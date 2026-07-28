import { getSessionRecord, SESSION_LOCATIONS } from "./session-store.js";
import { splitConversationRounds } from "./conversation-rounds.js";
import { loadSession, selectRecentRounds } from "./session-parser.js";
import { sessionToMarkdown } from "./markdown.js";
import { renderMarkdownDocument } from "../render/html.js";
import { renderMarkdownFragment } from "../render/fragment.js";
import {
  collapsePairedSkillMessages,
  formatMessageTextForPresentation,
  parseSkillMessagePresentation
} from "../shared/message-presentation.js";

const TOKEN_BEHAVIOR_META = [
  { key: "user", label: "User", color: "#0f766e" },
  { key: "assistant", label: "Assistant", color: "#2563eb" },
  { key: "tool", label: "Tool", color: "#d97706" },
  { key: "reasoning", label: "Reasoning", color: "#e11d48" },
  { key: "developer", label: "Developer", color: "#6b7280" },
  { key: "context", label: "Context", color: "#059669" },
  { key: "hidden", label: "Unattributed", color: "#64748b" },
  { key: "other", label: "Other", color: "#9ca3af" }
];

const TOOL_COLORS = [
  "#d97706",
  "#2563eb",
  "#0f766e",
  "#7c3aed",
  "#dc2626",
  "#059669",
  "#0ea5e9",
  "#db2777"
];

function parseBoolean(value) {
  return value === "1" || value === "true";
}

function parsePositiveInteger(value, fallbackValue) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackValue;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("'", "&#39;");
}

function renderImageBlockHtml(block) {
  const detailLabel = block.detail ? ` · ${escapeHtml(block.detail)}` : "";

  return `
    <figure class="message-media message-image-card">
      <div class="message-image-frame">
        <img src="${escapeAttribute(block.imageUrl)}" alt="Attached image" loading="lazy">
      </div>
      <figcaption>Attached image${detailLabel}</figcaption>
    </figure>
  `;
}

function renderSkillBlockHtml(skill) {
  const title = skill.name ? escapeHtml(skill.name) : "Skill";
  const metaParts = [];

  if (skill.path) {
    metaParts.push(`
      <div class="message-skill-meta">
        <div class="message-skill-label">Path</div>
        <div class="message-skill-value"><code>${escapeHtml(skill.path)}</code></div>
      </div>
    `);
  }

  if (skill.description) {
    metaParts.push(`
      <div class="message-skill-meta">
        <div class="message-skill-label">Description</div>
        <div class="message-skill-value">${escapeHtml(skill.description)}</div>
      </div>
    `);
  }

  const body = skill.body
    ? `
      <section class="message-skill-section">
        <div class="message-skill-label">Content</div>
        <pre><code>${escapeHtml(skill.body)}</code></pre>
      </section>
    `
    : "";

  return `
    <details class="message-media message-skill-card">
      <summary>
        <div class="message-skill-header">
          <span class="message-skill-badge">Skill</span>
          <div class="message-skill-title">${title}</div>
        </div>
        <span class="message-skill-caret">+</span>
      </summary>
      <div class="message-skill-panel">
        ${metaParts.length > 0 ? `<div class="message-skill-meta-list">${metaParts.join("")}</div>` : ""}
        ${body}
      </div>
    </details>
  `;
}

function renderMessageContent(item) {
  const role = item.role || "unknown";
  const contentBlocks = Array.isArray(item.contentBlocks) ? item.contentBlocks : [];
  const skillPresentation = parseSkillMessagePresentation(item.text);
  const canRenderSkillCard =
    skillPresentation &&
    (contentBlocks.length === 0 || contentBlocks.every((block) => block.kind === "text"));

  if (canRenderSkillCard) {
    const displayText = formatMessageTextForPresentation(item.text, role);

    return {
      displayText,
      renderedHtml: renderSkillBlockHtml(skillPresentation)
    };
  }

  if (contentBlocks.length === 0) {
    const displayText = formatMessageTextForPresentation(item.text, role);

    return {
      displayText,
      renderedHtml: renderMarkdownFragment(displayText)
    };
  }

  const textParts = [];
  const htmlParts = [];

  for (const block of contentBlocks) {
    if (block.kind === "text") {
      textParts.push(block.text);
      htmlParts.push(renderMarkdownFragment(formatMessageTextForPresentation(block.text, role)));
      continue;
    }

    if (block.kind === "image") {
      htmlParts.push(renderImageBlockHtml(block));
      continue;
    }

    if (block.kind === "json") {
      textParts.push(block.raw);
      htmlParts.push(`<pre><code>${escapeHtml(block.raw)}</code></pre>`);
    }
  }

  const displayText = formatMessageTextForPresentation(textParts.join("\n\n").trim(), role);

  return {
    displayText,
    renderedHtml: htmlParts.join("")
  };
}

