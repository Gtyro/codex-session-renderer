export const DEFAULT_BROWSER_SCOPE = "active";

export const DEFAULT_BROWSER_OPTIONS = Object.freeze({
  rounds: 1,
  all: true,
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
    rounds: parsePositiveInteger(options.rounds, DEFAULT_BROWSER_OPTIONS.rounds),
    all:
      typeof options.all === "boolean"
        ? options.all
        : parseBooleanWithDefault(options.all, DEFAULT_BROWSER_OPTIONS.all),
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
    search: searchParams.get("q")?.trim() || "",
    selectedSessionId: selectedSessionId || "",
    selectedSession,
    options: normalizeBrowserOptions({
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

  if (!selectedSessionId && selectedSession?.relativePath) {
    searchParams.set("location", selectedSession.location);
    searchParams.set("relativePath", selectedSession.relativePath);
  }

  if (search) {
    searchParams.set("q", search);
  }

  if (!browserOptions.all) {
    searchParams.set("all", "0");
  }

  if (!browserOptions.all || browserOptions.rounds !== DEFAULT_BROWSER_OPTIONS.rounds) {
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
