#!/usr/bin/env node

const path = require("node:path");

const runVsce = require(path.resolve(__dirname, "..", "node_modules", "@vscode", "vsce", "out", "main"));

runVsce([
  "node",
  "vsce",
  "package",
  "--readme-path",
  "vscode/README.md",
  "--changelog-path",
  "vscode/CHANGELOG.md"
]);
