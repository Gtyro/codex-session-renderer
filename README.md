# Codex Session Renderer

[中文说明](./README.zh-CN.md)

This project reads Codex session files from `~/.codex/sessions` and `~/.codex/archived_sessions`, lets you browse and manage them through a built-in web UI, and can also export readable markdown, HTML, and optional PNG snapshots from the CLI.

By default it only renders the most recent conversation round, where one round means everything from one user message up to the next user message.

## Requirements

- Node.js 18+

Playwright Chromium is only required when you explicitly want PNG exports. The web UI and markdown/html rendering work without it.

The renderer can use a pinned official `Source Han Sans SC` download for Simplified Chinese text rendering, so it does not depend on system-installed Chinese fonts after the font assets are installed once.
By default the downloaded font files are stored in a per-user data directory instead of inside the package tree.
On Linux that means `~/.local/share/codex-session-renderer/fonts` unless `XDG_DATA_HOME` is set.
If you skip font installation, the HTML preview falls back to system fonts instead of failing.

## Setup

```bash
npm install
```

Optional setup for consistent Chinese rendering:

```bash
npm run install:fonts
```

Optional setup for PNG export:

```bash
npm run install:browser
```

## Global CLI

Install the CLI globally from GitHub:

```bash
npm install -g git+https://github.com/Gtyro/codex-session-renderer.git#main
```

After installation, both of these commands work from any directory:

```bash
codex-session-renderer --latest
csr --latest
```

`csr` is the short alias for day-to-day use.

Download the pinned Chinese font assets into the global install:

```bash
csr --install-fonts
```

This downloads fonts into your user data directory, so it stays writable even when the package itself was installed under a root-owned global `node_modules`.

If this machine does not already have a Playwright Chromium install, run:

```bash
npx playwright install chromium
```

To remove the global install later:

```bash
npm uninstall -g codex-session-renderer
```

For local development from a checkout, you can still use `npm link` in the repo root if you want global commands to point at your working tree directly.

## Usage

Start the built-in web UI:

```bash
npm run web
```

By default the web UI listens on `http://127.0.0.1:4311/`.

Or through the global CLI:

```bash
csr --serve
```

The web UI reads both `sessions` and `archived_sessions`, prefers `~/.codex/session_index.jsonl` `thread_name` for session titles and falls back to the Codex state database when needed, lets you rename titles inline from the sidebar, archive active sessions, restore archived sessions, and permanently delete archived sessions.
Double-click a sidebar title to edit it in place, or use the `Rename` action to enter the same inline editing mode.
When you archive or restore the currently selected session, the UI now stays on the current scope and keeps your browsing context instead of jumping to the other tab automatically.

Render the latest session:

```bash
npm run render -- --latest
```

Install the pinned Chinese font assets for a local checkout:

```bash
npm run install:fonts
```

The CLI can also install fonts directly:

```bash
csr --install-fonts
codex-session-renderer --install-fonts
```

Render the latest 3 rounds instead of only the latest one:

```bash
npm run render -- --latest --rounds 3
```

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

Use a custom archived sessions directory for the web UI:

```bash
npm run web -- --sessions-dir /path/to/sessions --archived-sessions-dir /path/to/archived_sessions
```

Render and clear the output directory first:

```bash
npm run render -- --latest --clean-output
```

Render markdown/html plus final PNG images:

```bash
npm run render -- --latest --png
```

Render only final PNG images:

```bash
npm run render -- --latest --png-only
```

Include normally hidden scaffolding:

```bash
npm run render -- --latest --include-context --include-developer --include-reasoning
```

The same options work through the global commands:

```bash
csr --latest --rounds 3
csr --id 019cea6d-7660-7c51-ade7-510d2bdf3caa --all
csr --serve
```

Skip PNG export and keep only markdown/html outputs:

```bash
npm run render -- --latest --no-images
```

`--no-images` is now only a compatibility flag because PNG export is skipped by default.

If Playwright Chromium is missing, PNG rendering exits with a message telling you to run `npm run install:browser`. The web UI and the default markdown/html path continue to work.

## VS Code Extension

This repository can also be packaged as a VS Code extension. The extension is browser-first: it starts the local session browser server and opens the full UI in your external browser instead of forcing the experience into a sidebar.

The first extension version contributes these commands:

- `Codex Session Renderer: Open Session Browser`
- `Codex Session Renderer: Open Latest Preview`
- `Codex Session Renderer: Copy Browser URL`
- `Codex Session Renderer: Stop Session Browser`

The extension manifest lives in the repo root `package.json`, the extension entrypoint is `vscode/extension.cjs`, and the Marketplace page uses the dedicated `vscode/README.md` and `vscode/CHANGELOG.md` instead of the project root docs.
When running through Remote SSH, WSL, or another remote extension host, the extension asks VS Code to translate the local server URL into a client-accessible external URL before opening or copying it.

To package a `.vsix` from this repo root:

```bash
npm run package:vsix
```

The resulting `.vsix` can be uploaded through the Marketplace web UI.

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

## Output

Each run writes these files into the output directory:

- `<session-id>.md` for the full archive transcript
- `<session-id>.compact.md` for the shareable compact transcript
- `<session-id>.compact.html` for the selected transcript as a whole
- `<session-id>.round-01.compact.html`, `<session-id>.round-02.compact.html`, ... for per-round image rendering
- `<session-id>.round-01.compact.png`, `<session-id>.round-02.compact.png`, ... by default one image per round
- If a single round is still too tall, that round falls back to paged images such as `<session-id>.round-01.compact-01.png`

With `--png-only`, the renderer removes markdown and html artifacts for the current session and leaves only the final PNG files.

By default, the renderer skips PNG generation so you do not need a Playwright Chromium install.

With `--png`, the renderer keeps the markdown/html artifacts and also generates PNG outputs.

With `--clean-output`, the renderer clears the target output directory before writing new files.

By default the renderer keeps user messages, assistant messages, tool calls, and tool outputs for only the most recent conversation round. Developer prompts, internal reasoning, and injected session context are hidden unless you opt in.

The compact outputs hide empty polling calls, fold progress-heavy logs, and truncate long tool sections so the PNG output stays readable.
