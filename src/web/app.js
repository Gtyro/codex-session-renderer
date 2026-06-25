import {
  getTranscriptEntryTimestamp,
  groupTranscriptItems,
  splitEntriesIntoDisplaySegments
} from "./transcript-presentation.js";
import {
  getTranscriptJumpTargetKind,
  pickTranscriptJumpIndex,
  pickTranscriptViewportAnchorIndex
} from "./transcript-navigation.js";
import {
  DEFAULT_BROWSER_OPTIONS,
  buildBrowserUrlState,
  normalizeBrowserOptions,
  parseBrowserUrlState
} from "./browser-url-state.js";
import {
  getScopeForSession,
  pickNeighborSessionKey,
  resolveSessionSelectionAfterRefresh,
  sessionKey
} from "./session-selection.js";

const SCOPE_META = {
  all: {
    title: "全部会话",
    emptyMessage: "没有找到会话。",
    copy: "侧栏会统一展示活动会话和归档会话。"
  },
  active: {
    title: "活动会话",
    emptyMessage: "没有找到活动会话。",
    copy: "这里只显示仍在 sessions 目录里的会话。"
  },
  archived: {
    title: "归档会话",
    emptyMessage: "没有找到归档会话。",
    copy: "这里只显示已归档的会话，可恢复或删除。"
  }
};

const state = {
  sessions: [],
  archivedSessions: [],
  selectedKey: null,
  routeSelectedId: "",
  renamingKey: null,
  renamingValue: "",
  renameFocusPending: false,
  scope: "active",
  mobilePanel: "master",
  sidebarCollapsed: false,
  options: {
    ...DEFAULT_BROWSER_OPTIONS
  },
  busy: false,
  detailBusy: false,
  detailRequestId: 0,
  detailSignature: null,
  detailSession: null,
  transcriptJumpIndex: null
};

const elements = {
  workspace: document.querySelector(".workspace"),
  chatPane: document.querySelector(".chat-pane"),
  sidebarToggle: document.querySelector("#sidebar-toggle"),
  sessionsRoot: document.querySelector("#sessions-root"),
  archivedRoot: document.querySelector("#archived-root"),
  searchInput: document.querySelector("#search-input"),
  refreshButton: document.querySelector("#refresh-button"),
  allCount: document.querySelector("#all-count"),
  sessionsCount: document.querySelector("#sessions-count"),
  archivedCount: document.querySelector("#archived-count"),
  masterTitle: document.querySelector("#master-title"),
  sessionList: document.querySelector("#session-list"),
  scopeButtons: Array.from(document.querySelectorAll("[data-scope]")),
  roundsInput: document.querySelector("#rounds-input"),
  allRoundsToggle: document.querySelector("#all-rounds-toggle"),
  includeContextToggle: document.querySelector("#include-context-toggle"),
  includeDeveloperToggle: document.querySelector("#include-developer-toggle"),
  includeReasoningToggle: document.querySelector("#include-reasoning-toggle"),
  sessionStatus: document.querySelector("#session-status"),
  sessionTitle: document.querySelector("#session-title"),
  sessionIdLine: document.querySelector("#session-idline"),
  sessionPath: document.querySelector("#session-path"),
  sessionLocation: document.querySelector("#session-location"),
  sessionModified: document.querySelector("#session-modified"),
  sessionSize: document.querySelector("#session-size"),
  feedbackMessage: document.querySelector("#feedback-message"),
  openPreviewLink: document.querySelector("#open-preview-link"),
  downloadCompactLink: document.querySelector("#download-compact-link"),
  downloadFullLink: document.querySelector("#download-full-link"),
  renameButton: document.querySelector("#rename-button"),
  archiveButton: document.querySelector("#archive-button"),
  restoreButton: document.querySelector("#restore-button"),
  deleteButton: document.querySelector("#delete-button"),
  backToListButton: document.querySelector("#back-to-list"),
  viewerCard: document.querySelector(".viewer-card"),
  emptyState: document.querySelector("#empty-state"),
  transcriptToolbar: document.querySelector("#transcript-toolbar"),
  expandToolsButton: document.querySelector("#expand-tools-button"),
  collapseToolsButton: document.querySelector("#collapse-tools-button"),
  transcriptStats: document.querySelector("#transcript-stats"),
  transcriptRoot: document.querySelector("#transcript-root")
};

function getAllSessions() {
  return [...state.sessions, ...state.archivedSessions];
}

function getScopeItems(scope = state.scope) {
  if (scope === "active") {
    return state.sessions;
  }

  if (scope === "archived") {
    return state.archivedSessions;
  }

  return getAllSessions();
}

function getFilteredScopeItems(scope = state.scope) {
  return filterSessions(getScopeItems(scope));
}

function getSelectedSession() {
  return getAllSessions().find((item) => sessionKey(item) === state.selectedKey) ?? null;
}

function findSessionByKey(key, items = getAllSessions()) {
  return items.find((item) => sessionKey(item) === key) ?? null;
}

function findSessionById(id, items = getAllSessions()) {
  const normalizedId = String(id ?? "").trim();

  if (!normalizedId) {
    return null;
  }

  return items.find((item) => item.id === normalizedId) ?? null;
}

function getSearchKeyword() {
  return elements.searchInput.value.trim().toLowerCase();
}

function getSessionSelectionFromKey(key) {
  if (!key) {
    return null;
  }

  const separatorIndex = key.indexOf(":");

  if (separatorIndex === -1) {
    return null;
  }

  return {
    location: key.slice(0, separatorIndex),
    relativePath: key.slice(separatorIndex + 1)
  };
}

function browserOptionsEqual(left, right) {
  return (
    left.rounds === right.rounds &&
    left.all === right.all &&
    left.includeContext === right.includeContext &&
    left.includeDeveloper === right.includeDeveloper &&
    left.includeReasoning === right.includeReasoning
  );
}

function syncOptionControls() {
  elements.roundsInput.value = String(state.options.rounds);
  elements.allRoundsToggle.checked = state.options.all;
  elements.includeContextToggle.checked = state.options.includeContext;
  elements.includeDeveloperToggle.checked = state.options.includeDeveloper;
  elements.includeReasoningToggle.checked = state.options.includeReasoning;
  elements.roundsInput.disabled = state.options.all;
}

