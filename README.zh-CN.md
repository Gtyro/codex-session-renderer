# Codex Session Renderer

[English README](./README.md)

这是一个浏览器优先的 Codex 会话浏览器与导出工具。

它会从 `~/.codex/sessions` 和 `~/.codex/archived_sessions` 读取会话文件，提供一个内置的浏览器界面用于浏览和管理，同时支持导出 compact/full 两种视图的 Markdown、HTML，以及按需启用的 PNG 快照。VS Code 扩展打开的也是同一套浏览器界面。

## 主要特性

- 用完整浏览器界面浏览活动会话和归档会话。
- 支持原地修改标题、归档或恢复会话，以及永久删除归档会话。
- 深链接 URL 会保留 scope、搜索词、选中会话和阅读选项。
- 会话内容会按对话轮次组织，过程性内容可折叠，并支持用 `[` / `]` 跳转。
- 结构化图片附件、文件提及摘要和 skill payload 会以更易读的卡片形式展示，而不是原始协议文本。
- 可以把当前视图导出为 compact/full Markdown、HTML，以及可选的 PNG。

## 依赖要求

- Node.js 18+

如果 Codex 使用的是默认目录，一般不需要额外配置。

## 快速开始

```bash
npm install
npm run web
```

打开 `http://127.0.0.1:4311/`。
如果 `4311` 已被占用，服务会自动回退到一个空闲随机端口，并在终端打印最终 URL。

默认会读取：

- `~/.codex/sessions`
- `~/.codex/archived_sessions`

## Web 页面

启动内置浏览器界面：

```bash
npm run web
```

为活动会话和归档会话分别指定目录：

```bash
npm run web -- --sessions-dir /path/to/sessions --archived-sessions-dir /path/to/archived_sessions
```

界面会优先使用 `~/.codex/session_index.jsonl` 里的 `thread_name` 作为会话标题，缺失时再回退到 Codex 状态数据库。你可以双击标题直接原地改名，也可以用顶部操作按钮完成归档、恢复和删除，并通过深链接 URL 重新打开同一个浏览视图。

## CLI 导出

浏览器界面是主入口。CLI 主要用于导出快照和分享产物。

渲染最新会话：

```bash
npm run render -- --latest
```

渲染最近 3 轮：

```bash
npm run render -- --latest --rounds 3
```

如果需要查看默认最近一轮之外的内容，可以使用 `--rounds` 或 `--all`。

按会话 ID 渲染：

```bash
npm run render -- --id 019cea6d-7660-7c51-ade7-510d2bdf3caa
```

渲染整个会话：

```bash
npm run render -- --id 019cea6d-7660-7c51-ade7-510d2bdf3caa --all
```

使用自定义 sessions 目录或输出目录：

```bash
npm run render -- --id 019cea6d-7660-7c51-ade7-510d2bdf3caa --sessions-dir /path/to/sessions --output-dir ./artifacts
```

渲染前先清空输出目录：

```bash
npm run render -- --latest --clean-output
```

额外生成 PNG 图片：

```bash
npm run render -- --latest --png
```

只保留最终 PNG 图片：

```bash
npm run render -- --latest --png-only
```

包含默认隐藏的 context、developer 消息和 reasoning 摘要：

```bash
npm run render -- --latest --include-context --include-developer --include-reasoning
```

`--no-images` 仍然保留为兼容旧用法的参数，但现在默认本来就不会导出 PNG。

## 可选全局 CLI

可以直接从 GitHub 全局安装 CLI：

```bash
npm install -g git+https://github.com/Gtyro/codex-session-renderer.git#main
```

安装完成后，在任意目录都可以使用这两个命令名：

```bash
csr --serve
csr --latest --rounds 3
codex-session-renderer --id 019cea6d-7660-7c51-ade7-510d2bdf3caa --all
```

`csr` 是日常使用的短别名。

## VS Code 扩展

这个仓库也可以直接打包成 VS Code 扩展。扩展会启动本地会话浏览服务，并在外部浏览器里打开完整界面，而不是把主体验强行塞进侧栏。

扩展提供这些命令：

