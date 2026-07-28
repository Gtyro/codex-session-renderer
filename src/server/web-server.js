import http from "node:http";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";
import {
  archiveSession,
  deleteSession,
  getSessionRoots,
  listSessions,
  renameSession,
  restoreSession,
  SESSION_LOCATIONS
} from "../core/session-store.js";
import { sessionToMarkdown } from "../core/markdown.js";
import {
  buildDownloadName,
  buildSessionDetailPayload,
  buildSessionDocument,
  buildSessionListPayload,
  buildSessionPayload
} from "../core/session-view-model.js";
import {
  getRawRequestPathname,
  getStaticContentType,
  INDEX_FILE,
  isBrowserAppRoute,
  resolveWebAsset
} from "./static-asset-routing.js";

const execFileAsync = promisify(execFile);
const DEFAULT_WEB_PORT = 4311;
const DEFAULT_BROWSER_CLIENT_HEARTBEAT_TIMEOUT_MS = 90_000;
const DEFAULT_BROWSER_CLIENT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_BROWSER_CLIENT_SHUTDOWN_DELAY_MS = 5_000;

function isWslEnvironment() {
  return (
    Boolean(process.env.WSL_INTEROP) ||
    Boolean(process.env.WSL_DISTRO_NAME) ||
    /microsoft/i.test(os.release())
  );
}

async function getPortOccupant(port) {
  const portValue = String(port);

  try {
    const { stdout } = await execFileAsync("lsof", [
      "-nP",
      `-iTCP:${portValue}`,
      "-sTCP:LISTEN",
      "-Fpcu"
    ]);
    const lines = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const details = {};

    for (const line of lines) {
      const prefix = line[0];
      const value = line.slice(1);

      if (prefix === "p") {
        details.pid = value;
      }
      if (prefix === "c") {
        details.command = value;
      }
      if (prefix === "u") {
        details.user = value;
      }
    }

    if (!details.pid) {
      return null;
    }

    try {
      const [{ stdout: userOutput }, { stdout: argsOutput }] = await Promise.all([
        execFileAsync("ps", ["-p", details.pid, "-o", "user="]),
        execFileAsync("ps", ["-p", details.pid, "-o", "args="])
      ]);

      details.user = userOutput.trim() || details.user || null;
      details.args = argsOutput.trim() || null;
    } catch {
      details.args = null;
    }

    return details;
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }

    if (error && typeof error.code === "number") {
      return null;
    }

    return null;
  }
}

async function getWindowsHostPortOccupant(port) {
  if (!isWslEnvironment()) {
    return null;
  }

  const script = `
$connection = Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 LocalAddress,LocalPort,OwningProcess
if ($null -eq $connection) { exit 0 }
$process = Get-CimInstance Win32_Process -Filter "ProcessId = $($connection.OwningProcess)" | Select-Object -First 1 Name,CommandLine
[pscustomobject]@{
  localAddress = $connection.LocalAddress
  localPort = $connection.LocalPort
  pid = $connection.OwningProcess
  command = $process.Name
  args = $process.CommandLine
} | ConvertTo-Json -Compress
`.trim();

  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-Command",
      script
    ]);
    const output = stdout.trim();

    if (!output) {
      return null;
    }

    const payload = JSON.parse(output);
    return {
      pid: payload.pid ? String(payload.pid) : null,
      command: payload.command || null,
      args: payload.args || null,
      user: "Windows host",
      localAddress: payload.localAddress || null,
      localPort: payload.localPort || null
    };
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }

    return null;
  }
}

async function createPortInUseError(host, port) {
  const occupant = await getPortOccupant(port);
  const parts = [`Port ${port} on ${host} is already in use.`];

  if (occupant?.pid) {
    const summary = occupant.args || occupant.command || null;
    const owner = occupant.user ? ` by user ${occupant.user}` : "";
    parts.push(`Listener PID ${occupant.pid}${owner}${summary ? `: ${summary}` : ""}`);
  }

  parts.push("Stop the existing process or start with `--port 0` or another free port.");

  const error = new Error(parts.join(" "));
  error.code = "PORT_IN_USE";
  error.port = port;
  error.host = host;
  error.occupant = occupant ?? null;
  return error;
}

