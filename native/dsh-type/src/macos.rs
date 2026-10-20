//! Native macOS front-app inspection and Unicode events, without pasteboard access.
//! All retained Core Foundation objects and the autorelease pool are scoped.

use crate::{input, Way};
use std::ffi::{c_char, c_void, CStr};
use std::ptr::{null, null_mut};
use std::thread::sleep;
use std::time::Duration;

pub(crate) type Object = *mut c_void;
type Cf = *const c_void;
pub(crate) type Selector = *const c_void;

#[link(name = "objc")]
extern "C" {
    fn objc_getClass(name: *const c_char) -> Object;
    fn sel_registerName(name: *const c_char) -> Selector;
    pub(crate) fn objc_msgSend();
    fn objc_autoreleasePoolPush() -> Object;
    fn objc_autoreleasePoolPop(pool: Object);
}

#[link(name = "AppKit", kind = "framework")]
extern "C" {}

#[repr(C)]
struct Range {
    location: isize,
    length: isize,
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(object: Cf);
    fn CFGetTypeID(object: Cf) -> usize;
    fn CFStringGetTypeID() -> usize;
    fn CFStringGetLength(string: Cf) -> isize;
    fn CFStringGetCharacters(string: Cf, range: Range, buffer: *mut u16);
    fn CFStringCreateWithCString(allocator: Cf, string: *const c_char, encoding: u32) -> Cf;
}

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXUIElementCreateApplication(pid: i32) -> Cf;
    fn AXUIElementCopyAttributeValue(element: Cf, attribute: Cf, value: *mut Cf) -> i32;
    fn AXUIElementSetMessagingTimeout(element: Cf, timeout: f32) -> i32;
    fn AXUIElementGetTypeID() -> usize;
    fn CGPreflightPostEventAccess() -> bool;
    fn CGRequestPostEventAccess() -> bool;
    fn CGEventCreateKeyboardEvent(source: Cf, key: u16, down: bool) -> Cf;
    fn CGEventKeyboardSetUnicodeString(event: Cf, length: usize, string: *const u16);
    fn CGEventSetFlags(event: Cf, flags: u64);
    fn CGEventPost(tap: u32, event: Cf);
    pub(crate) fn CGEventSourceFlagsState(state: i32) -> u64;
}

#[link(name = "Carbon", kind = "framework")]
extern "C" {
    fn IsSecureEventInputEnabled() -> bool;
}

struct Owned(Cf);
impl Owned {
    fn new(value: Cf) -> Option<Self> {
        if value.is_null() {
            None
        } else {
            Some(Self(value))
        }
    }
}
impl Drop for Owned {
    fn drop(&mut self) {
        unsafe { CFRelease(self.0) };
    }
}

pub(crate) struct Pool(Object);
impl Pool {
    pub(crate) fn new() -> Self {
        Self(unsafe { objc_autoreleasePoolPush() })
    }
}
impl Drop for Pool {
    fn drop(&mut self) {
        unsafe { objc_autoreleasePoolPop(self.0) };
    }
}

pub(crate) unsafe fn selector(name: &CStr) -> Selector {
    sel_registerName(name.as_ptr())
}

pub(crate) unsafe fn object(receiver: Object, name: &CStr) -> Object {
    if receiver.is_null() {
        return null_mut();
    }
    let send: unsafe extern "C" fn(Object, Selector) -> Object =
        std::mem::transmute(objc_msgSend as *const ());
    send(receiver, selector(name))
}

pub(crate) unsafe fn front_application() -> Object {
    let class = objc_getClass(c"NSWorkspace".as_ptr());
    object(object(class, c"sharedWorkspace"), c"frontmostApplication")
}

pub(crate) unsafe fn pid(application: Object) -> i32 {
    if application.is_null() {
        return 0;
    }
    let send: unsafe extern "C" fn(Object, Selector) -> i32 =
        std::mem::transmute(objc_msgSend as *const ());
    send(application, selector(c"processIdentifier"))
}

unsafe fn cf_string(value: Cf) -> Option<String> {
    if value.is_null() || CFGetTypeID(value) != CFStringGetTypeID() {
        return None;
    }
    let length = CFStringGetLength(value);
    if length < 0 {
        return None;
    }
    // Bound data obtained from other applications before allocation or copying.
    let length = length.min(4096) as usize;
    let mut units = vec![0u16; length];
    CFStringGetCharacters(
        value,
        Range {
            location: 0,
            length: length as isize,
        },
        units.as_mut_ptr(),
    );
    Some(String::from_utf16_lossy(&units))
}

