import test from "node:test";
import assert from "node:assert/strict";
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

async function expectMissing(filePath) {
  await assert.rejects(access(filePath));
}

test("listSessions deletes standalone ping sessions and keeps normal sessions", async () => {
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

    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].relativePath, "2026/06/20/regular.jsonl");
    await assert.doesNotReject(readFile(normalFile, "utf8"));
    await expectMissing(pingFile);
    await expectMissing(pingPongFile);
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

test("getSessionRecord does not fallback when thread_name is missing", async () => {
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

    const record = await getSessionRecord({
      codexDir,
      sessionsDir,
      location: SESSION_LOCATIONS.sessions,
      relativePath
    });

    assert.equal(record.threadName, null);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("renameSession updates thread_name in session_index.jsonl without renaming the file", async () => {
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
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
