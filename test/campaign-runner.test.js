import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { createCampaign, readCampaign, readCampaignEvents } from "../src/core/campaign-store.js";
import {
  buildCampaignRunPrompt,
  createCampaignRunArgs,
  extractCodexExecTokens,
  normalizeCodexExecEvent,
  runCampaignCodex
} from "../src/core/campaign-runner.js";

const fakeCodex = path.resolve("test-support/fake-codex-exec.mjs");

test("CSR-owned worker persists a stable thread and records JSON token usage", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "csr-campaign-runner-"));
  const campaignRoot = path.join(tempDir, "campaigns");

  try {
    const campaign = await createCampaign({ rootDir: campaignRoot, cwd: tempDir, tasks: ["Process sample A"] });
    const run = await runCampaignCodex({
      rootDir: campaignRoot,
      id: campaign.id,
      role: "worker",
      taskId: "task-1",
      prompt: "Perform the requested work.",
      command: process.execPath,
      commandArgs: [fakeCodex]
    });
    const stored = await readCampaign({ rootDir: campaignRoot, id: campaign.id });
    const events = await readCampaignEvents({ rootDir: campaignRoot, id: campaign.id });

    assert.equal(run.status, "awaiting-validation");
    assert.equal(run.threadId, "fake-thread-001");
    assert.equal(run.measurement.workerTokens, 720);
    assert.equal(run.measurement.status, "measured");
    assert.equal(run.model, "codex-default");
    assert.equal(run.modelSource, "runner-default");
    assert.equal(stored.tasks[0].status, "awaiting-validation");
    assert.deepEqual(stored.threads[0], {
      threadId: "fake-thread-001",
      role: "worker",
      taskId: "task-1",
      revision: 1,
      attachedAt: stored.threads[0].attachedAt
    });
    assert.ok(events.some((event) => event.type === "worker.turn.completed"));
    assert.ok(events.some((event) => event.type === "worker.run.completed"));
    assert.ok(events.some((event) => event.data?.item?.command === "./tools/resolve-release-year --title Braid --compact"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("CSR-owned runs leave missing tokens unknown instead of inventing zero", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "csr-campaign-runner-"));
  const campaignRoot = path.join(tempDir, "campaigns");

  try {
    const campaign = await createCampaign({ rootDir: campaignRoot, cwd: tempDir, tasks: ["Process sample A"] });
    const run = await runCampaignCodex({
      rootDir: campaignRoot,
      id: campaign.id,
      role: "worker",
      taskId: "task-1",
      command: process.execPath,
      commandArgs: [fakeCodex, "--no-tokens"]
    });

    assert.equal(run.measurement.workerTokens, null);
    assert.equal(run.measurement.status, "unknown");
    assert.equal(run.status, "awaiting-validation");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("workers may explicitly use danger-full-access while reviewers remain read-only", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "csr-campaign-runner-"));
  const campaignRoot = path.join(tempDir, "campaigns");

  try {
    const campaign = await createCampaign({ rootDir: campaignRoot, cwd: tempDir, tasks: ["Process sample A"] });
    const worker = await runCampaignCodex({
      rootDir: campaignRoot,
      id: campaign.id,
      role: "worker",
      taskId: "task-1",
      command: process.execPath,
      commandArgs: [fakeCodex],
      sandbox: "danger-full-access"
    });
    assert.equal(worker.sandbox, "danger-full-access");

    await assert.rejects(
      runCampaignCodex({
        rootDir: campaignRoot,
        id: campaign.id,
        role: "worker",
        taskId: "task-1",
        command: process.execPath,
        commandArgs: [fakeCodex],
        sandbox: "unsafe-ish"
      }),
      /Campaign worker sandbox/u
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("JSON adapter preserves useful event fields and avoids double-counting cached input", () => {
  const event = {
    type: "turn.completed",
    thread_id: "thread-a",
    turn_id: "turn-a",
    usage: { input_tokens: 500, cached_input_tokens: 300, output_tokens: 220 }
  };

  assert.deepEqual(normalizeCodexExecEvent(event), {
    type: "turn.completed",
    threadId: "thread-a",
    turnId: "turn-a",
    item: null,
    usage: event.usage,
    message: null
  });
  assert.equal(extractCodexExecTokens(event), 720);
  assert.deepEqual(normalizeCodexExecEvent({
    type: "item.completed",
    item: { id: "cmd-a", type: "command_execution", status: "completed", command: ["./tools/resolve-release-year", "--title", "Braid", "--compact"] }
  }).item, {
    id: "cmd-a",
    type: "command_execution",
    status: "completed",
    command: "./tools/resolve-release-year --title Braid --compact"
  });
  assert.deepEqual(createCampaignRunArgs({ cwd: "/project", sandbox: "workspace-write", model: "gpt-5" }), [
    "exec",
    "--json",
    "--model",
    "gpt-5",
    "--sandbox",
    "workspace-write",
    "--cd",
    "/project",
    "--skip-git-repo-check",
    "-"
  ]);
  assert.deepEqual(createCampaignRunArgs({ cwd: "/project", sandbox: "workspace-write" }), [
    "exec",
    "--json",
    "--sandbox",
    "workspace-write",
    "--cd",
    "/project",
    "--skip-git-repo-check",
    "-"
  ]);
});

test("reviewer prompts contain only a bounded coordinator checkpoint, never registered assets", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "csr-campaign-runner-"));
  const campaignRoot = path.join(tempDir, "campaigns");

  try {
    const campaign = await createCampaign({ rootDir: campaignRoot, cwd: tempDir, tasks: ["Process sample A"] });
    const prompt = buildCampaignRunPrompt({
      manifest: {
        ...campaign,
        assets: [{ path: "/private/SKILL.md", hash: "asset-hash", primary: true }]
      },
      role: "reviewer",
      prompt: "case=task-1; baseline=run-a; candidate=run-b"
    });

    assert.match(prompt, /Review only the coordinator-supplied, compact checkpoint/u);
    assert.match(prompt, /Do not call tools, inspect the workspace/u);
    assert.match(prompt, /case=task-1/u);
    assert.doesNotMatch(prompt, /Registered instruction assets/u);
    assert.doesNotMatch(prompt, /private\/SKILL\.md/u);

    const run = await runCampaignCodex({
      rootDir: campaignRoot,
      id: campaign.id,
      role: "reviewer",
      prompt: "Review only this checkpoint.",
      command: process.execPath,
      commandArgs: [fakeCodex]
    });
    assert.equal(run.sandbox, "read-only");
    assert.equal(run.executionCwd, null);
    await assert.rejects(
      runCampaignCodex({
        rootDir: campaignRoot,
        id: campaign.id,
        role: "reviewer",
        prompt: "Review only this checkpoint.",
        command: process.execPath,
        commandArgs: [fakeCodex],
        sandbox: "workspace-write"
      }),
      /always run in the read-only checkpoint sandbox/u
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
