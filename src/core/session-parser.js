import { open, readFile, stat } from "node:fs/promises";
import { extractSessionId } from "./session-store.js";
import { countConversationRounds, splitConversationRounds } from "./conversation-rounds.js";

const ANSI_PATTERN = /[\u001b\u009b][[\]()#;?]*(?:(?:\d{1,4}(?:;\d{0,4})*)?[0-9A-ORZcf-nqry=><~]|.)/gu;
const SNAPSHOT_READ_CHUNK_BYTES = 64 * 1024;
const USER_TRANSCRIPT_CONTROL_MESSAGE_PATTERN = /^<\/?(?:turn_aborted|user_turn_aborted)>/iu;

function parseJsonLines(source) {
  return source
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function normalizeText(value) {
  return String(value ?? "")
    .replace(ANSI_PATTERN, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
}

function looksLikeContextPrelude(text) {
  return (
    text.includes("# AGENTS.md instructions") ||
    text.includes("<environment_context>") ||
    text.includes("<permissions instructions>") ||
    text.includes("<collaboration_mode>")
  );
}

function imageAttachmentPlaceholder(detail) {
  return detail ? `[Image attachment: ${detail}]` : "[Image attachment]";
}

const STANDALONE_TEXT_PROTOCOL_MARKERS = new Set(["<proposed_plan>", "</proposed_plan>"]);

function isStandaloneImageMarker(block, marker) {
  return block?.kind === "text" && block.text === marker;
}

function stripStandaloneTextProtocolMarkerLines(text) {
  const lines = String(text ?? "").split("\n");
  const hasRenderableContent = lines.some((line) => {
    const trimmed = line.trim();
    return trimmed !== "" && !STANDALONE_TEXT_PROTOCOL_MARKERS.has(trimmed);
  });

  if (!hasRenderableContent) {
    return String(text ?? "").trim();
  }

  const filteredLines = lines.filter((line) => !STANDALONE_TEXT_PROTOCOL_MARKERS.has(line.trim()));

  return filteredLines.join("\n").trim();
}

function stripWrappedImageMarkers(contentBlocks) {
  return contentBlocks.filter((block, index, blocks) => {
    if (isStandaloneImageMarker(block, "<image>")) {
      return blocks[index + 1]?.kind !== "image";
    }

    if (isStandaloneImageMarker(block, "</image>")) {
      return blocks[index - 1]?.kind !== "image";
    }

    return true;
  });
}

function isStandaloneTextProtocolMarker(block, marker) {
  return block?.kind === "text" && block.blockType === "output_text" && block.text === marker;
}

function stripWrappedTextProtocolMarkers(contentBlocks) {
  const removableIndexes = new Set();
  let openIndex = null;

  for (let index = 0; index < contentBlocks.length; index += 1) {
    const block = contentBlocks[index];

    if (isStandaloneTextProtocolMarker(block, "<proposed_plan>")) {
      if (openIndex === null) {
        openIndex = index;
      }
      continue;
    }

    if (isStandaloneTextProtocolMarker(block, "</proposed_plan>")) {
      if (openIndex !== null) {
        const hasWrappedContent = contentBlocks
          .slice(openIndex + 1, index)
          .some((candidate) => !(candidate.kind === "text" && STANDALONE_TEXT_PROTOCOL_MARKERS.has(candidate.text)));

        if (hasWrappedContent) {
          removableIndexes.add(openIndex);
          removableIndexes.add(index);
        }
      }

      openIndex = null;
    }
  }

  return contentBlocks.filter((_, index) => !removableIndexes.has(index));
}

function normalizeMessageContentBlock(block) {
  if (!block || typeof block !== "object") {
    return null;
  }

  if ((block.type === "input_text" || block.type === "output_text") && typeof block.text === "string") {
    const normalizedText = normalizeText(block.text);
    const text =
      block.type === "output_text"
        ? stripStandaloneTextProtocolMarkerLines(normalizedText)
        : normalizedText;

    return text
      ? {
          kind: "text",
          blockType: block.type,
          text
        }
      : null;
  }

  if (block.type === "input_image" && typeof block.image_url === "string") {
    const imageUrl = String(block.image_url).trim();
    const detail = typeof block.detail === "string" && block.detail.trim() ? block.detail.trim() : null;

    if (!imageUrl) {
      return null;
    }

    return {
      kind: "image",
      blockType: block.type,
      imageUrl,
      detail
    };
  }

  const raw = normalizeText(JSON.stringify(block, null, 2));

  return raw
    ? {
        kind: "json",
        blockType: typeof block.type === "string" ? block.type : "unknown",
        raw
      }
    : null;
}

function parseMessageBlocks(content) {
  const contentBlocks = stripWrappedTextProtocolMarkers(
    stripWrappedImageMarkers(
      (Array.isArray(content) ? content : [])
      .map(normalizeMessageContentBlock)
      .filter(Boolean)
    )
  );
  const text = contentBlocks
    .map((block) => {
      if (block.kind === "text") {
        return block.text;
      }

      if (block.kind === "image") {
        return imageAttachmentPlaceholder(block.detail);
      }

      return block.raw;
    })
    .filter(Boolean)
    .join("\n\n");

  return {
    text,
    contentBlocks
  };
}

function parsePossibleJson(value) {
  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function safeJson(value) {
  return JSON.stringify(value, null, 2);
}

function detectToolTextTruncation(value) {
  const text = normalizeText(value);

  if (!text) {
    return {
      isTruncated: false,
      truncationReason: null
    };
  }

  if (
    /warning:\s*truncated output/iu.test(text) ||
    /\b\d+\s+tokens truncated\b/iu.test(text) ||
    /\b\d+\s+bytes omitted\b/iu.test(text) ||
    /\btotal output lines:\s*\d+\b/iu.test(text)
  ) {
    return {
      isTruncated: true,
      truncationReason: "日志截断"
    };
  }

  return {
    isTruncated: false,
    truncationReason: null
  };
}

function parseTokenUsageInfo(info) {
  const lastTokenUsage = info?.last_token_usage ?? {};
  const totalTokenUsage = info?.total_token_usage ?? {};
  const totalTokens = Number(lastTokenUsage.total_tokens);
  const cumulativeTokens = Number(totalTokenUsage.total_tokens);

  if (!Number.isFinite(totalTokens) || totalTokens <= 0) {
    return null;
  }

  return {
    totalTokens,
    cumulativeTokens: Number.isFinite(cumulativeTokens) ? cumulativeTokens : totalTokens,
    inputTokens: Number(lastTokenUsage.input_tokens) || 0,
    cachedInputTokens: Number(lastTokenUsage.cached_input_tokens) || 0,
    outputTokens: Number(lastTokenUsage.output_tokens) || 0,
    reasoningOutputTokens: Number(lastTokenUsage.reasoning_output_tokens) || 0
  };
}

function buildToolCall(payload, timestamp) {
  if (payload.type === "function_call") {
    const parsedArguments = parsePossibleJson(payload.arguments);
    return {
      kind: "tool_call",
      timestamp,
      toolType: "function_call",
      name: payload.name || "unknown_tool",
      callId: payload.call_id || null,
      body: safeJson(parsedArguments),
      data: parsedArguments,
      language: "json"
    };
  }

  if (payload.type === "custom_tool_call") {
    return {
      kind: "tool_call",
      timestamp,
      toolType: "custom_tool_call",
      name: payload.name || "custom_tool",
      callId: payload.call_id || null,
      body: normalizeText(payload.input),
      data: payload.input,
      language: "text"
    };
  }

  if (payload.type === "web_search_call") {
    const parsedAction = payload.action || payload;
    return {
      kind: "tool_call",
      timestamp,
      toolType: "web_search_call",
      name: "web_search",
      callId: payload.call_id || null,
      body: safeJson(parsedAction),
      data: parsedAction,
      language: "json"
    };
  }

  return {
    kind: "tool_event",
    timestamp,
    eventType: payload.type || "unknown_item",
    body: safeJson(payload),
    language: "json"
  };
}

function buildToolOutput(payload, timestamp, toolName) {
  if (payload.type === "function_call_output") {
    const body = normalizeText(payload.output);
    const truncation = detectToolTextTruncation(body);

    return {
      kind: "tool_output",
      timestamp,
      toolType: "function_call_output",
      name: toolName,
      callId: payload.call_id || null,
      body,
      language: "text",
      isTruncated: truncation.isTruncated,
      truncationReason: truncation.truncationReason
    };
  }

  if (payload.type === "custom_tool_call_output") {
    const parsed = parsePossibleJson(payload.output);
    const body = typeof parsed === "string" ? normalizeText(parsed) : safeJson(parsed);
    const truncation = typeof parsed === "string"
      ? detectToolTextTruncation(body)
      : { isTruncated: false, truncationReason: null };

    return {
      kind: "tool_output",
      timestamp,
      toolType: "custom_tool_call_output",
      name: toolName,
      callId: payload.call_id || null,
      body,
      language: typeof parsed === "string" ? "text" : "json",
      isTruncated: truncation.isTruncated,
      truncationReason: truncation.truncationReason
    };
  }

  return {
    kind: "tool_event",
    timestamp,
    eventType: payload.type || "unknown_output",
    body: safeJson(payload),
    language: "json"
  };
}

function buildActivityEvent(payload, timestamp) {
  return {
    type: payload.type || "unknown_event",
    timestamp: timestamp || null,
    turnId: payload.turn_id || null,
    startedAt: Number.isFinite(Number(payload.started_at)) ? Number(payload.started_at) : null,
    completedAt: Number.isFinite(Number(payload.completed_at)) ? Number(payload.completed_at) : null,
    durationMs: Number.isFinite(Number(payload.duration_ms)) ? Number(payload.duration_ms) : null,
    collaborationMode: payload.collaboration_mode_kind || null,
    modelContextWindow: Number.isFinite(Number(payload.model_context_window))
      ? Number(payload.model_context_window)
      : null
  };
}

export async function loadSession(filePath, options = {}) {
  const source = await readFile(filePath, "utf8");
  const lines = parseJsonLines(source);
  const metaLine = lines.find((entry) => entry.type === "session_meta");
  const meta = metaLine?.payload ?? {};

  const session = {
    id: meta.id || extractSessionId(filePath),
    filePath,
    startedAt: meta.timestamp || lines[0]?.timestamp || null,
    cwd: meta.cwd || null,
    source: meta.source || null,
    originator: meta.originator || null,
    cliVersion: meta.cli_version || null,
    modelProvider: meta.model_provider || null,
    items: [],
    tokenSnapshots: [],
    activityEvents: []
  };
  const toolNamesByCallId = new Map();
  let pendingTokenSnapshotStartIndex = 0;
  let runEpoch = 0;
  let lastTokenSnapshotKey = null;

  function resetTokenSnapshotWindow() {
    pendingTokenSnapshotStartIndex = session.items.length;
    lastTokenSnapshotKey = null;
  }

  function recordTokenSnapshot(payload, timestamp) {
    const usage = parseTokenUsageInfo(payload.info);

    if (!usage) {
      return;
    }

    const snapshotKey = [
      runEpoch,
      usage.cumulativeTokens,
      usage.totalTokens,
      usage.inputTokens,
      usage.cachedInputTokens,
      usage.outputTokens,
      usage.reasoningOutputTokens
    ].join(":");

    if (snapshotKey === lastTokenSnapshotKey) {
      return;
    }

    lastTokenSnapshotKey = snapshotKey;
    const segmentItems = session.items.slice(pendingTokenSnapshotStartIndex);

    session.tokenSnapshots.push({
      timestamp,
      tokens: usage.totalTokens,
      ...usage,
      startIndex: pendingTokenSnapshotStartIndex,
      endIndex: session.items.length,
      items: segmentItems
    });

    pendingTokenSnapshotStartIndex = session.items.length;
  }

  for (const entry of lines) {
    if (entry.type === "event_msg") {
      const payload = entry.payload || {};

      if (payload.type === "task_started" || payload.type === "thread_rolled_back") {
        runEpoch += 1;
        resetTokenSnapshotWindow();
      }

      if (
        payload.type === "task_started" ||
        payload.type === "task_complete" ||
        payload.type === "task_completed" ||
        payload.type === "thread_rolled_back"
      ) {
        session.activityEvents.push(buildActivityEvent(payload, entry.timestamp || null));
      }

      if (payload.type === "token_count") {
        recordTokenSnapshot(payload, entry.timestamp || null);
      }

      continue;
    }

    if (entry.type !== "response_item") {
      continue;
    }

    const payload = entry.payload || {};
    const timestamp = entry.timestamp || null;

    if (payload.type === "message") {
      const role = payload.role || "unknown";
      const { text, contentBlocks } = parseMessageBlocks(payload.content);

      if (!text && contentBlocks.length === 0) {
        continue;
      }

      if (role === "developer" && !options.includeDeveloper) {
        continue;
      }

      if (role === "user" && !options.includeContext && looksLikeContextPrelude(text)) {
        continue;
      }

      session.items.push({
        kind: "message",
        timestamp,
        role,
        phase: payload.phase || null,
        text,
        contentBlocks,
        isContextPrelude: role === "user" ? looksLikeContextPrelude(text) : false
      });
      continue;
    }

    if (payload.type === "reasoning") {
      if (!options.includeReasoning) {
        continue;
      }

      const summary = Array.isArray(payload.summary) && payload.summary.length > 0
        ? payload.summary.map((item) => safeJson(item)).join("\n")
        : "Reasoning content was not included in the session export.";

      session.items.push({
        kind: "reasoning",
        timestamp,
        text: summary
      });
      continue;
    }

    if (
      payload.type === "function_call" ||
      payload.type === "custom_tool_call" ||
      payload.type === "web_search_call"
    ) {
      const toolCall = buildToolCall(payload, timestamp);
      session.items.push(toolCall);
      if (toolCall.callId) {
        toolNamesByCallId.set(toolCall.callId, toolCall.name);
      }
      continue;
    }

    if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
      session.items.push(
        buildToolOutput(payload, timestamp, toolNamesByCallId.get(payload.call_id) || null)
      );
      continue;
    }

    session.items.push({
      kind: "tool_event",
      timestamp,
      eventType: payload.type || "unknown_item",
      body: safeJson(payload),
      language: "json"
    });
  }

  return session;
}

function buildMessageFromJsonlEntry(entry, options = {}) {
  if (entry?.type !== "response_item") {
    return null;
  }

  const payload = entry.payload || {};

  if (payload.type !== "message") {
    return null;
  }

  const role = payload.role || "unknown";
  const { text, contentBlocks } = parseMessageBlocks(payload.content);

  if (!text && contentBlocks.length === 0) {
    return null;
  }

  if (role === "developer" && !options.includeDeveloper) {
    return null;
  }

  if (role === "user" && !options.includeContext && looksLikeContextPrelude(text)) {
    return null;
  }

  return {
    kind: "message",
    timestamp: entry.timestamp || null,
    role,
    phase: payload.phase || null,
    text,
    contentBlocks,
    isContextPrelude: role === "user" ? looksLikeContextPrelude(text) : false
  };
}

function parseJsonlBufferLine(buffer, offset) {
  const source = buffer.toString("utf8").trim();

  if (!source) {
    return null;
  }

  return {
    entry: JSON.parse(source),
    offset
  };
}

async function readJsonlFromHead(filePath, onLine) {
  const handle = await open(filePath, "r");
  let position = 0;
  let pending = Buffer.alloc(0);
  let pendingOffset = 0;

  try {
    while (true) {
      const buffer = Buffer.allocUnsafe(SNAPSHOT_READ_CHUNK_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);

      if (bytesRead <= 0) {
        break;
      }

      const chunk = buffer.subarray(0, bytesRead);
      const sourceOffset = pending.length > 0 ? pendingOffset : position;
      const source = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
      let lineStart = 0;

      for (let index = 0; index < source.length; index += 1) {
        if (source[index] !== 0x0a) {
          continue;
        }

        const parsed = parseJsonlBufferLine(source.subarray(lineStart, index), sourceOffset + lineStart);
        lineStart = index + 1;

        if (parsed && (await onLine(parsed)) === false) {
          return;
        }
      }

      pending = source.subarray(lineStart);
      pendingOffset = sourceOffset + lineStart;
      position += bytesRead;
    }

    const parsed = parseJsonlBufferLine(pending, pendingOffset);
    if (parsed) {
      await onLine(parsed);
    }
  } finally {
    await handle.close();
  }
}

async function readJsonlFromTail(filePath, onLine) {
  const [details, handle] = await Promise.all([stat(filePath), open(filePath, "r")]);
  let position = details.size;
  let pending = Buffer.alloc(0);

  try {
    while (position > 0) {
      const length = Math.min(SNAPSHOT_READ_CHUNK_BYTES, position);
      position -= length;
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      const chunk = buffer.subarray(0, bytesRead);
      const source = pending.length > 0 ? Buffer.concat([chunk, pending]) : chunk;
      let lineEnd = source.length;

      for (let index = source.length - 1; index >= 0; index -= 1) {
        if (source[index] !== 0x0a) {
          continue;
        }

        const parsed = parseJsonlBufferLine(source.subarray(index + 1, lineEnd), position + index + 1);
        lineEnd = index;

        if (parsed && (await onLine(parsed)) === false) {
          return;
        }
      }

      pending = source.subarray(0, lineEnd);
    }

    const parsed = parseJsonlBufferLine(pending, 0);
    if (parsed) {
      await onLine(parsed);
    }
  } finally {
    await handle.close();
  }
}

function isEligibleUserMessage(item) {
  return (
    item?.kind === "message" &&
    item.role === "user" &&
    item.isContextPrelude !== true &&
    !USER_TRANSCRIPT_CONTROL_MESSAGE_PATTERN.test(String(item.text ?? "").trim())
  );
}

function addSnapshotItem(itemsByOffset, offset, item, label = null) {
  if (!item || !Number.isFinite(offset)) {
    return;
  }

  const existing = itemsByOffset.get(offset);

  itemsByOffset.set(offset, {
    item: existing?.item || item,
    label: [existing?.label, label].filter(Boolean).join(" · ") || null
  });
}

/**
 * Reads only the messages required for the default first-and-last recall view.
 * The middle of a JSONL is intentionally never parsed here: aggregate process
 * metrics are deferred to the explicit analysis/full reader paths.
 */
export async function loadSessionMemorySnapshot(filePath, options = {}) {
  let meta = {};
  let firstTimestamp = null;
  let firstUser = null;
  let firstFinalAssistant = null;
  let firstLatestAssistant = null;

  await readJsonlFromHead(filePath, ({ entry, offset }) => {
    firstTimestamp ||= entry.timestamp || null;

    if (entry.type === "session_meta") {
      meta = entry.payload || {};
      return true;
    }

    const item = buildMessageFromJsonlEntry(entry, options);

    if (!item) {
      return true;
    }

    if (!firstUser && isEligibleUserMessage(item)) {
      firstUser = { item, offset };
      return true;
    }

    // A response belongs to the current request only up to the next request.
    // This matters for historical Codex sessions that predate `final_answer`
    // phases: without this boundary, the newest answer is shown under the
    // first request in the memory snapshot.
    if (firstUser && isEligibleUserMessage(item)) {
      // Consecutive user messages before any assistant output are one
      // interrupted/follow-up request group. Keep reading so the first
      // displayed request can still carry that group's eventual answer.
      return !firstLatestAssistant;
    }

    if (firstUser && item.role === "assistant") {
      firstLatestAssistant = { item, offset };

      if (isFinalAssistantMessage(item)) {
        firstFinalAssistant = firstLatestAssistant;
        return false;
      }
    }

    return true;
  });

  const tailUsers = [];
  const tailResponsesByUserOffset = new Map();
  let nearestFinalAssistant = null;
  let nearestAssistant = null;

  await readJsonlFromTail(filePath, ({ entry, offset }) => {
    const item = buildMessageFromJsonlEntry(entry, options);

    if (!item) {
      return true;
    }

    if (item.role === "assistant") {
      nearestAssistant ||= { item, offset };

      if (isFinalAssistantMessage(item)) {
        nearestFinalAssistant = { item, offset };
      }

      return true;
    }

    if (!isEligibleUserMessage(item)) {
      return true;
    }

    tailUsers.push({ item, offset });
    tailResponsesByUserOffset.set(offset, nearestFinalAssistant || nearestAssistant || null);

    // While reading backwards, discard the answer just associated with this
    // request. An older request must not inherit it across a newer user turn.
    nearestFinalAssistant = null;
    nearestAssistant = null;

    return tailUsers.length < 2;
  });

  const itemsByOffset = new Map();

  if (firstUser) {
    addSnapshotItem(itemsByOffset, firstUser.offset, firstUser.item, "首个请求");
    const response = firstFinalAssistant || firstLatestAssistant;
    if (response) {
      addSnapshotItem(itemsByOffset, response.offset, response.item);
    }
  }

  [...tailUsers].reverse().forEach((user, index, users) => {
    const label = index === users.length - 1 ? "最新请求" : "倒数第 2 个请求";
    addSnapshotItem(itemsByOffset, user.offset, user.item, label);
    const response = tailResponsesByUserOffset.get(user.offset);
    if (response) {
      addSnapshotItem(itemsByOffset, response.offset, response.item);
    }
  });

  const items = [...itemsByOffset.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, entry]) => ({
      ...entry.item,
      snapshotExcerpt: true,
      snapshotLabel: entry.label
    }));

  return {
    id: meta.id || extractSessionId(filePath),
    filePath,
    startedAt: meta.timestamp || firstTimestamp,
    cwd: meta.cwd || null,
    source: meta.source || null,
    originator: meta.originator || null,
    cliVersion: meta.cli_version || null,
    modelProvider: meta.model_provider || null,
    items,
    tokenSnapshots: [],
    activityEvents: [],
    selection: {
      mode: "memory_snapshot",
      summaryComplete: false,
      totalRounds: null,
      totalItems: null,
      displayedItems: items.length,
      omittedItems: null,
      totalUserMessages: null,
      displayedUserMessages: items.filter(isEligibleUserMessage).length,
      totalFinalAnswers: null,
      totalToolCalls: null,
      totalTokens: null,
      firstUserIncluded: Boolean(firstUser),
      tailUserMessagesIncluded: tailUsers.length
    }
  };
}

function sliceTokenSnapshots(tokenSnapshots, startIndex) {
  const sourceSnapshots = Array.isArray(tokenSnapshots) ? tokenSnapshots : [];

  if (!Number.isFinite(startIndex) || startIndex <= 0) {
    return sourceSnapshots.map((snapshot) => ({
      ...snapshot,
      items: Array.isArray(snapshot.items) ? [...snapshot.items] : []
    }));
  }

  const slicedSnapshots = [];

  for (const snapshot of sourceSnapshots) {
    const snapshotStartIndex = Number(snapshot.startIndex) || 0;
    const snapshotEndIndex = Number(snapshot.endIndex) || snapshotStartIndex;

    if (snapshotEndIndex <= startIndex) {
      continue;
    }

    const originalItems = Array.isArray(snapshot.items) ? snapshot.items : [];
    const retainedStartIndex = Math.max(0, startIndex - snapshotStartIndex);
    const retainedItems = originalItems.slice(retainedStartIndex);
    const retainedItemCount = retainedItems.length;
    const originalItemCount = originalItems.length;
    const retainedRatio =
      originalItemCount > 0 ? retainedItemCount / originalItemCount : 1;

    slicedSnapshots.push({
      ...snapshot,
      startIndex: Math.max(0, snapshotStartIndex - startIndex),
      endIndex: Math.max(0, snapshotEndIndex - startIndex),
      tokens:
        originalItemCount > 0 && retainedRatio < 1 ? snapshot.tokens * retainedRatio : snapshot.tokens,
      items: retainedItems
    });
  }

  return slicedSnapshots;
}

function sliceActivityEvents(activityEvents, startTimestamp) {
  const sourceEvents = Array.isArray(activityEvents) ? activityEvents : [];
  const startTime = Date.parse(startTimestamp || "");

  if (!Number.isFinite(startTime)) {
    return [...sourceEvents];
  }

  const visibleEvents = [];
  let precedingStart = null;

  for (const event of sourceEvents) {
    const eventTime = Date.parse(event?.timestamp || "");

    if (Number.isFinite(eventTime) && eventTime < startTime) {
      if (event?.type === "task_started") {
        precedingStart = event;
      }
      continue;
    }

    visibleEvents.push(event);
  }

  return precedingStart ? [precedingStart, ...visibleEvents] : visibleEvents;
}

export function selectRecentRounds(session, rounds) {
  const conversationRounds = splitConversationRounds(session.items);
  const totalRounds = conversationRounds.length;

  if (!Number.isFinite(rounds) || rounds <= 0) {
    return {
      ...session,
      selection: {
        mode: "all",
        roundsRequested: null,
        roundsIncluded: countConversationRounds(session.items)
      }
    };
  }

  if (totalRounds === 0 || rounds >= totalRounds) {
    return {
      ...session,
      selection: {
        mode: "recent_rounds",
        roundsRequested: rounds,
        roundsIncluded: totalRounds
      }
    };
  }

  const selectedRounds = conversationRounds.slice(totalRounds - rounds);
  const startIndex = selectedRounds[0].startIndex;
  const tokenSnapshots = sliceTokenSnapshots(session.tokenSnapshots, startIndex);
  const activityEvents = sliceActivityEvents(session.activityEvents, session.items[startIndex]?.timestamp);

  return {
    ...session,
    items: session.items.slice(startIndex),
    tokenSnapshots,
    activityEvents,
    selection: {
      mode: "recent_rounds",
      roundsRequested: rounds,
      roundsIncluded: rounds,
      totalRounds
    }
  };
}

function isConversationUserMessage(item) {
  return isEligibleUserMessage(item);
}

function isAssistantMessage(item) {
  return item?.kind === "message" && item.role === "assistant";
}

function isFinalAssistantMessage(item) {
  return isAssistantMessage(item) && item.phase === "final_answer";
}

function findSnapshotResponseIndex(items, userIndex) {
  let latestAssistantIndex = null;

  for (let index = userIndex + 1; index < items.length; index += 1) {
    const item = items[index];

    if (isConversationUserMessage(item)) {
      break;
    }

    if (isFinalAssistantMessage(item)) {
      return index;
    }

    if (isAssistantMessage(item)) {
      latestAssistantIndex = index;
    }
  }

  return latestAssistantIndex;
}

function sumRecordedTokens(tokenSnapshots) {
  return (Array.isArray(tokenSnapshots) ? tokenSnapshots : []).reduce((total, snapshot) => {
    const tokens = Number(snapshot?.tokens ?? snapshot?.totalTokens ?? 0);
    return Number.isFinite(tokens) && tokens > 0 ? total + tokens : total;
  }, 0);
}

/**
 * Selects a compact recall view: the first user request and the two most
 * recent user requests, each paired with its final (or latest) assistant
 * response. The omitted process stays summarized in `selection` instead of
 * being serialized into the interactive browser payload.
 */
export function selectSessionMemorySnapshot(session) {
  const items = Array.isArray(session?.items) ? session.items : [];
  const userIndexes = items
    .map((item, index) => (isConversationUserMessage(item) ? index : null))
    .filter((index) => Number.isInteger(index));
  const firstUserIndex = userIndexes[0] ?? null;
  const tailUserIndexes = userIndexes.slice(-2);
  const selectedUserIndexes = [...new Set([firstUserIndex, ...tailUserIndexes].filter(Number.isInteger))].sort(
    (left, right) => left - right
  );
  const selectedIndexes = new Set(selectedUserIndexes);
  const labelsByIndex = new Map();

  if (Number.isInteger(firstUserIndex)) {
    labelsByIndex.set(firstUserIndex, "首个请求");
  }

  tailUserIndexes.forEach((index, tailIndex) => {
    const label = tailUserIndexes.length === 1 || tailIndex === tailUserIndexes.length - 1
      ? "最新请求"
      : "倒数第 2 个请求";
    const existing = labelsByIndex.get(index);
    labelsByIndex.set(index, existing ? `${existing} · ${label}` : label);
  });

  selectedUserIndexes.forEach((userIndex) => {
    const responseIndex = findSnapshotResponseIndex(items, userIndex);

    if (Number.isInteger(responseIndex)) {
      selectedIndexes.add(responseIndex);
    }
  });

  const snapshotItems = [...selectedIndexes]
    .sort((left, right) => left - right)
    .map((index) => ({
      ...items[index],
      snapshotExcerpt: true,
      snapshotLabel: labelsByIndex.get(index) || null
    }));
  const totalRounds = countConversationRounds(items);
  const totalToolCalls = items.filter((item) => item?.kind === "tool_call").length;
  const totalFinalAnswers = items.filter(isFinalAssistantMessage).length;

  return {
    ...session,
    items: snapshotItems,
    // Token snapshot items can reference every original transcript item. They
    // are intentionally omitted here so a compact view does not carry the
    // whole session back to the browser indirectly.
    tokenSnapshots: [],
    activityEvents: [],
    selection: {
      mode: "memory_snapshot",
      totalRounds,
      totalItems: items.length,
      displayedItems: snapshotItems.length,
      omittedItems: Math.max(0, items.length - snapshotItems.length),
      totalUserMessages: userIndexes.length,
      displayedUserMessages: selectedUserIndexes.length,
      totalFinalAnswers,
      totalToolCalls,
      totalTokens: sumRecordedTokens(session?.tokenSnapshots),
      firstUserIncluded: Number.isInteger(firstUserIndex),
      tailUserMessagesIncluded: tailUserIndexes.length
    }
  };
}

export function splitSessionIntoRounds(session) {
  const rounds = splitConversationRounds(session.items);

  if (rounds.length === 0) {
    return [
      {
        ...session,
        round: null
      }
    ];
  }

  return rounds.map((round) => ({
    ...session,
    items: session.items.slice(round.startIndex, round.endIndex),
    round: {
      index: round.index,
      total: round.total
    }
  }));
}
