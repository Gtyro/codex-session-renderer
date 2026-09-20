# Codex Session Renderer

[中文说明](./README.zh-CN.md)

Browser-first session browser and export tool for Codex histories.

It reads session files from `~/.codex/sessions` and `~/.codex/archived_sessions`, gives you a built-in browser UI for browsing and management, and can export compact/full Markdown, HTML, and optional PNG snapshots. The same browser UI can also be launched from the VS Code extension.

## Highlights

- Browse active and archived sessions in a full browser UI.
- Filter sessions by their recorded workspace (`cwd`), with a separate fallback choice for older logs that lack one.
- Rename titles inline, archive or restore sessions, and permanently delete archived sessions.
- Keep deep-linked URLs that preserve scope, search, selected session, and reader options.
- Group transcript activity into conversation rounds, collapse process-heavy sections, and jump with `[` / `]`.
- Connect Goals, delegated subtasks, `task_started` lifecycle events, tool calls, and detected verification results; linked evidence jumps back to the original transcript.
- Render structured image attachments, attached-file callouts, and skill payloads as readable cards instead of raw protocol text.
- Build local, redacted optimization evidence and live campaign traces: worker/reviewer activity, instruction revisions, validation, token/time metrics, and safe instruction-asset patch history.
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

## Make Targets

For local repository work, the repo root also provides a small `make` facade:

```bash
make deps
make dev
make stop
make test
make build
```

Semantics:

- `make dev`
  - standalone browser UI for local development/debugging
- `make stop`
  - best-effort stop for the standalone `make dev` server only
- `make test`
  - Node test suite
- `make build`
  - package the VS Code extension as a `.vsix`

The day-to-day primary user flow still remains the VS Code host command:

- `Codex Session Renderer: Open Session Browser`

## Browser UI

Start the built-in browser:

```bash
npm run web
```

Use custom active and archived session directories:

```bash
npm run web -- --sessions-dir /path/to/sessions --archived-sessions-dir /path/to/archived_sessions
```

The browser prefers `thread_name` from `~/.codex/session_index.jsonl` for session titles and falls back to the Codex state database when needed. Use the sidebar workspace selector to filter by the `cwd` recorded in each session's metadata. Recorded workspaces are ordered by their most recently updated session, while **Unrecorded workspace** stays last; **All workspaces** stays first. Double-click an active session title to rename it inline, or double-click an archived session to delete it and use the non-blocking **Undo** prompt if needed. The toolbar can also archive, restore, or delete sessions, and deep-linked URLs reopen the same view later.

## CLI Export

The browser UI is the primary experience. The CLI is for exporting snapshots and shareable artifacts.

## Optimization analysis

Open a session in the browser and use **Copy full analysis pack**. The browser derives a local evidence summary plus an expandable task trace from persisted session events, then places a redacted prompt on the clipboard for a Codex review. Each trace entry can jump back to the original transcript.

The report distinguishes recorded facts from hypotheses and does not claim exact per-skill or per-document token attribution. It never changes `AGENTS.md`, skills, READMEs, or other documentation; any recommended changes remain proposals to review and validate against repeated task cases.

Use **Run Codex analysis** only when you want the local server to start a separate Codex CLI review. The browser asks for confirmation, runs `codex exec` with `--sandbox read-only --ephemeral`, and displays only its redacted final report. It does not apply that report or write to the analyzed workspace.

## Agent Workflow Optimizer

Install `$agent-workflow-optimizer` into your Codex Skills directory, then use natural-language requests such as:

```text
$agent-workflow-optimizer Review today's mygog add-game work and optimize the relevant instructions.
$agent-workflow-optimizer Use $mygog-add-game to add Braid, 忍道焰, and Sea Watchers; improve the workflow while processing the list.
```

For a selected browser session, **Hand to optimizer Skill** only copies the corresponding foreground request. Paste it into the current Codex conversation; the browser never launches a hidden Codex task.

Repeated-task requests create a local campaign under `~/.codex-session-renderer/campaigns`. Every campaign worker starts through `csr campaign run`: CSR owns a persistent `codex exec --json` process, records its stable thread and structured token/time events, and streams them into the campaign panel. A successful process becomes **awaiting validation**, not a passed task; explicit acceptance evidence is required before `csr campaign validate --from-run ...` records the outcome. Reviewers run separately in an empty read-only checkpoint sandbox and receive only the coordinator's compact checkpoint, not a workspace, registered assets, raw sessions, or tool-discovery work. Native delegated agents are excluded from campaigns because the current Codex runtime cannot independently attribute their token or elapsed-time cost. Unknown or shared-write tasks run serially; proven-independent tasks may run in parallel waves with one fixed instruction revision.

Historical or externally created workers can still be measured from an explicitly selected persisted session through `csr campaign measure`; neither the user nor the agent reads raw JSONL directly. The App Server bridge is optional enrichment, not a campaign dependency. A missing token count is displayed as unknown, never as zero, and cannot satisfy the token-saving requirement for a durable patch.

An overlay can improve the next task immediately. A durable `SKILL.md`, `README*.md`, or `docs/*.md` patch is applied only after two successful paired cases in one cohort show lower worker token cost. Each pair must be actual CSR worker runs with explicit acceptance validation, the same model/command/arguments/sandbox/prompt, and separate clean workspace copies of one snapshot; tokens and provenance are read from the recorded runs, never hand-entered. Historical sessions can select cases but cannot serve as the CSR baseline. Worker tokens are the promotion metric; elapsed time is displayed as a regression warning, while reviewer token/time is separate overhead. `AGENTS.md` is never auto-edited, automatic changes are not committed, merge conflicts are left untouched, and `csr campaign rollback` only reverses an unchanged applied patch. Completed ledgers can be retained without clutter through `csr campaign archive --run <id>` and recovered with `csr campaign restore --run <id>`.

For an agent-created disposable worktree, create the campaign with `--disposable-workspace`. CSR accepts this only for an existing, non-symlink directory beneath the system temporary directory. Its resolved path and filesystem identity are recorded; `csr campaign archive --run <id>` then removes that exact workspace before moving the ledger to the recoverable archive. Every other campaign workspace is retained, and a missing disposable workspace is recorded rather than treated as an error.

For a per-run isolated worktree, pass both `--execution-cwd /tmp/<case>` and `--disposable-execution-cwd` to a worker run. CSR verifies the same boundary and removes that exact worktree after the run has recorded its final measurement; cleanup is retained as a campaign event.

`csr sessions search`, `csr sessions pick`, and `csr session evidence` are the Skill's session data-plane commands. They support natural-language resolution and an arrow-key picker, and intentionally do not default to global `latest`.

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
