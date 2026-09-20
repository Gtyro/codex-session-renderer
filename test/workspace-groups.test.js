import test from "node:test";
import assert from "node:assert/strict";
import {
  getOldestWorkspaceSession,
  UNKNOWN_WORKSPACE_KEY,
  getWorkspaceDisplayName,
  getWorkspaceGroupKey,
  groupSessionsByWorkspace,
  pickNeighborWorkspaceKey,
  sortSessionsByModified
} from "../src/web/workspace-groups.js";

test("workspace grouping keeps sessions together, surfaces recent workspaces first, and puts unrecorded sessions last", () => {
  const sessions = [
    { id: "recent", workspace: "/projects/renderer", modifiedMs: 30 },
    { id: "unknown", workspace: null, modifiedMs: 40 },
    { id: "older", workspace: "/projects/renderer/", modifiedMs: 10 },
    { id: "archive", workspace: "/projects/api", modifiedMs: 25 }
  ];

  assert.deepEqual(
    groupSessionsByWorkspace(sessions).map((group) => ({
      key: group.key,
      label: group.label,
      sessionIds: group.sessions.map((session) => session.id)
    })),
    [
      {
        key: "/projects/renderer",
        label: "renderer",
        sessionIds: ["recent", "older"]
      },
      {
        key: "/projects/api",
        label: "api",
        sessionIds: ["archive"]
      },
      {
        key: UNKNOWN_WORKSPACE_KEY,
        label: "未记录工作区",
        sessionIds: ["unknown"]
      }
    ]
  );
});

test("workspace labels support Windows-style paths and a missing cwd", () => {
  assert.equal(getWorkspaceDisplayName("C:\\work\\renderer\\"), "renderer");
  assert.equal(getWorkspaceGroupKey({ workspace: "" }), UNKNOWN_WORKSPACE_KEY);
  assert.equal(getWorkspaceDisplayName(null), "未记录工作区");
});

test("session ordering uses modified time across active and archived records", () => {
  const sessions = [
    { id: "active", modifiedMs: 10 },
    { id: "archived", modifiedMs: 30 },
    { id: "other", modifiedMs: 20 }
  ];

  assert.deepEqual(sortSessionsByModified(sessions).map((session) => session.id), [
    "archived",
    "other",
    "active"
  ]);
});

test("workspace fallback prefers the preceding option and selects the oldest session", () => {
  const groups = groupSessionsByWorkspace([
    { id: "renderer-new", workspace: "/projects/renderer", modifiedMs: 40 },
    { id: "renderer-old", workspace: "/projects/renderer", modifiedMs: 10 },
    { id: "api", workspace: "/projects/api", modifiedMs: 30 },
    { id: "cli", workspace: "/projects/cli", modifiedMs: 20 },
    { id: "unknown", workspace: null, modifiedMs: 50 }
  ]);

  assert.equal(pickNeighborWorkspaceKey(groups, "/projects/api"), "/projects/renderer");
  assert.equal(pickNeighborWorkspaceKey(groups, "/projects/renderer"), "/projects/api");
  assert.equal(pickNeighborWorkspaceKey(groups, UNKNOWN_WORKSPACE_KEY), "/projects/cli");
  assert.equal(getOldestWorkspaceSession(groups, "/projects/renderer")?.id, "renderer-old");
  assert.equal(getOldestWorkspaceSession(groups, "missing"), null);
});
