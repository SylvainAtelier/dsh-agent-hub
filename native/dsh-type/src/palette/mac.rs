//! macOS side of the palette. The pasteboard announces nothing, so it is watched by reading
//! its change counter (a single integer) at an interval that relaxes while nothing happens.

use super::image::{png, MAX_IMAGE_BYTES};
use super::{Clip, Target, MAX_BYTES};
use crate::macos::{front_application, object, objc_msgSend, pid, selector, Object, Pool, Selector};
use std::ffi::{c_char, c_void, CStr};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::sleep;
use std::time::{Duration, Instant};

#[link(name = "AppKit", kind = "framework")]
extern "C" {}

#[link(name = "objc")]
extern "C" {
    fn objc_getClass(name: *const c_char) -> Object;
}

extern "C" {
    fn getpid() -> i32;
}

unsafe fn send0_int(receiver: Object, name: &CStr) -> isize {
    let send: unsafe extern "C" fn(Object, Selector) -> isize = std::mem::transmute(objc_msgSend as *const ());
    send(receiver, selector(name))
}

unsafe fn send1(receiver: Object, name: &CStr, argument: Object) -> Object {
    let send: unsafe extern "C" fn(Object, Selector, Object) -> Object = std::mem::transmute(objc_msgSend as *const ());
    send(receiver, selector(name), argument)
}

unsafe fn send1_bool(receiver: Object, name: &CStr, argument: Object) -> bool {
    let send: unsafe extern "C" fn(Object, Selector, Object) -> bool = std::mem::transmute(objc_msgSend as *const ());
    send(receiver, selector(name), argument)
}

unsafe fn ns_string(text: &CStr) -> Object {
    send1(objc_getClass(c"NSString".as_ptr()), c"stringWithUTF8String:", text.as_ptr() as Object)
}

unsafe fn pasteboard() -> Object {
    object(objc_getClass(c"NSPasteboard".as_ptr()), c"generalPasteboard")
}

pub fn capture() -> Option<Target> {
    let _pool = Pool::new();
    let process = unsafe { pid(front_application()) };
    if process <= 0 || process == unsafe { getpid() } {
        return None;
    }
    let app = crate::macos::front().map(|(name, _)| name).unwrap_or_default();
    Some(Target { id: process as isize, app })
}

#[repr(C)]
struct Rect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    static kCGWindowOwnerPID: *const c_void;
    static kCGWindowLayer: *const c_void;
    static kCGWindowBounds: *const c_void;
    fn CGWindowListCopyWindowInfo(option: u32, relative_to: u32) -> *const c_void;
    fn CGRectMakeWithDictionaryRepresentation(dictionary: *const c_void, rect: *mut Rect) -> bool;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFArrayGetCount(array: *const c_void) -> isize;
    fn CFArrayGetValueAtIndex(array: *const c_void, index: isize) -> *const c_void;
    fn CFDictionaryGetValue(dictionary: *const c_void, key: *const c_void) -> *const c_void;
    fn CFNumberGetValue(number: *const c_void, kind: isize, value: *mut c_void) -> bool;
}

/// The middle of the target app's front window, in points from the top left of the main screen
/// (where windows are placed). The list comes front to back and needs no permission; windows too
/// small to be the one worked in (status items, tool tips) are passed over. None without a window.
pub fn front_point(target: &Target) -> Option<(f64, f64)> {
    // kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements
    let list = unsafe { CGWindowListCopyWindowInfo(1 | 1 << 4, 0) };
    if list.is_null() {
        return None;
    }
    let number = |info: *const c_void, key: *const c_void| unsafe {
        let value = CFDictionaryGetValue(info, key);
        let mut out = 0i32;
        // kCFNumberSInt32Type
        (!value.is_null() && CFNumberGetValue(value, 3, &mut out as *mut i32 as *mut c_void)).then_some(out)
    };
    let found = (0..unsafe { CFArrayGetCount(list) }).find_map(|index| unsafe {
        let info = CFArrayGetValueAtIndex(list, index);
        if number(info, kCGWindowOwnerPID)? as isize != target.id || number(info, kCGWindowLayer)? != 0 {
            return None;
        }
        let bounds = CFDictionaryGetValue(info, kCGWindowBounds);
        let mut rect = Rect { x: 0.0, y: 0.0, width: 0.0, height: 0.0 };
        if bounds.is_null() || !CGRectMakeWithDictionaryRepresentation(bounds, &mut rect) || rect.width < 100.0 || rect.height < 60.0 {
            return None;
        }
        Some((rect.x + rect.width / 2.0, rect.y + rect.height / 2.0))
    });
    unsafe { CFRelease(list) };
    found
}