unsafe fn attribute(element: Cf, name: &std::ffi::CStr) -> Option<Owned> {
    if element.is_null() || CFGetTypeID(element) != AXUIElementGetTypeID() {
        return None;
    }
    // AX attribute names are SDK CFSTR macros, not exported global symbols.
    let name = Owned::new(CFStringCreateWithCString(null(), name.as_ptr(), 0x08000100))?;
    let mut value = null();
    let status = AXUIElementCopyAttributeValue(element, name.0, &mut value);
    let value = Owned::new(value);
    if status == 0 {
        value
    } else {
        None
    }
}

pub fn front() -> Option<(String, String)> {
    let _pool = Pool::new();
    unsafe {
        let application = front_application();
        let process = pid(application);
        if process <= 0 {
            return None;
        }
        let name = cf_string(object(application, c"localizedName")).unwrap_or_default();
        let title = (|| {
            let element = Owned::new(AXUIElementCreateApplication(process))?;
            // An unresponsive application must not stall the line protocol indefinitely.
            if AXUIElementSetMessagingTimeout(element.0, 0.25) != 0 {
                return None;
            }
            let window = attribute(element.0, c"AXFocusedWindow")?;
            if CFGetTypeID(window.0) != AXUIElementGetTypeID()
                || AXUIElementSetMessagingTimeout(window.0, 0.25) != 0
            {
                return None;
            }
            let title = attribute(window.0, c"AXTitle")?;
            cf_string(title.0)
        })()
        .unwrap_or_default();
        Some((name, input::short_title(&title)))
    }
}

/// Query both services independently: neither a parent PID nor the helper signature proves which
/// app TCC attributes a request to. Do not cache a denial after the user changes the system setting.
pub fn permission_status() -> serde_json::Value {
    let (trusted, post) = permission_checks();
    serde_json::json!({
        "accessibility": trusted && post,
        "axTrusted": trusted,
        "postEventAllowed": post,
        "pid": std::process::id(),
        "helper": std::env::current_exe().ok(),
    })
}

fn permission_checks() -> (bool, bool) {
    unsafe { (AXIsProcessTrusted(), CGPreflightPostEventAccess()) }
}

/// Keep recovery instructions short; full diagnostics belong in the helper log, not a toast.
/// TCC may attribute permission to the launching app or the helper, depending on the launch chain.
pub fn permission_problem() -> Option<String> {
    let (trusted, post) = permission_checks();
    if trusted && post {
        return None;
    }
    let missing = match (trusted, post) {
        (false, false) => "Accessibility (window and keystroke control)",
        (false, true) => "Accessibility (window control)",
        _ => "Accessibility (sending keystrokes)",
    };
    let helper = std::env::current_exe().map(|path| path.display().to_string()).unwrap_or_else(|_| "dsh-type".into());
    eprintln!("permission denied: axTrusted={trusted}, postEventAllowed={post}, pid={}, helper={helper}", std::process::id());
    Some(format!(
        "macOS needs {missing}. Enable DeepSeek Harness (or your terminal) in System Settings › Accessibility. If already enabled, reload the clipboard helper or restart the launching app."
    ))
}

pub fn open_permission() -> Result<(), String> {
    // Only on an explicit user action: let macOS register the request under its actual responsible
    // application. This does not grant access; the user still authorizes it in System Settings.
    if !unsafe { CGPreflightPostEventAccess() } {
        unsafe { CGRequestPostEventAccess() };
    }
    // A fixed argument to an absolute executable, never a shell or user-controlled URL.
    let status = std::process::Command::new("/usr/bin/open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|error| format!("could not open Accessibility settings: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("macOS refused to open Accessibility settings".into())
    }
}

fn key_plan(ch: char) -> (u16, Vec<u16>) {
    match ch {
        '\n' => (36, Vec::new()),
        '\t' => (48, Vec::new()),
        _ => (0, ch.encode_utf16(&mut [0; 2]).to_vec()),
    }
}

