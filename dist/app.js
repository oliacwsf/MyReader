// 本工程不使用打包器，不能写裸模块 import（WebView2 无法解析，会导致整个脚本不执行）。
// 直接使用 Tauri v2 内核注入的 IPC 通道；对话框与窗口操作改由 Rust 自定义命令提供。
const invoke = (cmd, args = {}) => window.__TAURI_INTERNALS__.invoke(cmd, args);
const openDialog = (o = {}) => invoke(o.directory ? 'pick_folder' : 'pick_file', {
  defaultPath: o.defaultPath || null,
  extensions: (o.filters || []).flatMap((f) => f.extensions || []),
});
const saveDialog = (o = {}) => invoke('pick_save_path', { defaultPath: o.defaultPath || null });

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const EXTS = ['.pdf', '.epub', '.mobi', '.azw3', '.txt', '.html', '.htm', '.fb2', '.cbz', '.xps', '.svg'];
const COLORS = [['#E53935', '红色'], ['#FDD835', '黄色'], ['#43A047', '绿色'],
                ['#1E88E5', '蓝色'], ['#8E24AA', '紫色'], ['#FB8C00', '橙色']];
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

const S = {
  cfg: null, files: [], selected: null, sortKey: 'name', sortAsc: true,
  viewMode: 'all',          // 'all' 全部文件 / 'recent' 最近阅读
  spine: null,              // Rust 端可选返回的 EPUB spine 路径表（路径→页号映射用）
  path: null, kind: null, pages: 0, page: 0, toc: [], bookmarks: [], anns: [],
  color: '#E53935', width: 2, tool: 'select', zoom: 1.0,
  font: 'Microsoft YaHei', size: 16, spacing: 1.5, progress: 0,
  annotJs: '', pageReady: false, saveChain: Promise.resolve(),
  // 对应 PdfViewerWidget 的成员：page_items / render_queue / render_generation /
  // render_mode / page_chars / scroll_timer / thread_pool(单线程)
  pdf: { doc: null, page: 1, total: 0, scale: 1.0, anns: [], items: [], queue: [],
         generation: 0, rendering: false, sceneH: 0, pageChars: {}, renderMode: 'high',
         queueTimer: null, scrollTimer: null, syncTimer: null, suppressSync: false,
         sizeCache: new Map(), sizeToken: 0, sizeCheckStarted: false, sizeTimer: null,
         renderTask: null, renderingItem: null },
};

// ---------------- 通用 ----------------
function toast(msg) { $('#message-text').textContent = msg; $('#dlg-message').showModal(); }
// 非阻塞加载提示：页面已经出现时不该还压着一个要手动点“确定”的模态框
function showLoading(msg) {
  const tip = $('#loading-tip');
  tip.textContent = msg || '加载中';
  tip.classList.remove('hidden');
}
function hideLoading() { $('#loading-tip').classList.add('hidden'); }
function promptBox(title, def = '') {
  return new Promise((resolve) => {
    $('#prompt-title').textContent = title;
    $('#prompt-input').value = def;
    const dlg = $('#dlg-prompt');
    const done = (v) => { dlg.close(); cleanup(); resolve(v); };
    const ok = () => done($('#prompt-input').value);
    const cancel = () => done(null);
    const cleanup = () => { $('#prompt-ok').removeEventListener('click', ok); $('#prompt-cancel').removeEventListener('click', cancel); };
    $('#prompt-ok').addEventListener('click', ok);
    $('#prompt-cancel').addEventListener('click', cancel);
    dlg.showModal();
  });
}
function mdToHtml(text) {
  let t = text.replace(/<u>/g, '\u0001').replace(/<\/u>/g, '\u0002')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\u0001/g, '<u>').replace(/\u0002/g, '</u>');
  t = t.replace(/^[ \t]*(-{3,}|\*{3,})[ \t]*$/gm, '<hr style="border:1px solid #ccc;margin:15px 0;">');
  for (let n = 6; n >= 1; n--) {
    const re = new RegExp('^' + '#'.repeat(n) + ' (.*?)$', 'gm');
    t = t.replace(re, `<h${n}>$1</h${n}>`);
  }
  t = t.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
       .replace(/\*(.*?)\*/g, '<i>$1</i>')
       .replace(/`(.*?)`/g, '<code>$1</code>')
       .replace(/\+\+(.*?)\+\+/g, '<u>$1</u>')
       .replace(/__(.*?)__/g, '<u>$1</u>')
       .replace(/^&gt; (.*?)$/gm, '<blockquote>$1</blockquote>')
       .replace(/\n/g, '<br>');
  return t;
}
function human(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}
function showView(which) {
  $('#browser-view').classList.toggle('active', which === 'browser');
  $('#reader-view').classList.toggle('active', which === 'reader');
  invoke('set_window_title', { title: which === 'reader' && S.path ? `我的阅读器 - ${S.path.split(/[\\/]/).pop()}` : '我的阅读器' }).catch(() => {});
}

// ---------------- 文件列表 ----------------
async function loadFiles() {
  S.files = await invoke('list_files', { dir: S.cfg.last_dir, search: $('#search').value, filter: $('#filter').value });
  renderTable();
}
// ---- 最近阅读（存 localStorage，最多 10 条，不依赖后端） ----
const RECENT_KEY = 'mr.recent';
function loadRecent() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch (e) { return []; }
}
function saveRecent(list) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch (e) { /* 隐私模式忽略 */ }
}
function extOf(p) {
  const m = /\.([^.\/\\]+)$/.exec(String(p || ''));
  return m ? '.' + m[1].toLowerCase() : '';
}
function recordRecent(path) {
  if (!path) return;
  const list = loadRecent().filter((r) => r.path !== path);
  const f = S.files.find((x) => x.path === path);
  list.unshift({
    path,
    name: f ? f.name : String(path).split(/[\\/]/).pop(),
    ext: f ? f.ext : extOf(path),
    size: f ? f.size : 0,
    has_note: f ? !!f.has_note : false,
    note: f ? (f.note || '') : '',
    ts: Date.now(),
  });
  saveRecent(list.slice(0, 10));
}
function renderTable() {
  const key = S.sortKey, asc = S.sortAsc;
  let base = S.viewMode === 'recent' ? loadRecent() : S.files;
  if (S.viewMode === 'recent') {
    // 最近阅读只有 10 条，搜索/筛选在前端就地过滤即可
    const q = ($('#search').value || '').toLowerCase();
    const flt = ($('#filter').value || '').toLowerCase();
    base = base.filter((f) => {
      if (flt && flt !== '全部支持格式' && String(f.ext || '').toLowerCase() !== flt) return false;
      if (q && !String(f.name || '').toLowerCase().includes(q)) return false;
      return true;
    });
  }
  const rows = [...base].sort((a, b) => {
    let x = a[key], y = b[key];
    if (key === 'size') { x = +x; y = +y; }
    else if (key === 'has_note') { x = x ? 1 : 0; y = y ? 1 : 0; }
    else { x = String(x).toLowerCase(); y = String(y).toLowerCase(); }
    return (x < y ? -1 : x > y ? 1 : 0) * (asc ? 1 : -1);
  });
  $('#lbl-dir').textContent = S.viewMode === 'recent'
    ? (rows.length ? `最近阅读（${rows.length} 本）` : '最近阅读（暂无记录）')
    : S.cfg.last_dir;
  const body = $('#file-body');
  body.innerHTML = '';
  for (const f of rows) {
    const tr = document.createElement('tr');
    tr.dataset.path = f.path;
    // 笔记状态：√ 有笔记 / □ 无笔记
    tr.innerHTML = `<td title="${esc(f.name)}">${esc(f.name)}</td><td>${esc(f.ext)}</td><td>${human(f.size)}</td>
      <td class="col-note ${f.has_note ? 'yes' : 'no'}">${f.has_note ? '√' : '□'}</td>
      <td title="${esc(f.note)}">${esc(f.note)}</td>`;
    tr.addEventListener('click', () => selectRow(tr, f));
    tr.addEventListener('dblclick', () => openBook(f.path));
    tr.addEventListener('contextmenu', (e) => { e.preventDefault(); selectRow(tr, f); fileContextMenu(e, f); });
    body.appendChild(tr);
  }
}

// ---------------- 列宽（可拖动调整 + 记忆） ----------------
const COLS = ['name', 'ext', 'size', 'has_note', 'note'];
const DEF_COL_W = { name: 340, ext: 72, size: 94, has_note: 90, note: 0 }; // note: 0 表示自动铺满剩余
const colW = { ...DEF_COL_W };

