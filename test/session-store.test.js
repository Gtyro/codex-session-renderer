import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import {
  getSessionRecord,
  listSessions,
  renameSession,
  resolveSessionFile,
  SESSION_LOCATIONS
} from "../src/core/session-store.js";

const SQLITE_CLI_AVAILABLE = checkSqliteCli();

function checkSqliteCli() {
  try {
    execFileSync("sqlite3", ["-version"], {
      stdio: "ignore"
    });
    return true;
  } catch {
    return false;
  }
}

function buildMessage(role, text, blockType = role === "assistant" ? "output_text" : "input_text") {
  return {
    type: "response_item",
    timestamp: "2026-06-20T00:00:00.000Z",
    payload: {
      type: "message",
      role,
      content: [
        {
          type: blockType,
          text
        }
      ]
    }
  };
}

async function writeSession(rootDir, relativePath, entries) {
  const filePath = path.join(rootDir, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8"
  );
  return filePath;
}

async function writeSessionIndex(codexDir, entries) {
  await mkdir(codexDir, { recursive: true });
  await writeFile(
    path.join(codexDir, "session_index.jsonl"),
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8"
  );
}

async function writeStateDatabase(codexDir, entries) {
  if (!SQLITE_CLI_AVAILABLE) {
    throw new Error("sqlite3 CLI is required for this test.");
  }

  await mkdir(codexDir, { recursive: true });
  const databasePath = path.join(codexDir, "state_5.sqlite");
  const escapedEntries = entries.map(({ id, title }) => {
    const escapedId = String(id).replaceAll("'", "''");
    const escapedTitle = String(title).replaceAll("'", "''");
    return `INSERT INTO threads (id, title) VALUES ('${escapedId}', '${escapedTitle}');`;
  });

  execFileSync(
    "sqlite3",
    [
      databasePath,
      [
        "PRAGMA journal_mode=WAL;",
        "CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '');",
        ...escapedEntries
      ].join("\n")
    ],
    {
      stdio: "ignore"
    }
  );

  return databasePath;
}

function readStateTitle(codexDir, sessionId) {
  if (!SQLITE_CLI_AVAILABLE) {
    throw new Error("sqlite3 CLI is required for this test.");
  }

  const databasePath = path.join(codexDir, "state_5.sqlite");
  const escapedId = String(sessionId).replaceAll("'", "''");
  const raw = execFileSync(
    "sqlite3",
    ["-json", databasePath, `SELECT title FROM threads WHERE id = '${escapedId}' LIMIT 1;`],
    {
      encoding: "utf8"
    }
  ).trim();
  const rows = raw ? JSON.parse(raw) : [];
  return rows[0]?.title ?? null;
}

async function expectMissing(filePath) {
  await assert.rejects(access(filePath));
}

