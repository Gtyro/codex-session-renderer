#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const majorNodeVersion = Number.parseInt(process.versions.node.split(".")[0], 10);
const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";

if (!Number.isFinite(majorNodeVersion) || majorNodeVersion < 20 || typeof File === "undefined") {
  const result = spawnSync(npxCommand, ["-y", "node@20", __filename], {
    cwd: path.resolve(__dirname, ".."),
    stdio: "inherit"
  });

  process.exit(result.status ?? 1);
}

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
