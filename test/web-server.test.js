import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { startWebServer } from "../src/server/web-server.js";
import { resolveWebAsset } from "../src/server/static-asset-routing.js";
import { createCampaign } from "../src/core/campaign-store.js";

async function stopServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function requestRaw(url, pathname) {
  return await new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: url.hostname,
        port: url.port,
        path: pathname
      },
      (response) => {
        const chunks = [];

        response.on("data", (chunk) => {
          chunks.push(chunk);
        });
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8")
          });
        });
      }
    );

    request.on("error", reject);
    request.end();
  });
}

async function postJson(url, pathname, payload) {
  const response = await fetch(new URL(pathname, url), {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const contentType = response.headers.get("content-type") || "";

  return {
    response,
    body: contentType.includes("application/json") ? await response.json() : null
  };
}

async function waitForServerShutdown(url, timeoutMs = 1_500) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      await fetch(new URL("/api/sessions", url));
    } catch {
      return;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }

  throw new Error(`Expected ${url} to stop responding within ${timeoutMs}ms.`);
}

async function readSseUntil(reader, matcher) {
  const decoder = new TextDecoder();
  let source = "";
  for (let index = 0; index < 6; index += 1) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    source += decoder.decode(value, { stream: true });
    if (matcher.test(source)) {
      break;
    }
  }
  return source;
}

test("resolveWebAsset rejects requests that escape the web root", () => {
  const result = resolveWebAsset("/assets/%2e%2e/%2e%2e/package.json");

  assert.equal(result?.statusCode, 403);
  assert.equal(result?.error?.message, "Asset path is outside the web root.");
});

test("web server serves browser assets from the web root directory", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "csr-web-server-"));
  const sessionsDir = path.join(tempDir, "sessions");
  const archivedSessionsDir = path.join(tempDir, "archived_sessions");
  await Promise.all([
    mkdir(sessionsDir, { recursive: true }),
    mkdir(archivedSessionsDir, { recursive: true })
  ]);

  let webServer = null;

  try {
    webServer = await startWebServer({
      host: "127.0.0.1",
      port: 0,
      sessionsDir,
      archivedSessionsDir
    });
    const webUrl = new URL(webServer.url);

    const assetResponse = await fetch(`${webServer.url}/assets/session-selection.js`);
    assert.equal(assetResponse.status, 200);
    assert.match(await assetResponse.text(), /export function sessionKey/u);

    const missingResponse = await fetch(`${webServer.url}/assets/does-not-exist.js`);
    assert.equal(missingResponse.status, 404);

    const traversalResponse = await requestRaw(webUrl, "/assets/%2e%2e/%2e%2e/package.json");
    assert.ok([403, 404].includes(traversalResponse.statusCode));
  } finally {
    if (webServer) {
      await stopServer(webServer.server);
    }

    await rm(tempDir, {
      recursive: true,
      force: true
    });
  }
});

test("web server falls back to a random port when the preferred default port is busy", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "csr-web-server-port-"));
  const sessionsDir = path.join(tempDir, "sessions");
  const archivedSessionsDir = path.join(tempDir, "archived_sessions");
  await Promise.all([
    mkdir(sessionsDir, { recursive: true }),
    mkdir(archivedSessionsDir, { recursive: true })
  ]);

  const occupiedServer = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("occupied");
  });

  let webServer = null;

  try {
    await new Promise((resolve, reject) => {
      occupiedServer.once("error", reject);
      occupiedServer.listen(0, "127.0.0.1", resolve);
    });

    const occupiedAddress = occupiedServer.address();
    const occupiedPort = typeof occupiedAddress === "object" && occupiedAddress ? occupiedAddress.port : 0;

    webServer = await startWebServer({
      host: "127.0.0.1",
      defaultPort: occupiedPort,
      sessionsDir,
      archivedSessionsDir
    });

    assert.notEqual(webServer.port, occupiedPort);
    assert.equal(webServer.preferredPort, occupiedPort);
    assert.equal(webServer.fallbackUsed, true);

    const assetResponse = await fetch(`${webServer.url}/assets/app.js`);
    assert.equal(assetResponse.status, 200);
  } finally {
    if (webServer) {
      await stopServer(webServer.server);
    }

    await stopServer(occupiedServer);
    await rm(tempDir, {
      recursive: true,
      force: true
    });
  }
});