pub fn focus(process: isize) -> bool {
    let _pool = Pool::new();
    unsafe {
        let class = objc_getClass(c"NSRunningApplication".as_ptr());
        let send: unsafe extern "C" fn(Object, Selector, i32) -> Object = std::mem::transmute(objc_msgSend as *const ());
        let application = send(class, selector(c"runningApplicationWithProcessIdentifier:"), process as i32);
        if application.is_null() {
            return false;
        }
        let activate: unsafe extern "C" fn(Object, Selector, usize) -> bool = std::mem::transmute(objc_msgSend as *const ());
        // NSApplicationActivateIgnoringOtherApps
        activate(application, selector(c"activateWithOptions:"), 2)
    }
}

/// Activation of our own window is done by the window toolkit.
pub fn raise(_window: isize) {}

pub fn restore(target: &Target) -> bool {
    if !focus(target.id) {
        return false;
    }
    for _ in 0..30 {
        let _pool = Pool::new();
        if unsafe { pid(front_application()) } as isize == target.id {
            return true;
        }
        sleep(Duration::from_millis(10));
    }
    false
}

pub fn wait_modifiers() -> bool {
    let modifiers: u64 = (1 << 17) | (1 << 18) | (1 << 19) | (1 << 20) | (1 << 23);
    for _ in 0..100 {
        if unsafe { crate::macos::CGEventSourceFlagsState(0) } & modifiers == 0 {
            return true;
        }
        sleep(Duration::from_millis(10));
    }
    false
}

/// The window's corners and shadow are drawn by macOS.
pub fn style(_window: isize) {
    edit_menu();
}

/// Web views take ⌘A/C/V/X/Z from the Edit menu's key equivalents; without a main menu (an
/// accessory app has none) those keys do nothing in the text fields. The menu is never shown.
fn edit_menu() {
    static DONE: OnceLock<()> = OnceLock::new();
    DONE.get_or_init(|| unsafe {
        let _pool = Pool::new();
        let app = object(objc_getClass(c"NSApplication".as_ptr()), c"sharedApplication");
        let alloc = |class: &CStr| object(objc_getClass(class.as_ptr()), c"alloc");
        let menu = |title: &CStr| send1(alloc(c"NSMenu"), c"initWithTitle:", ns_string(title));
        let item: unsafe extern "C" fn(Object, Selector, Object, Selector, Object) -> Object = std::mem::transmute(objc_msgSend as *const ());
        let edit = menu(c"Edit");
        for (title, action, key) in [
            (c"Undo", c"undo:", c"z"),
            // An upper-case equivalent is the same letter with ⇧.
            (c"Redo", c"redo:", c"Z"),
            (c"Cut", c"cut:", c"x"),
            (c"Copy", c"copy:", c"c"),
            (c"Paste", c"paste:", c"v"),
            (c"Select All", c"selectAll:", c"a"),
        ] {
            let entry = item(alloc(c"NSMenuItem"), selector(c"initWithTitle:action:keyEquivalent:"), ns_string(title), selector(action), ns_string(key));
            send1(edit, c"addItem:", entry);
        }
        let holder = item(alloc(c"NSMenuItem"), selector(c"initWithTitle:action:keyEquivalent:"), ns_string(c"Edit"), std::ptr::null(), ns_string(c""));
        send1(holder, c"setSubmenu:", edit);
        let main = menu(c"");
        send1(main, c"addItem:", holder);
        send1(app, c"setMainMenu:", main);
    });
}

