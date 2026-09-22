import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "..");
const serverManagerPath = path.join(repoRoot, "vscode", "server-manager.cjs");

function loadServerManager() {
  delete require.cache[serverManagerPath];
  return require(serverManagerPath);
}

function createVscodeMock({
  host = "127.0.0.1",
  port,
  sessionsDir = "",
  archivedSessionsDir = "",
  clientHeartbeatTimeoutMinutes = 10
} = {}) {
  const hasExplicitPort = port !== undefined;

  return {
    workspace: {
      getConfiguration() {
        return {
          get(key) {
            switch (key) {
              case "host":
                return host;
              case "port":
                return hasExplicitPort ? port : 4311;
              case "sessionsDir":
                return sessionsDir;
              case "archivedSessionsDir":
                return archivedSessionsDir;
              case "clientHeartbeatTimeoutMinutes":
                return clientHeartbeatTimeoutMinutes;
              default:
                return undefined;
            }
          },
          inspect(key) {
            if (key !== "port" || !hasExplicitPort) {
              return {
                globalValue: undefined,
                workspaceValue: undefined,
                workspaceFolderValue: undefined
              };
            }

            return {
              globalValue: port,
              workspaceValue: undefined,
              workspaceFolderValue: undefined
            };
          }
        };
      }
    },
    env: {
      async asExternalUri(uri) {
        return {
          toString() {
            return uri.toString();
          }
        };
      }
    },
    Uri: {
      parse(value) {
        return {
          toString() {
            return value;
          }
        };
      }
    }
  };
}

async function createSessionRoots(rootDir, label) {
  const sessionsDir = path.join(rootDir, `${label}-sessions`);
  const archivedSessionsDir = path.join(rootDir, `${label}-archived`);
  await Promise.all([
    mkdir(sessionsDir, { recursive: true }),
    mkdir(archivedSessionsDir, { recursive: true })
  ]);

  return {
    sessionsDir,
    archivedSessionsDir
  };
}

async function assertSessionsEndpoint(url) {
  const response = await fetch(new URL("/api/sessions", url));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.ok(Array.isArray(payload.sessions));
  assert.ok(Array.isArray(payload.archivedSessions));
}

async function postJson(url, pathname, payload) {
  const response = await fetch(new URL(pathname, url), {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const body = await response.json();

  return {
    response,
    body
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

test("server manager reuses a shared server across VS Code windows and only detaches non-owners", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "csr-vscode-manager-"));
  const globalStorageDir = path.join(tempDir, "global-storage");
  const roots = await createSessionRoots(tempDir, "shared");
  const context = {
    extensionPath: repoRoot,
    globalStorageUri: {
      fsPath: globalStorageDir
    }
  };
  const vscode = createVscodeMock(roots);
  const ownerManager = loadServerManager();
  const sharedManager = loadServerManager();

  try {
    const ownerUrls = await ownerManager.getBrowserUrls(vscode, context, "root");
    const sharedUrls = await sharedManager.getBrowserUrls(vscode, context, "root");

    assert.equal(ownerUrls.internalUrl, sharedUrls.internalUrl);
    await assertSessionsEndpoint(ownerUrls.internalUrl);

    assert.deepEqual(await sharedManager.stopServer(), {
      action: "detached"
    });
    await assertSessionsEndpoint(ownerUrls.internalUrl);

    assert.deepEqual(await ownerManager.stopServer(), {
      action: "stopped"
    });
    await assert.rejects(fetch(new URL("/api/sessions", ownerUrls.internalUrl)));
  } finally {
    await sharedManager.stopServer().catch(() => {});
    await ownerManager.stopServer().catch(() => {});
    await rm(tempDir, {
      recursive: true,
      force: true
    });
  }
});

test("server manager reuses the same shared server even when another window has different session root settings", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "csr-vscode-manager-config-"));
  const globalStorageDir = path.join(tempDir, "global-storage");
  const rootsA = await createSessionRoots(tempDir, "a");
  const rootsB = await createSessionRoots(tempDir, "b");
  const context = {
    extensionPath: repoRoot,
    globalStorageUri: {
      fsPath: globalStorageDir
    }
  };
  const vscodeA = createVscodeMock(rootsA);
  const vscodeB = createVscodeMock(rootsB);
  const managerA = loadServerManager();
  const managerB = loadServerManager();

  try {
    const urlsA = await managerA.getBrowserUrls(vscodeA, context, "root");
    await assertSessionsEndpoint(urlsA.internalUrl);
    const urlsB = await managerB.getBrowserUrls(vscodeB, context, "root");
    assert.equal(urlsA.internalUrl, urlsB.internalUrl);
    await assertSessionsEndpoint(urlsB.internalUrl);

    assert.deepEqual(await managerB.stopServer(), {
      action: "detached"
    });
    assert.deepEqual(await managerB.stopServer(), {
      action: "idle"
    });
    assert.deepEqual(await managerA.stopServer(), {
      action: "stopped"
    });
  } finally {
    await managerA.stopServer().catch(() => {});
    await managerB.stopServer().catch(() => {});
    await rm(tempDir, {
      recursive: true,
      force: true
    });
  }
});