function estimateTokenWeight(text) {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim();

  if (!normalized) {
    return 1;
  }

  return Math.max(1, Math.ceil(normalized.length / 4));
}

function firstNonEmptyLine(text) {
  return String(text ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean) || "";
}

function truncateTokenText(value, maxLength = 80) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function getToolName(entry) {
  if (!entry) {
    return "tool";
  }

  if (entry.kind === "tool_interaction") {
    return entry.call?.name || entry.output?.name || "tool";
  }

  const item = entry.item ?? entry;

  if (!item || typeof item !== "object") {
    return "tool";
  }

  return item.name || item.eventType || "tool";
}

function getToolPreview(entry) {
  if (!entry) {
    return {
      preview: "No data",
      callPreview: "No input",
      outputPreview: "No output"
    };
  }

  if (entry.kind === "tool_interaction") {
    const callPreview = truncateTokenText(firstNonEmptyLine(entry.call?.body), 80) || "No input";
    const outputPreview = truncateTokenText(firstNonEmptyLine(entry.output?.body), 80) || "No output";

    return {
      preview: [callPreview, outputPreview].filter(Boolean).join(" · "),
      callPreview,
      outputPreview
    };
  }

  const item = entry.item ?? entry;
  const body = item?.body ?? item?.text ?? "";
  const preview = truncateTokenText(firstNonEmptyLine(body), 80) || "No data";

  return {
    preview,
    callPreview: item?.kind === "tool_output" ? "No input" : preview,
    outputPreview: item?.kind === "tool_call" ? "No output" : preview
  };
}

function getEntryTruncationInfo(entry) {
  if (!entry) {
    return {
      isTruncated: false,
      truncationReason: null
    };
  }

  if (entry.kind === "tool_interaction") {
    return {
      isTruncated: Boolean(entry.call?.isTruncated || entry.output?.isTruncated),
      truncationReason: entry.output?.truncationReason || entry.call?.truncationReason || null
    };
  }

  const item = entry.item ?? entry;

  return {
    isTruncated: Boolean(item?.isTruncated),
    truncationReason: item?.truncationReason || null
  };
}

function groupTokenSnapshotItems(items) {
  const sourceItems = Array.isArray(items) ? items : [];
  const entries = [];

  for (let index = 0; index < sourceItems.length; index += 1) {
    const item = sourceItems[index];
    const nextItem = sourceItems[index + 1];

    if (
      item?.kind === "tool_call" &&
      item.callId &&
      nextItem?.kind === "tool_output" &&
      nextItem.callId === item.callId
    ) {
      entries.push({
        kind: "tool_interaction",
        call: item,
        output: nextItem
      });
      index += 1;
      continue;
    }

    entries.push({
      kind: "single",
      item
    });
  }

  return entries;
}

function getTokenBehaviorKey(entry) {
  if (!entry) {
    return "other";
  }

  if (entry.kind === "tool_interaction") {
    return "tool";
  }

  const item = entry.item ?? entry;

  if (!item || typeof item !== "object") {
    return "other";
  }

  if (item.kind === "reasoning") {
    return "reasoning";
  }

  if (item.kind === "tool_call" || item.kind === "tool_output" || item.kind === "tool_event") {
    return "tool";
  }

  if (item.kind !== "message") {
    return "other";
  }

  if (item.role === "developer") {
    return "developer";
  }

  if (item.role === "assistant") {
    return "assistant";
  }

  if (item.role === "user" && item.isContextPrelude) {
    return "context";
  }

  if (item.role === "user") {
    return "user";
  }

  return "other";
}

function estimateTranscriptEntryWeight(entry) {
  if (!entry) {
    return 0;
  }

  if (entry.kind === "tool_interaction") {
    return estimateTokenWeight(entry.call?.body) + estimateTokenWeight(entry.output?.body);
  }

  const item = entry.item ?? entry;

  if (!item || typeof item !== "object") {
    return 0;
  }

  if (item.kind === "message") {
    return estimateTokenWeight(item.text);
  }

  if (item.kind === "reasoning") {
    return estimateTokenWeight(item.text);
  }

  if (item.kind === "tool_call" || item.kind === "tool_output" || item.kind === "tool_event") {
    return estimateTokenWeight(item.body);
  }

  return estimateTokenWeight(item.text || item.body || "");
}

