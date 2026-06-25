import { readFile } from "node:fs/promises";
import { extractSessionId } from "./session-store.js";
import { countConversationRounds, splitConversationRounds } from "./conversation-rounds.js";

const ANSI_PATTERN = /[\u001b\u009b][[\]()#;?]*(?:(?:\d{1,4}(?:;\d{0,4})*)?[0-9A-ORZcf-nqry=><~]|.)/gu;

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
    return {
      kind: "tool_output",
      timestamp,
      toolType: "function_call_output",
      name: toolName,
      callId: payload.call_id || null,
      body: normalizeText(payload.output),
      language: "text"
    };
  }

  if (payload.type === "custom_tool_call_output") {
    const parsed = parsePossibleJson(payload.output);
    return {
      kind: "tool_output",
      timestamp,
      toolType: "custom_tool_call_output",
      name: toolName,
      callId: payload.call_id || null,
      body: typeof parsed === "string" ? normalizeText(parsed) : safeJson(parsed),
      language: typeof parsed === "string" ? "text" : "json"
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
    items: []
  };
  const toolNamesByCallId = new Map();

  for (const entry of lines) {
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

  return {
    ...session,
    items: session.items.slice(startIndex),
    selection: {
      mode: "recent_rounds",
      roundsRequested: rounds,
      roundsIncluded: rounds,
      totalRounds
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
