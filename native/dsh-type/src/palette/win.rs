//! Windows side of the palette: the window that was in front, the clipboard, and
//! a listener that is woken by the system when the clipboard changes (no polling), and tries
//! again, a little later each time, when a copy announced by another program cannot be read yet.

use super::image::{dib_to_png, png, png_to_dib, MAX_IMAGE_BYTES};
use super::{Clip, Target, MAX_BYTES};
use std::sync::atomic::{AtomicIsize, AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::thread::sleep;
use std::time::Duration;
use windows_sys::Win32::Foundation::{GlobalFree, HANDLE, HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::Graphics::Dwm::DwmSetWindowAttribute;
use windows_sys::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONULL};
use windows_sys::Win32::System::DataExchange::{
    AddClipboardFormatListener, CloseClipboard, EmptyClipboard, GetClipboardData, GetClipboardOwner,
    GetClipboardSequenceNumber, IsClipboardFormatAvailable, OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE};
use windows_sys::Win32::System::Ole::{CF_DIB, CF_UNICODETEXT};
use windows_sys::Win32::System::Threading::{AttachThreadInput, GetCurrentProcessId, GetCurrentThreadId};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VK_CONTROL, VK_LWIN,
    VK_MENU, VK_RETURN, VK_RWIN, VK_SHIFT,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, CreateWindowExW, DefWindowProcW, DispatchMessageW, GetForegroundWindow, GetMessageW,
    GetWindowThreadProcessId, IsIconic, IsWindow, KillTimer, PeekMessageW, PostMessageW, PostThreadMessageW, RegisterClassW, SetForegroundWindow,
    SetTimer, SetWindowsHookExW, ShowWindow, UnhookWindowsHookEx, HC_ACTION, HWND_MESSAGE, KBDLLHOOKSTRUCT,
    LLKHF_ALTDOWN, MSG, PM_NOREMOVE, SW_RESTORE, WH_KEYBOARD_LL, WM_APP, WM_CLIPBOARDUPDATE, WM_KEYDOWN, WM_QUIT,
    WM_SYSKEYDOWN, WM_TIMER, WNDCLASSW,
};

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

fn pid_of(window: HWND) -> u32 {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(window, &mut pid) };
    pid
}

/// The window the user was typing in. None when it is ours or there is none.
pub fn capture() -> Option<Target> {
    let window = unsafe { GetForegroundWindow() };
    if window.is_null() {
        return None;
    }
    let pid = pid_of(window);
    if pid == unsafe { GetCurrentProcessId() } {
        return None;
    }
    Some(Target { id: window as isize, app: crate::windows::process_name(pid) })
}

/// The middle of the screen the target window is on, in desktop pixels. None when it is gone.
pub fn front_point(target: &Target) -> Option<(f64, f64)> {
    let window = target.id as HWND;
    unsafe {
        if IsWindow(window) == 0 {
            return None;
        }
        let monitor = MonitorFromWindow(window, MONITOR_DEFAULTTONULL);
        if monitor.is_null() {
            return None;
        }
        let mut info: MONITORINFO = std::mem::zeroed();
        info.cbSize = size_of::<MONITORINFO>() as u32;
        if GetMonitorInfoW(monitor, &mut info) == 0 {
            return None;
        }
        let r = info.rcMonitor;
        Some(((r.left + r.right) as f64 / 2.0, (r.top + r.bottom) as f64 / 2.0))
    }
}

/// Brings a window to the front even when Windows would not let a background process do it.
pub fn focus(window: isize) -> bool {
    let window = window as HWND;
    unsafe {
        if IsWindow(window) == 0 {
            return false;
        }
        if IsIconic(window) != 0 {
            ShowWindow(window, SW_RESTORE);
        }
        if SetForegroundWindow(window) != 0 {
            return true;
        }
        // Share the input queue of whoever has the focus for a moment: that allows the switch.
        let front = GetForegroundWindow();
        let front_thread = GetWindowThreadProcessId(front, std::ptr::null_mut());
        let mine = GetCurrentThreadId();
        let attached = front_thread != 0 && front_thread != mine && AttachThreadInput(mine, front_thread, 1) != 0;
        let done = SetForegroundWindow(window) != 0;
        if attached {
            AttachThreadInput(mine, front_thread, 0);
        }
        done
    }
}

/// Raises our own window.
pub fn raise(window: isize) {
    focus(window);
}

