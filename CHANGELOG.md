# Changelog

## Unreleased

- Fixed VSIX packaging after an over-aggressive exclude removed `src/core/font-assets.js` from the extension runtime.
- Changed CLI defaults so PNG export is now opt-in via `--png` or `--png-only`.
- Deprecated `--only-images` in favor of `--png-only`.
- Deprecated `--no-images` because PNG export is skipped by default.
- Added session renaming support in the browser UI by updating `session_index.jsonl` `thread_name` instead of renaming the session file.
- Added inline sidebar renaming so double-click edits the title in place.
- Kept the browser UI on the current scope after archive or restore operations so it preserves browsing context instead of jumping across tabs.
- Added a browser-first VS Code extension entrypoint that starts the local session browser and opens it externally.
- Added a dedicated Marketplace README and flattened the VS Code extension entry path to `vscode/extension.cjs`.
- Added a developer-only VS Code self-check command for non-destructive browser/server regression checks, including remote URL translation.
- Fixed the self-check preview HTML detection to accept the renderer's lowercase `<!doctype html>` output and tightened external URL comparison.
- Removed redundant explicit activation events, moved the extension README into `vscode/`, and made the Marketplace README bilingual.
- Moved the extension Marketplace changelog into `vscode/` and pointed VSIX packaging at the dedicated extension docs.

## Planned Removals

- `--only-images` is planned for removal in `0.2.0`.
- `--no-images` is planned for removal in `0.2.0`.
