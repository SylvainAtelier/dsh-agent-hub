//! Windows Unicode input. Explicit paste is refused because arbitrary clipboard
//! formats and asynchronous consumers cannot be preserved reliably.

use crate::{input, Way};
use std::thread::sleep;
use std::time::Duration;
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, WAIT_ABANDONED, WAIT_OBJECT_0};
use windows_sys::Win32::System::Threading::{
    CreateMutexW, OpenProcess, QueryFullProcessImageNameW, ReleaseMutex, WaitForSingleObject,
    PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP,
    KEYEVENTF_UNICODE, VIRTUAL_KEY, VK_CONTROL, VK_LWIN, VK_MENU, VK_RETURN, VK_RWIN, VK_SHIFT,
    VK_TAB,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId,
};

/// The executable name (no `.exe`) of a process, blank when it cannot be opened.
pub fn process_name(pid: u32) -> String {
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        let mut app = String::new();
        if !process.is_null() {
            let mut path = [0u16; 32768];
            let mut size = path.len() as u32;
            if QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, path.as_mut_ptr(), &mut size)
                != 0
                && size as usize <= path.len()
            {
                let path = String::from_utf16_lossy(&path[..size as usize]);
                let file = path.rsplit(['\\', '/']).next().unwrap_or("");
                app = file
                    .strip_suffix(".exe")
                    .or_else(|| file.strip_suffix(".EXE"))
                    .unwrap_or(file)
                    .to_string();
            }
            CloseHandle(process);
        }
        app
    }
}

pub fn front() -> Option<(String, String)> {
    unsafe {
        let window = GetForegroundWindow();
        if window.is_null() {
            return None;
        }
        let mut title = [0u16; 256];
        let length = GetWindowTextW(window, title.as_mut_ptr(), title.len() as i32).max(0) as usize;
        let title = String::from_utf16_lossy(&title[..length.min(title.len())]);
        let mut pid = 0u32;
        GetWindowThreadProcessId(window, &mut pid);
        let app = process_name(pid);
        Some((app, input::short_title(&title)))
    }
}

fn key(vk: VIRTUAL_KEY, scan: u16, flags: u32) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: scan,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn character_inputs(ch: char) -> Vec<INPUT> {
    let vk = match ch {
        '\n' => Some(VK_RETURN),
        '\t' => Some(VK_TAB),
        _ => None,
    };
    if let Some(vk) = vk {
        return vec![key(vk, 0, 0), key(vk, 0, KEYEVENTF_KEYUP)];
    }
    let mut units = [0u16; 2];
    ch.encode_utf16(&mut units)
        .iter()
        .flat_map(|unit| {
            [
                key(0, *unit, KEYEVENTF_UNICODE),
                key(0, *unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP),
            ]
        })
        .collect()
}

fn unmatched_release_index(sent: usize, total: usize) -> Option<usize> {
    (sent > 0 && sent < total && sent % 2 == 1).then_some(sent)
}

pub fn modifiers_down() -> bool {
    [VK_CONTROL, VK_SHIFT, VK_MENU, VK_LWIN, VK_RWIN]
        .iter()
        .any(|vk| unsafe { GetAsyncKeyState(*vk as i32) < 0 })
}

/// One typist at a time across processes (Cardputer dictation and the palette share it).
/// Held only while typing; a busy lock refuses at once instead of queueing.
pub struct InputLock(HANDLE);

impl Drop for InputLock {
    fn drop(&mut self) {
        unsafe {
            ReleaseMutex(self.0);
            CloseHandle(self.0);
        }
    }
}

pub fn input_lock() -> Result<InputLock, String> {
    let name: Vec<u16> = "Local\\dsh-type-input\0".encode_utf16().collect();
    unsafe {
        let handle = CreateMutexW(std::ptr::null(), 0, name.as_ptr());
        if handle.is_null() {
            return Err("cannot lock the keyboard for typing".into());
        }
        match WaitForSingleObject(handle, 0) {
            WAIT_OBJECT_0 | WAIT_ABANDONED => Ok(InputLock(handle)),
            _ => {
                CloseHandle(handle);
                Err("another typing request is running".into())
            }
        }
    }
}