test("listSessions only deletes ping sessions from the active sessions directory", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "csr-session-store-"));
  const sessionsDir = path.join(tempDir, "sessions");
  const archivedSessionsDir = path.join(tempDir, "archived_sessions");

  try {
    const pingFile = await writeSession(sessionsDir, "2026/06/20/ping.jsonl", [
      buildMessage("user", "<environment_context>\n  <cwd>/tmp/demo</cwd>\n</environment_context>"),
      buildMessage("user", "ping")
    ]);
    const pingPongFile = await writeSession(archivedSessionsDir, "2026/06/20/ping-pong.jsonl", [
      buildMessage("user", "<permissions instructions>\nworkspace-write\n</permissions instructions>"),
      buildMessage("user", "ping"),
      buildMessage("assistant", "pong")
    ]);
    const normalFile = await writeSession(sessionsDir, "2026/06/20/regular.jsonl", [
      buildMessage("user", "Render the latest session"),
      buildMessage("assistant", "Working on it.")
    ]);

    const sessions = await listSessions({ sessionsDir, archivedSessionsDir });

    assert.equal(sessions.length, 2);
    assert.deepEqual(
      sessions
        .map((session) => `${session.location}:${session.relativePath}`)
        .sort(),
      [
        "archived_sessions:2026/06/20/ping-pong.jsonl",
        "sessions:2026/06/20/regular.jsonl"
      ]
    );
    await assert.doesNotReject(readFile(normalFile, "utf8"));
    await expectMissing(pingFile);
    await assert.doesNotReject(readFile(pingPongFile, "utf8"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveSessionFile skips standalone ping sessions when resolving latest", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "csr-session-store-"));
  const sessionsDir = path.join(tempDir, "sessions");
  const archivedSessionsDir = path.join(tempDir, "archived_sessions");

  try {
    const normalFile = await writeSession(
      sessionsDir,
      "2026/06/20/rollout-2026-06-20T10-00-00-01900000-0000-7000-8000-000000000001.jsonl",
      [buildMessage("user", "hello"), buildMessage("assistant", "world")]
    );
    const pingFile = await writeSession(
      sessionsDir,
      "2026/06/20/rollout-2026-06-20T11-00-00-01900000-0000-7000-8000-000000000002.jsonl",
      [buildMessage("user", "ping")]
    );

    const resolved = await resolveSessionFile({
      sessionsDir,
      archivedSessionsDir,
      latest: true
    });

    assert.equal(resolved, normalFile);
    await expectMissing(pingFile);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("getSessionRecord treats a standalone ping session as deleted", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "csr-session-store-"));
  const sessionsDir = path.join(tempDir, "sessions");

  try {
    const pingFile = await writeSession(sessionsDir, "2026/06/20/ping.jsonl", [
      buildMessage("user", "ping")
    ]);

    await assert.rejects(
      getSessionRecord({
        sessionsDir,
        location: SESSION_LOCATIONS.sessions,
        relativePath: "2026/06/20/ping.jsonl"
      }),
      /Session was not found/
    );
    await expectMissing(pingFile);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("listSessions only inspects the file head when detecting ping sessions", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "csr-session-store-"));
  const sessionsDir = path.join(tempDir, "sessions");
  const archivedSessionsDir = path.join(tempDir, "archived_sessions");

  try {
    const pingAtHeadFile = await writeSession(sessionsDir, "2026/06/20/ping-head.jsonl", [
      buildMessage("user", "ping"),
      buildMessage("assistant", "x".repeat(20_000)),
      buildMessage("user", "real request after the header window")
    ]);
    await writeSession(sessionsDir, "2026/06/20/regular.jsonl", [
      buildMessage("user", "Render the latest session"),
      buildMessage("assistant", "Working on it.")
    ]);

    const sessions = await listSessions({ sessionsDir, archivedSessionsDir });

    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].relativePath, "2026/06/20/regular.jsonl");
    await expectMissing(pingAtHeadFile);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("listSessions reads thread_name from session_index.jsonl", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "csr-session-store-"));
  const codexDir = path.join(tempDir, ".codex");
  const sessionsDir = path.join(tempDir, "sessions");
  const archivedSessionsDir = path.join(tempDir, "archived_sessions");
  const relativePath =
    "2026/06/20/rollout-2026-06-20T11-00-00-01900000-0000-7000-8000-000000000002.jsonl";

  try {
    await writeSession(sessionsDir, relativePath, [
      buildMessage("user", "hello"),
      buildMessage("assistant", "world")
    ]);
    await writeSessionIndex(codexDir, [
      {
        id: "01900000-0000-7000-8000-000000000002",
        thread_name: "Remote SSH regression",
        updated_at: "2026-06-20T00:00:00.000Z"
      }
    ]);

    const sessions = await listSessions({
      codexDir,
      sessionsDir,
      archivedSessionsDir
    });

    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].threadName, "Remote SSH regression");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("getSessionRecord falls back to SQLite thread titles when session_index is missing", async (t) => {
  if (!SQLITE_CLI_AVAILABLE) {
    t.skip("sqlite3 CLI is not available");
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "csr-session-store-"));
  const codexDir = path.join(tempDir, ".codex");
  const sessionsDir = path.join(tempDir, "sessions");
  const relativePath =
    "2026/06/20/rollout-2026-06-20T11-00-00-01900000-0000-7000-8000-000000000002.jsonl";

  try {
    await writeSession(sessionsDir, relativePath, [
      buildMessage("user", "hello"),
      buildMessage("assistant", "world")
    ]);
    await writeStateDatabase(codexDir, [
      {
        id: "01900000-0000-7000-8000-000000000002",
        title: "SQLite fallback title"
      }
    ]);

    const record = await getSessionRecord({
      codexDir,
      sessionsDir,
      location: SESSION_LOCATIONS.sessions,
      relativePath
    });

    assert.equal(record.threadName, "SQLite fallback title");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("session_index thread_name overrides SQLite thread titles", async (t) => {
  if (!SQLITE_CLI_AVAILABLE) {
    t.skip("sqlite3 CLI is not available");
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "csr-session-store-"));
  const codexDir = path.join(tempDir, ".codex");
  const sessionsDir = path.join(tempDir, "sessions");
  const archivedSessionsDir = path.join(tempDir, "archived_sessions");
  const relativePath =
    "2026/06/20/rollout-2026-06-20T11-00-00-01900000-0000-7000-8000-000000000002.jsonl";

  try {
    await writeSession(sessionsDir, relativePath, [
      buildMessage("user", "hello"),
      buildMessage("assistant", "world")
    ]);
    await writeStateDatabase(codexDir, [
      {
        id: "01900000-0000-7000-8000-000000000002",
        title: "SQLite fallback title"
      }
    ]);
    await writeSessionIndex(codexDir, [
      {
        id: "01900000-0000-7000-8000-000000000002",
        thread_name: "Indexed title",
        updated_at: "2026-06-20T00:00:00.000Z"
      }
    ]);

    const sessions = await listSessions({
      codexDir,
      sessionsDir,
      archivedSessionsDir
    });

    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].threadName, "Indexed title");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("renameSession updates both SQLite and existing session_index records", async (t) => {
  if (!SQLITE_CLI_AVAILABLE) {
    t.skip("sqlite3 CLI is not available");
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "csr-session-store-"));
  const codexDir = path.join(tempDir, ".codex");
  const sessionsDir = path.join(tempDir, "sessions");
  const archivedSessionsDir = path.join(tempDir, "archived_sessions");
  const relativePath =
    "2026/06/20/rollout-2026-06-20T11-00-00-01900000-0000-7000-8000-000000000002.jsonl";

  try {
    const originalFile = await writeSession(sessionsDir, relativePath, [
      buildMessage("user", "hello"),
      buildMessage("assistant", "world")
    ]);
    await writeStateDatabase(codexDir, [
      {
        id: "01900000-0000-7000-8000-000000000002",
        title: "Old sqlite title"
      }
    ]);
    await writeSessionIndex(codexDir, [
      {
        id: "01900000-0000-7000-8000-000000000002",
        thread_name: "Old name",
        updated_at: "2026-06-20T00:00:00.000Z"
      }
    ]);

    const renamed = await renameSession({
      codexDir,
      sessionsDir,
      archivedSessionsDir,
      location: SESSION_LOCATIONS.sessions,
      relativePath,
      name: "Remote SSH regression"
    });

    assert.equal(renamed.relativePath, relativePath);
    assert.equal(renamed.threadName, "Remote SSH regression");
    await assert.doesNotReject(readFile(originalFile, "utf8"));

    const indexSource = await readFile(path.join(codexDir, "session_index.jsonl"), "utf8");
    assert.match(indexSource, /"thread_name":"Remote SSH regression"/);
    assert.equal(
      readStateTitle(codexDir, "01900000-0000-7000-8000-000000000002"),
      "Remote SSH regression"
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("renameSession updates SQLite without creating a new session_index record", async (t) => {
  if (!SQLITE_CLI_AVAILABLE) {
    t.skip("sqlite3 CLI is not available");
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "csr-session-store-"));
  const codexDir = path.join(tempDir, ".codex");
  const sessionsDir = path.join(tempDir, "sessions");
  const archivedSessionsDir = path.join(tempDir, "archived_sessions");
  const relativePath =
    "2026/06/20/rollout-2026-06-20T11-00-00-01900000-0000-7000-8000-000000000002.jsonl";

  try {
    await writeSession(sessionsDir, relativePath, [
      buildMessage("user", "hello"),
      buildMessage("assistant", "world")
    ]);
    await writeStateDatabase(codexDir, [
      {
        id: "01900000-0000-7000-8000-000000000002",
        title: "Old sqlite title"
      }
    ]);

    const renamed = await renameSession({
      codexDir,
      sessionsDir,
      archivedSessionsDir,
      location: SESSION_LOCATIONS.sessions,
      relativePath,
      name: "Remote SSH regression"
    });

    assert.equal(renamed.threadName, "Remote SSH regression");
    assert.equal(
      readStateTitle(codexDir, "01900000-0000-7000-8000-000000000002"),
      "Remote SSH regression"
    );
    await assert.rejects(access(path.join(codexDir, "session_index.jsonl")));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
