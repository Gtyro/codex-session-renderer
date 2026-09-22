import { execFile as execFileCallback } from "node:child_process";
import { copyFile, mkdir, open, readFile, readdir, rm, rename, rmdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parseIdeContextMessagePresentation, parseUserMessagePresentation } from "../shared/message-presentation.js";

const SESSION_ID_PATTERN = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const ANSI_PATTERN = /[\u001b\u009b][[\]()#;?]*(?:(?:\d{1,4}(?:;\d{0,4})*)?[0-9A-ORZcf-nqry=><~]|.)/gu;
const STANDALONE_PING_PATTERN = /^ping(?:[\s.!?。！？]*)$/iu;
const SESSION_INDEX_FILE_NAME = "session_index.jsonl";
const STATE_DATABASE_FILE_PATTERN = /^state_(\d+)\.sqlite$/u;
const PING_DETECTION_HEADER_BYTES = 16 * 1024;
const INTERNAL_APPROVAL_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const SESSION_METADATA_HEADER_BYTES = 4 * 1024;
const SQLITE_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const pingSessionCache = new Map();
const sessionMetadataCache = new Map();
const execFile = promisify(execFileCallback);

export const SESSION_LOCATIONS = {
  sessions: "sessions",
  archived: "archived_sessions"
};

export function getDefaultCodexDir() {
  return path.join(os.homedir(), ".codex");
}

export function getDefaultSessionsDir(codexDir = getDefaultCodexDir()) {
  return path.join(path.resolve(codexDir), SESSION_LOCATIONS.sessions);
}

export function getDefaultArchivedSessionsDir(codexDir = getDefaultCodexDir()) {
  return path.join(path.resolve(codexDir), SESSION_LOCATIONS.archived);
}

export function getSessionRoots(options = {}) {
  const codexDir = options.codexDir ? path.resolve(options.codexDir) : getDefaultCodexDir();

  return {
    codexDir,
    sessionsDir: options.sessionsDir
      ? path.resolve(options.sessionsDir)
      : getDefaultSessionsDir(codexDir),
    archivedSessionsDir: options.archivedSessionsDir
      ? path.resolve(options.archivedSessionsDir)
      : getDefaultArchivedSessionsDir(codexDir)
  };
}

async function collectSessionFiles(rootDir) {
  let entries;

  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectSessionFiles(fullPath)));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }

  return files;
}

