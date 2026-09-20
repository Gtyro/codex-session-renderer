import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import {
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { redactSensitiveText } from "./optimization-analysis.js";

const execFile = promisify(execFileCallback);
const CAMPAIGN_SCHEMA_VERSION = 1;
const CAMPAIGN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u;
const CAMPAIGN_DIR_NAME = ".codex-session-renderer";
const CAMPAIGN_FILE_NAME = "campaign.json";
const EVENTS_FILE_NAME = "events.jsonl";
const CAMPAIGN_LOCK_DIR_NAME = ".campaign.lock";
const CAMPAIGN_LOCK_RETRIES = 240;
const CAMPAIGN_LOCK_DELAY_MS = 25;

function now() {
  return new Date().toISOString();
}

function sha256(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

function normalizeTask(task, index) {
  if (typeof task === "string") {
    return {
      id: `task-${index + 1}`,
      label: task,
      status: "pending",
      cohort: null,
      revision: 1
    };
  }

  return {
    id: String(task?.id || `task-${index + 1}`),
    label: String(task?.label || task?.prompt || `Task ${index + 1}`),
    status: task?.status || "pending",
    cohort: task?.cohort || null,
    revision: Number.isInteger(task?.revision) ? task.revision : 1,
    metadata: task?.metadata && typeof task.metadata === "object" ? redactValue(task.metadata) : null
  };
}

function normalizeCampaignId(value) {
  const id = String(value ?? "").trim();

  if (!CAMPAIGN_ID_PATTERN.test(id)) {
    throw new Error("Campaign ID is invalid.");
  }

  return id;
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function createWorkspaceLifecycle(cwd, disposableWorkspace, registeredAt) {
  const workspacePath = path.resolve(cwd || process.cwd());

  if (!disposableWorkspace) {
    return {
      path: workspacePath,
      ownership: "external",
      cleanup: {
        policy: "retain",
        status: "not-requested",
        registeredAt
      }
    };
  }

  const temporaryRoot = await realpath(os.tmpdir());
  const resolvedWorkspace = await realpath(workspacePath).catch((error) => {
    if (error?.code === "ENOENT") {
      throw new Error("A disposable campaign workspace must already exist.");
    }
    throw error;
  });
  const entry = await lstat(resolvedWorkspace);

  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error("A disposable campaign workspace must be a non-symlink directory.");
  }
  if (resolvedWorkspace === temporaryRoot || !isWithin(temporaryRoot, resolvedWorkspace)) {
    throw new Error("A disposable campaign workspace must resolve beneath the system temporary directory.");
  }

  return {
    path: workspacePath,
    realpath: resolvedWorkspace,
    identity: {
      device: entry.dev,
      inode: entry.ino
    },
    ownership: "campaign-temporary",
    cleanup: {
      policy: "delete-on-archive",
      status: "pending",
      registeredAt
    }
  };
}

function recordWorkspaceCleanup(manifest, status, details = {}) {
  const completedAt = now();
  manifest.workspace = {
    ...manifest.workspace,
    cleanup: {
      ...manifest.workspace.cleanup,
      status,
      completedAt,
      ...details
    }
  };
  return { ...manifest.workspace.cleanup };
}

async function disposeCampaignWorkspace(paths, manifest) {
  const workspace = manifest.workspace;

  if (workspace?.ownership !== "campaign-temporary" || workspace?.cleanup?.policy !== "delete-on-archive") {
    return { status: "not-requested" };
  }

  const workspacePath = workspace.path;
  const expectedPath = workspace.realpath;
  const expectedIdentity = workspace.identity;

  try {
    const temporaryRoot = await realpath(os.tmpdir());
    const resolvedWorkspace = await realpath(workspacePath).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });

    if (!resolvedWorkspace) {
      const cleanup = recordWorkspaceCleanup(manifest, "missing", { missingAt: now() });
      await appendEventWithManifest(paths, manifest, {
        type: "workspace.cleanup.missing",
        role: "coordinator",
        data: { path: workspacePath, expectedPath }
      });
      return cleanup;
    }
    if (
      resolvedWorkspace !== expectedPath ||
      resolvedWorkspace === temporaryRoot ||
      !isWithin(temporaryRoot, resolvedWorkspace)
    ) {
      throw new Error("Disposable workspace path no longer matches its registered temporary directory.");
    }

    const entry = await lstat(resolvedWorkspace);
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      entry.dev !== expectedIdentity?.device ||
      entry.ino !== expectedIdentity?.inode
    ) {
      throw new Error("Disposable workspace identity changed after registration.");
    }

    await rm(resolvedWorkspace, { recursive: true, force: false });
    const cleanup = recordWorkspaceCleanup(manifest, "disposed", { disposedAt: now() });
    await appendEventWithManifest(paths, manifest, {
      type: "workspace.cleanup.completed",
      role: "coordinator",
      data: { path: workspacePath, resolvedPath: resolvedWorkspace, disposedAt: cleanup.disposedAt }
    });
    return cleanup;
  } catch (error) {
    const cleanup = recordWorkspaceCleanup(manifest, "failed", {
      failedAt: now(),
      error: redactSensitiveText(error?.message || String(error))
    });
    await appendEventWithManifest(paths, manifest, {
      type: "workspace.cleanup.failed",
      role: "coordinator",
      data: { path: workspacePath, error: cleanup.error }
    });
    throw new Error(`Declared campaign workspace was not cleaned: ${cleanup.error}`);
  }
}

