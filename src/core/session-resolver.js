import { loadSession } from "./session-parser.js";
import { listSessions } from "./session-store.js";

function normalize(value) {
  return String(value ?? "")
    .toLocaleLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
}

function termsFor(query) {
  return normalize(query)
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((term) => term.length > 0);
}

function firstUserMessage(session) {
  return (
    session.items.find((item) => item?.kind === "message" && item.role === "user")?.text || ""
  );
}

function scoreText(text, terms, multiplier) {
  const normalized = normalize(text);
  return terms.reduce((score, term) => {
    if (normalized === term) {
      return score + multiplier * 8;
    }
    if (normalized.startsWith(term)) {
      return score + multiplier * 4;
    }
    if (normalized.includes(term)) {
      return score + multiplier;
    }
    return score;
  }, 0);
}

/**
 * Resolve session candidates without using a global "latest" fallback. The
 * caller is deliberately responsible for asking a human to choose ties.
 */
export async function searchSessions(query, options = {}) {
  const terms = termsFor(query);
  const records = await listSessions(options);
  const candidates = await Promise.all(
    records.map(async (record) => {
      const session = await loadSession(record.filePath);
      const firstPrompt = firstUserMessage(session);
      const cwd = session.cwd || "";
      const score =
        scoreText(record.id, terms, 6) +
        scoreText(record.threadName, terms, 5) +
        scoreText(firstPrompt, terms, 3) +
        scoreText(cwd, terms, 2);

      return {
        id: record.id,
        filePath: record.filePath,
        location: record.location,
        relativePath: record.relativePath,
        threadName: record.threadName,
        cwd: cwd || null,
        firstPrompt: firstPrompt || null,
        modifiedAt: record.modifiedAt,
        modifiedMs: record.modifiedMs,
        score
      };
    })
  );

  return candidates
    .filter((candidate) => terms.length === 0 || candidate.score > 0)
    .sort((left, right) => right.score - left.score || right.modifiedMs - left.modifiedMs || left.id.localeCompare(right.id));
}

export async function getSessionCandidateById(id, options = {}) {
  const normalizedId = normalize(id);
  const candidates = await searchSessions(normalizedId, options);
  const exact = candidates.filter((candidate) => normalize(candidate.id) === normalizedId);

  if (exact.length === 1) {
    return exact[0];
  }

  const fragments = candidates.filter((candidate) => normalize(candidate.id).includes(normalizedId));

  if (fragments.length === 1) {
    return fragments[0];
  }

  if (fragments.length === 0) {
    throw new Error(`No session matched "${id}".`);
  }

  throw new Error(`Session reference "${id}" is ambiguous. Use csr sessions pick or choose an exact ID.`);
}

export function buildOptimizationHandoff(candidate) {
  const title = candidate?.threadName || candidate?.firstPrompt || "选中的 Codex 会话";
  const sessionId = candidate?.id;

  if (!sessionId) {
    throw new Error("A stable session ID is required for an optimizer handoff.");
  }

  return `$agent-workflow-optimizer 复盘「${title}」（session: ${sessionId}），分析 token 与耗时并优化相关 Skill、README 或开发文档。`;
}