function normalizeText(value) {
  return String(value ?? "")
    .replace(ANSI_PATTERN, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
}

function normalizeWorkspace(value) {
  const workspace = String(value ?? "").trim();

  if (!workspace) {
    return null;
  }

  // Codex records an absolute cwd, but avoid using the host platform's path
  // rules here: old sessions can originate from another OS or a remote host.
  const withoutTrailingSeparator = workspace.replace(/[\\/]+$/u, "");
  return withoutTrailingSeparator || workspace;
}

function looksLikeContextPrelude(text) {
  return (
    text.includes("# AGENTS.md instructions") ||
    text.includes("<environment_context>") ||
    text.includes("<permissions instructions>") ||
    text.includes("<collaboration_mode>")
  );
}

function parseMessageBlocks(content) {
  const blocks = Array.isArray(content) ? content : [];

  return blocks
    .map((block) => {
      if (!block || typeof block !== "object") {
        return "";
      }

      if ((block.type === "input_text" || block.type === "output_text") && typeof block.text === "string") {
        return normalizeText(block.text);
      }

      return normalizeText(JSON.stringify(block, null, 2));
    })
    .filter(Boolean)
    .join("\n\n");
}

function isStandalonePingText(text) {
  return STANDALONE_PING_PATTERN.test(normalizeText(text));
}

function sessionIdFromPath(filePath) {
  const match = path.basename(filePath).match(SESSION_ID_PATTERN);
  return match ? match[1] : path.basename(filePath, ".jsonl");
}

function normalizeThreadName(value) {
  const normalized = String(value ?? "").replace(/\s+/gu, " ").trim();

  if (!normalized) {
    throw new Error("Session title cannot be empty.");
  }

  return normalized;
}

function getSessionIndexPath(codexDir) {
  return path.join(path.resolve(codexDir), SESSION_INDEX_FILE_NAME);
}

function readThreadName(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}

function getThreadDisplayName(value) {
  const threadName = readThreadName(value);

  if (!threadName) {
    return null;
  }

  const requestText =
    parseIdeContextMessagePresentation(threadName)?.requestText ||
    parseUserMessagePresentation(threadName)?.requestText ||
    null;

  return requestText ? requestText.replace(/\s+/gu, " ").trim() : threadName;
}

function escapeSqliteValue(value) {
  return `'${String(value ?? "").replaceAll("'", "''")}'`;
}

async function findStateDatabasePath(codexDir) {
  let entries;

  try {
    entries = await readdir(path.resolve(codexDir), { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }

  let selectedPath = null;
  let selectedVersion = -1;

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const match = entry.name.match(STATE_DATABASE_FILE_PATTERN);

    if (!match) {
      continue;
    }

    const version = Number.parseInt(match[1], 10);

    if (!Number.isFinite(version) || version < selectedVersion) {
      continue;
    }

    if (version === selectedVersion && selectedPath && entry.name.localeCompare(path.basename(selectedPath)) <= 0) {
      continue;
    }

    selectedPath = path.join(path.resolve(codexDir), entry.name);
    selectedVersion = version;
  }

  return selectedPath;
}

async function runSqliteJsonQuery(databasePath, sql) {
  if (!databasePath) {
    return null;
  }

  try {
    const { stdout } = await execFile("sqlite3", ["-json", databasePath, sql], {
      maxBuffer: SQLITE_MAX_BUFFER_BYTES
    });
    const trimmed = stdout.trim();
    return trimmed ? JSON.parse(trimmed) : [];
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function loadSessionIndexThreadNames(codexDir) {
  const indexPath = getSessionIndexPath(codexDir);
  let source;

  try {
    source = await readFile(indexPath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return new Map();
    }

    throw error;
  }

  const threadNamesById = new Map();

  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();

    if (!line) {
      continue;
    }

    let entry;

    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (!entry || typeof entry !== "object" || typeof entry.id !== "string") {
      continue;
    }

    const threadName = readThreadName(entry.thread_name);

    if (threadName) {
      threadNamesById.set(entry.id, threadName);
    }
  }

  return threadNamesById;
}

async function updateSessionThreadName(codexDir, sessionId, threadName) {
  const normalizedThreadName = normalizeThreadName(threadName);
  const indexPath = getSessionIndexPath(codexDir);
  const updatedAt = new Date().toISOString();
  let source = "";

  try {
    source = await readFile(indexPath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return {
        found: false,
        changed: false
      };
    }

    throw error;
  }

  const lines = source
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter(Boolean);
  let matched = false;
  let changed = false;
  const updatedLines = lines.map((line) => {
    let entry;

    try {
      entry = JSON.parse(line);
    } catch {
      return line;
    }

    if (!entry || typeof entry !== "object" || entry.id !== sessionId) {
      return line;
    }

    matched = true;
    const currentThreadName = readThreadName(entry.thread_name);

    if (currentThreadName === normalizedThreadName) {
      return line;
    }

    changed = true;
    return JSON.stringify({
      ...entry,
      id: sessionId,
      thread_name: normalizedThreadName,
      updated_at: updatedAt
    });
  });

  if (!matched || !changed) {
    return {
      found: matched,
      changed: false
    };
  }

  await mkdir(path.dirname(indexPath), { recursive: true });
  await writeFile(indexPath, `${updatedLines.join("\n")}\n`, "utf8");
  return {
    found: true,
    changed: true
  };
}

async function loadStateThreadNames(codexDir) {
  const databasePath = await findStateDatabasePath(codexDir);

  try {
    const rows = await runSqliteJsonQuery(
      databasePath,
      "SELECT id, title FROM threads WHERE title <> '';"
    );

    if (!rows) {
      return new Map();
    }

    const threadNamesById = new Map();

    for (const row of rows) {
      if (!row || typeof row !== "object" || typeof row.id !== "string") {
        continue;
      }

      const threadName = readThreadName(row.title);

      if (threadName) {
        threadNamesById.set(row.id, threadName);
      }
    }

    return threadNamesById;
  } catch {
    return new Map();
  }
}

async function loadSessionThreadNames(codexDir) {
  const [indexThreadNamesById, stateThreadNamesById] = await Promise.all([
    loadSessionIndexThreadNames(codexDir),
    loadStateThreadNames(codexDir)
  ]);
  const resolvedThreadNamesById = new Map(stateThreadNamesById);

  for (const [id, threadName] of indexThreadNamesById) {
    resolvedThreadNamesById.set(id, threadName);
  }

  return {
    resolvedThreadNamesById,
    indexThreadNamesById,
    stateThreadNamesById
  };
}

async function readStateThreadTitle(databasePath, sessionId) {
  const rows = await runSqliteJsonQuery(
    databasePath,
    `SELECT title FROM threads WHERE id = ${escapeSqliteValue(sessionId)} LIMIT 1;`
  );

  if (!rows) {
    return {
      available: false,
      found: false,
      rawTitle: null,
      threadName: null
    };
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      available: true,
      found: false,
      rawTitle: null,
      threadName: null
    };
  }

  const rawTitle = typeof rows[0]?.title === "string" ? rows[0].title : "";

  return {
    available: true,
    found: true,
    rawTitle,
    threadName: readThreadName(rawTitle)
  };
}

async function writeStateThreadTitle(databasePath, sessionId, threadName) {
  const rows = await runSqliteJsonQuery(
    databasePath,
    `UPDATE threads
SET title = ${escapeSqliteValue(threadName)}
WHERE id = ${escapeSqliteValue(sessionId)};
SELECT changes() AS changes;`
  );

  if (!rows) {
    return {
      available: false,
      changed: false
    };
  }

  return {
    available: true,
    changed: Number(rows[0]?.changes ?? 0) > 0
  };
}

async function loadStateThreadColumns(databasePath) {
  const rows = await runSqliteJsonQuery(databasePath, "PRAGMA table_info(threads);");

  if (!rows) {
    return null;
  }

  const columns = new Set();

  for (const row of rows) {
    if (row && typeof row.name === "string" && row.name) {
      columns.add(row.name);
    }
  }

  return columns;
}

async function readStateThreadRecord(databasePath, sessionId) {
  const rows = await runSqliteJsonQuery(
    databasePath,
    `SELECT id FROM threads WHERE id = ${escapeSqliteValue(sessionId)} LIMIT 1;`
  );

  if (!rows) {
    return {
      available: false,
      found: false
    };
  }

  return {
    available: true,
    found: Array.isArray(rows) && rows.length > 0
  };
}

async function writeStateThreadLocation(databasePath, sessionId, locationUpdate, columns = null) {
  const availableColumns = columns ?? (await loadStateThreadColumns(databasePath));

  if (!availableColumns) {
    return {
      available: false,
      found: false,
      changed: false
    };
  }

  const record = await readStateThreadRecord(databasePath, sessionId);

  if (!record.available) {
    return {
      available: false,
      found: false,
      changed: false
    };
  }

  if (!record.found) {
    return {
      available: true,
      found: false,
      changed: false
    };
  }

  const updatedAtMs = Number(locationUpdate.updatedAtMs);
  const updatedAtSeconds = Math.floor(updatedAtMs / 1000);
  const assignments = [];

  if (availableColumns.has("rollout_path")) {
    assignments.push(`rollout_path = ${escapeSqliteValue(locationUpdate.rolloutPath)}`);
  }

  if (availableColumns.has("archived")) {
    assignments.push(`archived = ${locationUpdate.archived ? 1 : 0}`);
  }

  if (availableColumns.has("archived_at")) {
    assignments.push(
      locationUpdate.archived
        ? `archived_at = ${updatedAtSeconds}`
        : "archived_at = NULL"
    );
  }

  if (availableColumns.has("updated_at")) {
    assignments.push(`updated_at = ${updatedAtSeconds}`);
  }

  if (availableColumns.has("updated_at_ms")) {
    assignments.push(`updated_at_ms = ${updatedAtMs}`);
  }

  if (assignments.length === 0) {
    return {
      available: true,
      found: true,
      changed: false
    };
  }

  const rows = await runSqliteJsonQuery(
    databasePath,
    `UPDATE threads
SET ${assignments.join(",\n    ")}
WHERE id = ${escapeSqliteValue(sessionId)};
SELECT changes() AS changes;`
  );

  if (!rows) {
    return {
      available: false,
      found: false,
      changed: false
    };
  }

  return {
    available: true,
    found: true,
    changed: Number(rows[0]?.changes ?? 0) > 0
  };
}

function normalizeLocation(location) {
  if (location === SESSION_LOCATIONS.sessions || location === "active") {
    return SESSION_LOCATIONS.sessions;
  }

  if (location === SESSION_LOCATIONS.archived || location === "archived") {
    return SESSION_LOCATIONS.archived;
  }

  throw new Error(`Unsupported session location: ${location}`);
}

function normalizeRelativeSessionPath(relativePath) {
  const normalized = path.posix
    .normalize(String(relativePath ?? "").replaceAll("\\", "/"))
    .replace(/^(\.\/)+/u, "");

  if (!normalized || normalized === "." || normalized.startsWith("../")) {
    throw new Error(`Invalid relative session path: ${relativePath}`);
  }

  return normalized;
}

function canonicalizeTargetRelativeSessionPath(relativePath) {
  const normalizedRelativePath = normalizeRelativeSessionPath(relativePath);

  if (normalizedRelativePath.includes("/")) {
    return normalizedRelativePath;
  }

  const match = /^rollout-(\d{4})-(\d{2})-(\d{2})T.+\.jsonl$/u.exec(normalizedRelativePath);

  if (!match) {
    return normalizedRelativePath;
  }

  const [, year, month, day] = match;
  return `${year}/${month}/${day}/${normalizedRelativePath}`;
}

function toRelativeSessionPath(rootDir, filePath) {
  return path.relative(rootDir, filePath).split(path.sep).join("/");
}

function resolveSessionPath(rootDir, relativePath) {
  const normalizedRelativePath = normalizeRelativeSessionPath(relativePath);
  const targetPath = path.resolve(rootDir, ...normalizedRelativePath.split("/"));
  const normalizedRoot = path.resolve(rootDir);
  const relative = path.relative(normalizedRoot, targetPath);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Session path escapes the configured root: ${relativePath}`);
  }

  return targetPath;
}

function getDirectoryForLocation(roots, location) {
  const normalizedLocation = normalizeLocation(location);
  return normalizedLocation === SESSION_LOCATIONS.archived
    ? roots.archivedSessionsDir
    : roots.sessionsDir;
}

async function readUtf8FileHead(filePath, maxBytes) {
  const handle = await open(filePath, "r");
  const buffer = Buffer.allocUnsafe(maxBytes);

  try {
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return {
      bytesRead,
      source: buffer.toString("utf8", 0, bytesRead)
    };
  } finally {
    await handle.close();
  }
}

function getSessionMetadata(payload) {
  const startedAtMs = Date.parse(payload?.timestamp || "");

  return {
    workspace: normalizeWorkspace(payload?.cwd),
    startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : null,
    isGuardianReview: payload?.source?.subagent?.other === "guardian"
  };
}

function readJsonStringProperty(source, propertyName) {
  const expression = new RegExp(`"${propertyName}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`, "u");
  const match = expression.exec(source);

  if (!match) {
    return null;
  }

  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function readTruncatedSessionMetadata(source) {
  if (
    !/^\s*\{/u.test(source) ||
    !/"type"\s*:\s*"session_meta"/u.test(source) ||
    !/"payload"\s*:\s*\{/u.test(source)
  ) {
    return null;
  }

  const startedAtMs = Date.parse(readJsonStringProperty(source, "timestamp") || "");

  return {
    workspace: normalizeWorkspace(readJsonStringProperty(source, "cwd")),
    startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : null,
    isGuardianReview:
      /"source"\s*:\s*\{\s*"subagent"\s*:\s*\{\s*"other"\s*:\s*"guardian"\s*\}\s*\}/u.test(
        source
      )
  };
}

async function readSessionMetadata(filePath, fileStat = null) {
  const cached = sessionMetadataCache.get(filePath);

  if (cached && fileStat && cached.modifiedMs === fileStat.mtimeMs && cached.sizeBytes === fileStat.size) {
    return cached.metadata;
  }

  let bytesRead;
  let source;

  try {
    ({ bytesRead, source } = await readUtf8FileHead(filePath, SESSION_METADATA_HEADER_BYTES));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      sessionMetadataCache.delete(filePath);
      return null;
    }

    throw error;
  }

  let metadata = getSessionMetadata(null);

  const reachedEnd = !fileStat || bytesRead >= fileStat.size;
  const rawLines = source.split(/\r?\n/u);
  const lines =
    !reachedEnd && !source.endsWith("\n") && !source.endsWith("\r") ? rawLines.slice(0, -1) : rawLines;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) {
      continue;
    }

    let entry;

    try {
      entry = JSON.parse(line);
    } catch {
      break;
    }

    if (entry?.type !== "session_meta") {
      break;
    }

    metadata = getSessionMetadata(entry.payload);
    break;
  }

  if (!metadata.isGuardianReview && lines.length !== rawLines.length) {
    metadata = readTruncatedSessionMetadata(rawLines.at(-1).trim()) || metadata;
  }

  if (fileStat) {
    sessionMetadataCache.set(filePath, {
      modifiedMs: fileStat.mtimeMs,
      sizeBytes: fileStat.size,
      metadata
    });
  }

  return metadata;
}

async function readSessionWorkspace(filePath, fileStat = null) {
  return (await readSessionMetadata(filePath, fileStat))?.workspace || null;
}

async function isStandalonePingSessionFile(filePath, fileStat) {
  const cached = pingSessionCache.get(filePath);

  if (cached && cached.modifiedMs === fileStat.mtimeMs && cached.sizeBytes === fileStat.size) {
    return cached.isStandalonePing;
  }

  let isStandalonePing = false;

  try {
    const { bytesRead, source } = await readUtf8FileHead(filePath, PING_DETECTION_HEADER_BYTES);
    const reachedEnd = bytesRead >= fileStat.size;
    const rawLines = source.split(/\r?\n/u);
    const lines =
      !reachedEnd && !source.endsWith("\n") && !source.endsWith("\r") ? rawLines.slice(0, -1) : rawLines;
    let userMessageCount = 0;
    let hasNonPingUserMessage = false;

    for (const rawLine of lines) {
      const line = rawLine.trim();

      if (!line) {
        continue;
      }

      let entry;

      try {
        entry = JSON.parse(line);
      } catch {
        hasNonPingUserMessage = true;
        break;
      }

      if (entry.type !== "response_item") {
        continue;
      }

      const payload = entry.payload || {};

      if (payload.type !== "message" || payload.role !== "user") {
        continue;
      }

      const text = parseMessageBlocks(payload.content);

      if (!text || looksLikeContextPrelude(text)) {
        continue;
      }

      userMessageCount += 1;

      if (userMessageCount > 1 || !isStandalonePingText(text)) {
        hasNonPingUserMessage = true;
        break;
      }
    }

    isStandalonePing = userMessageCount === 1 && !hasNonPingUserMessage;
  } catch (error) {
    if (error && error.code === "ENOENT") {
      pingSessionCache.delete(filePath);
      sessionMetadataCache.delete(filePath);
      return false;
    }

    throw error;
  }

  pingSessionCache.set(filePath, {
    modifiedMs: fileStat.mtimeMs,
    sizeBytes: fileStat.size,
    isStandalonePing
  });

  return isStandalonePing;
}

async function readInternalApprovalSessionInfo(filePath, fileStat) {
  const metadata = await readSessionMetadata(filePath, fileStat);

  return metadata?.isGuardianReview
    ? {
        startedAtMs: metadata.startedAtMs
      }
    : null;
}

function isExpiredInternalApprovalSession(info, now = Date.now()) {
  return (
    Number.isFinite(info?.startedAtMs) &&
    now - info.startedAtMs >= INTERNAL_APPROVAL_RETENTION_MS
  );
}

async function removeEmptyParents(startDir, stopDir) {
  const normalizedStopDir = path.resolve(stopDir);
  let currentDir = path.resolve(startDir);

  while (currentDir !== normalizedStopDir) {
    const relative = path.relative(normalizedStopDir, currentDir);

    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return;
    }

    try {
      await rmdir(currentDir);
    } catch (error) {
      if (error && (error.code === "ENOTEMPTY" || error.code === "ENOENT")) {
        return;
      }

      throw error;
    }

    currentDir = path.dirname(currentDir);
  }
}

async function deleteTransientSessionFile(filePath, rootDir) {
  await rm(filePath, { force: true });
  pingSessionCache.delete(filePath);
  sessionMetadataCache.delete(filePath);
  await removeEmptyParents(path.dirname(filePath), rootDir);
}

async function getSessionRetentionState(filePath, fileStat, location) {
  const normalizedLocation = normalizeLocation(location);

  if (
    normalizedLocation === SESSION_LOCATIONS.sessions &&
    (await isStandalonePingSessionFile(filePath, fileStat))
  ) {
    return "standalone-ping";
  }

  const internalApprovalInfo = await readInternalApprovalSessionInfo(filePath, fileStat);

  if (internalApprovalInfo) {
    return isExpiredInternalApprovalSession(internalApprovalInfo)
      ? "expired-internal-approval"
      : "internal-approval";
  }

  return "retained";
}

function shouldDeleteTransientSession(retentionState) {
  return retentionState === "standalone-ping" || retentionState === "expired-internal-approval";
}

async function moveSessionFile(sourcePath, targetPath) {
  try {
    await rename(sourcePath, targetPath);
  } catch (error) {
    if (error && error.code === "EXDEV") {
      await copyFile(sourcePath, targetPath);
      await rm(sourcePath, { force: true });
      return;
    }

    throw error;
  }
}

async function readSessionRecordIfRetained(filePath, rootDir, location, threadNamesById = new Map()) {
  const normalizedLocation = normalizeLocation(location);
  let fileStat;

  try {
    fileStat = await stat(filePath);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      pingSessionCache.delete(filePath);
      sessionMetadataCache.delete(filePath);
      return null;
    }

    throw error;
  }

  if ((await getSessionRetentionState(filePath, fileStat, normalizedLocation)) !== "retained") {
    return null;
  }

  const id = sessionIdFromPath(filePath);

  const threadName = threadNamesById.get(id) ?? null;

  return {
    id,
    filePath,
    relativePath: toRelativeSessionPath(rootDir, filePath),
    location: normalizedLocation,
    threadName,
    displayName: getThreadDisplayName(threadName),
    workspace: await readSessionWorkspace(filePath, fileStat),
    modifiedAt: new Date(fileStat.mtimeMs).toISOString(),
    modifiedMs: fileStat.mtimeMs,
    sizeBytes: fileStat.size
  };
}

