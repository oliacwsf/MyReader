# 从零开始：在 GitHub 云端生成 exe

> 全程在浏览器里操作，**你自己的电脑不用装 Python、Rust、Node、Visual Studio**。
> 编译在微软提供的 Windows 云端机器上完成，你只下载结果。
> 预计耗时：注册 3 分钟 + 上传 2 分钟 + 首次编译 15–30 分钟。

---

## 第 0 步：先准备两样东西

| 需要 | 说明 |
| --- | --- |
| `reader-tauri-src.zip` | 我交给你的工程压缩包（约 480KB）。**先解压**，得到一个 `reader-tauri` 文件夹 |
| 一个能收信的邮箱 | QQ、163、Gmail、Outlook 都行，注册时要收验证码 |

另外：一台能上网的电脑 + Chrome / Edge 浏览器。国内访问 GitHub 偶尔偏慢，卡住时换个时段再试即可。

> 重要：解压后先打开 `reader-tauri` 文件夹看一眼，里面应该直接能看到
> `dist`、`src-tauri`、`.github`、`package.json`、`README.md` 等。
> **后面上传的是"这个文件夹里面的内容"，不是这个文件夹本身。**

---

## 第 1 步：注册 GitHub 账号（约 3 分钟）

1. 浏览器打开 **<https://github.com/signup>**。
2. 依次填写：
   - **Email**：你的邮箱；
   - **Password**：至少 8 位，含字母和数字；
   - **Username**：用户名，只能用小写字母、数字、短横线，例如 `reader-2026`。它会变成你的仓库网址，建议起个好记的；
   - 国家/地区选 China，问卷可以直接跳过。
3. 完成人机验证（拼图/选图），点 **Create account**。
4. 去邮箱找 GitHub 发来的 **6 位验证码**，填回网页。
5. 计划选择 **Free（免费）**，付费选项一律跳过。
6. 看到 GitHub 首页即注册成功。

---

## 第 2 步：创建仓库（约 1 分钟）

仓库就是"存放这个工程的地方"。

1. 登录后，点右上角 **「+」** → **New repository**。
2. 按下表填写：

| 项目 | 填什么 | 为什么 |
| --- | --- | --- |
| Repository name | `my-reader` | 随意，但别用中文和空格 |
| Description | 可留空 | — |
| **Public / Private** | **选 Public** | 公开仓库的 Actions 编译**完全免费**；私有仓库每月只有 2000 分钟 |
| Add a README file | **不勾** | 保持空仓库，上传时不会冲突 |
| Add .gitignore / license | **不勾** | 同上 |

3. 点绿色 **Create repository**。
4. 记下网址：`https://github.com/你的用户名/my-reader`。

---

## 第 3 步：上传工程文件（**最容易出错，请慢一点**）

### 3.1 打开上传页

空仓库页面上会有一句 "…or **uploading an existing file**"，点那个蓝色链接；
或者点 **Add file → Upload files**。

### 3.2 拖文件（关键）

1. 打开你解压出来的 **`reader-tauri` 文件夹**，**进入它里面**。
2. 按 `Ctrl + A` 全选**里面的所有内容**（约 30 个文件，包括 `.github` 文件夹、`dist` 文件夹、`src-tauri` 文件夹、`package.json` 等）。
3. 把这些**一起拖进** GitHub 网页中间的虚线上传框。

> ⚠️ **不要把外面那层 `reader-tauri` 文件夹整个拖进去**。
> 如果拖错，仓库里会变成 `reader-tauri/dist/...` 多套一层，云端编译会报
> `index.html not found` 而失败。
>
> 正确结果：仓库首页第一层就能看到 `dist`、`src-tauri`、`.github`、`package.json`。
>
> 小提示：`.github` 在 Windows 里是**普通文件夹**（名字以点开头，但不是隐藏文件），
> 可以被一起拖进去。拖完在上传列表里确认一下有它。

### 3.3 提交

等进度条全部走完（`vendor/pdf.worker.min.js` 约 1.4MB，稍慢），在下方
**Commit changes** 区域填一句说明（例如 `init`），点绿色 **Commit changes**。

### 3.4 上传后逐项核对

回到仓库首页，确认能看到这些（点进去看一眼更保险）：

- [ ] `.github` → `workflows` → `windows-build.yml`
- [ ] `dist` → `index.html`、`app.js`、`annot.js`、`styles.css`、`vendor`
- [ ] `src-tauri` → `Cargo.toml`、`tauri.conf.json`、`src`、`icons`
- [ ] `package.json`、`package-lock.json`

### 3.5 如果 `.github` 没传上去（补救方法，2 分钟）

网页上传偶尔会漏掉点开头的文件夹，手动补一个即可：

1. 仓库首页点 **Add file → Create new file**。
2. 在文件名输入框里**完整输入**：
   ```
   .github/workflows/windows-build.yml
   ```
   （输入 `/` 时 GitHub 会自动建好目录）
3. 把下面这一整段**原样粘贴**到下面的大编辑框：