function getBrowserRouteState() {
  const selectedSession = getSelectedSession() || getSessionSelectionFromKey(state.selectedKey);

  return {
    scope: state.scope,
    search: elements.searchInput.value,
    selectedSessionId: getSelectedSession()?.id || state.routeSelectedId,
    selectedSession,
    options: state.options
  };
}

function syncBrowserUrl(historyMode = "replace") {
  const nextUrl = buildBrowserUrlState(getBrowserRouteState());
  const currentUrl = `${window.location.pathname}${window.location.search}`;

  if (nextUrl === currentUrl) {
    return;
  }

  window.history[historyMode === "push" ? "pushState" : "replaceState"](null, "", nextUrl);
}

function renderAndSyncBrowserUrl(historyMode = "replace") {
  render();
  syncBrowserUrl(historyMode);
}

function resetDetailCache() {
  state.detailSignature = null;
  state.detailSession = null;
}

function selectSessionKey(nextKey, options = {}) {
  const nextSession = getAllSessions().find((item) => sessionKey(item) === nextKey) ?? null;
  state.selectedKey = nextKey;
  state.routeSelectedId = nextSession?.id || "";
  state.mobilePanel = nextKey ? options.mobilePanel || "detail" : "master";
  renderAndSyncBrowserUrl(options.historyMode || "push");
  return loadSelectedSessionDetail();
}

function applyRouteState(routeState, options = {}) {
  const nextOptions = normalizeBrowserOptions(routeState.options);
  const currentSearchValue = elements.searchInput.value;
  let nextSelectedKey = routeState.selectedSession ? sessionKey(routeState.selectedSession) : null;
  let nextScope = routeState.scope;
  const nextRouteSelectedId = String(routeState.selectedSessionId ?? "").trim();
  const resolvedById = nextRouteSelectedId ? findSessionById(nextRouteSelectedId) : null;
  const resolvedByKey = nextSelectedKey ? findSessionByKey(nextSelectedKey) : null;

  if (resolvedById) {
    nextSelectedKey = sessionKey(resolvedById);
    nextScope =
      routeState.scope === "all" ? routeState.scope : getScopeForSession(resolvedById);
  } else if (resolvedByKey) {
    nextScope =
      routeState.scope === "all" ? routeState.scope : getScopeForSession(resolvedByKey);
  }

  const selectionChanged = state.selectedKey !== nextSelectedKey;
  const optionsChanged = !browserOptionsEqual(state.options, nextOptions);

  state.scope = nextScope;
  state.selectedKey = nextSelectedKey;
  state.routeSelectedId = nextRouteSelectedId;
  state.mobilePanel = state.selectedKey ? "detail" : "master";
  state.options = nextOptions;

  if (currentSearchValue !== routeState.search) {
    elements.searchInput.value = routeState.search;
  }

  syncOptionControls();

  if (selectionChanged || optionsChanged) {
    resetDetailCache();
  }

  render();

  if (options.syncUrl) {
    syncBrowserUrl(options.historyMode || "replace");
  }

  if (options.loadDetail !== false) {
    return loadSelectedSessionDetail();
  }

  return Promise.resolve();
}

function initializeRouteState() {
  const routeState = parseBrowserUrlState(window.location);
  const resolvedById = routeState.selectedSessionId ? findSessionById(routeState.selectedSessionId) : null;
  const resolvedByKey = routeState.selectedSession ? findSessionByKey(sessionKey(routeState.selectedSession)) : null;

  state.scope =
    routeState.scope === "all"
      ? routeState.scope
      : resolvedById
      ? getScopeForSession(resolvedById)
      : resolvedByKey
      ? getScopeForSession(resolvedByKey)
      : routeState.scope;
  state.selectedKey = resolvedById
    ? sessionKey(resolvedById)
    : resolvedByKey
    ? sessionKey(resolvedByKey)
    : routeState.selectedSession
    ? sessionKey(routeState.selectedSession)
    : null;
  state.routeSelectedId = String(routeState.selectedSessionId ?? "").trim();
  state.mobilePanel = state.selectedKey ? "detail" : "master";
  state.options = normalizeBrowserOptions(routeState.options);
  elements.searchInput.value = routeState.search;
  syncOptionControls();
}

function loadSidebarPreference() {
  try {
    return window.localStorage.getItem("csr.sidebar.collapsed") === "1";
  } catch {
    return false;
  }
}

function saveSidebarPreference() {
  try {
    window.localStorage.setItem("csr.sidebar.collapsed", state.sidebarCollapsed ? "1" : "0");
  } catch {
    // Ignore storage failures.
  }
}

function formatLocalTime(value) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function formatBytes(value) {
  if (!Number.isFinite(value)) {
    return "-";
  }

  if (value < 1024) {
    return `${value} B`;
  }

  const units = ["KB", "MB", "GB"];
  let size = value;
  let unit = units[0];

  for (const nextUnit of units) {
    size /= 1024;
    unit = nextUnit;
    if (size < 1024) {
      break;
    }
  }

  return `${size.toFixed(size >= 10 ? 0 : 1)} ${unit}`;
}

function describeRoundSelection(session) {
  const selection = session?.selection;

  if (!selection) {
    return "";
  }

  if (selection.mode === "all") {
    return selection.roundsIncluded > 0 ? `全部 ${selection.roundsIncluded} 轮` : "全部轮次";
  }

  const totalRounds = selection.totalRounds ?? selection.roundsIncluded ?? selection.roundsRequested;
  const roundsIncluded = selection.roundsIncluded ?? selection.roundsRequested;

  if (Number.isFinite(totalRounds) && Number.isFinite(roundsIncluded)) {
    return `最近 ${roundsIncluded} / ${totalRounds} 轮`;
  }

  if (Number.isFinite(roundsIncluded)) {
    return `最近 ${roundsIncluded} 轮`;
  }

  return "";
}

function getLocationLabel(location) {
  return location === "archived_sessions" ? "归档" : "活动";
}

function truncateText(value, maxLength = 80) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function getMissingThreadNameLabel() {
  return "（缺少标题）";
}

function getListTitle(item) {
  return item.threadName || getMissingThreadNameLabel();
}

function getSessionHeading(item) {
  return getListTitle(item);
}

function getRenamePromptValue(item) {
  return item.threadName || "";
}

function isRenamingSession(item) {
  return Boolean(item) && state.renamingKey === sessionKey(item);
}

