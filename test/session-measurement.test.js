import test from "node:test";
import assert from "node:assert/strict";
import { deriveSessionMeasurement } from "../src/core/session-measurement.js";

test("session-log measurements use cumulative token cost and keep absent tokens unknown", () => {
  const measured = deriveSessionMeasurement({
    id: "worker-session",
    tokenSnapshots: [
      { tokens: 200, cumulativeTokens: 200 },
      { tokens: 140, cumulativeTokens: 340 }
    ],
    activityEvents: [{ durationMs: 80 }, { durationMs: 120 }]
  });
  assert.deepEqual(measured, {
    source: "session-jsonl",
    status: "measured",
    workerTokens: 340,
    elapsedMs: 200,
    session: { id: "worker-session", location: null, relativePath: null, modifiedAt: null },
    evidenceRef: "session:worker-session"
  });

  const unknown = deriveSessionMeasurement({ id: "no-token", tokenSnapshots: [], activityEvents: [] });
  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.workerTokens, null);
});
