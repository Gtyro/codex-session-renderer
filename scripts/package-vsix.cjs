#!/usr/bin/env node

const { exec, spawn } = require("node:child_process");
const { closeSync, mkdtempSync, openSync, readFile, rm } = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const npmListCommand = "npm list --production --parseable --depth=99999 --loglevel=error";
const originalExec = exec;

// npm 10 on this host suppresses `npm list` output when VSCE captures it through
// a pipe. A file descriptor preserves that output without changing VSCE's
// dependency selection or including development dependencies.
require("node:child_process").exec = (command, options, callback) => {
  if (command !== npmListCommand) {
    return originalExec(command, options, callback);
  }

  const outputDir = mkdtempSync(path.join(os.tmpdir(), "csr-vsce-npm-"));
  const outputPath = path.join(outputDir, "dependencies.txt");
  const outputFd = openSync(outputPath, "w");
  const child = spawn(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["list", "--production", "--parseable", "--depth=99999", "--loglevel=error"],
    {
      cwd: options?.cwd,
      env: options?.env,
      stdio: ["ignore", outputFd, outputFd]
    }
  );

  closeSync(outputFd);
  child.once("error", finish);
  child.once("close", (code, signal) => {
    const error = code === 0 ? null : Object.assign(new Error(`npm list exited with code ${code}.`), { code, signal });
    finish(error);
  });

  function finish(error) {
    readFile(outputPath, "utf8", (readError, output = "") => {
      rm(outputDir, { recursive: true, force: true }, () => {
        callback(error || readError || null, output, error ? output : "");
      });
    });
  }

  return child;
};

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
