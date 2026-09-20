import { startBrowserClientLifecycleTracking } from "./browser-client-lifecycle.js";
import {
  getTranscriptEntryTimestamp,
  groupTranscriptItems,
  groupTranscriptItemsWithRanges,
  splitEntriesIntoDisplaySegments
} from "./transcript-presentation.js";
import {
  getTranscriptJumpTargetKind,
  pickTranscriptJumpIndex,
  pickTranscriptViewportAnchorIndex
} from "./transcript-navigation.js";
import {
  DEFAULT_BROWSER_OPTIONS,
  READER_MODES,
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
import { deriveTaskActivity } from "./task-activity-presentation.js";
import {
  getOldestWorkspaceSession,
  getWorkspaceDisplayName,
  getWorkspaceGroupKey,
  groupSessionsByWorkspace,
  pickNeighborWorkspaceKey,
  sortSessionsByModified
} from "./workspace-groups.js";

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
  workspace: "",
  preserveSelectionOutsideSearch: false,
  mobilePanel: "master",
  sidebarCollapsed: false,
  options: {
    ...DEFAULT_BROWSER_OPTIONS
  },
  pendingDelete: null,
  busy: false,
  detailBusy: false,
  detailRequestId: 0,
  detailSignature: null,
  detailSession: null,
  localAnalysisBusy: false,
  agentAnalysisBusy: false,
  agentAnalysisResult: null,
  campaigns: [],
  activeCampaign: null,
  campaignEvents: [],
  campaignEventSource: null,
  transcriptJumpIndex: null,
  tokenRailActiveIndex: null,
  tokenRailAnchors: [],
  tokenRailSegments: [],
  tokenRailTotalTokens: 0,
  tokenRailSyncQueued: false
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
  workspaceFilter: document.querySelector("#workspace-filter"),
  masterTitle: document.querySelector("#master-title"),
  sessionList: document.querySelector("#session-list"),
  scopeButtons: Array.from(document.querySelectorAll("[data-scope]")),
  readerMode: document.querySelector("#reader-mode"),
  roundsInput: document.querySelector("#rounds-input"),
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
  deleteUndoToast: document.querySelector("#delete-undo-toast"),
  deleteUndoMessage: document.querySelector("#delete-undo-message"),
  undoDeleteButton: document.querySelector("#undo-delete-button"),
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
  transcriptShortcutHint: document.querySelector(".transcript-shortcut-hint"),
  taskActivityCard: document.querySelector("#task-activity-card"),
  taskActivityNote: document.querySelector("#task-activity-note"),
  taskActivityState: document.querySelector("#task-activity-state"),
  taskActivitySummary: document.querySelector("#task-activity-summary"),
  taskRelationship: document.querySelector("#task-relationship"),
  taskTimeline: document.querySelector("#task-timeline"),
  copyAnalysisBriefButton: document.querySelector("#copy-analysis-brief-button"),
  optimizerHandoffButton: document.querySelector("#optimizer-handoff-button"),
  runCodexAnalysisButton: document.querySelector("#run-codex-analysis-button"),
  optimizationAnalysisCard: document.querySelector("#optimization-analysis-card"),
  optimizationAnalysisNote: document.querySelector("#optimization-analysis-note"),
  optimizationAnalysisState: document.querySelector("#optimization-analysis-state"),
  optimizationAnalysisSummary: document.querySelector("#optimization-analysis-summary"),
  optimizationObservations: document.querySelector("#optimization-observations"),
  optimizationRecommendations: document.querySelector("#optimization-recommendations"),
  optimizationTrace: document.querySelector("#optimization-trace"),
  optimizationTraceNote: document.querySelector("#optimization-trace-note"),
  optimizationTraceEntries: document.querySelector("#optimization-trace-entries"),
  optimizationAgentResult: document.querySelector("#optimization-agent-result"),
  optimizationAgentResultText: document.querySelector("#optimization-agent-result-text"),
  transcriptTokenCard: document.querySelector("#transcript-token-card"),
  transcriptTokenNote: document.querySelector("#transcript-token-note"),
  transcriptTokenTotal: document.querySelector("#transcript-token-total"),
  transcriptTokenSummary: document.querySelector("#transcript-token-summary"),
  transcriptTokenBar: document.querySelector("#transcript-token-bar"),
  transcriptTokenLegend: document.querySelector("#transcript-token-legend"),
  transcriptTokenToolsNote: document.querySelector("#transcript-token-tools-note"),
  transcriptTokenTools: document.querySelector("#transcript-token-tools"),
  transcriptTokenRail: document.querySelector("#transcript-token-rail"),
  transcriptTokenRailNote: document.querySelector("#transcript-token-rail-note"),
  transcriptTokenRailTotal: document.querySelector("#transcript-token-rail-total"),
  transcriptTokenRailCurrent: document.querySelector("#transcript-token-rail-current"),
  transcriptTokenRailTrack: document.querySelector("#transcript-token-rail-track"),
  expandToolsButton: document.querySelector("#expand-tools-button"),
  collapseToolsButton: document.querySelector("#collapse-tools-button"),
  transcriptStats: document.querySelector("#transcript-stats"),
  transcriptRoot: document.querySelector("#transcript-root"),
  campaignCard: document.querySelector("#campaign-card"),
  campaignNote: document.querySelector("#campaign-note"),
  campaignState: document.querySelector("#campaign-state"),
  campaignList: document.querySelector("#campaign-list"),
  campaignSummary: document.querySelector("#campaign-summary"),
  campaignOverlay: document.querySelector("#campaign-overlay"),
  campaignWorkerLane: document.querySelector("#campaign-worker-lane"),
  campaignReviewerLane: document.querySelector("#campaign-reviewer-lane"),
  campaignEvents: document.querySelector("#campaign-events")
};

const TOKEN_RAIL_COLORS = [
  "#0f766e",
  "#2563eb",
  "#d97706",
  "#7c3aed",
  "#dc2626",
  "#059669",
  "#0ea5e9",
  "#db2777"
];

const SNAPSHOT_DESKTOP_MIN_WIDTH = 1181;
const SNAPSHOT_CAMPAIGN_CLEARANCE_PX = 16;
const SNAPSHOT_VIEWER_BOTTOM_GAP_PX = 16;
const SNAPSHOT_USER_HEIGHT_SHARE = 0.4;
const DELETE_UNDO_TIMEOUT_MS = 5_000;

let snapshotLayoutFrame = null;
let pendingDeleteTimer = null;
let pendingDeleteCountdownTimer = null;

function resetMemorySnapshotLayout() {
  elements.transcriptRoot.style.removeProperty("--snapshot-user-height");
  elements.transcriptRoot.style.removeProperty("--snapshot-assistant-height");
  elements.campaignCard.style.removeProperty("--snapshot-campaign-offset");
}

/*
 * getBoundingClientRect() changes when the chat pane scrolls. Convert a
 * position back into the pane's content coordinates before using it for the
 * snapshot layout; otherwise collapsing an expanded message while scrolled
 * down would incorrectly make the recall cards taller.
 */
function getChatPaneContentPosition(element, edge = "top") {
  const paneRect = elements.chatPane.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();
  return elementRect[edge] - paneRect.top + elements.chatPane.scrollTop;
}

/*
 * Recall is a self-contained first screen. Keep the Campaign card entirely
 * below the viewport while keeping the viewer card's rounded bottom fully
 * visible. The available height is shared by every user/assistant pair, so
 * columns remain visually regular regardless of message length.
 */
function updateMemorySnapshotLayout() {
  snapshotLayoutFrame = null;

  const root = elements.transcriptRoot;
  const isDesktopSnapshot =
    root.dataset.selectionMode === "memory_snapshot" &&
    window.innerWidth >= SNAPSHOT_DESKTOP_MIN_WIDTH &&
    !root.querySelector(".snapshot-message.is-expanded");

  if (!isDesktopSnapshot) {
    resetMemorySnapshotLayout();
    return;
  }

  // Re-measure from the CSS baseline on every pass so a resize does not retain
  // an offset calculated for an earlier viewport.
  resetMemorySnapshotLayout();

  const userEntries = [...root.querySelectorAll(".snapshot-message.role-user")];
  const assistantEntries = [...root.querySelectorAll(".snapshot-message.role-assistant")];

  if (userEntries.length === 0 || assistantEntries.length === 0) {
    return;
  }

  // The first-screen layout always starts at scrollTop 0. Both values below
  // therefore use stable chat-pane content coordinates, rather than viewport
  // coordinates that vary after the reader scrolls through expanded content.
  const viewerBottom = getChatPaneContentPosition(elements.viewerCard, "bottom");
  const desiredViewerBottom = elements.chatPane.clientHeight - SNAPSHOT_VIEWER_BOTTOM_GAP_PX;
  const additionalCardHeight = Math.max(0, Math.floor(desiredViewerBottom - viewerBottom));

  if (additionalCardHeight > 0) {
    const userHeight = userEntries[0].getBoundingClientRect().height;
    const assistantHeight = assistantEntries[0].getBoundingClientRect().height;
    const userExtra = Math.floor(additionalCardHeight * SNAPSHOT_USER_HEIGHT_SHARE);
    const assistantExtra = additionalCardHeight - userExtra;

    root.style.setProperty("--snapshot-user-height", `${Math.round(userHeight + userExtra)}px`);
    root.style.setProperty("--snapshot-assistant-height", `${Math.round(assistantHeight + assistantExtra)}px`);
  }

  const campaignTop = getChatPaneContentPosition(elements.campaignCard);
  const minimumCampaignTop = elements.chatPane.clientHeight + SNAPSHOT_CAMPAIGN_CLEARANCE_PX;
  const campaignOffset = Math.max(0, Math.ceil(minimumCampaignTop - campaignTop));

  if (campaignOffset > 0) {
    elements.campaignCard.style.setProperty("--snapshot-campaign-offset", `${campaignOffset}px`);
  }
}

function scheduleMemorySnapshotLayout() {
  if (snapshotLayoutFrame !== null) {
    cancelAnimationFrame(snapshotLayoutFrame);
  }

  snapshotLayoutFrame = requestAnimationFrame(updateMemorySnapshotLayout);
}

startBrowserClientLifecycleTracking().catch(() => {});

function getAllSessions() {
  return [...getVisibleSessions(state.sessions), ...getVisibleSessions(state.archivedSessions)];
}

function getVisibleSessions(items) {
  const pendingKey = state.pendingDelete ? sessionKey(state.pendingDelete.session) : null;

  return pendingKey ? items.filter((item) => sessionKey(item) !== pendingKey) : items;
}

function getScopeItems(scope = state.scope) {
  if (scope === "active") {
    return getVisibleSessions(state.sessions);
  }

  if (scope === "archived") {
    return getVisibleSessions(state.archivedSessions);
  }

  return sortSessionsByModified(getAllSessions());
}

function getFilteredScopeItems(scope = state.scope) {
  return filterSessions(getScopeItems(scope));
}

function getWorkspaceGroups(scope = state.scope) {
  return groupSessionsByWorkspace(getScopeItems(scope));
}

function getWorkspaceFallback(workspace = state.workspace, groups = getWorkspaceGroups()) {
  if (!workspace || !groups.some((group) => group.key === workspace)) {
    return null;
  }

  return pickNeighborWorkspaceKey(groups, workspace);
}