```yaml
name: Build Windows exe

on:
  workflow_dispatch:
  push:
    tags: ['v*']

jobs:
  build-windows:
    runs-on: windows-latest
    steps:
      - name: 检出源码
        uses: actions/checkout@v4

      - name: 安装 Node
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: 安装 Rust (MSVC 工具链)
        uses: dtolnay/rust-toolchain@stable

      - name: 缓存 Rust 构建
        uses: Swatinem/rust-cache@v2
        with:
          workspaces: src-tauri

      - name: 安装前端依赖
        run: npm install

      - name: 编译（只产出单文件 exe，不打安装包）
        run: npm run tauri build -- --no-bundle

      - name: 上传便携 exe
        uses: actions/upload-artifact@v4
        with:
          name: my-reader-portable
          path: src-tauri/target/release/my-reader.exe
          if-no-files-found: error

      - name: （可选）同时生成 NSIS 安装包
        if: startsWith(github.ref, 'refs/tags/v')
        run: npm run tauri build -- --bundles nsis

      - name: 上传安装包
        if: startsWith(github.ref, 'refs/tags/v')
        uses: actions/upload-artifact@v4
        with:
          name: my-reader-setup
          path: src-tauri/target/release/bundle/nsis/*.exe
          if-no-files-found: warn
```

4. 拉到底点 **Commit new file**。

> 这个文件就是"云端构建说明书"：它让 GitHub 借一台 Windows 机器，
> 装好 Node/Rust → 执行编译 → 把 exe 上传成可下载的成品。

---

## 第 4 步：启动云端编译（约 1 分钟操作 + 等待）

1. 点仓库顶部的 **Actions** 标签。
2. 若出现 "Workflows aren't running" 之类提示，点 **I understand my workflows, go ahead and enable them** 启用。
3. 左侧工作流列表选 **Build Windows exe**。
4. 右侧出现 **Run workflow** 下拉按钮 → 分支选 `main` → 点绿色 **Run workflow**。
5. 刷新页面，会出现一条新的运行记录，点进去 → 再点 **build-windows** 可以看实时日志。

**等待时间**：首次约 **15–30 分钟**（云端要现装 Rust 并编译几百个依赖）；
之后因为有了缓存，通常 **5–10 分钟**。日志长时间不动是正常的，不要反复取消重跑。

**成功标志**：所有步骤前都是绿色 ✔，最后一步 "上传便携 exe" 成功，运行页底部出现 **Artifacts** 区域。

---

## 第 5 步：下载 exe

1. 回到这次运行的**总览页**（不是某个步骤的日志页），拉到最下面 **Artifacts**。
2. 点 **`my-reader-portable`** 下载 —— 下载到的是一个 **zip**。
3. 解压，得到 **`my-reader.exe`**（单文件，约 8–15MB）。
4. 把 exe 放到一个**有写入权限**的文件夹，例如 `D:\我的阅读器\`。
   **不要**放在 `C:\Program Files` 里直接双击（程序要在同目录写数据库）。
5. 双击运行。

> 成品只有这一个 exe，不需要附带其它文件；PDF.js、界面、标注引擎都已嵌在里面。

---

## 第 6 步：首次运行的常见提示

| 现象 | 处理 |
| --- | --- |
| 蓝色 SmartScreen「Windows 已保护你的电脑」 | 点「**更多信息**」→「**仍要运行**」。自制程序没有代码签名，属正常 |
| 杀毒软件报毒 / 自动删除 | 自编译无签名程序常见，加入白名单即可（可在本机自行编译避免误报） |
| 提示缺少 **WebView2** | 装微软 [WebView2 Evergreen Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)（Win10/11 一般已随 Edge 自带） |
| 首次启动后文件夹里多出 `database\`、`note\`、`config.json` | 正常：说明标注/笔记/进度可以保存了 |
| 想沿用 Python 版旧数据 | 把旧版的 `database\my_reader.db`、`note\`、`config.json` 复制到 exe 同目录，程序会自动迁移旧表结构 |

---

## 第 7 步：以后怎么更新 / 要安装包怎么办

- **改了代码重新出 exe**：在仓库网页上传覆盖同名文件 → Commit → 再走一次第 4 步。
- **想要带安装向导的安装包**：在仓库点 **Releases → Create a new release**，标签填 `v1.0.0` 并发布。
  工作流检测到 `v` 开头的标签会额外生成 **`my-reader-setup`** 安装包（NSIS，会自动处理 WebView2 引导）。
- **费用**：Public 仓库的 Actions 免费；Artifact 默认保留 90 天，重要版本请及时下载存档。

---

## 出错了怎么排查

| 症状 | 原因 / 处理 |
| --- | --- |
| Actions 里找不到 `Build Windows exe` | `.github/workflows/windows-build.yml` 没传上去或路径多了一层 → 按 3.5 补救 |
| `index.html not found` / `frontendDist` 报错 | 文件被套在 `reader-tauri/` 子目录里了 → 把里面的内容移到仓库根目录 |
| `npm : 无法识别` / `tauri 不是命令` | 根目录缺 `package.json` / `package-lock.json`，重新上传 |
| 编译超过 60 分钟仍无进展 | Cancel 后重跑一次（云端偶发抽风），重跑会用到已有缓存 |
| 某步骤红色 ✘ | 点开该步骤，把**最后 30 行日志**复制给我，我帮你定位并改工程 |

---

## 关于隐私

- 上传的只是**程序源码**，你的电子书、标注、笔记**不会**被上传，它们只保存在你自己电脑的 exe 同目录。
- 公开仓库任何人能看到源码；如果不想公开，可改 Private，但会消耗每月 2000 分钟免费额度（一次构建约 20 分钟，够用很多次）。
