const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

const trackerState = {
  clientId: null,
  heartbeatTimer: null,
  stopped: false,
  lifecycleEventsBound: false,
  registering: null
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
    const error = new Error(`Tracker request failed with status ${response.status}.`);
    error.status = response.status;
    throw error;
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
  } catch (error) {
    if (error?.status === 410) {
      trackerState.clientId = null;
      await registerClient();
      return;
    }

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
  if (trackerState.lifecycleEventsBound) {
    return;
  }

  trackerState.lifecycleEventsBound = true;
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

async function registerClient() {
  if (trackerState.stopped) {
    return;
  }

  if (trackerState.registering) {
    return trackerState.registering;
  }

  trackerState.registering = (async () => {
    try {
      const payload = await requestTracker("/api/browser-client/open", {});
      const clientId = payload?.clientId;

      if (!clientId || trackerState.stopped) {
        return;
      }

      trackerState.clientId = clientId;
      bindLifecycleEvents();
      startHeartbeatTimer(payload.heartbeatIntervalMs || DEFAULT_HEARTBEAT_INTERVAL_MS);
    } catch {
      clearHeartbeatTimer();
    } finally {
      trackerState.registering = null;
    }
  })();

  return trackerState.registering;
}

export async function startBrowserClientLifecycleTracking() {
  if (trackerState.clientId || trackerState.stopped || trackerState.registering) {
    return;
  }

  await registerClient();
}
