# Codex Session Renderer

[English README](./README.md)

这个项目会从 `~/.codex/sessions` 和 `~/.codex/archived_sessions` 读取 Codex 会话文件，内置一个可直接使用的 Web 页面用于浏览和管理会话，同时支持通过 CLI 导出 Markdown、HTML，以及按需启用的 PNG 快照。

默认情况下，它只渲染最近一轮对话。这里的一轮指的是：从一条用户消息开始，到下一条用户消息出现之前的全部内容。

## 依赖要求

- Node.js 18+

只有在你显式需要导出 PNG 时，才需要安装 Playwright Chromium。Web 页面和 Markdown/HTML 导出不依赖 Chromium。

渲染器可以使用固定版本的官方 `Source Han Sans SC`（思源黑体简体中文）字体资源来渲染简体中文，因此在字体资源安装完成后，不再依赖系统级中文字体。
默认情况下，下载的字体文件会保存在每个用户自己的数据目录中，而不是项目包目录内。
在 Linux 上，这通常是 `~/.local/share/codex-session-renderer/fonts`，除非你设置了 `XDG_DATA_HOME`。
如果你没有安装字体资源，HTML 预览会退回系统字体，而不会直接报错退出。

## 安装

```bash
npm install
```

可选：安装固定版本字体资源，保证中文显示一致：

```bash
npm run install:fonts
```

可选：安装 Chromium，用于 PNG 导出：

```bash
npm run install:browser
```

## 全局 CLI

可以直接从 GitHub 全局安装 CLI：

```bash
npm install -g git+https://github.com/Gtyro/codex-session-renderer.git#main
```

安装完成后，在任意目录都可以使用下面两个命令：

```bash
codex-session-renderer --latest
csr --latest
```

`csr` 是日常使用的短别名。

将固定版本的中文字体资源下载到全局安装对应的用户数据目录：

```bash
csr --install-fonts
```

这些字体会下载到你的用户数据目录里，因此即使包本体安装在 root 拥有权限的全局 `node_modules` 下，字体目录依然是可写的。

如果当前机器还没有安装 Playwright Chromium，请执行：

```bash
npx playwright install chromium
```

如果后续想删除全局安装：

```bash
npm uninstall -g codex-session-renderer
```

如果你是在本地仓库里开发，也仍然可以在仓库根目录执行 `npm link`，让全局命令直接指向当前工作树。

## 用法

启动内置 Web 页面：

```bash
npm run web
```

默认会监听在 `http://127.0.0.1:4311/`。

或者使用全局 CLI：

```bash
csr --serve
```

Web 页面会同时读取 `sessions` 和 `archived_sessions`，并使用 `~/.codex/session_index.jsonl` 里的 `thread_name` 作为会话标题；你可以直接在侧边栏里原地修改这个标题，也可以归档活动会话、把归档会话恢复回 `sessions`，以及永久删除归档会话。
双击侧边栏标题即可直接原地编辑，或者使用界面里的 `改名` 操作进入同一套内联编辑状态。
当你归档或恢复当前选中的会话时，界面会继续停留在当前 scope，并尽量保留原来的浏览上下文，而不是自动跳到另一页。

渲染最新会话：

```bash
npm run render -- --latest
```

为本地仓库安装固定版本的中文字体资源：

```bash
npm run install:fonts
```

CLI 也可以直接安装字体：

```bash
csr --install-fonts
codex-session-renderer --install-fonts
```

渲染最近 3 轮对话，而不只是最近 1 轮：

```bash
npm run render -- --latest --rounds 3
```

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

为 Web 页面分别指定活动会话目录和归档目录：

```bash
npm run web -- --sessions-dir /path/to/sessions --archived-sessions-dir /path/to/archived_sessions
```

渲染前先清空输出目录：

```bash
npm run render -- --latest --clean-output
```

输出 Markdown/HTML，并额外生成最终 PNG 图片：

```bash
npm run render -- --latest --png
```

只输出最终 PNG 图片：

```bash
npm run render -- --latest --png-only
```

包含默认隐藏的脚手架信息：

```bash
npm run render -- --latest --include-context --include-developer --include-reasoning
```

同样的参数也适用于全局命令：

```bash
csr --latest --rounds 3
csr --id 019cea6d-7660-7c51-ade7-510d2bdf3caa --all
csr --serve
```

跳过 PNG，只保留 Markdown/HTML 输出：

```bash
npm run render -- --latest --no-images
```

`--no-images` 现在只是兼容旧用法，因为默认就不会导出 PNG。

如果 Playwright Chromium 缺失，PNG 渲染会提示你执行 `npm run install:browser`。但 Web 页面和默认的 Markdown/HTML 路径仍然可以正常使用。

## VS Code 扩展

这个仓库现在也可以直接打包为 VS Code 扩展。扩展的定位是“浏览器优先”：

- 入口在 VS Code 命令面板
- 主要浏览界面在外部浏览器全屏打开
- 不强行把主体验塞进侧栏

第一版扩展提供这些命令：

- `Codex Session Renderer: Open Session Browser`
- `Codex Session Renderer: Open Latest Preview`
- `Codex Session Renderer: Copy Browser URL`
- `Codex Session Renderer: Stop Session Browser`

扩展 manifest 直接复用仓库根目录的 `package.json`，扩展入口文件是 `vscode/extension.cjs`。Marketplace 展示页使用单独的 `vscode/README.md` 和 `vscode/CHANGELOG.md`，不会直接拿项目根目录文档当扩展说明。
在 Remote SSH、WSL 或其他远端扩展宿主下，扩展会先让 VS Code 把本地服务地址转换成客户端可访问的外部 URL，再用于打开浏览器或复制链接。

如果你已经跑通过 Marketplace 流程，打包 VSIX 的最小步骤就是：

```bash
npm run package:vsix
```

打出来的 `.vsix` 就可以上传到 Marketplace 网页端。

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

## 输出内容

每次运行都会在输出目录中写入以下文件：

- `<session-id>.md`：完整归档转录
- `<session-id>.compact.md`：适合分享的精简转录
- `<session-id>.compact.html`：当前选中转录的完整 HTML
- `<session-id>.round-01.compact.html`、`<session-id>.round-02.compact.html` 等：按轮次拆分、用于图片渲染的 HTML
- `<session-id>.round-01.compact.png`、`<session-id>.round-02.compact.png` 等：默认每轮输出一张图片
- 如果单轮内容仍然过高，会自动回退为分页图片，例如 `<session-id>.round-01.compact-01.png`

启用 `--png-only` 时，渲染器会删除当前会话对应的 Markdown 和 HTML 中间产物，只保留最终 PNG 文件。

默认情况下，渲染器不会生成 PNG，因此不需要 Playwright Chromium。

启用 `--png` 时，渲染器会在保留 Markdown/HTML 的同时额外生成 PNG。

启用 `--clean-output` 时，渲染器会在写入新文件前先清空目标输出目录。

默认情况下，渲染器只保留最近一轮对话中的用户消息、助手消息、工具调用和工具输出。开发者提示、内部推理以及注入的上下文内容默认隐藏，只有显式启用相关参数时才会包含。

精简输出会隐藏空轮询调用、折叠进度日志较多的内容，并截断过长的工具输出片段，以便最终 PNG 更易阅读。
