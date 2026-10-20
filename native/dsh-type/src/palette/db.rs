//! The clipboard history: one SQLite file, a table for texts and one for images, and one for the
//! finished translations. Only this process opens it. Images are short-lived (see `IMAGE_TTL_MS`) and never pinned, so they need
//! no trimming by count and nothing of them is synced; the page tells them apart by a negative id.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::path::Path;

/// Longest text kept; a longer copy is not a note but a document and is left out.
pub const MAX_BYTES: usize = 64 * 1024;
/// The page holds a mirror of the list: each entry is cut here, the rest is fetched on demand.
const PREVIEW_CHARS: usize = 8192;
/// Rows listed at most (pinned ones included).
const MAX_LIST: i64 = 2000;
/// Old rows beyond the limit are deleted in batches, not on every copy.
const TRIM_EVERY: u32 = 50;
/// Changes remembered so a page that is a few behind gets only those rows, not the whole list.
const LOG: usize = 128;
/// An image not copied or used again within this time is dropped: screenshots are for now.
pub const IMAGE_TTL_MS: i64 = 5 * 60 * 60 * 1000;
/// Images kept at most, however recent: a burst of screenshots does not fill the disk.
const MAX_IMAGES: i64 = 100;
/// Translations kept, the most recent; the same text into the same language by the same bot is one.
pub const MAX_TRANSLATIONS: i64 = 200;

pub struct Db {
    conn: Connection,
    writes: u32,
    /// Bumped by every change; a page that already shows this version needs nothing sent.
    pub version: u64,
    /// The row each recent version touched; None for a change too broad to name (a trim).
    log: VecDeque<(u64, Option<i64>)>,
}

/// What a page that shows an older version needs to catch up.
pub enum Catch {
    Nothing,
    /// These rows changed; the ones that are gone appear in `gone`.
    Patch { rows: Vec<Value>, gone: Vec<i64> },
    Full(Value),
}

const COLUMNS: &str = "id, substr(text, 1, ?1), length(text) > ?1, app, pinned, at";

const IMAGE_COLUMNS: &str = "-id, w, h, length(data), app, at";

fn image_wire(row: &rusqlite::Row) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": row.get::<_, i64>(0)?,
        "img": [row.get::<_, i64>(1)?, row.get::<_, i64>(2)?],
        "size": row.get::<_, i64>(3)?,
        "text": "",
        "cut": false,
        "app": row.get::<_, String>(4)?,
        "pin": 0,
        "at": row.get::<_, i64>(5)?,
    }))
}

fn translation_wire(row: &rusqlite::Row) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": row.get::<_, i64>(0)?,
        "src": row.get::<_, String>(1)?,
        "out": row.get::<_, String>(2)?,
        "lang": row.get::<_, String>(3)?,
        "bot": row.get::<_, String>(4)?,
        "at": row.get::<_, i64>(5)?,
    }))
}

fn wire(row: &rusqlite::Row) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": row.get::<_, i64>(0)?,
        "text": row.get::<_, String>(1)?,
        "cut": row.get::<_, bool>(2)?,
        "app": row.get::<_, String>(3)?,
        // 0, or when it was pinned: pinned rows keep the order they were pinned in.
        "pin": row.get::<_, i64>(4)?,
        "at": row.get::<_, i64>(5)?,
    }))
}

/// FNV-1a: stable across runs and Rust versions, unlike `DefaultHasher`.
fn hash(bytes: &[u8]) -> i64 {
    let mut value: u64 = 0xcbf29ce484222325;
    for byte in bytes {
        value ^= *byte as u64;
        value = value.wrapping_mul(0x100000001b3);
    }
    value as i64
}

/// The row holding exactly `text` (Ok), or the free hash key to insert it under (Err).
fn slot(conn: &Connection, text: &str) -> Result<Result<i64, i64>, String> {
    let mut key = hash(text.as_bytes());
    loop {
        let found: Option<(i64, String)> = conn
            .query_row("SELECT id, text FROM clip WHERE hash = ?1", [key], |row| Ok((row.get(0)?, row.get(1)?)))
            .optional()
            .map_err(|e| e.to_string())?;
        match found {
            Some((id, existing)) if existing == text => return Ok(Ok(id)),
            // A hash collision between different texts: take the next key.
            Some(_) => key = key.wrapping_add(1),
            None => return Ok(Err(key)),
        }
    }
}

