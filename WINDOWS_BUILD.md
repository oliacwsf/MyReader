# 在 Windows 上把本工程编译成 exe

> 本工程是 Rust + Tauri 2 源码。Tauri 在 Windows 上依赖 **MSVC 链接器**与 **WebView2**，  
> 因此 exe 必须在 Windows 机器上生成（Linux/macOS 无法交叉编译出可运行的 Windows 版）。  
> 源码与 Rust 逻辑已在 Linux 侧做过编译校验；你在 Windows 上只需执行下面几条命令。

---

## 路线选择

| 路线                                | 适合                 | 需要本地装环境          |
| --------------------------------- | ------------------ | ---------------- |
| **A. 本地 Windows 构建**（下面第 1~5 节）   | 想自己掌控、以后还要改代码      | 是                |
| **B. GitHub Actions 云端构建**（第 6 节） | 不想装 VS/Rust，只要 exe | 否，只需一个 GitHub 账号 |

---

## A. 本地构建

### 1. 准备环境（只装一次）

| 软件                                 | 版本 / 说明                                                | 下载地址                                                         |
| ---------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------ |
| Windows                            | **Win10 1803+ 或 Win11**                                | —                                                            |
| Node.js                            | 18 / 20 / 22 LTS 均可（含 npm）                             | <https://nodejs.org>                                         |
| Rust                               | 用 rustup 安装，工具链选 `x86_64-pc-windows-msvc`（默认即是）        | <https://rustup.rs>                                          |
| **Visual Studio Build Tools 2022** | 安装时勾选 **「使用 C++ 的桌面开发」**（含 MSVC v143 + Windows 11 SDK） | <https://visualstudio.microsoft.com/visual-cpp-build-tools/> |
| WebView2 Runtime                   | Win11 / 近年的 Win10 **已自带**；老机器需装「Evergreen Runtime」     | <https://developer.microsoft.com/microsoft-edge/webview2/>   |

安装完验证（PowerShell）：

```powershell
node -v
npm -v
rustc --version
cargo --version
```

> VS Build Tools 装好后，建议用开始菜单里的 **「x64 Native Tools Command Prompt for VS 2022」**  
> 来执行后面的命令，它会自动配好 `link.exe` 等环境变量；用普通 PowerShell 也可以，只要 `link.exe` 能找到。

### 2. 放置工程

把 `reader-tauri` 整个文件夹解压到一个**不含中文和空格**的路径，例如：

```
C:\my-reader-tauri\
├── dist\
│   ├── index.html
│   ├── app.js
│   ├── annot.js
│   ├── styles.css
│   └── vendor\       (pdf.js)
├── package.json
├── .github\
│   └── workflows\windows-build.yml
└── src-tauri\
    ├── Cargo.toml
    ├── tauri.conf.json    frontendDist = "../dist"
    ├── icons\
    └── src\
```

### 3. 安装前端依赖

```powershell
cd C:\my-reader-tauri
npm install
```

（国内网络慢可先执行 `npm config set registry https://registry.npmmirror.com`；  
Rust 依赖慢可在 `%USERPROFILE%\.cargo\config.toml` 配置 crates.io 镜像。）

### 4. 编译

```powershell
npm run tauri build
```

首次构建会下载并编译 Rust 依赖，**约 10–25 分钟**，之后增量构建只需几十秒。

### 5. 找到成品

```
src-tauri\target\release\
├── my-reader.exe                      ← ★ 单文件便携 exe（前端资源已内嵌，约 8–15 MB）
└── bundle\
    ├── nsis\我的阅读器_1.0.0_x64-setup.exe   ← 安装包（可选）
    └── msi\我的阅读器_1.0.0_x64_en-US.msi
```

**只要 exe、不要安装包**（构建更快）：

```powershell
npm run tauri build -- --no-bundle
```

#### 做成便携压缩包

1. 新建文件夹 `我的阅读器便携版\`，把 `my-reader.exe` 复制进去；
2. 可选：把旧 Python 版目录下的 `database\`、`note\`、`config.json` 一起复制进去 ——  
   **本工程数据库表结构与 Python 版完全一致，启动时还会自动修复旧库结构漂移**，  
   所以你的笔记、进度、书签、EPUB 标注、PDF 标注会**原样延续**，不需要任何导入操作；
3. 右键文件夹 →「压缩为 ZIP」，即为可分发的便携包。

程序首次运行会在 **exe 所在目录**创建 `database\my_reader.db`、`note\`、`config.json`，  
所以请把 exe 放在有写权限的目录（不要放在 `C:\Program Files` 里直接双击，除非以管理员运行或改数据目录）。  
数据/笔记目录可在程序「设置」里改到别处。

#### 进一步压缩（可选）

```powershell
upx --best --lzma my-reader.exe
```

Cargo.toml 里已启用 `opt-level="s"`、`lto`、`strip`、`panic="abort"`。  
UPX 能再省 30–50%，但**可能触发杀毒软件误报**，正式分发建议改用代码签名证书。

---

## B. 云端构建（不想装环境，推荐）

**零基础逐步图文说明见 [GITHUB_CLOUD_BUILD.md](./GITHUB_CLOUD_BUILD.md)**（从注册 GitHub 账号开始，全程在浏览器里完成，本地不装任何开发工具）。

简要流程：注册账号 → 建 Public 仓库 → 网页上传工程文件（含 `.github` 与 `dist`）→ **Actions** → `Build Windows exe` → **Run workflow** → 等 15–30 分钟 → 在 **Artifacts** 下载 `my-reader-portable` → 解压即得到单文件 `my-reader.exe`。

工程已附 `.github/workflows/windows-build.yml`（Windows 云端编译 + 上传便携 exe）。

---

## 常见问题

| 现象                                                   | 原因 / 处理                                                                                                     |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `link.exe not found` / `LNK` 错误                      | 没装 VS Build Tools 的 C++ 组件，或没用 x64 Native Tools 命令行                                                         |
| `failed to run custom build command for tauri-build` | 检查 `src-tauri\icons\icon.ico` 是否存在、`tauri.conf.json` 是否完整                                                   |
| 双击 exe 无窗口 / 提示缺 WebView2                            | 目标机器装 [WebView2 Evergreen Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)；Win10/11 一般已自带 |
| `npm run tauri build` 报 MSI/WiX 相关错误                 | 先用 `--no-bundle` 只出 exe；MSI 目标需要 WiX，可改用 NSIS 或直接分发 exe                                                     |
| 打开 EPUB 后图片不显示                                       | 确认 `dist\vendor\` 文件夹存在（PDF.js）；EPUB 图片已内联为 data URI，不依赖外部文件                                                |
| 标注保存后重启丢失                                            | 确认 exe 目录可写（`database\` 能生成）；旧库若报「表有 N 列」会在启动时自动迁移                                                          |
| 首次打开 25MB+ 合集较慢                                      | 属正常：需解压并分块；之后按页加载很快                                                                                         |

---

## 验证清单（换版后建议先跑一遍）

1. 打开 25MB+ / 60 册合集 → 目录双击能跳、正文链接能跳、"下一页 / 上一页"能翻；
2. 在某一页做标注 → 翻到下一页 → 翻回来 → **标注仍在**；
3. 点「返回」→ 重新打开同一本书 → **标注、进度、笔记都在**；
4. 关闭程序再启动 → 数据仍在；
5. 加书签、写笔记、改备注 → 重启后仍在。
