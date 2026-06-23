# Changelog

## 0.1.8

- Switched session titles and renaming to metadata-backed titles instead of renaming session files, preferring `session_index.jsonl` and falling back to the Codex state database.
- Added inline sidebar renaming so double-click edits the title in place.

## 0.1.7

- Fixed VSIX packaging so the extension runtime includes `src/core/font-assets.js` again.

## 0.1.6

- Added session rename support in the browser UI.
- Stopped switching tabs automatically after archive or restore actions so the current browsing context is preserved.

## 0.1.5

- Moved the Marketplace changelog into `vscode/` so extension-facing docs are grouped more cleanly.
- Continued using dedicated extension docs instead of the project root README.

## 0.1.4

- Removed redundant explicit activation events.
- Made the Marketplace README bilingual.

## 0.1.3

- Hid the developer self-check command by default behind `codexSessionRenderer.showDeveloperCommands`.

## 0.1.2

- Fixed self-check preview HTML detection for lowercase `<!doctype html>`.
- Tightened external URL comparison in the self-check report.

## 0.1.1

- Added the non-destructive developer self-check command.

## 中文说明

### 0.1.8

- 将会话标题与改名逻辑切换为元数据驱动，不再改动会话文件名；标题优先读取 `session_index.jsonl`，缺失时回退到 Codex 状态数据库。
- 侧边栏新增原地改名，双击即可直接编辑标题。

### 0.1.7

- 修复 VSIX 打包遗漏 `src/core/font-assets.js`，避免扩展启动时报模块缺失。

### 0.1.6

- 浏览器界面新增会话改名能力。
- 归档或恢复后不再自动切换标签页，尽量保留当前浏览上下文。

### 0.1.5

- 将 Marketplace 使用的 changelog 移到 `vscode/` 目录下，让扩展相关文档更集中。
- 继续保持扩展说明与项目根 README 分离。

### 0.1.4

- 删除了冗余的显式 `activationEvents`。
- 将 Marketplace README 整理为中英双语。

### 0.1.3

- 默认隐藏开发者自检命令，只有开启 `codexSessionRenderer.showDeveloperCommands` 后才显示。

### 0.1.2

- 修复自检对小写 `<!doctype html>` 的预览 HTML 误判。
- 收紧自检中的 external URL 比较逻辑。

### 0.1.1

- 增加了非破坏性的开发者自检命令。