function buildTokenStats(tokenSnapshots) {
  const sourceSnapshots = Array.isArray(tokenSnapshots) ? tokenSnapshots : [];
  const totalsByKey = new Map(TOKEN_BEHAVIOR_META.map(({ key }) => [key, 0]));
  const toolGroupsByKey = new Map();
  const toolGroupsInOrder = [];
  let totalTokens = 0;
  let knownTokens = 0;
  let hiddenTokens = 0;
  let toolTokens = 0;
  let toolInstanceCount = 0;
  let explicitTruncationCount = 0;
  const unattributedStats = {
    totalCount: 0,
    webSearchCount: 0,
    truncatedCount: 0,
    noVisibleDataCount: 0,
    residualCount: 0
  };

  for (const snapshot of sourceSnapshots) {
    const snapshotTokens = Number(snapshot?.tokens ?? snapshot?.totalTokens ?? 0);

    if (!Number.isFinite(snapshotTokens) || snapshotTokens <= 0) {
      continue;
    }

    totalTokens += snapshotTokens;
    const entries = groupTokenSnapshotItems(snapshot.items);
    const hasWebSearch = entries.some((entry) => getToolName(entry) === "web_search");
    const hasExplicitTruncation = entries.some((entry) => getEntryTruncationInfo(entry).isTruncated);
    const weightedEntries = entries
      .map((entry) => {
        const key = getTokenBehaviorKey(entry);
        const toolName = key === "tool" ? getToolName(entry) : null;

        return {
          entry,
          key,
          toolName,
          weight: estimateTranscriptEntryWeight(entry)
        };
      })
      .filter((entry) => entry.weight > 0);
    const totalWeight = weightedEntries.reduce((sum, entry) => sum + entry.weight, 0);

    if (totalWeight <= 0) {
      hiddenTokens += snapshotTokens;
      totalsByKey.set("hidden", (totalsByKey.get("hidden") ?? 0) + snapshotTokens);
      unattributedStats.totalCount += 1;
      unattributedStats.noVisibleDataCount += 1;

      if (hasWebSearch) {
        unattributedStats.webSearchCount += 1;
      }

      if (hasExplicitTruncation) {
        unattributedStats.truncatedCount += 1;
      }

      continue;
    }

    const allocatedKnownTokens = Math.min(snapshotTokens, totalWeight);
    const residualHiddenTokens = snapshotTokens - allocatedKnownTokens;

    knownTokens += allocatedKnownTokens;

    if (residualHiddenTokens > 0) {
      hiddenTokens += residualHiddenTokens;
      totalsByKey.set("hidden", (totalsByKey.get("hidden") ?? 0) + residualHiddenTokens);
      unattributedStats.totalCount += 1;

      if (hasWebSearch) {
        unattributedStats.webSearchCount += 1;
      }

      if (hasExplicitTruncation) {
        unattributedStats.truncatedCount += 1;
      }

      if (!hasWebSearch && !hasExplicitTruncation) {
        unattributedStats.residualCount += 1;
      }
    }

    for (const entry of weightedEntries) {
      const allocatedTokens = allocatedKnownTokens * (entry.weight / totalWeight);
      totalsByKey.set(entry.key, (totalsByKey.get(entry.key) ?? 0) + allocatedTokens);

      if (entry.key !== "tool") {
        continue;
      }

      toolTokens += allocatedTokens;
      toolInstanceCount += 1;

      let group = toolGroupsByKey.get(entry.toolName);

      if (!group) {
        group = {
          key: entry.toolName,
          label: entry.toolName,
          color: TOOL_COLORS[toolGroupsInOrder.length % TOOL_COLORS.length],
          tokens: 0,
          count: 0,
          instances: [],
          order: toolGroupsInOrder.length
        };
        toolGroupsByKey.set(entry.toolName, group);
        toolGroupsInOrder.push(group);
      }

      group.tokens += allocatedTokens;
      group.count += 1;

      const preview = getToolPreview(entry.entry);
      const truncation = getEntryTruncationInfo(entry.entry);

      group.instances.push({
        index: group.instances.length + 1,
        kind: entry.entry.kind,
        name: entry.toolName,
        timestamp: entry.entry.kind === "tool_interaction"
          ? entry.entry.output?.timestamp || entry.entry.call?.timestamp || null
          : entry.entry.item?.timestamp ?? entry.entry.timestamp ?? null,
        callId: entry.entry.kind === "tool_interaction"
          ? entry.entry.call?.callId || null
          : entry.entry.item?.callId || null,
        tokens: allocatedTokens,
        isTruncated: truncation.isTruncated,
        truncationReason: truncation.truncationReason,
        preview: preview.preview,
        callPreview: preview.callPreview,
        outputPreview: preview.outputPreview,
        source: entry.entry.kind === "tool_interaction"
          ? {
              call: {
                body: entry.entry.call?.body || "",
                data: entry.entry.call?.data ?? null,
                language: entry.entry.call?.language || "text",
                name: entry.entry.call?.name || entry.toolName
              },
              output: {
                body: entry.entry.output?.body || "",
                data: entry.entry.output?.data ?? null,
                language: entry.entry.output?.language || "text",
                name: entry.entry.output?.name || entry.toolName
              }
            }
          : {
              item: {
                body: entry.entry.item?.body || entry.entry.body || "",
                data: entry.entry.item?.data ?? entry.entry.data ?? null,
                kind: entry.entry.item?.kind || entry.entry.kind || "tool_event",
                language: entry.entry.item?.language || entry.entry.language || "text",
                name: entry.toolName
              }
            }
      });

      if (truncation.isTruncated) {
        explicitTruncationCount += 1;
      }
    }
  }

  if (totalTokens <= 0) {
    return null;
  }

  const categories = TOKEN_BEHAVIOR_META.map((meta) => ({
    ...meta,
    tokens: totalsByKey.get(meta.key) ?? 0
  })).filter((entry) => entry.tokens > 0.01);

  const totalToolTokens = toolGroupsInOrder.reduce((sum, group) => sum + group.tokens, 0);
  const toolGroups = toolGroupsInOrder
    .map((group) => ({
      ...group,
      shareOfOverall: totalTokens > 0 ? group.tokens / totalTokens : 0,
      shareOfToolTotal: totalToolTokens > 0 ? group.tokens / totalToolTokens : 0,
      truncatedCount: group.instances.filter((instance) => instance.isTruncated).length,
      instances: group.instances.map((instance) => ({
        ...instance,
        shareOfOverall: totalTokens > 0 ? instance.tokens / totalTokens : 0,
        shareOfToolTotal: group.tokens > 0 ? instance.tokens / group.tokens : 0
      }))
    }))
    .sort((left, right) => right.tokens - left.tokens);

  return {
    totalTokens,
    knownTokens,
    hiddenTokens,
    explicitTruncationCount,
    unattributedStats,
    categories,
    toolStats: totalToolTokens > 0
      ? {
          totalTokens: totalToolTokens,
          totalCount: toolInstanceCount,
          truncatedCount: explicitTruncationCount,
          groups: toolGroups,
          shareOfOverall: totalTokens > 0 ? totalToolTokens / totalTokens : 0
        }
      : {
          totalTokens: 0,
          totalCount: 0,
          truncatedCount: 0,
          groups: [],
          shareOfOverall: 0
        }
  };
}

