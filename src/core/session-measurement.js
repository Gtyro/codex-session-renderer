function numericMaximum(values) {
  const valid = values.map(Number).filter((value) => Number.isFinite(value) && value > 0);
  return valid.length > 0 ? Math.max(...valid) : null;
}

function sumPositive(values) {
  return values.reduce((total, value) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? total + numeric : total;
  }, 0);
}

/**
 * Derive a completed worker measurement from CSR's parsed session record.
 * The caller supplies the stable session ID; this module never chooses a
 * global newest session or exposes raw JSONL to an agent.
 */
export function deriveSessionMeasurement(session, candidate = null) {
  const snapshots = Array.isArray(session?.tokenSnapshots) ? session.tokenSnapshots : [];
  const cumulativeTokens = numericMaximum(snapshots.map((snapshot) => snapshot?.cumulativeTokens));
  const segmentTokens = sumPositive(snapshots.map((snapshot) => snapshot?.tokens));
  const workerTokens = cumulativeTokens || (segmentTokens > 0 ? segmentTokens : null);
  const elapsedMs = sumPositive((session?.activityEvents || []).map((event) => event?.durationMs)) || null;
  const sessionId = session?.id || candidate?.id || null;

  return {
    source: "session-jsonl",
    status: workerTokens === null ? "unknown" : "measured",
    workerTokens,
    elapsedMs,
    session: {
      id: sessionId,
      location: candidate?.location || null,
      relativePath: candidate?.relativePath || null,
      modifiedAt: candidate?.modifiedAt || null
    },
    evidenceRef: sessionId ? `session:${sessionId}` : null
  };
}
