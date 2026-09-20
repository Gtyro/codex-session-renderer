import { execFile as execFileCallback, spawn as spawnChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";
import {
  appendCampaignEvent,
  completeCampaignRun,
  readCampaign,
  recordCampaignRunThread,
  startCampaignRun
} from "./campaign-store.js";
import { redactSensitiveText } from "./optimization-analysis.js";

const MAX_EVENT_TEXT_CHARS = 4_000;
const MAX_REVIEW_CHECKPOINT_CHARS = 6_000;
const RUNNER_DEFAULT_MODEL = "codex-default";
const execFile = promisify(execFileCallback);

function compactText(value, maxLength = MAX_EVENT_TEXT_CHARS) {
  const text = redactSensitiveText(String(value ?? "")).trim();
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}

function hashCoordinatorPrompt(prompt) {
  return createHash("sha256").update(compactText(prompt, 12_000), "utf8").digest("hex");
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function registerDisposableExecutionWorkspace(workspacePath) {
  const temporaryRoot = await realpath(os.tmpdir());
  const resolvedWorkspace = await realpath(workspacePath).catch((error) => {
    if (error?.code === "ENOENT") {
      throw new Error("A disposable execution workspace must already exist.");
    }
    throw error;
  });
  const entry = await lstat(resolvedWorkspace);

  if (
    !entry.isDirectory() ||
    entry.isSymbolicLink() ||
    resolvedWorkspace === temporaryRoot ||
    !isWithin(temporaryRoot, resolvedWorkspace)
  ) {
    throw new Error("A disposable execution workspace must be a non-symlink directory beneath the system temporary directory.");
  }

  return {
    path: workspacePath,
    realpath: resolvedWorkspace,
    device: entry.dev,
    inode: entry.ino
  };
}

async function disposeExecutionWorkspace(workspace) {
  const temporaryRoot = await realpath(os.tmpdir());
  const resolvedWorkspace = await realpath(workspace.path).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });

  if (!resolvedWorkspace) {
    return { status: "missing", path: workspace.path };
  }
  if (
    resolvedWorkspace !== workspace.realpath ||
    resolvedWorkspace === temporaryRoot ||
    !isWithin(temporaryRoot, resolvedWorkspace)
  ) {
    throw new Error("Disposable execution workspace path no longer matches its registered temporary directory.");
  }

  const entry = await lstat(resolvedWorkspace);
  if (
    !entry.isDirectory() ||
    entry.isSymbolicLink() ||
    entry.dev !== workspace.device ||
    entry.ino !== workspace.inode
  ) {
    throw new Error("Disposable execution workspace identity changed after registration.");
  }

  await rm(resolvedWorkspace, { recursive: true, force: false });
  return { status: "disposed", path: workspace.path, resolvedPath: resolvedWorkspace };
}

function pick(object, ...keys) {
  for (const key of keys) {
    if (object && Object.hasOwn(object, key) && object[key] !== null && object[key] !== undefined) {
      return object[key];
    }
  }
  return null;
}

function extractThreadId(event) {
  return pick(
    event,
    "thread_id",
    "threadId"
  ) || pick(event?.thread, "id", "thread_id") || pick(event?.data, "thread_id", "threadId") || null;
}

function extractTurnId(event) {
  return pick(event, "turn_id", "turnId") || pick(event?.turn, "id", "turn_id") || pick(event?.data, "turn_id", "turnId") || null;
}

function extractCommand(item, event) {
  const value = pick(item, "command", "cmd", "command_line", "commandLine")
    || pick(event, "command", "cmd", "command_line", "commandLine");
  if (Array.isArray(value)) {
    return compactText(value.join(" "));
  }
  return value ? compactText(value) : null;
}

/**
 * Codex `exec --json` currently emits machine-readable events. Keep this
 * adapter deliberately tolerant of harmless shape changes while recording
 * only the small, redacted subset the campaign UI and ledger need.
 */
