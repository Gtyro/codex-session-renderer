# Codex Session Renderer

Browser-first session browsing for Codex histories in VS Code.  
面向 Codex 会话历史的浏览器优先 VS Code 扩展。

Open your Codex sessions in a full browser window from VS Code.  
从 VS Code 直接在完整浏览器窗口中打开 Codex 会话。

Use it to browse active and archived sessions, rename titles inline, archive or restore sessions, delete archived sessions, and open the latest preview without leaving VS Code.  
你可以用它浏览活动会话和归档会话、原地修改标题、归档或恢复会话、删除归档会话，并快速打开最新预览。

## Commands / 命令

- `Codex Session Renderer: Open Session Browser`
- `Codex Session Renderer: Open Latest Preview`
- `Codex Session Renderer: Copy Browser URL`
- `Codex Session Renderer: Stop Session Browser`

## Settings / 设置

- `codexSessionRenderer.host`
- `codexSessionRenderer.port`
- `codexSessionRenderer.sessionsDir`
- `codexSessionRenderer.archivedSessionsDir`
- `codexSessionRenderer.showDeveloperCommands`

If you already use Codex with its default directories, no extra setup is required.  
如果你已经在使用默认目录下的 Codex，一般不需要额外配置。

- `~/.codex/sessions`
- `~/.codex/archived_sessions`

## Highlights / 特性

- Full browser view instead of a cramped sidebar.  
  使用完整浏览器视图，而不是局促的侧边栏。
- Inline rename from the session list.  
  支持在会话列表中原地改名。
- Works well with local VS Code, Remote SSH, and WSL.  
  适用于本地 VS Code、Remote SSH 和 WSL。

Full project documentation / 完整项目文档：  
https://github.com/Gtyro/codex-session-renderer