function resetUnavailableWorkspaceFilter(scope = state.scope, fallbackWorkspaceKey = null) {
  const groups = getWorkspaceGroups(scope);

  if (!state.workspace || groups.some((group) => group.key === state.workspace)) {
    return null;
  }

  const nextWorkspace =
    fallbackWorkspaceKey && groups.some((group) => group.key === fallbackWorkspaceKey)
      ? fallbackWorkspaceKey
      : "";
  state.workspace = nextWorkspace;

  if (!nextWorkspace) {
    return null;
  }

  return getOldestWorkspaceSession(groups, nextWorkspace);
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
    left.readerMode === right.readerMode &&
    left.rounds === right.rounds &&
    left.includeContext === right.includeContext &&
    left.includeDeveloper === right.includeDeveloper &&
    left.includeReasoning === right.includeReasoning
  );
}

function syncOptionControls() {
  elements.readerMode.value = state.options.readerMode;
  elements.roundsInput.value = String(state.options.rounds);
  elements.includeContextToggle.checked = state.options.includeContext;
  elements.includeDeveloperToggle.checked = state.options.includeDeveloper;
  elements.includeReasoningToggle.checked = state.options.includeReasoning;
  elements.roundsInput.disabled = state.options.readerMode !== READER_MODES.recent;
}

function getBrowserRouteState() {
  const selectedSession = getSelectedSession() || getSessionSelectionFromKey(state.selectedKey);

  return {
    scope: state.scope,
    workspace: state.workspace,
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
  state.agentAnalysisResult = null;
}

function getCampaignEventDetail(event) {
  const data = event.data || {};
  const summary = data.summary || data.checkpointSummary || data.rationale || data.error || data.message || null;
  const evidenceRefs = Array.isArray(data.evidenceRefs) ? data.evidenceRefs : [];
  const patch = data.relativePath ? `补丁：${data.relativePath}` : null;
  const measurement = data.tokenMeasurement || data.measurement;
  const tokenDetail = measurement
    ? measurement.status === "measured"
      ? `${measurement.source === "csr-owned-codex-exec" ? "CSR token" : "日志 token"}：${formatTokenCount(data.workerTokens || measurement.workerTokens || 0)}`
      : `${measurement.source === "csr-owned-codex-exec" ? "CSR token" : "日志 token"}：未测得`
    : null;
  return [summary, patch, tokenDetail, evidenceRefs.length > 0 ? `证据：${evidenceRefs.join(", ")}` : null].filter(Boolean).join(" · ");
}

function formatCampaignEvent(event) {
  const item = document.createElement("li");
  const heading = document.createElement("strong");
  heading.textContent = `${event.role || "system"} · ${event.type || "event"}`;
  const detail = document.createElement("span");
  const task = event.taskId ? ` · ${event.taskId}` : "";
  const payloadDetail = getCampaignEventDetail(event);
  detail.textContent = [
    `${event.timestamp ? formatLocalTime(event.timestamp) : "刚刚"}${task}`,
    payloadDetail
  ]
    .filter(Boolean)
    .join(" · ");
  item.append(heading, detail);
  return item;
}

function renderCampaignEventLane(element, events, emptyText) {
  element.replaceChildren(
    ...(events.length > 0
      ? events.slice(-12).reverse().map(formatCampaignEvent)
      : [Object.assign(document.createElement("li"), { textContent: emptyText })])
  );
}

function campaignMetric(label, value) {
  const card = document.createElement("div");
  card.className = "campaign-metric";
  const labelNode = document.createElement("span");
  const valueNode = document.createElement("strong");
  labelNode.textContent = label;
  valueNode.textContent = value;
  card.append(labelNode, valueNode);
  return card;
}

function getCampaignRoleMetrics(campaign, events, role) {
  const recordedRuns = (campaign.runs || []).filter((run) => run.role === role && run.measurement);
  if (recordedRuns.length > 0) {
    return recordedRuns.reduce(
      (metrics, run) => ({
        tokens: metrics.tokens + (Number(run.measurement?.workerTokens) || 0),
        elapsedMs: metrics.elapsedMs + (Number(run.measurement?.elapsedMs) || 0)
      }),
      { tokens: 0, elapsedMs: 0 }
    );
  }
  const tokenTotalsByThread = new Map();
  let elapsedMs = 0;

  events.forEach((event) => {
    if (event.role !== role) {
      return;
    }
    const data = event.data || {};
    const threadId = data.threadId || data.turn?.threadId || null;
    const totalTokens = Number(data.tokenUsage?.total?.totalTokens);
    if (threadId && Number.isFinite(totalTokens)) {
      tokenTotalsByThread.set(threadId, Math.max(tokenTotalsByThread.get(threadId) || 0, totalTokens));
    }
    if (event.type.endsWith("turn.completed")) {
      const durationMs = Number(data.turn?.durationMs);
      if (Number.isFinite(durationMs) && durationMs > 0) {
        elapsedMs += durationMs;
      }
    }
  });

  return {
    tokens: [...tokenTotalsByThread.values()].reduce((total, value) => total + value, 0),
    elapsedMs
  };
}

function renderCampaignMonitor() {
  const campaigns = state.campaigns;
  const active = state.activeCampaign;
  elements.campaignList.replaceChildren();
  elements.campaignSummary.replaceChildren();
  elements.campaignWorkerLane.replaceChildren();
  elements.campaignReviewerLane.replaceChildren();
  elements.campaignEvents.replaceChildren();

  if (campaigns.length === 0) {
    elements.campaignNote.textContent = "尚无 campaign。调用 $agent-workflow-optimizer 后，这里会显示 worker 与 reviewer 的实时过程。";
    elements.campaignState.textContent = "等待中";
    elements.campaignOverlay.textContent = "尚无 overlay。";
    renderCampaignEventLane(elements.campaignWorkerLane, [], "尚无 worker 事件。");
    renderCampaignEventLane(elements.campaignReviewerLane, [], "尚无 reviewer 事件。");
    renderCampaignEventLane(elements.campaignEvents, [], "尚无验证或补丁记录。");
    return;
  }

  campaigns.forEach((campaign) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "campaign-choice";
    button.classList.toggle("active", campaign.id === active?.id);
    button.textContent = `${campaign.intent || "Optimization campaign"} · ${campaign.id.slice(0, 8)}`;
    button.addEventListener("click", () => loadCampaign(campaign.id));
    elements.campaignList.append(button);
  });

  if (!active) {
    elements.campaignNote.textContent = "正在读取 campaign 详情…";
    elements.campaignState.textContent = "加载中";
    elements.campaignOverlay.textContent = "-";
    renderCampaignEventLane(elements.campaignWorkerLane, [], "正在读取…");
    renderCampaignEventLane(elements.campaignReviewerLane, [], "正在读取…");
    renderCampaignEventLane(elements.campaignEvents, [], "正在读取…");
    return;
  }

  const revision = active.revisions?.at(-1) || { number: 1, overlay: "" };
  const completed = (active.tasks || []).filter((task) => task.status === "completed").length;
  const awaitingValidation = (active.tasks || []).filter((task) => task.status === "awaiting-validation").length;
  const failed = (active.tasks || []).filter((task) => task.status === "failed").length;
  const workerMetrics = getCampaignRoleMetrics(active, state.campaignEvents, "worker");
  const workerTokens = workerMetrics.tokens;
  const workerElapsedMs = workerMetrics.elapsedMs;
  const reviewerEvents = state.campaignEvents.filter((event) => event.role === "reviewer").length;
  const reviewerMetrics = getCampaignRoleMetrics(active, state.campaignEvents, "reviewer");
  const appServer = active.appServer || {};
  const measuredTaskIds = new Set([
    ...(active.tasks || []).filter((task) => task.validation?.tokenMeasurement?.status === "measured").map((task) => task.id),
    ...(active.runs || []).filter((run) => run.role === "worker" && run.measurement?.status === "measured").map((run) => run.taskId)
  ]);
  const measuredTasks = measuredTaskIds.size;
  const running = (active.runs || []).some((run) => run.status === "running");
  const appServerError = appServer.status === "unavailable" && appServer.lastError ? ` · 实时增强不可用` : "";
  elements.campaignNote.textContent = `${active.intent} · ${active.id}${appServerError}`;
  elements.campaignState.textContent = running
    ? "CSR worker 运行中"
    : appServer.status === "connected"
    ? `实时观察 ${appServer.protocolVersion || ""}`.trim()
    : "日志观察";
  elements.campaignOverlay.textContent = revision.overlay || "V1 基线：尚未产生 reviewer overlay。";
  elements.campaignSummary.append(
    campaignMetric("版本", `V${revision.number}`),
    campaignMetric("完成", `${completed}/${active.tasks?.length || 0}`),
    campaignMetric("等待验证", String(awaitingValidation)),
    campaignMetric("失败", String(failed)),
    campaignMetric("worker token", workerTokens > 0 ? formatTokenCount(workerTokens) : "—"),
    campaignMetric("已测 token", `${measuredTasks}/${active.tasks?.length || 0}`),
    campaignMetric("worker 耗时", workerElapsedMs > 0 ? formatDuration(workerElapsedMs) : "—"),
    campaignMetric("reviewer token", reviewerMetrics.tokens > 0 ? formatTokenCount(reviewerMetrics.tokens) : "—"),
    campaignMetric("reviewer 耗时", reviewerMetrics.elapsedMs > 0 ? formatDuration(reviewerMetrics.elapsedMs) : "—"),
    campaignMetric("reviewer 检查点", String(reviewerEvents))
  );
  renderCampaignEventLane(
    elements.campaignWorkerLane,
    state.campaignEvents.filter((event) => event.role === "worker"),
    "尚无 worker 事件。"
  );
  renderCampaignEventLane(
    elements.campaignReviewerLane,
    state.campaignEvents.filter((event) => event.role === "reviewer"),
    "尚无 reviewer 事件。"
  );
  renderCampaignEventLane(
    elements.campaignEvents,
    state.campaignEvents.filter((event) => event.type?.startsWith("validation.") || event.type?.startsWith("patch.")),
    "尚无验证或补丁记录。"
  );
}

function closeCampaignStream() {
  state.campaignEventSource?.close();
  state.campaignEventSource = null;
}

function connectCampaignStream(id) {
  closeCampaignStream();
  const cursor = state.campaignEvents.at(-1)?.seq || 0;
  const source = new EventSource(`/api/campaigns/${encodeURIComponent(id)}/stream?after=${encodeURIComponent(cursor)}`);
  state.campaignEventSource = source;
  source.addEventListener("campaign", (message) => {
    try {
      const event = JSON.parse(message.data);
      if (!state.activeCampaign || state.activeCampaign.id !== id || state.campaignEvents.some((entry) => entry.seq === event.seq)) {
        return;
      }
      state.campaignEvents.push(event);
      if (event.type === "overlay.activated" || /\.(?:run\.(?:started|completed|failed))$/u.test(event.type || "")) {
        loadCampaign(id, { preserveEvents: true });
        return;
      }
      renderCampaignMonitor();
    } catch {
      // Durable events are fetched again when this campaign is selected.
    }
  });
}

async function loadCampaign(id, options = {}) {
  try {
    const [campaignResponse, eventsResponse] = await Promise.all([
      fetch(`/api/campaigns/${encodeURIComponent(id)}`, { headers: { accept: "application/json" } }),
      fetch(`/api/campaigns/${encodeURIComponent(id)}/events`, { headers: { accept: "application/json" } })
    ]);
    const campaignPayload = await campaignResponse.json();
    const eventsPayload = await eventsResponse.json();
    if (!campaignResponse.ok || !eventsResponse.ok) {
      throw new Error(campaignPayload.error || eventsPayload.error || "无法读取 campaign。");
    }
    state.activeCampaign = campaignPayload.campaign;
    if (!options.preserveEvents) {
      state.campaignEvents = eventsPayload.events || [];
    }
    renderCampaignMonitor();
    connectCampaignStream(id);
  } catch (error) {
    elements.campaignNote.textContent = error instanceof Error ? error.message : String(error);
    elements.campaignState.textContent = "读取失败";
  }
}