function loadColW() {
  try {
    const s = JSON.parse(localStorage.getItem('mr.colw') || '{}');
    COLS.forEach((k) => { if (typeof s[k] === 'number' && isFinite(s[k])) colW[k] = s[k]; });
  } catch (e) { /* 忽略损坏的本地配置 */ }
}
function saveColW() {
  try { localStorage.setItem('mr.colw', JSON.stringify(colW)); } catch (e) { /* 隐私模式忽略 */ }
}
function applyColW() {
  const table = $('#file-table');
  const cols = $$('#file-table colgroup col');
  let fixed = 0;
  cols.forEach((c, i) => {
    const w = colW[COLS[i]];
    if (w > 0) { c.style.width = w + 'px'; fixed += w; } else { c.style.width = ''; }
  });
  if (colW.note > 0) {
    // 全部列都固定宽度：表格按总宽排版，超出容器时横向滚动
    table.style.width = fixed + 'px';
    table.style.minWidth = fixed + 'px';
  } else {
    table.style.width = '100%';
    table.style.minWidth = fixed + 'px';
  }
}
function resetColW() {
  Object.assign(colW, DEF_COL_W);
  saveColW(); applyColW();
}
function bindColResizers() {
  $$('#file-table thead th').forEach((th, i) => {
    const grip = th.querySelector('.col-resizer');
    if (!grip) return;
    grip.addEventListener('click', (e) => e.stopPropagation());
    grip.addEventListener('mousedown', (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      const k = COLS[i];
      const startX = ev.clientX;
      const startW = th.getBoundingClientRect().width;
      document.body.classList.add('col-resizing');
      const move = (e) => {
        colW[k] = Math.max(46, Math.round(startW + e.clientX - startX));
        applyColW();
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        document.body.classList.remove('col-resizing');
        saveColW();
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
    grip.addEventListener('dblclick', (e) => { e.stopPropagation(); resetColW(); });
  });
}
function selectRow(tr, f) {
  $$('#file-body tr.selected').forEach((r) => r.classList.remove('selected'));
  tr.classList.add('selected');
  S.selected = f;
  $('#btn-open-note').disabled = false;
}
function fileContextMenu(e, f) {
  // 轻量右键菜单：预览 / 导出 / 删除笔记 / 打开笔记
  const menu = document.createElement('div');
  menu.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY}px;z-index:999;background:#fff;
    border:1px solid #aaa;box-shadow:0 3px 12px rgba(0,0,0,.25);padding:4px;min-width:130px`;
  const items = [
    ['预览笔记', async () => { await previewNoteText(await invoke('load_note', { path: f.path })); }],
    ['导出笔记', () => exportNote(f.path)],
    ['删除笔记', async () => { await invoke('delete_note', { path: f.path }); await loadFiles(); }],
    ['打开笔记', () => openNoteExternal(f.path)],
  ];
  for (const [label, fn] of items) {
    const b = document.createElement('div');
    b.textContent = label;
    b.style.cssText = 'padding:5px 10px;cursor:pointer';
    b.onmouseenter = () => b.style.background = '#eef5fd';
    b.onmouseleave = () => b.style.background = '#fff';
    b.onclick = () => { menu.remove(); fn(); };
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  const close = () => { menu.remove(); document.removeEventListener('click', close); };
  setTimeout(() => document.addEventListener('click', close), 0);
}

// ---------------- 打开 / 关闭书籍 ----------------
async function openBook(path) {
  if (S.path) await closeCurrent();
  showLoading('正在打开 ' + String(path).split(/[\\/]/).pop());
  try {
    let meta;
    try { meta = await invoke('open_book', { path }); }
    catch (e) { toast('打开失败：' + e); return; }
    S.path = path; S.kind = meta.kind; S.pages = meta.pages; S.toc = meta.toc || [];
    // Rust 端可选返回 EPUB spine 路径表（如 ['Text/cover.xhtml','Text/ch1.xhtml',...]），
    // 用于把页面内原始相对链接映射回页号；没有也能正常用，只是跨文件链接靠 TOC 兜底。
    S.spine = Array.isArray(meta.spine) ? meta.spine : null;
    recordRecent(path);              // 打开成功即记入“最近阅读”
    // 这 4 个查询互不依赖，并行取；串行会让"点了书没反应"的等待感被放大
    const [anns, bms, prog, noteText] = await Promise.all([
      invoke('get_annotations', { path }),
      invoke('get_bookmarks', { path }),
      invoke('get_progress', { path }),
      invoke('load_note', { path }),
    ]);
    S.anns = anns; S.bookmarks = bms;
    const [pos, pg] = prog;
    S.page = S.kind === 'pdf' ? 0 : Math.min(Math.max(pg | 0, 0), Math.max(0, S.pages - 1));
    S.progress = pos | 0;
    $('#note-edit').value = noteText;
    $('#lbl-progress').textContent = `已读 ${S.progress}%`;
    $('#fmtbar').classList.toggle('hidden', S.kind === 'pdf');
    $('#page-frame').classList.toggle('hidden', S.kind === 'pdf');
    $('#pdf-area').classList.toggle('hidden', S.kind !== 'pdf');
    showView('reader');
    renderTocSidebar();
    if (S.kind === 'pdf') await initPdf(path);
    else await loadPage(S.page, { scrollPos: S.progress });
  } finally {
    hideLoading();                       // 书页就绪即消失，不再阻塞阅读
  }
}
async function closeCurrent() {
  flushAnnotations();
  await saveNote();
  await saveProgress();
  if (S.kind === 'pdf') await invoke('set_pdf_annotations', { path: S.path, data: JSON.stringify(S.pdf.anns) }).catch(() => {});
  await invoke('clear_book', { path: S.path }).catch(() => {});
  // 释放渲染内存
  const frame = $('#page-frame');
  try { frame.contentDocument.open(); frame.contentDocument.write(''); frame.contentDocument.close(); } catch (e) {}
  pdfClearAll();                       // 对应 PdfViewerWidget.clear()：清队列/定时器/占位/缓存
  if (S.pdf.doc) { try { S.pdf.doc.destroy(); } catch (e) { /* 忽略 */ } }
  S.pdf.doc = null; S.pdf.anns = []; S.pageReady = false;
  pageCache.clear();                   // 换书必须清，避免同页号串书
}
async function back() {
  if (!S.path) return;
  await closeCurrent();
  S.path = null; S.kind = null;
  showView('browser');
  await loadFiles();
}

// ---------------- 阅读页（EPUB / TXT） ----------------
let loadSeq = 0;
// 取回的页 HTML 小缓存：翻回去不必再走一次 IPC + zip 重解析。
// 与 Rust 端 6 页 LRU 配合，来回翻页基本零等待。
const pageCache = new Map();
const PAGE_CACHE_MAX = 6;
function cachePage(i, html) {
  pageCache.delete(i);
  pageCache.set(i, html);                       // 插入序 = LRU 顺序
  while (pageCache.size > PAGE_CACHE_MAX) pageCache.delete(pageCache.keys().next().value);
}
let prefetching = false;
async function prefetchNeighbors(n) {
  if (!S.path || S.kind === 'pdf' || prefetching) return;
  const owner = S.path;
  prefetching = true;
  try {
    for (const i of [n + 1, n - 1]) {
      if (i < 0 || i >= S.pages || pageCache.has(i)) continue;
      const html = await invoke('get_page', { path: owner, index: i });
      if (S.path !== owner) return;             // 期间换书了，丢弃
      if (typeof html === 'string' && html) cachePage(i, html);
    }
  } catch (e) { /* 预取失败不影响正常翻页 */ } finally { prefetching = false; }
}
/** 只等一帧排版：rAF 回调时样式与布局已经算完，标注可以按最终位置画 */
const waitLayout = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

async function loadPage(n, opts = {}) {
  if (!S.path || S.kind === 'pdf') return;
  flushAnnotations();
  const seq = ++loadSeq;
  n = Math.min(Math.max(n | 0, 0), Math.max(0, S.pages - 1));
  let html = pageCache.get(n);
  if (html) { pageCache.delete(n); pageCache.set(n, html); }
  else {
    try { html = await invoke('get_page', { path: S.path, index: n }); }
    catch (e) { toast('加载页面失败：' + e); return; }
    if (seq !== loadSeq) return;          // 期间又翻了一页，丢弃这次结果
    if (typeof html === 'string' && html) cachePage(n, html);
  }
  const frame = $('#page-frame');
  const doc = frame.contentDocument;
  S.pageReady = false;                 // 新页面就绪前禁止 dump，避免把空标注写回去
  // doc.open() 会移除 document 上的事件监听器，但 document/window 对象本身复用，
  // 上面的 ReaderAnnot / __mrAnnotReady 标记会残留。若不先清掉，新注入的 annot.js
  // 会误判「已初始化」提前 return，本页就没有点击/滚动监听器了 —— 大型 EPUB 拆分出的
  // 「上一页/下一页」链接从此点不动。这里显式清理，强制每页都重新绑定。
  try { delete frame.contentWindow.ReaderAnnot; } catch (e) { /* 忽略 */ }
  try { delete doc.__mrAnnotReady; } catch (e) { /* 忽略 */ }
  doc.open();
  doc.write(html.replace('</body>', `<script>${S.annotJs}<\/script></body>`));
  doc.close();
  S.page = n;
  const w = frame.contentWindow;
  if (!w || !w.ReaderAnnot) { S.pageReady = true; return; }
  w.ReaderAnnot.setPage(n);
  // 顺序很重要：先把字号/字体/缩放应用好，等排版稳定后再画标注。
  // 反过来的话标注矩形按旧布局绘制，字号一变就整体错位。
  w.ReaderAnnot.applyStyle(S.font, S.size, S.spacing, S.zoom);
  applyToolToFrame();
  await waitLayout();
  if (seq !== loadSeq) return;
  const w2 = frame.contentWindow;
  if (!w2 || !w2.ReaderAnnot) { S.pageReady = true; return; }
  w2.ReaderAnnot.restore(S.anns.filter((a) => (a.page | 0) === n));
  if (opts.frag) w2.ReaderAnnot.scrollToAnchor(opts.frag);
  else if (opts.toBottom) w2.ReaderAnnot.scrollToPercent(100);
  else if (opts.scrollPos != null && opts.scrollPos > 0) w2.ReaderAnnot.scrollToPercent(opts.scrollPos);
  else w2.ReaderAnnot.scrollToPercent(0);   // 下一页 / TOC 前进：显式回页首，别让 iframe 残留旧滚动位置
  S.pageReady = true;
  // 字体/图片晚一步就绪时文字会重排，标注得跟着复算一次，否则会整体偏一行
  setTimeout(() => {
    const w3 = frame.contentWindow;
    if (w3 && w3.ReaderAnnot && S.pageReady && S.page === n) w3.ReaderAnnot.relayout();
  }, 260);
  saveProgress();                      // 写库放后台，翻页立即响应
  prefetchNeighbors(n);                // 空闲时把前后页取回来
}
/** 把 EPUB 内部相对文件路径映射到 spine 表项 {path, page, idx}。
 *  后端已把绝大多数正文链接/TOC 链接重写成 epub://pN.html#chap_...，
 *  这里只兜底「后端 resolve 失败、仍保留原始相对路径」的链接。
 *  匹配策略与后端 resolve_idx 一致：完整规范路径优先，短文件名仅全书唯一时回退。 */
function normEpubPath(p) {
  let s = String(p == null ? '' : p).replace(/\\/g, '/');
  const q = s.indexOf('?'); if (q >= 0) s = s.slice(0, q);
  const h = s.indexOf('#'); if (h >= 0) s = s.slice(0, h);
  const parts = [];
  for (const seg of s.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (parts.length) parts.pop(); }
    else parts.push(seg);
  }
  return parts.join('/').toLowerCase();
}
function epubEntryOfFile(file) {
  if (!file) return null;
  const list = S.spine;
  if (!Array.isArray(list) || !list.length) return null;
  const target = normEpubPath(file);
  if (!target) return null;
  // 1) 完整规范路径（大小写不敏感）
  for (const e of list) if (normEpubPath(e && e.path) === target) return e;
  // 2) 短文件名回退，仅当全书唯一
  const bn = target.split('/').pop();
  let hit = null;
  for (const e of list) {
    if (normEpubPath(e && e.path).split('/').pop() === bn) {
      if (hit) return null;      // 重名，无法唯一确定，宁可不跳也不跳错
      hit = e;
    }
  }
  return hit;
}
function navigateTo(href) {
  if (!href) { toast('该目录项没有可用链接'); return; }
  href = String(href);
  // PDF 目录项可能是「第 N 页」「#page=N」「N」等形式
  if (S.kind === 'pdf') {
    let pg = null;
    const m1 = /(?:^|[#?&/])page[=:]?\s*(\d+)/i.exec(href);
    if (m1) pg = parseInt(m1[1], 10);
    else {
      const m2 = /^\s*(\d+)\s*$/.exec(href);
      if (m2) pg = parseInt(m2[1], 10);
    }
    if (pg && pg >= 1) { gotoPdfPage(pg, false); return; }
    toast('无法识别该目录链接：' + href); return;
  }

  const dec = (s) => { try { return decodeURIComponent(s); } catch (e) { return s; } };
  let page = S.page, frag = '';

  // 1) 后端规范化链接：epub://pN.html#chap_idx_anchor（frag 已带 chap 前缀，勿再解码）
  const m = /^epub:\/\/p(\d+)\.x?html?(?:#(.*))?$/i.exec(href);
  if (m) { page = parseInt(m[1], 10); frag = m[2] || ''; }
  else if (href.charAt(0) === '#') {
    // 2) 纯同页锚点
    frag = dec(href.slice(1));
    const w = $('#page-frame').contentWindow;
    if (w && w.ReaderAnnot) w.ReaderAnnot.scrollToAnchor(frag);
    return;
  } else {
    // 3) 原始相对路径：file#anchor 或 file
    const i = href.indexOf('#');
    const file = i >= 0 ? href.slice(0, i) : href;
    const f0 = i >= 0 ? dec(href.slice(i + 1)) : '';
    // 3a) Rust 重写过文件名（pN.html / pN.xhtml）
    const pm = /p(\d+)\.x?html?$/i.exec(file);
    if (pm) { page = parseInt(pm[1], 10); frag = f0; }
    else {
      // 3b) spine 路径表：文件名 → {page, idx}
      const entry = epubEntryOfFile(file);
      if (entry) {
        page = entry.page | 0;
        frag = f0 ? `chap_${entry.idx}_${f0}` : `chap_${entry.idx}`;
      } else {
        // 3c) 无文件名：纯锚点，目标可能在当前页；空链接回页顶
        const w0 = $('#page-frame').contentWindow;
        const curHas = (id) => {
          try { const d = w0 && w0.document; return d && (d.getElementById(id) || d.getElementsByName(id)[0]); } catch (e) { return null; }
        };
        if (!file && f0 && curHas(f0)) { if (w0 && w0.ReaderAnnot) w0.ReaderAnnot.scrollToAnchor(f0); return; }
        if (!file && !f0) { if (w0 && w0.ReaderAnnot) w0.ReaderAnnot.scrollToPercent(0); return; }
        toast('无法定位该章节链接：' + href); return;
      }
    }
  }
  const toBottom = !frag && page < S.page;
  if (page !== S.page) loadPage(page, { frag: frag || undefined, toBottom });
  else if (frag) { const w = $('#page-frame').contentWindow; if (w && w.ReaderAnnot) w.ReaderAnnot.scrollToAnchor(frag); }
}
function pageStep(delta) {
  const n = S.page + delta;
  if (n < 0 || n >= S.pages) return;
  loadPage(n, { toBottom: delta < 0 });
}

// ---------------- 标注 ----------------
function flushAnnotations() {
  if (!S.path || S.kind === 'pdf' || !S.pageReady) return;
  const w = $('#page-frame').contentWindow;
  if (!w || !w.ReaderAnnot) return;
  const d = w.ReaderAnnot.dump();
  if (d && Array.isArray(d.list)) saveAnnotationsForPage(d.page | 0, d.list);
}
function saveAnnotationsForPage(page, list) {
  const clean = list.filter((a) => a && a.kind);
  S.anns = S.anns.filter((a) => (a.page | 0) !== page)
    .concat(clean.map((a) => ({ ...a, page })));
  // 串行化，避免快速翻页时写入乱序
  S.saveChain = S.saveChain
    .then(() => invoke('save_annotations', { path: S.path, page, list: clean }))
    .catch((e) => console.error('save annotations', e));
}
function applyToolToFrame() {
  const w = $('#page-frame').contentWindow;
  if (w && w.ReaderAnnot) w.ReaderAnnot.setTool(S.tool, S.color, S.width);
}
function setTool(tool) {
  S.tool = tool;
  $$('#tool-group button').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  if (S.kind === 'pdf') {
    if (tool === 'highlight' || tool === 'underline') {
      const w = pdfWrapOfSelection();          // 先选字再点按钮，和 EPUB 一样顺
      if (w && commitPdfSelection(w)) return;
    }
    applyPdfTool();
    return;
  }
  if (tool === 'highlight' || tool === 'underline') {
    const w = $('#page-frame').contentWindow;
    if (w && w.ReaderAnnot) w.ReaderAnnot.annotateSelection(tool, S.color);
    setTool('select');
    return;
  }
  applyToolToFrame();
}
function undoAnnotation() {
  if (S.kind === 'pdf') { S.pdf.anns.pop(); renderPdfAnnotations(); return; }
  const w = $('#page-frame').contentWindow;
  if (w && w.ReaderAnnot) w.ReaderAnnot.undo();
}
function clearAnnotations() {
  if (S.kind === 'pdf') { S.pdf.anns = []; renderPdfAnnotations(); return; }
  const w = $('#page-frame').contentWindow;
  if (w && w.ReaderAnnot) w.ReaderAnnot.clearAll();
}
function applyFormat() {
  S.font = $('#font-sel').value; S.size = parseInt($('#size-sel').value, 10);
  S.spacing = parseFloat($('#line-in').value) || 1.5;
  if (S.kind !== 'pdf') {
    const w = $('#page-frame').contentWindow;
    if (w && w.ReaderAnnot) w.ReaderAnnot.applyStyle(S.font, S.size, S.spacing, S.zoom);
    scheduleRelayout();          // 排版变了：按锚点重新锚定标注，别让框留在旧位置
  }
}
// 字号/行距连续调整时合并成一次重排，避免每改一档全部重算
let relayoutTimer = null;
function scheduleRelayout() {
  clearTimeout(relayoutTimer);
  relayoutTimer = setTimeout(() => {
    const w = $('#page-frame').contentWindow;
    if (!w || !w.ReaderAnnot || !S.pageReady || S.kind === 'pdf') return;
    w.ReaderAnnot.relayout();
    flushAnnotations();          // 新坐标立刻回存，下次打开直接用对的位置
  }, 60);
}
function setZoom(z) {
  S.zoom = Math.min(3, Math.max(0.2, z));
  $('#lbl-zoom').textContent = Math.round(S.zoom * 100) + '%';
  if (S.kind === 'pdf') { pdfSetScale(S.zoom); return; }
  applyFormat();
}
function fitWidth() {
  if (S.kind === 'pdf') { pdfFitWidth(); return; }
  setZoom(1.0);
}

/** 对应 zoom_in/out + _invalidate_rendered()：只改占位尺寸，不重建 DOM，
 *  全部已渲染页作废后按新 zoom 重新按视口渲染（原版 setTransform + invalidate） */
async function pdfSetScale(z) {
  const P = S.pdf;
  if (!P.doc || !P.items.length) return;
  const cur = P.page;
  P.scale = z;
  applyZoomToItems();
  invalidateRendered();
  await nextFrame();
  gotoPdfPage(cur, false);
}

// ---------------- 笔记 ----------------
async function saveNote() {
  if (!S.path) return;
  await invoke('save_note', { path: S.path, text: $('#note-edit').value }).catch(() => {});
}
function appendNote(text) {
  $('#note-edit').value += text;
  saveNote();
}
async function previewNoteText(text) {
  $('#preview-body').innerHTML = mdToHtml(text || '');
  $('#dlg-preview').showModal();
}
async function exportNote(path) {
  const dest = await saveDialog({ defaultPath: (path || '笔记').split(/[\\/]/).pop() + '.md',
    filters: [{ name: 'Markdown', extensions: ['md', 'txt'] }] });
  if (dest) await invoke('export_note', { path: path || S.path, dest });
}
async function openNoteExternal(path) {
  const p = path || S.path;
  if (!p) return;
  const notePath = await invoke('base_path');
  const exists = S.files.find((f) => f.path === p)?.has_note;
  if (!exists) { toast('文件【' + p.split(/[\\/]/).pop() + '】暂无笔记。\n（只有在阅读界面输入内容并保存后才会产生笔记）'); return; }
  if (S.cfg.md_editor) { await invoke('open_external', { path: p, editor: S.cfg.md_editor }); return; }
  await previewNoteText(await invoke('load_note', { path: p }));
}

// ---------------- 进度 / 书签 / 目录 ----------------
async function saveProgress() {
  if (!S.path) return;
  const page = S.kind === 'pdf' ? Math.max(0, (S.pdf.page || 1) - 1) : S.page;
  await invoke('set_progress', { path: S.path, pos: S.progress, page, kind: S.kind }).catch(() => {});
}
async function addBookmark() {
  if (!S.path) return;
  const ref = S.kind === 'pdf' ? `第 ${S.pdf.page} 页` : `第 ${S.page + 1} 页`;
  const name = await promptBox('书签名称', `${ref} ${S.progress}%`);
  if (name === null) return;
  S.bookmarks.push({ name: name || '书签', pos: S.progress });
  await invoke('set_bookmarks', { path: S.path, list: S.bookmarks });
  renderBookmarks();
}
function buildTocTree(items, container) {
  container.innerHTML = '';
  if (!items || !items.length) return;
  const ul = document.createElement('ul');
  for (const it of items) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.className = 'toc-item'; span.textContent = it.title || '未命名';
    span.onclick = () => {
      if (S.kind === 'pdf' && it.page != null && it.page >= 1) gotoPdfPage(it.page, false);
      else if (it.href) navigateTo(it.href);
      else toast('该目录项没有可用链接');
    };
    li.appendChild(span);
    if (it.children && it.children.length) buildTocTree(it.children, li);
    ul.appendChild(li);
  }
  container.appendChild(ul);
}
let bmSelected = -1;
function renderBookmarks() {
  const box = $('#bm-list'); box.innerHTML = '';
  S.bookmarks.forEach((b, i) => {
    const d = document.createElement('div');
    d.className = 'bm-item' + (bmSelected === i ? ' selected' : '');
    d.textContent = `${b.name}  (${b.pos}%)`;
    d.onclick = () => { bmSelected = i; renderBookmarks(); };
    d.ondblclick = () => {
      if (S.kind === 'pdf') scrollPdfToPercent(b.pos);
      else { const w = $('#page-frame').contentWindow; if (w && w.ReaderAnnot) w.ReaderAnnot.scrollToPercent(b.pos); }
    };
    box.appendChild(d);
  });
}
function renderTocSidebar() {
  buildTocTree(S.toc, $('#toc-tree'));
  renderBookmarks();
}
function toggleTocPane() {
  const hidden = $('#toc-pane').classList.toggle('hidden');
  $('#toc-divider').classList.toggle('hidden', hidden);
  const btn = $('#toc-reopen');
  btn.textContent = hidden ? '▶' : '◀';
  btn.title = hidden ? '展开目录/书签栏' : '收起目录/书签栏';
}

// ---- 可拖动分隔条：笔记栏 / 目录栏 / 目录·书签两栏宽度自由调整并记忆 ----
function bindPaneResizers() {
  const notePane = $('.right-pane'), noteDiv = $('#note-divider');
  const tocPane = $('#toc-pane'), tocDiv = $('#toc-divider');
  const tocTreeCol = $('#toc-col-tree'), tocInnerDiv = $('#toc-inner-divider');
  function splitter(div, pane, dir, min, max, storeKey) {
    let startX = 0, startW = 0;
    const val = (v) => (typeof v === 'function' ? v() : v);
    div.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation();
      startX = e.clientX; startW = pane.getBoundingClientRect().width;
      const mn = val(min), mx = val(max);
      div.classList.add('active');
      document.body.classList.add('col-resizing');
      const move = (ev) => {
        const dx = ev.clientX - startX;
        const w = Math.max(mn, Math.min(mx, startW + dir * dx));
        pane.style.width = w + 'px';
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        document.body.classList.remove('col-resizing');
        div.classList.remove('active');
        try { localStorage.setItem(storeKey, String(pane.getBoundingClientRect().width)); } catch (err) { /* 忽略 */ }
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
    try {
      const saved = parseFloat(localStorage.getItem(storeKey));
      if (isFinite(saved) && saved > 0) pane.style.width = Math.max(val(min), Math.min(val(max), saved)) + 'px';
    } catch (e) { /* 忽略 */ }
  }
  const vw = () => Math.max(320, window.innerWidth);
  splitter(noteDiv, notePane, -1, 200, vw() * 0.75, 'mr.noteW');   // 右拖 → 笔记变窄
  // 侧栏整体：最小缩到「目录列 42px + 内部分隔条 5px」，此时书签列被完全压到 0
  const TOC_PANE_MIN = 47;
  splitter(tocDiv, tocPane, 1, TOC_PANE_MIN, () => Math.min(560, window.innerWidth * 0.56), 'mr.tocW');
  // 目录栏内部：目录列与书签列左右分栏，中间分隔条可拖动，宽度记忆。
  // 目录列最小缩到「目录」两个字宽（13px×2 + 头部左右 padding ≈ 42px）；
  // 最大可拖到 tocPane 宽度减去分隔条本身，即把书签列完全压到 0。
  const TOC_COL_MIN = 42;
  splitter(tocInnerDiv, tocTreeCol, 1, TOC_COL_MIN,
    () => Math.max(TOC_COL_MIN, tocPane.getBoundingClientRect().width - 5), 'mr.tocColW');
}

// ---------------- PDF：复刻 Python 版 PdfViewerWidget 的懒加载状态机 ----------------
// 逐条对应原版方法（不是"看起来像懒加载"，而是同一套状态机）：
//   load_pdf()                -> initPdf / buildPdfItems：打开只扫每页尺寸、建白色占位，不渲染任何页
//   QGraphicsRectItem         -> .pdf-page 白色占位 div（每页按自己的 wPt/hPt，y 累加 + spacing）
//   page_items[]              -> P.items[]（rect/idx/pix_item/is_rendered/is_high_res/rendering_high）
//   apply_zoom()              -> applyZoomToItems / pdfFitScale：fit_width 用最大页宽
//   _update_viewport_render() -> updateViewportRender：视口 ±500 场景像素预取；离屏 removeItem 释放位图
//   _process_render_queue()   -> processRenderQueue：单线程串行 + 10ms tick
//   RenderTask(低清)          -> 先渲染 low_res_w 预览（high 700 / fast 500）
//   RenderTask(高清)          -> 再渲染高清，ratio=clamp(zoom*dpr,1,3/2)，像素上限 1e7/8e6 按 sqrt 回缩
//   _on_render_finished()     -> onRenderFinished：generation 校验丢弃过期结果，低清插回队首立即升级
//   _on_scroll_changed()      -> onScrollChanged：清队列 / generation++ / 作废非高清 / 100ms 防抖
//   _invalidate_rendered()    -> invalidateRendered：缩放后全部作废，不重建 DOM
//   _extract_page_chars()     -> extractPageChars：getTextContent 按需提取并缓存
const PDF_RENDER_SCALE = 2.0;        // Python: PDF_RENDER_SCALE
const PDF_SPACING = 16;              // Python: spacing
// Python 里场景坐标就是渲染像素，上下各扩 500 约等于半屏；这里的场景坐标是
// 点尺寸×PDF_RENDER_SCALE（2 倍基准），等效值要放大，否则下一页永远进不了预取区。
const PDF_PREFETCH = 1900;   // 覆盖一整页（rh≈1684）+ 间距，翻页时邻页不被立即释放
const PDF_DEBOUNCE_MS = 40;
const PDF_QUEUE_TICK = 0;
const PDF_MAX_DPR = 2;

function pdfArea() { return $('#pdf-area'); }

/** 对应 Python PdfViewerWidget.load_pdf + QPdfDocument.load：按路径打开，不把整本读进渲染内存 */
// ---------------- PDF（PDF.js · 懒加载状态机） ----------------
async function pdfRangeTransport(path) {
  const lib = window.pdfjsLib;
  const R = lib && lib.PDFDataRangeTransport;
  if (!R) return null;
  let size = 0;
  try { size = await invoke('file_size', { path }); } catch (e) { return null; }
  if (!size || size < 256 * 1024) return null;  // 小文件直接读一次，避免任何协议探测等待
  const t = new R(size, new Uint8Array(0));
  t.disableAutoFetch = true;          // 别为了"可能用得到"把整本拉下来
  t.disableStream = true;
  let failed = false;
  t.requestDataRange = (begin, end) => {
    const len = Math.max(1, end - begin);
    invoke('read_file_range', { path, offset: begin, length: len })
      .then((buf) => {
        if (failed) return;
        const u = (buf instanceof Uint8Array) ? buf : new Uint8Array(buf);
        t.onDataRange(begin, u);
      })
      .catch((e) => {
        failed = true;
        console.warn('range 读取失败：', begin, len, e);
        t.onDataRange(begin, new Uint8Array(0));       // 让 pdf.js 抛错，由外层回退
      });
  };
  return t;
}

async function loadPdfDoc(path) {
  // 大、中文件优先按字节区间读取；小文件直接读字节。正常路径不再等待 asset 协议超时。
  try {
    const range = await pdfRangeTransport(path);
    if (range) {
      return await window.pdfjsLib.getDocument({
        range, rangeChunkSize: 131072, disableAutoFetch: true, disableStream: true,
      }).promise;
    }
  } catch (e) {
    console.info('range 模式不可用，改用二进制直读：', e && e.message);
  }
  let data;
  try {
    const buf = await invoke('read_file_bytes', { path });
    data = (buf instanceof Uint8Array) ? buf : new Uint8Array(buf);
  } catch (e) {
    const b64 = await invoke('read_file_base64', { path });    // 旧内核兜底
    const raw = atob(b64);
    data = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) data[i] = raw.charCodeAt(i);
  }
  return window.pdfjsLib.getDocument({ data }).promise;
}

/** 用 pdf.js 解析 PDF 自带书签（outline），作为目录的兜底。
 *  有些 PDF 的 Rust 端没解析出 TOC，但 pdf.js 能拿到 outline。 */
async function buildPdfOutline(doc) {
  if (!doc || typeof doc.getOutline !== 'function') return [];
  let outline = null;
  try { outline = await doc.getOutline(); } catch (e) { return []; }
  if (!Array.isArray(outline) || !outline.length) return [];
  const destToPage = async (dest) => {
    try {
      if (dest == null) return null;
      if (typeof dest === 'string') dest = await doc.getDestination(dest);
      if (Array.isArray(dest) && dest.length) {
        const ref = dest[0];
        if (ref && typeof ref === 'object' && typeof doc.getPageIndex === 'function') {
          return ((await doc.getPageIndex(ref)) | 0) + 1;   // 转成 1-based
        }
        if (typeof ref === 'number' && ref >= 0) return ref + 1;
      } else if (dest && typeof dest === 'object' && dest.pageIndex != null) {
        return (dest.pageIndex | 0) + 1;
      }
    } catch (e) { /* 忽略单条解析失败 */ }
    return null;
  };
  const walk = async (items) => {
    const out = [];
    for (const it of items) {
      const page = await destToPage(it.dest);
      const node = { title: it.title || '未命名', page, href: page ? ('page=' + page) : '' };
      if (it.items && it.items.length) node.children = await walk(it.items);
      else node.children = [];
      out.push(node);
    }
    return out;
  };
  return walk(outline);
}

async function initPdf(path) {
  try {
    if (!window.pdfjsLib) throw new Error('PDF 引擎未加载');
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.js';
    const P = S.pdf;
    P.renderMode = (S.cfg && S.cfg.pdf_render_mode) === 'fast' ? 'fast' : 'high';

    // 原版 QPdfDocument.load(str(path)) 是按路径异步加载；这里优先用自定义
    // PDFDataRangeTransport 按字节区间取数，小文件则一次性直读，不再等待任何
    // asset 协议探测超时。旧版 8 秒/1.2 秒通道探测是打开慢的主要来源。
    const doc = await loadPdfDoc(path);
    P.doc = doc; P.total = doc.numPages;
    // 自带书签（目录）的 PDF：Rust 端没解析出 TOC 时，用 pdf.js 的 outline 兜底补上
    if (!S.toc || !S.toc.length) {
      const outline = await buildPdfOutline(doc).catch(() => null);
      if (outline && outline.length) { S.toc = outline; renderTocSidebar(); }
    }
    const [anns, prog] = await Promise.all([
      invoke('get_pdf_annotations', { path }),
      invoke('get_progress', { path }),
    ]);
    P.anns = Array.isArray(anns) ? anns : [];
    const pos = prog[0];
    S.progress = pos | 0;
    P.page = Math.max(1, Math.min(doc.numPages, Math.round(S.progress / 100 * doc.numPages) || 1));

    await buildPdfItems();          // 只扫尺寸 + 建占位，不渲染任何一页
    P.scale = pdfFitScale();        // apply_zoom()：按最大页宽适宽
    S.zoom = P.scale;
    $('#lbl-zoom').textContent = Math.round(S.zoom * 100) + '%';
    applyZoomToItems();
    await nextFrame();
    gotoPdfPage(P.page, false);
    updateViewportRender();         // 文档 Ready 后按视口启动渲染队列
  } catch (e) {
    toast('PDF 加载失败：' + (e && e.message ? e.message : e));
  }
}

/** 对应 load_pdf()：只遍历页尺寸（fitz 读 page.rect），为每页放一个白色占位矩形，
 *  绝不渲染内容。因此打开 3000 页 PDF 的成本是 O(页数) 的元数据扫描，而非 O(页数) 的绘制。 */
async function buildPdfItems() {
  const P = S.pdf, holder = $('#pdf-pages');
  pdfClearAll();
  // 对应 load_pdf()：PyMuPDF 读 fdoc[i].rect 是 O(1)，而 PDF.js 的 getPage 要解析页树，
  // 上千页逐页取尺寸就是秒级卡顿（旧版正是这么干的）。这里只用第 1 页尺寸铺满占位，
  // 打开即出画面；页面尺寸是否统一在后台抽查，不统一才补算 —— 首屏绝不等它。
  let first = { w: 595, h: 842 };
  try {
    const pg = await P.doc.getPage(1);
    const vp = pg.getViewport({ scale: 1 });
    first = { w: vp.width, h: vp.height };
  } catch (e) { /* 用 A4 兜底 */ }
  P.sizeCache.set(1, first);

  const frag = document.createDocumentFragment();
  let y = 0;
  for (let i = 1; i <= P.total; i++) {
    const sz = first;
    const rw = Math.max(Math.floor(sz.w * PDF_RENDER_SCALE), 1);
    const rh = Math.max(Math.floor(sz.h * PDF_RENDER_SCALE), 1);
    const wrap = document.createElement('div');
    wrap.className = 'pdf-page';
    wrap.dataset.page = String(i);
    // canvas / svg 延迟到真正需要时再创建：几千页的书打开时只建轻量 div 占位，
    // 省掉上万个 DOM 节点与逐页样式写入，首屏显著更快（画图/渲染时才补建）。
    frag.appendChild(wrap);
    P.items.push({
      num: i, wPt: sz.w, hPt: sz.h, rw, rh, y, wrap, canvas: null, svg: null,
      w: rw, h: rh,
      isRendered: false, isHighRes: false, renderingHigh: false, pixItem: null,
    });
    y += rh + PDF_SPACING;                     // y_offset += rh + spacing
  }
  holder.appendChild(frag);
  P.sceneH = y;
  applyZoomToItems();
  // 页面尺寸抽查会读取中部/尾部页，若立即执行会和首屏渲染争抢 range I/O。
  // 延后到首个高清页完成后再做（见 onRenderFinished）。
}

/** 按需创建位图 canvas（延迟到首次渲染该页时），返回已挂载到 wrap 的 canvas */
function pdfEnsureCanvas(it) {
  if (it.canvas) return it.canvas;
  const canvas = document.createElement('canvas');
  canvas.width = 1; canvas.height = 1;
  // 显示尺寸必须固定为适宽后的布局尺寸（it.w/it.h），而不是内部像素尺寸。
  // 否则 canvas 会按内部像素宽（低清 700px / 高清更大）撑破 wrap，翻页后“又变大”。
  canvas.style.width = it.w + 'px';
  canvas.style.height = it.h + 'px';
  it.wrap.insertBefore(canvas, it.wrap.firstChild);
  it.canvas = canvas;
  return canvas;
}

/** 按需创建标注 svg 层（延迟到首次画标注/建文本层时），始终保持在 wrap 最上层 */
function pdfEnsureSvg(it) {
  if (it.svg) return it.svg;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'pdf-overlay');
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  svg.setAttribute('width', it.w); svg.setAttribute('height', it.h);
  svg.setAttribute('viewBox', `0 0 ${it.w} ${it.h}`);
  it.wrap.appendChild(svg);
  it.svg = svg;
  return svg;
}

/** 单页点尺寸（缓存），等价于 fitz 的 page.rect */
async function pdfSizeOf(i) {
  const P = S.pdf;
  if (P.sizeCache.has(i)) return P.sizeCache.get(i);
  try {
    const pg = await P.doc.getPage(i);
    const vp = pg.getViewport({ scale: 1 });
    const v = { w: vp.width, h: vp.height };
    P.sizeCache.set(i, v);
    return v;
  } catch (e) { return null; }
}

/** 后台校正页面尺寸：先抽查几页，全一致（绝大多数 PDF）就直接收工，零额外开销；
 *  确实混排才分批补齐，最后一次性重算 y 布局，避免循环里 O(n²)。 */
async function correctPdfSizes() {
  const P = S.pdf;
  const token = ++P.sizeToken;
  const base = P.items[0]; if (!base) return;
  const sample = [2, 3, 4, 5, Math.ceil(P.total / 2), P.total];
  for (const i of sample) {
    if (i < 2 || i > P.total) continue;
    const sz = await pdfSizeOf(i);
    if (P.sizeToken !== token) return;
    if (sz && (Math.abs(sz.w - base.wPt) > 0.5 || Math.abs(sz.h - base.hPt) > 0.5)) {
      await fillAllPdfSizes(token);
      return;
    }
  }
}

async function fillAllPdfSizes(token) {
  const P = S.pdf;
  const BATCH = 12;
  for (let s = 2; s <= P.total; s += BATCH) {
    if (P.sizeToken !== token || S.kind !== 'pdf' || !P.doc) return;
    const e = Math.min(P.total, s + BATCH - 1);
    const got = await Promise.all(
      Array.from({ length: e - s + 1 }, (_, k) => pdfSizeOf(s + k)),
    );
    for (let k = 0; k < got.length; k++) {
      const sz = got[k], it = P.items[s + k - 1];
      if (!sz || !it) continue;
      it.wPt = sz.w; it.hPt = sz.h;
      it.rw = Math.max(1, Math.floor(sz.w * PDF_RENDER_SCALE));
      it.rh = Math.max(1, Math.floor(sz.h * PDF_RENDER_SCALE));
    }
    await new Promise((r) => setTimeout(r, 0));   // 让出主线程，别卡住滚动
  }
  if (P.sizeToken !== token) return;
  relayoutPdfItems();
}

/** 尺寸变了重算 y 并与当前滚动位置对齐（对应 Python 里重排 page_items 后 view 校正） */
function relayoutPdfItems() {
  const P = S.pdf, area = pdfArea();
  const keep = P.page, before = P.items[keep - 1];
  const anchorTop = before ? before.y : 0;
  let y = 0;
  for (const it of P.items) { it.y = y; y += it.rh + PDF_SPACING; }
  P.sceneH = y;
  applyZoomToItems();
  const now = P.items[keep - 1];
  if (now && area) area.scrollTop += (now.y - anchorTop) * (P.scale || 1);
  updateViewportRender();
}

/** 对应 apply_zoom() / setTransform：只改占位显示尺寸，不重建 DOM */
function applyZoomToItems() {
  const P = S.pdf, z = P.scale || 1;
  for (const it of P.items) {
    const w = Math.max(1, Math.round(it.rw * z));
    const h = Math.max(1, Math.round(it.rh * z));
    it.w = w; it.h = h;
    it.wrap.style.top = Math.round(it.y * z) + 'px';
    it.wrap.style.width = w + 'px'; it.wrap.style.height = h + 'px';
    if (it.canvas) { it.canvas.style.width = w + 'px'; it.canvas.style.height = h + 'px'; }
    if (it.svg) {
      it.svg.setAttribute('width', w); it.svg.setAttribute('height', h);
      it.svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    }
    // 文本层坐标是按旧尺寸算的，缩放后必须重建，否则选中的字与显示错位
    if (it.textLayer) { it.textLayer.remove(); it.textLayer = null; }
  }
  $('#pdf-pages').style.height = Math.round(P.sceneH * z + 48) + 'px';
}

/** 把视口换算成场景坐标（对应 view.mapToScene(viewport().rect())）。
 *  pdf-bar 是 sticky 固定条，可见内容区为 [barH, clientHeight]，
 *  其内容坐标 = scrollTop，故场景 top = scrollTop / zoom。 */
function pdfViewportScene() {
  const area = pdfArea(), z = S.pdf.scale || 1;
  const barH = $('#pdf-bar').offsetHeight;
  const top = area.scrollTop / z;
  return { top, bottom: top + Math.max(0, area.clientHeight - barH) / z };
}

function pdfPageInViewport(it) {
  const vp = pdfViewportScene();
  return it.y < vp.bottom && it.y + it.rh > vp.top;
}

let pdfSaveTimer = null;
// 点工具条按钮的瞬间浏览器可能清掉 PDF 文字选区，这里像 EPUB 一样记住最近一次有效选区。
let pdfLastRange = null;
document.addEventListener('selectionchange', () => {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || sel.isCollapsed) return;
  const r = sel.getRangeAt(0);
  const n = r.startContainer && r.startContainer.nodeType === 3 ? r.startContainer.parentNode : r.startContainer;
  if (n && n.closest && n.closest('.pdf-text')) pdfLastRange = r.cloneRange();
});

/** 对应 _update_viewport_render()：只把与视口相交的页放进队列，离屏页立刻释放位图 */
function updateViewportRender() {
  const P = S.pdf;
  if (!P.doc || !P.items.length) return;
  const vp = pdfViewportScene();
  const t = vp.top - PDF_PREFETCH, b = vp.bottom + PDF_PREFETCH;
  P.queue.length = 0;                          // self.render_queue.clear()
  for (const it of P.items) {
    if (it.y < b && it.y + it.rh > t) {        // d['rect'].intersects(vp)
      if (!it.isRendered || (!it.isHighRes && !it.renderingHigh)) {
        if (!P.queue.includes(it)) P.queue.push(it);
      }
    } else if (it.isRendered) {
      pdfReleasePixmap(it);                    // removeItem(pix_item)，释放内存
    }
  }
  const center = (vp.top + vp.bottom) / 2;
  P.queue.sort((a, b) => {
    const da = Math.abs(a.y + a.rh / 2 - center), db = Math.abs(b.y + b.rh / 2 - center);
    return da - db || a.num - b.num;
  });
  processRenderQueue();
}

/** 对应 removeItem(d['pix_item']) + 状态复位 */
function pdfReleasePixmap(it) {
  if (it.canvas && (it.canvas.width !== 1 || it.canvas.height !== 1)) {
    it.canvas.width = 1; it.canvas.height = 1;
  }
  it.pixItem = null;
  it.isRendered = false; it.isHighRes = false; it.renderingHigh = false;
  it.wrap.classList.remove('rendering', 'rendering-empty');
}

/** 对应 _process_render_queue()：单线程（QThreadPool maxThreadCount=1）串行处理 */
function processRenderQueue() {
  const P = S.pdf;
  if (P.rendering || !P.doc || !P.queue.length) return;
  P.rendering = true;
  const it = P.queue.shift();
  const gen = P.generation;
  const fast = P.renderMode === 'fast';
  if (!it.isRendered) {
    // 低清预览：QSize(low_res_w, int(h * ratio))
    const lowResW = fast ? 500 : 700;
    const ratio = lowResW / it.rw;
    renderPdfTask(it, false, ratio, lowResW, Math.max(1, Math.floor(it.rh * ratio)), gen);
  } else if (!it.isHighRes && !it.renderingHigh) {
    it.renderingHigh = true;
    // 高清：ratio = max(1, min(zoom*dpr, max_ratio))；像素超上限按 sqrt 回缩
    const maxRatio = fast ? 2.0 : 3.0;
    const maxPixels = fast ? 8000000 : 10000000;
    const dpr = Math.min(window.devicePixelRatio || 1, PDF_MAX_DPR);
    let ratio = Math.max(1.0, Math.min((P.scale || 1) * dpr, maxRatio));
    let w = Math.floor(it.rw * ratio), h = Math.floor(it.rh * ratio);
    if (w * h > maxPixels) {
      const k = Math.sqrt(maxPixels / (w * h));
      w = Math.max(1, Math.floor(w * k)); h = Math.max(1, Math.floor(h * k)); ratio *= k;
    }
    renderPdfTask(it, true, ratio, w, h, gen);
  } else {
    P.rendering = false;
    if (P.queue.length) scheduleQueueTick();
  }
}

/** 对应 RenderTask.run()：PDF.js 在 worker 里解码，主线程一次只跑一个 */
async function renderPdfTask(it, isHigh, ratio, w, h, gen) {
  const P = S.pdf;
  let task = null;
  P.renderingItem = it;
  try {
    it.wrap.classList.add('rendering');
    it.wrap.classList.toggle('rendering-empty', !it.isRendered);
    const page = await P.doc.getPage(it.num);
    if (gen !== P.generation || !P.doc) return;
    const vp = page.getViewport({ scale: PDF_RENDER_SCALE * ratio });
    // 先画到离屏画布，完成后一次贴回；直接改可见 canvas.width 会先清成黑/透明。
    const off = document.createElement('canvas');
    off.width = w; off.height = h;
    const ctx = off.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    task = page.render({ canvasContext: ctx, viewport: vp });
    P.renderTask = task;
    await task.promise;
    if (gen !== P.generation || !P.doc) return;
    const cv = pdfEnsureCanvas(it);
    cv.width = w; cv.height = h;
    // 内部像素是渲染分辨率（低清 700px / 高清更高），显示尺寸始终锁定为适宽布局尺寸，
    // 否则重新渲染/翻页后 canvas 会按像素宽撑破 wrap，出现“又变宽大超出窗口”。
    cv.style.width = it.w + 'px';
    cv.style.height = it.h + 'px';
    cv.getContext('2d', { alpha: false }).drawImage(off, 0, 0);
    onRenderFinished(it, isHigh, gen);
  } catch (e) {
    if (gen === P.generation) {
      it.renderingHigh = false;
      it.wrap.classList.remove('rendering', 'rendering-empty');
      if (!e || e.name !== 'RenderingCancelledException') console.warn('PDF 渲染失败', it.num, e);
    }
  } finally {
    if (P.renderTask === task) P.renderTask = null;
    if (P.renderingItem === it) P.renderingItem = null;
    P.rendering = false;
    if (gen !== P.generation) {
      if (!P.scrollTimer) requestViewportRender();
    } else if (P.queue.length) {
      scheduleQueueTick();
    }
  }
}

/** 对应 _on_render_finished()：贴图像 + generation 校验 + 低清插回队首升级高清 */
function onRenderFinished(it, isHigh, gen) {
  const P = S.pdf;
  if (gen !== P.generation) return;
  it.pixItem = it.canvas;
  it.isRendered = true;
  it.wrap.classList.remove('rendering', 'rendering-empty');
  renderPdfAnnsFor(it);                             // 标注层随页面一起恢复
  if (pdfPageInViewport(it)) buildPdfTextLayer(it); // 只给可见页建文本层，预取页不抢 I/O
  if (isHigh) {
    it.isHighRes = true; it.renderingHigh = false;
    if ((isHigh || P.renderMode === 'fast') && !P.sizeCheckStarted) {
      P.sizeCheckStarted = true;
      P.sizeTimer = setTimeout(() => { P.sizeTimer = null; correctPdfSizes(); }, 400);
    }
  } else {
    it.isHighRes = false;
    const vp = pdfViewportScene();
    // 预取页先保留低清即可；只有真正可见的页立即升级高清，避免预取阻塞翻页。
    if (it.y < vp.bottom && it.y + it.rh > vp.top
        && !P.queue.includes(it) && !it.renderingHigh) {
      P.queue.unshift(it);
    }
  }
}

/** 对应 QTimer.singleShot(10, _process_render_queue) */
function scheduleQueueTick() {
  const P = S.pdf;
  clearTimeout(P.queueTimer);
  P.queueTimer = setTimeout(() => { P.queueTimer = null; processRenderQueue(); }, PDF_QUEUE_TICK);
}

/** 对应 scroll_timer（100ms 单次触发） */
function requestViewportRender() {
  const P = S.pdf;
  clearTimeout(P.scrollTimer);
  P.scrollTimer = setTimeout(() => { P.scrollTimer = null; updateViewportRender(); }, PDF_DEBOUNCE_MS);
}

/** 滚动只重排队列：不再每次 generation++ / 删除低清图。
 *  旧逻辑会把刚完成的预取反复作废，平滑翻页后只能从零重渲染。 */
function onScrollChanged() {
  const P = S.pdf;
  if (!P.doc || !P.items.length) return;
  P.queue.length = 0;
  requestViewportRender();
  const area = pdfArea();
  const total = area.scrollHeight - area.clientHeight;
  const pct = total > 0 ? Math.round(area.scrollTop / total * 100) : 100;
  if (pct !== S.progress) {
    S.progress = pct;
    $('#lbl-progress').textContent = `已读 ${pct}%`;
    clearTimeout(pdfSaveTimer);
    pdfSaveTimer = setTimeout(() => saveProgress(), 900);
  }
  syncPdfScroll();
}

/** 对应 _invalidate_rendered()：缩放变化后全部作废，按新 zoom 重新按视口渲染 */
function invalidateRendered() {
  const P = S.pdf;
  for (const it of P.items) if (it.isRendered) pdfReleasePixmap(it);
  P.queue.length = 0;
  P.generation += 1;
  requestViewportRender();
}

/** 对应 _extract_page_chars()：只有真正需要文本时才解析该页，并缓存 */
async function extractPageChars(num) {
  const P = S.pdf;
  if (P.pageChars[num] != null) return P.pageChars[num];
  if (!P.doc) return '';
  try {
    const page = await P.doc.getPage(num);
    const tc = await page.getTextContent();
    P.pageChars[num] = tc.items.map((x) => x.str || '').join('');
  } catch (e) { P.pageChars[num] = ''; }
  return P.pageChars[num];
}

/** 清空 PDF 场景（对应 PdfViewerWidget.clear()） */
function pdfClearAll() {
  const P = S.pdf;
  P.queue.length = 0;
  P.generation += 1;
  P.sizeToken += 1;                 // 作废正在后台跑的尺寸校正
  if (P.sizeCache) P.sizeCache.clear();
  clearTimeout(P.queueTimer); clearTimeout(P.scrollTimer); clearTimeout(P.syncTimer); clearTimeout(P.sizeTimer);
  P.queueTimer = P.scrollTimer = P.syncTimer = P.sizeTimer = null;
  P.sizeCheckStarted = false;
  if (P.renderTask) { try { P.renderTask.cancel(); } catch (e) { /* 已结束 */ } }
  P.renderTask = null; P.renderingItem = null;
  P.rendering = false;
  for (const it of P.items) if (it.textLayer) { try { it.textLayer.remove(); } catch (e) { /* 忽略 */ } }
  P.items = [];
  P.pageChars = {};
  P.sceneH = 0;
  pdfDraw.wrap = null; pdfDraw.start = null; pdfClearDrawPreview();   // 画图委托状态复位
  const holder = $('#pdf-pages');
  holder.innerHTML = '';
  holder.style.height = '';
}

/** 把标注数据统一成矩形数组（兼容旧的“行级矩形数组”与新的“拖拽框”） */
function pdfRectsOf(a) {
  if (Array.isArray(a.data)) return a.data;
  const d = a.data || {};
  if (typeof d.x1 === 'number' && typeof d.x2 === 'number') {
    return [{ x: Math.min(d.x1, d.x2), y: Math.min(d.y1, d.y2),
              w: Math.abs(d.x2 - d.x1), h: Math.abs(d.y2 - d.y1) }];
  }
  return [];
}

function renderPdfAnnsFor(p) {
  const svg = pdfEnsureSvg(p);
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const W = p.w, H = p.h;
  for (const a of S.pdf.anns) {
    if ((a.page | 0) !== p.num) continue;
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    if (a.kind === 'highlight' || a.kind === 'underline') {
      for (const r of pdfRectsOf(a)) {
        if (a.kind === 'highlight') {
          g.appendChild(svgNode('rect', { x: r.x * W, y: r.y * H, width: r.w * W, height: r.h * H,
            fill: a.color, 'fill-opacity': '0.32' }));
        } else {
          g.appendChild(svgNode('line', { x1: r.x * W, y1: (r.y + r.h) * H,
            x2: (r.x + r.w) * W, y2: (r.y + r.h) * H, stroke: a.color, 'stroke-width': a.width || 2 }));
        }
      }
    } else {
      const d = a.data || {};
      if (a.kind === 'rect') {
        g.appendChild(svgNode('rect', {
          x: Math.min(d.x1, d.x2) * W, y: Math.min(d.y1, d.y2) * H,
          width: Math.abs(d.x2 - d.x1) * W, height: Math.abs(d.y2 - d.y1) * H,
          fill: 'none', stroke: a.color, 'stroke-width': a.width || 2 }));
      } else if (a.kind === 'line' || a.kind === 'arrow') {
        g.appendChild(svgNode('line', { x1: d.x1 * W, y1: d.y1 * H, x2: d.x2 * W, y2: d.y2 * H,
          stroke: a.color, 'stroke-width': a.width || 2 }));
        if (a.kind === 'arrow') {
          const ang = Math.atan2((d.y2 - d.y1) * H, (d.x2 - d.x1) * W);
          const len = Math.max(9, (a.width || 2) * 4.5);
          const tipX = d.x2 * W, tipY = d.y2 * H;
          const pts = [[tipX, tipY],
            [tipX - len * Math.cos(ang - 0.42), tipY - len * Math.sin(ang - 0.42)],
            [tipX - len * Math.cos(ang + 0.42), tipY - len * Math.sin(ang + 0.42)]]
            .map((q) => q[0].toFixed(1) + ',' + q[1].toFixed(1)).join(' ');
          g.appendChild(svgNode('polygon', { points: pts, fill: a.color }));
        }
      }
    }
    svg.appendChild(g);
  }
}

function svgNode(tag, attrs) {
  const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  e.style.pointerEvents = 'none';
  return e;
}

function renderPdfAnnotations() {
  const P = S.pdf;
  const it = P.items[P.page - 1];
  if (it) renderPdfAnnsFor(it);
}

/** 只有「画」类工具才拦鼠标；高亮/下划线要走文字选择 */
const PDF_SHAPES = ['line', 'arrow', 'rect', 'screenshot'];

function applyPdfTool() {
  const drawing = PDF_SHAPES.includes(S.tool);
  const vp = pdfViewportScene();
  for (const it of S.pdf.items) {
    it.wrap.style.cursor = drawing ? 'crosshair' : 'default';
    // 选择/高亮/下划线都要能选中文字；画形状时才把文本层让开
    if (it.textLayer) it.textLayer.classList.toggle('on', !drawing);
    // 可见页还没有文本层时按需补建（预取页不建，滚动时省掉 getTextContent）
    else if (!drawing && !it.textBusy && it.y < vp.bottom && it.y + it.rh > vp.top) buildPdfTextLayer(it);
  }
}

/** 为某一页建文本层：文字可选中 → 才能高亮/下划线。
 *  PDF 页本质是位图，没有文本层就只能拖框，文字型 PDF 也就"选不了字"。 */
async function buildPdfTextLayer(it) {
  const P = S.pdf;
  if (!P.doc || it.textLayer || it.textBusy) return;
  it.textBusy = true;
  try {
    const page = await P.doc.getPage(it.num);
    if (it.w <= 0 || !it.wPt) return;
    const tc = await page.getTextContent();
    const scale = it.w / it.wPt;
    const vp = page.getViewport({ scale });
    const layer = document.createElement('div');
    layer.className = 'pdf-text' + (PDF_SHAPES.includes(S.tool) ? '' : ' on');
    layer.style.width = it.w + 'px';
    layer.style.height = it.h + 'px';
    it.wrap.insertBefore(layer, pdfEnsureSvg(it));
    const spans = [], targets = [];
    for (const item of (tc.items || [])) {
      if (!item.str) continue;
      const tx = window.pdfjsLib.Util.transform(vp.transform, item.transform);
      const fontH = Math.hypot(tx[2], tx[3]);
      if (!isFinite(fontH) || fontH <= 0.5) continue;
      const sp = document.createElement('span');
      sp.textContent = item.str;
      sp.style.left = tx[4].toFixed(2) + 'px';
      sp.style.top = (tx[5] - fontH * 0.84).toFixed(2) + 'px';
      sp.style.fontSize = fontH.toFixed(2) + 'px';
      spans.push(sp); targets.push((item.width || 0) * scale);
      layer.appendChild(sp);
    }
    // 统一量宽后再设 scaleX（避免逐个写读造成反复重排）
    for (let i = 0; i < spans.length; i++) {
      const w0 = spans[i].offsetWidth || 1;
      const k = targets[i] / w0;
      if (isFinite(k) && k > 0.03 && k < 30) spans[i].style.transform = 'scaleX(' + k.toFixed(3) + ')';
    }
    it.textLayer = layer;
  } catch (e) {
    console.warn('文本层失败（可能是扫描件）', it.num, e);
  } finally {
    it.textBusy = false;
  }
}

/** 与 EPUB 标注一致：把同一段视觉行中不同字体产生的零碎选区合框，
 *  统一上下边界并合并水平重叠，避免半透明高亮叠色和下划线跳动。 */
function normalizePdfTextRects(rects) {
  const src = rects.filter((q) => q.width > 0.5 && q.height > 0.5)
    .map((q) => ({ l: q.left, t: q.top, r: q.right, b: q.bottom }))
    .sort((a, b) => a.t - b.t || a.l - b.l);
  const lines = [];
  for (const q of src) {
    const cy = (q.t + q.b) / 2;
    let line = lines[lines.length - 1];
    let same = false;
    if (line) {
      const overlap = Math.min(q.b, line.b) - Math.max(q.t, line.t);
      const minH = Math.max(1, Math.min(q.b - q.t, line.b - line.t));
      same = Math.abs(cy - line.cy) <= Math.max(2, minH * 0.45) || overlap / minH > 0.42;
    }
    if (!same) { line = { t: q.t, b: q.b, cy, boxes: [] }; lines.push(line); }
    else { line.t = Math.min(line.t, q.t); line.b = Math.max(line.b, q.b); line.cy = (line.t + line.b) / 2; }
    line.boxes.push(q);
  }
  const out = [];
  for (const line of lines) {
    const intervals = [];
    for (const q of line.boxes.sort((a, b) => a.l - b.l)) {
      const last = intervals[intervals.length - 1];
      if (last && q.l <= last.r + 1.25) last.r = Math.max(last.r, q.r);
      else intervals.push({ l: q.l, r: q.r });
    }
    for (const iv of intervals) out.push({ left: iv.l, top: line.t, right: iv.r, bottom: line.b,
      width: iv.r - iv.l, height: line.b - line.t });
  }
  return out;
}

/** 用当前选区生成 PDF 高亮/下划线（坐标为页内 0~1，随缩放不变） */
function commitPdfSelection(wrap) {
  const sel = window.getSelection();
  let range = null;
  if (sel && sel.rangeCount && !sel.isCollapsed) range = sel.getRangeAt(0);
  else if (pdfLastRange) range = pdfLastRange;
  if (!range || range.collapsed) return false;
  const r = wrap.getBoundingClientRect();
  const rects = normalizePdfTextRects([...range.getClientRects()].filter((q) => q.width > 2 && q.height > 2
    && q.bottom > r.top + 2 && q.top < r.bottom - 2));
  if (!rects.length) return false;
  const data = rects.map((q) => ({
    x: (Math.max(q.left, r.left) - r.left) / r.width,
    y: (Math.max(q.top, r.top) - r.top) / r.height,
    w: (Math.min(q.right, r.right) - Math.max(q.left, r.left)) / r.width,
    h: q.height / r.height,
  })).filter((d) => d.w > 0 && d.h > 0);
  if (!data.length) return false;
  S.pdf.anns.push({ page: +(wrap.dataset.page), kind: S.tool, color: S.color, width: S.width, data });
  renderPdfAnnotations(); persistPdfAnns();
  pdfLastRange = null;
  try { sel.removeAllRanges(); } catch (e) { /* 忽略 */ }
  setTool('select');
  return true;
}

/** 当前选区落在哪一页上 */
function pdfWrapOfSelection() {
  let range = null;
  const sel = window.getSelection();
  if (sel && sel.rangeCount && !sel.isCollapsed) range = sel.getRangeAt(0);
  else if (pdfLastRange) range = pdfLastRange;
  if (!range) return null;
  let n = range.startContainer;
  if (n && n.nodeType === 3) n = n.parentNode;
  for (const it of S.pdf.items) if (it.wrap.contains(n)) return it.wrap;
  return null;
}

// 画图交互改为容器级事件委托：几千页的书不再给每页各绑 4 个监听器 + 一堆闭包，
// 打开 PDF 时省下海量事件注册，交互逻辑与逐页绑定版完全一致。
const pdfDraw = { wrap: null, start: null, preview: null, head: null };
function pdfWrapFrom(e) {
  let n = e.target;
  while (n && n.nodeType === 1 && !n.classList.contains('pdf-page')) n = n.parentNode;
  return (n && n.classList && n.classList.contains('pdf-page')) ? n : null;
}
function pdfRel(wrap, e) {
  const r = wrap.getBoundingClientRect();
  return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
           y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
}
function pdfClearDrawPreview() {
  const d = pdfDraw;
  if (d.preview && d.preview.parentNode) d.preview.parentNode.removeChild(d.preview);
  if (d.head && d.head.parentNode) d.head.parentNode.removeChild(d.head);
  d.preview = null; d.head = null;
}
function pdfNoText(wrap) { return !wrap.querySelector('.pdf-text span'); }
function pdfIsTextTool(wrap) { return (S.tool === 'highlight' || S.tool === 'underline') && !pdfNoText(wrap); }
function pdfIsDrawTool(wrap) { return PDF_SHAPES.includes(S.tool)
  || ((S.tool === 'highlight' || S.tool === 'underline') && pdfNoText(wrap)); }

function bindPdfDrawing(holder) {
  holder.addEventListener('mousedown', (e) => {
    const wrap = pdfWrapFrom(e);
    if (!wrap) return;
    pdfDraw.wrap = wrap;
    if (e.button !== 0 || !pdfIsDrawTool(wrap)) return;
    e.preventDefault();
    pdfDraw.start = pdfRel(wrap, e);
    pdfClearDrawPreview();
    const it = S.pdf.items[+(wrap.dataset.page) - 1];
    const svg = it ? pdfEnsureSvg(it) : null;
    if (!svg) return;
    if (S.tool === 'screenshot') {
      // 自由矩形截图：玫红虚线预览框（对齐 Python 版 _update_shape_preview）
      pdfDraw.preview = svgNode('rect', { fill: 'rgba(255,64,129,.16)', stroke: '#FF4081',
        'stroke-dasharray': '5 4', 'stroke-width': 1.5 });
      svg.appendChild(pdfDraw.preview);
    } else if (S.tool === 'rect' || S.tool === 'highlight' || S.tool === 'underline') {
      pdfDraw.preview = svgNode('rect', { fill: 'rgba(30,136,229,.12)', stroke: S.color,
        'stroke-dasharray': '4 3', 'stroke-width': 1 });
      svg.appendChild(pdfDraw.preview);
    } else {
      // 预览就该是线：旧版所有工具都先画一个矩形虚框，手感很怪
      pdfDraw.preview = svgNode('line', { stroke: S.color, 'stroke-dasharray': '5 4', 'stroke-width': 1.5 });
      svg.appendChild(pdfDraw.preview);
      if (S.tool === 'arrow') { pdfDraw.head = svgNode('polygon', { fill: S.color, opacity: '0.75' }); svg.appendChild(pdfDraw.head); }
    }
  });

  holder.addEventListener('mousemove', (e) => {
    const d = pdfDraw;
    if (!d.wrap || !d.start || !d.preview) return;
    const b = pdfRel(d.wrap, e), W = d.wrap.clientWidth, H = d.wrap.clientHeight;
    if (S.tool === 'rect' || S.tool === 'highlight' || S.tool === 'underline' || S.tool === 'screenshot') {
      d.preview.setAttribute('x', Math.min(d.start.x, b.x) * W);
      d.preview.setAttribute('y', Math.min(d.start.y, b.y) * H);
      d.preview.setAttribute('width', Math.abs(b.x - d.start.x) * W);
      d.preview.setAttribute('height', Math.abs(b.y - d.start.y) * H);
    } else {
      d.preview.setAttribute('x1', d.start.x * W); d.preview.setAttribute('y1', d.start.y * H);
      d.preview.setAttribute('x2', b.x * W); d.preview.setAttribute('y2', b.y * H);
      if (d.head) {
        const ang = Math.atan2((b.y - d.start.y) * H, (b.x - d.start.x) * W);
        const len = 11, tipX = b.x * W, tipY = b.y * H;
        d.head.setAttribute('points', [[tipX, tipY],
          [tipX - len * Math.cos(ang - 0.42), tipY - len * Math.sin(ang - 0.42)],
          [tipX - len * Math.cos(ang + 0.42), tipY - len * Math.sin(ang + 0.42)]]
          .map((q) => q[0].toFixed(1) + ',' + q[1].toFixed(1)).join(' '));
      }
    }
  });

  holder.addEventListener('mouseup', (e) => {
    const d = pdfDraw;
    const wrap = d.wrap;
    if (!wrap) return;
    if (pdfIsTextTool(wrap)) {
      // 文字选择在 mouseup 之后才定稿，等一拍再取
      setTimeout(() => { commitPdfSelection(wrap); }, 0);
      return;
    }
    if (!d.start) return;
    const a = d.start, b = pdfRel(wrap, e);
    d.start = null; pdfClearDrawPreview(); d.wrap = null;
    if (Math.abs(b.x - a.x) < 0.002 || Math.abs(b.y - a.y) < 0.002) return;
    if (S.tool === 'screenshot') {          // 自由矩形截图：不产生标注，直接截取位图
      doPdfScreenshot(wrap, a, b);
      setTool('select');
      return;
    }
    const kind = S.tool;
    if (kind === 'highlight' || kind === 'underline') {
      S.pdf.anns.push({ page: +(wrap.dataset.page), kind, color: S.color, width: S.width,
        data: [{ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
                 w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) }] });
    } else {
      S.pdf.anns.push({ page: +(wrap.dataset.page), kind, color: S.color, width: S.width,
        data: { x1: a.x, y1: a.y, x2: b.x, y2: b.y } });
    }
    renderPdfAnnotations(); persistPdfAnns();
    setTool('select');
  });

  holder.addEventListener('mouseleave', () => {
    pdfDraw.start = null; pdfClearDrawPreview(); pdfDraw.wrap = null;
  });
}

function persistPdfAnns() {
  if (S.path) invoke('set_pdf_annotations', { path: S.path, data: JSON.stringify(S.pdf.anns) }).catch(() => {});
}

function loadSvgImage(svg) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('SVG rasterize failed'));
    try {
      const xml = new XMLSerializer().serializeToString(svg);
      img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(xml)));
    } catch (e) { reject(e); }
  });
}

