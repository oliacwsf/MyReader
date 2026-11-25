mod epub;
mod store;

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use store::Db;

const SUPPORTED: &[&str] = &[".pdf", ".epub", ".mobi", ".azw3", ".txt", ".html", ".htm", ".fb2", ".cbz", ".xps", ".svg"];

/// FNV-1a 64 位哈希：把文件的「完整路径」稳定映射成 16 位十六进制文件名，
/// 用于笔记文件的命名，避免同名文件共享同一笔记、也避免超长/特殊字符路径问题。
fn fnv1a64(s: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    pub last_dir: String,
    pub db_dir: String,
    pub note_dir: String,
    pub md_editor: String,
    pub font: String,
    pub font_size: u32,
    pub line_spacing: f64,
    pub zoom: f64,
    pub sc_page_down: String,
    pub sc_page_up: String,
    pub sc_fullscreen: String,
    /// PDF 渲染模式：high（高清，低清预览 700px→高清 3x）/ fast（极速，500px→2x）
    /// 对应 Python 版 SettingsDialog 的 pdf_mode_combo / PdfViewerWidget.render_mode
    pub pdf_render_mode: String,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            last_dir: String::new(),
            db_dir: String::new(),
            note_dir: String::new(),
            md_editor: String::new(),
            font: "Microsoft YaHei".into(),
            font_size: 16,
            line_spacing: 1.5,
            zoom: 1.0,
            sc_page_down: "ArrowRight".into(),
            sc_page_up: "ArrowLeft".into(),
            sc_fullscreen: "F11".into(),
            pdf_render_mode: "high".into(),
        }
    }
}

#[derive(Serialize)]
pub struct FileEntry {
    pub name: String,
    pub ext: String,
    pub size: u64,
    pub note: String,
    pub has_note: bool,
    pub path: String,
}

pub struct AppState {
    pub base: PathBuf,
    pub config_path: PathBuf,
    pub db: Db,
    pub config: Mutex<Config>,
    pub books: Mutex<HashMap<String, epub::BookIndex>>,
}

impl AppState {
    fn new() -> Result<Self, String> {
        let base = store::base_dir();
        let config_path = base.join("config.json");
        let mut config: Config = std::fs::read_to_string(&config_path)
            .ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        if config.last_dir.is_empty() { config.last_dir = base.to_string_lossy().into_owned(); }
        let db_dir = if config.db_dir.is_empty() { base.join("database") } else { PathBuf::from(&config.db_dir) };
        let note_dir = if config.note_dir.is_empty() { base.join("note") } else { PathBuf::from(&config.note_dir) };
        config.db_dir = db_dir.to_string_lossy().into_owned();
        config.note_dir = note_dir.to_string_lossy().into_owned();
        std::fs::create_dir_all(&note_dir).map_err(|e| e.to_string())?;
        let db = Db::open(&db_dir)?;
        Ok(AppState { base, config_path, db, config: Mutex::new(config), books: Mutex::new(HashMap::new()) })
    }

    /// 笔记文件按「完整路径」哈希命名，不同目录下的同名文件各自独立，互不串扰。
    fn note_path(&self, file: &str) -> PathBuf {
        let cfg = self.config.lock().unwrap();
        PathBuf::from(&cfg.note_dir).join(format!("{:016x}.notes.md", fnv1a64(file)))
    }

    /// 旧版笔记文件按「文件名」命名（同名文件会串扰），仅用于读取时的兼容回退。
    fn legacy_note_path(&self, file: &str) -> PathBuf {
        let cfg = self.config.lock().unwrap();
        let name = Path::new(file).file_name().and_then(|s| s.to_str()).unwrap_or("book");
        PathBuf::from(&cfg.note_dir).join(format!("{}.notes.md", name))
    }

    /// 读取笔记内容：优先新命名（哈希隔离），内容为空时回退旧命名，保证旧笔记不丢失。
    fn note_text(&self, file: &str) -> String {
        let text = std::fs::read_to_string(self.note_path(file)).unwrap_or_default();
        if !text.trim().is_empty() {
            return text;
        }
        std::fs::read_to_string(self.legacy_note_path(file)).unwrap_or_default()
    }
}

