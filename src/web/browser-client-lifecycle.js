const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

const trackerState = {
  clientId: null,
  heartbeatTimer: null,
  stopped: false
};

function clearHeartbeatTimer() {
  if (trackerState.heartbeatTimer) {
    window.clearInterval(trackerState.heartbeatTimer);
    trackerState.heartbeatTimer = null;
  }
}

function buildJsonRequest(body, options = {}) {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body),
    ...options
  };
}

async function requestTracker(pathname, body, options = {}) {
  const response = await fetch(pathname, buildJsonRequest(body, options));

  if (!response.ok) {
    throw new Error(`Tracker request failed with status ${response.status}.`);
  }

  const contentType = response.headers.get("content-type") || "";

  if (!contentType.includes("application/json")) {
    return null;
  }

  return await response.json();
}

async function sendHeartbeat() {
  if (trackerState.stopped || !trackerState.clientId) {
    return;
  }

  try {
    await requestTracker("/api/browser-client/ping", {
      clientId: trackerState.clientId
    });
  } catch {
    clearHeartbeatTimer();
  }
}

function startHeartbeatTimer(intervalMs) {
  clearHeartbeatTimer();
  trackerState.heartbeatTimer = window.setInterval(() => {
    sendHeartbeat().catch(() => {});
  }, Math.max(1_000, intervalMs));
}

function notifyClose() {
  if (trackerState.stopped || !trackerState.clientId) {
    return;
  }

  trackerState.stopped = true;
  clearHeartbeatTimer();
  const payload = JSON.stringify({
    clientId: trackerState.clientId
  });
  const blob = new Blob([payload], {
    type: "application/json"
  });

  if (navigator.sendBeacon?.("/api/browser-client/close", blob)) {
    return;
  }

  fetch(
    "/api/browser-client/close",
    buildJsonRequest(
      {
        clientId: trackerState.clientId
      },
      {
        keepalive: true
      }
    )
  ).catch(() => {});
}

function bindLifecycleEvents() {
  window.addEventListener("pagehide", notifyClose, {
    capture: true
  });
  window.addEventListener("beforeunload", notifyClose, {
    capture: true
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      sendHeartbeat().catch(() => {});
    }
  });
}

export async function startBrowserClientLifecycleTracking() {
  if (trackerState.clientId || trackerState.stopped) {
    return;
  }

  try {
    const payload = await requestTracker("/api/browser-client/open", {});
    const clientId = payload?.clientId;

    if (!clientId) {
      return;
    }

    trackerState.clientId = clientId;
    bindLifecycleEvents();
    startHeartbeatTimer(payload.heartbeatIntervalMs || DEFAULT_HEARTBEAT_INTERVAL_MS);
  } catch {
    clearHeartbeatTimer();
  }
}
