# Codex Session Renderer

This project reads session files from `~/.codex/sessions`, finds a session by ID or picks the latest one, exports the readable transcript to markdown, and renders a PNG snapshot from the markdown.

By default it only renders the most recent conversation round, where one round means everything from one user message up to the next user message.

## Requirements

- Node.js 18+
- A Playwright Chromium browser install

## Setup

```bash
npm install
npm run install:browser
```

## Usage

Render the latest session:

```bash
npm run render -- --latest
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

Render and clear the output directory first:

```bash
npm run render -- --latest --clean-output
```

Render only final PNG images:

```bash
npm run render -- --latest --only-images
```

Include normally hidden scaffolding:

```bash
npm run render -- --latest --include-context --include-developer --include-reasoning
```

## Output

Each run writes these files into the output directory:

- `<session-id>.md` for the full archive transcript
- `<session-id>.compact.md` for the shareable compact transcript
- `<session-id>.compact.html` for the selected transcript as a whole
- `<session-id>.round-01.compact.html`, `<session-id>.round-02.compact.html`, ... for per-round image rendering
- `<session-id>.round-01.compact.png`, `<session-id>.round-02.compact.png`, ... by default one image per round
- If a single round is still too tall, that round falls back to paged images such as `<session-id>.round-01.compact-01.png`

With `--only-images`, the renderer removes markdown and html artifacts for the current session and leaves only the final PNG files.

With `--clean-output`, the renderer clears the target output directory before writing new files.

By default the renderer keeps user messages, assistant messages, tool calls, and tool outputs for only the most recent conversation round. Developer prompts, internal reasoning, and injected session context are hidden unless you opt in.

The compact outputs hide empty polling calls, fold progress-heavy logs, and truncate long tool sections so the PNG output stays readable.
