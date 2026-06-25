export function sessionKey(item) {
  return `${item.location}:${item.relativePath}`;
}

export function getScopeForSession(session) {
  return session?.location === "archived_sessions" ? "archived" : "active";
}

function findSessionById(id, items) {
  const normalizedId = String(id ?? "").trim();

  if (!normalizedId) {
    return null;
  }

  return items.find((item) => item.id === normalizedId) ?? null;
}

function findSessionByKey(key, items) {
  return items.find((item) => sessionKey(item) === key) ?? null;
}

function getScopeItems(scope, sessions, archivedSessions) {
  if (scope === "active") {
    return sessions;
  }

  if (scope === "archived") {
    return archivedSessions;
  }

  return [...sessions, ...archivedSessions];
}

function isKeyInScope(scope, key, availableKeys, scopedKeys) {
  return scope === "all" ? availableKeys.has(key) : scopedKeys.has(key);
}

export function pickNeighborSessionKey(items, currentKey) {
  const currentIndex = items.findIndex((item) => sessionKey(item) === currentKey);

  if (currentIndex === -1) {
    return null;
  }

  const neighbor = items[currentIndex - 1] || items[currentIndex + 1] || null;
  return neighbor ? sessionKey(neighbor) : null;
}

export function resolveSessionSelectionAfterRefresh({
  scope,
  sessions,
  archivedSessions,
  preferredKey = null,
  preferredId = "",
  fallbackKey = null
}) {
  const availableItems = [...sessions, ...archivedSessions];
  const availableKeys = new Set(availableItems.map((item) => sessionKey(item)));
  const scopedItems = getScopeItems(scope, sessions, archivedSessions);
  const scopedKeys = new Set(scopedItems.map((item) => sessionKey(item)));
  const preferredById = findSessionById(preferredId, availableItems);
  let selectedKey = null;

  if (preferredKey && isKeyInScope(scope, preferredKey, availableKeys, scopedKeys)) {
    selectedKey = preferredKey;
  } else if (
    preferredById &&
    isKeyInScope(scope, sessionKey(preferredById), availableKeys, scopedKeys)
  ) {
    selectedKey = sessionKey(preferredById);
  } else if (fallbackKey && isKeyInScope(scope, fallbackKey, availableKeys, scopedKeys)) {
    selectedKey = fallbackKey;
  } else {
    selectedKey = scopedItems[0] ? sessionKey(scopedItems[0]) : null;
  }

  const selectedSession = selectedKey ? findSessionByKey(selectedKey, availableItems) : null;

  return {
    selectedKey,
    routeSelectedId: selectedSession?.id || ""
  };
}