// ---------------- 配置 ----------------

#[tauri::command]
fn get_config(state: tauri::State<'_, AppState>) -> Config {
    state.config.lock().unwrap().clone()
}

#[tauri::command]
fn set_config(cfg: Config, state: tauri::State<'_, AppState>) -> Result<(), String> {
    *state.config.lock().unwrap() = cfg.clone();
    std::fs::write(&state.config_path, serde_json::to_string_pretty(&cfg).unwrap_or_default())
        .map_err(|e| e.to_string())
}

// ---------------- 文件列表 ----------------

fn human_size(n: u64) -> String {
    if n < 1024 { return format!("{} B", n); }
    if n < 1024 * 1024 { return format!("{:.1} KB", n as f64 / 1024.0); }
    if n < 1024 * 1024 * 1024 { return format!("{:.1} MB", n as f64 / 1048576.0); }
    format!("{:.2} GB", n as f64 / 1073741824.0)
}

#[tauri::command]
fn list_files(dir: String, search: String, filter: String, state: tauri::State<'_, AppState>) -> Vec<FileEntry> {
    let root = PathBuf::from(&dir);
    let notes = state.db.notes();
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(&root) else { return out; };
    let search = search.to_lowercase();
    for e in rd.flatten() {
        let p = e.path();
        if !p.is_file() { continue; }
        let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string();
        let ext = p.extension().and_then(|s| s.to_str()).map(|s| format!(".{}", s.to_lowercase())).unwrap_or_default();
        if !SUPPORTED.contains(&ext.as_str()) { continue; }
        if filter != "全部支持格式" && filter != ext { continue; }
        if !search.is_empty() && !name.to_lowercase().contains(&search) { continue; }
        let size = e.metadata().map(|m| m.len()).unwrap_or(0);
        let full = p.to_string_lossy().into_owned();
        let note = notes.get(&full).cloned().unwrap_or_default();
        // 只有笔记文件存在「且内容非空白」才算有笔记，空文件不再误判为有笔记
        let has_note = !state.note_text(&full).trim().is_empty();
        out.push(FileEntry { name, ext, size, note, has_note, path: full });
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

#[tauri::command]
fn human_size_of(n: u64) -> String { human_size(n) }

// ---------------- 书籍 ----------------

#[derive(Serialize)]
pub struct BookMeta {
    pub kind: String,
    pub pages: usize,
    pub toc: Vec<epub::TocItem>,
    /// EPUB 的 spine 表：规范化路径 + 分块页号 + 章节序号。
    /// 前端用它把页面内未被后端重写掉的原始相对链接映射回页号，做到文内链接 100% 跳转。
    /// PDF / TXT 等非 EPUB 返回空数组。
    pub spine: Vec<epub::SpineEntry>,
}

#[tauri::command]
async fn open_book(path: String, state: tauri::State<'_, AppState>) -> Result<BookMeta, String> {
    let p = PathBuf::from(&path);
    let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase();
    // 只建索引：EPUB 不在此处重写章节 / 内联图片，页面 HTML 推迟到 get_page 按 chunk 生成。
    // async 命令在后台线程池执行，避免大型 EPUB 的索引扫描阻塞 WebView 主线程。
    let book = match ext.as_str() {
        "epub" => epub::open_epub(&p)?,
        "txt" | "html" | "htm" => epub::open_text(&p)?,
        _ => epub::BookIndex::empty_pdf(&p),
    };
    let meta = BookMeta {
        kind: book.kind.clone(),
        pages: book.pages,
        toc: book.toc.clone(),
        spine: book.spine_entries(),
    };
    state.books.lock().unwrap().insert(path, book);
    Ok(meta)
}

#[tauri::command]
async fn get_page(path: String, index: usize, state: tauri::State<'_, AppState>) -> Result<String, String> {
    let mut books = state.books.lock().unwrap();
    let book = books.get_mut(&path).ok_or("书籍未打开")?;
    book.render_page(index)
}

#[tauri::command]
fn read_file_base64(path: String) -> Result<String, String> {
    let data = std::fs::read(&path).map_err(|e| e.to_string())?;
    Ok(STANDARD.encode(&data))
}

/// 二进制直传（对应 Python 直接把路径交给 QPdfDocument::load）。
/// base64 会让体积膨胀 1/3，JS 侧还要跑一遍 atob 循环，大 PDF 上这几个秒全白花。
#[tauri::command]
fn read_file_bytes(path: String) -> Result<tauri::ipc::Response, String> {
    let data = std::fs::read(&path).map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(data))
}

/// 按字节区间读取（供 PDF.js 的 PDFDataRangeTransport 做懒加载）。
/// 返回二进制而不是 base64：一本 200MB 的 PDF 若整本 base64 进 JS，
/// 光是解码就要几秒、内存还要翻三倍；按需只取当前页所在的一小段即可秒开。
#[tauri::command]
fn read_file_range(path: String, offset: u64, length: u64) -> Result<tauri::ipc::Response, String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let size = f.metadata().map_err(|e| e.to_string())?.len();
    let start = offset.min(size);
    let len = length.min(size - start) as usize;
    f.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; len];
    f.read_exact(&mut buf).map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(buf))
}

