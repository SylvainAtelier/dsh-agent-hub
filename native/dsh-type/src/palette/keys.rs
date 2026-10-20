//! Accelerator text ("Ctrl+Alt+V") to a global hotkey. The settings page records the same names.

use global_hotkey::hotkey::{Code, HotKey, Modifiers};

fn code(name: &str) -> Option<Code> {
    let upper = name.to_ascii_uppercase();
    if upper.len() == 1 {
        let ch = upper.as_bytes()[0];
        return match ch {
            b'A'..=b'Z' => format!("Key{}", ch as char).parse().ok(),
            b'0'..=b'9' => format!("Digit{}", ch as char).parse().ok(),
            _ => None,
        };
    }
    if let Some(number) = upper.strip_prefix('F').and_then(|n| n.parse::<u8>().ok()) {
        if (1..=24).contains(&number) {
            return format!("F{number}").parse().ok();
        }
    }
    match upper.as_str() {
        "SPACE" => Some(Code::Space),
        "ENTER" | "RETURN" => Some(Code::Enter),
        "TAB" => Some(Code::Tab),
        "BACKSPACE" => Some(Code::Backspace),
        "INSERT" => Some(Code::Insert),
        "DELETE" => Some(Code::Delete),
        "HOME" => Some(Code::Home),
        "END" => Some(Code::End),
        "PAGEUP" => Some(Code::PageUp),
        "PAGEDOWN" => Some(Code::PageDown),
        "UP" => Some(Code::ArrowUp),
        "DOWN" => Some(Code::ArrowDown),
        "LEFT" => Some(Code::ArrowLeft),
        "RIGHT" => Some(Code::ArrowRight),
        "MINUS" => Some(Code::Minus),
        "EQUAL" => Some(Code::Equal),
        "COMMA" => Some(Code::Comma),
        "PERIOD" => Some(Code::Period),
        "SLASH" => Some(Code::Slash),
        "SEMICOLON" => Some(Code::Semicolon),
        "QUOTE" => Some(Code::Quote),
        "BACKQUOTE" => Some(Code::Backquote),
        "BRACKETLEFT" => Some(Code::BracketLeft),
        "BRACKETRIGHT" => Some(Code::BracketRight),
        "BACKSLASH" => Some(Code::Backslash),
        _ => None,
    }
}

/// A hotkey needs a key and at least one modifier: a bare letter would take over typing everywhere.
pub fn parse(accel: &str) -> Result<HotKey, String> {
    let mut modifiers = Modifiers::empty();
    let mut key = None;
    for part in accel.split('+').map(str::trim).filter(|part| !part.is_empty()) {
        match part.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => modifiers |= Modifiers::CONTROL,
            "alt" | "option" => modifiers |= Modifiers::ALT,
            "shift" => modifiers |= Modifiers::SHIFT,
            "cmd" | "command" | "meta" | "super" | "win" => modifiers |= Modifiers::META,
            _ => {
                if key.replace(code(part).ok_or_else(|| format!("unknown key \"{part}\""))?).is_some() {
                    return Err("only one key may follow the modifiers".into());
                }
            }
        }
    }
    let key = key.ok_or("no key")?;
    if modifiers.is_empty() {
        return Err("add a modifier (Ctrl, Alt, Shift or Cmd)".into());
    }
    Ok(HotKey::new(Some(modifiers), key))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_modifiers_and_keys() {
        let key = parse("Ctrl+Alt+V").unwrap();
        assert_eq!(key, HotKey::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyV));
        assert_eq!(parse("shift + f5").unwrap(), HotKey::new(Some(Modifiers::SHIFT), Code::F5));
        assert_eq!(parse("Cmd+Shift+Space").unwrap(), HotKey::new(Some(Modifiers::META | Modifiers::SHIFT), Code::Space));
        assert_eq!(parse("Ctrl+1").unwrap(), HotKey::new(Some(Modifiers::CONTROL), Code::Digit1));
        assert_eq!(parse("Ctrl+Space").unwrap(), HotKey::new(Some(Modifiers::CONTROL), Code::Space));
    }

    #[test]
    fn refuses_what_would_break_typing() {
        assert!(parse("V").is_err());
        assert!(parse("Ctrl+").is_err());
        assert!(parse("Ctrl+A+B").is_err());
        assert!(parse("Ctrl+Nope").is_err());
        assert!(parse("").is_err());
    }
}