/** PDF 自由矩形截图：页面位图 + 当前标注 SVG 两层合成后裁剪。 */
async function doPdfScreenshot(wrap, a, b) {
  const it = S.pdf.items.find((i) => i.wrap === wrap);
  if (!it) return;
  if (!it.isRendered || !it.canvas || !it.canvas.width || it.canvas.width < 2) {
    toast('当前页还没渲染完，请稍候再截图。'); return;
  }
  const W = it.canvas.width, H = it.canvas.height;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  const w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
  if (Math.round(w * W) < 5 || Math.round(h * H) < 5) { toast('截图区域太小'); return; }
  const sx = Math.max(0, Math.floor(x * W)), sy = Math.max(0, Math.floor(y * H));
  const sw = Math.min(W - sx, Math.max(1, Math.round(w * W)));
  const sh = Math.min(H - sy, Math.max(1, Math.round(h * H)));
  const out = document.createElement('canvas');
  out.width = sw; out.height = sh;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, sw, sh);
  ctx.drawImage(it.canvas, sx, sy, sw, sh, 0, 0, sw, sh);
  try {
    if (it.svg && it.svg.children.length) {
      const img = await loadSvgImage(it.svg);
      // SVG 使用页面显示坐标，canvas 使用位图像素，二者按比例映射到同一裁剪框。
      const vx = sx / W * it.w, vy = sy / H * it.h;
      const vw = sw / W * it.w, vh = sh / H * it.h;
      ctx.drawImage(img, vx, vy, vw, vh, 0, 0, sw, sh);
    }
  } catch (e) { console.warn('截图标注层合成失败', e); }
  handleScreenshot(out.toDataURL('image/png'));
}

