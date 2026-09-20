import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import {
  activateCampaignOverlay,
  archiveCampaign,
  appendCampaignEvent,
  completeCampaignRun,
  createCampaign,
  getTaskFamilyId,
  getPatchPromotionStatus,
  registerCampaignAsset,
  recordCampaignValidation,
  readCampaign,
  readCampaignEvents,
  registerCampaignPatch,
  restoreCampaign,
  rollbackCampaignPatch,
  startCampaignRun,
  promoteCampaignPatch
} from "../src/core/campaign-store.js";

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function recordValidatedPair({ rootDir, campaignId, taskId, baselineTokens, candidateTokens, cohort = "known-year", baselineAssetHashes = {}, candidateAssetHashes = {} }) {
  const workspace = {
    kind: "git-workspace-snapshot",
    root: "/isolated/worktree",
    revision: "abc123",
    clean: true,
    fingerprint: "git:abc123"
  };
  const common = {
    rootDir,
    id: campaignId,
    role: "worker",
    taskId,
    command: "codex",
    commandArgs: ["--json"],
    model: "gpt-5",
    sandbox: "workspace-write",
    promptHash: "same-prompt",
    workspace
  };
  const baseline = await startCampaignRun({ ...common, runId: `${taskId}-baseline`, revision: 1, executionCwd: `/isolated/${taskId}-baseline`, assetHashes: baselineAssetHashes });
  await completeCampaignRun({
    rootDir,
    id: campaignId,
    runId: baseline.id,
    exitCode: 0,
    measurement: { source: "csr-owned-codex-exec", status: "measured", workerTokens: baselineTokens, elapsedMs: 10, workspaceAfter: workspace }
  });
  await recordCampaignValidation({
    rootDir,
    id: campaignId,
    taskId,
    runId: baseline.id,
    status: "passed",
    source: "csr-owned-codex-exec",
    workerTokens: baselineTokens,
    cohort,
    tokenMeasurement: { source: "csr-owned-codex-exec", status: "measured" }
  });
  const candidate = await startCampaignRun({ ...common, runId: `${taskId}-candidate`, revision: 2, executionCwd: `/isolated/${taskId}-candidate`, assetHashes: candidateAssetHashes });
  await completeCampaignRun({
    rootDir,
    id: campaignId,
    runId: candidate.id,
    exitCode: 0,
    measurement: { source: "csr-owned-codex-exec", status: "measured", workerTokens: candidateTokens, elapsedMs: 8, workspaceAfter: workspace }
  });
  await recordCampaignValidation({
    rootDir,
    id: campaignId,
    taskId,
    runId: candidate.id,
    status: "reviewer-verified",
    source: "csr-owned-codex-exec",
    workerTokens: candidateTokens,
    cohort,
    tokenMeasurement: { source: "csr-owned-codex-exec", status: "measured" }
  });
  return { baseline, candidate };
}