/// Puts the target back in front and waits until it is: typing must never land elsewhere.
pub fn restore(target: &Target) -> bool {
    if !focus(target.id) {
        return false;
    }
    for _ in 0..30 {
        if unsafe { GetForegroundWindow() } as isize == target.id {
            return true;
        }
        sleep(Duration::from_millis(10));
    }
    false
}

/// Waits (up to a second) for the hotkey's modifiers to be let go.
pub fn wait_modifiers() -> bool {
    for _ in 0..100 {
        if !crate::windows::modifiers_down() {
            return true;
        }
        sleep(Duration::from_millis(10));
    }
    false
}

/// Waits (up to a second) for Enter to be let go: a key still held when the target comes back
/// to the front would reach it by auto-repeat.
pub fn wait_enter_released() {
    for _ in 0..100 {
        if unsafe { GetAsyncKeyState(VK_RETURN as i32) } >= 0 {
            return;
        }
        sleep(Duration::from_millis(10));
    }
}

/// Round corners from the system compositor: no drawing cost in the page.
pub fn style(window: isize) {
    let round: u32 = 2; // DWMWCP_ROUND
    unsafe {
        DwmSetWindowAttribute(window as HWND, 33, &round as *const u32 as *const _, 4);
    }
}

/// The clipboard is shared with every program: take it briefly, and give up rather than wait.
fn open_clipboard() -> bool {
    for _ in 0..5 {
        if unsafe { OpenClipboard(std::ptr::null_mut()) } != 0 {
            return true;
        }
        sleep(Duration::from_millis(15));
    }
    false
}

/// A block of global memory holding `bytes`, for SetClipboardData; null when out of memory.
unsafe fn global(bytes: &[u8]) -> HANDLE {
    let memory = GlobalAlloc(GMEM_MOVEABLE, bytes.len());
    if memory.is_null() {
        return std::ptr::null_mut();
    }
    let target = GlobalLock(memory) as *mut u8;
    if target.is_null() {
        GlobalFree(memory);
        return std::ptr::null_mut();
    }
    std::ptr::copy_nonoverlapping(bytes.as_ptr(), target, bytes.len());
    GlobalUnlock(memory);
    memory as HANDLE
}

/// The registered "PNG" format browsers and screenshot tools use, which keeps transparency.
fn png_format() -> u32 {
    unsafe { RegisterClipboardFormatW(wide("PNG").as_ptr()) }
}

/// Puts an image on the clipboard as the stored PNG (read back, it is the same image) and as a
/// DIB for the programs that only paste that.
pub fn set_image(data: &[u8]) -> Result<(), String> {
    let dib = png_to_dib(data).ok_or("the image cannot be read")?;
    if !open_clipboard() {
        return Err("the clipboard is busy".into());
    }
    unsafe {
        EmptyClipboard();
        let mut placed = false;
        for (format, bytes) in [(png_format(), data), (CF_DIB as u32, &dib[..])] {
            if format == 0 {
                continue;
            }
            let memory = global(bytes);
            if memory.is_null() {
                continue;
            }
            if SetClipboardData(format, memory).is_null() {
                GlobalFree(memory as _);
            } else {
                placed = true;
            }
        }
        CloseClipboard();
        if placed { Ok(()) } else { Err("the clipboard refused the image".into()) }
    }
}

/// The bytes of a clipboard format, at most `limit`; None when absent, too big or not ready.
unsafe fn block(format: u32, limit: usize) -> Option<Vec<u8>> {
    let data = GetClipboardData(format);
    if data.is_null() || GlobalSize(data) > limit {
        return None;
    }
    let pointer = GlobalLock(data) as *const u8;
    if pointer.is_null() {
        return None;
    }
    let bytes = std::slice::from_raw_parts(pointer, GlobalSize(data)).to_vec();
    GlobalUnlock(data);
    Some(bytes)
}

/// The image on the open clipboard as PNG: its own PNG when it has one, else its bitmap converted.
unsafe fn read_image() -> Option<Clip> {
    let format = png_format();
    if format != 0 && IsClipboardFormatAvailable(format) != 0 {
        if let Some((whole, width, height)) = block(format, MAX_IMAGE_BYTES * 2).as_deref().and_then(png) {
            return Some(Clip::Image(whole.to_vec(), width, height));
        }
    }
    let (data, width, height) = dib_to_png(&block(CF_DIB as u32, 200 * 1024 * 1024)?)?;
    (data.len() <= MAX_IMAGE_BYTES).then_some(Clip::Image(data, width, height))
}