async function filterRetainedSessionFiles(filePaths, rootDir, location) {
  const normalizedLocation = normalizeLocation(location);
  const retained = await Promise.all(
    filePaths.map(async (filePath) => {
      let fileStat;

      try {
        fileStat = await stat(filePath);
      } catch (error) {
        if (error && error.code === "ENOENT") {
          pingSessionCache.delete(filePath);
          sessionMetadataCache.delete(filePath);
          return null;
        }

        throw error;
      }

      if ((await getSessionRetentionState(filePath, fileStat, normalizedLocation)) !== "retained") {
        return null;
      }

      return filePath;
    })
  );

  return retained.filter(Boolean);
}

async function mutateSessionLocation({
  fromLocation,
  toLocation,
  relativePath,
  sessionsDir,
  archivedSessionsDir,
  codexDir
}) {
  const roots = getSessionRoots({ sessionsDir, archivedSessionsDir, codexDir });
  const sourceRoot = getDirectoryForLocation(roots, fromLocation);
  const targetRoot = getDirectoryForLocation(roots, toLocation);
  const sourceRelativePath = normalizeRelativeSessionPath(relativePath);
  const targetRelativePath = canonicalizeTargetRelativeSessionPath(sourceRelativePath);
  const sourcePath = resolveSessionPath(sourceRoot, sourceRelativePath);
  const targetPath = resolveSessionPath(targetRoot, targetRelativePath);
  const sessionId = sessionIdFromPath(sourcePath);
  const stateDatabasePath = await findStateDatabasePath(roots.codexDir);
  const stateThreadColumns = await loadStateThreadColumns(stateDatabasePath);

  await mkdir(path.dirname(targetPath), { recursive: true });

  try {
    await stat(sourcePath);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error(`Session was not found: ${sourceRelativePath}`);
    }

    throw error;
  }

  try {
    await stat(targetPath);
    throw new Error(
      `Cannot move session because the destination already exists: ${targetRelativePath}`
    );
  } catch (error) {
    if (!(error && error.code === "ENOENT")) {
      throw error;
    }
  }

  await moveSessionFile(sourcePath, targetPath);
  pingSessionCache.delete(sourcePath);
  sessionMetadataCache.delete(sourcePath);

  try {
    await writeStateThreadLocation(
      stateDatabasePath,
      sessionId,
      {
        archived: normalizeLocation(toLocation) === SESSION_LOCATIONS.archived,
        rolloutPath: targetPath,
        updatedAtMs: Date.now()
      },
      stateThreadColumns
    );
  } catch (error) {
    try {
      await moveSessionFile(targetPath, sourcePath);
      pingSessionCache.delete(targetPath);
      sessionMetadataCache.delete(targetPath);
      await removeEmptyParents(path.dirname(targetPath), targetRoot);
    } catch {
      // Best effort rollback. Prefer surfacing the original DB sync failure.
    }

    throw error;
  }

  await removeEmptyParents(path.dirname(sourcePath), sourceRoot);

  return getSessionRecord({
    ...roots,
    location: normalizeLocation(toLocation),
    relativePath: targetRelativePath
  });
}

