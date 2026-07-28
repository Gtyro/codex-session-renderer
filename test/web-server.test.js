import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { startWebServer } from "../src/server/web-server.js";
import { resolveWebAsset } from "../src/server/static-asset-routing.js";

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