function redactValue(value) {
  if (typeof value === "string") {
    return redactSensitiveText(value);
  }

  if (Array.isArray(value)) {
    return value.map(redactValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactValue(child)]));
  }

  return value;
}

function campaignPaths(rootDir, id) {
  const normalizedRoot = path.resolve(rootDir || getDefaultCampaignsDir());
  const campaignDir = path.join(normalizedRoot, normalizeCampaignId(id));

  if (!isWithin(normalizedRoot, campaignDir)) {
    throw new Error("Campaign path is outside the campaign store.");
  }

  return {
    rootDir: normalizedRoot,
    campaignDir,
    manifestPath: path.join(campaignDir, CAMPAIGN_FILE_NAME),
    eventsPath: path.join(campaignDir, EVENTS_FILE_NAME)
  };
}

async function writeManifest(paths, manifest) {
  const normalized = {
    ...manifest,
    updatedAt: now()
  };
  await writeFile(paths.manifestPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
}

async function readManifest(paths) {
  let source;

  try {
    source = await readFile(paths.manifestPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Campaign "${path.basename(paths.campaignDir)}" was not found.`);
    }
    throw error;
  }

  const manifest = JSON.parse(source);

  if (manifest?.schemaVersion !== CAMPAIGN_SCHEMA_VERSION) {
    throw new Error(`Unsupported campaign schema: ${manifest?.schemaVersion ?? "unknown"}.`);
  }

  return manifest;
}

function pause(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function withCampaignLock(paths, operation) {
  const lockPath = path.join(paths.campaignDir, CAMPAIGN_LOCK_DIR_NAME);
  let acquired = false;

  for (let attempt = 0; attempt < CAMPAIGN_LOCK_RETRIES; attempt += 1) {
    try {
      await mkdir(lockPath);
      acquired = true;
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      await pause(CAMPAIGN_LOCK_DELAY_MS);
    }
  }

  if (!acquired) {
    throw new Error(`Campaign "${path.basename(paths.campaignDir)}" is busy; retry the operation.`);
  }

  try {
    return await operation();
  } finally {
    await rmdir(lockPath).catch(() => {});
  }
}

function buildCampaignEvent(manifest, { type, role = "system", taskId = null, revision = null, data = null }) {
  return {
    schemaVersion: CAMPAIGN_SCHEMA_VERSION,
    seq: manifest.eventSeq + 1,
    timestamp: now(),
    runId: manifest.id,
    type: String(type || "campaign.event"),
    role: String(role || "system"),
    taskId: taskId || null,
    revision: Number.isInteger(revision) ? revision : null,
    data: data === null ? null : redactValue(data)
  };
}

async function appendEventWithManifest(paths, manifest, eventOptions) {
  const event = buildCampaignEvent(manifest, eventOptions);
  await appendFile(paths.eventsPath, `${JSON.stringify(event)}\n`, "utf8");
  manifest.eventSeq = event.seq;
  await writeManifest(paths, manifest);
  return event;
}

function taskIndex(manifest, taskId) {
  const index = manifest.tasks.findIndex((task) => task.id === taskId);
  if (index < 0) {
    throw new Error(`Task "${taskId}" is not registered in campaign ${manifest.id}.`);
  }
  return index;
}

function assertAssetPath(assetPath, cwd) {
  const resolvedCwd = path.resolve(cwd || "");
  const resolvedPath = path.resolve(assetPath || "");
  const basename = path.basename(resolvedPath).toLowerCase();
  const relative = path.relative(resolvedCwd, resolvedPath).split(path.sep).join("/");

  if (!cwd || !isWithin(resolvedCwd, resolvedPath)) {
    throw new Error("Instruction assets must remain inside the campaign workspace.");
  }

  if (basename === "agents.md") {
    throw new Error("AGENTS.md is never eligible for automatic campaign patches.");
  }

  const allowed =
    basename === "skill.md" ||
    /^readme(?:\.[a-z0-9-]+)?\.md$/iu.test(basename) ||
    (relative.startsWith("docs/") && relative.endsWith(".md"));

  if (!allowed) {
    throw new Error("Only SKILL.md, README*.md, and docs/*.md instruction assets are eligible.");
  }

  return {
    assetPath: resolvedPath,
    relativePath: relative
  };
}

function assertPromotedAssetContent(assetPath, content) {
  if (path.basename(assetPath).toLowerCase() !== "skill.md") {
    return;
  }

  const frontmatter = String(content ?? "").match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u)?.[1] || "";
  const name = frontmatter.match(/^name:\s*([^\s#][^#]*?)\s*$/mu)?.[1]?.trim();
  const description = frontmatter.match(/^description:\s*(.+?)\s*$/mu)?.[1]?.trim();

  if (!name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) || !description) {
    throw new Error("Promoted SKILL.md must retain valid name and description frontmatter.");
  }
}

function patchCanPromote(patch, manifest = null) {
  const comparisons = Array.isArray(patch.comparisons) ? patch.comparisons : [];
  const runs = new Map((manifest?.runs || []).map((run) => [run.id, run]));
  const acceptedStatuses = new Set(["passed", "reviewer-verified"]);
  const comparisonDiagnostics = comparisons.map((entry) => {
    const caseId = typeof entry?.caseId === "string" ? entry.caseId.trim() : "";
    const cohort = typeof entry?.cohort === "string" ? entry.cohort.trim() : "";
    const baselineRun = runs.get(entry?.baselineRunId);
    const candidateRun = runs.get(entry?.candidateRunId);
    const reject = (reason) => ({ entry, caseId, cohort, eligible: false, reason });

    if (!manifest) return reject("Campaign run evidence is required.");
    if (!caseId || !cohort) return reject("Comparison requires a caseId and cohort.");
    if (!baselineRun || !candidateRun || baselineRun.id === candidateRun.id) {
      return reject("Comparison must reference distinct baseline and candidate CSR runs.");
    }
    if (baselineRun.role !== "worker" || candidateRun.role !== "worker") {
      return reject("Both comparison runs must be CSR-owned workers.");
    }
    if (baselineRun.taskId !== caseId || candidateRun.taskId !== caseId) {
      return reject("Comparison caseId must match both worker task IDs.");
    }
    if (baselineRun.revision >= candidateRun.revision) {
      return reject("Candidate worker revision must be newer than its baseline.");
    }
    if (
      baselineRun.command !== candidateRun.command ||
      !baselineRun.model ||
      !candidateRun.model ||
      baselineRun.model !== candidateRun.model ||
      !baselineRun.modelSource ||
      !candidateRun.modelSource ||
      baselineRun.modelSource !== candidateRun.modelSource ||
      baselineRun.sandbox !== candidateRun.sandbox ||
      baselineRun.promptHash !== candidateRun.promptHash ||
      !baselineRun.executionCwd ||
      !candidateRun.executionCwd ||
      baselineRun.executionCwd === candidateRun.executionCwd ||
      !baselineRun.workspace?.fingerprint ||
      baselineRun.workspace.fingerprint !== candidateRun.workspace?.fingerprint ||
      baselineRun.workspace.fingerprint !== baselineRun.measurement?.workspaceAfter?.fingerprint ||
      candidateRun.workspace.fingerprint !== candidateRun.measurement?.workspaceAfter?.fingerprint ||
      baselineRun.assetHashes?.[patch.relativePath] !== patch.baseHash ||
      candidateRun.assetHashes?.[patch.relativePath] !== patch.nextHash ||
      JSON.stringify(baselineRun.commandArgs || []) !== JSON.stringify(candidateRun.commandArgs || [])
    ) {
      return reject("Baseline and candidate must use separate, unchanged workspace copies of the same captured snapshot, with the same CSR command, model identity and source, arguments, sandbox, coordinator prompt, and tested instruction-asset hashes.");
    }
    if (
      baselineRun.measurement?.source !== "csr-owned-codex-exec" ||
      candidateRun.measurement?.source !== "csr-owned-codex-exec" ||
      baselineRun.measurement?.status !== "measured" ||
      candidateRun.measurement?.status !== "measured" ||
      !Number.isFinite(Number(baselineRun.measurement?.workerTokens)) ||
      !Number.isFinite(Number(candidateRun.measurement?.workerTokens)) ||
      Number(baselineRun.measurement.workerTokens) <= 0 ||
      Number(candidateRun.measurement.workerTokens) <= 0
    ) {
      return reject("Both comparison runs need measured CSR worker tokens.");
    }
    if (
      !acceptedStatuses.has(baselineRun.validation?.status) ||
      !acceptedStatuses.has(candidateRun.validation?.status) ||
      baselineRun.validation?.source !== "csr-owned-codex-exec" ||
      candidateRun.validation?.source !== "csr-owned-codex-exec" ||
      baselineRun.validation?.cohort !== cohort ||
      candidateRun.validation?.cohort !== cohort
    ) {
      return reject("Both comparison runs need accepted CSR validation in the declared cohort.");
    }
    if (Number(candidateRun.measurement.workerTokens) >= Number(baselineRun.measurement.workerTokens)) {
      return reject("Candidate worker tokens are not lower than baseline tokens.");
    }

    return {
      entry,
      caseId,
      cohort,
      eligible: true,
      baselineRunId: baselineRun.id,
      candidateRunId: candidateRun.id,
      baselineWorkerTokens: Number(baselineRun.measurement.workerTokens),
      workerTokens: Number(candidateRun.measurement.workerTokens)
    };
  });
  const winning = comparisonDiagnostics.filter((entry) => entry.eligible);
  const comparableGroups = new Map();
  winning.forEach((entry) => {
    const cohort = entry.cohort.trim();
    const caseIds = comparableGroups.get(cohort) || new Set();
    caseIds.add(entry.caseId);
    comparableGroups.set(cohort, caseIds);
  });
  const winningCohort = [...comparableGroups.entries()].find(([, caseIds]) => caseIds.size >= 2)?.[0] || null;

  return {
    eligible: Boolean(winningCohort),
    winningComparisons: winningCohort ? comparableGroups.get(winningCohort).size : 0,
    requiredComparisons: 2,
    comparisons: comparisonDiagnostics.map(({ entry: _entry, ...diagnostic }) => diagnostic)
  };
}

async function mergeCandidate({ currentContent, baseContent, nextContent }) {
  if (currentContent === baseContent) {
    return { content: nextContent, strategy: "clean" };
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "csr-campaign-merge-"));
  const currentPath = path.join(tempDir, "current.md");
  const basePath = path.join(tempDir, "base.md");
  const nextPath = path.join(tempDir, "candidate.md");

  try {
    await Promise.all([
      writeFile(currentPath, currentContent, "utf8"),
      writeFile(basePath, baseContent, "utf8"),
      writeFile(nextPath, nextContent, "utf8")
    ]);

    try {
      const { stdout } = await execFile("git", ["merge-file", "-p", "--diff3", currentPath, basePath, nextPath], {
        maxBuffer: 4 * 1024 * 1024
      });
      return { content: stdout, strategy: "three-way" };
    } catch (error) {
      if (Number(error?.code) === 1) {
        throw new Error("Automatic three-way merge produced conflicts; no instruction asset was written.");
      }
      throw error;
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export function getDefaultCampaignsDir() {
  return path.join(os.homedir(), CAMPAIGN_DIR_NAME, "campaigns");
}

export function getDefaultArchivedCampaignsDir() {
  return path.join(os.homedir(), CAMPAIGN_DIR_NAME, "archived-campaigns");
}

export function getCampaignArchiveRoot(rootDir) {
  const activeRoot = path.resolve(rootDir || getDefaultCampaignsDir());
  if (activeRoot === path.resolve(getDefaultCampaignsDir())) {
    return getDefaultArchivedCampaignsDir();
  }
  return path.join(path.dirname(activeRoot), `archived-${path.basename(activeRoot)}`);
}

export function getTaskFamilyId({
  skillPath = null,
  skillContent = null,
  skillHash = null,
  assetPaths = [],
  assetHashes = [],
  taskTemplate = ""
} = {}) {
  const identity = {
    skillPath: skillPath ? path.resolve(skillPath) : null,
    skillHash: skillHash || (skillContent === null ? null : sha256(skillContent)),
    assetPaths: [...assetPaths].map((entry) => path.resolve(entry)).sort(),
    assetHashes: [...assetHashes].map(String).sort(),
    taskTemplate: String(taskTemplate).replace(/\s+/gu, " ").trim().toLocaleLowerCase()
  };
  return `family-${sha256(JSON.stringify(identity)).slice(0, 20)}`;
}

export async function createCampaign(options = {}) {
  const rootDir = path.resolve(options.rootDir || getDefaultCampaignsDir());
  const id = normalizeCampaignId(options.id || randomUUID());
  const paths = campaignPaths(rootDir, id);
  const tasks = (Array.isArray(options.tasks) ? options.tasks : []).map(normalizeTask);
  const createdAt = now();
  const cwd = path.resolve(options.cwd || process.cwd());
  const workspace = await createWorkspaceLifecycle(cwd, Boolean(options.disposableWorkspace), createdAt);
  const manifest = {
    schemaVersion: CAMPAIGN_SCHEMA_VERSION,
    id,
    createdAt,
    updatedAt: createdAt,
    cwd,
    workspace,
    intent: redactSensitiveText(String(options.intent || "Agent workflow optimization campaign")),
    taskFamilyId: options.taskFamilyId || null,
    eventSeq: 0,
    tasks,
    threads: [],
    runs: [],
    revisions: [
      {
        number: 1,
        overlay: "",
        createdAt,
        activatedAt: createdAt,
        reason: "baseline"
      }
    ],
    patches: [],
    appServer: {
      status: "not-connected",
      protocolVersion: null,
      lastError: null
    },
    sessionLog: {
      status: "available",
      source: "csr-session-jsonl"
    }
  };

  await mkdir(paths.rootDir, { recursive: true });
  await mkdir(paths.campaignDir, { recursive: false });
  await Promise.all([
    writeFile(paths.eventsPath, "", "utf8"),
    writeManifest(paths, manifest)
  ]);
  await appendCampaignEvent({ rootDir, id, type: "campaign.created", role: "coordinator", data: { intent: manifest.intent } });
  return readCampaign({ rootDir, id });
}

export async function readCampaign({ rootDir, id }) {
  return readManifest(campaignPaths(rootDir, id));
}

export async function listCampaigns({ rootDir } = {}) {
  const resolvedRoot = path.resolve(rootDir || getDefaultCampaignsDir());
  let entries;

  try {
    entries = await readdir(resolvedRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const campaigns = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && CAMPAIGN_ID_PATTERN.test(entry.name))
      .map(async (entry) => {
        try {
          return await readCampaign({ rootDir: resolvedRoot, id: entry.name });
        } catch {
          return null;
        }
      })
  );

  return campaigns
    .filter(Boolean)
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)) || left.id.localeCompare(right.id));
}

export async function archiveCampaign({ rootDir, id, archiveRoot = null }) {
  const paths = campaignPaths(rootDir, id);
  const targetRoot = path.resolve(archiveRoot || getCampaignArchiveRoot(paths.rootDir));
  const targetDir = path.join(targetRoot, normalizeCampaignId(id));

  if (path.resolve(paths.campaignDir) === path.resolve(targetDir) || !isWithin(targetRoot, targetDir)) {
    throw new Error("Campaign archive target is invalid.");
  }

  return withCampaignLock(paths, async () => {
    const manifest = await readManifest(paths);
    if ((manifest.runs || []).some((run) => run.status === "running")) {
      throw new Error("Running campaigns cannot be archived.");
    }
    await mkdir(targetRoot, { recursive: true });
    await lstat(targetDir).then(
      () => {
        throw new Error(`Archived campaign "${id}" already exists.`);
      },
      (error) => {
        if (error?.code !== "ENOENT") throw error;
      }
    );
    const workspaceCleanup = await disposeCampaignWorkspace(paths, manifest);
    const archivedAt = now();
    manifest.archivedAt = archivedAt;
    manifest.archiveRoot = targetRoot;
    await appendEventWithManifest(paths, manifest, {
      type: "campaign.archived",
      role: "coordinator",
      data: { archiveRoot: targetRoot, archivePath: targetDir, archivedAt, workspaceCleanup }
    });
    await rename(paths.campaignDir, targetDir);
    await rmdir(path.join(targetDir, CAMPAIGN_LOCK_DIR_NAME));
    return {
      id: manifest.id,
      archivedAt,
      archiveRoot: targetRoot,
      archivePath: targetDir,
      workspaceCleanup
    };
  });
}

export async function restoreCampaign({ rootDir, id, archiveRoot = null }) {
  const activeRoot = path.resolve(rootDir || getDefaultCampaignsDir());
  const sourcePaths = campaignPaths(archiveRoot || getCampaignArchiveRoot(activeRoot), id);
  const targetDir = path.join(activeRoot, normalizeCampaignId(id));

  if (path.resolve(sourcePaths.campaignDir) === path.resolve(targetDir) || !isWithin(activeRoot, targetDir)) {
    throw new Error("Campaign restore target is invalid.");
  }

  return withCampaignLock(sourcePaths, async () => {
    const manifest = await readManifest(sourcePaths);
    if ((manifest.runs || []).some((run) => run.status === "running")) {
      throw new Error("Running campaigns cannot be restored.");
    }
    await mkdir(activeRoot, { recursive: true });
    await lstat(targetDir).then(
      () => {
        throw new Error(`Active campaign "${id}" already exists.`);
      },
      (error) => {
        if (error?.code !== "ENOENT") throw error;
      }
    );
    const restoredAt = now();
    manifest.restoredAt = restoredAt;
    await appendEventWithManifest(sourcePaths, manifest, {
      type: "campaign.restored",
      role: "coordinator",
      data: { restoredAt, restoredFrom: sourcePaths.rootDir }
    });
    await rename(sourcePaths.campaignDir, targetDir);
    await rmdir(path.join(targetDir, CAMPAIGN_LOCK_DIR_NAME));
    return {
      id: manifest.id,
      restoredAt,
      campaignRoot: activeRoot,
      campaignPath: targetDir
    };
  });
}

export async function appendCampaignEvent({ rootDir, id, type, role = "system", taskId = null, revision = null, data = null }) {
  const paths = campaignPaths(rootDir, id);
  return withCampaignLock(paths, async () => {
    const manifest = await readManifest(paths);
    return appendEventWithManifest(paths, manifest, { type, role, taskId, revision, data });
  });
}

export async function readCampaignEvents({ rootDir, id, after = 0 }) {
  const paths = campaignPaths(rootDir, id);
  let source;

  try {
    source = await readFile(paths.eventsPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  return source
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((event) => Number(event.seq) > Number(after || 0));
}

export async function attachCampaignThread({ rootDir, id, threadId, role, taskId = null, revision = null }) {
  const paths = campaignPaths(rootDir, id);
  return withCampaignLock(paths, async () => {
    const manifest = await readManifest(paths);

    if (!threadId || !role) {
      throw new Error("Campaign thread attachments require threadId and role.");
    }

    if (taskId) {
      taskIndex(manifest, taskId);
    }

    const attachment = {
      threadId: String(threadId),
      role: String(role),
      taskId: taskId || null,
      revision: Number.isInteger(revision) ? revision : null,
      attachedAt: now()
    };
    const existing = manifest.threads.findIndex((entry) => entry.threadId === attachment.threadId);

    if (existing >= 0) {
      manifest.threads[existing] = attachment;
    } else {
      manifest.threads.push(attachment);
    }

    await appendEventWithManifest(paths, manifest, {
      type: `${attachment.role}.attached`,
      role: attachment.role,
      taskId,
      revision,
      data: attachment
    });
    return attachment;
  });
}

export async function startCampaignRun({
  rootDir,
  id,
  runId,
  role,
  taskId = null,
  revision = null,
  command = "codex",
  commandArgs = [],
  model = null,
  modelSource = null,
  sandbox = null,
  promptHash = null,
  executionCwd = null,
  workspace = null,
  assetHashes = null
}) {
  const paths = campaignPaths(rootDir, id);
  return withCampaignLock(paths, async () => {
    const manifest = await readManifest(paths);
    const normalizedRole = String(role || "");

    if (!runId || !["worker", "reviewer"].includes(normalizedRole)) {
      throw new Error("Campaign runs require a run ID and a worker or reviewer role.");
    }
    if (taskId) {
      taskIndex(manifest, taskId);
    }
    if (manifest.runs?.some((entry) => entry.id === runId)) {
      throw new Error(`Campaign run "${runId}" already exists.`);
    }

    const normalizedModel = typeof model === "string" && model.trim() ? model.trim() : "codex-default";
    const normalizedModelSource = modelSource === "explicit" || modelSource === "runner-default"
      ? modelSource
      : (normalizedModel === "codex-default" ? "runner-default" : "explicit");
    if (normalizedModelSource === "explicit" && normalizedModel === "codex-default") {
      throw new Error("An explicit campaign model must name the selected model.");
    }
    if (normalizedModelSource === "runner-default" && normalizedModel !== "codex-default") {
      throw new Error("The CSR runner-default model identity must be codex-default.");
    }

    const run = {
      id: String(runId),
      role: normalizedRole,
      taskId: taskId || null,
      revision: Number.isInteger(revision) ? revision : manifest.revisions.at(-1)?.number || 1,
      command: String(command || "codex"),
      commandArgs: Array.isArray(commandArgs) ? commandArgs.map((entry) => redactSensitiveText(String(entry))) : [],
      model: normalizedModel,
      modelSource: normalizedModelSource,
      sandbox: sandbox || null,
      promptHash: typeof promptHash === "string" && promptHash.trim() ? promptHash.trim() : null,
      executionCwd: typeof executionCwd === "string" && executionCwd.trim() ? executionCwd : null,
      workspace: workspace && typeof workspace === "object" ? redactValue(workspace) : null,
      assetHashes: assetHashes && typeof assetHashes === "object" ? redactValue(assetHashes) : null,
      status: "running",
      threadId: null,
      startedAt: now(),
      completedAt: null,
      exitCode: null,
      measurement: null,
      error: null
    };
    manifest.runs = Array.isArray(manifest.runs) ? manifest.runs : [];
    manifest.runs.push(run);
    if (run.role === "worker" && run.taskId) {
      const index = taskIndex(manifest, run.taskId);
      manifest.tasks[index] = { ...manifest.tasks[index], status: "running", revision: run.revision };
    }
    await appendEventWithManifest(paths, manifest, {
      type: `${run.role}.run.started`,
      role: run.role,
      taskId: run.taskId,
      revision: run.revision,
      data: {
        runId: run.id,
        command: run.command,
        commandArgs: run.commandArgs,
        model: run.model,
        modelSource: run.modelSource,
        sandbox: run.sandbox,
        promptHash: run.promptHash,
        executionCwd: run.executionCwd,
        workspace: run.workspace,
        assetHashes: run.assetHashes
      }
    });
    return run;
  });
}

export async function recordCampaignRunThread({ rootDir, id, runId, threadId }) {
  const paths = campaignPaths(rootDir, id);
  return withCampaignLock(paths, async () => {
    const manifest = await readManifest(paths);
    const index = (manifest.runs || []).findIndex((entry) => entry.id === runId);
    if (index < 0) {
      throw new Error(`Campaign run "${runId}" was not found.`);
    }
    if (!threadId) {
      throw new Error("Campaign run thread ID is required.");
    }

    const run = { ...manifest.runs[index], threadId: String(threadId) };
    manifest.runs[index] = run;
    const attachment = {
      threadId: run.threadId,
      role: run.role,
      taskId: run.taskId,
      revision: run.revision,
      attachedAt: now()
    };
    const attachedIndex = manifest.threads.findIndex((entry) => entry.threadId === attachment.threadId);
    if (attachedIndex >= 0) {
      manifest.threads[attachedIndex] = attachment;
    } else {
      manifest.threads.push(attachment);
    }
    await appendEventWithManifest(paths, manifest, {
      type: `${run.role}.thread.started`,
      role: run.role,
      taskId: run.taskId,
      revision: run.revision,
      data: { runId: run.id, threadId: run.threadId }
    });
    return run;
  });
}

export async function completeCampaignRun({ rootDir, id, runId, exitCode, measurement = null, error = null }) {
  const paths = campaignPaths(rootDir, id);
  return withCampaignLock(paths, async () => {
    const manifest = await readManifest(paths);
    const index = (manifest.runs || []).findIndex((entry) => entry.id === runId);
    if (index < 0) {
      throw new Error(`Campaign run "${runId}" was not found.`);
    }

    const previous = manifest.runs[index];
    const succeeded = Number(exitCode) === 0;
    const run = {
      ...previous,
      status: succeeded ? "awaiting-validation" : "failed",
      completedAt: now(),
      exitCode: Number.isFinite(Number(exitCode)) ? Number(exitCode) : null,
      measurement: measurement && typeof measurement === "object" ? redactValue(measurement) : null,
      error: error ? redactSensitiveText(String(error)) : null
    };
    manifest.runs[index] = run;
    if (run.role === "worker" && run.taskId) {
      const taskPosition = taskIndex(manifest, run.taskId);
      manifest.tasks[taskPosition] = {
        ...manifest.tasks[taskPosition],
        status: succeeded ? "awaiting-validation" : "failed",
        revision: run.revision
      };
    }
    await appendEventWithManifest(paths, manifest, {
      type: `${run.role}.run.${succeeded ? "completed" : "failed"}`,
      role: run.role,
      taskId: run.taskId,
      revision: run.revision,
      data: {
        runId: run.id,
        threadId: run.threadId,
        exitCode: run.exitCode,
        measurement: run.measurement,
        error: run.error
      }
    });
    return run;
  });
}

export async function getCampaignRun({ rootDir, id, runId }) {
  const manifest = await readCampaign({ rootDir, id });
  const run = (manifest.runs || []).find((entry) => entry.id === runId);
  if (!run) {
    throw new Error(`Campaign run "${runId}" was not found.`);
  }
  return run;
}

export async function registerCampaignAsset({ rootDir, id, assetPath, primary = false }) {
  const paths = campaignPaths(rootDir, id);
  return withCampaignLock(paths, async () => {
    const manifest = await readManifest(paths);
    const resolvedPath = path.resolve(assetPath || "");
    const details = await lstat(resolvedPath).catch(() => null);

    if (!details || !details.isFile() || details.isSymbolicLink()) {
      throw new Error("Campaign assets must be existing non-symlink files.");
    }

    const content = await readFile(resolvedPath, "utf8");
    const asset = {
      path: resolvedPath,
      relativePath: isWithin(manifest.cwd, resolvedPath) ? path.relative(manifest.cwd, resolvedPath).split(path.sep).join("/") : null,
      hash: sha256(content),
      primary: Boolean(primary),
      observedAt: now()
    };
    const existing = manifest.assets?.findIndex((entry) => entry.path === asset.path) ?? -1;
    manifest.assets = Array.isArray(manifest.assets) ? manifest.assets : [];
    if (asset.primary) {
      manifest.assets = manifest.assets.map((entry) => ({ ...entry, primary: false }));
    }
    if (existing >= 0) {
      manifest.assets[existing] = asset;
    } else {
      manifest.assets.push(asset);
    }
    const primaryAsset = manifest.assets.find((entry) => entry.primary) || manifest.assets[0] || null;
    manifest.taskFamilyId = getTaskFamilyId({
      skillPath: primaryAsset?.path,
      skillHash: primaryAsset?.hash || null,
      assetPaths: manifest.assets.map((entry) => entry.path),
      assetHashes: manifest.assets.map((entry) => entry.hash),
      taskTemplate: manifest.intent
    });
    await appendEventWithManifest(paths, manifest, {
      type: "campaign.asset.observed",
      role: "coordinator",
      data: { path: asset.relativePath || asset.path, hash: asset.hash, primary: asset.primary, taskFamilyId: manifest.taskFamilyId }
    });
    return asset;
  });
}

export async function setCampaignAppServerStatus({ rootDir, id, status, protocolVersion = null, capabilities = null, error = null }) {
  const paths = campaignPaths(rootDir, id);
  return withCampaignLock(paths, async () => {
    const manifest = await readManifest(paths);
    manifest.appServer = {
      status: String(status || "unavailable"),
      protocolVersion: protocolVersion || null,
      capabilities: capabilities && typeof capabilities === "object" ? redactValue(capabilities) : null,
      lastError: error ? redactSensitiveText(String(error)) : null,
      updatedAt: now()
    };
    await writeManifest(paths, manifest);
    return manifest.appServer;
  });
}

export async function activateCampaignOverlay({ rootDir, id, overlay, reason, evidenceRefs = [] }) {
  const paths = campaignPaths(rootDir, id);
  return withCampaignLock(paths, async () => {
    const manifest = await readManifest(paths);
    const number = Math.max(...manifest.revisions.map((entry) => Number(entry.number) || 0)) + 1;
    const revision = {
      number,
      overlay: redactSensitiveText(String(overlay || "").trim()),
      reason: redactSensitiveText(String(reason || "reviewer checkpoint")),
      evidenceRefs: Array.isArray(evidenceRefs) ? evidenceRefs.map(String) : [],
      createdAt: now(),
      activatedAt: now()
    };
    manifest.revisions.push(revision);
    await appendEventWithManifest(paths, manifest, {
      type: "overlay.activated",
      role: "reviewer",
      revision: number,
      data: revision
    });
    return revision;
  });
}

export async function recordCampaignValidation({
  rootDir,
  id,
  taskId,
  status,
  source = "command",
  workerTokens = null,
  elapsedMs = null,
  cohort = null,
  revision = null,
  evidenceRefs = [],
  tokenMeasurement = null,
  runId = null
}) {
  const paths = campaignPaths(rootDir, id);
  return withCampaignLock(paths, async () => {
    const manifest = await readManifest(paths);
    const index = taskIndex(manifest, taskId);
    const runIndex = runId ? (manifest.runs || []).findIndex((entry) => entry.id === runId) : -1;
    if (runId && runIndex < 0) {
      throw new Error(`Campaign run "${runId}" was not found.`);
    }
    const validatedRun = runIndex >= 0 ? manifest.runs[runIndex] : null;
    if (validatedRun && (validatedRun.role !== "worker" || validatedRun.taskId !== taskId || validatedRun.status !== "awaiting-validation")) {
      throw new Error("Only a completed worker run for this task can receive campaign validation.");
    }
    if (validatedRun && validatedRun.measurement?.source !== "csr-owned-codex-exec") {
      throw new Error("Campaign run validation requires CSR-owned worker measurement.");
    }
    const normalizedStatus = ["passed", "failed", "reviewer-verified"].includes(status) ? status : "failed";
    const requestedWorkerTokens = Number(workerTokens);
    const measuredWorkerTokens = Number.isFinite(requestedWorkerTokens) && requestedWorkerTokens > 0
      ? requestedWorkerTokens
      : null;
    const requestedMeasurementStatus = tokenMeasurement?.status || (measuredWorkerTokens === null ? "unknown" : "measured");
    const normalizedTokenMeasurement = {
      source: String(tokenMeasurement?.source || (measuredWorkerTokens === null ? "unknown" : "manual")),
      status: requestedMeasurementStatus === "measured" && measuredWorkerTokens !== null ? "measured" : "unknown",
      session: tokenMeasurement?.session && typeof tokenMeasurement.session === "object" ? redactValue(tokenMeasurement.session) : null
    };
    const result = {
      status: normalizedStatus,
      source: validatedRun ? "csr-owned-codex-exec" : String(source),
      workerTokens: validatedRun ? validatedRun.measurement.workerTokens : measuredWorkerTokens,
      elapsedMs: validatedRun ? validatedRun.measurement.elapsedMs : (Number.isFinite(Number(elapsedMs)) ? Number(elapsedMs) : null),
      cohort: cohort || manifest.tasks[index].cohort || null,
      revision: Number.isInteger(revision) ? revision : manifest.tasks[index].revision,
      evidenceRefs: Array.isArray(evidenceRefs) ? evidenceRefs.map(String) : [],
      tokenMeasurement: validatedRun
        ? {
            source: "csr-owned-codex-exec",
            status: validatedRun.measurement.status === "measured" && validatedRun.measurement.workerTokens !== null ? "measured" : "unknown",
            session: validatedRun.measurement.session && typeof validatedRun.measurement.session === "object" ? redactValue(validatedRun.measurement.session) : null
          }
        : normalizedTokenMeasurement,
      recordedAt: now()
    };
    manifest.tasks[index] = {
      ...manifest.tasks[index],
      status: normalizedStatus === "failed" ? "failed" : "completed",
      cohort: result.cohort,
      revision: result.revision,
      validation: result
    };
    if (validatedRun) {
      manifest.runs[runIndex] = {
        ...validatedRun,
        validation: result
      };
    }
    await appendEventWithManifest(paths, manifest, {
      type: `validation.${normalizedStatus}`,
      role: "worker",
      taskId,
      revision: result.revision,
      data: { ...result, runId: runId || null }
    });
    return result;
  });
}

export async function registerCampaignPatch({
  rootDir,
  id,
  assetPath,
  baseContent,
  nextContent,
  revision,
  comparisons = [],
  rationale = ""
}) {
  const paths = campaignPaths(rootDir, id);
  return withCampaignLock(paths, async () => {
    const manifest = await readManifest(paths);
    const safeAsset = assertAssetPath(assetPath, manifest.cwd);
    const metadata = await lstat(safeAsset.assetPath).catch(() => null);

    if (!metadata || !metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("Automatic campaign patches require an existing non-symlink instruction asset.");
    }

    const currentContent = await readFile(safeAsset.assetPath, "utf8");
    if (sha256(currentContent) !== sha256(baseContent)) {
      throw new Error("Candidate patch base does not match the current instruction asset; refresh evidence before registering it.");
    }

    const patch = {
      id: `patch-${String(manifest.patches.length + 1).padStart(3, "0")}`,
      assetPath: safeAsset.assetPath,
      relativePath: safeAsset.relativePath,
      baseContent: redactSensitiveText(String(baseContent ?? "")),
      nextContent: redactSensitiveText(String(nextContent ?? "")),
      baseHash: sha256(baseContent),
      nextHash: sha256(nextContent),
      revision: Number.isInteger(revision) ? revision : manifest.revisions.at(-1)?.number || 1,
      comparisons: redactValue(comparisons),
      rationale: redactSensitiveText(String(rationale || "")),
      state: "candidate",
      createdAt: now(),
      appliedAt: null,
      appliedHash: null
    };
    manifest.patches.push(patch);
    await appendEventWithManifest(paths, manifest, {
      type: "patch.candidate",
      role: "reviewer",
      revision: patch.revision,
      data: { id: patch.id, relativePath: patch.relativePath, eligibility: patchCanPromote(patch, manifest) }
    });
    return patch;
  });
}

export async function promoteCampaignPatch({ rootDir, id, patchId }) {
  const paths = campaignPaths(rootDir, id);
  return withCampaignLock(paths, async () => {
    const manifest = await readManifest(paths);
    const index = manifest.patches.findIndex((patch) => patch.id === patchId);

    if (index < 0) {
      throw new Error(`Patch "${patchId}" was not found.`);
    }

    const patch = manifest.patches[index];
    const eligibility = patchCanPromote(patch, manifest);

    if (!eligibility.eligible) {
      throw new Error(`Patch "${patch.id}" needs ${eligibility.requiredComparisons} successful token-saving comparisons before promotion.`);
    }

    assertAssetPath(patch.assetPath, manifest.cwd);
    const details = await lstat(patch.assetPath);
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new Error("Patch target is no longer a regular file.");
    }

    const currentContent = await readFile(patch.assetPath, "utf8");
    const merged = await mergeCandidate({ currentContent, baseContent: patch.baseContent, nextContent: patch.nextContent });
    assertPromotedAssetContent(patch.assetPath, merged.content);
    await writeFile(patch.assetPath, merged.content, "utf8");
    patch.state = "applied";
    patch.appliedAt = now();
    patch.appliedHash = sha256(merged.content);
    patch.mergeStrategy = merged.strategy;
    manifest.patches[index] = patch;
    await appendEventWithManifest(paths, manifest, {
      type: "patch.applied",
      role: "coordinator",
      revision: patch.revision,
      data: { id: patch.id, relativePath: patch.relativePath, mergeStrategy: merged.strategy }
    });
    return patch;
  });
}

export async function rollbackCampaignPatch({ rootDir, id, patchId }) {
  const paths = campaignPaths(rootDir, id);
  return withCampaignLock(paths, async () => {
    const manifest = await readManifest(paths);
    const index = manifest.patches.findIndex((patch) => patch.id === patchId);

    if (index < 0) {
      throw new Error(`Patch "${patchId}" was not found.`);
    }

    const patch = manifest.patches[index];
    if (patch.state !== "applied" || !patch.appliedHash) {
      throw new Error(`Patch "${patch.id}" is not an applied patch.`);
    }

    const currentContent = await readFile(patch.assetPath, "utf8");
    if (sha256(currentContent) !== patch.appliedHash) {
      throw new Error("Patch target changed after application; rollback refuses to overwrite it.");
    }

    await writeFile(patch.assetPath, patch.baseContent, "utf8");
    patch.state = "rolled-back";
    patch.rolledBackAt = now();
    manifest.patches[index] = patch;
    await appendEventWithManifest(paths, manifest, {
      type: "patch.rolled-back",
      role: "coordinator",
      revision: patch.revision,
      data: { id: patch.id, relativePath: patch.relativePath }
    });
    return patch;
  });
}

export function getPatchPromotionStatus(patch, manifest = null) {
  return patchCanPromote(patch, manifest);
}