export async function listSessions(options = {}) {
  const roots = getSessionRoots(options);
  const { resolvedThreadNamesById } = await loadSessionThreadNames(roots.codexDir);
  const locations = [
    {
      location: SESSION_LOCATIONS.sessions,
      rootDir: roots.sessionsDir
    },
    {
      location: SESSION_LOCATIONS.archived,
      rootDir: roots.archivedSessionsDir
    }
  ];
  const nestedEntries = await Promise.all(
    locations.map(async ({ location, rootDir }) => {
      const files = await collectSessionFiles(rootDir);
      return Promise.all(
        files.map((filePath) =>
          readSessionRecordIfRetained(filePath, rootDir, location, resolvedThreadNamesById)
        )
      );
    })
  );

  return nestedEntries
    .flat()
    .filter(Boolean)
    .sort((left, right) => right.modifiedMs - left.modifiedMs || left.id.localeCompare(right.id));
}

export async function cleanupTransientSessions(options = {}) {
  const roots = getSessionRoots(options);
  const locations = [
    {
      location: SESSION_LOCATIONS.sessions,
      rootDir: roots.sessionsDir
    },
    {
      location: SESSION_LOCATIONS.archived,
      rootDir: roots.archivedSessionsDir
    }
  ];

  await Promise.all(
    locations.map(async ({ location, rootDir }) => {
      const files = await collectSessionFiles(rootDir);
      await Promise.all(
        files.map(async (filePath) => {
          let fileStat;

          try {
            fileStat = await stat(filePath);
          } catch (error) {
            if (error && error.code === "ENOENT") {
              pingSessionCache.delete(filePath);
              sessionMetadataCache.delete(filePath);
              return;
            }

            throw error;
          }

          const retentionState = await getSessionRetentionState(filePath, fileStat, location);

          if (shouldDeleteTransientSession(retentionState)) {
            await deleteTransientSessionFile(filePath, rootDir);
          }
        })
      );
    })
  );
}