async function fetchCampaigns() {
  try {
    const response = await fetch("/api/campaigns", { headers: { accept: "application/json" } });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "无法加载 campaign 列表。");
    }
    state.campaigns = payload.campaigns || [];
    const retained = state.campaigns.find((campaign) => campaign.id === state.activeCampaign?.id);
    if (retained) {
      state.activeCampaign = retained;
      renderCampaignMonitor();
      return;
    }
    if (state.campaigns[0]) {
      await loadCampaign(state.campaigns[0].id);
      return;
    }
    state.activeCampaign = null;
    state.campaignEvents = [];
    closeCampaignStream();
    renderCampaignMonitor();
  } catch (error) {
    elements.campaignNote.textContent = error instanceof Error ? error.message : String(error);
    elements.campaignState.textContent = "读取失败";
  }
}

function selectSessionKey(nextKey, options = {}) {
  const nextSession = getAllSessions().find((item) => sessionKey(item) === nextKey) ?? null;
  state.preserveSelectionOutsideSearch = false;
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
  const nextWorkspace = routeState.workspace;
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
  const workspaceChanged = state.workspace !== nextWorkspace;

  state.scope = nextScope;
  state.workspace = nextWorkspace;
  state.preserveSelectionOutsideSearch = false;
  state.selectedKey = nextSelectedKey;
  state.routeSelectedId = nextRouteSelectedId;
  state.mobilePanel = state.selectedKey ? "detail" : "master";
  state.options = nextOptions;

  if (currentSearchValue !== routeState.search) {
    elements.searchInput.value = routeState.search;
  }

  syncOptionControls();

  if (selectionChanged || optionsChanged || workspaceChanged) {
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
  state.workspace = routeState.workspace;
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

function formatTokenCount(value) {
  if (!Number.isFinite(value)) {
    return "-";
  }

  const absolute = Math.abs(value);

  if (absolute >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(absolute >= 10_000_000 ? 0 : 1)}M`;
  }

  if (absolute >= 1_000) {
    return `${(value / 1_000).toFixed(absolute >= 10_000 ? 0 : 1)}k`;
  }

  return `${Math.round(value)}`;
}

function formatTokenPercent(value) {
  if (!Number.isFinite(value)) {
    return "-";
  }

  return `${value.toFixed(1)}%`;
}

function describeRoundSelection(session) {
  const selection = session?.selection;

  if (!selection) {
    return "";
  }

  if (selection.mode === "all") {
    return selection.roundsIncluded > 0 ? `全部 ${selection.roundsIncluded} 轮` : "全部轮次";
  }

  if (selection.mode === "memory_snapshot") {
    return [
      "首 1 · 尾 2 请求",
      selection.omittedItems > 0 ? `省略 ${selection.omittedItems} 项过程` : null
    ]
      .filter(Boolean)
      .join(" · ");
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

function buildMemorySnapshotNotice(selection) {
  const notice = document.createElement("section");
  notice.className = "memory-snapshot-notice";
  const copy = document.createElement("p");
  copy.textContent = [
    "首尾速览",
    "首个请求 + 最近两次请求及答复",
    selection?.summaryComplete === false ? "中间过程按需读取" : null
  ]
    .filter(Boolean)
    .join(" · ");

  const expand = document.createElement("button");
  expand.type = "button";
  expand.className = "memory-snapshot-expand";
  expand.textContent = "查看全部轮次";
  expand.addEventListener("click", () => {
    state.options = {
      ...state.options,
      readerMode: READER_MODES.all
    };
    syncOptionControls();
    resetDetailCache();
    renderSelection();
    syncBrowserUrl("push");
    loadSelectedSessionDetail();
  });

  notice.append(copy, expand);
  return notice;
}

function getLocationLabel(location) {
  return location === "archived_sessions" ? "归档" : "活动";
}

function clearTokenDistribution() {
  elements.transcriptTokenCard.hidden = true;
  elements.transcriptTokenNote.textContent = "-";
  elements.transcriptTokenTotal.textContent = "-";
  elements.transcriptTokenSummary.replaceChildren();
  elements.transcriptTokenBar.replaceChildren();
  elements.transcriptTokenLegend.replaceChildren();
  elements.transcriptTokenToolsNote.textContent = "-";
  elements.transcriptTokenTools.replaceChildren();
}

function clearTokenRail() {
  state.tokenRailActiveIndex = null;
  state.tokenRailAnchors = [];
  state.tokenRailSegments = [];
  state.tokenRailTotalTokens = 0;
  elements.transcriptTokenRail.hidden = true;
  elements.transcriptTokenRailNote.textContent = "-";
  elements.transcriptTokenRailTotal.textContent = "-";
  elements.transcriptTokenRailCurrent.textContent = "-";
  elements.transcriptTokenRailTrack.replaceChildren();
  elements.transcriptTokenRailTrack.style.height = "";
}

function clearTaskActivity() {
  elements.taskActivityCard.hidden = true;
  elements.taskActivityCard.dataset.state = "";
  elements.taskActivityNote.textContent = "-";
  elements.taskActivityState.textContent = "-";
  elements.taskActivitySummary.replaceChildren();
  elements.taskRelationship.replaceChildren();
  elements.taskTimeline.replaceChildren();
}

function clearOptimizationAnalysis() {
  elements.optimizationAnalysisCard.hidden = true;
  elements.optimizationAnalysisCard.dataset.state = "";
  elements.optimizationAnalysisNote.textContent = "-";
  elements.optimizationAnalysisState.textContent = "-";
  elements.optimizationAnalysisSummary.replaceChildren();
  elements.optimizationObservations.replaceChildren();
  elements.optimizationRecommendations.replaceChildren();
  elements.optimizationTrace.open = false;
  elements.optimizationTraceNote.textContent = "-";
  elements.optimizationTraceEntries.replaceChildren();
  elements.optimizationAgentResult.hidden = true;
  elements.optimizationAgentResult.open = false;
  elements.optimizationAgentResultText.textContent = "";
}

function formatDuration(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return "未记录";
  }

  if (durationMs < 60_000) {
    return `${Math.round(durationMs / 1_000)} 秒`;
  }

  return `${Math.round(durationMs / 60_000)} 分钟`;
}

function getOptimizationAnalysisState(analysis) {
  if (analysis.summary.verificationFailures > 0) {
    return { label: "先修正确性", value: "attention" };
  }

  if (analysis.recommendations.length > 0) {
    return { label: "可建基准", value: "ready" };
  }

  return { label: "证据不足", value: "limited" };
}

function createOptimizationListItem(entry) {
  const item = document.createElement("li");
  const title = document.createElement("strong");
  title.textContent = entry.title;
  const detail = document.createElement("span");
  detail.textContent = entry.detail;
  const meta = document.createElement("small");
  meta.textContent = entry.confidence === "observed" || entry.kind === "observed" || entry.kind === "measurement"
    ? "基于记录"
    : "待验证假设";
  item.append(title, detail, meta);
  return item;
}

function createOptimizationTraceEntry(entry, { canJump = true } = {}) {
  const row = document.createElement("li");
  const details = document.createElement("details");
  details.className = "optimization-trace-entry";
  const summary = document.createElement("summary");
  const title = document.createElement("span");
  title.className = "optimization-trace-entry-title";
  title.textContent = entry.label;

  const meta = document.createElement("span");
  meta.className = "optimization-trace-entry-meta";
  meta.textContent = [
    entry.timestamp ? formatLocalTime(entry.timestamp) : "日志中未提供时间",
    entry.truncated ? "已截断" : null
  ]
    .filter(Boolean)
    .join(" · ");
  summary.append(title, meta);
  const content = document.createElement("pre");
  content.textContent = entry.content || "(empty)";
  details.append(summary, content);

  if (canJump && Number.isInteger(entry.itemIndex)) {
    const jump = document.createElement("button");
    jump.type = "button";
    jump.className = "optimization-trace-jump";
    jump.dataset.taskActivityIndex = String(entry.itemIndex);
    jump.textContent = "跳转原始 transcript";
    details.append(jump);
  }

  row.append(details);
  return row;
}

function renderOptimizationTrace(trace, { canJump = true } = {}) {
  const entries = Array.isArray(trace?.entries) ? trace.entries : [];
  elements.optimizationTraceEntries.replaceChildren(
    ...entries.map((entry) => createOptimizationTraceEntry(entry, { canJump }))
  );
  elements.optimizationTraceNote.textContent = [
    `${entries.length} 项`,
    trace?.isTruncated ? `已截断 ${trace.truncatedEntries} 段 / 省略 ${trace.omittedItems} 项` : "当前范围完整"
  ].join(" · ");
}

function renderCodexAnalysisResult() {
  const result = state.agentAnalysisResult;

  if (!result || result.signature !== state.detailSignature) {
    elements.optimizationAgentResult.hidden = true;
    elements.optimizationAgentResult.open = false;
    elements.optimizationAgentResultText.textContent = "";
    return;
  }

  elements.optimizationAgentResult.hidden = false;
  elements.optimizationAgentResult.open = true;
  elements.optimizationAgentResultText.textContent = result.text;
}

function renderOptimizationAnalysis(session) {
  const analysis = session?.optimizationAnalysis;

  if (!analysis) {
    clearOptimizationAnalysis();
    return;
  }

  const stateInfo = getOptimizationAnalysisState(analysis);
  elements.optimizationAnalysisCard.hidden = false;
  elements.optimizationAnalysisCard.dataset.state = stateInfo.value;
  elements.optimizationAnalysisState.textContent = stateInfo.label;
  elements.optimizationAnalysisNote.textContent = [
    `${analysis.summary.toolCalls} 次工具调用`,
    analysis.summary.totalTokens > 0 ? `${formatTokenCount(analysis.summary.totalTokens)} token` : "未记录 token",
    analysis.summary.documentsRead > 0 ? `${analysis.summary.documentsRead} 份指令资产` : null,
    analysis.summary.skills > 0 ? `${analysis.summary.skills} 个 Skill` : null
  ]
    .filter(Boolean)
    .join(" · ");
  elements.optimizationAnalysisSummary.replaceChildren(
    createTaskActivityMetric("记录 token", analysis.summary.totalTokens > 0 ? formatTokenCount(analysis.summary.totalTokens) : "—", "tool"),
    createTaskActivityMetric("任务耗时", formatDuration(analysis.summary.durationMs), "started"),
    createTaskActivityMetric("重复调用", String(analysis.repeatedToolCalls.length), "delegation"),
    createTaskActivityMetric(
      "失败验证",
      String(analysis.summary.verificationFailures),
      analysis.summary.verificationFailures > 0 ? "failed" : "verification"
    )
  );
  elements.optimizationObservations.replaceChildren(
    ...(analysis.observations.length > 0
      ? analysis.observations.map(createOptimizationListItem)
      : [createOptimizationListItem({ title: "尚无可归因异常", detail: "请在更多相似任务上收集证据后再作修改。", kind: "hypothesis" })])
  );
  elements.optimizationRecommendations.replaceChildren(
    ...analysis.recommendations.map(createOptimizationListItem)
  );
  renderOptimizationTrace(analysis.taskTrace, {
    canJump: analysis.traceJumpsAvailable !== false
  });
  renderCodexAnalysisResult();
}

function getTaskActivityState(activity) {
  if (activity.summary.failed > 0) {
    return { label: "需复核", value: "attention" };
  }

  if (activity.timeline.some((event) => event.kind === "completed")) {
    return { label: "已完成", value: "complete" };
  }

  if (activity.summary.passed > 0) {
    return { label: "已验证", value: "verified" };
  }

  return { label: "进行中", value: "active" };
}

function getTaskStatusLabel(status) {
  switch (status) {
    case "completed":
      return "完成";
    case "blocked":
      return "阻塞";
    case "delegated":
      return "已委派";
    case "failed":
      return "失败";
    case "passed":
      return "通过";
    case "recorded":
      return "已记录";
    case "pending":
      return "待结果";
    default:
      return "已识别";
  }
}

function createTaskActivityMetric(label, value, tone = "neutral") {
  const item = document.createElement("div");
  item.className = `task-activity-metric ${tone}`;

  const metricLabel = document.createElement("span");
  metricLabel.textContent = label;
  const metricValue = document.createElement("strong");
  metricValue.textContent = value;
  item.append(metricLabel, metricValue);
  return item;
}

function createTaskActivityNode(type, label, options = {}) {
  const itemIndex = Number.isInteger(options.itemIndex) ? options.itemIndex : null;
  const node = document.createElement(itemIndex === null ? "div" : "button");
  node.className = `task-relation-node ${type}`;
  node.dataset.status = options.status || "observed";

  if (itemIndex !== null) {
    node.type = "button";
    node.dataset.taskActivityIndex = String(itemIndex);
    node.title = `跳转到原始 transcript\n${label}`;
  } else {
    node.title = label;
  }

  const badge = document.createElement("span");
  badge.className = "task-relation-badge";
  badge.textContent = options.badge || "记录";
  const title = document.createElement("strong");
  title.textContent = label;
  const meta = document.createElement("span");
  meta.className = "task-relation-meta";
  meta.textContent = options.meta || getTaskStatusLabel(options.status);
  node.append(badge, title, meta);
  return node;
}

function renderTaskRelationship(activity) {
  elements.taskRelationship.replaceChildren();

  if (activity.goals.length === 0) {
    const empty = document.createElement("p");
    empty.className = "task-relationship-empty";
    empty.textContent = "尚未从当前会话识别到 Goal；下方仍保留全部可审计事件。";
    elements.taskRelationship.append(empty);
    return;
  }

  for (const goal of activity.goals) {
    const branch = document.createElement("section");
    branch.className = "task-relation-branch";
    const root = createTaskActivityNode("goal", goal.label, {
      badge: "Goal",
      status: goal.status,
      itemIndex: goal.itemIndex,
      meta: `${getTaskStatusLabel(goal.status)} · ${goal.source === "create_goal" ? "显式" : "用户请求"}`
    });
    const children = document.createElement("div");
    children.className = "task-relation-children";
    const childTasks = activity.tasks.filter(
      (task) => task.goalId === goal.id || (activity.goals.length === 1 && !task.goalId)
    );
    const directVerifications = activity.verifications.filter(
      (verification) =>
        (verification.goalId === goal.id || (activity.goals.length === 1 && !verification.goalId)) &&
        !childTasks.some((task) => task.id === verification.taskId)
    );
    const relationshipCount = childTasks.length + directVerifications.length;
    const relationshipHeading = document.createElement("p");
    relationshipHeading.className = "task-relation-children-head";
    relationshipHeading.textContent = childTasks.length > 0
      ? `执行与验证 · ${relationshipCount} 项记录`
      : `验证证据 · ${directVerifications.length} 项`;
    children.append(relationshipHeading);

    for (const task of childTasks) {
      const taskWrap = document.createElement("div");
      taskWrap.className = "task-relation-task";
      taskWrap.append(
        createTaskActivityNode("subtask", task.label, {
          badge: "子任务",
          status: task.status,
          itemIndex: task.itemIndex,
          meta: getTaskStatusLabel(task.status)
        })
      );

      const checks = activity.verifications.filter((verification) => verification.taskId === task.id);
      if (checks.length > 0) {
        const evidence = document.createElement("div");
        evidence.className = "task-relation-evidence";
        checks.forEach((verification) => {
          evidence.append(
            createTaskActivityNode("verification", verification.command, {
              badge: "验证",
              status: verification.status,
              itemIndex: verification.itemIndex,
              meta: getTaskStatusLabel(verification.status)
            })
          );
        });
        taskWrap.append(evidence);
      }

      children.append(taskWrap);
    }

    directVerifications.forEach((verification) => {
      children.append(
        createTaskActivityNode("verification", verification.command, {
          badge: "验证",
          status: verification.status,
          itemIndex: verification.itemIndex,
          meta: getTaskStatusLabel(verification.status)
        })
      );
    });

    if (relationshipCount === 0) {
      const pending = document.createElement("p");
      pending.className = "task-relation-pending";
      pending.textContent = "尚未记录到委派或验证步骤";
      children.append(pending);
    }

    branch.append(root, children);
    elements.taskRelationship.append(branch);
  }
}

function renderTaskTimeline(activity) {
  elements.taskTimeline.replaceChildren();

  for (const event of activity.timeline) {
    const row = document.createElement("li");
    row.className = "task-timeline-event";
    row.dataset.kind = event.kind;
    const content = document.createElement(Number.isInteger(event.itemIndex) ? "button" : "div");
    content.className = "task-timeline-event-content";

    if (Number.isInteger(event.itemIndex)) {
      content.type = "button";
      content.dataset.taskActivityIndex = String(event.itemIndex);
      content.title = "跳转到原始 transcript";
    }

    const marker = document.createElement("span");
    marker.className = "task-timeline-marker";
    const title = document.createElement("strong");
    title.textContent = event.title;
    const detail = document.createElement("span");
    detail.className = "task-timeline-detail";
    detail.textContent = event.detail;
    const time = document.createElement("time");
    time.textContent = event.timestamp ? formatLocalTime(event.timestamp) : "日志中未提供时间";
    content.append(marker, title, detail, time);
    row.append(content);
    elements.taskTimeline.append(row);
  }
}

function renderTaskActivity(session) {
  const activity = deriveTaskActivity(session);

  if (!activity.hasActivity) {
    clearTaskActivity();
    return;
  }

  const stateInfo = getTaskActivityState(activity);
  elements.taskActivityCard.hidden = false;
  elements.taskActivityCard.dataset.state = stateInfo.value;
  elements.taskActivityState.textContent = stateInfo.label;
  elements.taskActivityNote.textContent = [
    `${activity.summary.starts} 个 task_started`,
    `${activity.summary.tools} 次工具调用`,
    activity.summary.delegated > 0 ? `${activity.summary.delegated} 项委派` : null,
    activity.summary.recorded > 0
      ? `${activity.summary.passed} 通过 / ${activity.summary.failed} 失败 / ${activity.summary.recorded} 项验证`
      : "尚未识别到验证命令"
  ]
    .filter(Boolean)
    .join(" · ");
  elements.taskActivitySummary.replaceChildren(
    createTaskActivityMetric("任务启动", String(activity.summary.starts), "started"),
    createTaskActivityMetric("工具调用", String(activity.summary.tools), "tool"),
    createTaskActivityMetric("已委派", String(activity.summary.delegated), "delegation"),
    createTaskActivityMetric(
      "验证结果",
      activity.summary.recorded > 0 ? `${activity.summary.passed}/${activity.summary.failed}` : "—",
      activity.summary.failed > 0 ? "failed" : "verification"
    )
  );
  renderTaskRelationship(activity);
  renderTaskTimeline(activity);
}

function jumpToTranscriptItem(itemIndex) {
  const candidates = Array.from(
    elements.transcriptRoot.querySelectorAll("[data-item-start-index][data-item-end-index]")
  )
    .filter((element) => {
      const start = Number(element.dataset.itemStartIndex);
      const end = Number(element.dataset.itemEndIndex);
      return Number.isFinite(start) && Number.isFinite(end) && start <= itemIndex && itemIndex < end;
    })
    .sort((left, right) => {
      const leftSize = Number(left.dataset.itemEndIndex) - Number(left.dataset.itemStartIndex);
      const rightSize = Number(right.dataset.itemEndIndex) - Number(right.dataset.itemStartIndex);
      return leftSize - rightSize;
    });
  const target = candidates[0];

  if (!target) {
    return;
  }

  if (target instanceof HTMLDetailsElement) {
    target.open = true;
  }

  let ancestor = target.parentElement;
  while (ancestor && ancestor !== elements.transcriptRoot) {
    if (ancestor instanceof HTMLDetailsElement) {
      ancestor.open = true;
    }
    ancestor = ancestor.parentElement;
  }

  target.classList.add("task-evidence-active");
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  window.setTimeout(() => target.classList.remove("task-evidence-active"), 1800);
}

function formatTokenRailSegmentLabel(segment, totalTokens) {
  const percent = totalTokens > 0 ? (segment.tokens / totalTokens) * 100 : 0;
  return `${formatTokenCount(segment.tokens)} tok · ${formatTokenPercent(percent)}`;
}

function getTokenRailColor(index) {
  return TOKEN_RAIL_COLORS[index % TOKEN_RAIL_COLORS.length];
}

function applyItemRangeAttributes(element, range) {
  if (!(element instanceof HTMLElement) || !range) {
    return;
  }

  element.dataset.itemStartIndex = String(range.startIndex);
  element.dataset.itemEndIndex = String(range.endIndex);
}

function createTokenRailSegment(segment, totalTokens) {
  const item = document.createElement("article");
  item.className = "transcript-token-segment";
  item.dataset.segmentIndex = String(segment.index - 1);
  item.style.setProperty("--token-color", getTokenRailColor(segment.index - 1));

  const title = document.createElement("div");
  title.className = "transcript-token-segment-title";
  title.textContent = `第 ${segment.index} 段`;

  const meta = document.createElement("div");
  meta.className = "transcript-token-segment-meta";
  meta.textContent = formatTokenRailSegmentLabel(segment, totalTokens);

  item.append(title, meta);
  item.title = `${title.textContent} · ${meta.textContent}`;
  return item;
}

function findBestRailNode(nodes, itemIndex) {
  let bestNode = null;
  let bestSpan = Number.POSITIVE_INFINITY;

  for (const node of nodes) {
    const startIndex = Number(node.dataset.itemStartIndex);
    const endIndex = Number(node.dataset.itemEndIndex);

    if (!Number.isFinite(startIndex) || !Number.isFinite(endIndex)) {
      continue;
    }

    if (itemIndex < startIndex || itemIndex >= endIndex) {
      continue;
    }

    const span = Math.max(1, endIndex - startIndex);

    if (span < bestSpan) {
      bestSpan = span;
      bestNode = node;
    }
  }

  return bestNode;
}

function layoutTokenRail() {
  if (elements.transcriptTokenRail.hidden || state.tokenRailSegments.length === 0) {
    return;
  }

  const candidateNodes = Array.from(
    elements.transcriptRoot.querySelectorAll("[data-item-start-index][data-item-end-index]")
  );
  const transcriptRootRect = elements.transcriptRoot.getBoundingClientRect();
  const transcriptHeight = Math.max(elements.transcriptRoot.scrollHeight, transcriptRootRect.height, 1);
  const positionedSegments = state.tokenRailSegments.map((segment) => {
    const startNode = findBestRailNode(candidateNodes, segment.startIndex);
    const endNode = findBestRailNode(candidateNodes, Math.max(segment.startIndex, segment.endIndex - 1));

    if (startNode && endNode) {
      const startRect = startNode.getBoundingClientRect();
      const endRect = endNode.getBoundingClientRect();
      const top = Math.max(0, startRect.top - transcriptRootRect.top);
      const bottom = Math.max(top + 24, endRect.bottom - transcriptRootRect.top);

      return {
        ...segment,
        startNode,
        top,
        height: bottom - top
      };
    }

    return {
      ...segment,
      startNode: null,
      top: 0,
      height: Math.max(24, transcriptHeight / Math.max(1, state.tokenRailSegments.length))
    };
  });

  elements.transcriptTokenRailTrack.style.height = `${transcriptHeight}px`;
  elements.transcriptTokenRailTrack.replaceChildren(
    ...positionedSegments.map((segment) => {
      const item = createTokenRailSegment(segment, state.tokenRailTotalTokens);
      item.style.top = `${segment.top}px`;
      item.style.height = `${segment.height}px`;
      return item;
    })
  );
  state.tokenRailAnchors = positionedSegments.map((segment) => segment.startNode);
}

function renderTokenRail(tokenSegments, tokenStats) {
  const segments = Array.isArray(tokenSegments) ? tokenSegments.filter((segment) => Number.isFinite(segment.tokens) && segment.tokens > 0) : [];

  if (!tokenStats || segments.length === 0) {
    clearTokenRail();
    return;
  }

  const totalTokens = Number.isFinite(tokenStats.totalTokens) && tokenStats.totalTokens > 0
    ? tokenStats.totalTokens
    : segments.reduce((sum, segment) => sum + segment.tokens, 0);

  elements.transcriptTokenRail.hidden = false;
  elements.transcriptTokenRailNote.textContent = "按 token_count 分段";
  elements.transcriptTokenRailTotal.textContent = `${formatTokenCount(totalTokens)} tok`;
  state.tokenRailSegments = segments;
  state.tokenRailTotalTokens = totalTokens;
  state.tokenRailActiveIndex = null;
  layoutTokenRail();
  scheduleTokenRailSync({ rebuildAnchors: true });
}

function getTokenRailMarkerLine() {
  const paneRect = elements.chatPane.getBoundingClientRect();
  return paneRect.top + Math.min(180, Math.max(104, paneRect.height * 0.18));
}

function updateTokenRailHighlight(activeIndex) {
  if (state.tokenRailActiveIndex === activeIndex) {
    return;
  }

  state.tokenRailActiveIndex = activeIndex;
  const items = elements.transcriptTokenRail.querySelectorAll(".transcript-token-segment");

  items.forEach((item) => {
    const isActive = Number(item.dataset.segmentIndex) === activeIndex;
    item.classList.toggle("is-active", isActive);
    item.setAttribute("aria-current", isActive ? "true" : "false");
  });

  const activeSegment = Number.isInteger(activeIndex)
    ? state.tokenRailSegments.find((segment) => segment.index - 1 === activeIndex) ?? null
    : null;

  if (activeSegment) {
    const totalTokens = state.tokenRailTotalTokens;
    const percent = totalTokens > 0 ? (activeSegment.tokens / totalTokens) * 100 : 0;
    elements.transcriptTokenRailCurrent.textContent = `当前第 ${activeSegment.index} 段 · ${formatTokenPercent(percent)} · ${formatTokenCount(activeSegment.tokens)} tok`;
    elements.transcriptTokenRailCurrent.title = elements.transcriptTokenRailCurrent.textContent;
  } else {
    elements.transcriptTokenRailCurrent.textContent = "-";
    elements.transcriptTokenRailCurrent.title = "";
  }
}

function syncTokenRailFromScroll() {
  if (elements.transcriptTokenRail.hidden) {
    return;
  }

  const anchors = state.tokenRailAnchors;

  if (anchors.length === 0) {
    updateTokenRailHighlight(null);
    return;
  }

  const markerLine = getTokenRailMarkerLine();
  let activeIndex = 0;

  for (let index = 0; index < anchors.length; index += 1) {
    const node = anchors[index];

    if (!(node instanceof Element) || !node.isConnected) {
      continue;
    }

    const rect = node.getBoundingClientRect();

    if (rect.top <= markerLine) {
      activeIndex = index;
    } else {
      break;
    }
  }

  updateTokenRailHighlight(activeIndex);
}

function scheduleTokenRailSync({ rebuildAnchors = false } = {}) {
  if (rebuildAnchors) {
    state.tokenRailAnchors = [];
  }

  if (state.tokenRailSyncQueued) {
    return;
  }

  state.tokenRailSyncQueued = true;
  window.requestAnimationFrame(() => {
    state.tokenRailSyncQueued = false;
    if (!elements.transcriptTokenRail.hidden) {
      if (rebuildAnchors) {
        layoutTokenRail();
      }
      syncTokenRailFromScroll();
    }
  });
}

function createTokenMetric(label, value, note) {
  const item = document.createElement("div");
  item.className = "token-summary-item";

  const metricLabel = document.createElement("div");
  metricLabel.className = "token-summary-label";
  metricLabel.textContent = label;

  const metricValue = document.createElement("div");
  metricValue.className = "token-summary-value";
  metricValue.textContent = value;

  item.append(metricLabel, metricValue);

  if (note) {
    const metricNote = document.createElement("div");
    metricNote.className = "token-summary-note";
    metricNote.textContent = note;
    item.append(metricNote);
  }

  return item;
}

function createTokenChip(label, value) {
  const chip = document.createElement("span");
  chip.className = "token-chip";
  chip.textContent = `${label}: ${value}`;
  return chip;
}

function formatTokenShareText(tokens, totalTokens) {
  const percent = totalTokens > 0 ? (tokens / totalTokens) * 100 : 0;
  return `${formatTokenCount(tokens)} tok · ${formatTokenPercent(percent)}`;
}

function renderToolInstance(instance, groupTokens, totalTokens) {
  const row = document.createElement("article");
  row.className = "token-instance";

  const header = document.createElement("div");
  header.className = "token-instance-header";

  const title = document.createElement("div");
  title.className = "token-instance-title";
  title.textContent = instance.isTruncated ? `#${instance.index} · 截断` : `#${instance.index}`;

  const meta = document.createElement("div");
  meta.className = "token-instance-meta";
  const overall = formatTokenPercent(instance.shareOfOverall * 100);
  const withinTool = formatTokenPercent(instance.shareOfToolTotal * 100);
  meta.textContent = [
    `${formatTokenCount(instance.tokens)} tok`,
    `${withinTool} of ${instance.name}`,
    `${overall} overall`,
    instance.isTruncated ? (instance.truncationReason || "日志截断") : null
  ]
    .filter(Boolean)
    .join(" · ");

  header.append(title, meta);

  const body = document.createElement("div");
  body.className = "token-instance-body";

  const preview = document.createElement("div");
  preview.className = "token-instance-preview";
  preview.textContent = instance.preview || "No data";
  body.append(preview);

  if (instance.isTruncated) {
    const truncation = document.createElement("div");
    truncation.className = "token-instance-detail token-instance-truncation";
    truncation.textContent = instance.truncationReason || "日志截断";
    body.append(truncation);
  }

  if (instance.callPreview || instance.outputPreview) {
    const detail = document.createElement("div");
    detail.className = "token-instance-detail";
    detail.textContent = [
      instance.callPreview ? `Input: ${instance.callPreview}` : null,
      instance.outputPreview ? `Output: ${instance.outputPreview}` : null
    ]
      .filter(Boolean)
      .join(" · ");
    body.append(detail);
  }

  const bar = document.createElement("div");
  bar.className = "token-instance-bar";
  const fill = document.createElement("div");
  fill.className = "token-instance-fill";
  fill.style.width = `${Math.max(2, instance.shareOfToolTotal * 100)}%`;
  bar.append(fill);

  row.append(header, body, bar);
  row.title = `${instance.name} · ${formatTokenShareText(instance.tokens, totalTokens)} · ${formatTokenPercent(instance.shareOfToolTotal * 100)} of ${instance.name}`;

  return row;
}

function renderToolGroup(group, totalTokens, index) {
  const details = document.createElement("details");
  details.className = "token-tool-group";
  details.open = false;

  const summary = document.createElement("summary");
  summary.className = "token-tool-summary";

  const left = document.createElement("div");
  left.className = "token-tool-summary-left";

  const badge = document.createElement("span");
  badge.className = "token-tool-badge";
  badge.style.setProperty("--token-color", group.color);
  badge.textContent = group.label;

  const title = document.createElement("div");
  title.className = "token-tool-title";
  title.textContent = `${group.label} · ${group.count} 次`;

  const subtitle = document.createElement("div");
  subtitle.className = "token-tool-subtitle";
  subtitle.textContent = [
    `${formatTokenCount(group.tokens)} tok`,
    `${formatTokenPercent(group.shareOfOverall * 100)} overall`,
    `${formatTokenPercent(group.shareOfToolTotal * 100)} of tool total`,
    group.truncatedCount > 0 ? `${group.truncatedCount} 截断` : null
  ]
    .filter(Boolean)
    .join(" · ");

  left.append(badge, title, subtitle);

  const right = document.createElement("div");
  right.className = "token-tool-summary-right";

  const caret = document.createElement("span");
  caret.className = "token-tool-caret";
  caret.textContent = "+";
  right.append(caret);

  summary.append(left, right);
  details.append(summary);

  const body = document.createElement("div");
  body.className = "token-tool-body";

  const instances = document.createElement("div");
  instances.className = "token-tool-instances";
  group.instances.forEach((instance) => {
    instances.append(renderToolInstance(instance, group.tokens, totalTokens));
  });

  body.append(instances);
  details.append(body);
  return details;
}

function renderTokenDistribution(tokenStats) {
  if (!tokenStats || !Array.isArray(tokenStats.categories) || tokenStats.categories.length === 0) {
    clearTokenDistribution();
    return;
  }

  const categories = tokenStats.categories.filter((entry) => Number.isFinite(entry.tokens) && entry.tokens > 0);

  if (categories.length === 0) {
    clearTokenDistribution();
    return;
  }

  const totalTokens = Number.isFinite(tokenStats.totalTokens) && tokenStats.totalTokens > 0
    ? tokenStats.totalTokens
    : categories.reduce((sum, entry) => sum + entry.tokens, 0);
  const knownTokens = Number.isFinite(tokenStats.knownTokens)
    ? tokenStats.knownTokens
    : Math.max(0, totalTokens - (Number.isFinite(tokenStats.hiddenTokens) ? tokenStats.hiddenTokens : 0));
  const hiddenTokens = Number.isFinite(tokenStats.hiddenTokens)
    ? tokenStats.hiddenTokens
    : Math.max(0, totalTokens - knownTokens);
  const explicitTruncationCount = Number.isFinite(tokenStats.explicitTruncationCount)
    ? tokenStats.explicitTruncationCount
    : 0;
  const unattributedStats = tokenStats.unattributedStats || {
    totalCount: 0,
    webSearchCount: 0,
    truncatedCount: 0,
    noVisibleDataCount: 0,
    residualCount: 0
  };
  const toolStats = tokenStats.toolStats || { totalTokens: 0, totalCount: 0, groups: [], shareOfOverall: 0 };
  const toolGroups = Array.isArray(toolStats.groups) ? toolStats.groups : [];
  elements.transcriptTokenCard.hidden = false;
  elements.transcriptTokenNote.textContent =
    "按 token_count 段统计：可见文本按长度估算；剩余 token 统一记为未归因，次数标签可重叠。";
  elements.transcriptTokenTotal.textContent = `${formatTokenCount(totalTokens)} tok`;
  elements.transcriptTokenSummary.replaceChildren(
    createTokenMetric("总量", `${formatTokenCount(totalTokens)} tok`, "按段 total_tokens 统计"),
    createTokenMetric("已识别", `${formatTokenCount(knownTokens)} tok`, "能从日志直接看到的部分"),
    createTokenMetric(
      "未归因",
      `${formatTokenCount(hiddenTokens)} tok`,
      [
        `${unattributedStats.totalCount} 段未归因（按 token_count）`,
        `${unattributedStats.webSearchCount} 段含 web_search`,
        `${unattributedStats.truncatedCount} 段明确截断`,
        unattributedStats.noVisibleDataCount > 0 ? `${unattributedStats.noVisibleDataCount} 段无可见内容` : null,
        `${unattributedStats.residualCount} 段其他残差`
      ]
        .filter(Boolean)
        .join(" · ")
    ),
    createTokenMetric(
      "Tool",
      `${formatTokenCount(toolStats.totalTokens)} tok`,
      `${formatTokenPercent(toolStats.shareOfOverall * 100)} of total · ${toolStats.totalCount} 次`
    )
  );
  elements.transcriptTokenBar.replaceChildren();
  elements.transcriptTokenLegend.replaceChildren();
  elements.transcriptTokenToolsNote.textContent = toolGroups.length > 0
    ? [
        "每个 tool 只统计能从日志直接看到的输入/输出",
        `未归因共 ${unattributedStats.totalCount} 段，不会硬分给某个 tool`,
        "web_search 内部消耗和其他未落盘内容留在未归因里",
        explicitTruncationCount > 0 ? `已明确标出 ${explicitTruncationCount} 处日志截断` : null
      ]
        .filter(Boolean)
        .join("；")
    : "当前会话没有可分组的 tool 调用。";
  elements.transcriptTokenTools.replaceChildren();

  for (const entry of categories) {
    const percent = totalTokens > 0 ? (entry.tokens / totalTokens) * 100 : 0;
    const displayLabel = entry.key === "hidden" ? "未归因" : entry.label;
    const bar = document.createElement("div");
    bar.className = "token-bar-segment";
    bar.style.setProperty("--token-color", entry.color);
    bar.style.flexBasis = `${percent}%`;
    bar.title = `${displayLabel} · ${formatTokenCount(entry.tokens)} tok · ${formatTokenPercent(percent)} cost`;
    elements.transcriptTokenBar.append(bar);

    const legendItem = document.createElement("div");
    legendItem.className = "token-legend-item";

    const swatch = document.createElement("span");
    swatch.className = "token-legend-swatch";
    swatch.style.setProperty("--token-color", entry.color);

    const body = document.createElement("div");
    body.className = "token-legend-body";

    const label = document.createElement("div");
    label.className = "token-legend-label";
    label.textContent = displayLabel;

    const meta = document.createElement("div");
    meta.className = "token-legend-meta";
    meta.textContent = entry.key === "hidden"
      ? `${formatTokenCount(entry.tokens)} tok · ${formatTokenPercent(percent)} cost · ${unattributedStats.totalCount} 段未归因`
      : `${formatTokenCount(entry.tokens)} tok · ${formatTokenPercent(percent)} cost`;

    body.append(label, meta);
    legendItem.append(swatch, body);
    elements.transcriptTokenLegend.append(legendItem);
  }

  toolGroups.forEach((group, index) => {
    elements.transcriptTokenTools.append(renderToolGroup(group, totalTokens, index));
  });
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
  return item.displayName || item.threadName || getMissingThreadNameLabel();
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
  const readerMode = overrides.readerMode ?? state.options.readerMode;
  const searchParams = new URLSearchParams({
    location: session.location,
    relativePath: session.relativePath,
    rounds: String(overrides.rounds ?? state.options.rounds)
  });

  const mode = overrides.mode ?? null;
  if (mode) {
    searchParams.set("mode", mode);
  }

  if (readerMode) {
    searchParams.set("view", readerMode);
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

function clearPendingDeleteTimer() {
  if (pendingDeleteTimer !== null) {
    window.clearTimeout(pendingDeleteTimer);
    pendingDeleteTimer = null;
  }

  if (pendingDeleteCountdownTimer !== null) {
    window.clearInterval(pendingDeleteCountdownTimer);
    pendingDeleteCountdownTimer = null;
  }
}

function renderDeleteUndoToast() {
  const pending = state.pendingDelete;
  elements.deleteUndoToast.hidden = !pending;

  if (!pending) {
    return;
  }

  const remainingSeconds = Math.max(0, Math.ceil((pending.expiresAt - Date.now()) / 1_000));
  elements.deleteUndoMessage.textContent = `归档会话已从列表移除，剩余 ${remainingSeconds} 秒可撤销。`;
}

function undoPendingSessionDelete() {
  const pending = state.pendingDelete;

  if (!pending) {
    return;
  }

  clearPendingDeleteTimer();
  state.pendingDelete = null;
  state.workspace = pending.previousWorkspace;
  state.selectedKey = pending.previousSelectedKey;
  state.routeSelectedId = pending.previousRouteSelectedId;
  state.mobilePanel = pending.previousMobilePanel;
  state.preserveSelectionOutsideSearch = pending.previousPreserveSelectionOutsideSearch;
  state.detailRequestId += 1;
  state.detailBusy = false;
  resetDetailCache();
  renderAndSyncBrowserUrl("replace");
  setFeedback("已撤销删除。");
  void loadSelectedSessionDetail();
}

function setVisible(element, visible) {
  element.hidden = !visible;
}

function filterSessions(items) {
  const keyword = getSearchKeyword();

  return items.filter((item) =>
    (!state.workspace || getWorkspaceGroupKey(item) === state.workspace) &&
    (!keyword ||
      [item.threadName, item.id, item.relativePath, item.filePath, item.workspace].some((field) =>
        String(field).toLowerCase().includes(keyword)
      ))
  );
}

function renderWorkspaceFilter() {
  const groups = getWorkspaceGroups();
  const selectedGroup = groups.find((group) => group.key === state.workspace) ?? null;
  const optionData = [
    {
      value: "",
      label: "所有工作区",
      title: "显示当前范围内的所有工作区"
    },
    ...groups.map((group) => ({
      value: group.key,
      label: `${group.label} · ${group.sessions.length}`,
      title: group.workspace || "这类会话没有记录工作目录。"
    }))
  ];
  const optionSignature = JSON.stringify(optionData);

  if (elements.workspaceFilter.dataset.optionSignature !== optionSignature) {
    elements.workspaceFilter.replaceChildren(
      ...optionData.map(({ value, label, title }) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        option.title = title;
        return option;
      })
    );
    elements.workspaceFilter.dataset.optionSignature = optionSignature;
  }

  elements.workspaceFilter.value = state.workspace;
  elements.workspaceFilter.title = selectedGroup?.workspace || optionData[0].title;
  elements.workspaceFilter.disabled = state.busy;
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
  const workspaceGroup = getWorkspaceGroups().find((group) => group.key === state.workspace) ?? null;
  const selectedWorkspaceLabel = workspaceGroup ? getWorkspaceDisplayName(workspaceGroup.workspace) : null;

  elements.masterTitle.textContent = selectedWorkspaceLabel
    ? `${meta.title} · ${selectedWorkspaceLabel}`
    : meta.title;

  if (keyword) {
    elements.masterTitle.title = `筛选词 "${keyword}" 命中 ${visibleCount} / ${totalCount} 条记录。`;
    return;
  }

  elements.masterTitle.title = selectedWorkspaceLabel
    ? `当前工作区：${workspaceGroup.workspace || "未记录工作区"}`
    : meta.copy;
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
    card.title = [
      getListTitle(item),
      item.relativePath,
      item.location === "archived_sessions" ? "双击删除（可撤销）" : "双击改名"
    ].join("\n");

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

      if (item.location === "archived_sessions") {
        scheduleSessionDelete(item);
        return;
      }

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
  elements.workspaceFilter.disabled = state.busy;
  elements.renameButton.disabled = state.busy;
  elements.archiveButton.disabled = state.busy || state.detailBusy;
  elements.restoreButton.disabled = state.busy || state.detailBusy;
  elements.deleteButton.disabled = state.busy || state.detailBusy;
  elements.expandToolsButton.disabled = !state.detailSession;
  elements.collapseToolsButton.disabled = !state.detailSession;
  elements.optimizerHandoffButton.disabled = !state.detailSession || state.detailBusy;
  elements.copyAnalysisBriefButton.disabled = !state.detailSession || state.detailBusy || state.localAnalysisBusy;
  elements.runCodexAnalysisButton.disabled =
    !state.detailSession || state.detailBusy || state.localAnalysisBusy || state.agentAnalysisBusy;
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

function getTruncationNote(item) {
  return item?.isTruncated ? item.truncationReason || "日志截断" : "";
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

function getMemorySnapshotBlocks(session) {
  const items = Array.isArray(session?.items) ? session.items : [];

  return items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => isConversationUserMessage(item) && item.snapshotLabel)
    .map(({ item, index }) => {
      const assistant = items.slice(index + 1).find(isAssistantMessage) || null;

      return {
        label: item.snapshotLabel,
        user: item,
        assistant,
        state: assistant ? (isFinalAssistantMessage(assistant) ? "complete" : "pending") : "waiting"
      };
    });
}

function buildMemorySnapshotBlock(block) {
  const wrapper = document.createElement("section");
  wrapper.className = "conversation-block memory-snapshot-block";
  wrapper.dataset.blockState = block.state;
  const timestamp = block.assistant?.timestamp || block.user?.timestamp || "";
  const status = describeConversationStatus(block.state === "waiting" ? null : block.state, true);
  wrapper.innerHTML = `
    <header class="conversation-block-header">
      <div class="conversation-block-meta">
        <p class="conversation-block-title">${escapeHtml(block.label)}</p>
        <p class="conversation-block-summary">用户请求 · ${escapeHtml(block.assistant ? "对应答复" : "尚无答复")}</p>
      </div>
      <div class="conversation-block-side">
        <span class="conversation-status">${escapeHtml(status)}</span>
        ${timestamp ? `<time>${escapeHtml(formatLocalTime(timestamp))}</time>` : ""}
      </div>
    </header>
  `;

  const stack = document.createElement("div");
  stack.className = "conversation-block-stack";
  stack.append(buildTranscriptEntry({ kind: "single", item: block.user }));

  if (block.assistant) {
    const assistantEntry = buildTranscriptEntry({ kind: "single", item: block.assistant });

    if (block.state === "pending") {
      assistantEntry.classList.add("pending-report");
    }

    stack.append(assistantEntry);
  }

  wrapper.append(stack);
  return wrapper;
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

function buildProcessGroup(entries, range = null) {
  const details = document.createElement("details");
  details.className = "process-group";
  applyItemRangeAttributes(details, range);
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
    body.append(buildTranscriptEntry(entry, entry));
  });

  details.append(body);
  return details;
}

function buildConversationBlock(block, session) {
  const blockItems = session.items.slice(block.startIndex, block.endIndex);
  const entries = groupTranscriptItemsWithRanges(blockItems, block.startIndex);
  const visibleUserEntries = entries.filter(isUserMessageEntry);
  const assistantSelection = pickVisibleAssistantEntry(entries);
  const visibleEntries = new Set(visibleUserEntries);

  if (assistantSelection) {
    visibleEntries.add(assistantSelection.entry);
  }

  const displaySegments = splitEntriesIntoDisplaySegments(entries, (entry) => visibleEntries.has(entry));
  const visibleUserCount = visibleUserEntries.length || block.userMessageCount || 0;
  const snapshotLabel =
    session?.selection?.mode === "memory_snapshot"
      ? blockItems.find((item) => item?.snapshotLabel)?.snapshotLabel || "会话选段"
      : null;
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
  applyItemRangeAttributes(wrapper, {
    startIndex: block.startIndex,
    endIndex: block.endIndex
  });
  wrapper.innerHTML = `
    <header class="conversation-block-header">
      <div class="conversation-block-meta">
        <p class="conversation-block-title">${escapeHtml(snapshotLabel || `第 ${block.index} 轮`)}</p>
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
      stack.append(buildTranscriptEntry(entry, entry));
    });
    wrapper.append(stack);
    return wrapper;
  }

  displaySegments.forEach((segment) => {
    if (segment.kind === "visible") {
      const node = buildTranscriptEntry(segment.entry, segment.entry);

      if (assistantSelection?.entry === segment.entry && assistantSelection.state === "pending") {
        node.classList.add("pending-report");
      }

      stack.append(node);
      return;
    }

    if (segment.kind === "process") {
      const range = {
        startIndex: segment.entries[0]?.startIndex ?? block.startIndex,
        endIndex: segment.entries[segment.entries.length - 1]?.endIndex ?? block.endIndex
      };
      stack.append(buildProcessGroup(segment.entries, range));
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

function renderPreformattedBlock(label, value, note = "") {
  return `
    <section class="tool-block">
      <div class="tool-block-head">
        <div class="tool-block-label">${escapeHtml(label)}</div>
        ${note ? `<div class="tool-block-note">${escapeHtml(note)}</div>` : ""}
      </div>
      <pre><code>${escapeHtml(String(value ?? "").trim() || "(empty)")}</code></pre>
    </section>
  `;
}

function buildTranscriptEntry(entry, range = null) {
  if (entry.kind === "tool_interaction") {
    const summaryParts = [summarizeToolCall(entry.call), summarizeToolOutput(entry.output)].filter(Boolean);
    const timestamp = entry.output.timestamp || entry.call.timestamp || "";
    const truncationNote = getTruncationNote(entry.output) || getTruncationNote(entry.call);
    const wrapper = document.createElement("details");
    wrapper.className = "transcript-entry tool-entry";
    applyItemRangeAttributes(wrapper, range);

    wrapper.innerHTML = `
      <summary>
        <div class="entry-summary">
          <span class="entry-badge tool">Tool</span>
          <span class="entry-title">${escapeHtml(entry.call.name || "tool")}</span>
          ${truncationNote ? `<span class="entry-flag truncated">截断</span>` : ""}
          <span class="entry-preview">${escapeHtml(summaryParts.join("  |  "))}</span>
        </div>
        <div class="entry-meta">
          ${timestamp ? `<time>${escapeHtml(formatLocalTime(timestamp))}</time>` : ""}
          <span class="entry-caret">+</span>
        </div>
      </summary>
      <div class="entry-content">
        ${renderPreformattedBlock("Input", entry.call.body, getTruncationNote(entry.call))}
        ${renderPreformattedBlock("Output", entry.output.body, getTruncationNote(entry.output))}
      </div>
    `;

    return wrapper;
  }

  const item = entry.item;

  if (item.kind === "message") {
    const article = document.createElement("article");
    article.className = `transcript-entry message-entry role-${item.role}${item.snapshotExcerpt ? " snapshot-message" : ""}`;
    applyItemRangeAttributes(article, range);
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
      ${
        item.snapshotExcerpt
          ? '<button class="snapshot-message-toggle" type="button" data-snapshot-expand aria-expanded="false">展开完整内容</button>'
          : ""
      }
    `;
    return article;
  }

  if (item.kind === "reasoning") {
    const details = document.createElement("details");
    details.className = "transcript-entry reasoning-entry";
    applyItemRangeAttributes(details, range);
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
    applyItemRangeAttributes(details, range);
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
          ${item.isTruncated ? `<span class="entry-flag truncated">截断</span>` : ""}
          <span class="entry-preview">${escapeHtml(preview || "")}</span>
        </div>
        <div class="entry-meta">
          ${item.timestamp ? `<time>${escapeHtml(formatLocalTime(item.timestamp))}</time>` : ""}
          <span class="entry-caret">+</span>
        </div>
      </summary>
      <div class="entry-content">
        ${renderPreformattedBlock("Body", item.body, getTruncationNote(item))}
      </div>
    `;
    return details;
  }

  const article = document.createElement("article");
  article.className = "transcript-entry";
  applyItemRangeAttributes(article, range);
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
    delete elements.transcriptRoot.dataset.selectionMode;
    elements.transcriptToolbar.hidden = true;
    elements.transcriptStats.textContent = "-";
    clearTaskActivity();
    clearOptimizationAnalysis();
    clearTokenDistribution();
    clearTokenRail();
    return;
  }

  const conversationBlocks = getConversationBlocks(session);
  const entries = groupTranscriptItems(session.items);
  const selection = session.selection || null;
  const isMemorySnapshot = selection?.mode === "memory_snapshot";
  const memorySnapshotBlocks = isMemorySnapshot ? getMemorySnapshotBlocks(session) : [];
  const displayedBlockCount = isMemorySnapshot ? memorySnapshotBlocks.length : conversationBlocks.length;
  const toolCount = entries.filter(
    (entry) => entry.kind === "tool_interaction" || entry.item?.kind?.startsWith("tool")
  ).length;
  const userMessageCount = isMemorySnapshot
    ? Number(selection.displayedUserMessages) || session.items.filter(isConversationUserMessage).length
    : session.items.filter(isConversationUserMessage).length;
  const reportCount = session.items.filter(isFinalAssistantMessage).length;
  const roundSelection = describeRoundSelection(session);
  const totalTokens = isMemorySnapshot ? Number(selection.totalTokens) || 0 : session.tokenStats?.totalTokens || 0;
  const totalTokenLabel = totalTokens > 0 ? `${formatTokenCount(totalTokens)} tok` : null;

  elements.transcriptRoot.dataset.selectionMode = selection?.mode || "";
  elements.transcriptToolbar.dataset.selectionMode = selection?.mode || "";
  elements.expandToolsButton.hidden = isMemorySnapshot;
  elements.collapseToolsButton.hidden = isMemorySnapshot;
  elements.transcriptShortcutHint.hidden = isMemorySnapshot;

  if (isMemorySnapshot) {
    elements.transcriptRoot.append(buildMemorySnapshotNotice(selection));
  }

  if (isMemorySnapshot) {
    memorySnapshotBlocks.forEach((block) => {
      elements.transcriptRoot.append(buildMemorySnapshotBlock(block));
    });
  } else {
    conversationBlocks.forEach((block) => {
      elements.transcriptRoot.append(buildConversationBlock(block, session));
    });
  }

  elements.transcriptToolbar.hidden = false;
  if (isMemorySnapshot) {
    clearTaskActivity();
  } else {
    renderTaskActivity(session);
  }
  renderOptimizationAnalysis(session);
  renderTokenDistribution(session.tokenStats);
  renderTokenRail(session.tokenSegments, session.tokenStats);
  elements.transcriptStats.textContent = [
    isMemorySnapshot ? `显示 ${displayedBlockCount} 段` : `${displayedBlockCount} 轮`,
    isMemorySnapshot && Number(selection.totalUserMessages) > userMessageCount
      ? `${userMessageCount}/${selection.totalUserMessages} 条用户消息`
      : `${userMessageCount} 条用户消息`,
    `${reportCount} 条总结`,
    isMemorySnapshot
      ? Number(selection.totalToolCalls) > 0
        ? `完整会话 ${selection.totalToolCalls} 次工具`
        : null
      : toolCount > 0
      ? `${toolCount} 次工具`
      : null,
    totalTokenLabel,
    roundSelection
  ]
    .filter(Boolean)
    .join(" · ");
  bindTranscriptJumpTargets();
  scheduleTokenRailSync({ rebuildAnchors: true });
  scheduleMemorySnapshotLayout();
}

function showEmptyState(message) {
  clearTranscriptJumpState();
  clearTokenRail();
  delete elements.transcriptRoot.dataset.selectionMode;
  delete elements.transcriptToolbar.dataset.selectionMode;
  elements.expandToolsButton.hidden = false;
  elements.collapseToolsButton.hidden = false;
  elements.transcriptShortcutHint.hidden = false;
  elements.emptyState.querySelector("p").textContent = message;
  elements.viewerCard.classList.remove("has-selection");
  elements.transcriptRoot.replaceChildren();
  resetMemorySnapshotLayout();
  elements.transcriptToolbar.hidden = true;
  elements.transcriptStats.textContent = "-";
  clearTaskActivity();
  clearOptimizationAnalysis();
  clearTokenDistribution();
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
  elements.openPreviewLink.href = `/preview?${buildSessionQuery(session, { mode: "full", readerMode: READER_MODES.all })}`;
  elements.downloadCompactLink.href =
    `/download?${buildSessionQuery(session, { mode: "compact", readerMode: READER_MODES.all })}&format=compact-markdown`;
  elements.downloadFullLink.href =
    `/download?${buildSessionQuery(session, { mode: "full", readerMode: READER_MODES.all })}&format=full-markdown`;

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
  const selectionRemainsInWorkspace = scopeItems.some(
    (item) =>
      sessionKey(item) === state.selectedKey &&
      (!state.workspace || getWorkspaceGroupKey(item) === state.workspace)
  );
  const shouldPreserveSelection =
    state.preserveSelectionOutsideSearch && selectionRemainsInWorkspace;

  if (
    !filteredItems.some((item) => sessionKey(item) === state.selectedKey) &&
    !shouldPreserveSelection
  ) {
    state.selectedKey = filteredItems[0] ? sessionKey(filteredItems[0]) : null;
  }

  if (!state.selectedKey) {
    state.mobilePanel = "master";
  }

  renderScopeControls();
  renderWorkspaceFilter();
  renderSidebarSummary(filteredItems.length, scopeItems.length);
  renderChromeState();
  renderSessionList(filteredItems);
  renderSelection();
  renderDeleteUndoToast();
  syncInlineRenameFocus();
}

async function fetchSessions(options = {}) {
  const preferredKey = options.preferredKey ?? state.selectedKey;
  const preferredId = options.preferredId ?? getSelectedSession()?.id ?? state.routeSelectedId;
  const fallbackKey = options.fallbackKey ?? null;
  const workspaceFallbackKey = options.workspaceFallbackKey ?? getWorkspaceFallback();
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
    const workspaceFallbackSession = resetUnavailableWorkspaceFilter(
      state.scope,
      workspaceFallbackKey
    );
    elements.sessionsRoot.textContent = payload.roots.sessionsDir;
    elements.archivedRoot.textContent = payload.roots.archivedSessionsDir;

    const selection = resolveSessionSelectionAfterRefresh({
      scope: state.scope,
      sessions: getVisibleSessions(state.sessions),
      archivedSessions: getVisibleSessions(state.archivedSessions),
      preferredKey,
      preferredId,
      fallbackKey
    });

    state.selectedKey = selection.selectedKey;
    state.routeSelectedId = selection.routeSelectedId;
    state.preserveSelectionOutsideSearch = false;

    if (workspaceFallbackSession) {
      state.selectedKey = sessionKey(workspaceFallbackSession);
      state.routeSelectedId = workspaceFallbackSession.id;
      state.preserveSelectionOutsideSearch = true;
    }

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

async function loadOptimizationAnalysis(session = getSelectedSession()) {
  if (!session || !state.detailSession || state.localAnalysisBusy) {
    return state.detailSession?.optimizationAnalysis || null;
  }

  const signature = getDetailSignature(session);
  const existing = state.detailSignature === signature ? state.detailSession.optimizationAnalysis : null;

  if (existing) {
    return existing;
  }

  state.localAnalysisBusy = true;
  updateActionState(session);
  setFeedback("正在生成完整会话的优化分析包…");

  try {
    const response = await fetch("/api/session-optimization-analysis", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify({
        location: session.location,
        relativePath: session.relativePath,
        rounds: state.options.rounds,
        view: state.options.readerMode,
        includeContext: state.options.includeContext,
        includeDeveloper: state.options.includeDeveloper,
        includeReasoning: state.options.includeReasoning
      })
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "无法生成优化分析包。");
    }

    if (signature !== getDetailSignature(getSelectedSession() || {}) || !state.detailSession) {
      return null;
    }

    state.detailSession = {
      ...state.detailSession,
      optimizationAnalysis: payload.analysis || null
    };
    renderSelection();
    return state.detailSession.optimizationAnalysis;
  } finally {
    state.localAnalysisBusy = false;
    updateActionState(getSelectedSession());
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

function scheduleSessionDelete(session) {
  if (!session || session.location !== "archived_sessions" || state.busy) {
    return;
  }

  if (state.pendingDelete) {
    setFeedback("已有一项待删除的归档会话；可撤销或等待删除完成。", { error: true });
    return;
  }

  const deletedKey = sessionKey(session);
  const fallbackKey = getNeighborSelectionKey(deletedKey);
  const fallbackSession = findSessionByKey(fallbackKey);
  const workspaceFallbackKey = getWorkspaceFallback();

  state.pendingDelete = {
    session,
    fallbackKey,
    workspaceFallbackKey,
    expiresAt: Date.now() + DELETE_UNDO_TIMEOUT_MS,
    previousWorkspace: state.workspace,
    previousSelectedKey: state.selectedKey,
    previousRouteSelectedId: state.routeSelectedId,
    previousMobilePanel: state.mobilePanel,
    previousPreserveSelectionOutsideSearch: state.preserveSelectionOutsideSearch
  };
  clearPendingDeleteTimer();

  const workspaceFallbackSession = resetUnavailableWorkspaceFilter(
    state.scope,
    workspaceFallbackKey
  );

  if (workspaceFallbackSession) {
    state.detailRequestId += 1;
    state.detailBusy = false;
    state.selectedKey = sessionKey(workspaceFallbackSession);
    state.routeSelectedId = workspaceFallbackSession.id;
    state.mobilePanel = "detail";
    state.preserveSelectionOutsideSearch = true;
    resetDetailCache();
  } else if (state.selectedKey === deletedKey) {
    state.detailRequestId += 1;
    state.detailBusy = false;
    state.selectedKey = fallbackKey;
    state.routeSelectedId = fallbackSession?.id || "";
    state.mobilePanel = fallbackKey ? "detail" : "master";
    state.preserveSelectionOutsideSearch = false;
    resetDetailCache();
  }

  renderAndSyncBrowserUrl("replace");
  void loadSelectedSessionDetail();
  pendingDeleteTimer = window.setTimeout(() => {
    pendingDeleteTimer = null;
    void commitPendingSessionDelete(state.pendingDelete);
  }, DELETE_UNDO_TIMEOUT_MS);
  pendingDeleteCountdownTimer = window.setInterval(() => {
    renderDeleteUndoToast();
  }, 250);
}

async function commitPendingSessionDelete(pending) {
  if (!pending || state.pendingDelete !== pending) {
    return;
  }

  clearPendingDeleteTimer();
  state.pendingDelete = null;
  state.busy = true;
  updateActionState(getSelectedSession());
  renderDeleteUndoToast();
  setFeedback("正在永久删除归档会话…");

  try {
    const response = await fetch("/api/sessions/delete", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify({
        relativePath: pending.session.relativePath
      })
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "删除归档会话失败。");
    }

    const deletedKey = sessionKey(pending.session);
    state.archivedSessions = state.archivedSessions.filter((item) => sessionKey(item) !== deletedKey);
    state.sessions = state.sessions.filter((item) => sessionKey(item) !== deletedKey);
    setFeedback("归档会话已删除。");
    renderAndSyncBrowserUrl("replace");
  } catch (error) {
    state.workspace = pending.previousWorkspace;
    state.selectedKey = pending.previousSelectedKey;
    state.routeSelectedId = pending.previousRouteSelectedId;
    state.mobilePanel = pending.previousMobilePanel;
    state.preserveSelectionOutsideSearch = pending.previousPreserveSelectionOutsideSearch;
    state.detailRequestId += 1;
    state.detailBusy = false;
    resetDetailCache();
    setFeedback(error instanceof Error ? error.message : String(error), {
      error: true
    });
    renderAndSyncBrowserUrl("replace");
    void loadSelectedSessionDetail();
  } finally {
    state.busy = false;
    updateActionState(getSelectedSession());
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
    readerMode: elements.readerMode.value,
    rounds: elements.roundsInput.value,
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
  state.preserveSelectionOutsideSearch = false;
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
    state.preserveSelectionOutsideSearch = false;
    resetUnavailableWorkspaceFilter();
    state.mobilePanel = "master";
    renderAndSyncBrowserUrl("push");
    loadSelectedSessionDetail();
  });
}

elements.workspaceFilter.addEventListener("change", () => {
  state.workspace = elements.workspaceFilter.value;
  state.preserveSelectionOutsideSearch = false;
  state.mobilePanel = "master";
  resetDetailCache();
  renderAndSyncBrowserUrl("push");
  loadSelectedSessionDetail();
});

elements.sidebarToggle.addEventListener("click", () => {
  state.sidebarCollapsed = !state.sidebarCollapsed;
  renderChromeState();
});

elements.readerMode.addEventListener("change", syncOptionsFromControls);
elements.roundsInput.addEventListener("change", syncOptionsFromControls);
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
  const session = getSelectedSession();

  if (session && window.confirm("确定删除这个归档会话吗？你可以在接下来的几秒内撤销。")) {
    scheduleSessionDelete(session);
  }
});

elements.undoDeleteButton.addEventListener("click", undoPendingSessionDelete);

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
  scheduleTokenRailSync({ rebuildAnchors: true });
});

elements.collapseToolsButton.addEventListener("click", () => {
  elements.transcriptRoot.querySelectorAll(".process-group").forEach((node) => {
    node.open = false;
  });
  scheduleTokenRailSync({ rebuildAnchors: true });
});

elements.copyAnalysisBriefButton.addEventListener("click", async () => {
  const session = getSelectedSession();

  if (!session) {
    return;
  }

  try {
    const analysis = await loadOptimizationAnalysis(session);
    const brief = analysis?.agentBrief;

    if (!brief) {
      throw new Error("当前会话没有可复制的优化分析包。");
    }

    await navigator.clipboard.writeText(brief);
    setFeedback("完整分析包已复制；可粘贴到 Codex 请求证据化优化建议。");
  } catch (error) {
    setFeedback(
      error instanceof Error ? error.message : "无法访问剪贴板；请在支持剪贴板权限的浏览器中重试。",
      { error: true }
    );
  }
});

elements.optimizerHandoffButton.addEventListener("click", async () => {
  const session = getSelectedSession();
  if (!session || !state.detailSession) {
    return;
  }
  try {
    const response = await fetch("/api/session-optimizer-handoff", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        location: session.location,
        relativePath: session.relativePath,
        view: state.options.readerMode,
        rounds: state.options.rounds
      })
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "无法生成优化 Skill 交接请求。");
    }
    await navigator.clipboard.writeText(payload.handoff);
    setFeedback("已复制交给优化 Skill 的请求；粘贴到当前 Codex 对话即可开始前台复盘。");
  } catch (error) {
    setFeedback(error instanceof Error ? error.message : String(error), { error: true });
  }
});

elements.runCodexAnalysisButton.addEventListener("click", async () => {
  const session = getSelectedSession();

  if (!session || !state.detailSession || state.agentAnalysisBusy) {
    return;
  }

  const signature = getDetailSignature(session);

  const confirmed = window.confirm(
    "将在该会话记录的工作目录启动一次只读、临时的 Codex 分析。它不会自动修改文件，最长可能运行 5 分钟。继续吗？"
  );

  if (!confirmed) {
    return;
  }

  try {
    await loadOptimizationAnalysis(session);
  } catch (error) {
    setFeedback(error instanceof Error ? error.message : String(error), { error: true });
    return;
  }

  if (signature !== getDetailSignature(getSelectedSession() || {})) {
    return;
  }

  state.agentAnalysisBusy = true;
  updateActionState(session);
  elements.runCodexAnalysisButton.disabled = true;
  setFeedback("Codex 正在分析当前会话的执行轨迹…");

  try {
    const response = await fetch("/api/session-analysis", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify({
        location: session.location,
        relativePath: session.relativePath,
        rounds: state.options.rounds,
        view: state.options.readerMode,
        includeContext: state.options.includeContext,
        includeDeveloper: state.options.includeDeveloper,
        includeReasoning: state.options.includeReasoning
      })
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Codex 分析失败。");
    }

    if (signature === getDetailSignature(getSelectedSession() || {})) {
      state.agentAnalysisResult = {
        signature,
        text: payload.result || "Codex 未返回可展示的分析结果。"
      };
      setFeedback("Codex 分析完成；结果已显示在优化分析卡片中。");
      renderSelection();
    }
  } catch (error) {
    setFeedback(error instanceof Error ? error.message : String(error), { error: true });
  } finally {
    state.agentAnalysisBusy = false;
    updateActionState(getSelectedSession());
  }
});

elements.taskActivityCard.addEventListener("click", (event) => {
  const target = event.target.closest("[data-task-activity-index]");

  if (!(target instanceof HTMLElement)) {
    return;
  }

  const itemIndex = Number(target.dataset.taskActivityIndex);
  if (Number.isInteger(itemIndex)) {
    jumpToTranscriptItem(itemIndex);
  }
});

elements.transcriptRoot.addEventListener("click", (event) => {
  const toggle = event.target.closest("[data-snapshot-expand]");

  if (!(toggle instanceof HTMLButtonElement)) {
    return;
  }

  const entry = toggle.closest(".snapshot-message");

  if (!entry) {
    return;
  }

  const expanded = entry.classList.toggle("is-expanded");
  toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
  toggle.textContent = expanded ? "收起内容" : "展开完整内容";
  scheduleTokenRailSync({ rebuildAnchors: true });
  scheduleMemorySnapshotLayout();
});

elements.optimizationAnalysisCard.addEventListener("click", (event) => {
  const target = event.target.closest("[data-task-activity-index]");

  if (!(target instanceof HTMLElement)) {
    return;
  }

  const itemIndex = Number(target.dataset.taskActivityIndex);
  if (Number.isInteger(itemIndex)) {
    jumpToTranscriptItem(itemIndex);
  }
});

elements.chatPane.addEventListener("scroll", () => {
  scheduleTokenRailSync();
});

elements.transcriptRoot.addEventListener(
  "toggle",
  () => {
    scheduleTokenRailSync({ rebuildAnchors: true });
  },
  true
);

window.addEventListener("resize", () => {
  scheduleTokenRailSync({ rebuildAnchors: true });
  scheduleMemorySnapshotLayout();
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

renderChromeState();
initializeRouteState();
fetchSessions({
  preferredKey: state.selectedKey,
  historyMode: "replace"
});
fetchCampaigns();
setInterval(() => {
  fetchCampaigns();
}, 3_000);