export function normalizeCodexExecEvent(event) {
  const type = String(pick(event, "type", "event") || pick(event?.data, "type") || "unknown");
  const usage = event?.usage || event?.token_usage || event?.tokenUsage || event?.turn?.usage || null;
  const item = event?.item || event?.data?.item || null;
  const message = pick(event, "message", "text") || pick(item, "text", "message") || null;

  return {
    type,
    threadId: extractThreadId(event),
    turnId: extractTurnId(event),
        item: item && typeof item === "object"
          ? {
              id: pick(item, "id", "item_id"),
              type: pick(item, "type"),
              status: pick(item, "status"),
              command: extractCommand(item, event)
            }
          : null,
    usage: usage && typeof usage === "object" ? usage : null,
    message: message ? compactText(message) : null
  };
}

/**
 * Extract the complete-turn token total. Cached input is intentionally not
 * added a second time: when input_tokens is supplied it already represents
 * the prompt input and cached_input_tokens is its breakdown.
 */
export function extractCodexExecTokens(event) {
  const normalized = normalizeCodexExecEvent(event);
  const usage = normalized.usage;
  if (!usage) {
    return null;
  }

  const total = positiveNumber(pick(usage, "total_tokens", "totalTokens"));
  if (total !== null) {
    return total;
  }

  const input = positiveNumber(pick(usage, "input_tokens", "inputTokens", "prompt_tokens", "promptTokens")) || 0;
  const output = positiveNumber(pick(usage, "output_tokens", "outputTokens", "completion_tokens", "completionTokens")) || 0;
  return input + output > 0 ? input + output : null;
}

export function createCampaignRunArgs({ cwd, sandbox, model = null, promptFromStdin = true }) {
  return [
    "exec",
    "--json",
    ...(model ? ["--model", model] : []),
    "--sandbox",
    sandbox,
    "--cd",
    cwd,
    "--skip-git-repo-check",
    ...(promptFromStdin ? ["-"] : [])
  ];
}

function currentRevision(manifest) {
  return manifest.revisions?.at(-1) || { number: 1, overlay: "" };
}

function taskForRun(manifest, role, taskId) {
  if (role !== "worker") {
    return null;
  }
  const task = manifest.tasks?.find((entry) => entry.id === taskId);
  if (!task) {
    throw new Error(`Task "${taskId}" is not registered in campaign ${manifest.id}.`);
  }
  return task;
}

function assetBlock(manifest, assetRoot = null) {
  const assets = Array.isArray(manifest.assets) ? manifest.assets : [];
  if (assets.length === 0) {
    return "No instruction assets were registered for this campaign.";
  }
  return assets
    .map((asset) => {
      const relativePath = path.relative(manifest.cwd, asset.path);
      const mappedPath = assetRoot && relativePath && !relativePath.startsWith(`..${path.sep}`) && relativePath !== ".."
        ? path.join(assetRoot, relativePath)
        : asset.path;
      return `- ${mappedPath} (sha256 ${asset.hash}${asset.primary ? ", primary" : ""})`;
    })
    .join("\n");
}

async function collectRunAssetHashes(manifest, assetRoot) {
  const entries = await Promise.all(
    (manifest.assets || []).map(async (asset) => {
      const relativePath = path.relative(manifest.cwd, asset.path);
      if (!relativePath || relativePath.startsWith(`..${path.sep}`) || relativePath === "..") {
        throw new Error("Registered instruction assets must be inside the campaign workspace for an isolated worker run.");
      }
      const assetPath = path.join(assetRoot, relativePath);
      const content = await readFile(assetPath, "utf8");
      return [relativePath.split(path.sep).join("/"), createHash("sha256").update(content, "utf8").digest("hex")];
    })
  );
  return Object.fromEntries(entries);
}

