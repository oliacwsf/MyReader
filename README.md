# 我的阅读器 · My Reader（v1.1.6）

一个基于 **Rust + Tauri 2** 的桌面电子书阅读器，前端 HTML/CSS/JS 复刻原 Qt（PySide6）版界面，
Rust 后端负责 EPUB 解析、SQLite 持久化与文件访问，PDF 使用内置的 PDF.js 离线渲染。

成品为**单个 Windows 可执行文件**（约 8–15 MB），不含 Chromium 运行时，依赖系统自带的 WebView2。

---

## 功能特性

| 分类 | 功能 |
| --- | --- |
| 文件管理 | 目录浏览、打开文件、搜索、按格式筛选、排序、列宽拖拽记忆、备注列、右键菜单 |
| 最近阅读 | 自动记录最近打开的 10 本书并持久化，支持换电脑/盘符变化后按文件名自适应定位 |
| 支持格式 | `.epub` `.pdf` `.txt` `.html` `.htm` `.mobi` `.azw3` `.fb2` `.cbz` `.xps` `.svg` |
| EPUB 阅读 | 大书分块加载（80 章/页 + 单页字节预算）、目录/正文链接**文内 100% 跳转**、图片/字体内联 |
| PDF 阅读 | 字节区间懒加载、按需渲染、翻页预取、文字型 PDF 高亮/下划线、扫描件拖框标注 |
| 标注 | 高亮、下划线、直线、箭头、矩形、自由截图（可带标注合成导出 PNG） |
| 目录 / 书签 | 左侧「目录 | 书签」两栏可独立展开/收起，宽度可拖动调节并记忆；PDF 自带书签自动解析 |
| 笔记 | Markdown 编辑、预览、导出、删除、把选中文字写入笔记；按文件完整路径隔离，空笔记不误显示 |
| 阅读体验 | 字体/字号/行距/缩放/适宽/全屏、快捷键、阅读进度、书签 |
| 数据兼容 | 数据库表结构与 Python 旧版一致，自动迁移旧库，直接沿用旧数据 |
| 便携运行 | 进度/书签/标注/备注/笔记/最近阅读全部存于 exe 同目录，整目录放入 U 盘即可随身携带 |

---

## 运行环境（最终用户）

| 依赖 | 版本 / 说明 | 获取方式 |
| --- | --- | --- |
| Windows | Windows 10 1803+ 或 Windows 11 | 系统自带 |
| WebView2 Runtime | Win11 / 近年 Win10 **已随 Edge 自带**；老机器需装 Evergreen 版 | <https://developer.microsoft.com/microsoft-edge/webview2/> |

> 成品 exe 无需再安装任何其它运行库：PDF.js、SQLite（bundled 编译进 exe）、界面与标注引擎均已内嵌。

---

## 开发 / 构建环境（开发者）

编译 **Windows 版 exe** 需要在 Windows 上完成（Tauri 的 WebView2 + MSVC 链接器仅支持在 Windows 构建，无法在 Linux/macOS 交叉编译出可运行的 Windows 版）。

| 依赖 | 版本 / 说明 | 获取方式 |
| --- | --- | --- |
| Node.js | 18 / 20 / 22 LTS（含 npm） | <https://nodejs.org> |
| Rust | 用 rustup 安装，工具链 `x86_64-pc-windows-msvc`（默认） | <https://rustup.rs> |
| Visual Studio Build Tools 2022 | 勾选「**使用 C++ 的桌面开发**」（MSVC v143 + Windows 11 SDK） | <https://visualstudio.microsoft.com/visual-cpp-build-tools/> |
| WebView2 Runtime | 开发机一般已随系统自带 | 同上 |

> **Linux 开发预览**（仅 `tauri dev`，不产出 Windows exe）需系统库：
> `libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev libsoup-3.0-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev`
> 可用 `sudo apt-get install ...` 安装。

### Rust 依赖（`src-tauri/Cargo.toml`）

| crate | 用途 |
| --- | --- |
| `tauri` 2 | 桌面应用框架 |
| `tauri-plugin-dialog` 2 | 原生文件/目录选择对话框 |
| `serde` / `serde_json` | 序列化与配置、数据读写 |
| `zip` 2（deflate） | EPUB 压缩包解析 |
| `rusqlite` 0.32（bundled） | SQLite 持久化（SQLite 直接编入 exe，无需系统库） |
| `base64` 0.22 | 图片/字体内联与二进制传输 |

### 前端依赖（`package.json`）

| 包 | 用途 |
| --- | --- |
| `@tauri-apps/cli` | 构建/开发命令 |
| `@tauri-apps/api`、`@tauri-apps/plugin-dialog` | Tauri 前端 API |

> 前端界面不依赖任何打包器；PDF.js 已内置在 `dist/vendor/`，离线可用、无需联网。

---

## 目录结构

