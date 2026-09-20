import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { getAppServerCapabilities, ingestAppServerNotification } from "../src/core/app-server-bridge.js";
import { attachCampaignThread, createCampaign, readCampaignEvents } from "../src/core/campaign-store.js";

test("App Server notifications become role-scoped campaign events only for attached threads", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "csr-app-server-bridge-"));
  const campaignRoot = path.join(tempDir, "campaigns");

  try {
    const campaign = await createCampaign({ rootDir: campaignRoot, cwd: tempDir, tasks: ["A"] });
    await attachCampaignThread({ rootDir: campaignRoot, id: campaign.id, threadId: "worker-thread", role: "worker", taskId: "task-1", revision: 1 });
    await attachCampaignThread({ rootDir: campaignRoot, id: campaign.id, threadId: "reviewer-thread", role: "reviewer", revision: 1 });
    const event = await ingestAppServerNotification({
      rootDir: campaignRoot,
      campaignId: campaign.id,
      notification: {
        method: "turn/plan/updated",
        params: {
          threadId: "worker-thread",
          turnId: "turn-1",
          plan: [{ step: "Import", status: "inProgress" }]
        }
      }
    });
    assert.equal(event.type, "worker.turn.plan.updated");
    assert.equal(event.taskId, "task-1");
    const tokenEvent = await ingestAppServerNotification({
      rootDir: campaignRoot,
      campaignId: campaign.id,
      notification: {
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "reviewer-thread",
          turnId: "turn-review",
          tokenUsage: { total: { totalTokens: 321 } }
        }
      }
    });
    assert.equal(tokenEvent.type, "reviewer.thread.tokenUsage.updated");
    assert.equal(tokenEvent.data.tokenUsage.total.totalTokens, 321);
    assert.equal(
      await ingestAppServerNotification({
        rootDir: campaignRoot,
        campaignId: campaign.id,
        notification: { method: "turn/started", params: { threadId: "unattached", turn: { id: "turn-2" } } }
      }),
      null
    );
    assert.equal((await readCampaignEvents({ rootDir: campaignRoot, id: campaign.id })).length, 5);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("App Server capability check rejects an incompatible initialize response", () => {
  const capabilities = getAppServerCapabilities({
    codexHome: "/tmp/codex",
    platformFamily: "unix",
    platformOs: "linux",
    userAgent: "codex-cli/0.1.8"
  });
  assert.equal(capabilities.protocolVersion, "0.1.8");
  assert.ok(capabilities.eventMethods.includes("turn/plan/updated"));
  assert.throws(
    () => getAppServerCapabilities({ userAgent: "codex-cli/0.1.8" }),
    /incompatible/u
  );
});