- `Codex Session Renderer: Open Session Browser`
- `Codex Session Renderer: Open Latest Preview`
- `Codex Session Renderer: Copy Browser URL`
- `Codex Session Renderer: Run Developer Self-Check`（仅在启用 `codexSessionRenderer.showDeveloperCommands` 时显示）

扩展 manifest 直接复用仓库根目录的 `package.json`，扩展入口文件是 `vscode/extension.cjs`，Marketplace 文档使用单独的 `vscode/README.md` 和 `vscode/CHANGELOG.md`。
扩展打开的浏览器视图保留与独立 Web 页面一致的深链接 URL 状态、对话轮次组织方式和 transcript 跳转能力。
扩展启动的浏览器服务会在最后一个浏览器窗口或标签页关闭后自动停止。
在 Remote SSH、WSL 或其他远端扩展宿主下，扩展会先让 VS Code 把本地服务地址转换成客户端可访问的外部 URL，再用于打开浏览器或复制链接。

从仓库根目录打包 `.vsix`：

```bash
npm run package:vsix
```

## 可选资源

如果需要一致的简体中文渲染效果，可以安装固定版本的字体资源：

```bash
npm run install:fonts
```

CLI 也可以直接安装同一套字体资源：

```bash
csr --install-fonts
codex-session-renderer --install-fonts
```

渲染器使用固定版本的官方 `Source Han Sans SC`（思源黑体简体中文）字体下载。字体文件会保存在每个用户自己的数据目录中，而不是项目包目录内。在 Linux 上，这通常是 `~/.local/share/codex-session-renderer/fonts`，除非设置了 `XDG_DATA_HOME`。如果没有安装这些字体资源，HTML 预览会回退到系统字体，而不会直接失败。

只有在需要 PNG 导出时，才需要安装 Playwright Chromium：

```bash
npm run install:browser
```

浏览器界面和默认的 Markdown/HTML 导出都不依赖 Chromium。如果 Chromium 缺失，PNG 导出会给出 `npm run install:browser` 提示，而不会影响浏览器界面。

## 输出内容

默认的 Markdown/HTML 模式下，每次运行都会在输出目录中写入以下文件：

- `<session-id>.md`：完整归档转录
- `<session-id>.compact.md`：适合分享的精简转录
- `<session-id>.compact.html`：当前选中转录的完整 HTML
- `<session-id>.round-01.compact.html`、`<session-id>.round-02.compact.html` 等：按轮次拆分、用于图片渲染的 HTML

启用 `--png` 或 `--png-only` 时，渲染器还会额外写入：

- `<session-id>.round-01.compact.png`、`<session-id>.round-02.compact.png` 等：通常每轮输出一张图片
- 如果单轮内容仍然过高，会自动回退为分页图片，例如 `<session-id>.round-01.compact-01.png`

启用 `--png-only` 时，渲染器不会保留顶层 Markdown/HTML 产物，并会在导出 PNG 后删除临时的分轮 HTML，最终只保留 PNG 文件。

默认情况下，渲染器只保留最近一轮对话中的用户消息、助手消息、工具调用和工具输出。开发者提示、内部推理以及注入的上下文内容默认隐藏，只有显式启用相关参数时才会包含。

结构化图片附件、文件提及摘要和 skill payload 会在 Markdown 与交互式 HTML 中统一整理为更易读的展示形式。

精简输出会隐藏空轮询调用、折叠进度日志较多的内容，并截断过长的工具输出片段，以便最终 PNG 更易阅读。

## Shell 补全

CLI 可以输出 `bash`、`zsh` 或 `fish` 的补全脚本：

```bash
csr --print-completion bash
csr --print-completion zsh
csr --print-completion fish
```

快速配置示例：

```bash
echo 'eval "$(csr --print-completion bash)"' >> ~/.bashrc
echo 'eval "$(csr --print-completion zsh)"' >> ~/.zshrc
echo 'source (csr --print-completion fish | psub)' >> ~/.config/fish/config.fish
```

生成的脚本会同时为 `csr` 和 `codex-session-renderer` 注册补全。