async function createWindowsHostPortInUseError(host, port) {
  const occupant = await getWindowsHostPortOccupant(port);
  const parts = [
    `Windows host port ${port} is already in use, so browsers opening http://${host}:${port}/ will hit that Windows service instead of this WSL server.`
  ];

  if (occupant?.pid) {
    const summary = occupant.args || occupant.command || null;
    parts.push(`Windows listener PID ${occupant.pid}${summary ? `: ${summary}` : ""}`);
  }

  parts.push("Choose another port such as `--port 0` or stop the Windows-side listener.");

  const error = new Error(parts.join(" "));
  error.code = "WINDOWS_HOST_PORT_IN_USE";
  error.port = port;
  error.host = host;
  error.occupant = occupant ?? null;
  return error;
}

function normalizePositiveNumber(value, fallbackValue) {
  return Number.isFinite(value) && value >= 0 ? value : fallbackValue;
}

function createBrowserClientController(server, options = {}) {
  const stopWhenIdle = Boolean(options.stopWhenIdle);
  const heartbeatTimeoutMs = normalizePositiveNumber(
    options.clientHeartbeatTimeoutMs,
    DEFAULT_BROWSER_CLIENT_HEARTBEAT_TIMEOUT_MS
  );
  const heartbeatIntervalMs = Math.max(
    1_000,
    normalizePositiveNumber(
      options.clientHeartbeatIntervalMs,
      Math.min(
        DEFAULT_BROWSER_CLIENT_HEARTBEAT_INTERVAL_MS,
        Math.max(1_000, Math.floor(heartbeatTimeoutMs / 3))
      )
    )
  );
  const shutdownDelayMs = normalizePositiveNumber(
    options.stopWhenIdleDelayMs,
    DEFAULT_BROWSER_CLIENT_SHUTDOWN_DELAY_MS
  );
  const pruneIntervalMs = Math.max(1_000, Math.min(heartbeatIntervalMs, 15_000));
  const clients = new Map();
  let hasSeenClient = false;
  let shutdownRequested = false;
  let shutdownTimer = null;
  const pruneTimer = setInterval(() => {
    if (pruneStaleClients()) {
      scheduleShutdownIfIdle();
    }
  }, pruneIntervalMs);

  pruneTimer.unref?.();

  function clearShutdownTimer() {
    if (shutdownTimer) {
      clearTimeout(shutdownTimer);
      shutdownTimer = null;
    }
  }

  function stopTimers() {
    clearShutdownTimer();
    clearInterval(pruneTimer);
  }

  function pruneStaleClients(now = Date.now()) {
    let removed = false;

    for (const [clientId, client] of clients.entries()) {
      if (now - client.lastSeenAt > heartbeatTimeoutMs) {
        clients.delete(clientId);
        removed = true;
      }
    }

    return removed;
  }

  function scheduleShutdownIfIdle() {
    if (!stopWhenIdle || !hasSeenClient || clients.size > 0 || shutdownRequested || shutdownTimer) {
      return;
    }

    shutdownTimer = setTimeout(() => {
      shutdownTimer = null;
      pruneStaleClients();

      if (clients.size > 0 || shutdownRequested) {
        return;
      }

      shutdownRequested = true;
      stopTimers();
      server.close(() => {});
      server.closeIdleConnections?.();
    }, shutdownDelayMs);

    shutdownTimer.unref?.();
  }

  function markClientActive(clientId) {
    const client = clients.get(clientId);

    if (!client) {
      return false;
    }

    client.lastSeenAt = Date.now();
    clearShutdownTimer();
    return true;
  }

  server.once("close", () => {
    shutdownRequested = true;
    stopTimers();
    clients.clear();
  });

  return {
    heartbeatIntervalMs,
    heartbeatTimeoutMs,
    registerClient() {
      pruneStaleClients();
      clearShutdownTimer();
      hasSeenClient = true;

      const clientId = randomUUID();
      clients.set(clientId, {
        lastSeenAt: Date.now()
      });

      return {
        clientId,
        heartbeatIntervalMs,
        heartbeatTimeoutMs
      };
    },
    pingClient(clientId) {
      pruneStaleClients();
      return markClientActive(clientId);
    },
    disconnectClient(clientId) {
      pruneStaleClients();
      const deleted = clients.delete(clientId);

      if (deleted) {
        scheduleShutdownIfIdle();
      }

      return deleted;
    }
  };
}

