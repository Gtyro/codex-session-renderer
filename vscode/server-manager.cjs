const { mkdir, readFile, rm, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const REGISTRY_BASENAME = "shared-server";
const SERVER_PROBE_TIMEOUT_MS = 1_500;
const DEFAULT_CLIENT_HEARTBEAT_TIMEOUT_MINUTES = 10;

let serverStatePromise = null;

function getProjectRoot(context) {
  return context.extensionPath || path.resolve(__dirname, "..");
}

async function importModule(modulePath) {
  return import(pathToFileURL(modulePath).href);
}

async function loadServerModule(context) {
  const projectRoot = getProjectRoot(context);
  const modulePath = path.join(projectRoot, "src", "server", "web-server.js");
  return importModule(modulePath);
}

function getConfiguredRoots(vscode) {
  const config = vscode.workspace.getConfiguration("codexSessionRenderer");
  const sessionsDir = config.get("sessionsDir") || undefined;
  const archivedSessionsDir = config.get("archivedSessionsDir") || undefined;

  return {
    sessionsDir,
    archivedSessionsDir
  };
}

function getConfiguredServer(vscode) {
  const config = vscode.workspace.getConfiguration("codexSessionRenderer");
  const host = config.get("host") || "127.0.0.1";
  const configuredPort = Number(config.get("port"));
  const configuredHeartbeatTimeoutMinutes = Number(config.get("clientHeartbeatTimeoutMinutes"));
  const inspectedPort = config.inspect("port");
  const hasExplicitPort =
    inspectedPort?.globalValue !== undefined ||
    inspectedPort?.workspaceValue !== undefined ||
    inspectedPort?.workspaceFolderValue !== undefined;

  return {
    host,
    port: hasExplicitPort && Number.isFinite(configuredPort) ? configuredPort : undefined,
    clientHeartbeatTimeoutMs:
      Number.isFinite(configuredHeartbeatTimeoutMinutes) && configuredHeartbeatTimeoutMinutes >= 1
        ? Math.round(configuredHeartbeatTimeoutMinutes * 60_000)
        : DEFAULT_CLIENT_HEARTBEAT_TIMEOUT_MINUTES * 60_000
  };
}

function getSharedStorageDir(context) {
  return context?.globalStorageUri?.fsPath || null;
}

function getRegistryPaths(storageDir) {
  return {
    registryFile: path.join(storageDir, `${REGISTRY_BASENAME}.json`)
  };
}

async function readRegistry(registryFile) {
  try {
    const source = await readFile(registryFile, "utf8");
    const payload = JSON.parse(source);
    return payload && typeof payload === "object" ? payload : null;
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }

    if (error instanceof SyntaxError) {
      return null;
    }

    throw error;
  }
}

