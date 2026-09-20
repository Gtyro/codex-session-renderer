import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { buildOptimizationHandoff, getSessionCandidateById, searchSessions } from "../src/core/session-resolver.js";

function sessionEntry(id, cwd, prompt) {
  return [
    {
      type: "session_meta",
      payload: { id, cwd },
      timestamp: "2026-08-17T00:00:00.000Z"
    },
    {
      type: "response_item",
      timestamp: "2026-08-17T00:00:01.000Z",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] }
    }
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n");
}

test("session resolver searches recorded titles and prompts without a global latest fallback", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "csr-session-resolver-"));
  const sessionsDir = path.join(tempDir, "sessions");
  const archivedSessionsDir = path.join(tempDir, "archived");
  const id = "11111111-1111-1111-1111-111111111111";
  const sessionPath = path.join(sessionsDir, "2026", `${id}.jsonl`);
  await mkdir(path.dirname(sessionPath), { recursive: true });
  await mkdir(archivedSessionsDir, { recursive: true });
  await writeFile(sessionPath, `${sessionEntry(id, "/workspace/mygog", "Add Braid to the game library")}\n`, "utf8");

  try {
    const candidates = await searchSessions("Braid", { sessionsDir, archivedSessionsDir });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].id, id);
    const exact = await getSessionCandidateById(id, { sessionsDir, archivedSessionsDir });
    assert.match(buildOptimizationHandoff(exact), new RegExp(id, "u"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