function clearInlineRename() {
  state.renamingKey = null;
  state.renamingValue = "";
  state.renameFocusPending = false;
}

function clearTranscriptJumpState() {
  state.transcriptJumpIndex = null;
}

function getNeighborSelectionKey(currentKey) {
  return pickNeighborSessionKey(getFilteredScopeItems(), currentKey);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function buildSessionQuery(session, overrides = {}) {
  const searchParams = new URLSearchParams({
    location: session.location,
    relativePath: session.relativePath,
    rounds: String(overrides.rounds ?? state.options.rounds)
  });

  const mode = overrides.mode ?? null;
  if (mode) {
    searchParams.set("mode", mode);
  }

  if (overrides.all ?? state.options.all) {
    searchParams.set("all", "1");
  }

  if (overrides.includeContext ?? state.options.includeContext) {
    searchParams.set("includeContext", "1");
  }

  if (overrides.includeDeveloper ?? state.options.includeDeveloper) {
    searchParams.set("includeDeveloper", "1");
  }

  if (overrides.includeReasoning ?? state.options.includeReasoning) {
    searchParams.set("includeReasoning", "1");
  }

  return searchParams.toString();
}

function getDetailSignature(session) {
  return `${sessionKey(session)}?${buildSessionQuery(session)}`;
}

function setFeedback(message, { error = false } = {}) {
  elements.feedbackMessage.textContent = message;
  elements.feedbackMessage.classList.toggle("error", error);
}

function setVisible(element, visible) {
  element.hidden = !visible;
}

function filterSessions(items) {
  const keyword = getSearchKeyword();

  if (!keyword) {
    return items;
  }

  return items.filter((item) =>
    [item.threadName, item.id, item.relativePath, item.filePath].some((field) =>
      String(field).toLowerCase().includes(keyword)
    )
  );
}

function renderScopeControls() {
  elements.allCount.textContent = String(getAllSessions().length);
  elements.sessionsCount.textContent = String(state.sessions.length);
  elements.archivedCount.textContent = String(state.archivedSessions.length);

  for (const button of elements.scopeButtons) {
    const active = button.dataset.scope === state.scope;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  }
}

function renderSidebarSummary(visibleCount, totalCount) {
  const meta = SCOPE_META[state.scope];
  const keyword = getSearchKeyword();

  elements.masterTitle.textContent = meta.title;

  if (keyword) {
    elements.masterTitle.title = `筛选词 "${keyword}" 命中 ${visibleCount} / ${totalCount} 条记录。`;
    return;
  }

  elements.masterTitle.title = meta.copy;
}

function renderChromeState() {
  elements.workspace.dataset.sidebar = state.sidebarCollapsed ? "collapsed" : "expanded";
  elements.sidebarToggle.setAttribute("aria-label", state.sidebarCollapsed ? "展开侧栏" : "收起侧栏");
  elements.sidebarToggle.dataset.tooltip = state.sidebarCollapsed ? "展开侧栏" : "收起侧栏";
}

function renderSessionList(items) {
  const previousScrollTop = elements.sessionList.scrollTop;
  elements.sessionList.replaceChildren();

  if (items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-list";
    empty.textContent = SCOPE_META[state.scope].emptyMessage;
    elements.sessionList.append(empty);
    return;
  }

  for (const item of items) {
    const card = document.createElement("div");
    card.className = "session-item";
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.title = `${getListTitle(item)}\n${item.relativePath}`;

    if (state.selectedKey === sessionKey(item)) {
      card.classList.add("active");
    }

    card.addEventListener("click", () => {
      selectSessionKey(sessionKey(item), {
        historyMode: "push",
        mobilePanel: "detail"
      });
    });

    card.addEventListener("keydown", (event) => {
      if (isRenamingSession(item)) {
        return;
      }

      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectSessionKey(sessionKey(item), {
          historyMode: "push",
          mobilePanel: "detail"
        });
      }
    });

    card.addEventListener("dblclick", (event) => {
      event.preventDefault();
      startInlineRename(item);
    });

    const header = document.createElement("div");
    header.className = "session-item-header";

    let title;

    if (isRenamingSession(item)) {
      const input = document.createElement("input");
      input.type = "text";
      input.className = "session-title-editor";
      input.value = state.renamingValue;
      input.disabled = state.busy;
      input.setAttribute("aria-label", "编辑会话名称");

      input.addEventListener("input", () => {
        state.renamingValue = input.value;
      });
      input.addEventListener("click", (event) => {
        event.stopPropagation();
      });
      input.addEventListener("dblclick", (event) => {
        event.stopPropagation();
      });
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          submitInlineRename(item);
          return;
        }

        if (event.key === "Escape") {
          event.preventDefault();
          clearInlineRename();
          render();
        }
      });
      input.addEventListener("blur", () => {
        if (!isRenamingSession(item) || state.busy) {
          return;
        }

        submitInlineRename(item);
      });

      title = input;
    } else {
      title = document.createElement("p");
      title.className = "session-id";
      title.textContent = getListTitle(item);
    }

    const flag = document.createElement("span");
    flag.className = `session-flag ${item.location === "archived_sessions" ? "archived" : "active"}`;
    flag.textContent = getLocationLabel(item.location);

    const meta = document.createElement("p");
    meta.className = "session-meta";
    meta.textContent = formatLocalTime(item.modifiedAt);

    const pathLine = document.createElement("p");
    pathLine.className = "session-pathline";
    pathLine.textContent = item.relativePath;

    header.append(title, flag);
    card.append(header, meta, pathLine);
    elements.sessionList.append(card);
  }

  const maxScrollTop = Math.max(0, elements.sessionList.scrollHeight - elements.sessionList.clientHeight);
  elements.sessionList.scrollTop = Math.min(previousScrollTop, maxScrollTop);
}

function updateActionState(session) {
  const hasSelection = Boolean(session);

  setVisible(elements.openPreviewLink, hasSelection);
  setVisible(elements.downloadCompactLink, hasSelection);
  setVisible(elements.downloadFullLink, hasSelection);
  setVisible(elements.renameButton, hasSelection);
  setVisible(elements.archiveButton, hasSelection && session.location === "sessions");
  setVisible(elements.restoreButton, hasSelection && session.location === "archived_sessions");
  setVisible(elements.deleteButton, hasSelection && session.location === "archived_sessions");

  elements.refreshButton.disabled = state.busy;
  elements.renameButton.disabled = state.busy;
  elements.archiveButton.disabled = state.busy || state.detailBusy;
  elements.restoreButton.disabled = state.busy || state.detailBusy;
  elements.deleteButton.disabled = state.busy || state.detailBusy;
  elements.expandToolsButton.disabled = !state.detailSession;
  elements.collapseToolsButton.disabled = !state.detailSession;
}