test("server manager does not reuse a shared server from a different extension version", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "csr-vscode-manager-version-"));
  const globalStorageDir = path.join(tempDir, "global-storage");
  const roots = await createSessionRoots(tempDir, "version");
  const ownerContext = {
    extensionPath: repoRoot,
    extension: {
      packageJSON: {
        version: "0.1.9"
      }
    },
    globalStorageUri: {
      fsPath: globalStorageDir
    }
  };
  const upgradedContext = {
    ...ownerContext,
    extension: {
      packageJSON: {
        version: "0.1.10"
      }
    }
  };
  const vscode = createVscodeMock({
    ...roots,
    port: 0
  });
  const ownerManager = loadServerManager();
  const upgradedManager = loadServerManager();

  try {
    const ownerUrls = await ownerManager.getBrowserUrls(vscode, ownerContext, "root");
    const upgradedUrls = await upgradedManager.getBrowserUrls(vscode, upgradedContext, "root");

    assert.notEqual(upgradedUrls.internalUrl, ownerUrls.internalUrl);
    await assertSessionsEndpoint(upgradedUrls.internalUrl);
  } finally {
    await upgradedManager.stopServer().catch(() => {});
    await ownerManager.stopServer().catch(() => {});
    await rm(tempDir, {
      recursive: true,
      force: true
    });
  }
});

test("server manager recreates an auto-stopped shared server on the next browser open request", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "csr-vscode-manager-idle-"));
  const globalStorageDir = path.join(tempDir, "global-storage");
  const roots = await createSessionRoots(tempDir, "idle");
  const context = {
    extensionPath: repoRoot,
    globalStorageUri: {
      fsPath: globalStorageDir
    }
  };
  const vscode = createVscodeMock(roots);
  const ownerManager = loadServerManager();
  const sharedManager = loadServerManager();

  try {
    const ownerUrls = await ownerManager.getBrowserUrls(vscode, context, "root");
    const sharedUrls = await sharedManager.getBrowserUrls(vscode, context, "root");
    assert.equal(ownerUrls.internalUrl, sharedUrls.internalUrl);
    await assertSessionsEndpoint(ownerUrls.internalUrl);

    const openResult = await postJson(ownerUrls.internalUrl, "/api/browser-client/open", {});
    assert.equal(openResult.response.status, 200);

    const closeResult = await postJson(ownerUrls.internalUrl, "/api/browser-client/close", {
      clientId: openResult.body.clientId
    });
    assert.equal(closeResult.response.status, 200);

    await waitForServerShutdown(ownerUrls.internalUrl, 12_000);

    const reopenedUrls = await sharedManager.getBrowserUrls(vscode, context, "root");
    await assertSessionsEndpoint(reopenedUrls.internalUrl);
  } finally {
    await sharedManager.stopServer().catch(() => {});
    await ownerManager.stopServer().catch(() => {});
    await rm(tempDir, {
      recursive: true,
      force: true
    });
  }
});

test("server manager forwards the configured browser client heartbeat timeout", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "csr-vscode-manager-heartbeat-"));
  const roots = await createSessionRoots(tempDir, "heartbeat");
  const context = {
    extensionPath: repoRoot
  };
  const vscode = createVscodeMock({
    ...roots,
    clientHeartbeatTimeoutMinutes: 2
  });
  const manager = loadServerManager();

  try {
    const urls = await manager.getBrowserUrls(vscode, context, "root");
    const openResult = await postJson(urls.internalUrl, "/api/browser-client/open", {});
    assert.equal(openResult.response.status, 200);
    assert.equal(openResult.body.heartbeatTimeoutMs, 120_000);
  } finally {
    await manager.stopServer().catch(() => {});
    await rm(tempDir, {
      recursive: true,
      force: true
    });
  }
});