export function buildCampaignRunPrompt({ manifest, role, taskId, prompt = "", assetRoot = null }) {
  const revision = currentRevision(manifest);
  const task = taskForRun(manifest, role, taskId);
  const extra = compactText(prompt, role === "reviewer" ? MAX_REVIEW_CHECKPOINT_CHARS : 12_000);

  if (role === "reviewer") {
    return [
      "You are a CSR-owned Codex campaign reviewer.",
      `Campaign: ${manifest.id}`,
      `Instruction revision: V${revision.number}`,
      "Review only the coordinator-supplied, compact checkpoint below.",
      "Do not call tools, inspect the workspace, read registered instruction assets or raw sessions, or enumerate available tools. Do not fetch evidence references; treat them only as identifiers already summarized in the checkpoint.",
      "Do not edit files. State any proposed next overlay separately from durable patch proposals. If the checkpoint lacks evidence, report the exact gap instead of investigating it.",
      extra ? `Coordinator checkpoint:\n${extra}` : "Coordinator checkpoint: (none supplied)",
      "At completion, report a concise judgment, acceptance gaps, and any proposed overlay. Reviewer judgment never substitutes for measured worker evidence."
    ].join("\n\n");
  }

  const taskInstruction = task ? `Assigned task (${task.id}): ${task.label}` : "No individual task is assigned.";

  return [
    "You are a CSR-owned Codex campaign run.",
    `Campaign: ${manifest.id}`,
    `Role: ${role}`,
    `Instruction revision: V${revision.number}`,
    taskInstruction,
    "Execute exactly the assigned task. Follow the registered instruction assets and active overlay. Do not edit optimization instruction assets unless the task itself explicitly requires it.",
    "Registered instruction assets (read the applicable ones before acting):",
    assetBlock(manifest, assetRoot),
    `Active overlay:\n${revision.overlay || "(baseline: none)"}`,
    extra ? `Coordinator request:\n${extra}` : null,
    "At completion, report concise acceptance evidence and any blockers. A successful run is not itself validation."
  ].filter(Boolean).join("\n\n");
}

async function ensureDirectory(cwd) {
  const details = await stat(cwd).catch(() => null);
  if (!details?.isDirectory()) {
    throw new Error("Campaign working directory is unavailable; CSR did not start Codex.");
  }
}