// ---- 截图结果处理（对应 Python 版 _do_screenshot 的保存/复制/取消三选一） ----
let pendingShot = null;
function handleScreenshot(dataUrl) {
  pendingShot = dataUrl;
  $('#shot-text').textContent = '截图已捕获，请选择操作：';
  $('#dlg-shot').showModal();
}
async function saveShotToFile() {
  if (!pendingShot) return;
  const dest = await saveDialog({ defaultPath: 'screenshot.png',
    filters: [{ name: 'PNG 图片', extensions: ['png'] }] });
  if (dest) {
    await invoke('write_file_base64', { path: dest, data: pendingShot.split(',')[1] });
    toast('已保存到：\n' + dest);
  }
  $('#dlg-shot').close();
}
function dataUrlToBlob(dataUrl) {
  const parts = dataUrl.split(',');
  const mime = (parts[0].match(/data:(.*?)(;|$)/) || [])[1] || 'image/png';
  const bin = atob(parts[1]);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}
async function copyShotToClipboard() {
  if (!pendingShot) return;
  try {
    const blob = dataUrlToBlob(pendingShot);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    toast('截图已复制到剪贴板');
  } catch (e) {
    // 剪贴板写入不可用就退到保存文件，别让截图白截
    toast('复制失败，改为保存文件');
    await saveShotToFile();
    return;
  }
  $('#dlg-shot').close();
}