test("web server defaults session detail to a compact memory snapshot and loads analysis on demand", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "csr-web-snapshot-"));
  const sessionsDir = path.join(tempDir, "sessions");
  const archivedSessionsDir = path.join(tempDir, "archived_sessions");
  const sessionId = "33333333-3333-3333-3333-333333333333";
  const relativePath = `2026/${sessionId}.jsonl`;
  await mkdir(path.join(sessionsDir, "2026"), { recursive: true });
  await mkdir(archivedSessionsDir, { recursive: true });
  await writeFile(
    path.join(sessionsDir, relativePath),
    `${[
      { type: "session_meta", payload: { id: sessionId, cwd: tempDir } },
      {
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "First request" }] }
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "First answer" }]
        }
      },
      {
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Middle request" }] }
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "Middle answer" }]
        }
      },
      {
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Recent request" }] }
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "Recent answer" }]
        }
      },
      {
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Latest request" }] }
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "Latest answer" }]
        }
      }
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`,
    "utf8"
  );

  let webServer = null;

  try {
    webServer = await startWebServer({ host: "127.0.0.1", port: 0, sessionsDir, archivedSessionsDir });
    const detail = await fetch(
      `${webServer.url}/api/session-detail?${new URLSearchParams({ location: "sessions", relativePath })}`
    ).then((response) => response.json());

    assert.equal(detail.previewOptions.readerMode, "snapshot");
    assert.equal(detail.session.selection.mode, "memory_snapshot");
    assert.equal(detail.session.selection.summaryComplete, false);
    assert.equal(detail.session.selection.omittedItems, null);
    assert.deepEqual(
      detail.session.items.map((item) => item.text),
      ["First request", "First answer", "Recent request", "Recent answer", "Latest request", "Latest answer"]
    );
    assert.equal(detail.session.optimizationAnalysis, null);

    const analysis = await postJson(new URL(webServer.url), "/api/session-optimization-analysis", {
      location: "sessions",
      relativePath,
      view: "snapshot"
    });
    assert.equal(analysis.response.status, 200);
    assert.equal(analysis.body.analysis.traceJumpsAvailable, false);
    assert.match(analysis.body.analysis.agentBrief, /First request/u);
  } finally {
    if (webServer) {
      await stopServer(webServer.server);
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("web server exposes durable campaign events, SSE observation, and a foreground optimizer handoff", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "csr-web-campaign-"));
  const sessionsDir = path.join(tempDir, "sessions");
  const archivedSessionsDir = path.join(tempDir, "archived_sessions");
  const campaignsDir = path.join(tempDir, "campaigns");
  const sessionId = "22222222-2222-2222-2222-222222222222";
  const relativePath = `2026/${sessionId}.jsonl`;
  await mkdir(path.join(sessionsDir, "2026"), { recursive: true });
  await mkdir(archivedSessionsDir, { recursive: true });
  await writeFile(
    path.join(sessionsDir, relativePath),
    `${[
      { type: "session_meta", payload: { id: sessionId, cwd: tempDir } },
      {
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Optimize imports" }] }
      }
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`,
    "utf8"
  );
  const campaign = await createCampaign({ campaignsDir, rootDir: campaignsDir, cwd: tempDir, intent: "Repeated imports" });
  let webServer = null;
  const controller = new AbortController();

  try {
    webServer = await startWebServer({ host: "127.0.0.1", port: 0, sessionsDir, archivedSessionsDir, campaignsDir });
    const listed = await fetch(`${webServer.url}/api/campaigns`).then((response) => response.json());
    assert.equal(listed.campaigns[0].id, campaign.id);

    const events = await fetch(`${webServer.url}/api/campaigns/${campaign.id}/events`).then((response) => response.json());
    assert.equal(events.events[0].type, "campaign.created");

    const stream = await fetch(`${webServer.url}/api/campaigns/${campaign.id}/stream`, { signal: controller.signal });
    assert.equal(stream.status, 200);
    const streamSource = await readSseUntil(stream.body.getReader(), /event: campaign/u);
    assert.match(streamSource, /campaign\.created/u);
    controller.abort();

    const handoff = await postJson(new URL(webServer.url), "/api/session-optimizer-handoff", {
      location: "sessions",
      relativePath,
      all: true
    });
    assert.equal(handoff.response.status, 200);
    assert.match(handoff.body.handoff, /\$agent-workflow-optimizer/u);
    assert.match(handoff.body.handoff, new RegExp(sessionId, "u"));
  } finally {
    controller.abort();
    if (webServer) {
      await stopServer(webServer.server);
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("web server stops after the last tracked browser client disconnects", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "csr-web-server-idle-"));
  const sessionsDir = path.join(tempDir, "sessions");
  const archivedSessionsDir = path.join(tempDir, "archived_sessions");
  await Promise.all([
    mkdir(sessionsDir, { recursive: true }),
    mkdir(archivedSessionsDir, { recursive: true })
  ]);

  let webServer = null;

  try {
    webServer = await startWebServer({
      host: "127.0.0.1",
      port: 0,
      stopWhenIdle: true,
      stopWhenIdleDelayMs: 40,
      clientHeartbeatIntervalMs: 10,
      clientHeartbeatTimeoutMs: 60,
      sessionsDir,
      archivedSessionsDir
    });

    const openResult = await postJson(webServer.url, "/api/browser-client/open", {});
    assert.equal(openResult.response.status, 200);
    assert.match(openResult.body?.clientId || "", /^[0-9a-f-]{36}$/u);

    const pingResult = await postJson(webServer.url, "/api/browser-client/ping", {
      clientId: openResult.body.clientId
    });
    assert.equal(pingResult.response.status, 200);
    assert.equal(pingResult.body?.ok, true);

    const closeResult = await postJson(webServer.url, "/api/browser-client/close", {
      clientId: openResult.body.clientId
    });
    assert.equal(closeResult.response.status, 200);
    assert.equal(closeResult.body?.ok, true);

    await waitForServerShutdown(webServer.url);
    webServer = null;
  } finally {
    if (webServer) {
      await stopServer(webServer.server);
    }

    await rm(tempDir, {
      recursive: true,
      force: true
    });
  }
});