function sendResponse(response, statusCode, body, contentType) {
  response.writeHead(statusCode, {
    "content-type": contentType,
    "cache-control": "no-store"
  });
  response.end(body);
}

function sendJson(response, statusCode, payload) {
  sendResponse(response, statusCode, JSON.stringify(payload), "application/json; charset=utf-8");
}

function sendError(response, statusCode, error) {
  sendJson(response, statusCode, {
    error: error instanceof Error ? error.message : String(error)
  });
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) {
      throw new Error("Request body is too large.");
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function serveStaticAsset(response, pathname) {
  if (isBrowserAppRoute(pathname)) {
    const body = await readFile(INDEX_FILE);
    sendResponse(response, 200, body, getStaticContentType(INDEX_FILE));
    return true;
  }

  const asset = resolveWebAsset(pathname);

  if (!asset) {
    return false;
  }

  if (asset.error) {
    sendError(response, asset.statusCode, asset.error);
    return true;
  }

  try {
    const body = await readFile(asset.filePath);
    sendResponse(response, 200, body, asset.contentType);
    return true;
  } catch (error) {
    if (error && (error.code === "ENOENT" || error.code === "EISDIR")) {
      return false;
    }

    throw error;
  }
}

async function handleApiRequest(request, response, url, roots, browserClientController) {
  if (request.method === "POST" && url.pathname === "/api/browser-client/open") {
    sendJson(response, 200, browserClientController.registerClient());
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/browser-client/ping") {
    const body = await readJsonBody(request);

    if (!browserClientController.pingClient(body.clientId)) {
      sendError(response, 410, "Browser client session expired.");
      return true;
    }

    sendJson(response, 200, {
      ok: true
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/browser-client/close") {
    const body = await readJsonBody(request);
    browserClientController.disconnectClient(body.clientId);
    sendJson(response, 200, {
      ok: true
    });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/sessions") {
    const items = await listSessions(roots);
    sendJson(response, 200, buildSessionListPayload(items, roots));
    return true;
  }

  if (request.method === "GET" && url.pathname === "/preview") {
    const document = await buildSessionDocument(roots, url.searchParams);
    sendResponse(response, 200, document.html, "text/html; charset=utf-8");
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/session-detail") {
    const payload = await buildSessionPayload(roots, url.searchParams);
    sendJson(response, 200, buildSessionDetailPayload(payload));
    return true;
  }

  if (request.method === "GET" && url.pathname === "/download") {
    const format = url.searchParams.get("format") || "compact-markdown";
    const document = await buildSessionDocument(roots, url.searchParams);
    let body;
    let contentType;

    switch (format) {
      case "full-markdown":
        body = sessionToMarkdown(document.session, { mode: "full" });
        contentType = "text/markdown; charset=utf-8";
        break;
      case "compact-markdown":
        body = sessionToMarkdown(document.session, { mode: "compact" });
        contentType = "text/markdown; charset=utf-8";
        break;
      case "html":
        body = document.html;
        contentType = "text/html; charset=utf-8";
        break;
      default:
        throw new Error(`Unsupported download format: ${format}`);
    }

    response.writeHead(200, {
      "content-type": contentType,
      "content-disposition": `inline; filename="${buildDownloadName(
        document.record,
        format,
        document.previewOptions.mode
      )}"`,
      "cache-control": "no-store"
    });
    response.end(body);
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/sessions/archive") {
    const body = await readJsonBody(request);
    const session = await archiveSession({
      ...roots,
      relativePath: body.relativePath
    });
    sendJson(response, 200, {
      ok: true,
      session
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/sessions/restore") {
    const body = await readJsonBody(request);
    const session = await restoreSession({
      ...roots,
      relativePath: body.relativePath
    });
    sendJson(response, 200, {
      ok: true,
      session
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/sessions/rename") {
    const body = await readJsonBody(request);
    const session = await renameSession({
      ...roots,
      location: body.location || SESSION_LOCATIONS.sessions,
      relativePath: body.relativePath,
      name: body.name
    });
    sendJson(response, 200, {
      ok: true,
      session
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/sessions/delete") {
    const body = await readJsonBody(request);
    await deleteSession({
      ...roots,
      location: SESSION_LOCATIONS.archived,
      relativePath: body.relativePath
    });
    sendJson(response, 200, {
      ok: true
    });
    return true;
  }

  return false;
}

function createRequestHandler(host, port, roots, browserClientController) {
  return async (request, response) => {
    if (!request.url) {
      sendError(response, 400, "Missing request URL.");
      return;
    }

    const rawPathname = getRawRequestPathname(request.url);
    const url = new URL(request.url, `http://${host}:${port}`);

    try {
      // Preserve encoded dot-segments so the static asset guard can reject traversal attempts.
      if (await serveStaticAsset(response, rawPathname)) {
        return;
      }

      if (await handleApiRequest(request, response, url, roots, browserClientController)) {
        return;
      }

      sendError(response, 404, "Route not found.");
    } catch (error) {
      sendError(response, 500, error);
    }
  };
}

async function listenOnPort(server, host, port) {
  await new Promise((resolve, reject) => {
    const handleError = (error) => {
      reject(error);
    };
    const handleListening = () => {
      server.off("error", handleError);
      resolve();
    };

    server.once("error", handleError);
    server.listen(port, host, handleListening);
  });
}

export async function startWebServer(options = {}) {
  const roots = getSessionRoots(options);
  const host = options.host || "127.0.0.1";
  const defaultPort = Number.isFinite(options.defaultPort) ? options.defaultPort : DEFAULT_WEB_PORT;
  const hasExplicitPort = Number.isFinite(options.port);
  const preferredPort = hasExplicitPort ? options.port : defaultPort;
  const canFallbackToRandomPort = !hasExplicitPort && preferredPort !== 0;
  const candidatePorts = canFallbackToRandomPort ? [preferredPort, 0] : [preferredPort];

  for (const candidatePort of candidatePorts) {
    if (candidatePort !== 0 && (host === "127.0.0.1" || host === "localhost" || host === "0.0.0.0")) {
      const windowsHostOccupant = await getWindowsHostPortOccupant(candidatePort);
      if (windowsHostOccupant) {
        if (canFallbackToRandomPort && candidatePort === preferredPort) {
          continue;
        }

        throw await createWindowsHostPortInUseError(host, candidatePort);
      }
    }

    const server = http.createServer();
    const browserClientController = createBrowserClientController(server, options);
    server.on("request", createRequestHandler(host, candidatePort, roots, browserClientController));

    try {
      await listenOnPort(server, host, candidatePort);

      const address = server.address();
      const resolvedPort = typeof address === "object" && address ? address.port : candidatePort;

      return {
        server,
        host,
        port: resolvedPort,
        preferredPort,
        fallbackUsed: canFallbackToRandomPort && resolvedPort !== preferredPort,
        roots,
        url: `http://${host}:${resolvedPort}`
      };
    } catch (error) {
      if (error && error.code === "EADDRINUSE") {
        if (canFallbackToRandomPort && candidatePort === preferredPort) {
          continue;
        }

        throw await createPortInUseError(host, candidatePort);
      }

      throw error;
    }
  }

  throw await createPortInUseError(host, preferredPort);
}
