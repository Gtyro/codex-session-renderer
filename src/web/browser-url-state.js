export const DEFAULT_BROWSER_SCOPE = "active";
export const DEFAULT_BROWSER_WORKSPACE = "";
export const READER_MODES = Object.freeze({
  snapshot: "snapshot",
  recent: "recent",
  all: "all"
});

export const DEFAULT_BROWSER_OPTIONS = Object.freeze({
  readerMode: READER_MODES.snapshot,
  rounds: 1,
  includeContext: false,
  includeDeveloper: false,
  includeReasoning: false
});

function decodePathSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseBooleanWithDefault(value, fallbackValue) {
  if (value == null || value === "") {
    return fallbackValue;
  }

  if (value === "1" || value === "true") {
    return true;
  }

  if (value === "0" || value === "false") {
    return false;
  }

  return fallbackValue;
}

function normalizeReaderMode(value, legacyAll = null) {
  if (value === READER_MODES.snapshot || value === READER_MODES.recent || value === READER_MODES.all) {
    return value;
  }

  // Retain existing shared links. Before the snapshot view existed, all=1
  // meant the whole transcript and all=0 meant recent rounds.
  if (legacyAll === "1" || legacyAll === "true") {
    return READER_MODES.all;
  }

  if (legacyAll === "0" || legacyAll === "false") {
    return READER_MODES.recent;
  }

  return DEFAULT_BROWSER_OPTIONS.readerMode;
}

function parsePositiveInteger(value, fallbackValue) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackValue;
}

function normalizeScope(value) {
  if (value === "all" || value === "active" || value === "archived") {
    return value;
  }

  return DEFAULT_BROWSER_SCOPE;
}

function normalizeLocation(value) {
  if (value === "archived" || value === "archived_sessions") {
    return "archived_sessions";
  }

  return "sessions";
}

function normalizeWorkspace(value) {
  const workspace = String(value ?? "").trim();

  if (!workspace) {
    return DEFAULT_BROWSER_WORKSPACE;
  }

  const withoutTrailingSeparator = workspace.replace(/[\\/]+$/u, "");
  return withoutTrailingSeparator || workspace;
}

function deriveScope(scope, selectedSession) {
  if (scope) {
    return normalizeScope(scope);
  }

  if (selectedSession?.location === "archived_sessions") {
    return "archived";
  }

  return DEFAULT_BROWSER_SCOPE;
}

function extractSelectedSessionId(pathname) {
  const matched = String(pathname ?? "").match(/^\/c\/([^/]+)\/?$/u);

  if (!matched) {
    return "";
  }

  return decodePathSegment(matched[1]).trim();
}

export function normalizeBrowserOptions(options = {}) {
  return {
    readerMode: normalizeReaderMode(options.readerMode ?? options.view, options.all),
    rounds: parsePositiveInteger(options.rounds, DEFAULT_BROWSER_OPTIONS.rounds),
    includeContext:
      typeof options.includeContext === "boolean"
        ? options.includeContext
        : parseBooleanWithDefault(options.includeContext, DEFAULT_BROWSER_OPTIONS.includeContext),
    includeDeveloper:
      typeof options.includeDeveloper === "boolean"
        ? options.includeDeveloper
        : parseBooleanWithDefault(options.includeDeveloper, DEFAULT_BROWSER_OPTIONS.includeDeveloper),
    includeReasoning:
      typeof options.includeReasoning === "boolean"
        ? options.includeReasoning
        : parseBooleanWithDefault(options.includeReasoning, DEFAULT_BROWSER_OPTIONS.includeReasoning)
  };
}

export function parseBrowserUrlState(input) {
  const url =
    input instanceof URL
      ? input
      : input instanceof URLSearchParams
      ? new URL(`/?${input.toString()}`, "http://localhost")
      : new URL(String(input ?? "/"), "http://localhost");
  const searchParams = url.searchParams;
  const relativePath = searchParams.get("relativePath")?.trim() || "";
  const location = normalizeLocation(searchParams.get("location"));
  const selectedSessionId = extractSelectedSessionId(url.pathname);
  const selectedSession = relativePath
    ? {
        location,
        relativePath
      }
    : null;

  return {
    scope: deriveScope(searchParams.get("scope"), selectedSession),
    workspace: normalizeWorkspace(searchParams.get("workspace")),
    search: searchParams.get("q")?.trim() || "",
    selectedSessionId: selectedSessionId || "",
    selectedSession,
    options: normalizeBrowserOptions({
      readerMode: searchParams.get("view"),
      rounds: searchParams.get("rounds"),
      all: searchParams.get("all"),
      includeContext: searchParams.get("includeContext"),
      includeDeveloper: searchParams.get("includeDeveloper"),
      includeReasoning: searchParams.get("includeReasoning")
    })
  };
}

export function buildBrowserUrlState(route = {}, options = {}) {
  const searchParams = new URLSearchParams();
  const browserOptions = normalizeBrowserOptions(route.options);
  const scope = normalizeScope(route.scope);
  const workspace = normalizeWorkspace(route.workspace);
  const selectedSessionId = String(
    route.selectedSessionId ?? route.selectedSession?.id ?? ""
  ).trim();
  const selectedSession = route.selectedSession
    ? {
        location: normalizeLocation(route.selectedSession.location),
        relativePath: String(route.selectedSession.relativePath ?? "").trim()
      }
    : null;
  const search = String(route.search ?? "").trim();
  const pathname = selectedSessionId ? `/c/${encodeURIComponent(selectedSessionId)}` : options.pathname || "/";

  searchParams.set("scope", scope);

  if (workspace) {
    searchParams.set("workspace", workspace);
  }

  if (!selectedSessionId && selectedSession?.relativePath) {
    searchParams.set("location", selectedSession.location);
    searchParams.set("relativePath", selectedSession.relativePath);
  }

  if (search) {
    searchParams.set("q", search);
  }

  if (browserOptions.readerMode !== DEFAULT_BROWSER_OPTIONS.readerMode) {
    searchParams.set("view", browserOptions.readerMode);
  }

  if (
    browserOptions.readerMode === READER_MODES.recent &&
    browserOptions.rounds !== DEFAULT_BROWSER_OPTIONS.rounds
  ) {
    searchParams.set("rounds", String(browserOptions.rounds));
  }

  if (browserOptions.includeContext) {
    searchParams.set("includeContext", "1");
  }

  if (browserOptions.includeDeveloper) {
    searchParams.set("includeDeveloper", "1");
  }

  if (browserOptions.includeReasoning) {
    searchParams.set("includeReasoning", "1");
  }

  const query = searchParams.toString();
  return query ? `${pathname}?${query}` : pathname;
}
