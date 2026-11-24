//! EPUB 解析：与 Python 版 read_epub_html_chunks 等价。
//! 分块渲染（默认 80 章/页，>1500 章才拆）、目录解析、链接/锚点重写、
//! 图片与字体内联为 data URI（免除自定义协议，前端 iframe 直接渲染）。
//!
//! 与 Python 原版的加载时序保持一致：
//!   open_epub() 只做「元数据扫描」——container/OPF/manifest/spine、路径索引、
//!   锚点预扫描、目录、CSS、分块数，对应 read_epub_html_chunks 的解析阶段，
//!   但**不生成任何页面 HTML**；
//!   render_page(index) 才读取并重写该 chunk 的 80 章、内联该页资源、拼出单页，
//!   对应 EpubSchemeHandler.requestStarted 按需从 zip 供资源 +
//!   EpubWebEngineView.load_page 一次只 load 一个 pN.html。
//! 这样大型 EPUB 打开时不再一次性重写全部章节 / 内联全部图片，DOM 始终只有一页。
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use zip::ZipArchive;

pub const PAGE_CHUNK: usize = 80;
pub const SPLIT_THRESHOLD: usize = 1500;
/// 单页正文（zip 内解压后）预算。超过就先分页：图片 base64 会让单页 HTML 膨胀 1/3，
/// 一页塞几十 MB 时 WebView 解析要好几秒，分页后每页都能秒开。
pub const CHUNK_BYTES: usize = 2_000_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TocItem {
    pub title: String,
    pub href: String,
    pub children: Vec<TocItem>,
}

/// 返回给前端的 spine 表：前端据此把「未被后端重写掉」的原始相对链接
/// （如 ../Text/ch5.xhtml#sec）映射回「分块页号 + 章节序号」，实现文内链接 100% 跳转。
#[derive(Debug, Clone, Serialize)]
pub struct SpineEntry {
    /// zip 内规范化路径，如 "Text/ch1.xhtml"
    pub path: String,
    /// 该章所属分块页号（0-based，与 get_page 的 index 一致）
    pub page: usize,
    /// 该章在 spine 里的序号（锚点 id 前缀 chap_{idx}_ 用）
    pub idx: usize,
}

/// 打开书籍时只保存「索引」，不持有任何页面 HTML。
/// pages 为分块后的页数（对应 Python 的 page_nums / set_pages 的 key 数量）。
pub struct BookIndex {
    pub kind: String,
    pub pages: usize,
    pub toc: Vec<TocItem>,
    path: PathBuf,
    /// 每章在 zip 内的规范路径，索引即 spine 序号；空串表示该章缺失
    spine_files: Vec<String>,
    /// 小写路径 -> zip 内真实路径，只建一次（对应 EpubSchemeHandler._names）
    names: HashMap<String, String>,
    /// 路径 -> spine 序号，含短名唯一回退（对应 href_to_index）
    idx_map: HashMap<String, usize>,
    /// 会被 id_repl 保留的锚点集合（对应 preservable）
    preservable: HashSet<(usize, String)>,
    /// 每页对应的 spine 区间。分块同时受「章节数上限」和「单页原始字节预算」约束，
    /// 否则插图多的书会把几十 MB 图片 base64 全塞进一页，解析就要好几秒。
    chunk_ranges: Vec<(usize, usize)>,
    /// 章 -> 页 映射（链接、目录跨页重写用）
    page_of: Vec<usize>,
    css: String,
    /// TXT / HTML：直接是一页，无需分块
    text_page: Option<String>,
    /// 最近渲染过的少量页面，避免前后翻页反复解析同一 chunk
    cache: HashMap<usize, String>,
    cache_order: Vec<usize>,
    /// 常开 zip 句柄：对应 Python 里 EpubSchemeHandler 持有的同一份 zip。
    /// 每页都 File::open + 解析中央目录，在几千条目的书上就是每翻页多几十毫秒。
    zf: Option<ZipArchive<File>>,
}

