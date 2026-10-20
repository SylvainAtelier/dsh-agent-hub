//! dsh-type: puts dictated text into the front app, for dsh-agent-hub's
//! Cardputer module. One JSON request per line on stdin, one reply per line
//! on stdout; it exits when stdin closes. It opens no socket and reads no
//! file: it only types and names the front app. Paste is explicitly refused.
//!
//!   {"id":1,"op":"front"}                        -> {"id":1,"app":"Code","title":"index.ts"}
//!   {"id":2,"op":"type","text":"…","way":"auto"} -> {"id":2,"ok":true,"way":"unicode"}
//!   {"id":3,"op":"perm"}                         -> {"id":3,"accessibility":true}
//!   {"id":4,"op":"open-perm"}                    -> {"id":4,"ok":true}
//!
//! With `--palette` it is the clipboard history and translation window instead (palette/mod.rs).

use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

mod input;
#[cfg(any(windows, target_os = "macos"))]
mod palette;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use macos as platform;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as platform;

#[cfg(not(any(windows, target_os = "macos")))]
mod platform {
    pub fn front() -> Option<(String, String)> {
        None
    }
    pub fn type_text(_: &str, _: super::Way) -> Result<&'static str, String> {
        Err("dictation is not supported on this system".into())
    }
    pub fn accessibility() -> bool {
        true
    }
    pub fn open_permission() -> Result<(), String> {
        Ok(())
    }
}

/// How text reaches the front app.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Way {
    /// Native Unicode input, with no clipboard fallback.
    Auto,
    /// Native Unicode key events; the clipboard is left alone.
    Unicode,
    /// Reserved for explicit rejection until lossless paste is available.
    Paste,
}

impl Way {
    fn parse(value: Option<&str>) -> Result<Way, &'static str> {
        match value {
            Some("unicode") => Ok(Way::Unicode),
            Some("paste") => Ok(Way::Paste),
            Some("auto") | None => Ok(Way::Auto),
            _ => Err("unknown input way"),
        }
    }
}

/// Longest text accepted in one request: a dictation, not a document.
const MAX_CHARS: usize = 4000;

fn handle(request: &Value) -> Value {
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    match request.get("op").and_then(Value::as_str) {
        Some("front") => match platform::front() {
            Some((app, title)) => json!({ "id": id, "app": app, "title": title }),
            None => json!({ "id": id, "app": "" }),
        },
        Some("type") => {
            let text = request.get("text").and_then(Value::as_str).unwrap_or("");
            if text.is_empty() || text.chars().count() > MAX_CHARS {
                return json!({ "id": id, "ok": false, "error": "text is empty or too long" });
            }
            if request.get("way").is_some_and(|way| !way.is_string()) {
                return json!({ "id": id, "ok": false, "error": "way must be a string" });
            }
            let way = match Way::parse(request.get("way").and_then(Value::as_str)) {
                Ok(way) => way,
                Err(error) => return json!({ "id": id, "ok": false, "error": error }),
            };
            // Validate the entire input before the first native event is emitted.
            if let Err(error) = input::normalize(text).and_then(|_| input::ensure_unicode(way)) {
                return json!({ "id": id, "ok": false, "error": error });
            }
            match platform::type_text(text, way) {
                Ok(used) => json!({ "id": id, "ok": true, "way": used }),
                Err(error) => json!({ "id": id, "ok": false, "error": error }),
            }
        }
        Some("perm") => {
            #[cfg(target_os = "macos")]
            {
                let mut status = platform::permission_status();
                status["id"] = id;
                status
            }
            #[cfg(not(target_os = "macos"))]
            json!({ "id": id, "accessibility": platform::accessibility() })
        },
        Some("open-perm") => match platform::open_permission() {
            Ok(()) => json!({ "id": id, "ok": true }),
            Err(error) => json!({ "id": id, "ok": false, "error": error }),
        },
        _ => json!({ "id": id, "ok": false, "error": "unknown op" }),
    }
}

const MAX_LINE_BYTES: usize = 64 * 1024;