async function captureWorkspaceIdentity(cwd, excludedPaths = []) {
  try {
    const { stdout: topLevel } = await execFile("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
    const root = topLevel.trim();
    const exclusions = excludedPaths
      .map((entry) => String(entry || "").replaceAll("\\", "/").replace(/^\.\//u, ""))
      .filter((entry) => entry && !entry.startsWith("../") && entry !== "..")
      .map((entry) => `:(exclude)${entry}`);
    const [{ stdout: commit }, { stdout: status }, { stdout: diff }] = await Promise.all([
      execFile("git", ["-C", cwd, "rev-parse", "HEAD"]),
      execFile("git", ["-C", cwd, "status", "--porcelain=v1", "--untracked-files=all", "--", ".", ...exclusions]),
      execFile("git", ["-C", cwd, "diff", "--binary", "HEAD", "--", ".", ...exclusions])
    ]);
    const normalizedStatus = status.trim();
    const fingerprint = createHash("sha256")
      .update(`commit:${commit.trim()}\nstatus:${normalizedStatus}\ndiff:${diff}`, "utf8")
      .digest("hex");
    return {
      kind: "git-workspace-snapshot",
      root,
      revision: commit.trim(),
      clean: normalizedStatus.length === 0,
      fingerprint: `git:${fingerprint}`
    };
  } catch {
    return {
      kind: "unverified",
      root: null,
      revision: null,
      clean: false,
      fingerprint: null
    };
  }
}

function eventTypeForRun(role, eventType) {
  const suffix = String(eventType || "event").replaceAll("/", ".");
  return `${role}.${suffix}`;
}

function createMeasurement({ tokenTotal, startedAt, threadId, sawUsage, workspaceAfter = null }) {
  const workerTokens = tokenTotal > 0 ? tokenTotal : null;
  return {
    source: "csr-owned-codex-exec",
    status: workerTokens === null ? "unknown" : "measured",
    workerTokens,
    elapsedMs: Math.max(0, Date.now() - startedAt),
    session: {
      id: threadId || null,
      location: "codex-exec",
      relativePath: null,
      modifiedAt: null
    },
    evidenceRef: threadId ? `thread:${threadId}` : null,
    usageObserved: sawUsage,
    workspaceAfter
  };
}

/**
 * Start a persistent, local `codex exec --json` child owned by CSR. Its JSON
 * stream, thread identifier, elapsed time, and token usage are saved in the
 * campaign ledger as the run happens. This intentionally does not rely on
 * native delegated agents or an App Server connection.
 */
export async function runCampaignCodex({
  rootDir,
  id,
  role,
  taskId = null,
  prompt = "",
  command = "codex",
  commandArgs = [],
  model = null,
  executionCwd = null,
  sandbox = null,
  disposableExecutionCwd = false,
  spawn = spawnChildProcess
}) {
  if (!["worker", "reviewer"].includes(role)) {
    throw new Error("Campaign run role must be worker or reviewer.");
  }
  if (model !== null && (typeof model !== "string" || !model.trim())) {
    throw new Error("Campaign model must be a non-empty string when provided.");
  }
  const manifest = await readCampaign({ rootDir, id });
  await ensureDirectory(manifest.cwd);
  const revision = currentRevision(manifest);
  if (role === "reviewer" && sandbox && sandbox !== "read-only") {
    throw new Error("Campaign reviewers always run in the read-only checkpoint sandbox.");
  }
  const selectedSandbox = role === "reviewer" ? "read-only" : (sandbox || "workspace-write");
  if (!["read-only", "workspace-write", "danger-full-access"].includes(selectedSandbox)) {
    throw new Error("Campaign worker sandbox must be read-only, workspace-write, or danger-full-access.");
  }
  taskForRun(manifest, role, taskId);
  if (role === "reviewer" && executionCwd) {
    throw new Error("Campaign reviewers only run in CSR's empty checkpoint sandbox.");
  }
  if (disposableExecutionCwd && (role !== "worker" || !executionCwd)) {
    throw new Error("A disposable execution workspace requires an explicit worker --execution-cwd.");
  }
  const requestedExecutionCwd = path.resolve(executionCwd || manifest.cwd);
  await ensureDirectory(requestedExecutionCwd);
  if (disposableExecutionCwd && requestedExecutionCwd === path.resolve(manifest.cwd)) {
    throw new Error("A disposable execution workspace must differ from the campaign workspace.");
  }
  const disposableWorkspace = disposableExecutionCwd
    ? await registerDisposableExecutionWorkspace(requestedExecutionCwd)
    : null;
  const requestedModel = typeof model === "string" ? model.trim() : null;
  // The CLI's configured default is intentionally not guessed.  This stable
  // identity says that both sides used the same CSR invocation without an
  // explicit --model, while `requestedModel` remains null so the child CLI
  // can select its configured default normally.
  const selectedModel = requestedModel || RUNNER_DEFAULT_MODEL;
  const modelSource = requestedModel ? "explicit" : "runner-default";

  const reviewerScratchDir = role === "reviewer"
    ? await mkdtemp(path.join(os.tmpdir(), "csr-campaign-review-"))
    : null;
  const runCwd = reviewerScratchDir || requestedExecutionCwd;
  const assetRelativePaths = (manifest.assets || [])
    .map((asset) => path.relative(manifest.cwd, asset.path))
    .filter((assetPath) => assetPath && !assetPath.startsWith(`..${path.sep}`) && assetPath !== "..");
  const workspace = role === "worker" ? await captureWorkspaceIdentity(runCwd, assetRelativePaths) : null;
  const assetHashes = role === "worker" ? await collectRunAssetHashes(manifest, runCwd) : null;
  const runId = `run-${randomUUID()}`;
  const run = await startCampaignRun({
    rootDir,
    id,
    runId,
    role,
    taskId,
    revision: revision.number,
    command,
    commandArgs,
    model: selectedModel,
    modelSource,
    sandbox: selectedSandbox,
    promptHash: hashCoordinatorPrompt(prompt),
    executionCwd: role === "worker" ? runCwd : null,
    workspace,
    assetHashes
  });
  const assembledPrompt = buildCampaignRunPrompt({ manifest, role, taskId, prompt, assetRoot: role === "worker" ? runCwd : null });
  const args = [...commandArgs, ...createCampaignRunArgs({ cwd: runCwd, sandbox: selectedSandbox, model: requestedModel })];
  const startedAt = Date.now();
  let tokenTotal = null;
  let threadId = null;
  let sawUsage = false;
  let stderr = "";

  try {
    const exitCode = await new Promise((resolve, reject) => {
      let settled = false;
      const child = spawn(command, args, { cwd: runCwd, stdio: ["pipe", "pipe", "pipe"] });
      let eventWriteChain = Promise.resolve();
      const enqueueEventWrite = (operation) => {
        eventWriteChain = eventWriteChain.then(operation);
        return eventWriteChain;
      };
      const settle = (operation) => {
        if (settled) {
          return;
        }
        settled = true;
        operation();
      };
      const lines = readline.createInterface({ input: child.stdout });

      lines.on("line", (line) => {
        let raw;
        try {
          raw = JSON.parse(line);
        } catch {
          enqueueEventWrite(() => appendCampaignEvent({
            rootDir,
            id,
            type: `${role}.output.unparseable`,
            role,
            taskId,
            revision: run.revision,
            data: { text: compactText(line) }
          }));
          return;
        }
        const event = normalizeCodexExecEvent(raw);
        const observedThreadId = event.threadId;
        const shouldRecordThread = Boolean(observedThreadId && observedThreadId !== threadId);
        if (shouldRecordThread) threadId = observedThreadId;
        const tokens = extractCodexExecTokens(raw);
        if (tokens !== null) {
          sawUsage = true;
          tokenTotal = Math.max(tokenTotal || 0, tokens);
        }
        enqueueEventWrite(async () => {
          if (shouldRecordThread) {
            await recordCampaignRunThread({ rootDir, id, runId, threadId: observedThreadId });
          }
          await appendCampaignEvent({
            rootDir,
            id,
            type: eventTypeForRun(role, event.type),
            role,
            taskId,
            revision: run.revision,
            data: {
              runId,
              threadId: event.threadId,
              turnId: event.turnId,
              item: event.item,
              message: event.message,
              usage: event.usage || null
            }
          });
        });
      });
      child.stderr.on("data", (chunk) => {
        stderr = compactText(`${stderr}${String(chunk)}`);
      });
      child.once("error", (error) => settle(() => reject(error)));
      child.once("close", (code) => {
        lines.close();
        eventWriteChain.then(
          () => settle(() => resolve(Number.isFinite(Number(code)) ? Number(code) : 1)),
          (error) => settle(() => reject(error))
        );
      });
      child.stdin.end(assembledPrompt);
    });

    const measurement = createMeasurement({
      tokenTotal: tokenTotal || 0,
      startedAt,
      threadId,
      sawUsage,
      workspaceAfter: role === "worker" ? await captureWorkspaceIdentity(runCwd, assetRelativePaths) : null
    });
    return await completeCampaignRun({
      rootDir,
      id,
      runId,
      exitCode,
      measurement,
      error: exitCode === 0 ? null : stderr || `Codex exited with code ${exitCode}.`
    });
  } catch (error) {
    const measurement = createMeasurement({
      tokenTotal: tokenTotal || 0,
      startedAt,
      threadId,
      sawUsage,
      workspaceAfter: role === "worker" ? await captureWorkspaceIdentity(runCwd, assetRelativePaths) : null
    });
    await completeCampaignRun({
      rootDir,
      id,
      runId,
      exitCode: 1,
      measurement,
      error: error?.message || String(error)
    }).catch(() => {});
    throw error;
  } finally {
    if (disposableWorkspace) {
      try {
        const cleanup = await disposeExecutionWorkspace(disposableWorkspace);
        await appendCampaignEvent({
          rootDir,
          id,
          type: `${role}.execution-workspace.cleanup.${cleanup.status}`,
          role,
          taskId,
          revision: run.revision,
          data: cleanup
        });
      } catch (error) {
        await appendCampaignEvent({
          rootDir,
          id,
          type: `${role}.execution-workspace.cleanup.failed`,
          role,
          taskId,
          revision: run.revision,
          data: { path: disposableWorkspace.path, error: error?.message || String(error) }
        }).catch(() => {});
        throw error;
      }
    }
    if (reviewerScratchDir) {
      await rm(reviewerScratchDir, { recursive: true, force: true });
    }
  }
}
