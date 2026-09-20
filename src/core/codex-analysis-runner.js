import { spawn as spawnChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { redactSensitiveText } from "./optimization-analysis.js";

const ANALYSIS_TIMEOUT_MS = 5 * 60 * 1_000;
const MAX_STDERR_CHARS = 4_000;
const MAX_RESULT_CHARS = 80_000;

function truncate(value, maxLength) {
  const text = String(value ?? "").trim();
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}

export function createReadOnlyAnalysisArgs(outputPath, cwd) {
  return [
    "exec",
    "--sandbox",
    "read-only",
    "--ephemeral",
    "--output-last-message",
    outputPath,
    "--cd",
    cwd,
    "-"
  ];
}

async function ensureWorkingDirectory(cwd) {
  if (!cwd || typeof cwd !== "string") {
    throw new Error("此会话没有记录工作目录，无法安全启动本地 Codex 分析。请使用复制完整分析包。");
  }

  let details;

  try {
    details = await stat(cwd);
  } catch {
    throw new Error("会话记录的工作目录已不存在，无法安全启动本地 Codex 分析。请使用复制完整分析包。");
  }

  if (!details.isDirectory()) {
    throw new Error("会话记录的工作目录不是目录，无法安全启动本地 Codex 分析。请使用复制完整分析包。");
  }
}

function executeCodex(prompt, cwd, outputPath, options = {}) {
  const spawn = options.spawn || spawnChildProcess;
  const timeoutMs = options.timeoutMs ?? ANALYSIS_TIMEOUT_MS;
  const args = createReadOnlyAnalysisArgs(outputPath, cwd);

  return new Promise((resolve, reject) => {
    let stderr = "";
    let timedOut = false;
    const child = spawn("codex", args, {
      cwd,
      stdio: ["pipe", "ignore", "pipe"]
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stderr.on("data", (chunk) => {
      stderr = truncate(`${stderr}${String(chunk)}`, MAX_STDERR_CHARS);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);

      if (timedOut) {
        reject(new Error("Codex 分析在 5 分钟内未完成，已停止。请缩小会话范围或使用复制完整分析包。"));
        return;
      }

      if (exitCode !== 0) {
        const detail = redactSensitiveText(stderr);
        reject(new Error(`Codex 分析未完成（退出码 ${exitCode ?? "unknown"}）。${detail ? ` ${detail}` : ""}`));
        return;
      }

      resolve();
    });
    child.stdin.end(prompt);
  });
}

/**
 * Runs a user-requested, report-only Codex review. The child is ephemeral and
 * read-only; this function intentionally never grants write access or applies
 * its result to the workspace.
 */
export async function runReadOnlyCodexAnalysis({ cwd, prompt, options = {} }) {
  await ensureWorkingDirectory(cwd);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-session-renderer-analysis-"));
  const outputPath = path.join(tempDir, "final-message.txt");

  try {
    await executeCodex(prompt, cwd, outputPath, options);
    const result = await readFile(outputPath, "utf8");
    const redacted = truncate(redactSensitiveText(result), MAX_RESULT_CHARS);

    if (!redacted) {
      throw new Error("Codex 未返回可展示的分析结果。请使用复制完整分析包。" );
    }

    return redacted;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