export async function getSessionRecord({ location, relativePath, ...options }) {
  const roots = getSessionRoots(options);
  const rootDir = getDirectoryForLocation(roots, location);
  const filePath = resolveSessionPath(rootDir, relativePath);
  const { resolvedThreadNamesById } = await loadSessionThreadNames(roots.codexDir);
  const record = await readSessionRecordIfRetained(
    filePath,
    rootDir,
    normalizeLocation(location),
    resolvedThreadNamesById
  );

  if (!record) {
    throw new Error(`Session was not found: ${relativePath}`);
  }

  return record;
}

export async function resolveSessionFile({
  sessionsDir,
  archivedSessionsDir,
  codexDir,
  latest,
  id,
  location = SESSION_LOCATIONS.sessions,
  includeArchived = false
}) {
  const roots = getSessionRoots({ sessionsDir, archivedSessionsDir, codexDir });
  const requestedLocations = includeArchived
    ? [SESSION_LOCATIONS.sessions, SESSION_LOCATIONS.archived]
    : [normalizeLocation(location)];
  const files = (
    await Promise.all(
      requestedLocations.map(async (requestedLocation) => {
        const rootDir = getDirectoryForLocation(roots, requestedLocation);
        const rootFiles = await collectSessionFiles(rootDir);
        return filterRetainedSessionFiles(rootFiles, rootDir, requestedLocation);
      })
    )
  )
    .flat()
    .sort((left, right) => left.localeCompare(right));
  const searchedRoots = requestedLocations
    .map((requestedLocation) => getDirectoryForLocation(roots, requestedLocation))
    .join(", ");

  if (files.length === 0) {
    throw new Error(`No session files were found in ${searchedRoots}`);
  }

  if (latest) {
    return files.at(-1);
  }

  const normalizedId = String(id).toLowerCase();
  const matches = files.filter((filePath) =>
    sessionIdFromPath(filePath).toLowerCase().includes(normalizedId)
  );

  if (matches.length === 0) {
    throw new Error(`No session matched ID fragment "${id}" in ${searchedRoots}`);
  }

  if (matches.length > 1) {
    const candidates = matches
      .slice(0, 10)
      .map((filePath) => `- ${sessionIdFromPath(filePath)} (${filePath})`)
      .join("\n");
    throw new Error(`More than one session matched "${id}":\n${candidates}`);
  }

  return matches[0];
}