function gotoPdfPage(n, smooth = true) {
  const P = S.pdf;
  if (!P.doc || !P.items.length) return;
  n = Math.max(1, Math.min(P.total, n | 0 || 1));
  const it = P.items[n - 1];
  if (!it) return;
  const area = pdfArea(), holder = $('#pdf-pages');
  const barH = $('#pdf-bar').offsetHeight;
  if (!smooth && P.renderTask && P.renderingItem && P.renderingItem.num !== n) {
    try { P.renderTask.cancel(); } catch (e) { /* 已结束 */ }
  }
  // 用预计算的场景 y 定位，不依赖 offsetTop 的布局值
  area.scrollTo({ top: Math.max(0, holder.offsetTop + it.y * P.scale - barH - 6),
                  behavior: smooth ? 'smooth' : 'auto' });
  P.page = n;
  updatePdfLabel();
  // 平滑滚动过程中会经过中间页，先屏蔽自动同步，停下来再按实际位置校正
  if (smooth) {
    P.suppressSync = true;
    clearTimeout(P.syncTimer);
    P.syncTimer = setTimeout(() => { P.suppressSync = false; syncPdfScroll(); updateViewportRender(); }, 650);
  } else {
    P.suppressSync = false;
    syncPdfScroll();
    updateViewportRender();           // 立即渲染目标页，不等滚动防抖
  }
}