function roleLabel(role) {
  switch (role) {
    case "user":
      return "User";
    case "assistant":
      return "Assistant";
    case "developer":
      return "Developer";
    default:
      return role;
  }
}

function extractFirstUsefulLine(value) {
  const lines = String(value ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return lines[0] || "";
}

function summarizeToolCall(item) {
  if (item.name === "exec_command" && item.data?.cmd) {
    return truncateText(item.data.cmd, 70);
  }

  if (item.name === "write_stdin" && item.data?.chars) {
    return truncateText(`stdin ${item.data.chars}`, 70);
  }

  if (typeof item.data === "string") {
    return truncateText(item.data, 70);
  }

  if (item.data && typeof item.data === "object") {
    const pairs = Object.entries(item.data).slice(0, 2);
    if (pairs.length > 0) {
      return truncateText(
        pairs
          .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
          .join(" · "),
        70
      );
    }
  }

  return truncateText(extractFirstUsefulLine(item.body), 70) || "No input";
}

function summarizeToolOutput(item) {
  return truncateText(extractFirstUsefulLine(item.body), 78) || "No output";
}

function isConversationUserMessage(item) {
  return item?.kind === "message" && item.role === "user" && item.isContextPrelude !== true;
}

function isAssistantMessage(item) {
  return item?.kind === "message" && item.role === "assistant";
}

function isFinalAssistantMessage(item) {
  return isAssistantMessage(item) && item.phase === "final_answer";
}

function getTranscriptJumpTargets() {
  return Array.from(elements.transcriptRoot.querySelectorAll("[data-jump-target='true']")).filter(
    (target) => !target.closest(".process-group:not([open])")
  );
}

function isEditableTarget(target) {
  return (
    target instanceof Element &&
    Boolean(target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='textbox']"))
  );
}

function isNodeVisibleInChatPane(node) {
  if (!(node instanceof Element)) {
    return false;
  }

  const paneRect = elements.chatPane.getBoundingClientRect();
  const nodeRect = node.getBoundingClientRect();
  return nodeRect.bottom > paneRect.top && nodeRect.top < paneRect.bottom;
}

function updateTranscriptJumpDecorations(targets = getTranscriptJumpTargets()) {
  targets.forEach((target, index) => {
    const active = index === state.transcriptJumpIndex;
    target.classList.toggle("jump-target-active", active);
    target.dataset.jumpIndex = String(index);

    if (active) {
      target.setAttribute("aria-current", "true");
      return;
    }

    target.removeAttribute("aria-current");
  });
}

function setActiveTranscriptJumpIndex(index, { scroll = false } = {}) {
  const targets = getTranscriptJumpTargets();

  if (!Number.isInteger(index) || index < 0 || index >= targets.length) {
    clearTranscriptJumpState();
    updateTranscriptJumpDecorations(targets);
    return null;
  }

  state.transcriptJumpIndex = index;
  updateTranscriptJumpDecorations(targets);

  const target = targets[index];

  if (scroll) {
    target.scrollIntoView({
      block: "start",
      inline: "nearest"
    });
    target.focus({
      preventScroll: true
    });
  }

  return target;
}

function bindTranscriptJumpTargets() {
  const targets = getTranscriptJumpTargets();

  targets.forEach((target, index) => {
    target.dataset.jumpIndex = String(index);
    target.addEventListener("click", () => {
      state.transcriptJumpIndex = index;
      updateTranscriptJumpDecorations();
    });
  });

  updateTranscriptJumpDecorations(targets);
}

function navigateTranscriptJump(direction) {
  const targets = getTranscriptJumpTargets();

  if (targets.length === 0 || !elements.viewerCard.classList.contains("has-selection")) {
    return;
  }

  const explicitAnchorIndex =
    Number.isInteger(state.transcriptJumpIndex) &&
    state.transcriptJumpIndex >= 0 &&
    state.transcriptJumpIndex < targets.length &&
    isNodeVisibleInChatPane(targets[state.transcriptJumpIndex])
      ? state.transcriptJumpIndex
      : null;
  const paneRect = elements.chatPane.getBoundingClientRect();
  const rects = targets.map((target) => {
    const rect = target.getBoundingClientRect();
    return {
      top: rect.top - paneRect.top,
      bottom: rect.bottom - paneRect.top
    };
  });
  const offsets = rects.map((rect) => rect.top);
  const anchorIndex = explicitAnchorIndex ?? pickTranscriptViewportAnchorIndex(rects, paneRect.height);
  const nextIndex = pickTranscriptJumpIndex(offsets, direction, anchorIndex);

  if (nextIndex === -1) {
    return;
  }

  setActiveTranscriptJumpIndex(nextIndex, { scroll: true });
}

function buildConversationBlocksFromItems(items) {
  const sourceItems = Array.isArray(items) ? items : [];

  if (sourceItems.length === 0) {
    return [];
  }

  const blocks = [];
  let current = null;

  function finalizeCurrent() {
    if (!current || current.endIndex <= current.startIndex) {
      current = null;
      return;
    }

    blocks.push(current);
    current = null;
  }

  for (let index = 0; index < sourceItems.length; index += 1) {
    const item = sourceItems[index];
    const startsNewBlock =
      current &&
      current.hasFinalAnswer &&
      isConversationUserMessage(item);

    if (startsNewBlock) {
      finalizeCurrent();
    }

    if (!current) {
      current = {
        startIndex: index,
        endIndex: index,
        hasFinalAnswer: false,
        userMessageCount: 0
      };
    }

    current.endIndex = index + 1;

    if (isConversationUserMessage(item)) {
      current.userMessageCount += 1;
    }

    if (isFinalAssistantMessage(item)) {
      current.hasFinalAnswer = true;
    }
  }

  finalizeCurrent();

  return blocks.map((block, index) => ({
    ...block,
    index: index + 1,
    total: blocks.length
  }));
}

function getConversationBlocks(session) {
  if (Array.isArray(session?.conversationBlocks) && session.conversationBlocks.length > 0) {
    return session.conversationBlocks;
  }

  return buildConversationBlocksFromItems(session?.items ?? []);
}

function isUserMessageEntry(entry) {
  return entry.kind === "single" && isConversationUserMessage(entry.item);
}

function isAssistantMessageEntry(entry) {
  return entry.kind === "single" && isAssistantMessage(entry.item);
}

function isFinalAssistantEntry(entry) {
  return entry.kind === "single" && isFinalAssistantMessage(entry.item);
}

function pickVisibleAssistantEntry(entries) {
  const finalAssistantEntry = [...entries].reverse().find(isFinalAssistantEntry);

  if (finalAssistantEntry) {
    return {
      entry: finalAssistantEntry,
      state: "complete"
    };
  }

  const latestAssistantEntry = [...entries].reverse().find(isAssistantMessageEntry);

  if (latestAssistantEntry) {
    return {
      entry: latestAssistantEntry,
      state: "pending"
    };
  }

  return null;
}

function describeConversationStatus(assistantState, hasVisibleUserMessage) {
  if (assistantState === "complete") {
    return "已总结";
  }

  if (assistantState === "pending") {
    return "处理中";
  }

  return hasVisibleUserMessage ? "待回复" : "过程记录";
}

function describeProcessEntries(entries) {
  const toolCount = entries.filter(
    (entry) => entry.kind === "tool_interaction" || entry.item?.kind?.startsWith("tool")
  ).length;
  const reasoningCount = entries.filter((entry) => entry.kind === "single" && entry.item?.kind === "reasoning").length;
  const assistantCount = entries.filter(
    (entry) =>
      entry.kind === "single" &&
      entry.item?.kind === "message" &&
      entry.item.role === "assistant" &&
      entry.item.phase !== "final_answer"
  ).length;
  const otherCount = entries.length - toolCount - reasoningCount - assistantCount;
  const parts = [`${entries.length} 项过程`];

  if (assistantCount > 0) {
    parts.push(`${assistantCount} 条进展`);
  }

  if (toolCount > 0) {
    parts.push(`${toolCount} 次工具`);
  }

  if (reasoningCount > 0) {
    parts.push(`${reasoningCount} 条推理`);
  }

  if (otherCount > 0) {
    parts.push(`${otherCount} 条其他`);
  }

  return parts.join(" · ");
}

function buildProcessGroup(entries) {
  const details = document.createElement("details");
  details.className = "process-group";
  details.innerHTML = `
    <summary>
      <div class="entry-summary">
        <span class="entry-badge neutral">过程</span>
        <span class="entry-preview">${escapeHtml(describeProcessEntries(entries))}</span>
      </div>
      <div class="entry-meta">
        <span class="entry-caret">+</span>
      </div>
    </summary>
  `;

  const body = document.createElement("div");
  body.className = "process-group-body";

  entries.forEach((entry) => {
    body.append(buildTranscriptEntry(entry));
  });

  details.append(body);
  return details;
}

function buildConversationBlock(block, session) {
  const blockItems = session.items.slice(block.startIndex, block.endIndex);
  const entries = groupTranscriptItems(blockItems);
  const visibleUserEntries = entries.filter(isUserMessageEntry);
  const assistantSelection = pickVisibleAssistantEntry(entries);
  const visibleEntries = new Set(visibleUserEntries);

  if (assistantSelection) {
    visibleEntries.add(assistantSelection.entry);
  }

  const displaySegments = splitEntriesIntoDisplaySegments(entries, (entry) => visibleEntries.has(entry));
  const visibleUserCount = visibleUserEntries.length || block.userMessageCount || 0;
  const status = describeConversationStatus(assistantSelection?.state ?? null, visibleUserCount > 0);
  const timestamp =
    getTranscriptEntryTimestamp(assistantSelection?.entry) ||
    getTranscriptEntryTimestamp(
      [...visibleUserEntries].reverse().find((entry) => getTranscriptEntryTimestamp(entry))
    ) ||
    getTranscriptEntryTimestamp([...entries].reverse().find((entry) => getTranscriptEntryTimestamp(entry))) ||
    "";
  const wrapper = document.createElement("section");
  wrapper.className = "conversation-block";
  wrapper.dataset.blockState = assistantSelection?.state || (visibleUserCount > 0 ? "waiting" : "history");
  wrapper.innerHTML = `
    <header class="conversation-block-header">
      <div class="conversation-block-meta">
        <p class="conversation-block-title">第 ${block.index} 轮</p>
        <p class="conversation-block-summary">
          ${escapeHtml(
            [
              `${visibleUserCount} 条用户消息`,
              assistantSelection?.state === "complete"
                ? "1 条总结"
                : assistantSelection?.state === "pending"
                ? "最新 assistant 进展"
                : "暂无总结"
            ].join(" · ")
          )}
        </p>
      </div>
      <div class="conversation-block-side">
        <span class="conversation-status">${escapeHtml(status)}</span>
        ${timestamp ? `<time>${escapeHtml(formatLocalTime(timestamp))}</time>` : ""}
      </div>
    </header>
  `;

  const stack = document.createElement("div");
  stack.className = "conversation-block-stack";

  if (visibleUserEntries.length === 0 && !assistantSelection) {
    entries.forEach((entry) => {
      stack.append(buildTranscriptEntry(entry));
    });
    wrapper.append(stack);
    return wrapper;
  }

  displaySegments.forEach((segment) => {
    if (segment.kind === "visible") {
      const node = buildTranscriptEntry(segment.entry);

      if (assistantSelection?.entry === segment.entry && assistantSelection.state === "pending") {
        node.classList.add("pending-report");
      }

      stack.append(node);
      return;
    }

    if (segment.kind === "process") {
      stack.append(buildProcessGroup(segment.entries));
    }
  });

  wrapper.append(stack);
  return wrapper;
}

function renderRichText(text, renderedHtml = "") {
  if (typeof renderedHtml === "string" && renderedHtml.trim()) {
    return renderedHtml;
  }

  const source = String(text ?? "");
  const blocks = source.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g);
  const htmlParts = [];

  for (const block of blocks) {
    if (!block) {
      continue;
    }

    if (/^(```|~~~)/.test(block)) {
      const normalized = block.replace(/^(```|~~~)[^\n]*\n?/, "").replace(/(```|~~~)\s*$/, "");
      htmlParts.push(`<pre><code>${escapeHtml(normalized.trimEnd())}</code></pre>`);
      continue;
    }

    const paragraphs = block
      .trim()
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean);

    for (const paragraph of paragraphs) {
      htmlParts.push(`<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`);
    }
  }

  return htmlParts.length > 0 ? htmlParts.join("") : `<p>${escapeHtml(source)}</p>`;
}

function renderPreformattedBlock(label, value) {
  return `
    <section class="tool-block">
      <div class="tool-block-label">${escapeHtml(label)}</div>
      <pre><code>${escapeHtml(String(value ?? "").trim() || "(empty)")}</code></pre>
    </section>
  `;
}

function buildTranscriptEntry(entry) {
  if (entry.kind === "tool_interaction") {
    const summaryParts = [summarizeToolCall(entry.call), summarizeToolOutput(entry.output)].filter(Boolean);
    const timestamp = entry.output.timestamp || entry.call.timestamp || "";
    const wrapper = document.createElement("details");
    wrapper.className = "transcript-entry tool-entry";

    wrapper.innerHTML = `
      <summary>
        <div class="entry-summary">
          <span class="entry-badge tool">Tool</span>
          <span class="entry-title">${escapeHtml(entry.call.name || "tool")}</span>
          <span class="entry-preview">${escapeHtml(summaryParts.join("  |  "))}</span>
        </div>
        <div class="entry-meta">
          ${timestamp ? `<time>${escapeHtml(formatLocalTime(timestamp))}</time>` : ""}
          <span class="entry-caret">+</span>
        </div>
      </summary>
      <div class="entry-content">
        ${renderPreformattedBlock("Input", entry.call.body)}
        ${renderPreformattedBlock("Output", entry.output.body)}
      </div>
    `;

    return wrapper;
  }

  const item = entry.item;

  if (item.kind === "message") {
    const article = document.createElement("article");
    article.className = `transcript-entry message-entry role-${item.role}`;
    const jumpTargetKind = getTranscriptJumpTargetKind(item);

    if (jumpTargetKind) {
      article.dataset.jumpTarget = "true";
      article.dataset.jumpKind = jumpTargetKind;
      article.tabIndex = -1;
    }

    article.innerHTML = `
      <header class="entry-header">
        <div class="entry-summary">
          <span class="entry-badge ${escapeHtml(item.role)}">${escapeHtml(roleLabel(item.role))}</span>
        </div>
        ${item.timestamp ? `<time>${escapeHtml(formatLocalTime(item.timestamp))}</time>` : ""}
      </header>
      <div class="entry-content rich-text">${renderRichText(item.displayText ?? item.text, item.renderedHtml)}</div>
    `;
    return article;
  }

  if (item.kind === "reasoning") {
    const details = document.createElement("details");
    details.className = "transcript-entry reasoning-entry";
    details.innerHTML = `
      <summary>
        <div class="entry-summary">
          <span class="entry-badge reasoning">Reasoning</span>
          <span class="entry-preview">${escapeHtml(truncateText(extractFirstUsefulLine(item.text), 88) || "Summary")}</span>
        </div>
        <div class="entry-meta">
          ${item.timestamp ? `<time>${escapeHtml(formatLocalTime(item.timestamp))}</time>` : ""}
          <span class="entry-caret">+</span>
        </div>
      </summary>
      <div class="entry-content rich-text">${renderRichText(item.displayText ?? item.text, item.renderedHtml)}</div>
    `;
    return details;
  }

  if (item.kind === "tool_call" || item.kind === "tool_output" || item.kind === "tool_event") {
    const details = document.createElement("details");
    details.className = "transcript-entry tool-entry";
    const badgeLabel = item.kind === "tool_output" ? "Tool Output" : item.kind === "tool_call" ? "Tool Call" : "Tool Event";
    const preview =
      item.kind === "tool_output"
        ? summarizeToolOutput(item)
        : item.kind === "tool_call"
        ? summarizeToolCall(item)
        : truncateText(extractFirstUsefulLine(item.body), 88);
    const title = item.name || item.eventType || "tool";

    details.innerHTML = `
      <summary>
        <div class="entry-summary">
          <span class="entry-badge tool">${escapeHtml(badgeLabel)}</span>
          <span class="entry-title">${escapeHtml(title)}</span>
          <span class="entry-preview">${escapeHtml(preview || "")}</span>
        </div>
        <div class="entry-meta">
          ${item.timestamp ? `<time>${escapeHtml(formatLocalTime(item.timestamp))}</time>` : ""}
          <span class="entry-caret">+</span>
        </div>
      </summary>
      <div class="entry-content">
        ${renderPreformattedBlock("Body", item.body)}
      </div>
    `;
    return details;
  }

  const article = document.createElement("article");
  article.className = "transcript-entry";
  article.innerHTML = `
    <header class="entry-header">
      <div class="entry-summary">
        <span class="entry-badge neutral">Event</span>
      </div>
      ${item.timestamp ? `<time>${escapeHtml(formatLocalTime(item.timestamp))}</time>` : ""}
    </header>
    <div class="entry-content">
      ${renderPreformattedBlock("Body", item.body || "")}
    </div>
  `;
  return article;
}

function renderTranscript(session) {
  elements.transcriptRoot.replaceChildren();

  if (!session) {
    elements.transcriptToolbar.hidden = true;
    elements.transcriptStats.textContent = "-";
    return;
  }

  const conversationBlocks = getConversationBlocks(session);
  const entries = groupTranscriptItems(session.items);
  const toolCount = entries.filter(
    (entry) => entry.kind === "tool_interaction" || entry.item?.kind?.startsWith("tool")
  ).length;
  const userMessageCount = session.items.filter(isConversationUserMessage).length;
  const reportCount = session.items.filter(isFinalAssistantMessage).length;
  const roundSelection = describeRoundSelection(session);

  for (const block of conversationBlocks) {
    elements.transcriptRoot.append(buildConversationBlock(block, session));
  }

  elements.transcriptToolbar.hidden = false;
  elements.transcriptStats.textContent = [
    `${conversationBlocks.length} 轮`,
    `${userMessageCount} 条用户消息`,
    `${reportCount} 条总结`,
    toolCount > 0 ? `${toolCount} 次工具` : null,
    roundSelection
  ]
    .filter(Boolean)
    .join(" · ");
  bindTranscriptJumpTargets();
}

function showEmptyState(message) {
  clearTranscriptJumpState();
  elements.emptyState.querySelector("p").textContent = message;
  elements.viewerCard.classList.remove("has-selection");
  elements.transcriptRoot.replaceChildren();
  elements.transcriptToolbar.hidden = true;
  elements.transcriptStats.textContent = "-";
}

function renderSelection() {
  const session = getSelectedSession();
  const expectedSignature = session ? getDetailSignature(session) : null;
  const hasMatchingDetail = session && state.detailSignature === expectedSignature && state.detailSession;

  updateActionState(session);
  elements.workspace.dataset.mobilePanel = session ? state.mobilePanel : "master";

  if (!session) {
    elements.sessionStatus.textContent = "未选中";
    elements.sessionTitle.textContent = "选择一个会话查看预览";
    elements.sessionTitle.title = "";
    elements.sessionIdLine.textContent = "-";
    elements.sessionIdLine.title = "";
    elements.sessionPath.textContent = "左侧选择会话后，这里会显示对应的交互式 transcript。";
    elements.sessionPath.title = "";
    elements.sessionLocation.textContent = "-";
    elements.sessionModified.textContent = "-";
    elements.sessionSize.textContent = "-";
    showEmptyState("还没有选中会话。");
    return;
  }

  const locationLabel = getLocationLabel(session.location);
  elements.sessionStatus.textContent = locationLabel;
  elements.sessionTitle.textContent = getSessionHeading(session);
  elements.sessionTitle.title = getSessionHeading(session);
  elements.sessionIdLine.textContent = session.id;
  elements.sessionIdLine.title = session.id;
  elements.sessionPath.textContent = session.relativePath;
  elements.sessionPath.title = session.relativePath;
  elements.sessionLocation.textContent = locationLabel;
  elements.sessionModified.textContent = formatLocalTime(session.modifiedAt);
  elements.sessionSize.textContent = formatBytes(session.sizeBytes);
  elements.openPreviewLink.href = `/preview?${buildSessionQuery(session, { mode: "full" })}`;
  elements.downloadCompactLink.href =
    `/download?${buildSessionQuery(session, { mode: "compact" })}&format=compact-markdown`;
  elements.downloadFullLink.href =
    `/download?${buildSessionQuery(session, { mode: "full" })}&format=full-markdown`;

  if (hasMatchingDetail) {
    elements.viewerCard.classList.add("has-selection");
    renderTranscript(state.detailSession);
    return;
  }

  showEmptyState(state.detailBusy ? "正在加载 transcript…" : "正在准备 transcript…");
}

function render() {
  const scopeItems = getScopeItems(state.scope);
  const filteredItems = getFilteredScopeItems(state.scope);

  if (!filteredItems.some((item) => sessionKey(item) === state.selectedKey)) {
    state.selectedKey = filteredItems[0] ? sessionKey(filteredItems[0]) : null;
  }

  if (!state.selectedKey) {
    state.mobilePanel = "master";
  }

  renderScopeControls();
  renderSidebarSummary(filteredItems.length, scopeItems.length);
  renderChromeState();
  renderSessionList(filteredItems);
  renderSelection();
  syncInlineRenameFocus();
}

async function fetchSessions(options = {}) {
  const preferredKey = options.preferredKey ?? state.selectedKey;
  const preferredId = options.preferredId ?? getSelectedSession()?.id ?? state.routeSelectedId;
  const fallbackKey = options.fallbackKey ?? null;
  const historyMode = options.historyMode || "replace";

  state.busy = true;
  updateActionState(getSelectedSession());
  setFeedback("正在刷新会话列表…");

  try {
    const response = await fetch("/api/sessions", {
      headers: {
        accept: "application/json"
      }
    });

    if (!response.ok) {
      throw new Error((await response.json()).error || "加载会话列表失败。");
    }

    const payload = await response.json();
    state.sessions = payload.sessions;
    state.archivedSessions = payload.archivedSessions;
    elements.sessionsRoot.textContent = payload.roots.sessionsDir;
    elements.archivedRoot.textContent = payload.roots.archivedSessionsDir;

    const selection = resolveSessionSelectionAfterRefresh({
      scope: state.scope,
      sessions: state.sessions,
      archivedSessions: state.archivedSessions,
      preferredKey,
      preferredId,
      fallbackKey
    });

    state.selectedKey = selection.selectedKey;
    state.routeSelectedId = selection.routeSelectedId;

    resetDetailCache();
    setFeedback("会话列表已更新。");
    renderAndSyncBrowserUrl(historyMode);
    await loadSelectedSessionDetail();
  } catch (error) {
    setFeedback(error instanceof Error ? error.message : String(error), {
      error: true
    });
  } finally {
    state.busy = false;
    updateActionState(getSelectedSession());
  }
}

async function loadSelectedSessionDetail() {
  const session = getSelectedSession();

  if (!session) {
    state.detailBusy = false;
    state.detailSignature = null;
    state.detailSession = null;
    renderSelection();
    return;
  }

  const signature = getDetailSignature(session);
  if (state.detailSignature !== signature) {
    clearTranscriptJumpState();
  }

  if (state.detailSignature === signature && state.detailSession) {
    renderSelection();
    return;
  }

  const requestId = ++state.detailRequestId;
  state.detailBusy = true;
  state.detailSession = null;
  renderSelection();
  setFeedback("正在加载 transcript…");

  try {
    const response = await fetch(`/api/session-detail?${buildSessionQuery(session)}`, {
      headers: {
        accept: "application/json"
      }
    });

    if (!response.ok) {
      throw new Error((await response.json()).error || "加载 transcript 失败。");
    }

    const payload = await response.json();
    if (requestId !== state.detailRequestId) {
      return;
    }

    state.detailSignature = signature;
    state.detailSession = payload.session;
    setFeedback("transcript 已更新。");
    renderSelection();
  } catch (error) {
    if (requestId !== state.detailRequestId) {
      return;
    }

    state.detailSignature = null;
    state.detailSession = null;
    renderSelection();
    setFeedback(error instanceof Error ? error.message : String(error), {
      error: true
    });
  } finally {
    if (requestId === state.detailRequestId) {
      state.detailBusy = false;
      updateActionState(getSelectedSession());
    }
  }
}

async function mutateSession(endpoint, options = {}) {
  const session = options.session || getSelectedSession();

  if (!session) {
    return;
  }

  if (options.confirmMessage && !window.confirm(options.confirmMessage)) {
    return;
  }

  const fallbackKey = getNeighborSelectionKey(sessionKey(session));
  state.busy = true;
  updateActionState(session);
  setFeedback(options.pendingMessage || "正在处理…");

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify(
        options.buildRequestBody
          ? options.buildRequestBody(session)
          : {
              relativePath: session.relativePath
            }
      )
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "请求失败。");
    }

    if (options.onSuccess) {
      await options.onSuccess(payload, session);
    }

    setFeedback(options.successMessage || "已完成。");
    await fetchSessions({
      preferredKey: options.getPreferredKey
        ? options.getPreferredKey(payload, session)
        : payload.session
        ? sessionKey(payload.session)
        : null,
      fallbackKey
    });
  } catch (error) {
    if (options.onError) {
      await options.onError(error, session);
    }

    setFeedback(error instanceof Error ? error.message : String(error), {
      error: true
    });
  } finally {
    state.busy = false;
    updateActionState(getSelectedSession());

    if (options.onFinally) {
      await options.onFinally(session);
    }
  }
}

function syncInlineRenameFocus() {
  if (!state.renameFocusPending) {
    return;
  }

  const input = elements.sessionList.querySelector(".session-title-editor");

  if (!input) {
    return;
  }

  input.focus();
  input.select();
  state.renameFocusPending = false;
}

function startInlineRename(session) {
  if (!session || state.busy) {
    return;
  }

  state.selectedKey = sessionKey(session);
  state.mobilePanel = "master";
  state.renamingKey = sessionKey(session);
  state.renamingValue = getRenamePromptValue(session);
  state.renameFocusPending = true;
  renderAndSyncBrowserUrl("replace");
}

function submitInlineRename(session) {
  if (!session || state.busy || !isRenamingSession(session)) {
    return;
  }

  const name = state.renamingValue.trim();

  if (!name) {
    setFeedback("会话名称不能为空。", { error: true });
    state.renameFocusPending = true;
    render();
    return;
  }

  if (name === getRenamePromptValue(session)) {
    clearInlineRename();
    render();
    return;
  }

  mutateSession("/api/sessions/rename", {
    session,
    pendingMessage: "正在更新会话名称…",
    successMessage: "会话名称已更新。",
    onSuccess: () => {
      clearInlineRename();
    },
    onError: () => {
      state.renameFocusPending = true;
      render();
    },
    buildRequestBody: () => ({
      location: session.location,
      relativePath: session.relativePath,
      name
    })
  });
}

function syncOptionsFromControls() {
  const nextOptions = normalizeBrowserOptions({
    rounds: elements.roundsInput.value,
    all: elements.allRoundsToggle.checked,
    includeContext: elements.includeContextToggle.checked,
    includeDeveloper: elements.includeDeveloperToggle.checked,
    includeReasoning: elements.includeReasoningToggle.checked
  });

  if (browserOptionsEqual(state.options, nextOptions)) {
    syncOptionControls();
    syncBrowserUrl("replace");
    return;
  }

  state.options = nextOptions;
  syncOptionControls();
  resetDetailCache();
  renderSelection();
  syncBrowserUrl("replace");
  loadSelectedSessionDetail();
}

elements.searchInput.addEventListener("input", () => {
  renderAndSyncBrowserUrl("replace");
  loadSelectedSessionDetail();
});

elements.refreshButton.addEventListener("click", () => {
  fetchSessions({
    historyMode: "replace"
  });
});

for (const button of elements.scopeButtons) {
  button.addEventListener("click", () => {
    state.scope = button.dataset.scope ?? "all";
    state.mobilePanel = "master";
    renderAndSyncBrowserUrl("push");
    loadSelectedSessionDetail();
  });
}

elements.sidebarToggle.addEventListener("click", () => {
  state.sidebarCollapsed = !state.sidebarCollapsed;
  saveSidebarPreference();
  renderChromeState();
});

elements.roundsInput.addEventListener("change", syncOptionsFromControls);
elements.allRoundsToggle.addEventListener("change", syncOptionsFromControls);
elements.includeContextToggle.addEventListener("change", syncOptionsFromControls);
elements.includeDeveloperToggle.addEventListener("change", syncOptionsFromControls);
elements.includeReasoningToggle.addEventListener("change", syncOptionsFromControls);

elements.renameButton.addEventListener("click", () => {
  startInlineRename(getSelectedSession());
});

elements.archiveButton.addEventListener("click", () => {
  mutateSession("/api/sessions/archive", {
    pendingMessage: "正在归档会话…",
    successMessage: "会话已归档。"
  });
});

elements.restoreButton.addEventListener("click", () => {
  mutateSession("/api/sessions/restore", {
    pendingMessage: "正在恢复会话…",
    successMessage: "会话已恢复到 sessions。"
  });
});

elements.deleteButton.addEventListener("click", () => {
  mutateSession("/api/sessions/delete", {
    confirmMessage: "确定永久删除这个归档会话吗？",
    pendingMessage: "正在删除归档会话…",
    successMessage: "归档会话已删除。"
  });
});

elements.backToListButton.addEventListener("click", () => {
  state.mobilePanel = "master";
  render();
});

window.addEventListener("popstate", () => {
  applyRouteState(parseBrowserUrlState(window.location), {
    loadDetail: true
  });
});

elements.expandToolsButton.addEventListener("click", () => {
  elements.transcriptRoot.querySelectorAll(".process-group").forEach((node) => {
    node.open = true;
  });
});

elements.collapseToolsButton.addEventListener("click", () => {
  elements.transcriptRoot.querySelectorAll(".process-group").forEach((node) => {
    node.open = false;
  });
});

document.addEventListener("keydown", (event) => {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) {
    return;
  }

  if (isEditableTarget(event.target)) {
    return;
  }

  if (event.code === "BracketLeft") {
    event.preventDefault();
    navigateTranscriptJump(-1);
    return;
  }

  if (event.code === "BracketRight") {
    event.preventDefault();
    navigateTranscriptJump(1);
  }
});

state.sidebarCollapsed = loadSidebarPreference();
renderChromeState();
initializeRouteState();
fetchSessions({
  preferredKey: state.selectedKey,
  historyMode: "replace"
});
