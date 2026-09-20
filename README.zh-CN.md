# Codex Session Renderer

[English README](./README.md)

这是一个浏览器优先的 Codex 会话浏览器与导出工具。

它会从 `~/.codex/sessions` 和 `~/.codex/archived_sessions` 读取会话文件，提供一个内置的浏览器界面用于浏览和管理，同时支持导出 compact/full 两种视图的 Markdown、HTML，以及按需启用的 PNG 快照。VS Code 扩展打开的也是同一套浏览器界面。

## 主要特性

- 用完整浏览器界面浏览活动会话和归档会话。
- 按会话记录的工作区（`cwd`）筛选，缺少目录的旧日志会单独归类。
- 支持原地修改标题、归档或恢复会话，以及永久删除归档会话。
- 深链接 URL 会保留 scope、搜索词、选中会话和阅读选项。
- 会话内容会按对话轮次组织，过程性内容可折叠，并支持用 `[` / `]` 跳转。
- 任务脉络视图会关联 Goal、委派的子任务、`task_started` 生命周期事件、工具调用和识别到的验证结果；带链接的证据可跳回原始 transcript。
- 结构化图片附件、文件提及摘要和 skill payload 会以更易读的卡片形式展示，而不是原始协议文本。
- 可生成本地、脱敏的优化证据与实时 campaign 轨迹：worker/reviewer 活动、指令版本、验证、token/耗时指标以及安全的指令资产补丁历史。
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

## Make 入口

为了统一本地仓库操作，仓库根目录也提供了一层轻量 `make` 门面：

```bash
make deps
make dev
make stop
make test
make build
```

语义如下：

- `make dev`
  - 用于本地开发/调试时独立启动浏览器界面
- `make stop`
  - 仅对独立直启的 `make dev` 做尽力停止
- `make test`
  - 运行 Node 测试套件
- `make build`
  - 打包 VS Code 扩展 `.vsix`

日常主入口仍然是 VS Code 宿主命令：

- `Codex Session Renderer: Open Session Browser`

## Web 页面

启动内置浏览器界面：

```bash
npm run web
```

为活动会话和归档会话分别指定目录：

```bash
npm run web -- --sessions-dir /path/to/sessions --archived-sessions-dir /path/to/archived_sessions
```

界面会优先使用 `~/.codex/session_index.jsonl` 里的 `thread_name` 作为会话标题，缺失时再回退到 Codex 状态数据库。侧栏的工作区下拉框会按每个会话元数据中的 `cwd` 筛选；已记录的工作区按各自最新会话的更新时间倒序排列，“所有工作区”固定置顶，“未记录工作区”固定置底。双击活动会话标题可直接原地改名；双击归档会话可直接删除，并在不阻塞操作的“撤销”提示中恢复。顶部操作按钮同样支持归档、恢复和删除，并可通过深链接 URL 重新打开同一个浏览视图。

## CLI 导出

浏览器界面是主入口。CLI 主要用于导出快照和分享产物。

## 优化分析

在浏览器中打开一个会话后，点击 **复制完整分析包**。浏览器会根据持久化会话事件生成本地证据摘要和可展开的任务执行轨迹，并将脱敏后的 Codex 分析提示复制到剪贴板。轨迹中的每项都可跳回原始 transcript。

报告会区分已记录事实与待验证假设，不会声称能精确归因到单个 Skill 或单份文档。它绝不会自动修改 `AGENTS.md`、Skill、README 或其他开发文档；所有建议都仍需人工审阅，并在重复任务 case 上验证。

只有需要直接启动本地 Codex 审阅时才使用 **运行 Codex 分析**。浏览器会要求确认，再以 `codex exec --sandbox read-only --ephemeral` 启动独立分析，并仅显示其脱敏后的最终报告；不会应用报告或向被分析工作区写入内容。

## Agent Workflow Optimizer

将 `$agent-workflow-optimizer` 安装到 Codex Skills 目录后，可直接使用自然语言请求：

```text
$agent-workflow-optimizer 复盘今天 mygog 的 add-game 工作，并优化相关指令。
$agent-workflow-optimizer 用 $mygog-add-game 添加：Braid、忍道焰、Sea Watchers；处理列表时持续优化流程。
```

浏览器中选定会话后，点击 **交给优化 Skill** 只会复制对应的前台请求。将它粘贴到当前 Codex 对话即可；浏览器绝不会在后台启动隐藏的 Codex 任务。

重复任务会在 `~/.codex-session-renderer/campaigns` 创建本地 campaign。每个 campaign 的 worker 都通过 `csr campaign run` 启动：CSR 自己持有一个持久的 `codex exec --json` 进程，记录其稳定 thread 与结构化 token/耗时事件，并实时流入 campaign 面板。进程成功只会进入“等待验证”，不是任务已通过；必须先有明确验收证据，再用 `csr campaign validate --from-run ...` 记录结果。reviewer 则在临时空白、只读的 checkpoint 沙箱中运行，只接收协调者压缩后的 checkpoint，无法读取工作区、已注册资产、原始会话，也不应进行工具发现。当前 Codex 运行时无法独立归属原生委派子 agent 的 token 和耗时，因此它们不参与 campaign。共享写入或隔离性不明的任务会串行；只有能证明相互独立的任务才会以固定指令版本并行成波执行。

历史会话或外部创建的 worker 仍可由 `csr campaign measure` 基于用户明确选择的持久会话测量；用户和 agent 都不会直接读取原始 JSONL。App Server bridge 只是可选增强，不再是 campaign 的依赖。缺失 token 会明确显示为“未知”，绝不会记成 `0`，也不能满足持久补丁的 token 节省门槛。

overlay 可立即服务下一项任务。只有同一 cohort 的两个不同 case 都完成成功配对、并显示 worker token 降低后，才会自动应用 `SKILL.md`、`README*.md` 或 `docs/*.md` 的持久补丁。每个配对都必须来自 CSR 实际记录、已明确验收的 worker runs，并使用相同模型、命令、参数、sandbox 与 prompt，以及同一干净快照的两份独立工作区；token 与来源直接取自记录，不能手填。历史会话可用于挑选 case，但不能充当 CSR worker 的基线。worker token 是晋级指标；耗时会显示为回归告警，reviewer 的 token/耗时作为独立开销展示。`AGENTS.md` 永不自动修改，不自动提交，三方合并冲突不会覆盖文件；`csr campaign rollback` 也只会回退仍保持已应用版本的补丁。完成的 ledger 可以用 `csr campaign archive --run <id>` 归档而不删除，并用 `csr campaign restore --run <id>` 恢复。

若 agent 创建的是可丢弃 worktree，创建 campaign 时传入 `--disposable-workspace`。CSR 只接受系统临时目录下已存在且不是符号链接的目录，并记录其解析后的路径与文件系统身份；执行 `csr campaign archive --run <id>` 时，会先删除这个完全匹配的工作区，再把 ledger 移至可恢复的归档。其余工作区始终保留；若已声明的临时工作区已不存在，则会被记录为缺失而非报错。

若每次 worker 使用独立 worktree，则同时传入 `--execution-cwd /tmp/<case>` 与 `--disposable-execution-cwd`。CSR 会按同一边界验证，并在该 run 写入最终测量后立即删除完全匹配的工作区；清理结果会作为 campaign event 保留。

`csr sessions search`、`csr sessions pick` 与 `csr session evidence` 是 Skill 使用的会话数据面命令，支持自然语言解析和方向键选择，并且刻意不会默认选取全局 `latest`。

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
