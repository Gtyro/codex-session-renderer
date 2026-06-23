import { getSessionRecord, SESSION_LOCATIONS } from "./session-store.js";
import { loadSession, selectRecentRounds } from "./session-parser.js";
import { sessionToMarkdown } from "./markdown.js";
import { renderMarkdownDocument } from "../render/html.js";
import { renderMarkdownFragment } from "../render/fragment.js";

function parseBoolean(value) {
  return value === "1" || value === "true";
}

function parsePositiveInteger(value, fallbackValue) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackValue;
}

export function parsePreviewOptions(searchParams) {
  return {
    mode: searchParams.get("mode") === "full" ? "full" : "compact",
    all: parseBoolean(searchParams.get("all")),
    rounds: parsePositiveInteger(searchParams.get("rounds"), 1),
    includeContext: parseBoolean(searchParams.get("includeContext")),
    includeDeveloper: parseBoolean(searchParams.get("includeDeveloper")),
    includeReasoning: parseBoolean(searchParams.get("includeReasoning"))
  };
}

export async function buildSessionPayload(roots, searchParams) {
  const location = searchParams.get("location") || SESSION_LOCATIONS.sessions;
  const relativePath = searchParams.get("relativePath");

  if (!relativePath) {
    throw new Error("Missing session path.");
  }

  const previewOptions = parsePreviewOptions(searchParams);
  const record = await getSessionRecord({
    ...roots,
    location,
    relativePath
  });
  const loadedSession = await loadSession(record.filePath, {
    includeContext: previewOptions.includeContext,
    includeDeveloper: previewOptions.includeDeveloper,
    includeReasoning: previewOptions.includeReasoning
  });
  const session = previewOptions.all
    ? selectRecentRounds(loadedSession, 0)
    : selectRecentRounds(loadedSession, previewOptions.rounds);

  return {
    record,
    session,
    previewOptions
  };
}

export async function buildSessionDocument(roots, searchParams) {
  const payload = await buildSessionPayload(roots, searchParams);
  const markdown = sessionToMarkdown(payload.session, {
    mode: payload.previewOptions.mode
  });
  const titleSuffix = payload.previewOptions.mode === "full" ? "Full" : "Compact";
  const html = renderMarkdownDocument({
    session: payload.session,
    markdown,
    generatedAt: new Date().toISOString(),
    titleSuffix
  });

  return {
    ...payload,
    markdown,
    html
  };
}

export function buildSessionListPayload(items, roots) {
  return {
    roots: {
      sessionsDir: roots.sessionsDir,
      archivedSessionsDir: roots.archivedSessionsDir
    },
    sessions: items.filter((item) => item.location === SESSION_LOCATIONS.sessions),
    archivedSessions: items.filter((item) => item.location === SESSION_LOCATIONS.archived)
  };
}

export function buildInteractiveSession(session) {
  return {
    ...session,
    items: session.items.map((item) => {
      if (item.kind === "message" || item.kind === "reasoning") {
        return {
          ...item,
          renderedHtml: renderMarkdownFragment(item.text)
        };
      }

      return item;
    })
  };
}

export function buildSessionDetailPayload(payload) {
  return {
    record: {
      id: payload.record.id,
      filePath: payload.record.filePath,
      relativePath: payload.record.relativePath,
      location: payload.record.location,
      threadName: payload.record.threadName
    },
    previewOptions: payload.previewOptions,
    session: buildInteractiveSession(payload.session)
  };
}

export function buildDownloadName(record, format, mode) {
  if (format === "html") {
    return `${record.id}.${mode}.html`;
  }

  return `${record.id}.${format === "full-markdown" ? "full" : "compact"}.md`;
}
