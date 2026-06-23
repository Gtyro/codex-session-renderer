import { readFile } from "node:fs/promises";
import { extractSessionId } from "./session-store.js";

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

function parseMessageBlocks(content) {
  const blocks = Array.isArray(content) ? content : [];

  return blocks
    .map((block) => {
      if (!block || typeof block !== "object") {
        return "";
      }

      if ((block.type === "input_text" || block.type === "output_text") && typeof block.text === "string") {
        return normalizeText(block.text);
      }

      return normalizeText(JSON.stringify(block, null, 2));
    })
    .filter(Boolean)
    .join("\n\n");
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
      const text = parseMessageBlocks(payload.content);

      if (!text) {
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
        text,
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

  const userIndexes = session.items
    .map((item, index) => ({ item, index }))
    .filter(
      ({ item }) => item.kind === "message" && item.role === "user" && item.isContextPrelude !== true
    )
    .map(({ index }) => index);

  const totalRounds = userIndexes.length;

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

  const startIndex = userIndexes[totalRounds - rounds];

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

function countConversationRounds(items) {
  return items.filter(
    (item) => item.kind === "message" && item.role === "user" && item.isContextPrelude !== true
  ).length;
}

export function splitSessionIntoRounds(session) {
  const userIndexes = session.items
    .map((item, index) => ({ item, index }))
    .filter(
      ({ item }) => item.kind === "message" && item.role === "user" && item.isContextPrelude !== true
    )
    .map(({ index }) => index);

  if (userIndexes.length === 0) {
    return [
      {
        ...session,
        round: null
      }
    ];
  }

  const rounds = [];
  const leadingItems = session.items.slice(0, userIndexes[0]);

  for (let index = 0; index < userIndexes.length; index += 1) {
    const start = userIndexes[index];
    const end = userIndexes[index + 1] ?? session.items.length;
    const items = session.items.slice(start, end);

    rounds.push({
      ...session,
      items: index === 0 && leadingItems.length > 0 ? [...leadingItems, ...items] : items,
      round: {
        index: index + 1,
        total: userIndexes.length
      }
    });
  }

  return rounds;
}