#[tauri::command]
fn file_size(path: String) -> Result<u64, String> {
    std::fs::metadata(&path).map(|m| m.len()).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_file_base64(path: String, data: String) -> Result<(), String> {
    let bytes = STANDARD.decode(&data).map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| e.to_string())
}

#[tauri::command]
fn clear_book(path: String, state: tauri::State<'_, AppState>) {
    state.books.lock().unwrap().remove(&path);
}

// ---------------- 笔记 / 备注 / 进度 / 书签 / 标注 ----------------

// ---------------- 最近阅读（存 SQLite，随软件目录便携） ----------------

#[tauri::command]
fn get_recent(state: tauri::State<'_, AppState>) -> Vec<Value> {
    state.db.get_recent()
}

#[tauri::command]
fn record_recent(path: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.db.record_recent(&path)
}

#[tauri::command]
fn load_note(path: String, state: tauri::State<'_, AppState>) -> String {
    state.note_text(&path)
}

#[tauri::command]
fn save_note(path: String, text: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let p = state.note_path(&path);
    let legacy = state.legacy_note_path(&path);
    if text.trim().is_empty() {
        // 清空笔记：删除新命名文件，同时清理旧版遗留的同名文件，保证「清空」彻底生效
        if p.exists() { std::fs::remove_file(&p).map_err(|e| e.to_string())?; }
        if legacy.exists() { std::fs::remove_file(&legacy).map_err(|e| e.to_string())?; }
    } else {
        std::fs::write(&p, text).map_err(|e| e.to_string())?;
        // 已迁移到新命名，删除旧版文件避免残留
        if legacy.exists() { let _ = std::fs::remove_file(&legacy); }
    }
    Ok(())
}

#[tauri::command]
fn delete_note(path: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let p = state.note_path(&path);
    let legacy = state.legacy_note_path(&path);
    if p.exists() { std::fs::remove_file(p).map_err(|e| e.to_string())?; }
    if legacy.exists() { std::fs::remove_file(legacy).map_err(|e| e.to_string())?; }
    Ok(())
}