```
my-reader/
├── dist/                      ★ 前端资源（会被嵌入 exe）
│   ├── index.html             主界面
│   ├── styles.css             Qt 风格样式
│   ├── app.js                 主逻辑（列表/阅读/目录书签/笔记/设置/PDF）
│   ├── annot.js               iframe 内标注引擎
│   └── vendor/                PDF.js（离线内置）
├── package.json / package-lock.json
├── .github/workflows/windows-build.yml   云端一键构建 Windows exe
├── WINDOWS_BUILD.md           Windows 本地构建完整指导
├── GITHUB_CLOUD_BUILD.md      从零开始云端生成 exe 图文说明
└── src-tauri/
    ├── Cargo.toml             release：opt-level=s / lto / strip / panic=abort
    ├── tauri.conf.json        frontendDist = "../dist"
    ├── capabilities/default.json
    ├── icons/
    └── src/
        ├── main.rs
        ├── lib.rs             Tauri 命令与全局状态（open_book 返回目录 + spine 表）
        ├── epub.rs            EPUB 分块解析 / 目录 / 锚点 / spine 表 / 资源内联
        └── store.rs           SQLite 持久化（进度/书签/标注/备注/最近阅读，自动迁移旧库）
```

---

## 构建 exe

### 方式 A：本地 Windows 构建

```powershell
npm install
npm run tauri build            # 完整构建（exe + 安装包）
npm run tauri build -- --no-bundle   # 只要单文件 exe，更快
```

成品：`src-tauri\target\release\my-reader.exe`（便携单文件）。

### 方式 B：GitHub Actions 云端构建（推荐，无需本地装环境）

1. 把本工程上传到 GitHub 仓库（Public 仓库 Actions 免费）；
2. **Actions → Build Windows exe → Run workflow**；
3. 约 15–30 分钟后在 **Artifacts** 下载 `my-reader-portable`，解压得到 `my-reader.exe`；
4. 创建带 `v` 开头的 tag（如 `v1.0.0`）发布，还会额外生成 NSIS 安装包。

逐步图文说明见 **[GITHUB_CLOUD_BUILD.md](./GITHUB_CLOUD_BUILD.md)**，本地构建细节见 **[WINDOWS_BUILD.md](./WINDOWS_BUILD.md)**。

---

## 数据与便携性（重要）

程序以 **exe 所在目录**为基准读取/创建所有数据，**无需写入系统用户目录**：

```
<exe 目录>/database/my_reader.db    SQLite：进度、书签、标注、备注、最近阅读
<exe 目录>/note/<路径哈希>.notes.md   每本书的 Markdown 笔记
<exe 目录>/config.json              配置（数据目录、快捷键、字体等）
```

数据库表：`notes` / `recent` / `progress` / `bookmarks` / `pdf_annotations` / `epub_annotations`，
启动时自动检测并修复旧库结构漂移。把旧版的 `database\`、`note\`、`config.json` 复制到 exe 同目录即可**原样沿用**笔记、进度、书签与标注。

**U 盘便携**：把整个 exe 目录（含 `database\`、`note\`、`config.json`）一起放入 U 盘，换电脑运行即可同步携带全部数据。
其中「最近阅读」记录的是绝对路径，换电脑导致盘符变化（如 `E:` → `F:`）时，会按**文件名**在数据目录中自动重新定位（唯一匹配才替换）。

> 说明：笔记文件自 v1.1.3 起改为按**文件完整路径哈希**命名（如 `a1b2….notes.md`），用于隔离同名文件；
> 旧版按 `<书名>.notes.md` 命名的文件仍会自动兼容读取，重新保存后迁移到新命名。

---

## 关键设计说明

- **大 EPUB 秒开**：`open_book` 只做元数据扫描（目录/分块/锚点预扫/spine 表），页面 HTML 在翻页时才按 80 章/页分块生成，DOM 恒为一页。
- **文内链接 100% 跳转**：后端在解析时把正文与目录链接统一重写为 `epub://pN.html#chap_idx_anchor`，并向前端返回 **spine 表**（路径 → 分块页号 → 章节序号）；前端对后端未能重写的原始相对路径再按 spine 表兜底解析，缺失锚点自动回退到章节点。
- **PDF 懒加载**：`read_file_range` 按字节区间供数（`disableAutoFetch`），打开只扫尺寸建占位，可见页才渲染，翻页预取相邻页，避免整本读入内存。
- **标注锚点化**：标注记录「字符区间 + 引文」而非绝对坐标，字体/字号/窗口变化后按锚点重算位置，不会跑偏。
- **最近阅读持久化 + 路径自适应**：最近阅读存于 SQLite `recent` 表（随 exe 目录便携），前端渲染时若记录路径已失效，按文件名在当前文件列表中唯一匹配后重新定位。
- **笔记隔离**：笔记文件按「完整路径」FNV-1a 64 位哈希命名，同名文件各自独立；`has_note` 以「文件存在且内容非空白」为准，空文件不再误判。