/// The image holding exactly `data` (Ok), or the free hash key to insert it under (Err).
fn image_slot(conn: &Connection, data: &[u8]) -> Result<Result<i64, i64>, String> {
    let mut key = hash(data);
    loop {
        let found: Option<(i64, Vec<u8>)> = conn
            .query_row("SELECT id, data FROM img WHERE hash = ?1", [key], |row| Ok((row.get(0)?, row.get(1)?)))
            .optional()
            .map_err(|e| e.to_string())?;
        match found {
            Some((id, existing)) if existing == data => return Ok(Ok(id)),
            Some(_) => key = key.wrapping_add(1),
            None => return Ok(Err(key)),
        }
    }
}

fn pinned_ids(conn: &Connection) -> Result<Vec<(i64, i64)>, String> {
    let mut statement = conn.prepare_cached("SELECT id, pinned FROM clip WHERE pinned > 0 ORDER BY id").map_err(|e| e.to_string())?;
    let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?))).map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

fn schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA synchronous=NORMAL;
         PRAGMA temp_store=MEMORY;
         PRAGMA cache_size=-512;
         PRAGMA auto_vacuum=INCREMENTAL;
         CREATE TABLE IF NOT EXISTS clip(
           id INTEGER PRIMARY KEY,
           text TEXT NOT NULL,
           hash INTEGER NOT NULL UNIQUE,
           app TEXT NOT NULL DEFAULT '',
           pinned INTEGER NOT NULL DEFAULT 0,
           copied_at INTEGER NOT NULL,
           used_at INTEGER NOT NULL DEFAULT 0,
           at INTEGER NOT NULL,
           uses INTEGER NOT NULL DEFAULT 0
         );
         CREATE INDEX IF NOT EXISTS clip_order ON clip(pinned DESC, at DESC);
         CREATE TABLE IF NOT EXISTS img(
           id INTEGER PRIMARY KEY,
           data BLOB NOT NULL,
           hash INTEGER NOT NULL UNIQUE,
           w INTEGER NOT NULL,
           h INTEGER NOT NULL,
           app TEXT NOT NULL DEFAULT '',
           at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS img_at ON img(at);
         CREATE TABLE IF NOT EXISTS tr(
           id INTEGER PRIMARY KEY,
           src TEXT NOT NULL,
           out TEXT NOT NULL,
           lang TEXT NOT NULL,
           bot TEXT NOT NULL DEFAULT '',
           at INTEGER NOT NULL,
           UNIQUE(src, lang, bot)
         );
         CREATE INDEX IF NOT EXISTS tr_at ON tr(at);
         CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT NOT NULL);",
    )
}

fn open_checked(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    schema(&conn)?;
    let check: String = conn.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
    if check != "ok" {
        return Err(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CORRUPT),
            Some(check),
        ));
    }
    Ok(conn)
}

