export const UNKNOWN_WORKSPACE_KEY = "__unknown_workspace__";
export const UNKNOWN_WORKSPACE_LABEL = "未记录工作区";

function normalizeWorkspace(workspace) {
  const normalized = String(workspace ?? "").trim().replace(/[\\/]+$/u, "");
  return normalized || null;
}

export function getWorkspaceGroupKey(session) {
  return normalizeWorkspace(session?.workspace) || UNKNOWN_WORKSPACE_KEY;
}

export function getWorkspaceDisplayName(workspace) {
  const normalized = normalizeWorkspace(workspace);

  if (!normalized) {
    return UNKNOWN_WORKSPACE_LABEL;
  }

  return normalized.split(/[\\/]/u).filter(Boolean).at(-1) || normalized;
}

export function sortSessionsByModified(sessions) {
  return [...(Array.isArray(sessions) ? sessions : [])].sort(
    (left, right) =>
      (Number(right.modifiedMs) || 0) - (Number(left.modifiedMs) || 0) ||
      String(left.id ?? "").localeCompare(String(right.id ?? ""))
  );
}

export function pickNeighborWorkspaceKey(groups, currentKey) {
  const currentIndex = groups.findIndex((group) => group.key === currentKey);

  if (currentIndex === -1) {
    return null;
  }

  return groups[currentIndex - 1]?.key || groups[currentIndex + 1]?.key || null;
}

export function getOldestWorkspaceSession(groups, workspaceKey) {
  const group = groups.find((item) => item.key === workspaceKey);
  return group?.sessions.at(-1) || null;
}

/**
 * Preserve the session ordering within each group and order recorded
 * workspaces by their most recently modified session. The unrecorded fallback
 * always stays last so it does not displace an actual workspace.
 */
export function groupSessionsByWorkspace(sessions) {
  const groupsByKey = new Map();

  for (const session of Array.isArray(sessions) ? sessions : []) {
    const key = getWorkspaceGroupKey(session);
    let group = groupsByKey.get(key);

    if (!group) {
      const workspace = key === UNKNOWN_WORKSPACE_KEY ? null : key;
      group = {
        key,
        workspace,
        label: getWorkspaceDisplayName(workspace),
        sessions: []
      };
      groupsByKey.set(key, group);
    }

    group.sessions.push(session);
  }

  for (const group of groupsByKey.values()) {
    group.sessions = sortSessionsByModified(group.sessions);
    group.modifiedMs = Number(group.sessions[0]?.modifiedMs) || 0;
  }

  return [...groupsByKey.values()].sort((left, right) => {
    if (left.key === UNKNOWN_WORKSPACE_KEY) {
      return right.key === UNKNOWN_WORKSPACE_KEY ? 0 : 1;
    }

    if (right.key === UNKNOWN_WORKSPACE_KEY) {
      return -1;
    }

    return right.modifiedMs - left.modifiedMs || left.label.localeCompare(right.label, "zh-CN");
  });
}