function updatePdfLabel() {
  const P = S.pdf;
  $('#pdf-page-info').textContent = `${P.page} / ${P.total}`;
  const jump = $('#pdf-jump');
  if (jump && document.activeElement !== jump) jump.value = String(P.page);
}

function pdfStep(delta) {
  if (!S.pdf.doc) return;
  gotoPdfPage(S.pdf.page + delta, false);
}

let pdfScrollTick = false;
function pdfOnScroll() {
  if (pdfScrollTick) return;
  pdfScrollTick = true;
  requestAnimationFrame(() => { pdfScrollTick = false; onScrollChanged(); });
}

/** 对应 _find_page_at()：用预计算的 y 做纯数学查找，不遍历 DOM 读 getBoundingClientRect */
function syncPdfScroll() {
  const P = S.pdf;
  if (!P.doc || !P.items.length || P.suppressSync) return;
  const vp = pdfViewportScene();
  const line = vp.top + 24 / (P.scale || 1);
  let cur = P.total;
  for (const it of P.items) {
    if (it.y + it.rh > line) { cur = it.num; break; }
  }
  if (cur !== P.page) { P.page = cur; updatePdfLabel(); }
}

function scrollPdfToPercent(pct) {
  const P = S.pdf;
  if (!P.doc) return;
  gotoPdfPage(Math.round(pct / 100 * P.total) || 1, false);
}