function buildTokenSegments(tokenSnapshots) {
  const sourceSnapshots = Array.isArray(tokenSnapshots) ? tokenSnapshots : [];
  const segments = [];
  let totalTokens = 0;

  for (const snapshot of sourceSnapshots) {
    const snapshotTokens = Number(snapshot?.tokens ?? snapshot?.totalTokens ?? 0);

    if (!Number.isFinite(snapshotTokens) || snapshotTokens <= 0) {
      continue;
    }

    totalTokens += snapshotTokens;
    segments.push({
      index: segments.length + 1,
      startIndex: Number(snapshot?.startIndex) || 0,
      endIndex: Number(snapshot?.endIndex) || 0,
      tokens: snapshotTokens,
      cumulativeTokens: Number(snapshot?.cumulativeTokens) || snapshotTokens,
      inputTokens: Number(snapshot?.inputTokens) || 0,
      cachedInputTokens: Number(snapshot?.cachedInputTokens) || 0,
      outputTokens: Number(snapshot?.outputTokens) || 0,
      reasoningOutputTokens: Number(snapshot?.reasoningOutputTokens) || 0
    });
  }

  if (totalTokens <= 0) {
    return [];
  }

  return segments.map((segment) => ({
    ...segment,
    shareOfOverall: segment.tokens / totalTokens
  }));
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
    titleSuffix,
    includeBrowserClientLifecycleTracking: true
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
  const { tokenSnapshots: _tokenSnapshots, ...sessionWithoutSnapshots } = session;
  const sourceItems = collapsePairedSkillMessages(sessionWithoutSnapshots.items);
  const tokenStats = buildTokenStats(_tokenSnapshots);
  const tokenSegments = buildTokenSegments(_tokenSnapshots);
  const items = sourceItems.map((item) => {
    if (item.kind === "message") {
      const rendered = renderMessageContent(item);

      return {
        ...item,
        displayText: rendered.displayText,
        renderedHtml: rendered.renderedHtml
      };
    }

    if (item.kind === "reasoning") {
      return {
        ...item,
        displayText: item.text,
        renderedHtml: renderMarkdownFragment(item.text)
      };
    }

    return item;
  });

  return {
    ...sessionWithoutSnapshots,
    tokenStats,
    tokenSegments,
    items,
    conversationBlocks: splitConversationRounds(items).map((block) => ({
      index: block.index,
      total: block.total,
      startIndex: block.startIndex,
      endIndex: block.endIndex,
      hasFinalAnswer: block.hasFinalAnswer,
      userMessageCount: block.userMessageCount
    }))
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