/// Waits (up to a second) for Return and keypad Enter to be let go: a key still held when the
/// target comes back to the front would reach it, by auto-repeat or as a stray key-up.
pub fn wait_enter_released() {
    extern "C" {
        fn CGEventSourceKeyState(state: i32, key: u16) -> bool;
    }
    for _ in 0..100 {
        // kCGEventSourceStateCombinedSessionState; Return, keypad Enter.
        if unsafe { !CGEventSourceKeyState(0, 36) && !CGEventSourceKeyState(0, 76) } {
            return;
        }
        sleep(Duration::from_millis(10));
    }
}

pub fn set_clipboard(text: &str) -> Result<(), String> {
    let text = std::ffi::CString::new(text.replace('\0', "")).map_err(|_| "invalid text".to_string())?;
    let _pool = Pool::new();
    unsafe {
        let board = pasteboard();
        object(board, c"clearContents");
        let string = ns_string(&text);
        if send1_bool_two(board, string, ns_string(c"public.utf8-plain-text")) {
            Ok(())
        } else {
            Err("the pasteboard refused the text".into())
        }
    }
}

/// Puts a PNG on the pasteboard, as the bytes stored: reading it back finds the same image.
pub fn set_image(data: &[u8]) -> Result<(), String> {
    let _pool = Pool::new();
    unsafe {
        let board = pasteboard();
        object(board, c"clearContents");
        let make: unsafe extern "C" fn(Object, Selector, *const c_void, usize) -> Object = std::mem::transmute(objc_msgSend as *const ());
        let bytes = make(objc_getClass(c"NSData".as_ptr()), selector(c"dataWithBytes:length:"), data.as_ptr() as *const c_void, data.len());
        let set: unsafe extern "C" fn(Object, Selector, Object, Object) -> bool = std::mem::transmute(objc_msgSend as *const ());
        if !bytes.is_null() && set(board, selector(c"setData:forType:"), bytes, ns_string(c"public.png")) {
            Ok(())
        } else {
            Err("the pasteboard refused the image".into())
        }
    }
}

/// The bytes of an NSData, copied.
unsafe fn data_bytes(data: Object) -> Option<Vec<u8>> {
    if data.is_null() {
        return None;
    }
    let length = send0_int(data, c"length") as usize;
    let bytes = object(data, c"bytes") as *const u8;
    if bytes.is_null() || length == 0 {
        return None;
    }
    Some(std::slice::from_raw_parts(bytes, length).to_vec())
}

/// The image on the pasteboard as PNG: as it is, or converted from TIFF (which most apps put there).
unsafe fn read_image(board: Object) -> Option<Clip> {
    let mut data = send1(board, c"dataForType:", ns_string(c"public.png"));
    if data.is_null() {
        let tiff = send1(board, c"dataForType:", ns_string(c"public.tiff"));
        if tiff.is_null() || send0_int(tiff, c"length") as usize > MAX_IMAGE_BYTES * 8 {
            return None;
        }
        let image = send1(objc_getClass(c"NSBitmapImageRep".as_ptr()), c"imageRepWithData:", tiff);
        if image.is_null() {
            return None;
        }
        let encode: unsafe extern "C" fn(Object, Selector, usize, Object) -> Object = std::mem::transmute(objc_msgSend as *const ());
        // NSBitmapImageFileTypePNG
        data = encode(image, selector(c"representationUsingType:properties:"), 4, object(objc_getClass(c"NSDictionary".as_ptr()), c"dictionary"));
    }
    let bytes = data_bytes(data)?;
    let (whole, width, height) = png(&bytes)?;
    (whole.len() <= MAX_IMAGE_BYTES).then(|| Clip::Image(whole.to_vec(), width, height))
}

unsafe fn send1_bool_two(board: Object, string: Object, kind: Object) -> bool {
    let send: unsafe extern "C" fn(Object, Selector, Object, Object) -> bool = std::mem::transmute(objc_msgSend as *const ());
    send(board, selector(c"setString:forType:"), string, kind)
}