/** 对应 apply_zoom()：vw = viewport().width() - 24；zoom_factor = vw / max_page_w */
function pdfFitScale() {
  const P = S.pdf;
  if (!P.items.length) return 1;
  let maxW = 1;
  for (const it of P.items) if (it.rw > maxW) maxW = it.rw;
  const vw = (pdfArea().clientWidth || 720) - 24;
  return Math.min(3, Math.max(0.2, vw / maxW));
}

async function pdfFitWidth() {
  if (!S.pdf.doc) return;
  setZoom(pdfFitScale());
}

async function exportPdfPagePng() {
  const P = S.pdf;
  const it = P.items[P.page - 1];
  if (!it || !it.isRendered || !it.canvas) { toast('当前页还没渲染完，请稍候再导出。'); return; }
  const out = document.createElement('canvas');
  out.width = it.canvas.width; out.height = it.canvas.height;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(it.canvas, 0, 0);
  try {
    if (it.svg && it.svg.children.length) {
      const img = await loadSvgImage(it.svg);
      ctx.drawImage(img, 0, 0, out.width, out.height);
    }
  } catch (e) { console.warn('标注层合成失败', e); }
  const dest = await saveDialog({ defaultPath: `page-${P.page}.png`,
    filters: [{ name: 'PNG 图片', extensions: ['png'] }] });
  if (dest) await invoke('write_file_base64', { path: dest, data: out.toDataURL('image/png').split(',')[1] });
}