pub fn set_clipboard(text: &str) -> Result<(), String> {
    // Windows programs expect CRLF in the clipboard.
    let text = text.replace("\r\n", "\n").replace('\n', "\r\n");
    let units = wide(&text);
    if !open_clipboard() {
        return Err("the clipboard is busy".into());
    }
    unsafe {
        EmptyClipboard();
        let memory = GlobalAlloc(GMEM_MOVEABLE, units.len() * 2);
        if memory.is_null() {
            CloseClipboard();
            return Err("out of memory".into());
        }
        let target = GlobalLock(memory) as *mut u16;
        if target.is_null() {
            GlobalFree(memory);
            CloseClipboard();
            return Err("cannot lock clipboard memory".into());
        }
        std::ptr::copy_nonoverlapping(units.as_ptr(), target, units.len());
        GlobalUnlock(memory);
        let set = SetClipboardData(CF_UNICODETEXT as u32, memory as HANDLE);
        if set.is_null() {
            GlobalFree(memory);
        }
        CloseClipboard();
        if set.is_null() {
            return Err("the clipboard refused the text".into());
        }
    }
    Ok(())
}

/// What one look at the clipboard found.
enum Look {
    Copy(Clip, String),
    /// Nothing to keep: not text, ignored, or too long. Settled for this copy.
    Skip,
    /// Marked by its program as not for clipboard monitors (password managers do). Settled.
    Private(&'static str, String),
    /// Could not be read yet: another program holds the clipboard, or the owner has not
    /// produced the text (sync tools render it on demand, over the network). Worth another try.
    Busy(String),
}

/// The text (else the image) now on the clipboard and the program that put it there.
fn read(skip: &dyn Fn(&str) -> bool) -> Look {
    unsafe {
        let text = IsClipboardFormatAvailable(CF_UNICODETEXT as u32) != 0;
        let format = png_format();
        let image = (format != 0 && IsClipboardFormatAvailable(format) != 0) || IsClipboardFormatAvailable(CF_DIB as u32) != 0;
        if !text && !image {
            return Look::Skip;
        }
        let owner = GetClipboardOwner();
        let app = if owner.is_null() { String::new() } else { crate::windows::process_name(pid_of(owner)) };
        // Passwords from a manager carry these marks: leave before reading a single character.
        let exclude = RegisterClipboardFormatW(wide("ExcludeClipboardContentFromMonitorProcessing").as_ptr());
        if exclude != 0 && IsClipboardFormatAvailable(exclude) != 0 {
            return Look::Private("ExcludeClipboardContentFromMonitorProcessing", app);
        }
        if skip(&app) {
            return Look::Skip;
        }
        if !open_clipboard() {
            return Look::Busy(app);
        }
        let history = RegisterClipboardFormatW(wide("CanIncludeInClipboardHistory").as_ptr());
        let allowed = if history != 0 && IsClipboardFormatAvailable(history) != 0 {
            let data = GetClipboardData(history);
            let value = if data.is_null() { std::ptr::null_mut() } else { GlobalLock(data) as *mut u32 };
            let flag = if value.is_null() { 1 } else { *value };
            if !value.is_null() {
                GlobalUnlock(data);
            }
            flag != 0
        } else {
            true
        };
        let look = if !allowed {
            Look::Private("CanIncludeInClipboardHistory=0", app)
        } else if !text {
            // A bitmap rendered on demand may not be ready yet, like a text.
            match read_image() {
                Some(clip) => Look::Copy(clip, app),
                None if GetClipboardData(CF_DIB as u32).is_null() => Look::Busy(app),
                None => Look::Skip,
            }
        } else {
            // With delayed rendering this is where the owner is asked for the text; it may fail
            // while the owner is still fetching it.
            let data = GetClipboardData(CF_UNICODETEXT as u32);
            if data.is_null() {
                Look::Busy(app)
            } else if GlobalSize(data) > MAX_BYTES * 4 {
                Look::Skip
            } else {
                let pointer = GlobalLock(data) as *const u16;
                if pointer.is_null() {
                    Look::Busy(app)
                } else {
                    let capacity = GlobalSize(data) / 2;
                    let mut length = 0;
                    while length < capacity && *pointer.add(length) != 0 {
                        length += 1;
                    }
                    let text = String::from_utf16_lossy(std::slice::from_raw_parts(pointer, length));
                    GlobalUnlock(data);
                    Look::Copy(Clip::Text(text.replace("\r\n", "\n")), app)
                }
            }
        };
        CloseClipboard();
        look
    }
}

type Handler = Box<dyn Fn(bool) + Send + Sync>;
static HANDLER: OnceLock<Handler> = OnceLock::new();
static LISTENER: AtomicIsize = AtomicIsize::new(0);
const TIMER: usize = 1;
const CHECK: u32 = WM_APP + 1;
/// One copy often announces itself several times (a program writes each format in turn).
const SETTLE_MS: u32 = 80;
/// Waits before reading again a copy that could not be read: sync tools (phone links, remote
/// desktops) may take a while to deliver the text they announced.
const RETRY_MS: [u32; 5] = [120, 300, 700, 1500, 3000];

unsafe extern "system" fn procedure(window: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match message {
        WM_CLIPBOARDUPDATE => {
            SetTimer(window, TIMER, SETTLE_MS, None);
            0
        }
        WM_TIMER if wparam == TIMER => {
            KillTimer(window, TIMER);
            if let Some(handler) = HANDLER.get() {
                handler(false);
            }
            0
        }
        CHECK => {
            if let Some(handler) = HANDLER.get() {
                handler(true);
            }
            0
        }
        _ => DefWindowProcW(window, message, wparam, lparam),
    }
}

fn name(app: &str) -> &str {
    if app.is_empty() { "an unknown program" } else { app }
}

/// Looks at the clipboard now, on the watcher's thread: a change that went unnoticed or could
/// not be read is picked up when the window opens.
pub fn check_now() {
    let window = LISTENER.load(Ordering::Relaxed);
    if window != 0 {
        unsafe { PostMessageW(window as HWND, CHECK, 0, 0) };
    }
}

/// Calls `sink(copy, app)` for every new copy. Runs on its own thread, so a program
/// that holds the clipboard for long never freezes the palette.
pub fn watch(skip: Arc<dyn Fn(&str) -> bool + Send + Sync>, sink: Arc<dyn Fn(Clip, String) + Send + Sync>) {
    // The last copy settled (stored or deliberately left out), and the tries spent on the current one.
    // Only ever called on the watcher's thread; atomics just make the closure shareable.
    let settled = AtomicU32::new(0);
    let trying = AtomicU32::new(0);
    let tries = AtomicUsize::new(0);
    let _ = HANDLER.set(Box::new(move |fresh: bool| {
        let sequence = unsafe { GetClipboardSequenceNumber() };
        if settled.load(Ordering::Relaxed) == sequence {
            return;
        }
        if fresh || trying.swap(sequence, Ordering::Relaxed) != sequence {
            tries.store(0, Ordering::Relaxed);
        }
        let attempt = tries.fetch_add(1, Ordering::Relaxed);
        match read(&*skip) {
            Look::Busy(_) if attempt < RETRY_MS.len() => {
                let window = LISTENER.load(Ordering::Relaxed) as HWND;
                unsafe { SetTimer(window, TIMER, RETRY_MS[attempt], None) };
                return;
            }
            Look::Copy(clip, app) => sink(clip, app),
            Look::Skip => {}
            // Said once per copy, with the program but never the content: why a copy is missing.
            Look::Private(mark, app) => super::log(format!("left out a copy from {} marked {mark}", name(&app))),
            Look::Busy(app) => super::log(format!("gave up reading a copy from {} after {} tries", name(&app), attempt + 1)),
        }
        settled.store(sequence, Ordering::Relaxed);
    }));
    std::thread::Builder::new()
        .name("clipboard".into())
        .spawn(|| unsafe {
            let instance = GetModuleHandleW(std::ptr::null());
            let class = wide("DshClipboardListener");
            let description = WNDCLASSW {
                style: 0,
                lpfnWndProc: Some(procedure),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: instance,
                hIcon: std::ptr::null_mut(),
                hCursor: std::ptr::null_mut(),
                hbrBackground: std::ptr::null_mut(),
                lpszMenuName: std::ptr::null(),
                lpszClassName: class.as_ptr(),
            };
            RegisterClassW(&description);
            let window = CreateWindowExW(
                0,
                class.as_ptr(),
                std::ptr::null(),
                0,
                0,
                0,
                0,
                0,
                HWND_MESSAGE,
                std::ptr::null_mut(),
                instance,
                std::ptr::null(),
            );
            if window.is_null() || AddClipboardFormatListener(window) == 0 {
                return;
            }
            LISTENER.store(window as isize, Ordering::Relaxed);
            // Whatever is on the clipboard when we start is the first entry.
            SetTimer(window, TIMER, SETTLE_MS, None);
            let mut message: MSG = std::mem::zeroed();
            while GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0 {
                DispatchMessageW(&message);
            }
        })
        .ok();
}

/// Where a taken key goes: its digit, 1–9.
pub type Sink = Box<dyn Fn(u8) + Send>;

thread_local! {
    /// On the hook's own thread: the window it serves, the digits it takes, and where it reports.
    static GRAB: std::cell::RefCell<Option<(isize, u16, Sink)>> = const { std::cell::RefCell::new(None) };
}
/// The thread running the hook while the window is open; 0 when there is none.
static GRABBER: AtomicU32 = AtomicU32::new(0);

/// Alt with one of our digits and no other modifier, while our window is in front: taken from everyone else.
unsafe extern "system" fn on_key(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        let key = &*(lparam as *const KBDLLHOOKSTRUCT);
        let taken = (0x31..=0x39).contains(&key.vkCode)
            && key.flags & LLKHF_ALTDOWN != 0
            && [VK_CONTROL, VK_SHIFT, VK_LWIN, VK_RWIN].iter().all(|vk| GetAsyncKeyState(*vk as i32) >= 0)
            && GRAB.with(|grab| {
                let grab = grab.borrow();
                let Some((window, keys, sink)) = grab.as_ref() else { return false };
                if keys & 1 << (key.vkCode - 0x30) == 0 || GetForegroundWindow() as isize != *window {
                    return false;
                }
                if wparam == WM_SYSKEYDOWN as usize || wparam == WM_KEYDOWN as usize {
                    sink((key.vkCode - 0x30) as u8);
                }
                true
            });
        if taken {
            return 1;
        }
    }
    CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
}