/// The text on the pasteboard, else its image; None when it is neither, is marked concealed or
/// transient (password managers do), is a copied file (Finder adds the file's icon as an image),
/// or comes from an app on the ignore list.
fn read(skip: &dyn Fn(&str) -> bool) -> Option<(Clip, String)> {
    let _pool = Pool::new();
    unsafe {
        let board = pasteboard();
        let types = object(board, c"types");
        for private in [c"org.nspasteboard.ConcealedType", c"org.nspasteboard.TransientType", c"org.nspasteboard.AutoGeneratedType"] {
            if !types.is_null() && send1_bool(types, c"containsObject:", ns_string(private)) {
                return None;
            }
        }
        let app = crate::macos::front().map(|(name, _)| name).unwrap_or_default();
        if skip(&app) {
            return None;
        }
        let string = send1(board, c"stringForType:", ns_string(c"public.utf8-plain-text"));
        if string.is_null() {
            if !types.is_null() && send1_bool(types, c"containsObject:", ns_string(c"public.file-url")) {
                return None;
            }
            return read_image(board).map(|clip| (clip, app));
        }
        let bytes = object(string, c"UTF8String") as *const c_char;
        if bytes.is_null() {
            return None;
        }
        let text = CStr::from_ptr(bytes);
        if text.to_bytes().len() > MAX_BYTES {
            return None;
        }
        Some((Clip::Text(text.to_string_lossy().into_owned()), app))
    }
}

static WAKE: OnceLock<Mutex<Sender<()>>> = OnceLock::new();

/// Looks at the pasteboard now instead of at the next tick: the window just opened.
pub fn check_now() {
    if let Some(wake) = WAKE.get() {
        let _ = wake.lock().map(|wake| wake.send(()));
    }
}

/// Calls `sink(copy, app)` for every new copy.
pub fn watch(skip: Arc<dyn Fn(&str) -> bool + Send + Sync>, sink: Arc<dyn Fn(Clip, String) + Send + Sync>) {
    let (wake, woken) = channel::<()>();
    let _ = WAKE.set(Mutex::new(wake));
    std::thread::Builder::new()
        .name("pasteboard".into())
        .spawn(move || {
            let count = || {
                let _pool = Pool::new();
                unsafe { send0_int(pasteboard(), c"changeCount") }
            };
            // Whatever is on the pasteboard when we start is the first entry.
            let mut seen = -1;
            let mut changed = Instant::now();
            loop {
                let now = count();
                if now != seen {
                    seen = now;
                    changed = Instant::now();
                    if let Some((clip, app)) = read(&*skip) {
                        sink(clip, app);
                    }
                }
                // Quick while the user is copying, slower and slower when nothing happens.
                let idle = changed.elapsed();
                let wait = if idle < Duration::from_secs(10) {
                    250
                } else if idle < Duration::from_secs(120) {
                    1000
                } else {
                    2000
                };
                if let Err(RecvTimeoutError::Disconnected) = woken.recv_timeout(Duration::from_millis(wait)) {
                    return;
                }
            }
        })
        .ok();
}

type Tap = unsafe extern "C" fn(proxy: *mut c_void, kind: u32, event: *mut c_void, info: *mut c_void) -> *mut c_void;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn CGEventTapCreate(tap: u32, place: u32, options: u32, mask: u64, callback: Tap, info: *mut c_void) -> *mut c_void;
    fn CGEventTapEnable(tap: *mut c_void, enable: bool);
    fn CGEventGetIntegerValueField(event: *mut c_void, field: u32) -> i64;
    fn CGEventGetFlags(event: *mut c_void) -> u64;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    static kCFRunLoopCommonModes: *const c_void;
    fn CFMachPortCreateRunLoopSource(allocator: *const c_void, port: *mut c_void, order: isize) -> *mut c_void;
    fn CFMachPortInvalidate(port: *mut c_void);
    fn CFRunLoopGetMain() -> *mut c_void;
    fn CFRunLoopAddSource(run_loop: *mut c_void, source: *mut c_void, mode: *const c_void);
    fn CFRunLoopRemoveSource(run_loop: *mut c_void, source: *mut c_void, mode: *const c_void);
    fn CFRelease(object: *const c_void);
}