/// One typist at a time across processes (Cardputer dictation and the palette share it).
/// A busy lock refuses at once instead of queueing; closing the file releases it.
pub struct InputLock(#[allow(dead_code)] std::fs::File);

pub fn input_lock() -> Result<InputLock, String> {
    use std::os::fd::AsRawFd;
    extern "C" {
        fn flock(fd: i32, operation: i32) -> i32;
    }
    let file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(std::env::temp_dir().join("dsh-type-input.lock"))
        .map_err(|_| "cannot lock the keyboard for typing".to_string())?;
    // LOCK_EX | LOCK_NB
    if unsafe { flock(file.as_raw_fd(), 2 | 4) } != 0 {
        return Err("another typing request is running".into());
    }
    Ok(InputLock(file))
}

pub fn type_text(text: &str, way: Way) -> Result<&'static str, String> {
    input::ensure_unicode(way)?;
    let _lock = input_lock()?;
    let text = input::normalize(text)?;
    if let Some(problem) = permission_problem() {
        return Err(problem);
    }
    let _pool = Pool::new();
    unsafe {
        let process = pid(front_application());
        if process <= 0 {
            return Err("there is no frontmost application".into());
        }
        for ch in text.chars() {
            // Ignore Caps Lock, but never synthesize text while shortcut modifiers are held.
            let modifiers = (1 << 17) | (1 << 18) | (1 << 19) | (1 << 20) | (1 << 23);
            if pid(front_application()) != process {
                return Err("input stopped: another app came to the front; some text may already have been typed".into());
            }
            if CGEventSourceFlagsState(0) & modifiers != 0 {
                return Err("input stopped: a modifier key (⌘ ⌥ ⌃ ⇧ fn) is held; some text may already have been typed".into());
            }
            if IsSecureEventInputEnabled() {
                return Err("input stopped: Secure Input is on (a password field or an app such as a terminal with Secure Keyboard Entry has it); macOS drops typed events until it is off".into());
            }
            let (key, units) = key_plan(ch);
            // Allocate both halves before posting either one, avoiding a stuck key on allocation failure.
            let down = Owned::new(CGEventCreateKeyboardEvent(null(), key, true)).ok_or(
                "could not allocate key-down event; some text may already have been typed",
            )?;
            let up = Owned::new(CGEventCreateKeyboardEvent(null(), key, false))
                .ok_or("could not allocate key-up event; some text may already have been typed")?;
            for event in [&down, &up] {
                CGEventSetFlags(event.0, 0);
                if !units.is_empty() {
                    CGEventKeyboardSetUnicodeString(event.0, units.len(), units.as_ptr());
                }
            }
            // CGEventPost has no delivery acknowledgement; never claim a paste fallback or retry.
            CGEventPost(0, down.0);
            CGEventPost(0, up.0);
            sleep(Duration::from_millis(1));
        }
    }
    Ok("unicode")
}

/// ⌘V into the front app: how the palette inserts an image, which cannot be typed. Not part of
/// dictation, which never touches the clipboard.
pub fn paste() -> Result<(), String> {
    let _lock = input_lock()?;
    if let Some(problem) = permission_problem() {
        return Err(problem);
    }
    unsafe {
        if IsSecureEventInputEnabled() {
            return Err("Secure Input is on, so macOS drops the ⌘V".into());
        }
        // kVK_ANSI_V with ⌘.
        let down = Owned::new(CGEventCreateKeyboardEvent(null(), 9, true)).ok_or("could not allocate key-down event")?;
        let up = Owned::new(CGEventCreateKeyboardEvent(null(), 9, false)).ok_or("could not allocate key-up event")?;
        for event in [&down, &up] {
            CGEventSetFlags(event.0, 1 << 20);
        }
        CGEventPost(0, down.0);
        CGEventPost(0, up.0);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plans_unicode_scalars_and_navigation_without_posting() {
        assert_eq!(key_plan('😀'), (0, vec![0xd83d, 0xde00]));
        assert_eq!(key_plan('中'), (0, vec![0x4e2d]));
        assert_eq!(key_plan('\n'), (36, vec![]));
        assert_eq!(key_plan('\t'), (48, vec![]));
    }

    #[test]
    fn paste_is_rejected_before_querying_permissions() {
        assert!(type_text("test", Way::Paste).is_err());
    }
}
