//! Pure input preparation. No OS calls or clipboard access are allowed here.

use crate::{Way, MAX_CHARS};

pub fn ensure_unicode(way: Way) -> Result<(), String> {
    if way == Way::Paste {
        return Err("paste is unavailable: reliable clipboard preservation and paste completion cannot be guaranteed; use unicode or auto".into());
    }
    Ok(())
}

pub fn normalize(text: &str) -> Result<String, String> {
    if text.is_empty() || text.chars().count() > MAX_CHARS {
        return Err("text is empty or too long".into());
    }
    if text
        .chars()
        .any(|ch| ch.is_control() && !matches!(ch, '\n' | '\r' | '\t'))
    {
        return Err("text contains unsupported control characters".into());
    }
    // A CRLF is one Return; a standalone CR must not silently disappear.
    Ok(text.replace("\r\n", "\n").replace('\r', "\n"))
}

pub fn short_title(title: &str) -> String {
    let end = [" — ", " - "]
        .iter()
        .filter_map(|separator| title.find(separator))
        .min()
        .unwrap_or(title.len());
    title[..end].trim().chars().take(40).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_line_endings_and_preserves_unicode() {
        assert_eq!(normalize("a\r\nb\rc\n\t中😀").unwrap(), "a\nb\nc\n\t中😀");
    }

    #[test]
    fn rejects_controls_and_enforces_character_limit() {
        for text in ["", "a\0b", "\u{1b}", "\u{7f}", "\u{85}"] {
            assert!(normalize(text).is_err());
        }
        assert!(normalize(&"😀".repeat(MAX_CHARS)).is_ok());
        assert!(normalize(&"a".repeat(MAX_CHARS + 1)).is_err());
    }

    #[test]
    fn title_splits_at_the_first_separator_on_character_boundaries() {
        assert_eq!(
            short_title("index.ts — dsh-esp32 — Visual Studio Code"),
            "index.ts"
        );
        assert_eq!(short_title("Untitled - Notepad"), "Untitled");
        assert_eq!(short_title("a - b — c"), "a");
        assert_eq!(short_title(&"中😀".repeat(30)).chars().count(), 40);
        assert_eq!(short_title(""), "");
    }

    #[test]
    fn refuses_paste_without_a_fallback() {
        assert!(ensure_unicode(Way::Paste).is_err());
        assert!(ensure_unicode(Way::Auto).is_ok());
        assert!(ensure_unicode(Way::Unicode).is_ok());
    }
}