async function probeSharedServer(registry) {
  if (!registry || typeof registry.url !== "string" || !registry.url) {
    return false;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, SERVER_PROBE_TIMEOUT_MS);

  try {
    const response = await fetch(new URL("/api/sessions", registry.url), {
      signal: controller.signal
    });

    if (!response.ok) {
      return false;
    }

    const payload = await response.json();
    return (
      Array.isArray(payload?.sessions) &&
      Array.isArray(payload?.archivedSessions) &&
      payload?.roots?.sessionsDir === registry?.roots?.sessionsDir &&
      payload?.roots?.archivedSessionsDir === registry?.roots?.archivedSessionsDir
    );
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

function createSharedHandleFromRegistry(registry) {
  const parsedUrl = new URL(registry.url);
  const port = Number.parseInt(parsedUrl.port || "", 10);

  return {
    host: registry.host || parsedUrl.hostname,
    port: Number.isFinite(registry.port) ? registry.port : Number.isFinite(port) ? port : undefined,
    preferredPort: Number.isFinite(registry.preferredPort) ? registry.preferredPort : undefined,
    fallbackUsed: Boolean(registry.fallbackUsed),
    roots: registry.roots || {},
    url: registry.url
  };
}

function buildRegistryPayload(handle) {
  return {
    version: 1,
    host: handle.host,
    port: handle.port,
    preferredPort: handle.preferredPort,
    fallbackUsed: Boolean(handle.fallbackUsed),
    roots: handle.roots,
    url: handle.url,
    startedAt: new Date().toISOString()
  };
}

async function createServerHandle(vscode, context) {
  const { startWebServer } = await loadServerModule(context);
  const { host, port, clientHeartbeatTimeoutMs } = getConfiguredServer(vscode);
  const roots = getConfiguredRoots(vscode);
  return startWebServer({
    host,
    port,
    stopWhenIdle: true,
    clientHeartbeatTimeoutMs,
    ...roots
  });
}

async function createOwnedServerState(vscode, context, registryFile = null) {
  const handle = await createServerHandle(vscode, context);

  try {
    if (registryFile) {
      await writeFile(registryFile, JSON.stringify(buildRegistryPayload(handle), null, 2));
    }
  } catch (error) {
    await new Promise((resolve) => {
      handle.server.close(() => {
        resolve();
      });
    });
    throw error;
  }

  return {
    ownership: "local",
    handle,
    registryFile
  };
}

async function resolveServerState(vscode, context) {
  const sharedStorageDir = getSharedStorageDir(context);

  if (!sharedStorageDir) {
    return createOwnedServerState(vscode, context);
  }

  await mkdir(sharedStorageDir, { recursive: true });
  const registryPaths = getRegistryPaths(sharedStorageDir);
  const existingRegistry = await readRegistry(registryPaths.registryFile);

  if (existingRegistry && (await probeSharedServer(existingRegistry))) {
    return {
      ownership: "shared",
      handle: createSharedHandleFromRegistry(existingRegistry),
      registryFile: registryPaths.registryFile
    };
  }

  if (existingRegistry) {
    await rm(registryPaths.registryFile, { force: true });
  }

  return createOwnedServerState(vscode, context, registryPaths.registryFile);
}

async function isServerStateUsable(state) {
  if (!state?.handle?.url) {
    return false;
  }

  if (state.ownership === "local") {
    return Boolean(state.handle?.server?.listening);
  }

  if (state.ownership === "shared") {
    return probeSharedServer({
      url: state.handle.url,
      roots: state.handle.roots
    });
  }

  return false;
}

function attachOwnedServerCloseListener(statePromise) {
  statePromise
    .then((state) => {
      if (state.ownership !== "local" || !state.handle?.server) {
        return;
      }

      state.handle.server.once("close", () => {
        removeOwnedRegistry(state).catch(() => {});

        if (serverStatePromise === statePromise) {
          serverStatePromise = null;
        }
      });
    })
    .catch(() => {});
}

async function ensureServerState(vscode, context) {
  if (serverStatePromise) {
    const currentPromise = serverStatePromise;

    try {
      const state = await currentPromise;

      if (serverStatePromise === currentPromise && (await isServerStateUsable(state))) {
        return state;
      }
    } catch {
      if (serverStatePromise === currentPromise) {
        serverStatePromise = null;
      }
    }

    if (serverStatePromise === currentPromise) {
      serverStatePromise = null;
    }
  }

  if (!serverStatePromise) {
    const nextPromise = resolveServerState(vscode, context).catch((error) => {
      if (serverStatePromise === nextPromise) {
        serverStatePromise = null;
      }
      throw error;
    });
    serverStatePromise = nextPromise;
    attachOwnedServerCloseListener(nextPromise);
  }

  return serverStatePromise;
}

async function ensureServer(vscode, context) {
  const state = await ensureServerState(vscode, context);
  return state.handle;
}

async function buildLatestPreviewUrl(vscode, context) {
  const projectRoot = getProjectRoot(context);
  const sessionStoreModulePath = path.join(projectRoot, "src", "core", "session-store.js");
  const { getSessionRoots, resolveSessionFile, SESSION_LOCATIONS } = await importModule(
    sessionStoreModulePath
  );
  const configuredRoots = getConfiguredRoots(vscode);
  const roots = getSessionRoots(configuredRoots);
  const latestSessionFile = await resolveSessionFile({
    ...configuredRoots,
    latest: true,
    location: SESSION_LOCATIONS.sessions
  });
  const relativePath = path.relative(roots.sessionsDir, latestSessionFile).split(path.sep).join("/");
  const handle = await ensureServer(vscode, context);
  const searchParams = new URLSearchParams({
    location: SESSION_LOCATIONS.sessions,
    relativePath,
    mode: "full",
    all: "1"
  });

  return new URL(`/preview?${searchParams.toString()}`, handle.url).toString();
}

async function resolveExternalUrl(vscode, url) {
  const externalUri = await vscode.env.asExternalUri(vscode.Uri.parse(url));
  return externalUri.toString();
}

async function getBrowserUrls(vscode, context, target = "root") {
  const handle = await ensureServer(vscode, context);
  const internalUrl = target === "latest" ? await buildLatestPreviewUrl(vscode, context) : handle.url;
  const externalUrl = await resolveExternalUrl(vscode, internalUrl);

  return {
    handle,
    internalUrl,
    externalUrl
  };
}

async function removeOwnedRegistry(state) {
  if (!state?.registryFile) {
    return;
  }

  const registry = await readRegistry(state.registryFile);

  if (registry?.url === state.handle?.url) {
    await rm(state.registryFile, { force: true });
  }
}

async function stopServer() {
  if (!serverStatePromise) {
    return {
      action: "idle"
    };
  }

  const statePromise = serverStatePromise;
  serverStatePromise = null;
  const state = await statePromise;

  if (state.ownership !== "local" || !state.handle?.server) {
    return {
      action: "detached"
    };
  }

  let closeError = null;

  try {
    await new Promise((resolve, reject) => {
      state.handle.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  } catch (error) {
    closeError = error;
  }

  await removeOwnedRegistry(state).catch(() => {});

  if (closeError) {
    throw closeError;
  }

  return {
    action: "stopped"
  };
}

module.exports = {
  getBrowserUrls,
  buildLatestPreviewUrl,
  ensureServer,
  resolveExternalUrl,
  stopServer
};