const PAPER_CSS: &str = r#"
html { background-color: #e6e7ea !important; }
body { margin: 0 !important; padding: 0 !important; background: transparent !important; }
.paper { position: relative; width: 100%; max-width: 820px; margin: 26px auto; padding: 46px 54px;
  background: #fff; box-shadow: 0 2px 14px rgba(0,0,0,0.18); box-sizing: border-box;
  min-height: calc(100vh - 52px); word-wrap: break-word; overflow-wrap: break-word;
  font-size: 16px; line-height: 1.8; color: #222; }
/* 阅读栏窄于纸张宽度时自动适宽，并收窄内边距，避免内容被 padding 挤没 */
@media (max-width: 700px) {
  .paper { margin: 12px auto; padding: 26px 20px; }
}
.paper img, .paper svg, .paper image { display:block; margin:0 auto !important;
  max-width:100% !important; max-height:90vh !important; object-fit:contain !important; height:auto !important; }
.paper a { color:#1E88E5; text-decoration:none; cursor:pointer; }
.paper a:hover { text-decoration:underline; }
::-webkit-scrollbar { width:12px; height:12px; }
::-webkit-scrollbar-thumb { background:#c5c7cc; border-radius:6px; }
::-webkit-scrollbar-thumb:hover { background:#a9abb0; }
::-webkit-scrollbar-track { background:transparent; }
"#;

// ---------- 通用小工具（不引入 regex / urlencoding crate，控制体积） ----------

fn hexval(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (hexval(b[i + 1]), hexval(b[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub fn normpath(p: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for seg in p.split('/') {
        if seg.is_empty() || seg == "." { continue; }
        if seg == ".." { if !parts.is_empty() { parts.pop(); } }
        else { parts.push(seg); }
    }
    parts.join("/")
}

fn join_dir(base: &str, rel: &str) -> String {
    normpath(&format!("{}/{}", base, rel))
}

fn tag_name(tag: &str) -> String {
    let mut s = tag.trim_start_matches('<').trim_start_matches('/');
    let end = s.find(|c: char| !(c.is_ascii_alphanumeric() || c == ':' || c == '-')).unwrap_or(s.len());
    s = &s[..end];
    s.rsplit(':').next().unwrap_or(s).to_ascii_lowercase()
}

fn scan_tags(html: &str, want: Option<&str>) -> Vec<(usize, usize, String)> {
    let b = html.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] != b'<' { i += 1; continue; }
        let mut e = i + 1;
        let mut q = 0u8;
        while e < b.len() {
            if q != 0 { if b[e] == q { q = 0; } }
            else if b[e] == b'"' || b[e] == b'\'' { q = b[e]; }
            else if b[e] == b'>' { break; }
            e += 1;
        }
        let end = (e + 1).min(b.len());
        let text = html[i..end].to_string();
        let name = tag_name(&text);
        if want.map(|w| name == w).unwrap_or(true) {
            out.push((i, end, text));
        }
        i = end;
    }
    out
}

/// 返回属性值（支持单/双引号与无引号），大小写不敏感的属性名
fn find_attr(tag: &str, name: &str) -> Option<String> {
    let b = tag.as_bytes();
    let n: Vec<u8> = name.bytes().map(|c| c.to_ascii_lowercase()).collect();
    let mut i = 0;
    while i + n.len() <= b.len() {
        if (0..n.len()).all(|k| b[i + k].to_ascii_lowercase() == n[k]) {
            let before_ok = i == 0 || b[i - 1].is_ascii_whitespace() || b[i - 1] == b'<' || b[i - 1] == b':' || b[i - 1] == b'-';
            if before_ok {
                let mut j = i + n.len();
                while j < b.len() && b[j].is_ascii_whitespace() { j += 1; }
                if j < b.len() && b[j] == b'=' {
                    j += 1;
                    while j < b.len() && b[j].is_ascii_whitespace() { j += 1; }
                    if j < b.len() && (b[j] == b'"' || b[j] == b'\'') {
                        let quote = b[j];
                        j += 1;
                        let s = j;
                        while j < b.len() && b[j] != quote { j += 1; }
                        return Some(tag[s..j].to_string());
                    } else {
                        let s = j;
                        while j < b.len() && !b[j].is_ascii_whitespace() && b[j] != b'>' { j += 1; }
                        return Some(tag[s..j].to_string());
                    }
                }
            }
        }
        i += 1;
    }
    None
}

/// 定位属性引号内值的字节范围，用于原位替换
fn attr_span(tag: &str, name: &str) -> Option<(usize, usize)> {
    let b = tag.as_bytes();
    let n: Vec<u8> = name.bytes().map(|c| c.to_ascii_lowercase()).collect();
    let mut i = 0;
    while i + n.len() <= b.len() {
        if (0..n.len()).all(|k| b[i + k].to_ascii_lowercase() == n[k]) {
            let before_ok = i == 0 || b[i - 1].is_ascii_whitespace() || b[i - 1] == b'<' || b[i - 1] == b':' || b[i - 1] == b'-';
            if before_ok {
                let mut j = i + n.len();
                while j < b.len() && b[j].is_ascii_whitespace() { j += 1; }
                if j < b.len() && b[j] == b'=' {
                    j += 1;
                    while j < b.len() && b[j].is_ascii_whitespace() { j += 1; }
                    if j < b.len() && (b[j] == b'"' || b[j] == b'\'') {
                        let quote = b[j];
                        j += 1;
                        let s = j;
                        while j < b.len() && b[j] != quote { j += 1; }
                        return Some((s, j));
                    }
                    return None;
                }
            }
        }
        i += 1;
    }
    None
}

fn replace_attr(tag: &str, name: &str, value: &str) -> String {
    if let Some((s, e)) = attr_span(tag, name) {
        format!("{}{}{}", &tag[..s], value, &tag[e..])
    } else {
        tag.to_string()
    }
}

/// 快速锚点扫描：只找 id= / name= 的属性值，不做标签解析。
/// 旧实现每章 scan_tags + 全量 String 分配，1600 章的书要 400ms 以上；
/// 这里整章只扫一遍字节，命中才分配，剩下的时间都省给首屏。
fn scan_anchors_fast(html: &str, i: usize, out: &mut HashSet<(usize, String)>) {
    let b = html.as_bytes();
    let n = b.len();
    let mut k = 0usize;
    while k + 3 < n {
        let c = b[k];
        if c != b'i' && c != b'n' { k += 1; continue; }
        if k > 0 {
            let p = b[k - 1];
            if p.is_ascii_alphanumeric() || p == b'-' || p == b'_' { k += 1; continue; }
        }
        let q0 = if c == b'i' && b[k + 1] == b'd' {
            k + 2
        } else if c == b'n' && b[k + 1] == b'a' && b[k + 2] == b'm' && b[k + 3] == b'e' {
            k + 4
        } else { k += 1; continue; };
        let mut q = q0;
        // 必须是独立单词（id 后面不能紧跟字母数字）
        if q < n && (b[q].is_ascii_alphanumeric() || b[q] == b'-' || b[q] == b'_') { k += 1; continue; }
        while q < n && (b[q] == b' ' || b[q] == b'\t' || b[q] == b'\r' || b[q] == b'\n') { q += 1; }
        if q >= n || b[q] != b'=' { k += 1; continue; }
        q += 1;
        while q < n && (b[q] == b' ' || b[q] == b'\t' || b[q] == b'\r' || b[q] == b'\n') { q += 1; }
        if q >= n { break; }
        let quote = b[q];
        if quote != b'"' && quote != b'\'' { k += 1; continue; }
        q += 1;
        let start = q;
        while q < n && b[q] != quote { q += 1; }
        if q > start {
            if let Ok(v) = std::str::from_utf8(&b[start..q]) {
                if !v.is_empty() { out.insert((i, v.to_string())); }
            }
        }
        k = q + 1;
    }
}

fn strip_scripts(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    loop {
        let low = rest.to_ascii_lowercase();
        let Some(p) = low.find("<script") else { out.push_str(rest); break; };
        out.push_str(&rest[..p]);
        let after = &rest[p..];
        let Some(e) = after.to_ascii_lowercase().find("</script>") else { break; };
        rest = &after[e + 9..];
    }
    out
}

fn extract_body(s: &str) -> String {
    let low = s.to_ascii_lowercase();
    if let Some(p) = low.find("<body") {
        let after = &s[p..];
        if let Some(gt) = after.find('>') {
            let inner = &after[gt + 1..];
            if let Some(e) = inner.to_ascii_lowercase().find("</body>") {
                return inner[..e].to_string();
            }
            return inner.to_string();
        }
    }
    s.to_string()
}

fn mime_for(p: &str) -> &'static str {
    let l = p.to_ascii_lowercase();
    if l.ends_with(".png") { "image/png" }
    else if l.ends_with(".jpg") || l.ends_with(".jpeg") { "image/jpeg" }
    else if l.ends_with(".gif") { "image/gif" }
    else if l.ends_with(".svg") { "image/svg+xml" }
    else if l.ends_with(".webp") { "image/webp" }
    else if l.ends_with(".bmp") { "image/bmp" }
    else if l.ends_with(".ttf") { "font/ttf" }
    else if l.ends_with(".otf") { "font/otf" }
    else if l.ends_with(".woff") { "font/woff" }
    else if l.ends_with(".woff2") { "font/woff2" }
    else if l.ends_with(".mp3") { "audio/mpeg" }
    else { "application/octet-stream" }
}

fn read_entry(zf: &mut ZipArchive<File>, names: &HashMap<String, String>, path: &str) -> Option<Vec<u8>> {
    let mut buf = Vec::new();
    let real = names.get(&path.to_ascii_lowercase()).cloned().unwrap_or_else(|| path.to_string());
    if zf.by_name(&real).ok()?.read_to_end(&mut buf).is_ok() { Some(buf) } else { None }
}

fn read_text(zf: &mut ZipArchive<File>, names: &HashMap<String, String>, path: &str) -> Option<String> {
    read_entry(zf, names, path).map(|v| String::from_utf8_lossy(&v).into_owned())
}

/// 把相对资源变成 data URI；剥查询串、解码、大小写不敏感查找
fn data_uri(zf: &mut ZipArchive<File>, names: &HashMap<String, String>, base: &str, src: &str, force_mime: Option<&str>) -> Option<String> {
    let clean = src.split('?').next().unwrap_or(src);
    let decoded = percent_decode(clean);
    let full = join_dir(base, &decoded);
    let bytes = read_entry(zf, names, &full)?;
    let mime = force_mime.unwrap_or_else(|| mime_for(&full));
    Some(format!("data:{};base64,{}", mime, STANDARD.encode(&bytes)))
}

fn final_href(idx: usize, anchor: &str, preservable: &HashSet<(usize, String)>) -> String {
    if !anchor.is_empty() && preservable.contains(&(idx, anchor.to_string())) {
        format!("chap_{}_{}", idx, anchor)
    } else {
        format!("chap_{}", idx)
    }
}

fn toc_href(idx: usize, anchor: &str, preservable: &HashSet<(usize, String)>, page_of: &[usize]) -> String {
    format!("epub://p{}.html#{}", page_of.get(idx).copied().unwrap_or(0), final_href(idx, anchor, preservable))
}

fn resolve_idx(target_file: &str, base: &str, idx_map: &HashMap<String, usize>) -> Option<usize> {
    let abs = join_dir(base, target_file).to_ascii_lowercase();
    if let Some(i) = idx_map.get(&abs) { return Some(*i); }
    let bn = target_file.rsplit('/').next().unwrap_or(target_file).to_ascii_lowercase();
    if let Some(i) = idx_map.get(&bn) { return Some(*i); }
    let stem = bn.rsplit_once('.').map(|(a, _)| a).unwrap_or(&bn);
    idx_map.get(stem).copied()
}

fn text_of(s: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for c in s.chars() {
        if c == '<' { in_tag = true; continue; }
        if c == '>' { in_tag = false; continue; }
        if !in_tag { out.push(c); }
    }
    out.trim().to_string()
}

// ---------- NCX / EPUB3 Nav 目录 ----------

fn parse_ncx(xml: &str, base: &str, idx_map: &HashMap<String, usize>,
             preservable: &HashSet<(usize, String)>, page_of: &[usize]) -> Vec<TocItem> {
    let mut stack: Vec<TocItem> = Vec::new();
    let mut root: Vec<TocItem> = Vec::new();
    let mut cur: Option<TocItem> = None;
    for (_, _, tag) in scan_tags(xml, None) {
        let name = tag_name(&tag);
        if name == "navpoint" && !tag.starts_with("</") {
            if let Some(node) = cur.take() { stack.push(node); }
            cur = Some(TocItem { title: "未命名".into(), href: String::new(), children: vec![] });
        } else if name == "navpoint" && tag.starts_with("</") {
            let node = cur.take().unwrap_or(TocItem { title: "未命名".into(), href: String::new(), children: vec![] });
            if let Some(parent) = stack.pop() {
                let mut p = parent;
                p.children.push(node);
                cur = Some(p);
            } else {
                root.push(node);
            }
        } else if name == "text" && !tag.starts_with("</") {
            if let Some(node) = cur.as_mut() {
                // 文本在 </text> 之前：由调用方预扫描，这里用简单方式
                let _ = node;
            }
        } else if name == "content" {
            if let (Some(node), Some(src)) = (cur.as_mut(), find_attr(&tag, "src")) {
                let decoded = percent_decode(&src);
                let mut parts = decoded.splitn(2, '#');
                let f = parts.next().unwrap_or("").split('?').next().unwrap_or("");
                let a = parts.next().unwrap_or("");
                if let Some(i) = resolve_idx(f, base, idx_map) {
                    node.href = toc_href(i, a, preservable, page_of);
                }
            }
        }
    }
    // 标题：逐个 navPoint 块抽取 <text> 内容（与上面顺序扫描互补）
    let titles = extract_ncx_titles(xml);
    fn fill(nodes: &mut [TocItem], titles: &[String], idx: &mut usize) {
        for n in nodes.iter_mut() {
            if *idx < titles.len() { n.title = titles[*idx].clone(); }
            *idx += 1;
            fill(&mut n.children, titles, idx);
        }
    }
    let mut k = 0;
    fill(&mut root, &titles, &mut k);
    root
}

fn extract_ncx_titles(xml: &str) -> Vec<String> {
    let low = xml.to_ascii_lowercase();
    let mut out = Vec::new();
    let mut pos = 0;
    while let Some(p) = low[pos..].find("<text") {
        let start = pos + p;
        let after = &xml[start..];
        let Some(gt) = after.find('>') else { break; };
        let inner = &after[gt + 1..];
        let Some(e) = inner.to_ascii_lowercase().find("</text>") else { break; };
        let t = text_of(&inner[..e]);
        // 只收集 navPoint 内的 text：跳过 docTitle（文件头部）
        if start > 0 {
            let head = &low[..start];
            if head.contains("<navmap") || head.contains("<navpoint") { out.push(t); }
        }
        pos = start + gt + 1 + e + 7;
    }
    out
}

fn parse_nav(nav_html: &str, base: &str, idx_map: &HashMap<String, usize>,
             preservable: &HashSet<(usize, String)>, page_of: &[usize]) -> Vec<TocItem> {
    // 取 epub:type="toc" 的 nav，否则取第一个 nav
    let mut inner = nav_html;
    let low = nav_html.to_ascii_lowercase();
    if let Some(p) = low.find("epub:type=\"toc\"").or_else(|| low.find("epub:type='toc'")) {
        if let Some(gt) = nav_html[p..].find('>') {
            let rest = &nav_html[p + gt + 1..];
            if let Some(e) = rest.to_ascii_lowercase().find("</nav>") { inner = &rest[..e]; }
        }
    } else if let Some(p) = low.find("<nav") {
        if let Some(gt) = nav_html[p..].find('>') {
            let rest = &nav_html[p + gt + 1..];
            if let Some(e) = rest.to_ascii_lowercase().find("</nav>") { inner = &rest[..e]; }
        }
    }
    let mut out = Vec::new();
    let mut open: Option<(String, usize)> = None;
    for (s, e, tag) in scan_tags(inner, None) {
        let name = tag_name(&tag);
        if name == "a" && !tag.starts_with("</") {
            if let Some(h) = find_attr(&tag, "href") {
                open = Some((h, e));
            }
        } else if name == "a" && tag.starts_with("</") {
            if let Some((href, start)) = open.take() {
                let title = text_of(&inner[start..s]);
                if !title.is_empty() {
                    let decoded = percent_decode(&href);
                    let mut parts = decoded.splitn(2, '#');
                    let f = parts.next().unwrap_or("").split('?').next().unwrap_or("");
                    let a = parts.next().unwrap_or("");
                    let href_final = resolve_idx(f, base, idx_map)
                        .map(|i| toc_href(i, a, preservable, page_of)).unwrap_or_default();
                    out.push(TocItem { title, href: href_final, children: vec![] });
                }
            }
        }
    }
    out
}

/// 递归补齐空 href：返回该子树里第一个可用链接
fn fill_toc_href(items: &mut Vec<TocItem>) -> Option<String> {
    let mut first: Option<String> = None;
    for it in items.iter_mut() {
        let sub = fill_toc_href(&mut it.children);
        if it.href.is_empty() {
            if let Some(h) = sub { it.href = h; }
        }
        if first.is_none() && !it.href.is_empty() { first = Some(it.href.clone()); }
    }
    first
}

// ---------- 主解析 ----------

pub fn open_epub(path: &Path) -> Result<BookIndex, String> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    let mut zf = ZipArchive::new(file).map_err(|e| e.to_string())?;
    let names: HashMap<String, String> = (0..zf.len())
        .filter_map(|i| zf.by_index(i).ok().map(|f| (f.name().to_ascii_lowercase(), f.name().to_string())))
        .collect();

    let container = read_text(&mut zf, &names, "META-INF/container.xml").ok_or("缺少 container.xml")?;
    let opf_path = find_attr(&container, "full-path").ok_or("container.xml 缺少 full-path")?;
    let opf = read_text(&mut zf, &names, &opf_path).ok_or("缺少 OPF 文件")?;
    let opf_dir = opf_path.rsplit_once('/').map(|(a, _)| a).unwrap_or("");

    // manifest / spine
    let mut manifest: HashMap<String, String> = HashMap::new();
    let mut nav_href: Option<String> = None;
    for (_, _, tag) in scan_tags(&opf, Some("item")) {
        if let (Some(id), Some(href)) = (find_attr(&tag, "id"), find_attr(&tag, "href")) {
            let props = find_attr(&tag, "properties").unwrap_or_default();
            if props.split_whitespace().any(|p| p == "nav") && nav_href.is_none() { nav_href = Some(href.clone()); }
            if href.to_ascii_lowercase().ends_with(".ncx") { manifest.insert(id.clone(), href.clone()); }
            manifest.insert(id, href);
        }
    }
    let spine: Vec<String> = scan_tags(&opf, Some("itemref"))
        .iter().filter_map(|(_, _, t)| find_attr(t, "idref")).collect();
    let spine = if spine.is_empty() { manifest.keys().cloned().collect() } else { spine };

    // CSS（内联其中的 url() 资源）
    let mut css_parts = Vec::new();
    for href in manifest.values() {
        if href.to_ascii_lowercase().ends_with(".css") {
            let full = join_dir(opf_dir, &percent_decode(href));
            if let Some(c) = read_text(&mut zf, &names, &full) {
                css_parts.push(inline_css_urls(&c, &full, &mut zf, &names));
            }
        }
    }
    let css = css_parts.join("\n");

    // 路径索引：完整规范路径优先；短名仅在全书唯一时作回退
    let mut idx_map: HashMap<String, usize> = HashMap::new();
    let mut short_seen: HashMap<String, HashSet<usize>> = HashMap::new();
    for (i, sid) in spine.iter().enumerate() {
        let Some(raw) = manifest.get(sid) else { continue; };
        let decoded = percent_decode(raw);
        let abs = join_dir(opf_dir, &decoded).to_ascii_lowercase();
        idx_map.insert(abs, i);
        idx_map.entry(decoded.to_ascii_lowercase()).or_insert(i);
        let bn = decoded.rsplit('/').next().unwrap_or(&decoded).to_ascii_lowercase();
        for k in [bn.clone(), bn.rsplit_once('.').map(|(a, _)| a.to_string()).unwrap_or(bn.clone())] {
            short_seen.entry(k).or_default().insert(i);
        }
    }
    for (k, set) in short_seen {
        if set.len() == 1 { idx_map.insert(k, *set.iter().next().unwrap()); }
    }

    // 每章在 zip 内的规范路径（章节正文的重写推迟到 render_page）
    let spine_files: Vec<String> = spine.iter()
        .map(|sid| manifest.get(sid)
            .map(|h| join_dir(opf_dir, &percent_decode(h)))
            .unwrap_or_default())
        .collect();

    // 分块 = 章节数上限（原版 80 章/页）× 单页原始字节预算。
    // 只按章数切的话，插图多的书会把整本图片的 base64 全塞进一页，
    // 单页 HTML 能到几十 MB，WebView 解析就要好几秒 —— 这才是"打开慢"的真凶。
    let sizes: Vec<usize> = spine_files.iter()
        .map(|f| if f.is_empty() { 0 } else { zf.by_name(f).map(|x| x.size() as usize).unwrap_or(0) })
        .collect();
    let cap = if spine.len() > SPLIT_THRESHOLD { PAGE_CHUNK } else { spine.len().max(1) };
    let mut chunk_ranges: Vec<(usize, usize)> = Vec::new();
    let mut page_of: Vec<usize> = vec![0; spine_files.len()];
    let mut cs = 0usize;
    while cs < spine_files.len() {
        let mut ce = cs;
        let mut bytes = 0usize;
        while ce < spine_files.len() && (ce - cs) < cap {
            let sz = sizes[ce];
            if ce > cs && bytes + sz > CHUNK_BYTES { break; }
            bytes += sz;
            ce += 1;
        }
        if ce == cs { ce = cs + 1; }
        let page = chunk_ranges.len();
        for k in cs..ce { page_of[k] = page; }
        chunk_ranges.push((cs, ce));
        cs = ce;
    }

    // 预扫描：任意元素的 id/name 锚点集合（决定跳转链接要不要带 #anchor）。
    // 线性字节扫描 + 多线程分片：几千章的书上这一步原本要几百毫秒，
    // 每多等一秒用户就多一秒"点了没反应"。
    let mut preservable: HashSet<(usize, String)> = HashSet::new();
    {
        let n = spine_files.len();
        let nth = std::thread::available_parallelism().map(|v| v.get()).unwrap_or(2).min(4).min(n.max(1));
        let step = (n + nth - 1) / nth.max(1);
        let parts: Vec<HashSet<(usize, String)>> = std::thread::scope(|sc| {
            let mut hs = Vec::new();
            for t in 0..nth {
                let s0 = t * step;
                let s1 = ((t + 1) * step).min(n);
                if s0 >= s1 { continue; }
                let files = &spine_files;
                let names = &names;
                let path = &path;
                hs.push(sc.spawn(move || {
                    let mut out: HashSet<(usize, String)> = HashSet::new();
                    let Ok(f) = File::open(path) else { return out; };
                    let Ok(mut z) = ZipArchive::new(f) else { return out; };
                    for i in s0..s1 {
                        let full = &files[i];
                        if full.is_empty() { continue; }
                        if let Some(c) = read_text(&mut z, names, full) {
                            let c = if c.contains("<script") { strip_scripts(&c) } else { c };
                            scan_anchors_fast(&c, i, &mut out);
                        }
                    }
                    out
                }));
            }
            hs.into_iter().filter_map(|h| h.join().ok()).collect()
        });
        for r in parts { preservable.extend(r); }
    }

    // 目录
    let mut toc: Vec<TocItem> = Vec::new();
    if let Some(nh) = nav_href.as_ref() {
        let full = join_dir(opf_dir, &percent_decode(nh));
        if let Some(c) = read_text(&mut zf, &names, &full) {
            toc = parse_nav(&c, &full.rsplit_once('/').map(|(a, _)| a).unwrap_or(""), &idx_map, &preservable, &page_of);
        }
    }
    if toc.is_empty() {
        let spine_tag = scan_tags(&opf, Some("spine")).into_iter().next().map(|(_, _, t)| t).unwrap_or_default();
        let ncx_id = find_attr(&spine_tag, "toc")
            .or_else(|| manifest.iter().find(|(_, v)| v.to_ascii_lowercase().ends_with(".ncx")).map(|(k, _)| k.clone()));
        if let Some(id) = ncx_id {
            if let Some(href) = manifest.get(&id) {
                let full = join_dir(opf_dir, &percent_decode(href));
                if let Some(c) = read_text(&mut zf, &names, &full) {
                    toc = parse_ncx(&c, &full.rsplit_once('/').map(|(a, _)| a).unwrap_or(""), &idx_map, &preservable, &page_of);
                }
            }
        }
    }

    // 有些书的父级目录项只有标题、没有 href（真正的链接在子项里），
    // 前端点了就会"没反应"。这里让父项继承第一个可用的子项链接。
    fill_toc_href(&mut toc);

    // 对应 Python：open 阶段只把 pN.html 登记进 handler.pages，
    // requestStarted 命中后才返回内容，资源更是逐次从 zip 读取。
    let pages = chunk_ranges.len().max(1);

    Ok(BookIndex {
        kind: "epub".into(), pages, toc,
        path: path.to_path_buf(), spine_files, names, idx_map, preservable, css,
        chunk_ranges, page_of,
        text_page: None, cache: HashMap::new(), cache_order: Vec::new(), zf: Some(zf),
    })
}

/// 重写单章：去脚本、id/name 加 chap_{i}_ 前缀、链接改同/跨 chunk、图片内联。
/// 对应 Python read_epub_html_chunks 里 for i, sid in enumerate(spine) 的循环体。
/// 只有该章所属的 pN.html 被请求时才会执行 —— 大型 EPUB 不会被全量重写。
fn rewrite_chapter(
    zf: &mut ZipArchive<File>,
    names: &HashMap<String, String>,
    i: usize,
    full: &str,
    idx_map: &HashMap<String, usize>,
    preservable: &HashSet<(usize, String)>,
    page_of: &[usize],
) -> Option<String> {
    let orig = read_text(zf, names, full)?;
    let base = full.rsplit_once('/').map(|(a, _)| a).unwrap_or("");
    let mut content = strip_scripts(&orig).replace("<?xml", "<!-- xml").replace("?>", "-->");

    // 任意元素 id/name 重写
    let mut rebuilt = String::with_capacity(content.len() + 1024);
    let mut last = 0;
    for (s, e, tag) in scan_tags(&content, None) {
        rebuilt.push_str(&content[last..s]);
        let mut new_tag = tag.clone();
        for a in ["id", "name"] {
            if let Some(v) = find_attr(&tag, a) {
                new_tag = replace_attr(&new_tag, a, &format!("chap_{}_{}", i, v));
                break;
            }
        }
        rebuilt.push_str(&new_tag);
        last = e;
    }
    rebuilt.push_str(&content[last..]);
    content = rebuilt;

    // 链接重写：同 chunk 用 #frag，跨 chunk 用 epub://pN.html#frag
    let mut rebuilt = String::with_capacity(content.len() + 512);
    let mut last = 0;
    for (s, e, tag) in scan_tags(&content, Some("a")) {
        rebuilt.push_str(&content[last..s]);
        let Some(href) = find_attr(&tag, "href") else { rebuilt.push_str(&tag); last = e; continue; };
        let low = href.to_ascii_lowercase();
        if low.starts_with("http") || low.starts_with("mailto") || low.starts_with("javascript") || low.starts_with("data:") {
            rebuilt.push_str(&tag); last = e; continue;
        }
        let decoded = percent_decode(&href);
        let mut parts = decoded.splitn(2, '#');
        let f = parts.next().unwrap_or("").split('?').next().unwrap_or("");
        let a = parts.next().unwrap_or("");
        let new_href = if f.is_empty() {
            if !a.is_empty() { Some(format!("#{}", final_href(i, a, preservable))) } else { None }
        } else if let Some(t) = resolve_idx(f, base, idx_map) {
            let frag = final_href(t, a, preservable);
            let tp = page_of.get(t).copied().unwrap_or(0);
            let ip = page_of.get(i).copied().unwrap_or(0);
            if tp == ip { Some(format!("#{}", frag)) }
            else { Some(format!("epub://p{}.html#{}", tp, frag)) }
        } else { None };
        match new_href {
            Some(h) => rebuilt.push_str(&replace_attr(&tag, "href", &h)),
            None => rebuilt.push_str(&tag),
        }
        last = e;
    }
    rebuilt.push_str(&content[last..]);
    content = rebuilt;

    // 资源内联：只处理当前页这 80 章引用的图片/字体，其余仍留在 zip 里
    let mut rebuilt = String::with_capacity(content.len());
    let mut last = 0;
    for (s, e, tag) in scan_tags(&content, None) {
        rebuilt.push_str(&content[last..s]);
        let name = tag_name(&tag);
        let mut new_tag = tag.clone();
        if name == "img" {
            if let Some(src) = find_attr(&tag, "src") {
                if !src.starts_with("data:") && !src.starts_with("http") {
                    if let Some(uri) = data_uri(zf, names, base, &src, None) {
                        new_tag = replace_attr(&new_tag, "src", &uri);
                    }
                }
            }
        } else if name == "image" {
            if let Some(src) = find_attr(&tag, "href") {
                if !src.starts_with("data:") && !src.starts_with("http") {
                    if let Some(uri) = data_uri(zf, names, base, &src, None) {
                        new_tag = replace_attr(&new_tag, "href", &uri);
                    }
                }
            }
        }
        rebuilt.push_str(&new_tag);
        last = e;
    }
    rebuilt.push_str(&content[last..]);
    let body = extract_body(&rebuilt);
    Some(format!("<div id=\"chap_{}\">\n{}</div>", i, body))
}

impl BookIndex {
    /// 导出 spine 表（规范化路径 + 分块页号 + 章节序号），供前端解析原始相对链接。
    pub fn spine_entries(&self) -> Vec<SpineEntry> {
        self.spine_files.iter().enumerate()
            .filter(|(_, f)| !f.is_empty())
            .map(|(i, f)| SpineEntry {
                path: f.clone(),
                page: self.page_of.get(i).copied().unwrap_or(0),
                idx: i,
            })
            .collect()
    }

    /// PDF 由前端 PDF.js 直接处理，Rust 端只登记一个空索引
    pub fn empty_pdf(path: &Path) -> BookIndex {
        BookIndex {
            kind: "pdf".into(), pages: 0, toc: vec![], path: path.to_path_buf(),
            spine_files: vec![], names: HashMap::new(), idx_map: HashMap::new(),
            preservable: HashSet::new(), css: String::new(),
            chunk_ranges: vec![], page_of: vec![],
            text_page: None, cache: HashMap::new(), cache_order: vec![], zf: None,
        }
    }

    /// 生成第 index 个分块页 p{index}.html（每次只处理一个 chunk，默认 80 章）。
    /// 对应 Python：EpubSchemeHandler.requestStarted 命中 pages[pN.html] 才返回该页，
    /// 且其中引用的资源才从 zip 读取；EpubWebEngineView.load_page 一次只 load 一页，
    /// 因此单页 DOM 规模恒定，与全书章节数无关。
    pub fn render_page(&mut self, index: usize) -> Result<String, String> {
        if let Some(p) = self.text_page.as_ref() { return Ok(p.clone()); }
        if index >= self.pages { return Err("页码越界".into()); }
        if let Some(h) = self.cache.get(&index) { return Ok(h.clone()); }

        // 复用常开的 zip 句柄（对应 Python 里 handler 持有的同一份 zip）：
        // 几千条目的书每翻页重开一次中央目录，纯属白花的几十毫秒
        if self.zf.is_none() {
            let file = File::open(&self.path).map_err(|e| e.to_string())?;
            self.zf = Some(ZipArchive::new(file).map_err(|e| e.to_string())?);
        }
        let zf = self.zf.as_mut().ok_or("zip 句柄不可用")?;
        let (start, end) = self.chunk_ranges.get(index).copied()
            .unwrap_or((0, self.spine_files.len()));

        let mut body = String::new();
        if index > 0 {
            body.push_str(&format!("<div style=\"text-align:center;padding:8px 0;\"><a href=\"epub://p{}.html\" style=\"color:#1E88E5;text-decoration:none;\">← 上一页</a></div>", index - 1));
        }
        for i in start..end {
            let full = self.spine_files[i].clone();
            if full.is_empty() { continue; }
            if let Some(div) = rewrite_chapter(zf, &self.names, i, &full,
                                               &self.idx_map, &self.preservable, &self.page_of) {
                body.push_str(&div);
            }
        }        if index + 1 < self.pages {
            body.push_str(&format!("<div style=\"text-align:center;padding:8px 0;\"><a href=\"epub://p{}.html\" style=\"color:#1E88E5;text-decoration:none;\">下一页 →</a></div>", index + 1));
        }
        let html = format!("<!DOCTYPE html><html><head><meta charset='utf-8'><style>\n{}\n{}</style></head><body><div class='paper'>{}</div></body></html>",
                           self.css, PAPER_CSS, body);

        // 仅保留最近 3 页：DOM 永远只有一页，缓存只为前后翻页不重复解析同一 chunk
        self.cache.insert(index, html.clone());
        self.cache_order.retain(|&n| n != index);
        self.cache_order.push(index);
        while self.cache_order.len() > 6 {
            let old = self.cache_order.remove(0);
            self.cache.remove(&old);
        }
        Ok(html)
    }
}

fn inline_css_urls(css: &str, css_path: &str, zf: &mut ZipArchive<File>, names: &HashMap<String, String>) -> String {
    let base = css_path.rsplit_once('/').map(|(a, _)| a).unwrap_or("");
    let low = css.to_ascii_lowercase();
    let mut out = String::with_capacity(css.len());
    let mut pos = 0;
    while let Some(p) = low[pos..].find("url(") {
        let start = pos + p;
        out.push_str(&css[pos..start]);
        let after = &css[start + 4..];
        let Some(e) = after.find(')') else { out.push_str(&css[start..]); return out; };
        let raw = after[..e].trim().trim_matches('"').trim_matches('\'');
        let replacement = if raw.starts_with("data:") || raw.starts_with("http") { None }
            else { data_uri(zf, names, base, raw, None) };
        match replacement {
            Some(uri) => out.push_str(&format!("url(\"{}\")", uri)),
            None => out.push_str(&css[start..start + 4 + e + 1]),
        }
        pos = start + 4 + e + 1;
    }
    out.push_str(&css[pos..]);
    out
}

// ---------- TXT / HTML ----------

/// TXT / HTML：对应 Python build_html_from_text + EpubSchemeHandler.set_html 单页
pub fn open_text(path: &Path) -> Result<BookIndex, String> {
    let raw = std::fs::read(path).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&raw).into_owned();
    let is_html = matches!(path.extension().and_then(|s| s.to_str()).map(|s| s.to_ascii_lowercase()).as_deref(), Some("html") | Some("htm"));
    let body = if is_html { text } else {
        let mut b = String::new();
        for line in text.lines() {
            let esc = line.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
            b.push_str(&format!("<p>{}</p>\n", if esc.is_empty() { "&nbsp;" } else { &esc }));
        }
        b
    };
    let page = format!("<!DOCTYPE html><html><head><meta charset='utf-8'><style>\n{}</style></head><body><div class='paper'>{}</div></body></html>", PAPER_CSS, body);
    Ok(BookIndex {
        kind: "text".into(), pages: 1, toc: vec![], path: path.to_path_buf(),
        spine_files: vec![], names: HashMap::new(), idx_map: HashMap::new(),
        preservable: HashSet::new(), css: String::new(),
        chunk_ranges: vec![], page_of: vec![],
        text_page: Some(page), cache: HashMap::new(), cache_order: vec![], zf: None,
    })
}