// Drain oversized frames without ever allocating proportional to their size.
fn read_frame(reader: &mut impl BufRead) -> io::Result<Option<Result<Vec<u8>, ()>>> {
    let mut line = Vec::new();
    let mut oversized = false;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok(if oversized {
                Some(Err(()))
            } else if line.is_empty() {
                None
            } else {
                Some(Ok(line))
            });
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let count = newline.map_or(available.len(), |index| index + 1);
        if !oversized {
            if count > MAX_LINE_BYTES - line.len() {
                oversized = true;
                line.clear();
            } else {
                line.extend_from_slice(&available[..count]);
            }
        }
        reader.consume(count);
        if newline.is_some() {
            return Ok(Some(if oversized { Err(()) } else { Ok(line) }));
        }
    }
}

fn main() {
    if std::env::args().any(|arg| arg == "--palette") {
        #[cfg(any(windows, target_os = "macos"))]
        return palette::run();
        #[cfg(not(any(windows, target_os = "macos")))]
        {
            eprintln!("the palette is not available on this system");
            std::process::exit(2);
        }
    }
    let stdin = io::stdin();
    let mut reader = stdin.lock();
    let mut stdout = io::stdout().lock();
    while let Ok(Some(frame)) = read_frame(&mut reader) {
        let reply = match frame {
            Err(()) => json!({ "id": null, "ok": false, "error": "request line is too long" }),
            Ok(line) => {
                if line.iter().all(u8::is_ascii_whitespace) {
                    continue;
                }
                match serde_json::from_slice::<Value>(&line) {
                    Ok(request) => handle(&request),
                    Err(_) => json!({ "id": null, "ok": false, "error": "invalid JSON" }),
                }
            }
        };
        if writeln!(stdout, "{reply}")
            .and_then(|()| stdout.flush())
            .is_err()
        {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unknown_and_empty_requests() {
        assert_eq!(
            handle(&json!({ "id": 1, "op": "nope" }))["ok"],
            json!(false)
        );
        assert_eq!(
            handle(&json!({ "id": 2, "op": "type", "text": "" }))["ok"],
            json!(false)
        );
        assert_eq!(handle(&json!({ "id": 3, "op": "perm" }))["id"], json!(3));
    }

    #[test]
    fn parses_ways() {
        assert_eq!(Way::parse(Some("paste")), Ok(Way::Paste));
        assert_eq!(Way::parse(Some("unicode")), Ok(Way::Unicode));
        assert_eq!(Way::parse(None), Ok(Way::Auto));
        assert!(Way::parse(Some("typo")).is_err());
    }

    #[test]
    fn invalid_type_requests_never_reach_native_input() {
        for request in [
            json!({"op":"type", "text":"test", "way":"typo"}),
            json!({"op":"type", "text":"test", "way":false}),
            json!({"op":"type", "text":"test", "way":"paste"}),
            json!({"op":"type", "text":"a\u{0}b"}),
            json!({"op":"type", "text":"x".repeat(MAX_CHARS + 1)}),
        ] {
            assert_eq!(handle(&request)["ok"], false);
        }
    }

    #[test]
    fn bounds_frames_and_recovers_at_the_next_line() {
        let mut bytes = vec![b'x'; MAX_LINE_BYTES + 100];
        bytes.extend_from_slice(b"\n{}\nlast");
        let mut reader = io::BufReader::with_capacity(7, io::Cursor::new(bytes));
        assert_eq!(read_frame(&mut reader).unwrap(), Some(Err(())));
        assert_eq!(read_frame(&mut reader).unwrap(), Some(Ok(b"{}\n".to_vec())));
        assert_eq!(read_frame(&mut reader).unwrap(), Some(Ok(b"last".to_vec())));
        assert_eq!(read_frame(&mut reader).unwrap(), None);
    }

    #[test]
    fn accepts_exact_frame_limit_and_rejects_oversized_unterminated_frame() {
        let mut reader = io::Cursor::new(vec![b'x'; MAX_LINE_BYTES]);
        assert_eq!(
            read_frame(&mut reader).unwrap().unwrap().unwrap().len(),
            MAX_LINE_BYTES
        );
        let mut reader = io::Cursor::new(vec![b'x'; MAX_LINE_BYTES + 1]);
        assert_eq!(read_frame(&mut reader).unwrap(), Some(Err(())));
        assert_eq!(read_frame(&mut reader).unwrap(), None);
    }
}