impl Db {
    /// Opens the file; a damaged one is moved aside and replaced, so the palette still works.
    pub fn open(path: &Path) -> Result<Db, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let conn = match open_checked(path) {
            Ok(conn) => conn,
            Err(_) => {
                for suffix in ["", "-wal", "-shm"] {
                    let mut name = path.as_os_str().to_owned();
                    name.push(suffix);
                    let from = std::path::PathBuf::from(&name);
                    if suffix.is_empty() {
                        let mut backup = path.as_os_str().to_owned();
                        backup.push(".bak");
                        let _ = std::fs::rename(&from, backup);
                    } else {
                        let _ = std::fs::remove_file(&from);
                    }
                }
                open_checked(path).map_err(|e| e.to_string())?
            }
        };
        Ok(Db { conn, writes: 0, version: 1, log: VecDeque::new() })
    }

    fn changed(&mut self, id: Option<i64>) {
        self.version += 1;
        if self.log.len() == LOG {
            self.log.pop_front();
        }
        self.log.push_back((self.version, id));
    }

    /// Records a copy: a text seen before moves to the top, a new one is added.
    pub fn record(&mut self, text: &str, app: &str, now: i64, keep: usize) -> Result<Option<i64>, String> {
        if text.trim().is_empty() || text.len() > MAX_BYTES {
            return Ok(None);
        }
        self.expire(now)?;
        let id = match slot(&self.conn, text)? {
            Ok(id) => {
                self.conn
                    .execute(
                        "UPDATE clip SET copied_at = ?2, at = ?2, app = CASE WHEN ?3 = '' THEN app ELSE ?3 END WHERE id = ?1",
                        params![id, now, app],
                    )
                    .map_err(|e| e.to_string())?;
                id
            }
            Err(key) => {
                self.conn
                    .execute(
                        "INSERT INTO clip(text, hash, app, copied_at, at) VALUES(?1, ?2, ?3, ?4, ?4)",
                        params![text, key, app, now],
                    )
                    .map_err(|e| e.to_string())?;
                self.conn.last_insert_rowid()
            }
        };
        self.changed(Some(id));
        self.writes += 1;
        if self.writes >= TRIM_EVERY {
            self.writes = 0;
            self.trim(keep)?;
        }
        Ok(Some(id))
    }

    /// Deletes the oldest unpinned rows beyond `keep`.
    pub fn trim(&mut self, keep: usize) -> Result<(), String> {
        let removed = self
            .conn
            .execute(
                "DELETE FROM clip WHERE pinned = 0 AND id NOT IN (SELECT id FROM clip WHERE pinned = 0 ORDER BY at DESC LIMIT ?1)",
                [keep as i64],
            )
            .map_err(|e| e.to_string())?;
        if removed > 0 {
            self.changed(None);
            let _ = self.conn.execute_batch("PRAGMA incremental_vacuum(64)");
        }
        Ok(())
    }

    /// Records a copied image (a whole PNG): one seen before moves to the top and lives on.
    pub fn record_image(&mut self, data: &[u8], width: u32, height: u32, app: &str, now: i64) -> Result<Option<i64>, String> {
        if data.is_empty() || data.len() > super::image::MAX_IMAGE_BYTES {
            return Ok(None);
        }
        self.expire(now)?;
        let id = match image_slot(&self.conn, data)? {
            Ok(id) => {
                self.conn
                    .execute("UPDATE img SET at = ?2, app = CASE WHEN ?3 = '' THEN app ELSE ?3 END WHERE id = ?1", params![id, now, app])
                    .map_err(|e| e.to_string())?;
                id
            }
            Err(key) => {
                self.conn
                    .execute("INSERT INTO img(data, hash, w, h, app, at) VALUES(?1, ?2, ?3, ?4, ?5, ?6)", params![data, key, width, height, app, now])
                    .map_err(|e| e.to_string())?;
                self.conn.last_insert_rowid()
            }
        };
        self.changed(Some(-id));
        let extra: Vec<i64> = {
            let mut statement = self.conn.prepare_cached("SELECT id FROM img ORDER BY at DESC LIMIT -1 OFFSET ?1").map_err(|e| e.to_string())?;
            let rows = statement.query_map([MAX_IMAGES], |row| row.get(0)).map_err(|e| e.to_string())?;
            rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?
        };
        self.drop_images(&extra)?;
        Ok(Some(-id))
    }

    /// Drops the images unused for longer than `IMAGE_TTL_MS`.
    pub fn expire(&mut self, now: i64) -> Result<(), String> {
        let old: Vec<i64> = {
            let mut statement = self.conn.prepare_cached("SELECT id FROM img WHERE at < ?1").map_err(|e| e.to_string())?;
            let rows = statement.query_map([now - IMAGE_TTL_MS], |row| row.get(0)).map_err(|e| e.to_string())?;
            rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?
        };
        self.drop_images(&old)
    }

    fn drop_images(&mut self, ids: &[i64]) -> Result<(), String> {
        if ids.is_empty() {
            return Ok(());
        }
        for id in ids {
            self.conn.execute("DELETE FROM img WHERE id = ?1", [id]).map_err(|e| e.to_string())?;
            self.changed(Some(-id));
        }
        // Images are large: give their pages back to the disk at once.
        let _ = self.conn.execute_batch("PRAGMA incremental_vacuum");
        Ok(())
    }

    /// The PNG of an image, by its page id (negative).
    pub fn image(&self, id: i64) -> Option<Vec<u8>> {
        if id >= 0 {
            return None;
        }
        self.conn.query_row("SELECT data FROM img WHERE id = ?1", [-id], |row| row.get(0)).optional().ok().flatten()
    }

    pub fn used(&mut self, id: i64, now: i64) -> Result<(), String> {
        if id < 0 {
            self.conn.execute("UPDATE img SET at = ?2 WHERE id = ?1", params![-id, now]).map_err(|e| e.to_string())?;
            self.changed(Some(id));
            return Ok(());
        }
        self.conn
            .execute("UPDATE clip SET used_at = ?2, at = ?2, uses = uses + 1 WHERE id = ?1", params![id, now])
            .map_err(|e| e.to_string())?;
        self.changed(Some(id));
        Ok(())
    }

    /// Pins (at `now`, which orders the pinned rows) or unpins. Pinning a pinned row keeps its place.
    pub fn pin(&mut self, id: i64, on: bool, now: i64) -> Result<(), String> {
        if id < 0 {
            return Ok(());
        }
        self.conn
            .execute(
                "UPDATE clip SET pinned = CASE WHEN ?2 = 0 THEN 0 WHEN pinned > 0 THEN pinned ELSE ?3 END WHERE id = ?1",
                params![id, on as i64, now],
            )
            .map_err(|e| e.to_string())?;
        self.changed(Some(id));
        Ok(())
    }

    /// The pinned texts and when each was pinned, in the order they were pinned: what settings sync shares.
    pub fn pins(&self) -> Vec<(String, i64)> {
        let Ok(mut statement) = self.conn.prepare_cached("SELECT text, pinned FROM clip WHERE pinned > 0 ORDER BY pinned, id") else { return Vec::new() };
        let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)));
        rows.map(|rows| rows.filter_map(Result::ok).collect()).unwrap_or_default()
    }

    /// Makes exactly these texts the pinned ones, each with its pin time. A text already stored is
    /// pinned in place, never copied; a pinned row not listed goes back to the recent ones.
    pub fn set_pins(&mut self, items: &[(String, i64)], now: i64) -> Result<(), String> {
        let before = pinned_ids(&self.conn)?;
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        tx.execute("UPDATE clip SET pinned = 0 WHERE pinned > 0", []).map_err(|e| e.to_string())?;
        for (text, at) in items {
            if text.trim().is_empty() || text.len() > MAX_BYTES {
                continue;
            }
            let at = if *at > 0 { *at } else { now };
            let written = match slot(&tx, text)? {
                Ok(id) => tx.execute("UPDATE clip SET pinned = ?2 WHERE id = ?1", params![id, at]),
                Err(key) => tx.execute("INSERT INTO clip(text, hash, copied_at, at, pinned) VALUES(?1, ?2, ?3, ?3, ?3)", params![text, key, at]),
            };
            written.map_err(|e| e.to_string())?;
        }
        let after = pinned_ids(&tx)?;
        tx.commit().map_err(|e| e.to_string())?;
        // The pages learn only the rows whose pin changed.
        let mut ids: Vec<i64> = before.iter().chain(after.iter()).filter(|row| !(before.contains(row) && after.contains(row))).map(|(id, _)| *id).collect();
        ids.sort_unstable();
        ids.dedup();
        for id in ids {
            self.changed(Some(id));
        }
        Ok(())
    }

    /// Replaces a stored text, keeping its place, its pin and its source. A text that is already
    /// stored elsewhere is not added twice: that row takes the pin (the earlier one) and this one
    /// goes. Returns the row that now holds the text.
    pub fn edit(&mut self, id: i64, text: &str) -> Result<i64, String> {
        if id < 0 {
            return Err("an image cannot be edited".into());
        }
        if text.trim().is_empty() {
            return Err("the text is empty".into());
        }
        if text.len() > MAX_BYTES {
            return Err(format!("the text is too long (over {} KB)", MAX_BYTES / 1024));
        }
        let pinned: i64 = self
            .conn
            .query_row("SELECT pinned FROM clip WHERE id = ?1", [id], |row| row.get(0))
            .optional()
            .map_err(|e| e.to_string())?
            .ok_or("the entry is gone")?;
        match slot(&self.conn, text)? {
            Ok(same) if same == id => return Ok(id),
            Ok(other) => {
                let tx = self.conn.transaction().map_err(|e| e.to_string())?;
                tx.execute(
                    "UPDATE clip SET pinned = CASE WHEN ?2 = 0 THEN pinned WHEN pinned = 0 THEN ?2 ELSE min(pinned, ?2) END WHERE id = ?1",
                    params![other, pinned],
                )
                .map_err(|e| e.to_string())?;
                tx.execute("DELETE FROM clip WHERE id = ?1", [id]).map_err(|e| e.to_string())?;
                tx.commit().map_err(|e| e.to_string())?;
                self.changed(Some(id));
                self.changed(Some(other));
                Ok(other)
            }
            Err(key) => {
                self.conn.execute("UPDATE clip SET text = ?2, hash = ?3 WHERE id = ?1", params![id, text, key]).map_err(|e| e.to_string())?;
                self.changed(Some(id));
                Ok(id)
            }
        }
    }

    pub fn delete(&mut self, id: i64) -> Result<(), String> {
        if id < 0 {
            return self.drop_images(&[-id]);
        }
        self.conn.execute("DELETE FROM clip WHERE id = ?1", [id]).map_err(|e| e.to_string())?;
        self.changed(Some(id));
        Ok(())
    }

    pub fn full(&self, id: i64) -> Option<String> {
        if id < 0 {
            return None;
        }
        self.conn.query_row("SELECT text FROM clip WHERE id = ?1", [id], |row| row.get(0)).optional().ok().flatten()
    }

    /// The list as the page mirrors it: pinned rows in the order they were pinned, then the most
    /// recent, then the images (the page orders them among the texts by time).
    pub fn list(&self) -> Value {
        let sql = format!("SELECT {COLUMNS} FROM clip ORDER BY pinned = 0, pinned, at DESC LIMIT ?2");
        let Ok(mut statement) = self.conn.prepare_cached(&sql) else { return json!([]) };
        let mut rows: Vec<Value> = match statement.query_map(params![PREVIEW_CHARS as i64, MAX_LIST], wire) {
            Ok(rows) => rows.filter_map(Result::ok).collect(),
            Err(_) => Vec::new(),
        };
        let sql = format!("SELECT {IMAGE_COLUMNS} FROM img ORDER BY at DESC");
        if let Ok(mut statement) = self.conn.prepare_cached(&sql) {
            if let Ok(images) = statement.query_map([], image_wire) {
                rows.extend(images.filter_map(Result::ok));
            }
        }
        Value::Array(rows)
    }

    fn row(&self, id: i64) -> Option<Value> {
        if id < 0 {
            let sql = format!("SELECT {IMAGE_COLUMNS} FROM img WHERE id = ?1");
            let mut statement = self.conn.prepare_cached(&sql).ok()?;
            return statement.query_row([-id], image_wire).optional().ok().flatten();
        }
        let sql = format!("SELECT {COLUMNS} FROM clip WHERE id = ?2");
        let mut statement = self.conn.prepare_cached(&sql).ok()?;
        statement.query_row(params![PREVIEW_CHARS as i64, id], wire).optional().ok().flatten()
    }

    /// What a page showing version `seen` needs: the changed rows when they are few and known,
    /// else the whole list.
    pub fn since(&self, seen: u64) -> Catch {
        if seen == self.version {
            return Catch::Nothing;
        }
        let covered = self.log.front().is_some_and(|(first, _)| *first <= seen + 1);
        let ids: Option<Vec<i64>> = self.log.iter().filter(|(version, _)| *version > seen).map(|(_, id)| *id).collect();
        match ids {
            Some(mut ids) if covered && seen > 0 => {
                ids.sort_unstable();
                ids.dedup();
                let (mut rows, mut gone) = (Vec::new(), Vec::new());
                for id in ids {
                    match self.row(id) {
                        Some(row) => rows.push(row),
                        None => gone.push(id),
                    }
                }
                Catch::Patch { rows, gone }
            }
            _ => Catch::Full(self.list()),
        }
    }

    /// Keeps a finished translation as the page lists it; asked again, it moves to the top with
    /// the new result. The oldest beyond `MAX_TRANSLATIONS` go.
    pub fn record_translation(&mut self, src: &str, out: &str, lang: &str, bot: &str, now: i64) -> Result<Option<Value>, String> {
        if src.trim().is_empty() || out.trim().is_empty() || src.len() > MAX_BYTES || out.len() > MAX_BYTES {
            return Ok(None);
        }
        let row = self
            .conn
            .query_row(
                "INSERT INTO tr(src, out, lang, bot, at) VALUES(?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(src, lang, bot) DO UPDATE SET out = excluded.out, at = excluded.at
                 RETURNING id, src, out, lang, bot, at",
                params![src, out, lang, bot, now],
                translation_wire,
            )
            .map_err(|e| e.to_string())?;
        self.conn
            .execute("DELETE FROM tr WHERE id NOT IN (SELECT id FROM tr ORDER BY at DESC LIMIT ?1)", [MAX_TRANSLATIONS])
            .map_err(|e| e.to_string())?;
        Ok(Some(row))
    }

    /// The kept translations, the most recent first.
    pub fn translations(&self) -> Value {
        let Ok(mut statement) = self.conn.prepare_cached("SELECT id, src, out, lang, bot, at FROM tr ORDER BY at DESC") else { return json!([]) };
        let rows: Vec<Value> = match statement.query_map([], translation_wire) {
            Ok(rows) => rows.filter_map(Result::ok).collect(),
            Err(_) => Vec::new(),
        };
        Value::Array(rows)
    }

    pub fn delete_translation(&mut self, id: i64) -> Result<(), String> {
        self.conn.execute("DELETE FROM tr WHERE id = ?1", [id]).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn meta(&self, key: &str) -> Option<String> {
        self.conn.query_row("SELECT v FROM meta WHERE k = ?1", [key], |row| row.get(0)).optional().ok().flatten()
    }

    pub fn set_meta(&self, key: &str, value: &str) {
        let _ = self.conn.execute("INSERT INTO meta(k, v) VALUES(?1, ?2) ON CONFLICT(k) DO UPDATE SET v = ?2", params![key, value]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory() -> Db {
        let conn = Connection::open_in_memory().unwrap();
        schema(&conn).unwrap();
        Db { conn, writes: 0, version: 1, log: VecDeque::new() }
    }

    #[test]
    fn repeating_a_copy_moves_it_to_the_top_without_adding() {
        let mut db = memory();
        db.record("one", "A", 1, 10).unwrap();
        db.record("two", "B", 2, 10).unwrap();
        db.record("one", "", 3, 10).unwrap();
        let list = db.list();
        let items = list.as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["text"], "one");
        assert_eq!(items[0]["app"], "A", "a blank app keeps the known one");
    }

    #[test]
    fn pinned_rows_come_first_and_survive_trimming() {
        let mut db = memory();
        for (i, text) in ["a", "b", "c", "d"].iter().enumerate() {
            db.record(text, "", i as i64 + 1, 10).unwrap();
        }
        let id = db.list().as_array().unwrap().iter().find(|item| item["text"] == "a").unwrap()["id"].as_i64().unwrap();
        db.pin(id, true, 9).unwrap();
        db.trim(1).unwrap();
        let list = db.list();
        let texts: Vec<_> = list.as_array().unwrap().iter().map(|item| item["text"].as_str().unwrap().to_string()).collect();
        assert_eq!(texts, ["a", "d"]);
    }

    #[test]
    fn blank_and_oversized_text_is_not_kept() {
        let mut db = memory();
        db.record("  \n", "", 1, 10).unwrap();
        db.record(&"x".repeat(MAX_BYTES + 1), "", 2, 10).unwrap();
        assert_eq!(db.list().as_array().unwrap().len(), 0);
    }

    #[test]
    fn long_text_is_previewed_and_fetched_whole() {
        let mut db = memory();
        let text = "字".repeat(PREVIEW_CHARS + 5);
        db.record(&text, "", 1, 10).unwrap();
        let list = db.list();
        let item = &list.as_array().unwrap()[0];
        assert_eq!(item["text"].as_str().unwrap().chars().count(), PREVIEW_CHARS);
        assert_eq!(item["cut"], true);
        assert_eq!(db.full(item["id"].as_i64().unwrap()).unwrap(), text);
    }

    #[test]
    fn using_a_row_reorders_and_counts() {
        let mut db = memory();
        db.record("a", "", 1, 10).unwrap();
        db.record("b", "", 2, 10).unwrap();
        let id = db.list().as_array().unwrap()[1]["id"].as_i64().unwrap();
        let before = db.version;
        db.used(id, 3).unwrap();
        assert!(db.version > before);
        assert_eq!(db.list().as_array().unwrap()[0]["text"], "a");
    }

    #[test]
    fn images_are_kept_apart_never_pinned_and_dropped_after_their_time() {
        let mut db = memory();
        db.record("text", "", 1, 10).unwrap();
        let seen = db.version;
        let a = db.record_image(b"png-a", 4, 3, "Shot", 10).unwrap().unwrap();
        assert!(a < 0, "an image's page id is negative");
        assert_eq!(db.record_image(b"png-a", 4, 3, "", 20).unwrap(), Some(a), "the same image again is one row");
        assert_eq!(db.image(a).as_deref(), Some(&b"png-a"[..]));
        assert_eq!(db.full(a), None);
        db.pin(a, true, 21).unwrap();
        assert!(db.pins().is_empty());
        match db.since(seen) {
            Catch::Patch { rows, .. } => {
                assert_eq!(rows[0]["img"], json!([4, 3]));
                assert_eq!(rows[0]["app"], "Shot");
                assert_eq!(rows[0]["pin"], 0);
            }
            _ => panic!("expected a patch"),
        }
        let b = db.record_image(b"png-b", 1, 1, "", 30).unwrap().unwrap();
        db.used(a, 40).unwrap();
        db.expire(30 + IMAGE_TTL_MS + 1).unwrap();
        assert_eq!(db.image(b), None, "unused for its time: dropped");
        assert!(db.image(a).is_some(), "using an image keeps it");
        db.delete(a).unwrap();
        assert_eq!(db.list().as_array().unwrap().len(), 1, "texts stay");
    }

    #[test]
    fn translations_are_kept_once_newest_first_and_capped() {
        let mut db = memory();
        let first = db.record_translation("你好", "Hello", "en", "", 1).unwrap().unwrap();
        db.record_translation("早上好", "Good morning", "en", "", 2).unwrap();
        let again = db.record_translation("你好", "Hi", "en", "", 3).unwrap().unwrap();
        assert_eq!(again["id"], first["id"], "the same text, language and bot is one entry");
        db.record_translation("你好", "Bonjour", "fr", "", 4).unwrap();
        assert_eq!(db.record_translation(" ", "x", "en", "", 5).unwrap(), None);
        let list = db.translations();
        let outs: Vec<_> = list.as_array().unwrap().iter().map(|row| row["out"].as_str().unwrap().to_string()).collect();
        assert_eq!(outs, ["Bonjour", "Hi", "Good morning"]);
        db.delete_translation(first["id"].as_i64().unwrap()).unwrap();
        assert_eq!(db.translations().as_array().unwrap().len(), 2);
        for i in 0..MAX_TRANSLATIONS + 5 {
            db.record_translation(&format!("t{i}"), "o", "en", "", 10 + i).unwrap();
        }
        let list = db.translations();
        assert_eq!(list.as_array().unwrap().len() as i64, MAX_TRANSLATIONS);
        assert_eq!(list[0]["src"], format!("t{}", MAX_TRANSLATIONS + 4));
    }

    #[test]
    fn meta_round_trips() {
        let db = memory();
        assert_eq!(db.meta("bot"), None);
        db.set_meta("bot", "reviewer");
        db.set_meta("bot", "writer");
        assert_eq!(db.meta("bot").as_deref(), Some("writer"));
    }

    #[test]
    fn a_page_a_few_changes_behind_gets_only_those_rows() {
        let mut db = memory();
        db.record("a", "", 1, 10).unwrap();
        assert!(matches!(db.since(0), Catch::Full(_)), "a page that has nothing gets everything");
        let seen = db.version;
        assert!(matches!(db.since(seen), Catch::Nothing));
        let b = db.record("b", "", 2, 10).unwrap().unwrap();
        let a = db.record("a", "", 3, 10).unwrap().unwrap();
        db.delete(b).unwrap();
        match db.since(seen) {
            Catch::Patch { rows, gone } => {
                assert_eq!(rows.len(), 1);
                assert_eq!(rows[0]["id"], a);
                assert_eq!(rows[0]["at"], 3);
                assert_eq!(gone, [b]);
            }
            _ => panic!("expected a patch"),
        }
    }

    #[test]
    fn a_trim_or_a_long_absence_sends_the_whole_list() {
        let mut db = memory();
        db.record("a", "", 1, 10).unwrap();
        let seen = db.version;
        db.record("b", "", 2, 10).unwrap();
        db.trim(1).unwrap();
        assert!(matches!(db.since(seen), Catch::Full(_)));
        let seen = db.version;
        for i in 0..LOG + 1 {
            db.record(&format!("x{i}"), "", 10 + i as i64, 1000).unwrap();
        }
        assert!(matches!(db.since(seen), Catch::Full(_)));
    }

    #[test]
    fn setting_the_pins_pins_stored_texts_in_place_and_never_duplicates() {
        let mut db = memory();
        db.record("keep", "", 1, 10).unwrap();
        db.record("drop", "", 2, 10).unwrap();
        let drop = db.list().as_array().unwrap().iter().find(|item| item["text"] == "drop").unwrap()["id"].as_i64().unwrap();
        db.pin(drop, true, 5).unwrap();
        let seen = db.version;
        // "keep" exists unpinned, "new" does not exist, "drop" is no longer wanted; the duplicate is one row.
        db.set_pins(&[("new".into(), 30), ("keep".into(), 20), ("keep".into(), 20), ("  ".into(), 1)], 99).unwrap();
        assert_eq!(db.pins(), [("keep".to_string(), 20), ("new".to_string(), 30)]);
        let list = db.list();
        assert_eq!(list.as_array().unwrap().len(), 3, "keep and drop stay stored, new is added once");
        assert!(matches!(db.since(seen), Catch::Patch { .. }));
        // The same set again changes nothing.
        let settled = db.version;
        db.set_pins(&[("keep".into(), 20), ("new".into(), 30)], 99).unwrap();
        assert_eq!(db.version, settled);
        // A pin without a time takes the time of the call.
        db.set_pins(&[("keep".into(), 0)], 77).unwrap();
        assert_eq!(db.pins(), [("keep".to_string(), 77)]);
    }

    #[test]
    fn editing_keeps_the_row_or_folds_into_the_same_text() {
        let mut db = memory();
        let a = db.record("draft", "Notes", 1, 10).unwrap().unwrap();
        let b = db.record("final", "", 2, 10).unwrap().unwrap();
        db.pin(a, true, 5).unwrap();
        assert_eq!(db.edit(a, "draft v2").unwrap(), a);
        assert_eq!(db.full(a).as_deref(), Some("draft v2"));
        assert_eq!(db.pins(), [("draft v2".to_string(), 5)], "the pin and its time stay");
        assert_eq!(db.list().as_array().unwrap()[0]["app"], "Notes");
        // Now the same as another entry: one row is left, and it is pinned.
        assert_eq!(db.edit(a, "final").unwrap(), b);
        assert_eq!(db.full(a), None);
        assert_eq!(db.pins(), [("final".to_string(), 5)]);
        assert!(db.edit(b, "  ").is_err());
        assert!(db.edit(b, &"x".repeat(MAX_BYTES + 1)).is_err());
        assert!(db.edit(-1, "x").is_err());
        // The old text is no longer found as a copy: copying it again adds it.
        assert_ne!(db.record("draft v2", "", 3, 10).unwrap(), Some(b));
    }

    #[test]
    fn pinned_rows_keep_the_order_they_were_pinned_in() {
        let mut db = memory();
        let a = db.record("a", "", 1, 10).unwrap().unwrap();
        let b = db.record("b", "", 2, 10).unwrap().unwrap();
        db.record("c", "", 3, 10).unwrap();
        db.pin(b, true, 10).unwrap();
        db.pin(a, true, 11).unwrap();
        db.used(b, 12).unwrap();
        db.pin(b, true, 13).unwrap();
        let list = db.list();
        let texts: Vec<_> = list.as_array().unwrap().iter().map(|item| item["text"].as_str().unwrap().to_string()).collect();
        assert_eq!(texts, ["b", "a", "c"], "using or re-pinning a pinned row does not move it");
    }
}
