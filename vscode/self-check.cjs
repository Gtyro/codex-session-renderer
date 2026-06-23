const http = require("node:http");
const https = require("node:https");
const { getBrowserUrls } = require("./server-manager.cjs");

let outputChannel;

function getOutputChannel(vscode) {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel("Codex Session Renderer");
  }

  return outputChannel;
}

function appendLine(channel, line = "") {
  channel.appendLine(line);
}

function formatError(error) {
  if (error instanceof Error) {
    return error.stack || error.message;
  }

  return String(error);
}

function formatDuration(startedAt) {
  return `${Date.now() - startedAt}ms`;
}

function createRequestClient(targetUrl) {
  const parsed = new URL(targetUrl);
  return parsed.protocol === "https:" ? https : http;
}

function requestText(targetUrl) {
  return new Promise((resolve, reject) => {
    const client = createRequestClient(targetUrl);
    const request = client.request(targetUrl, { method: "GET" }, (response) => {
      const chunks = [];

      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        resolve({
          statusCode: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString("utf8")
        });
      });
    });

    request.setTimeout(10000, () => {
      request.destroy(new Error(`Timed out while requesting ${targetUrl}`));
    });
    request.on("error", reject);
    request.end();
  });
}

function assertOkResponse(response, label) {
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`${label} returned HTTP ${response.statusCode}`);
  }
}

function parseJsonResponse(response, label) {
  assertOkResponse(response, label);

  try {
    return JSON.parse(response.body);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function buildSessionUrl(baseUrl, pathname, session, options = {}) {
  const searchParams = new URLSearchParams({
    location: session.location,
    relativePath: session.relativePath,
    rounds: String(options.rounds ?? 1),
    mode: options.mode ?? "compact"
  });

  if (options.all) {
    searchParams.set("all", "1");
  }

  return new URL(`${pathname}?${searchParams.toString()}`, baseUrl).toString();
}

function normalizeComparableUrl(value) {
  const url = new URL(value);
  const normalizedPath = url.pathname.endsWith("/") && url.pathname !== "/" ? url.pathname.slice(0, -1) : url.pathname;
  return `${url.protocol}//${url.host}${normalizedPath}${url.search}`;
}

function looksLikeHtmlDocument(body) {
  const text = String(body ?? "").trimStart();
  return /^<!doctype html>/i.test(text) || /<html\b/i.test(text);
}

async function runStep(channel, results, label, callback) {
  const startedAt = Date.now();

  try {
    const detail = await callback();
    const line = detail ? `PASS ${label} (${formatDuration(startedAt)}): ${detail}` : `PASS ${label} (${formatDuration(startedAt)})`;
    results.push({ level: "pass", label, detail: detail || "" });
    appendLine(channel, line);
    return detail;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ level: "fail", label, detail });
    appendLine(channel, `FAIL ${label} (${formatDuration(startedAt)}): ${detail}`);
    throw error;
  }
}

function addWarning(channel, results, label, detail) {
  results.push({ level: "warn", label, detail });
  appendLine(channel, `WARN ${label}: ${detail}`);
}

