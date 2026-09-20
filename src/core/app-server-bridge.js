import { spawn } from "node:child_process";
import readline from "node:readline";
import { appendCampaignEvent, readCampaign, setCampaignAppServerStatus } from "./campaign-store.js";

export const APP_SERVER_NOTIFICATION_METHODS = new Set([
  "thread/updated",
  "thread/tokenUsage/updated",
  "turn/started",
  "turn/completed",
  "turn/diff/updated",
  "turn/plan/updated",
  "item/started",
  "item/completed"
]);

const REQUIRED_INITIALIZE_FIELDS = ["codexHome", "platformFamily", "platformOs", "userAgent"];

/**
 * The App Server does not advertise individual notifications at runtime. A
 * successful v1 initialize reply has this stable shape, and this adapter owns
 * the enumerated notification vocabulary above. Treat any other shape as an
 * incompatible protocol instead of silently recording a partial campaign.
 */
export function getAppServerCapabilities(result) {
  if (!result || typeof result !== "object") {
    throw new Error("App Server initialize returned no protocol capabilities.");
  }

  const missing = REQUIRED_INITIALIZE_FIELDS.filter((field) => !String(result[field] || "").trim());
  if (missing.length > 0) {
    throw new Error(`App Server initialize response is incompatible (missing ${missing.join(", ")}).`);
  }

  const userAgent = String(result.userAgent).trim();
  const serverVersion = result?.serverInfo?.version || result?.version || null;
  const userAgentVersion = userAgent.match(/(?:codex(?:[_ -]cli(?:[_ -]rs)?)?|codex-cli)[/ ]([^\s;]+)/iu)?.[1] || null;

  return {
    protocolVersion: serverVersion || userAgentVersion || userAgent,
    eventMethods: [...APP_SERVER_NOTIFICATION_METHODS],
    userAgent
  };
}

function compact(value, maxLength = 8_000) {
  const text = JSON.stringify(value ?? null);
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function findAttachment(manifest, threadId) {
  return manifest.threads.find((entry) => entry.threadId === threadId) || null;
}

function eventData(method, params) {
  switch (method) {
    case "thread/tokenUsage/updated":
      return {
        threadId: params.threadId,
        turnId: params.turnId,
        tokenUsage: params.tokenUsage || null
      };
    case "turn/started":
    case "turn/completed":
      return {
        threadId: params.threadId,
        turn: params.turn
          ? {
              id: params.turn.id,
              status: params.turn.status,
              durationMs: params.turn.durationMs ?? null,
              error: params.turn.error?.message || null
            }
          : null
      };
    case "turn/diff/updated":
      return { threadId: params.threadId, turnId: params.turnId, diff: String(params.diff || "") };
    case "turn/plan/updated":
      return { threadId: params.threadId, turnId: params.turnId, plan: params.plan || [], explanation: params.explanation || null };
    case "item/started":
    case "item/completed":
      return {
        threadId: params.threadId,
        turnId: params.turnId,
        timestamp: params.startedAtMs || params.completedAtMs || null,
        item: params.item || null
      };
    default:
      return { threadId: params.threadId || null, payload: compact(params) };
  }
}

/** Convert the App Server notification vocabulary into the campaign event vocabulary. */
export async function ingestAppServerNotification({ rootDir, campaignId, notification }) {
  if (!notification || !APP_SERVER_NOTIFICATION_METHODS.has(notification.method)) {
    return null;
  }

  const params = notification.params || {};
  const manifest = await readCampaign({ rootDir, id: campaignId });
  const attachment = findAttachment(manifest, params.threadId);

  if (!attachment) {
    return null;
  }

  const suffix = notification.method.replaceAll("/", ".");
  return appendCampaignEvent({
    rootDir,
    id: campaignId,
    type: `${attachment.role}.${suffix}`,
    role: attachment.role,
    taskId: attachment.taskId,
    revision: attachment.revision,
    data: eventData(notification.method, params)
  });
}

/**
 * Attach to the local managed App Server through its proxy. This process only
 * observes JSON-RPC; it never starts or owns a Codex task.
 */
export function startAppServerCampaignBridge({ rootDir, campaignId, command = "codex", args = ["app-server", "proxy"], version = "0.1.8", onError = null }) {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  let nextRequestId = 1;
  let initialized = false;

  function send(method, params) {
    const id = nextRequestId++;
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
  }

  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (Object.hasOwn(message, "id")) {
      const request = pending.get(message.id);
      if (request) {
        pending.delete(message.id);
        if (message.error) {
          request.reject(new Error(message.error.message || "App Server request failed."));
        } else {
          request.resolve(message.result);
        }
      }
      return;
    }

    ingestAppServerNotification({ rootDir, campaignId, notification: message }).catch((error) => onError?.(error));
  });

  child.stderr.on("data", (chunk) => onError?.(new Error(String(chunk).trim())));
  child.once("error", (error) => {
    setCampaignAppServerStatus({ rootDir, id: campaignId, status: "unavailable", error: error.message }).catch(() => {});
    onError?.(error);
  });
  child.once("close", (code) => {
    for (const request of pending.values()) {
      request.reject(new Error(`App Server proxy closed (${code ?? "unknown"}).`));
    }
    pending.clear();
    setCampaignAppServerStatus({
      rootDir,
      id: campaignId,
      status: initialized ? "disconnected" : "unavailable",
      error: initialized ? null : `App Server proxy closed (${code ?? "unknown"}).`
    }).catch(() => {});
  });

  const ready = send("initialize", {
    clientInfo: { name: "codex-session-renderer", version },
    capabilities: { experimentalApi: true }
  })
    .then(async (result) => {
      const capabilities = getAppServerCapabilities(result);
      initialized = true;
      await setCampaignAppServerStatus({
        rootDir,
        id: campaignId,
        status: "connected",
        protocolVersion: capabilities.protocolVersion,
        capabilities
      });
      await appendCampaignEvent({
        rootDir,
        id: campaignId,
        type: "campaign.app-server.ready",
        role: "system",
        data: capabilities
      });
      return result;
    })
    .catch(async (error) => {
      await setCampaignAppServerStatus({ rootDir, id: campaignId, status: "unavailable", error: error.message });
      await appendCampaignEvent({
        rootDir,
        id: campaignId,
        type: "campaign.app-server.error",
        role: "system",
        data: { message: error.message }
      });
      throw error;
    });

  return {
    child,
    ready,
    get initialized() {
      return initialized;
    },
    close() {
      lines.close();
      child.stdin.end();
      child.kill("SIGTERM");
    }
  };
}
