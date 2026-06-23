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
  renamingKey: null,
  renamingValue: "",
  renameFocusPending: false,
  scope: "active",
  mobilePanel: "master",
  sidebarCollapsed: false,
  options: {
    rounds: 1,
    all: true,
    includeContext: false,
    includeDeveloper: false,
    includeReasoning: false
  },
  busy: false,
  detailBusy: false,
  detailRequestId: 0,
  detailSignature: null,
  detailSession: null
};

const elements = {
  workspace: document.querySelector(".workspace"),
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

function sessionKey(item) {
  return `${item.location}:${item.relativePath}`;
}

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

function getSearchKeyword() {
  return elements.searchInput.value.trim().toLowerCase();
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
  return "（缺少 thread_name）";
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

function getNeighborSelectionKey(currentKey) {
  const items = getFilteredScopeItems();
  const currentIndex = items.findIndex((item) => sessionKey(item) === currentKey);

  if (currentIndex === -1) {
    return null;
  }

  const neighbor = items[currentIndex + 1] || items[currentIndex - 1] || null;
  return neighbor ? sessionKey(neighbor) : null;
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
      state.selectedKey = sessionKey(item);
      state.mobilePanel = "detail";
      render();
      loadSelectedSessionDetail();
    });

    card.addEventListener("keydown", (event) => {
      if (isRenamingSession(item)) {
        return;
      }

      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        state.selectedKey = sessionKey(item);
        state.mobilePanel = "detail";
        render();
        loadSelectedSessionDetail();
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

function groupTranscriptItems(items) {
  const entries = [];
  const consumedIndexes = new Set();

  for (let index = 0; index < items.length; index += 1) {
    if (consumedIndexes.has(index)) {
      continue;
    }

    const item = items[index];

    if (item.kind === "tool_call" && item.callId) {
      const outputIndex = items.findIndex(
        (candidate, candidateIndex) =>
          candidateIndex > index &&
          !consumedIndexes.has(candidateIndex) &&
          candidate.kind === "tool_output" &&
          candidate.callId === item.callId
      );

      if (outputIndex !== -1) {
        consumedIndexes.add(outputIndex);
        entries.push({
          kind: "tool_interaction",
          call: item,
          output: items[outputIndex]
        });
        continue;
      }
    }

    entries.push({
      kind: "single",
      item
    });
  }

  return entries;
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
    article.innerHTML = `
      <header class="entry-header">
        <div class="entry-summary">
          <span class="entry-badge ${escapeHtml(item.role)}">${escapeHtml(roleLabel(item.role))}</span>
        </div>
        ${item.timestamp ? `<time>${escapeHtml(formatLocalTime(item.timestamp))}</time>` : ""}
      </header>
      <div class="entry-content rich-text">${renderRichText(item.text, item.renderedHtml)}</div>
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
      <div class="entry-content rich-text">${renderRichText(item.text, item.renderedHtml)}</div>
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

  const entries = groupTranscriptItems(session.items);
  const toolCount = entries.filter((entry) => entry.kind === "tool_interaction" || entry.item?.kind?.startsWith("tool")).length;
  const messageCount = session.items.filter((item) => item.kind === "message").length;
  const roundSelection = describeRoundSelection(session);

  for (const entry of entries) {
    elements.transcriptRoot.append(buildTranscriptEntry(entry));
  }

  elements.transcriptToolbar.hidden = false;
  elements.transcriptStats.textContent = [
    `${entries.length} entries`,
    `${messageCount} messages`,
    `${toolCount} tools`,
    roundSelection
  ]
    .filter(Boolean)
    .join(" · ");
}

function showEmptyState(message) {
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
  const fallbackKey = options.fallbackKey ?? null;

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

    const availableKeys = new Set(getAllSessions().map((item) => sessionKey(item)));
    const scopedKeys = new Set(getScopeItems(state.scope).map((item) => sessionKey(item)));

    if (preferredKey && (state.scope === "all" ? availableKeys.has(preferredKey) : scopedKeys.has(preferredKey))) {
      state.selectedKey = preferredKey;
    } else if (fallbackKey && (state.scope === "all" ? availableKeys.has(fallbackKey) : scopedKeys.has(fallbackKey))) {
      state.selectedKey = fallbackKey;
    } else {
      const scopedItems = getScopeItems(state.scope);
      state.selectedKey = scopedItems[0] ? sessionKey(scopedItems[0]) : null;
    }

    state.detailSignature = null;
    state.detailSession = null;
    setFeedback("会话列表已更新。");
    render();
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
  render();
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
  state.options.rounds = Math.max(1, Number.parseInt(elements.roundsInput.value || "1", 10) || 1);
  state.options.all = elements.allRoundsToggle.checked;
  state.options.includeContext = elements.includeContextToggle.checked;
  state.options.includeDeveloper = elements.includeDeveloperToggle.checked;
  state.options.includeReasoning = elements.includeReasoningToggle.checked;
  elements.roundsInput.disabled = state.options.all;
  state.detailSignature = null;
  state.detailSession = null;
  renderSelection();
  loadSelectedSessionDetail();
}

elements.searchInput.addEventListener("input", () => {
  render();
});

elements.refreshButton.addEventListener("click", () => {
  fetchSessions();
});

for (const button of elements.scopeButtons) {
  button.addEventListener("click", () => {
    state.scope = button.dataset.scope ?? "all";
    state.mobilePanel = "master";
    render();
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

elements.expandToolsButton.addEventListener("click", () => {
  elements.transcriptRoot.querySelectorAll(".tool-entry").forEach((node) => {
    node.open = true;
  });
});

elements.collapseToolsButton.addEventListener("click", () => {
  elements.transcriptRoot.querySelectorAll(".tool-entry").forEach((node) => {
    node.open = false;
  });
});

state.sidebarCollapsed = loadSidebarPreference();
renderChromeState();
syncOptionsFromControls();
fetchSessions();