async function runSelfCheck(vscode, context) {
  const channel = getOutputChannel(vscode);
  const results = [];
  const startedAt = new Date().toISOString();
  let rootUrls;

  channel.clear();
  channel.show(true);

  appendLine(channel, `Codex Session Renderer self-check started at ${startedAt}`);
  appendLine(channel, `Remote: ${vscode.env.remoteName || "local"}`);
  appendLine(channel);

  try {
    await runStep(channel, results, "Start server and resolve external URL", async () => {
      rootUrls = await getBrowserUrls(vscode, context, "root");
      const roots = rootUrls.handle?.roots || {};
      appendLine(channel, `  Internal URL: ${rootUrls.internalUrl}`);
      appendLine(channel, `  External URL: ${rootUrls.externalUrl}`);
      appendLine(channel, `  Sessions dir: ${roots.sessionsDir || "(unknown)"}`);
      appendLine(channel, `  Archived dir: ${roots.archivedSessionsDir || "(unknown)"}`);
      return normalizeComparableUrl(rootUrls.internalUrl) === normalizeComparableUrl(rootUrls.externalUrl)
        ? "external URI resolved to the same client URL"
        : "external URI translation active";
    });

    const sessionsPayload = await runStep(channel, results, "Fetch session list", async () => {
      const response = await requestText(new URL("/api/sessions", rootUrls.internalUrl).toString());
      const payload = parseJsonResponse(response, "GET /api/sessions");

      if (!Array.isArray(payload.sessions) || !Array.isArray(payload.archivedSessions)) {
        throw new Error("Session list payload is missing sessions/archivedSessions arrays.");
      }

      return `${payload.sessions.length} active, ${payload.archivedSessions.length} archived`;
    }).then(async () => {
      const response = await requestText(new URL("/api/sessions", rootUrls.internalUrl).toString());
      return parseJsonResponse(response, "GET /api/sessions");
    });

    const candidateSession = sessionsPayload.sessions[0] || sessionsPayload.archivedSessions[0] || null;

    if (!candidateSession) {
      addWarning(
        channel,
        results,
        "Preview and detail checks",
        "No sessions were found, so preview/detail/download checks were skipped."
      );
    } else {
      await runStep(channel, results, "Fetch session detail", async () => {
        const url = buildSessionUrl(rootUrls.internalUrl, "/api/session-detail", candidateSession);
        const response = await requestText(url);
        const payload = parseJsonResponse(response, "GET /api/session-detail");

        if (!payload.record?.relativePath || !payload.session || !Array.isArray(payload.session.items)) {
          throw new Error("Session detail payload shape is incomplete.");
        }

        return `${payload.record.id || payload.record.relativePath} with ${payload.session.items.length} items`;
      });

      await runStep(channel, results, "Render preview HTML", async () => {
        const url = buildSessionUrl(rootUrls.internalUrl, "/preview", candidateSession, { all: true, mode: "full" });
        const response = await requestText(url);
        assertOkResponse(response, "GET /preview");

        if (!looksLikeHtmlDocument(response.body)) {
          throw new Error("Preview response did not look like a full HTML document.");
        }

        return `${response.body.length} bytes`;
      });

      await runStep(channel, results, "Download compact markdown", async () => {
        const url = new URL(
          `${buildSessionUrl(rootUrls.internalUrl, "/download", candidateSession)}&format=compact-markdown`
        ).toString();
        const response = await requestText(url);
        assertOkResponse(response, "GET /download");

        if (!response.body.trim()) {
          throw new Error("Download response was empty.");
        }

        return `${response.body.length} bytes`;
      });
    }

    appendLine(channel);
    appendLine(channel, `Self-check finished with ${results.filter((item) => item.level === "warn").length} warning(s).`);

    const actions = ["Open Browser", "Copy URL", "Show Report"];
    const message =
      results.some((item) => item.level === "warn")
        ? "Codex Session Renderer self-check passed with warnings."
        : "Codex Session Renderer self-check passed.";
    const selection = await vscode.window.showInformationMessage(message, ...actions);

    if (selection === "Open Browser" && rootUrls?.externalUrl) {
      await vscode.env.openExternal(vscode.Uri.parse(rootUrls.externalUrl));
    } else if (selection === "Copy URL" && rootUrls?.externalUrl) {
      await vscode.env.clipboard.writeText(rootUrls.externalUrl);
      vscode.window.setStatusBarMessage("Codex Session Renderer URL copied.", 3000);
    } else if (selection === "Show Report") {
      channel.show(true);
    }
  } catch (error) {
    appendLine(channel);
    appendLine(channel, "Self-check failed.");
    appendLine(channel, formatError(error));

    const selection = await vscode.window.showErrorMessage(
      "Codex Session Renderer self-check failed. See output for details.",
      "Show Report"
    );

    if (selection === "Show Report") {
      channel.show(true);
    }
  }
}

module.exports = {
  runSelfCheck
};