export function extractSessionId(filePath) {
  return sessionIdFromPath(filePath);
}

export async function archiveSession(options) {
  return mutateSessionLocation({
    ...options,
    fromLocation: SESSION_LOCATIONS.sessions,
    toLocation: SESSION_LOCATIONS.archived
  });
}

export async function restoreSession(options) {
  return mutateSessionLocation({
    ...options,
    fromLocation: SESSION_LOCATIONS.archived,
    toLocation: SESSION_LOCATIONS.sessions
  });
}

export async function renameSession({ location, relativePath, name, ...options }) {
  const normalizedLocation = normalizeLocation(location);
  const roots = getSessionRoots(options);
  const sourceRecord = await getSessionRecord({
    ...roots,
    location: normalizedLocation,
    relativePath
  });
  const normalizedThreadName = normalizeThreadName(name);
  const stateDatabasePath = await findStateDatabasePath(roots.codexDir);
  const stateThreadTitle = await readStateThreadTitle(stateDatabasePath, sourceRecord.id);
  const canWriteStateTitle = stateThreadTitle.available && stateThreadTitle.found;
  let stateTitleChanged = false;

  if (canWriteStateTitle && stateThreadTitle.threadName !== normalizedThreadName) {
    const updateResult = await writeStateThreadTitle(
      stateDatabasePath,
      sourceRecord.id,
      normalizedThreadName
    );

    if (!updateResult.available) {
      throw new Error("Failed to update the Codex state database.");
    }

    stateTitleChanged = updateResult.changed;
  }

  let indexUpdateResult;

  try {
    indexUpdateResult = await updateSessionThreadName(
      roots.codexDir,
      sourceRecord.id,
      normalizedThreadName
    );
  } catch (error) {
    if (stateTitleChanged) {
      try {
        await writeStateThreadTitle(stateDatabasePath, sourceRecord.id, stateThreadTitle.rawTitle ?? "");
      } catch {
        // Best effort rollback. If this fails, surfacing the original rename error is still more useful.
      }
    }

    throw error;
  }

  if (!canWriteStateTitle && !indexUpdateResult.found) {
    throw new Error("Cannot rename this session because no writable title metadata was found.");
  }

  return getSessionRecord({
    ...roots,
    location: normalizedLocation,
    relativePath
  });
}

export async function deleteSession({ location, relativePath, ...options }) {
  const normalizedLocation = normalizeLocation(location);

  if (normalizedLocation !== SESSION_LOCATIONS.archived) {
    throw new Error("Only archived sessions can be deleted.");
  }

  const roots = getSessionRoots(options);
  const rootDir = getDirectoryForLocation(roots, normalizedLocation);
  const targetPath = resolveSessionPath(rootDir, relativePath);

  try {
    await stat(targetPath);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error(`Session was not found: ${relativePath}`);
    }

    throw error;
  }

  await rm(targetPath, { force: true });
  pingSessionCache.delete(targetPath);
  sessionMetadataCache.delete(targetPath);
  await removeEmptyParents(path.dirname(targetPath), rootDir);
}