pub fn type_text(text: &str, way: Way) -> Result<&'static str, String> {
    input::ensure_unicode(way)?;
    let _lock = input_lock()?;
    let text = input::normalize(text)?;
    let window = unsafe { GetForegroundWindow() };
    if window.is_null() {
        return Err("there is no foreground window".into());
    }
    for ch in text.chars() {
        // Do not redirect remaining text after focus changes or turn it into shortcuts.
        if unsafe { GetForegroundWindow() } != window || modifiers_down() {
            return Err("input stopped: foreground window changed or a modifier is held; some text may already have been typed".into());
        }
        let inputs = character_inputs(ch);
        let sent = unsafe {
            SendInput(
                inputs.len() as u32,
                inputs.as_ptr(),
                size_of::<INPUT>() as i32,
            )
        } as usize;
        if sent != inputs.len() {
            // SendInput inserts an ordered prefix. Release only our unmatched key-down,
            // never a physical modifier, and never retry text after a partial insertion.
            if let Some(index) = unmatched_release_index(sent, inputs.len()) {
                unsafe {
                    SendInput(1, &inputs[index], size_of::<INPUT>() as i32);
                }
            }
            return Err("Windows refused all or part of the input (possibly UIPI); some text may already have been typed".into());
        }
        sleep(Duration::from_millis(1));
    }
    Ok("unicode")
}

/// Ctrl+V into the front window: how the palette inserts an image, which cannot be typed. Not
/// part of dictation, which never touches the clipboard.
pub fn paste() -> Result<(), String> {
    let _lock = input_lock()?;
    if modifiers_down() {
        return Err("a modifier key is held down".into());
    }
    // 'V' is the same virtual key on every layout.
    let inputs = [key(VK_CONTROL, 0, 0), key(0x56, 0, 0), key(0x56, 0, KEYEVENTF_KEYUP), key(VK_CONTROL, 0, KEYEVENTF_KEYUP)];
    let sent = unsafe { SendInput(inputs.len() as u32, inputs.as_ptr(), size_of::<INPUT>() as i32) } as usize;
    if sent != inputs.len() {
        // Never leave our Ctrl or V held down.
        let release = [key(0x56, 0, KEYEVENTF_KEYUP), key(VK_CONTROL, 0, KEYEVENTF_KEYUP)];
        unsafe { SendInput(release.len() as u32, release.as_ptr(), size_of::<INPUT>() as i32) };
        return Err("Windows refused the Ctrl+V (possibly UIPI)".into());
    }
    Ok(())
}

pub fn accessibility() -> bool {
    true
}

pub fn open_permission() -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_balanced_unicode_and_virtual_events_without_sending() {
        for (ch, count) in [('A', 2), ('中', 2), ('😀', 4), ('\n', 2), ('\t', 2)] {
            let events = character_inputs(ch);
            assert_eq!(events.len(), count);
            for pair in events.chunks_exact(2) {
                unsafe {
                    assert_eq!(pair[0].Anonymous.ki.wVk, pair[1].Anonymous.ki.wVk);
                    assert_eq!(pair[0].Anonymous.ki.wScan, pair[1].Anonymous.ki.wScan);
                    assert_eq!(
                        pair[0].Anonymous.ki.dwFlags | KEYEVENTF_KEYUP,
                        pair[1].Anonymous.ki.dwFlags
                    );
                }
            }
        }
    }

    #[test]
    fn preserves_surrogate_order_and_releases_only_unmatched_down_events() {
        let events = character_inputs('😀');
        unsafe {
            assert_eq!(events[0].Anonymous.ki.wScan, 0xd83d);
            assert_eq!(events[2].Anonymous.ki.wScan, 0xde00);
        }
        for sent in 0..=5 {
            let index = unmatched_release_index(sent, events.len());
            assert_eq!(
                index,
                if sent == 1 || sent == 3 {
                    Some(sent)
                } else {
                    None
                }
            );
            if let Some(index) = index {
                unsafe {
                    assert_ne!(events[index].Anonymous.ki.dwFlags & KEYEVENTF_KEYUP, 0);
                }
            }
        }
    }

    #[test]
    fn paste_is_rejected_before_touching_native_state() {
        assert!(type_text("test", Way::Paste).is_err());
    }
}