/// The key codes of the digits 1–9 on the main row.
const DIGITS: [i64; 9] = [18, 19, 20, 21, 23, 22, 26, 28, 25];
const KEY_DOWN: u32 = 10;
const KEY_UP: u32 = 11;
const OPTION: u64 = 1 << 19;
const OTHERS: u64 = (1 << 17) | (1 << 18) | (1 << 20);

/// Where a taken key goes: its digit, 1–9.
pub type Sink = Box<dyn Fn(u8) + Send>;

thread_local! {
    /// The event tap taking our ⌥ digits while the window is open, its run loop source, the digits
    /// (one bit each), and where it reports.
    static GRAB: std::cell::RefCell<Option<(*mut c_void, *mut c_void, u16, Sink)>> = const { std::cell::RefCell::new(None) };
}

/// ⌥ with one of our digits and no other modifier, while we are the front app: taken from everyone else.
unsafe extern "C" fn on_key(_: *mut c_void, kind: u32, event: *mut c_void, _: *mut c_void) -> *mut c_void {
    // The system switches a slow or interrupted tap off; it goes on again at once.
    if kind == 0xFFFF_FFFE || kind == 0xFFFF_FFFF {
        GRAB.with(|grab| {
            if let Some((tap, _, _, _)) = grab.borrow().as_ref() {
                CGEventTapEnable(*tap, true);
            }
        });
        return event;
    }
    if kind != KEY_DOWN && kind != KEY_UP {
        return event;
    }
    let Some(index) = DIGITS.iter().position(|code| *code == CGEventGetIntegerValueField(event, 9)) else { return event };
    let digit = index as u8 + 1;
    let flags = CGEventGetFlags(event);
    let ours = GRAB.with(|grab| grab.borrow().as_ref().is_some_and(|(_, _, keys, _)| keys & 1 << digit != 0));
    if !ours || flags & OPTION == 0 || flags & OTHERS != 0 {
        return event;
    }
    let _pool = Pool::new();
    if pid(front_application()) != getpid() {
        return event;
    }
    if kind == KEY_DOWN {
        GRAB.with(|grab| {
            if let Some((_, _, _, sink)) = grab.borrow().as_ref() {
                sink(digit);
            }
        });
    }
    std::ptr::null_mut()
}

/// While the window is open, ⌥ with the digits in `keys` (one bit per digit) belongs to it: a tap at the head of the input stream sees them
/// before any app's hotkeys. Needs the accessibility permission typing already asks for; without
/// it the page still has them unless another app takes them. Removed on closing. `None` releases.
pub fn grab(_window: isize, keys: u16, sink: Option<Sink>) {
    GRAB.with(|grab| unsafe {
        if let Some((tap, source, _, _)) = grab.borrow_mut().take() {
            CGEventTapEnable(tap, false);
            CFRunLoopRemoveSource(CFRunLoopGetMain(), source, kCFRunLoopCommonModes);
            CFMachPortInvalidate(tap);
            CFRelease(source);
            CFRelease(tap);
        }
        let Some(sink) = sink.filter(|_| keys != 0) else { return };
        // At the HID level, at the head, able to swallow: keys down and up.
        let tap = CGEventTapCreate(0, 0, 0, (1 << KEY_DOWN) | (1 << KEY_UP), on_key, std::ptr::null_mut());
        if tap.is_null() {
            return;
        }
        let source = CFMachPortCreateRunLoopSource(std::ptr::null(), tap, 0);
        if source.is_null() {
            CFMachPortInvalidate(tap);
            CFRelease(tap);
            return;
        }
        CFRunLoopAddSource(CFRunLoopGetMain(), source, kCFRunLoopCommonModes);
        CGEventTapEnable(tap, true);
        *grab.borrow_mut() = Some((tap, source, keys, sink));
    });
}

/// Option let go alone opens nothing on macOS.
pub fn mask_alt() {}