test("web server stays available when a browser client heartbeat expires", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "csr-web-server-heartbeat-"));
  const sessionsDir = path.join(tempDir, "sessions");
  const archivedSessionsDir = path.join(tempDir, "archived_sessions");
  await Promise.all([
    mkdir(sessionsDir, { recursive: true }),
    mkdir(archivedSessionsDir, { recursive: true })
  ]);

  let webServer = null;

  try {
    webServer = await startWebServer({
      host: "127.0.0.1",
      port: 0,
      stopWhenIdle: true,
      stopWhenIdleDelayMs: 40,
      clientHeartbeatTimeoutMs: 30,
      sessionsDir,
      archivedSessionsDir
    });

    const firstOpen = await postJson(webServer.url, "/api/browser-client/open", {});
    assert.equal(firstOpen.response.status, 200);

    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    const expiredPing = await postJson(webServer.url, "/api/browser-client/ping", {
      clientId: firstOpen.body.clientId
    });
    assert.equal(expiredPing.response.status, 410);
    assert.equal((await fetch(`${webServer.url}/api/sessions`)).status, 200);

    const resumedOpen = await postJson(webServer.url, "/api/browser-client/open", {});
    assert.equal(resumedOpen.response.status, 200);

    const closeResult = await postJson(webServer.url, "/api/browser-client/close", {
      clientId: resumedOpen.body.clientId
    });
    assert.equal(closeResult.response.status, 200);

    await waitForServerShutdown(webServer.url);
    webServer = null;
  } finally {
    if (webServer) {
      await stopServer(webServer.server);
    }

    await rm(tempDir, {
      recursive: true,
      force: true
    });
  }
});
