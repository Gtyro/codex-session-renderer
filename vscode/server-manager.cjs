const path = require("node:path");
const { pathToFileURL } = require("node:url");

let serverHandlePromise = null;

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

  return {
    host,
    port: Number.isFinite(configuredPort) ? configuredPort : 4311
  };
}

async function createServerHandle(vscode, context) {
  const { startWebServer } = await loadServerModule(context);
  const { host, port } = getConfiguredServer(vscode);
  const roots = getConfiguredRoots(vscode);
  return startWebServer({
    host,
    port,
    ...roots
  });
}

async function ensureServer(vscode, context) {
  if (!serverHandlePromise) {
    serverHandlePromise = createServerHandle(vscode, context).catch((error) => {
      serverHandlePromise = null;
      throw error;
    });
  }

  return serverHandlePromise;
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

async function stopServer() {
  if (!serverHandlePromise) {
    return false;
  }

  const handle = await serverHandlePromise;
  serverHandlePromise = null;

  await new Promise((resolve, reject) => {
    handle.server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

  return true;
}

module.exports = {
  getBrowserUrls,
  buildLatestPreviewUrl,
  ensureServer,
  resolveExternalUrl,
  stopServer
};