// ---------------- 设置 ----------------
function fillSettings() {
  $('#cfg-db').value = S.cfg.db_dir; $('#cfg-note').value = S.cfg.note_dir;
  $('#cfg-editor').value = S.cfg.md_editor; $('#cfg-pd').value = S.cfg.sc_page_down;
  $('#cfg-pu').value = S.cfg.sc_page_up; $('#cfg-fs').value = S.cfg.sc_fullscreen;
  $('#cfg-toc').value = S.cfg.sc_toc;
  $('#cfg-pdf-mode').value = S.cfg.pdf_render_mode || 'high';
}
async function openSettings() {
  fillSettings(); $('#dlg-settings').showModal();
}

// ---------------- 事件绑定 ----------------
function bindEvents() {
  $('#btn-dir').onclick = async () => {
    const d = await openDialog({ directory: true, defaultPath: S.cfg.last_dir });
    if (d) { S.cfg.last_dir = d; await invoke('set_config', { cfg: S.cfg }); await loadFiles(); }
  };
  $('#btn-file').onclick = async () => {
    const f = await openDialog({ multiple: false, filters: [{ name: '电子书', extensions: EXTS.map((e) => e.slice(1)) }] });
    if (f) { S.cfg.last_dir = f.replace(/[\\/][^\\/]*$/, ''); await invoke('set_config', { cfg: S.cfg }); await openBook(f); }
  };
  $('#btn-recent').onclick = () => {
    S.viewMode = S.viewMode === 'recent' ? 'all' : 'recent';
    $('#btn-recent').classList.toggle('active', S.viewMode === 'recent');
    renderTable();               // 切换“全部文件 / 最近阅读”视图
  };
  $('#btn-refresh').onclick = loadFiles;
  $('#search').oninput = loadFiles;
  $('#filter').onchange = loadFiles;
  $$('#file-table thead th').forEach((th) => th.onclick = () => {
    const k = th.dataset.col;
    if (S.sortKey === k) S.sortAsc = !S.sortAsc; else { S.sortKey = k; S.sortAsc = true; }
    renderTable();
  });
  $('#btn-edit-note').onclick = async () => {
    if (!S.selected) return toast('请先选中一个文件');
    const v = await promptBox('编辑备注', S.selected.note || '');
    if (v === null) return;
    await invoke('set_note_meta', { path: S.selected.path, text: v }); await loadFiles();
  };
  $('#btn-clear-note').onclick = async () => {
    if (!S.selected) return toast('请先选中一个文件');
    await invoke('clear_note_meta', { path: S.selected.path }); await loadFiles();
  };
  $('#btn-open-note').onclick = () => S.selected && openNoteExternal(S.selected.path);
  $('#btn-settings').onclick = openSettings;

  $('#pdf-export').onclick = exportPdfPagePng;
  $('#pdf-prev').onclick = () => pdfStep(-1);
  $('#pdf-next').onclick = () => pdfStep(1);
  $('#pdf-jump').onchange = () => {
    const v = parseInt($('#pdf-jump').value, 10);
    if (v) gotoPdfPage(v, false); else updatePdfLabel();
  };
  $('#pdf-area').addEventListener('scroll', pdfOnScroll, { passive: true });
  bindPdfDrawing($('#pdf-pages'));           // PDF 画图/标注交互：容器级委托，只绑一次
  $('#btn-back').onclick = back;
  $('#btn-prev').onclick = () => S.kind === 'pdf' ? pdfStep(-1) : pageStep(-1);
  $('#btn-next').onclick = () => S.kind === 'pdf' ? pdfStep(1) : pageStep(1);
  $$('#tool-group button').forEach((b) => b.onclick = () => setTool(b.dataset.tool));
  $('#width-sel').onchange = (e) => { S.width = parseInt(e.target.value, 10); applyToolToFrame(); };
  $('#btn-undo').onclick = undoAnnotation;
  $('#btn-clear-ann').onclick = clearAnnotations;
  $('#btn-zoom-in').onclick = () => setZoom(S.zoom + 0.1);
  $('#btn-zoom-out').onclick = () => setZoom(S.zoom - 0.1);
  $('#btn-fit').onclick = fitWidth;
  $('#btn-write-note').onclick = async () => {
    if (S.kind === 'pdf') {
      // 对应 _extract_page_chars()：只有真正需要文字时才解析该页，并缓存
      const sel = window.getSelection ? window.getSelection().toString() : '';
      const t = sel || (await extractPageChars(S.pdf.page)).slice(0, 300);
      if (t) appendNote(`\n> 引用：${t}\n`); else toast('当前页没有可提取的文字。');
      return;
    }
    const w = $('#page-frame').contentWindow;
    const t = w?.getSelection?.().toString?.() || '';
    if (t) appendNote(`\n> 引用：${t}\n`); else toast('请先在正文中选中文字。');
  };
  for (const id of ['#font-sel', '#size-sel', '#line-in']) $(id).onchange = applyFormat;
  $('#btn-preview-note').onclick = () => previewNoteText($('#note-edit').value);
  $('#btn-export-note').onclick = () => exportNote(S.path);
  $('#btn-delete-note').onclick = async () => {
    $('#note-edit').value = ''; await saveNote();
  };
  $('#btn-fullscreen').onclick = () => invoke('toggle_fullscreen').catch(() => {});

  $('#toc-reopen').onclick = toggleTocPane;
  $('#bm-add').onclick = addBookmark;
  $('#bm-del').onclick = async () => {
    if (bmSelected < 0) return;
    S.bookmarks.splice(bmSelected, 1); bmSelected = -1;
    await invoke('set_bookmarks', { path: S.path, list: S.bookmarks }); renderBookmarks();
  };
  $('#bm-clear').onclick = async () => {
    S.bookmarks = []; bmSelected = -1;
    await invoke('set_bookmarks', { path: S.path, list: [] }); renderBookmarks();
  };
  $('#preview-close').onclick = () => $('#dlg-preview').close();
  $('#message-ok').onclick = () => $('#dlg-message').close();
  $('#shot-save').onclick = saveShotToFile;
  $('#shot-copy').onclick = copyShotToClipboard;
  $('#shot-cancel').onclick = () => { $('#dlg-shot').close(); };
  $('#cfg-cancel').onclick = () => $('#dlg-settings').close();
  $('#cfg-save').onclick = async () => {
    S.cfg.db_dir = $('#cfg-db').value; S.cfg.note_dir = $('#cfg-note').value;
    S.cfg.md_editor = $('#cfg-editor').value; S.cfg.sc_page_down = $('#cfg-pd').value;
    S.cfg.sc_page_up = $('#cfg-pu').value; S.cfg.sc_fullscreen = $('#cfg-fs').value;
    S.cfg.sc_toc = $('#cfg-toc').value;
    S.cfg.pdf_render_mode = $('#cfg-pdf-mode').value;
    S.pdf.renderMode = S.cfg.pdf_render_mode === 'fast' ? 'fast' : 'high';
    if (S.kind === 'pdf' && S.pdf.doc) invalidateRendered();
    await invoke('set_config', { cfg: S.cfg }); $('#dlg-settings').close();
    toast('设置已保存；数据/笔记目录在重启后生效。');
  };
  $$('[data-browse]').forEach((b) => b.onclick = async () => {
    const target = $('#' + b.dataset.browse);
    const isFile = b.dataset.browse === 'cfg-editor';
    const r = await openDialog({ directory: !isFile, defaultPath: target.value || undefined });
    if (r) target.value = r;
  });

  window.addEventListener('message', (e) => {
    const d = e.data; if (!d || !d.type) return;
    if (d.type === '__ANN__') saveAnnotationsForPage(d.page | 0, d.list);
    else if (d.type === '__NAV__') navigateTo(d.href);
    else if (d.type === '__PROGRESS__') {
      S.progress = d.pct; $('#lbl-progress').textContent = `已读 ${d.pct}%`;
      saveProgress();
    }
    else if (d.type === '__EXTERNAL__') invoke('open_external', { path: d.href, editor: '' }).catch(() => {});
    else if (d.type === '__SHOT__' && d.dataUrl) handleScreenshot(d.dataUrl);
    else if (d.type === '__CLIP__' && d.text) appendNote(`\n> 引用：${d.text}\n`);
  });

  document.addEventListener('keydown', (e) => {
    const key = (e.shiftKey ? 'Shift+' : '') + (e.ctrlKey ? 'Ctrl+' : '') + (e.key === ' ' ? 'Space' : e.key);
    if (key === S.cfg.sc_page_down && S.path) { e.preventDefault(); scrollPage(1); }
    else if (key === S.cfg.sc_page_up && S.path) { e.preventDefault(); scrollPage(-1); }
    else if (key === S.cfg.sc_fullscreen) { e.preventDefault(); $('#btn-fullscreen').click(); }
    else if (key === S.cfg.sc_toc && S.path) { e.preventDefault(); toggleTocPane(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && S.path) { e.preventDefault(); undoAnnotation(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveNote(); saveProgress(); }
  });

  let noteTimer = null;
  $('#note-edit').addEventListener('input', () => {
    clearTimeout(noteTimer); noteTimer = setTimeout(saveNote, 800);
  });
  window.addEventListener('beforeunload', () => { flushAnnotations(); saveNote(); saveProgress(); });
}
function scrollPage(dir) {
  if (S.kind === 'pdf') { pdfStep(dir); return; }
  const w = $('#page-frame').contentWindow;
  if (!w) return;
  w.scrollBy(0, dir * (w.innerHeight - 80));
}

// ---------------- 启动 ----------------
async function main() {
  S.cfg = await invoke('get_config');
  const filter = $('#filter');
  filter.innerHTML = '<option>全部支持格式</option>' + EXTS.map((e) => `<option>${e}</option>`).join('');
  const cg = $('#color-group');
  COLORS.forEach(([hex, name], i) => {
    const b = document.createElement('button');
    b.style.background = hex; b.title = name; b.dataset.color = hex;
    if (i === 0) b.classList.add('active');
    b.onclick = () => {
      S.color = hex; $$('#color-group button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active'); applyToolToFrame();
    };
    cg.appendChild(b);
  });
  S.font = S.cfg.font || S.font; S.size = S.cfg.font_size || S.size;
  S.spacing = S.cfg.line_spacing || S.spacing; S.zoom = S.cfg.zoom || 1.0;
  $('#font-sel').value = S.font; $('#size-sel').value = String(S.size);
  $('#line-in').value = String(S.spacing); setZoom(S.zoom);
  loadColW(); applyColW(); bindColResizers();
  bindPaneResizers();
  S.annotJs = await invoke('annot_script');
  bindEvents();
  await loadFiles();
  showView('browser');
}
main().catch((e) => { console.error(e); document.body.innerHTML = `<pre>启动失败：${e}</pre>`; });