test("campaign ledger versions overlays, promotes verified instruction patches, and rolls them back", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "csr-campaign-store-"));
  const campaignRoot = path.join(tempDir, "campaigns");
  const skillPath = path.join(tempDir, ".codex", "skills", "demo", "SKILL.md");
  await mkdir(path.dirname(skillPath), { recursive: true });
  const baseSkill = "---\nname: demo\ndescription: Demo workflow\n---\n# Demo\n";
  const nextSkill = `${baseSkill}\nSkip redundant lookup after a confirmed hit.\n`;
  await writeFile(skillPath, baseSkill, "utf8");

  try {
    const campaign = await createCampaign({
      rootDir: campaignRoot,
      cwd: tempDir,
      intent: "repeat import",
      tasks: ["A", "B", "C"]
    });
    const overlay = await activateCampaignOverlay({
      rootDir: campaignRoot,
      id: campaign.id,
      overlay: "Skip redundant lookup after a confirmed hit.",
      reason: "Observed repeated lookup"
    });
    assert.equal(overlay.number, 2);
    const asset = await registerCampaignAsset({ rootDir: campaignRoot, id: campaign.id, assetPath: skillPath, primary: true });
    assert.equal(asset.primary, true);
    const assetPath = ".codex/skills/demo/SKILL.md";
    const hashes = {
      baselineAssetHashes: { [assetPath]: sha256(baseSkill) },
      candidateAssetHashes: { [assetPath]: sha256(nextSkill) }
    };
    const task1 = await recordValidatedPair({ rootDir: campaignRoot, campaignId: campaign.id, taskId: "task-1", baselineTokens: 200, candidateTokens: 150, ...hashes });
    const task2 = await recordValidatedPair({ rootDir: campaignRoot, campaignId: campaign.id, taskId: "task-2", baselineTokens: 180, candidateTokens: 120, ...hashes });

    const patch = await registerCampaignPatch({
      rootDir: campaignRoot,
      id: campaign.id,
      assetPath: skillPath,
      baseContent: baseSkill,
      nextContent: nextSkill,
      revision: overlay.number,
      comparisons: [
        { caseId: "task-1", cohort: "known-year", baselineRunId: task1.baseline.id, candidateRunId: task1.candidate.id },
        { caseId: "task-2", cohort: "known-year", baselineRunId: task2.baseline.id, candidateRunId: task2.candidate.id }
      ]
    });
    assert.equal(getPatchPromotionStatus(patch, await readCampaign({ rootDir: campaignRoot, id: campaign.id })).eligible, true);

    await promoteCampaignPatch({ rootDir: campaignRoot, id: campaign.id, patchId: patch.id });
    assert.match(await readFile(skillPath, "utf8"), /Skip redundant lookup/u);

    await rollbackCampaignPatch({ rootDir: campaignRoot, id: campaign.id, patchId: patch.id });
    assert.equal(await readFile(skillPath, "utf8"), baseSkill);

    const events = await readCampaignEvents({ rootDir: campaignRoot, id: campaign.id });
    assert.ok(events.some((event) => event.type === "campaign.created"));
    assert.ok(events.some((event) => event.type === "campaign.asset.observed"));
    assert.ok(events.some((event) => event.type === "patch.candidate"));
    assert.ok(events.some((event) => event.type === "patch.applied"));
    assert.ok(events.some((event) => event.type === "patch.rolled-back"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("campaign patches reject AGENTS.md and weak token evidence", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "csr-campaign-store-"));
  const campaignRoot = path.join(tempDir, "campaigns");
  const agentsPath = path.join(tempDir, "AGENTS.md");
  await writeFile(agentsPath, "rules\n", "utf8");

  try {
    const campaign = await createCampaign({ rootDir: campaignRoot, cwd: tempDir, tasks: ["A"] });
    await assert.rejects(
      registerCampaignPatch({
        rootDir: campaignRoot,
        id: campaign.id,
        assetPath: agentsPath,
        baseContent: "rules\n",
        nextContent: "new rules\n"
      }),
      /AGENTS\.md/u
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("manual token fields cannot qualify a promotion comparison", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "csr-campaign-store-"));
  const campaignRoot = path.join(tempDir, "campaigns");

  try {
    const campaign = await createCampaign({ rootDir: campaignRoot, cwd: tempDir, tasks: ["A"] });
    const manifest = await readCampaign({ rootDir: campaignRoot, id: campaign.id });
    assert.equal(
      getPatchPromotionStatus({
        comparisons: [
          { caseId: "task-1", cohort: "same", baselineRunId: "made-up-baseline", candidateRunId: "made-up-candidate", baselineWorkerTokens: 100, workerTokens: 1 },
          { caseId: "task-2", cohort: "same", baselineRunId: "made-up-baseline-2", candidateRunId: "made-up-candidate-2", baselineWorkerTokens: 100, workerTokens: 1 }
        ]
      }, manifest).eligible,
      false
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("paired promotion rejects runs that reuse one workspace or change the checkpoint prompt", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "csr-campaign-store-"));
  const campaignRoot = path.join(tempDir, "campaigns");

  try {
    const campaign = await createCampaign({ rootDir: campaignRoot, cwd: tempDir, tasks: ["A", "B"] });
    const task1 = await recordValidatedPair({ rootDir: campaignRoot, campaignId: campaign.id, taskId: "task-1", baselineTokens: 100, candidateTokens: 50, cohort: "paired" });
    const task2 = await recordValidatedPair({ rootDir: campaignRoot, campaignId: campaign.id, taskId: "task-2", baselineTokens: 100, candidateTokens: 50, cohort: "paired" });
    const comparisons = [
      { caseId: "task-1", cohort: "paired", baselineRunId: task1.baseline.id, candidateRunId: task1.candidate.id },
      { caseId: "task-2", cohort: "paired", baselineRunId: task2.baseline.id, candidateRunId: task2.candidate.id }
    ];
    const manifest = await readCampaign({ rootDir: campaignRoot, id: campaign.id });
    const reusedWorkspace = structuredClone(manifest);
    reusedWorkspace.runs.find((run) => run.id === task1.candidate.id).executionCwd = task1.baseline.executionCwd;
    assert.equal(getPatchPromotionStatus({ comparisons }, reusedWorkspace).eligible, false);

    const changedPrompt = structuredClone(manifest);
    changedPrompt.runs.find((run) => run.id === task2.candidate.id).promptHash = "different-prompt";
    assert.equal(getPatchPromotionStatus({ comparisons }, changedPrompt).eligible, false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("paired promotion accepts CSR's stable default-model identity but rejects a changed source", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "csr-campaign-store-"));
  const campaignRoot = path.join(tempDir, "campaigns");

  try {
    const campaign = await createCampaign({ rootDir: campaignRoot, cwd: tempDir, tasks: ["A", "B"] });
    const task1 = await recordValidatedPair({ rootDir: campaignRoot, campaignId: campaign.id, taskId: "task-1", baselineTokens: 100, candidateTokens: 50, cohort: "default-model" });
    const task2 = await recordValidatedPair({ rootDir: campaignRoot, campaignId: campaign.id, taskId: "task-2", baselineTokens: 100, candidateTokens: 50, cohort: "default-model" });
    const comparisons = [
      { caseId: "task-1", cohort: "default-model", baselineRunId: task1.baseline.id, candidateRunId: task1.candidate.id },
      { caseId: "task-2", cohort: "default-model", baselineRunId: task2.baseline.id, candidateRunId: task2.candidate.id }
    ];
    const manifest = await readCampaign({ rootDir: campaignRoot, id: campaign.id });
    for (const run of manifest.runs) {
      run.model = "codex-default";
      run.modelSource = "runner-default";
    }
    assert.equal(getPatchPromotionStatus({ comparisons }, manifest).eligible, true);

    manifest.runs.find((run) => run.id === task2.candidate.id).modelSource = "explicit";
    assert.equal(getPatchPromotionStatus({ comparisons }, manifest).eligible, false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("campaign promotion leaves three-way conflicts untouched", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "csr-campaign-store-"));
  const campaignRoot = path.join(tempDir, "campaigns");
  const guidePath = path.join(tempDir, "docs", "guide.md");
  const nextGuide = "base\ncandidate change\n";
  await mkdir(path.dirname(guidePath), { recursive: true });
  await writeFile(guidePath, "base\n", "utf8");

  try {
    const campaign = await createCampaign({ rootDir: campaignRoot, cwd: tempDir, tasks: ["A", "B"] });
    const hashes = {
      baselineAssetHashes: { "docs/guide.md": sha256("base\n") },
      candidateAssetHashes: { "docs/guide.md": sha256(nextGuide) }
    };
    const task1 = await recordValidatedPair({ rootDir: campaignRoot, campaignId: campaign.id, taskId: "task-1", baselineTokens: 20, candidateTokens: 10, cohort: "same-case", ...hashes });
    const task2 = await recordValidatedPair({ rootDir: campaignRoot, campaignId: campaign.id, taskId: "task-2", baselineTokens: 20, candidateTokens: 10, cohort: "same-case", ...hashes });
    const patch = await registerCampaignPatch({
      rootDir: campaignRoot,
      id: campaign.id,
      assetPath: guidePath,
      baseContent: "base\n",
      nextContent: nextGuide,
      comparisons: [
        { caseId: "task-1", cohort: "same-case", baselineRunId: task1.baseline.id, candidateRunId: task1.candidate.id },
        { caseId: "task-2", cohort: "same-case", baselineRunId: task2.baseline.id, candidateRunId: task2.candidate.id }
      ]
    });
    await writeFile(guidePath, "base\ncurrent change\n", "utf8");
    await assert.rejects(
      promoteCampaignPatch({ rootDir: campaignRoot, id: campaign.id, patchId: patch.id }),
      /three-way merge/u
    );
    assert.equal(await readFile(guidePath, "utf8"), "base\ncurrent change\n");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("task families bind normalized task patterns to all associated instruction hashes", () => {
  const base = getTaskFamilyId({
    skillPath: "/project/.codex/skills/demo/SKILL.md",
    skillHash: "skill-v1",
    assetPaths: ["/project/README.md", "/project/docs/guide.md"],
    assetHashes: ["readme-v1", "guide-v1"],
    taskTemplate: "Use the demo Skill   to process an input"
  });
  const equivalent = getTaskFamilyId({
    skillPath: "/project/.codex/skills/demo/SKILL.md",
    skillHash: "skill-v1",
    assetPaths: ["/project/docs/guide.md", "/project/README.md"],
    assetHashes: ["guide-v1", "readme-v1"],
    taskTemplate: "use the demo skill to process an input"
  });
  const changedGuide = getTaskFamilyId({
    skillPath: "/project/.codex/skills/demo/SKILL.md",
    skillHash: "skill-v1",
    assetPaths: ["/project/README.md", "/project/docs/guide.md"],
    assetHashes: ["readme-v1", "guide-v2"],
    taskTemplate: "use the demo skill to process an input"
  });

  assert.equal(base, equivalent);
  assert.notEqual(base, changedGuide);
});

test("completed campaign ledgers can be archived and restored without deleting their worker evidence", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "csr-campaign-store-"));
  const campaignRoot = path.join(tempDir, "campaigns");
  const archiveRoot = path.join(tempDir, "campaign-archive");

  try {
    const campaign = await createCampaign({ rootDir: campaignRoot, cwd: tempDir, tasks: ["A"] });
    const archived = await archiveCampaign({ rootDir: campaignRoot, id: campaign.id, archiveRoot });
    assert.equal(archived.archiveRoot, archiveRoot);
    await assert.rejects(readCampaign({ rootDir: campaignRoot, id: campaign.id }), /was not found/u);
    const archivedManifest = await readCampaign({ rootDir: archiveRoot, id: campaign.id });
    assert.equal(archivedManifest.archivedAt, archived.archivedAt);
    assert.ok((await readCampaignEvents({ rootDir: archiveRoot, id: campaign.id })).some((event) => event.type === "campaign.archived"));

    const restored = await restoreCampaign({ rootDir: campaignRoot, id: campaign.id, archiveRoot });
    assert.equal(restored.campaignRoot, campaignRoot);
    const activeManifest = await readCampaign({ rootDir: campaignRoot, id: campaign.id });
    assert.equal(activeManifest.restoredAt, restored.restoredAt);
    assert.ok((await readCampaignEvents({ rootDir: campaignRoot, id: campaign.id })).some((event) => event.type === "campaign.restored"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("archive disposes only an explicitly declared temporary campaign workspace and records the result", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "csr-campaign-store-"));
  const campaignRoot = path.join(tempDir, "campaigns");
  const archiveRoot = path.join(tempDir, "campaign-archive");
  const workspace = path.join(tempDir, "worktree");
  await mkdir(workspace);
  await writeFile(path.join(workspace, "evidence.txt"), "temporary worktree\n", "utf8");

  try {
    const campaign = await createCampaign({
      rootDir: campaignRoot,
      cwd: workspace,
      tasks: ["A"],
      disposableWorkspace: true
    });
    assert.equal(campaign.workspace.ownership, "campaign-temporary");
    assert.equal(campaign.workspace.cleanup.status, "pending");

    const archived = await archiveCampaign({ rootDir: campaignRoot, id: campaign.id, archiveRoot });
    assert.equal(archived.workspaceCleanup.status, "disposed");
    await assert.rejects(stat(workspace), (error) => error?.code === "ENOENT");

    const manifest = await readCampaign({ rootDir: archiveRoot, id: campaign.id });
    assert.equal(manifest.workspace.cleanup.status, "disposed");
    const events = await readCampaignEvents({ rootDir: archiveRoot, id: campaign.id });
    assert.ok(events.some((event) => event.type === "workspace.cleanup.completed"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("a missing declared temporary workspace is auditable and does not block archive", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "csr-campaign-store-"));
  const campaignRoot = path.join(tempDir, "campaigns");
  const archiveRoot = path.join(tempDir, "campaign-archive");
  const workspace = path.join(tempDir, "worktree");
  await mkdir(workspace);

  try {
    const campaign = await createCampaign({
      rootDir: campaignRoot,
      cwd: workspace,
      tasks: ["A"],
      disposableWorkspace: true
    });
    await rm(workspace, { recursive: true, force: true });

    const archived = await archiveCampaign({ rootDir: campaignRoot, id: campaign.id, archiveRoot });
    assert.equal(archived.workspaceCleanup.status, "missing");
    const events = await readCampaignEvents({ rootDir: archiveRoot, id: campaign.id });
    assert.ok(events.some((event) => event.type === "workspace.cleanup.missing"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("disposable campaign workspace registration rejects a non-temporary cwd", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "csr-campaign-store-"));

  try {
    await assert.rejects(
      createCampaign({ rootDir: path.join(tempDir, "campaigns"), cwd: process.cwd(), disposableWorkspace: true }),
      /system temporary directory/u
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("parallel worker and reviewer writes retain every campaign event and sequence", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "csr-campaign-store-"));
  const campaignRoot = path.join(tempDir, "campaigns");

  try {
    const campaign = await createCampaign({ rootDir: campaignRoot, cwd: tempDir, tasks: ["A"] });
    const appended = await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        appendCampaignEvent({
          rootDir: campaignRoot,
          id: campaign.id,
          type: index % 2 === 0 ? "worker.checkpoint" : "reviewer.checkpoint",
          role: index % 2 === 0 ? "worker" : "reviewer",
          data: { summary: `checkpoint ${index}` }
        })
      )
    );
    const events = await readCampaignEvents({ rootDir: campaignRoot, id: campaign.id });
    const manifest = await readCampaign({ rootDir: campaignRoot, id: campaign.id });

    assert.equal(events.length, 17);
    assert.deepEqual(
      [...new Set(events.map((event) => event.seq))].sort((left, right) => left - right),
      Array.from({ length: 17 }, (_, index) => index + 1)
    );
    assert.equal(manifest.eventSeq, 17);
    assert.equal(new Set(appended.map((event) => event.seq)).size, 16);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
