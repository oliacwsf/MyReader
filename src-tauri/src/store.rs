//! SQLite 持久化：表结构与 Python 版完全一致，可直接沿用旧的 my_reader.db。
//! 自动修复旧库结构漂移（3/4/5 列 progress、错列名等），避免整体保存失败。
use rusqlite::{Connection, params};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const SCHEMA: &[(&str, &[(&str, &str)])] = &[
    ("notes", &[("file_path", "TEXT PRIMARY KEY"), ("note_text", "TEXT")]),
    ("recent", &[("file_path", "TEXT PRIMARY KEY"), ("opened_at", "INTEGER")]),
    ("progress", &[("file_path", "TEXT PRIMARY KEY"), ("scroll_pos", "INTEGER"), ("file_type", "TEXT"), ("page", "INTEGER")]),
    ("bookmarks", &[("file_path", "TEXT"), ("name", "TEXT"), ("pos", "INTEGER")]),
    ("pdf_annotations", &[("file_path", "TEXT PRIMARY KEY"), ("ann_data", "TEXT")]),
    ("epub_annotations", &[("file_path", "TEXT"), ("ann_data", "TEXT")]),
];

pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    pub fn open(dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let conn = Connection::open(dir.join("my_reader.db")).map_err(|e| e.to_string())?;
        let db = Db { conn: Mutex::new(conn) };
        db.ensure_schema()?;
        Ok(db)
    }

    fn ensure_schema(&self) -> Result<(), String> {
        let c = self.conn.lock().map_err(|e| e.to_string())?;
        for &(table, cols) in SCHEMA {
            let want: Vec<String> = cols.iter().map(|(n, _)| n.to_string()).collect();
            let defs = cols.iter().map(|(n, t)| format!("{} {}", n, t)).collect::<Vec<_>>().join(", ");
            let have: Vec<String> = {
                let mut stmt = c.prepare(&format!("PRAGMA table_info({})", table)).map_err(|e| e.to_string())?;
                let rows = stmt.query_map([], |r| r.get::<_, String>(1)).map_err(|e| e.to_string())?;
                rows.filter_map(|r| r.ok()).collect()
            };
            if have == want { continue; }
            if have.is_empty() {
                c.execute(&format!("CREATE TABLE {} ({})", table, defs), []).map_err(|e| e.to_string())?;
                continue;
            }
            let common: Vec<&str> = cols.iter().map(|(n, _)| *n)
                .filter(|n| have.iter().any(|h| h.as_str() == *n)).collect();
            c.execute(&format!("ALTER TABLE {} RENAME TO {}_old", table, table), []).map_err(|e| e.to_string())?;
            c.execute(&format!("CREATE TABLE {} ({})", table, defs), []).map_err(|e| e.to_string())?;
            if !common.is_empty() {
                let list = common.join(", ");
                c.execute(&format!("INSERT OR IGNORE INTO {} ({}) SELECT {} FROM {}_old", table, list, list, table), [])
                    .map_err(|e| e.to_string())?;
            }
            c.execute(&format!("DROP TABLE {}_old", table), []).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    // ---- 备注（文件列表第 5 列） ----
    pub fn notes(&self) -> HashMap<String, String> {
        let mut out = HashMap::new();
        if let Ok(c) = self.conn.lock() {
            if let Ok(mut s) = c.prepare("SELECT file_path, note_text FROM notes") {
                if let Ok(rows) = s.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))) {
                    for r in rows.flatten() { out.insert(r.0, r.1); }
                }
            }
        }
        out
    }

    pub fn set_note_meta(&self, path: &str, text: &str) -> Result<(), String> {
        let c = self.conn.lock().map_err(|e| e.to_string())?;
        c.execute("INSERT OR REPLACE INTO notes (file_path, note_text) VALUES (?, ?)", params![path, text])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn clear_note_meta(&self, path: &str) -> Result<(), String> {
        let c = self.conn.lock().map_err(|e| e.to_string())?;
        c.execute("DELETE FROM notes WHERE file_path = ?", params![path]).map_err(|e| e.to_string())?;
        Ok(())
    }

    // ---- 最近阅读（随 SQLite 数据库便携，最多 10 条） ----
    pub fn get_recent(&self) -> Vec<Value> {
        let mut out = Vec::new();
        if let Ok(c) = self.conn.lock() {
            if let Ok(mut s) = c.prepare("SELECT file_path, opened_at FROM recent ORDER BY opened_at DESC LIMIT 10") {
                if let Ok(rows) = s.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))) {
                    for r in rows.flatten() {
                        out.push(serde_json::json!({"path": r.0, "ts": r.1}));
                    }
                }
            }
        }
        out
    }

    pub fn record_recent(&self, path: &str) -> Result<(), String> {
        let c = self.conn.lock().map_err(|e| e.to_string())?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        c.execute("INSERT OR REPLACE INTO recent (file_path, opened_at) VALUES (?, ?)", params![path, now])
            .map_err(|e| e.to_string())?;
        // 只保留最近 10 条
        c.execute(
            "DELETE FROM recent WHERE file_path NOT IN (SELECT file_path FROM recent ORDER BY opened_at DESC LIMIT 10)",
            []).map_err(|e| e.to_string())?;
        Ok(())
    }

    // ---- 阅读进度 ----
    pub fn progress(&self, path: &str) -> (i64, i64) {
        if let Ok(c) = self.conn.lock() {
            if let Ok(v) = c.query_row("SELECT scroll_pos, page FROM progress WHERE file_path = ?", params![path],
                |r| Ok((r.get::<_, i64>(0).unwrap_or(0), r.get::<_, i64>(1).unwrap_or(0)))) { return v; }
        }
        (0, 0)
    }

    pub fn set_progress(&self, path: &str, pos: i64, page: i64, kind: &str) -> Result<(), String> {
        let c = self.conn.lock().map_err(|e| e.to_string())?;
        c.execute("INSERT OR REPLACE INTO progress (file_path, scroll_pos, file_type, page) VALUES (?, ?, ?, ?)",
                  params![path, pos, kind, page]).map_err(|e| e.to_string())?;
        Ok(())
    }

    // ---- 书签 ----
    pub fn bookmarks(&self, path: &str) -> Vec<Value> {
        let mut out = Vec::new();
        if let Ok(c) = self.conn.lock() {
            if let Ok(mut s) = c.prepare("SELECT name, pos FROM bookmarks WHERE file_path = ?") {
                if let Ok(rows) = s.query_map(params![path], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))) {
                    for r in rows.flatten() {
                        out.push(serde_json::json!({"name": r.0, "pos": r.1}));
                    }
                }
            }
        }
        out
    }

    pub fn set_bookmarks(&self, path: &str, list: &[Value]) -> Result<(), String> {
        let c = self.conn.lock().map_err(|e| e.to_string())?;
        c.execute("DELETE FROM bookmarks WHERE file_path = ?", params![path]).map_err(|e| e.to_string())?;
        for b in list {
            let name = b.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let pos = b.get("pos").and_then(|v| v.as_i64()).unwrap_or(0);
            c.execute("INSERT INTO bookmarks (file_path, name, pos) VALUES (?, ?, ?)", params![path, name, pos])
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    // ---- EPUB 标注（按页存储） ----
    pub fn annotations(&self, path: &str) -> Vec<Value> {
        let mut out = Vec::new();
        if let Ok(c) = self.conn.lock() {
            if let Ok(mut s) = c.prepare("SELECT ann_data FROM epub_annotations WHERE file_path = ?") {
                if let Ok(rows) = s.query_map(params![path], |r| r.get::<_, String>(0)) {
                    for r in rows.flatten() {
                        if let Ok(v) = serde_json::from_str::<Value>(&r) {
                            if v.is_object() { out.push(v); }
                        }
                    }
                }
            }
        }
        out
    }

    /// 只替换指定页的标注，保留其它页（与 Python 版合并语义一致）
    pub fn save_annotations(&self, path: &str, page: i64, list: &[Value]) -> Result<(), String> {
        let c = self.conn.lock().map_err(|e| e.to_string())?;
        let mut keep: Vec<String> = Vec::new();
        {
            let mut s = c.prepare("SELECT ann_data FROM epub_annotations WHERE file_path = ?").map_err(|e| e.to_string())?;
            let rows = s.query_map(params![path], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
            for r in rows.flatten() {
                if let Ok(v) = serde_json::from_str::<Value>(&r) {
                    if v.get("page").and_then(|x| x.as_i64()).unwrap_or(0) != page {
                        keep.push(r);
                    }
                }
            }
        }
        c.execute("DELETE FROM epub_annotations WHERE file_path = ?", params![path]).map_err(|e| e.to_string())?;
        for row in keep {
            c.execute("INSERT INTO epub_annotations (file_path, ann_data) VALUES (?, ?)", params![path, row])
                .map_err(|e| e.to_string())?;
        }
        for a in list {
            let mut obj = a.clone();
            if let Some(m) = obj.as_object_mut() { m.insert("page".into(), serde_json::json!(page)); }
            let s = serde_json::to_string(&obj).unwrap_or_default();
            c.execute("INSERT INTO epub_annotations (file_path, ann_data) VALUES (?, ?)", params![path, s])
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    // ---- PDF 标注 ----
    pub fn pdf_annotations(&self, path: &str) -> Value {
        if let Ok(c) = self.conn.lock() {
            if let Ok(s) = c.query_row("SELECT ann_data FROM pdf_annotations WHERE file_path = ?", params![path],
                |r| r.get::<_, String>(0)) {
                return serde_json::from_str(&s).unwrap_or(serde_json::json!([]));
            }
        }
        serde_json::json!([])
    }

    pub fn set_pdf_annotations(&self, path: &str, data: &str) -> Result<(), String> {
        let c = self.conn.lock().map_err(|e| e.to_string())?;
        c.execute("INSERT OR REPLACE INTO pdf_annotations (file_path, ann_data) VALUES (?, ?)", params![path, data])
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

pub fn base_dir() -> PathBuf {
    std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}