#[tauri::command]
fn export_note(path: String, dest: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let text = state.note_text(&path);
    std::fs::write(&dest, text).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_note_meta(path: String, text: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.db.set_note_meta(&path, &text)
}

#[tauri::command]
fn clear_note_meta(path: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.db.clear_note_meta(&path)
}

#[tauri::command]
fn get_progress(path: String, state: tauri::State<'_, AppState>) -> Vec<i64> {
    let (p, g) = state.db.progress(&path);
    vec![p, g]
}

#[tauri::command]
fn set_progress(path: String, pos: i64, page: i64, kind: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.db.set_progress(&path, pos, page, &kind)
}

#[tauri::command]
fn get_bookmarks(path: String, state: tauri::State<'_, AppState>) -> Vec<Value> {
    state.db.bookmarks(&path)
}

#[tauri::command]
fn set_bookmarks(path: String, list: Vec<Value>, state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.db.set_bookmarks(&path, &list)
}

#[tauri::command]
fn get_annotations(path: String, state: tauri::State<'_, AppState>) -> Vec<Value> {
    state.db.annotations(&path)
}

#[tauri::command]
fn save_annotations(path: String, page: i64, list: Vec<Value>, state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.db.save_annotations(&path, page, &list)
}

#[tauri::command]
fn get_pdf_annotations(path: String, state: tauri::State<'_, AppState>) -> Value {
    state.db.pdf_annotations(&path)
}

#[tauri::command]
fn set_pdf_annotations(path: String, data: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.db.set_pdf_annotations(&path, &data)
}

// ---------------- 系统交互 ----------------

#[tauri::command]
fn open_external(path: String, editor: String) -> Result<(), String> {
    let exe = if !editor.is_empty() && Path::new(&editor).exists() { editor } else { String::new() };
    if !exe.is_empty() {
        std::process::Command::new(&exe).arg(&path).spawn().map_err(|e| e.to_string())?;
    } else if cfg!(target_os = "windows") {
        std::process::Command::new("cmd").args(["/C", "start", "", &path]).spawn().map_err(|e| e.to_string())?;
    } else {
        std::process::Command::new("xdg-open").arg(&path).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn base_path(state: tauri::State<'_, AppState>) -> String {
    state.base.to_string_lossy().into_owned()
}

/// 把标注引擎脚本内嵌进二进制，前端无需 fetch，离线可用
#[tauri::command]
fn annot_script() -> String {
    include_str!("../../dist/annot.js").to_string()
}

// ---- 系统对话框与窗口控制：前端不依赖任何 npm 包，全部走自定义命令 ----
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

fn picked(f: Option<tauri_plugin_dialog::FilePath>) -> Option<String> {
    f.and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
}

// 注意：必须把主窗口设为对话框的父窗口（set_parent）。
// 否则在 Windows 上对话框是一个独立的无 owner 顶层窗口，会被主窗口（WebView）压在下面，
// 用户必须先把主窗口拖开才能看到选择框。
#[tauri::command]
async fn pick_folder(window: tauri::WebviewWindow, default_path: Option<String>) -> Option<String> {
    let mut d = window.dialog().file().set_parent(&window);
    if let Some(p) = default_path.filter(|p| !p.is_empty()) { d = d.set_directory(p); }
    picked(d.blocking_pick_folder())
}

#[tauri::command]
async fn pick_file(window: tauri::WebviewWindow, default_path: Option<String>, extensions: Vec<String>) -> Option<String> {
    let mut d = window.dialog().file().set_parent(&window);
    if let Some(p) = default_path.filter(|p| !p.is_empty()) { d = d.set_directory(p); }
    if !extensions.is_empty() {
        let exts: Vec<&str> = extensions.iter().map(String::as_str).collect();
        d = d.add_filter("电子书", &exts);
    }
    picked(d.blocking_pick_file())
}

#[tauri::command]
async fn pick_save_path(window: tauri::WebviewWindow, default_path: Option<String>) -> Option<String> {
    let mut d = window.dialog().file().set_parent(&window);
    if let Some(n) = default_path.filter(|n| !n.is_empty()) { d = d.set_file_name(n); }
    picked(d.blocking_save_file())
}

#[tauri::command]
fn set_window_title(app: tauri::AppHandle, title: String) {
    if let Some(w) = app.get_webview_window("main") { let _ = w.set_title(&title); }
}

#[tauri::command]
fn toggle_fullscreen(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_fullscreen(!w.is_fullscreen().unwrap_or(false));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = AppState::new().expect("初始化失败");
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            get_config, set_config, list_files, human_size_of,
            open_book, get_page, read_file_base64, read_file_bytes,
            read_file_range, file_size, write_file_base64, clear_book,
            load_note, save_note, delete_note, export_note,
            get_recent, record_recent,
            set_note_meta, clear_note_meta,
            get_progress, set_progress,
            get_bookmarks, set_bookmarks,
            get_annotations, save_annotations,
            get_pdf_annotations, set_pdf_annotations,
            open_external, base_path, annot_script,
            pick_folder, pick_file, pick_save_path, set_window_title, toggle_fullscreen
        ])
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");
}
