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
