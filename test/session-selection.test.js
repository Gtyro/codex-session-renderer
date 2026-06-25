import test from "node:test";
import assert from "node:assert/strict";
import {
  pickNeighborSessionKey,
  resolveSessionSelectionAfterRefresh,
  sessionKey
} from "../src/web/session-selection.js";

function buildSession({ id, location = "sessions", relativePath }) {
  return {
    id,
    location,
    relativePath
  };
}

test("pickNeighborSessionKey prefers the previous sidebar item before the next one", () => {
  const sessions = [
    buildSession({ id: "newer", relativePath: "2026/06/25/newer.jsonl" }),
    buildSession({ id: "current", relativePath: "2026/06/24/current.jsonl" }),
    buildSession({ id: "older", relativePath: "2026/06/23/older.jsonl" })
  ];

  assert.equal(
    pickNeighborSessionKey(sessions, sessionKey(sessions[1])),
    sessionKey(sessions[0])
  );
  assert.equal(
    pickNeighborSessionKey(sessions, sessionKey(sessions[0])),
    sessionKey(sessions[1])
  );
  assert.equal(pickNeighborSessionKey(sessions, "sessions:missing.jsonl"), null);
});

test("resolveSessionSelectionAfterRefresh keeps active scope on archive and falls back to another active session", () => {
  const fallbackSession = buildSession({
    id: "next-active",
    relativePath: "2026/06/24/next-active.jsonl"
  });
  const archivedSession = buildSession({
    id: "current",
    location: "archived_sessions",
    relativePath: "2026/06/23/current.jsonl"
  });

  const result = resolveSessionSelectionAfterRefresh({
    scope: "active",
    sessions: [fallbackSession],
    archivedSessions: [archivedSession],
    preferredKey: sessionKey(archivedSession),
    preferredId: archivedSession.id,
    fallbackKey: sessionKey(fallbackSession)
  });

  assert.equal(result.selectedKey, sessionKey(fallbackSession));
  assert.equal(result.routeSelectedId, fallbackSession.id);
});

test("resolveSessionSelectionAfterRefresh keeps archived scope on restore and falls back inside archived sessions", () => {
  const fallbackSession = buildSession({
    id: "older-archived",
    location: "archived_sessions",
    relativePath: "2026/06/22/older-archived.jsonl"
  });
  const restoredSession = buildSession({
    id: "current",
    relativePath: "2026/06/23/current.jsonl"
  });

  const result = resolveSessionSelectionAfterRefresh({
    scope: "archived",
    sessions: [restoredSession],
    archivedSessions: [fallbackSession],
    preferredKey: sessionKey(restoredSession),
    preferredId: restoredSession.id,
    fallbackKey: sessionKey(fallbackSession)
  });

  assert.equal(result.selectedKey, sessionKey(fallbackSession));
  assert.equal(result.routeSelectedId, fallbackSession.id);
});

test("resolveSessionSelectionAfterRefresh keeps the moved session selected in all scope", () => {
  const activeSession = buildSession({
    id: "other",
    relativePath: "2026/06/24/other.jsonl"
  });
  const archivedSession = buildSession({
    id: "current",
    location: "archived_sessions",
    relativePath: "2026/06/23/current.jsonl"
  });

  const result = resolveSessionSelectionAfterRefresh({
    scope: "all",
    sessions: [activeSession],
    archivedSessions: [archivedSession],
    preferredKey: sessionKey(archivedSession),
    preferredId: archivedSession.id,
    fallbackKey: sessionKey(activeSession)
  });

  assert.equal(result.selectedKey, sessionKey(archivedSession));
  assert.equal(result.routeSelectedId, archivedSession.id);
});
