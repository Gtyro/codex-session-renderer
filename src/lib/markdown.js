function fence(language, content) {
  const trimmed = String(content ?? "").trimEnd();
  return `~~~${language}\n${trimmed}\n~~~`;
}

function toLines(value) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd());
}

function trimOuterBlankLines(lines) {
  const nextLines = [...lines];

  while (nextLines[0] === "") {
    nextLines.shift();
  }

  while (nextLines.at(-1) === "") {
    nextLines.pop();
  }

  return nextLines;
}

function collapseBlankRuns(lines) {
  const nextLines = [];
  let previousBlank = false;

  for (const line of lines) {
    const blank = line.trim() === "";
    if (blank && previousBlank) {
      continue;
    }
    nextLines.push(blank ? "" : line);
    previousBlank = blank;
  }

  return nextLines;
}

function compactLongLines(lines, { maxLines, headLines, tailLines }) {
  if (lines.length <= maxLines) {
    return lines;
  }

  const omitted = lines.length - headLines - tailLines;
  return [
    ...lines.slice(0, headLines),
    `... omitted ${omitted} line${omitted === 1 ? "" : "s"} ...`,
    ...lines.slice(-tailLines)
  ];
}

function isProgressLogLine(line) {
  const text = line.trim();

  if (!text) {
    return false;
  }

  return (
    /^[(\[]?[#=><|*+\-\\/:\s\u2800-\u28ff]{4,}.*$/u.test(text) ||
    /(?:idealTree|reify:|http fetch GET|waiting for fonts|taking page screenshot)/i.test(text) ||
    (/Downloading /i.test(text) && /\d/.test(text)) ||
    (/(\d+(?:\.\d+)?\s*(?:MiB|GiB|KiB)|\d+%)/i.test(text) &&
      /(?:\(|\[|MiB|GiB|KiB|s$)/.test(text))
  );
}

function summarizeProgressRuns(lines) {
  const nextLines = [];
  let buffered = 0;

  for (const line of lines) {
    if (isProgressLogLine(line)) {
      buffered += 1;
      continue;
    }

    if (buffered > 0) {
      nextLines.push(`... omitted ${buffered} progress/log line${buffered === 1 ? "" : "s"} ...`);
      buffered = 0;
    }

    nextLines.push(line);
  }

  if (buffered > 0) {
    nextLines.push(`... omitted ${buffered} progress/log line${buffered === 1 ? "" : "s"} ...`);
  }

  return nextLines;
}

function stringifyCompactValue(value) {
  if (typeof value === "string") {
    const normalized = value.replace(/\s+/g, " ").trim();

    if (normalized === "") {
      return '""';
    }

    return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
  }

  if (value === null || value === undefined) {
    return String(value);
  }

  const json = JSON.stringify(value);
  return json.length > 160 ? `${json.slice(0, 157)}...` : json;
}

function compactGenericBlock(body, { maxLines, headLines, tailLines }) {
  const lines = trimOuterBlankLines(collapseBlankRuns(toLines(body)));
  return compactLongLines(lines, { maxLines, headLines, tailLines }).join("\n");
}

function compactToolCallBody(item) {
  if (item.name === "write_stdin" && item.data && item.data.chars === "") {
    return null;
  }

  if (item.name === "exec_command" && item.data && typeof item.data === "object" && !Array.isArray(item.data)) {
    const lines = [];

    if (item.data.cmd) {
      lines.push(`cmd: ${stringifyCompactValue(item.data.cmd)}`);
    }
    if (item.data.workdir) {
      lines.push(`workdir: ${stringifyCompactValue(item.data.workdir)}`);
    }
    if (item.data.tty) {
      lines.push("tty: true");
    }
    if (item.data.login === false) {
      lines.push("login: false");
    }
    if (item.data.shell) {
      lines.push(`shell: ${stringifyCompactValue(item.data.shell)}`);
    }

    return lines.join("\n");
  }

  if (item.name === "write_stdin" && item.data && typeof item.data === "object" && !Array.isArray(item.data)) {
    const lines = [`session_id: ${stringifyCompactValue(item.data.session_id)}`];

    if (item.data.chars) {
      lines.push(`chars: ${stringifyCompactValue(item.data.chars)}`);
    }

    return lines.join("\n");
  }

  if (item.toolType === "function_call" && item.data && typeof item.data === "object" && !Array.isArray(item.data)) {
    const preferredKeys =
      Object.keys(item.data);

    const lines = [];
    const usedKeys = new Set();

    for (const key of preferredKeys) {
      if (!(key in item.data)) {
        continue;
      }
      lines.push(`${key}: ${stringifyCompactValue(item.data[key])}`);
      usedKeys.add(key);
    }

    const remainingKeys = Object.keys(item.data).filter((key) => !usedKeys.has(key));

    for (const key of remainingKeys.slice(0, 6)) {
      lines.push(`${key}: ${stringifyCompactValue(item.data[key])}`);
    }

    if (remainingKeys.length > 6) {
      lines.push(`... omitted ${remainingKeys.length - 6} additional field(s) ...`);
    }

    return lines.join("\n");
  }

  return compactGenericBlock(item.body, {
    maxLines: 24,
    headLines: 12,
    tailLines: 6
  });
}

function compactToolOutputBody(item) {
  const rawLines = toLines(item.body);
  const statusLine = rawLines.find((line) => /^Process (?:exited|running)/.test(line.trim()))?.trim() || null;
  const filteredLines = rawLines.filter((line) => {
    const text = line.trim();
    return !(
      text === "" ||
      /^Chunk ID:/i.test(text) ||
      /^Wall time:/i.test(text) ||
      /^Original token count:/i.test(text) ||
      /^Output:$/i.test(text) ||
      /^Process (?:exited|running)/.test(text)
    );
  });

  const collapsedLines = summarizeProgressRuns(collapseBlankRuns(filteredLines));
  const compactedLines = compactLongLines(trimOuterBlankLines(collapsedLines), {
    maxLines: 20,
    headLines: 10,
    tailLines: 6
  });

  if (compactedLines.length === 0) {
    if (
      !statusLine ||
      /^Process running with session ID/i.test(statusLine) ||
      /^Process exited with code 0$/i.test(statusLine)
    ) {
      return null;
    }
    return statusLine;
  }

  if (
    compactedLines.length === 1 &&
    /^... omitted \d+ progress\/log lines ...$/u.test(compactedLines[0]) &&
    (!statusLine || /^Process running with session ID/i.test(statusLine))
  ) {
    return null;
  }

  return [statusLine, statusLine ? "" : null, ...compactedLines]
    .filter((line) => line !== null)
    .join("\n");
}

function metadataLine(label, value) {
  return value ? `- ${label}: ${value}` : null;
}

function headingForRole(role) {
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

function itemHeading(item, number) {
  if (item.kind === "message") {
    return `### ${number}. ${headingForRole(item.role)}`;
  }

  if (item.kind === "reasoning") {
    return `### ${number}. Reasoning`;
  }

  if (item.kind === "tool_call") {
    return `### ${number}. Tool Call - ${item.name}`;
  }

  if (item.kind === "tool_output") {
    return item.name
      ? `### ${number}. Tool Output - ${item.name}`
      : `### ${number}. Tool Output`;
  }

  return `### ${number}. ${item.eventType || "Event"}`;
}

function buildEntries(items, mode) {
  if (mode !== "compact") {
    return items.map((item) => ({ kind: "single", item }));
  }

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
        const output = items[outputIndex];

        entries.push({
          kind: "tool_interaction",
          call: item,
          output
        });
        continue;
      }
    }

    if (item.kind === "tool_call" && item.callId) {
      entries.push({
        kind: "single",
        item
      });
      continue;
    }

    entries.push({
      kind: "single",
      item
    });
  }

  return entries;
}

function entryHeading(entry, number) {
  if (entry.kind === "tool_interaction") {
    return `### ${number}. Tool - ${entry.call.name}`;
  }

  return itemHeading(entry.item, number);
}

function entryTimestampLines(entry) {
  if (entry.kind === "tool_interaction") {
    const lines = [];

    if (entry.call.timestamp) {
      lines.push(`_Call: ${entry.call.timestamp}_`);
    }
    if (entry.output.timestamp && entry.output.timestamp !== entry.call.timestamp) {
      lines.push(`_Output: ${entry.output.timestamp}_`);
    }

    return lines;
  }

  if (!entry.item.timestamp) {
    return [];
  }

  return [`_Timestamp: ${entry.item.timestamp}_`];
}

function entryCallId(entry) {
  if (entry.kind === "tool_interaction") {
    return entry.call.callId || entry.output.callId || null;
  }

  return entry.item.callId || null;
}

function renderItemBody(item, mode) {
  if (item.kind === "message") {
    return item.text;
  }

  if (item.kind === "reasoning") {
    return fence("text", item.text);
  }

  if (item.kind === "tool_call") {
    const body = mode === "compact" ? compactToolCallBody(item) : item.body;
    if (!body) {
      return null;
    }
    return fence(item.language, body);
  }

  if (item.kind === "tool_output") {
    const body = mode === "compact" ? compactToolOutputBody(item) : item.body;
    if (!body) {
      return null;
    }
    return fence(item.language, body);
  }

  const body =
    mode === "compact"
      ? compactGenericBlock(item.body, {
          maxLines: 18,
          headLines: 10,
          tailLines: 4
        })
      : item.body;

  return fence(item.language || "json", body);
}

function renderEntryBody(entry, mode) {
  if (entry.kind === "tool_interaction") {
    const input = compactToolCallBody(entry.call);
    const output = compactToolOutputBody(entry.output);

    if (!input && !output) {
      return null;
    }

    const lines = [];

    if (input) {
      lines.push("Input");
      lines.push(input);
    }

    if (output) {
      if (lines.length > 0) {
        lines.push("");
      }
      lines.push("Output");
      lines.push(output);
    }

    return fence("text", lines.join("\n"));
  }

  return renderItemBody(entry.item, mode);
}

export function sessionToMarkdown(session, options = {}) {
  const mode = options.mode || "full";
  const entries = buildEntries(session.items, mode);
  const selectionLine =
    session.selection?.mode === "recent_rounds"
      ? `- Included rounds: last ${session.selection.roundsIncluded} of ${session.selection.totalRounds ?? session.selection.roundsIncluded}`
      : session.selection?.mode === "all"
      ? "- Included rounds: all"
        : null;
  const roundLine =
    session.round && session.round.total > 1
      ? `- Round: ${session.round.index} of ${session.round.total}`
      : session.round && session.round.total === 1
        ? "- Round: 1 of 1"
        : null;
  const lines = [
    `# Codex Session ${session.id}`,
    "",
    metadataLine("Source file", session.filePath),
    metadataLine("Started at", session.startedAt),
    metadataLine("Working directory", session.cwd),
    metadataLine("Source", session.source),
    metadataLine("Originator", session.originator),
    metadataLine("CLI version", session.cliVersion),
    metadataLine("Model provider", session.modelProvider),
    selectionLine,
    roundLine,
    "",
    mode === "compact"
      ? "> Compact view: long tool calls and tool outputs are summarized for readability. The full transcript remains in the non-compact markdown."
      : null,
    mode === "compact" ? "" : null,
    "## Transcript",
    ""
  ].filter((line) => line !== null);

  let renderedCount = 0;

  entries.forEach((entry) => {
    const body = renderEntryBody(entry, mode);
    if (!body) {
      return;
    }

    renderedCount += 1;
    lines.push(entryHeading(entry, renderedCount));

    for (const timestampLine of entryTimestampLines(entry)) {
      lines.push(timestampLine);
    }

    const callId = entryCallId(entry);
    if (callId) {
      lines.push(`_Call ID: ${callId}_`);
    }
    lines.push("");
    lines.push(body);
    lines.push("");
  });

  return `${lines.join("\n").trim()}\n`;
}
