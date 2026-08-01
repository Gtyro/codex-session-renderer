# Codex Session Renderer

[中文说明](./README.zh-CN.md)

Browser-first session browser and export tool for Codex histories.

It reads session files from `~/.codex/sessions` and `~/.codex/archived_sessions`, gives you a built-in browser UI for browsing and management, and can export compact/full Markdown, HTML, and optional PNG snapshots. The same browser UI can also be launched from the VS Code extension.

## Highlights

- Browse active and archived sessions in a full browser UI.
- Rename titles inline, archive or restore sessions, and permanently delete archived sessions.
- Keep deep-linked URLs that preserve scope, search, selected session, and reader options.
- Group transcript activity into conversation rounds, collapse process-heavy sections, and jump with `[` / `]`.
- Connect Goals, delegated subtasks, `task_started` lifecycle events, tool calls, and detected verification results; linked evidence jumps back to the original transcript.
- Render structured image attachments, attached-file callouts, and skill payloads as readable cards instead of raw protocol text.
- Export the current view as compact/full Markdown, HTML, and optional PNG.

## Requirements

- Node.js 18+

When Codex uses its default directories, no extra configuration is required.

## Quick Start

```bash
npm install
npm run web
```

Open `http://127.0.0.1:4311/`.
If `4311` is already busy, the server falls back to a random free port and prints the final URL in the terminal.

By default the browser reads:

- `~/.codex/sessions`
- `~/.codex/archived_sessions`

## Browser UI

Start the built-in browser:

```bash
npm run web
```

Use custom active and archived session directories:

```bash
npm run web -- --sessions-dir /path/to/sessions --archived-sessions-dir /path/to/archived_sessions
```

The browser prefers `thread_name` from `~/.codex/session_index.jsonl` for session titles and falls back to the Codex state database when needed. You can double-click a title to rename it inline, use the toolbar actions to archive, restore, or delete sessions, and reopen the same view later through its deep-linked URL.

## CLI Export

The browser UI is the primary experience. The CLI is for exporting snapshots and shareable artifacts.

Render the latest session:

```bash
npm run render -- --latest
```

Render the latest 3 rounds:

```bash
npm run render -- --latest --rounds 3
```

Use `--rounds` or `--all` when you want more than the default latest-round view.

Render a session by ID:

```bash
npm run render -- --id 019cea6d-7660-7c51-ade7-510d2bdf3caa
```

Render the whole session:

```bash
npm run render -- --id 019cea6d-7660-7c51-ade7-510d2bdf3caa --all
```

Use a custom sessions directory or output directory:

```bash
npm run render -- --id 019cea6d-7660-7c51-ade7-510d2bdf3caa --sessions-dir /path/to/sessions --output-dir ./artifacts
```

Clear the output directory before rendering:

```bash
npm run render -- --latest --clean-output
```

Also generate PNG images:

```bash
npm run render -- --latest --png
```

Keep only final PNG images:

```bash
npm run render -- --latest --png-only
```

Include normally hidden context, developer messages, and reasoning summaries:

```bash
npm run render -- --latest --include-context --include-developer --include-reasoning
```

`--no-images` still exists as a compatibility flag, but PNG export is skipped by default.

## Optional Global CLI

Install the CLI globally from GitHub:

```bash
npm install -g git+https://github.com/Gtyro/codex-session-renderer.git#main
```

After installation, both command names work from any directory:

```bash
csr --serve
csr --latest --rounds 3
codex-session-renderer --id 019cea6d-7660-7c51-ade7-510d2bdf3caa --all
```

`csr` is the short alias for day-to-day use.

## VS Code Extension

This repository can also be packaged as a VS Code extension. The extension starts the local session browser server and opens the full UI in an external browser instead of forcing the experience into a sidebar.

The extension contributes these commands:

- `Codex Session Renderer: Open Session Browser`
- `Codex Session Renderer: Open Latest Preview`
- `Codex Session Renderer: Copy Browser URL`
- `Codex Session Renderer: Run Developer Self-Check` (hidden unless `codexSessionRenderer.showDeveloperCommands` is enabled)

The extension manifest lives in the repo root `package.json`, the extension entrypoint is `vscode/extension.cjs`, and the Marketplace page uses the dedicated `vscode/README.md` and `vscode/CHANGELOG.md` instead of the project root docs.
The browser view opened by the extension keeps the same deep-linked URL state, conversation-round grouping, and transcript jump navigation as the standalone web UI.
The browser service started by the extension stops automatically after the last browser window or tab is closed.
When running through Remote SSH, WSL, or another remote extension host, the extension asks VS Code to translate the local server URL into a client-accessible external URL before opening or copying it.

To package a `.vsix` from this repo root:

```bash
npm run package:vsix
```

## Optional Assets

Install pinned Simplified Chinese font assets for consistent rendering:

```bash
npm run install:fonts
```

The CLI can install the same font assets directly:

```bash
csr --install-fonts
codex-session-renderer --install-fonts
```

The renderer uses a pinned official `Source Han Sans SC` download. Font files are stored in a per-user data directory instead of inside the package tree. On Linux that means `~/.local/share/codex-session-renderer/fonts` unless `XDG_DATA_HOME` is set. Without installed font assets, the HTML preview falls back to system fonts instead of failing.

Install Playwright Chromium only when you want PNG export:

```bash
npm run install:browser
```

The browser UI and the default markdown/html export path do not need Chromium. If Chromium is missing, PNG export exits with a message that points to `npm run install:browser`.

## Output

In the default markdown/html modes, each run writes these files into the output directory:

- `<session-id>.md` for the full archive transcript
- `<session-id>.compact.md` for the shareable compact transcript
- `<session-id>.compact.html` for the selected transcript as a whole
- `<session-id>.round-01.compact.html`, `<session-id>.round-02.compact.html`, ... for per-round image rendering

When `--png` or `--png-only` is enabled, the renderer additionally writes:

- `<session-id>.round-01.compact.png`, `<session-id>.round-02.compact.png`, ... typically one image per round
- If a single round is still too tall, that round falls back to paged images such as `<session-id>.round-01.compact-01.png`

With `--png-only`, the renderer skips the top-level markdown/html artifacts and removes the temporary per-round HTML after PNG export, leaving only the final PNG files.

By default the renderer keeps user messages, assistant messages, tool calls, and tool outputs for only the most recent conversation round. Developer prompts, internal reasoning, and injected session context stay hidden unless explicitly enabled.

Structured image attachments, attached-file callouts, and skill payloads are normalized in both markdown and interactive HTML so transcripts stay readable.

The compact outputs hide empty polling calls, fold progress-heavy logs, and truncate long tool sections so the PNG output stays readable.

## Shell Completion

The CLI can print completion scripts for `bash`, `zsh`, or `fish`:

```bash
csr --print-completion bash
csr --print-completion zsh
csr --print-completion fish
```

Quick setup examples:

```bash
echo 'eval "$(csr --print-completion bash)"' >> ~/.bashrc
echo 'eval "$(csr --print-completion zsh)"' >> ~/.zshrc
echo 'source (csr --print-completion fish | psub)' >> ~/.config/fish/config.fish
```

The generated script registers completion for both `csr` and `codex-session-renderer`.
