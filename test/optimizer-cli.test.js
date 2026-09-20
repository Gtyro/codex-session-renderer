import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { runOptimizerCli } from "../src/core/optimizer-cli.js";

async function invoke(argv) {
  const stdout = new PassThrough();
  let source = "";
  stdout.on("data", (chunk) => {
    source += String(chunk);
  });
  const stdin = new PassThrough();
  stdin.isTTY = false;
  stdout.isTTY = false;
  await runOptimizerCli(argv, { stdin, stdout });
  return JSON.parse(source);
}

test("optimizer CLI creates and retrieves a campaign without a user-authored config file", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "csr-optimizer-cli-"));
  const campaignsDir = path.join(tempDir, "campaigns");

  try {
    const created = await invoke([
      "campaign",
      "create",
      "--campaigns-dir",
      campaignsDir,
      "--cwd",
      tempDir,
      "--intent",
      "Repeated import task",
      "--task",
      "A",
      "--task",
      "B"
    ]);
    assert.equal(created.tasks.length, 2);

    const status = await invoke(["campaign", "status", "--campaigns-dir", campaignsDir, "--run", created.id]);
    assert.equal(status.id, created.id);
    assert.equal(status.revisions[0].number, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("optimizer CLI archives and restores a completed campaign ledger", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "csr-optimizer-cli-"));
  const campaignsDir = path.join(tempDir, "campaigns");
  const archiveDir = path.join(tempDir, "archive");

  try {
    const campaign = await invoke([
      "campaign",
      "create",
      "--campaigns-dir",
      campaignsDir,
      "--cwd",
      tempDir,
      "--task",
      "A"
    ]);
    const archived = await invoke([
      "campaign",
      "archive",
      "--campaigns-dir",
      campaignsDir,
      "--archive-dir",
      archiveDir,
      "--run",
      campaign.id
    ]);
    assert.equal(archived.archiveRoot, archiveDir);
    const restored = await invoke([
      "campaign",
      "restore",
      "--campaigns-dir",
      campaignsDir,
      "--archive-dir",
      archiveDir,
      "--run",
      campaign.id
    ]);
    assert.equal(restored.campaignRoot, campaignsDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("optimizer CLI registers and disposes an explicitly declared temporary workspace on archive", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "csr-optimizer-cli-"));
  const campaignsDir = path.join(tempDir, "campaigns");
  const archiveDir = path.join(tempDir, "archive");
  const workspace = path.join(tempDir, "worktree");
  await mkdir(workspace);

  try {
    const campaign = await invoke([
      "campaign",
      "create",
      "--campaigns-dir",
      campaignsDir,
      "--cwd",
      workspace,
      "--disposable-workspace",
      "--task",
      "A"
    ]);
    assert.equal(campaign.workspace.cleanup.policy, "delete-on-archive");

    const archived = await invoke([
      "campaign",
      "archive",
      "--campaigns-dir",
      campaignsDir,
      "--archive-dir",
      archiveDir,
      "--run",
      campaign.id
    ]);
    assert.equal(archived.workspaceCleanup.status, "disposed");
    await assert.rejects(stat(workspace), (error) => error?.code === "ENOENT");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("optimizer CLI returns redacted evidence for an explicitly selected session", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "csr-optimizer-cli-"));
  const sessionsDir = path.join(tempDir, "sessions");
  const archivedSessionsDir = path.join(tempDir, "archived");
  const sessionId = "33333333-3333-3333-3333-333333333333";
  await mkdir(path.join(sessionsDir, "2026"), { recursive: true });
  await mkdir(archivedSessionsDir, { recursive: true });
  await writeFile(
    path.join(sessionsDir, "2026", `${sessionId}.jsonl`),
    `${[
      { type: "session_meta", payload: { id: sessionId, cwd: tempDir } },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Review token=super-secret-value" }]
        }
      }
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`,
    "utf8"
  );

  try {
    const result = await invoke([
      "session",
      "evidence",
      "--id",
      sessionId,
      "--sessions-dir",
      sessionsDir,
      "--archived-sessions-dir",
      archivedSessionsDir
    ]);
    assert.equal(result.session.id, sessionId);
    assert.doesNotMatch(result.analysis.agentBrief, /super-secret-value/u);
    assert.match(result.handoff, /\$agent-workflow-optimizer/u);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("optimizer CLI measures a completed explicit session and preserves missing tokens as unknown", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "csr-optimizer-cli-"));
  const campaignsDir = path.join(tempDir, "campaigns");
  const sessionsDir = path.join(tempDir, "sessions");
  const archivedSessionsDir = path.join(tempDir, "archived");
  const measuredId = "44444444-4444-4444-4444-444444444444";
  const unknownId = "55555555-5555-5555-5555-555555555555";
  await mkdir(path.join(sessionsDir, "2026"), { recursive: true });
  await mkdir(archivedSessionsDir, { recursive: true });
  await writeFile(
    path.join(sessionsDir, "2026", `${measuredId}.jsonl`),
    `${[
      { type: "session_meta", payload: { id: measuredId, cwd: tempDir } },
      {
        type: "event_msg",
        timestamp: "2026-08-18T00:00:00.000Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { total_tokens: 720 },
            last_token_usage: { total_tokens: 720, input_tokens: 500, output_tokens: 220 }
          }
        }
      },
      { type: "event_msg", payload: { type: "task_complete", duration_ms: 1200 } }
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`,
    "utf8"
  );
  await writeFile(
    path.join(sessionsDir, "2026", `${unknownId}.jsonl`),
    `${JSON.stringify({ type: "session_meta", payload: { id: unknownId, cwd: tempDir } })}\n`,
    "utf8"
  );

  try {
    const campaign = await invoke([
      "campaign",
      "create",
      "--campaigns-dir",
      campaignsDir,
      "--cwd",
      tempDir,
      "--task",
      "Measured",
      "--task",
      "Unknown"
    ]);
    const measured = await invoke([
      "campaign",
      "measure",
      "--campaigns-dir",
      campaignsDir,
      "--run",
      campaign.id,
      "--task",
      "task-1",
      "--session",
      measuredId,
      "--sessions-dir",
      sessionsDir,
      "--archived-sessions-dir",
      archivedSessionsDir
    ]);
    assert.equal(measured.measurement.source, "session-jsonl");
    assert.equal(measured.measurement.status, "measured");
    assert.equal(measured.validation.workerTokens, 720);
    assert.equal(measured.validation.tokenMeasurement.status, "measured");
    const unknown = await invoke([
      "campaign",
      "measure",
      "--campaigns-dir",
      campaignsDir,
      "--run",
      campaign.id,
      "--task",
      "task-2",
      "--session",
      unknownId,
      "--sessions-dir",
      sessionsDir,
      "--archived-sessions-dir",
      archivedSessionsDir
    ]);
    assert.equal(unknown.measurement.status, "unknown");
    assert.equal(unknown.validation.workerTokens, null);
    assert.equal(unknown.validation.tokenMeasurement.status, "unknown");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("optimizer CLI validates CSR-owned worker measurements only after an explicit acceptance status", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "csr-optimizer-cli-"));
  const campaignsDir = path.join(tempDir, "campaigns");
  const fakeCodex = path.resolve("test-support/fake-codex-exec.mjs");

  try {
    const campaign = await invoke([
      "campaign",
      "create",
      "--campaigns-dir",
      campaignsDir,
      "--cwd",
      tempDir,
      "--task",
      "Measured worker task"
    ]);
    const run = await invoke([
      "campaign",
      "run",
      "--campaigns-dir",
      campaignsDir,
      "--run",
      campaign.id,
      "--role",
      "worker",
      "--task",
      "task-1",
      "--codex-command",
      process.execPath,
      "--command-arg",
      fakeCodex
    ]);
    await assert.rejects(
      invoke(["campaign", "validate", "--campaigns-dir", campaignsDir, "--run", campaign.id, "--from-run", run.id]),
      /explicit --status/u
    );
    const validation = await invoke([
      "campaign",
      "validate",
      "--campaigns-dir",
      campaignsDir,
      "--run",
      campaign.id,
      "--from-run",
      run.id,
      "--status",
      "passed",
      "--cohort",
      "repeatable"
    ]);
    assert.equal(validation.workerTokens, 720);
    assert.equal(validation.tokenMeasurement.source, "csr-owned-codex-exec");
    assert.equal(validation.tokenMeasurement.status, "measured");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