/// While the window is open, Alt with the digits in `keys` (one bit per digit) belongs to it: a hook installed at each opening runs ahead of
/// every hook installed before it and of every program's registered hotkeys. It runs on a thread of
/// its own that does nothing else, so it always answers in time (the system skips a hook that
/// keeps it waiting, and the window's thread is often busy with the page). Ended on closing, which
/// hands those keys back. `None` releases.
pub fn grab(window: isize, keys: u16, sink: Option<Sink>) {
    let old = GRABBER.swap(0, Ordering::SeqCst);
    if old != 0 {
        unsafe { PostThreadMessageW(old, WM_QUIT, 0, 0) };
    }
    let Some(sink) = sink.filter(|_| keys != 0) else { return };
    let (started, start) = std::sync::mpsc::channel();
    // A thread that cannot start drops `started`, which ends the wait below at once.
    let _ = std::thread::Builder::new().name("alt-digits".into()).spawn(move || unsafe {
        GRAB.with(|grab| *grab.borrow_mut() = Some((window, keys, sink)));
        let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(on_key), GetModuleHandleW(std::ptr::null()), 0);
        // The queue must exist before the release is posted to it.
        let mut message: MSG = std::mem::zeroed();
        PeekMessageW(&mut message, std::ptr::null_mut(), 0, 0, PM_NOREMOVE);
        let _ = started.send(if hook.is_null() { 0 } else { GetCurrentThreadId() });
        if hook.is_null() {
            return super::log("the system refused the keyboard hook: the language keys work only when no other program takes them");
        }
        while GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0 {}
        UnhookWindowsHookEx(hook);
    });
    if let Ok(id) = start.recv() {
        GRABBER.store(id, Ordering::SeqCst);
    }
}

/// Alt let go after a swallowed key would read as Alt pressed alone, which opens the window menu:
/// a key that means nothing in between prevents it, as other hotkey tools do.
pub fn mask_alt() {
    if unsafe { GetAsyncKeyState(VK_MENU as i32) } >= 0 {
        return;
    }
    let key = |flags| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: 0xE8, wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
    };
    let inputs = [key(0), key(KEYEVENTF_KEYUP)];
    unsafe { SendInput(inputs.len() as u32, inputs.as_ptr(), size_of::<INPUT>() as i32) };
}
