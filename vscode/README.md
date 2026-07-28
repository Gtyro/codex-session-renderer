# Codex Session Renderer

Browser-first session browsing for Codex histories in VS Code.<br>
面向 Codex 会话历史的浏览器优先 VS Code 扩展。

Open Codex sessions in a full browser window from VS Code.<br>
从 VS Code 直接在完整浏览器窗口中打开 Codex 会话。

Browse active and archived sessions, rename titles inline, archive or restore sessions, delete archived sessions, and open the latest preview without leaving VS Code.<br>
用于浏览活动会话和归档会话、原地修改标题、归档或恢复会话、删除归档会话，并快速打开最新预览。

Deep-linked browser URLs preserve the current scope, search query, selected session, and reader options. Transcript activity is grouped into collapsible conversation rounds, and `[` / `]` jump between user requests and final answers.<br>
深链接浏览器 URL 会保留当前 scope、搜索词、选中会话和阅读选项。会话内容会按可折叠的对话轮次组织，`[` / `]` 可在用户请求与助手最终回答之间跳转。

Structured image attachments and skill payloads render as readable cards instead of raw protocol text.<br>
结构化图片附件与技能负载会以可读卡片形式展示，而不是原始协议文本。

## Commands / 命令

- `Codex Session Renderer: Open Session Browser`
- `Codex Session Renderer: Open Latest Preview`
- `Codex Session Renderer: Copy Browser URL`
- `Codex Session Renderer: Run Developer Self-Check` (hidden unless `codexSessionRenderer.showDeveloperCommands` is enabled)

The browser service started by the extension stops automatically after the last browser window or tab is closed.<br>
扩展启动的浏览器服务会在最后一个浏览器窗口或标签页关闭后自动停止。

## Settings / 设置

- `codexSessionRenderer.host`
- `codexSessionRenderer.port`
- `codexSessionRenderer.openMode`
- `codexSessionRenderer.sessionsDir`
- `codexSessionRenderer.archivedSessionsDir`
- `codexSessionRenderer.showDeveloperCommands`

When Codex uses the default directories, no extra setup is required.<br>
使用默认目录时，一般不需要额外配置。

- `~/.codex/sessions`
- `~/.codex/archived_sessions`

## Highlights / 特性

- Full browser view instead of a cramped sidebar.<br>
  使用完整浏览器视图，而不是局促的侧边栏。
- Deep-linked session state that can be reopened directly.<br>
  会话状态支持深链接，可直接重新打开。
- Conversation rounds with keyboard jump navigation.<br>
  支持对话轮次分组与键盘跳转导航。
- Inline rename from the session list.<br>
  支持在会话列表中原地改名。
- Works well with local VS Code, Remote SSH, and WSL.<br>
  适用于本地 VS Code、Remote SSH 和 WSL。
