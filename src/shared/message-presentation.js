function normalizeText(value) {
  return String(value ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function trimOuterBlankLines(lines) {
  const nextLines = [...lines];

  while (nextLines[0]?.trim() === "") {
    nextLines.shift();
  }

  while (nextLines.at(-1)?.trim() === "") {
    nextLines.pop();
  }

  return nextLines;
}

function normalizeHeading(line) {
  return line
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .replace(/^\*\*(.*)\*\*$/, "$1")
    .replace(/^__(.*)__$/, "$1")
    .replace(/:+$/, "")
    .trim()
    .toLowerCase();
}

function isHeading(line, expected) {
  return normalizeHeading(line) === expected;
}

function parseAttachmentLine(line) {
  const match = line.trim().match(/^(?:[-*+]\s*)?([^:\n]+):\s*(.+)$/u);

  if (!match) {
    return null;
  }

  const label = match[1]?.trim();
  const path = match[2]?.trim();

  if (!label || !path) {
    return null;
  }

  return {
    label,
    path
  };
}

function toInlineCode(value) {
  const source = String(value ?? "");
  const runs = source.match(/`+/g);
  const fence = "`".repeat(Math.max(1, ...(runs ? runs.map((run) => run.length + 1) : [1])));
  return `${fence}${source}${fence}`;
}

function trimOuterBlankText(value) {
  return trimOuterBlankLines(normalizeText(value).split("\n")).join("\n");
}

function normalizeSkillName(value) {
  return String(value ?? "").trim().toLowerCase();
}

function stripSkillTriggerPrefix(value) {
  return String(value ?? "").trim().replace(/^\$/u, "");
}

function skillNameFromPath(value) {
  const source = String(value ?? "").trim().replace(/\\/g, "/");

  if (!source) {
    return null;
  }

  const segments = source.split("/").filter(Boolean);
  const skillFileIndex = segments.findIndex((segment) => segment.toLowerCase() === "skill.md");

  if (skillFileIndex <= 0) {
    return null;
  }

  return segments[skillFileIndex - 1] || null;
}

function parseSimpleMetadataLine(line) {
  const match = line.trim().match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.+)$/u);

  if (!match) {
    return null;
  }

  return {
    key: match[1].toLowerCase(),
    value: match[2].trim()
  };
}

function parseYamlLikeMetadata(lines) {
  const metadata = {};
  let nextIndex = 0;

  for (; nextIndex < lines.length; nextIndex += 1) {
    const line = lines[nextIndex];

    if (line.trim() === "") {
      nextIndex += 1;
      break;
    }

    const entry = parseSimpleMetadataLine(line);

    if (!entry) {
      break;
    }

    metadata[entry.key] = entry.value;
  }

  return {
    metadata,
    nextIndex
  };
}

function parseYamlFrontMatter(lines) {
  if (lines[0]?.trim() !== "---") {
    return null;
  }

  const metadata = {};
  let index = 1;

  for (; index < lines.length; index += 1) {
    const line = lines[index];

    if (line.trim() === "---") {
      index += 1;
      break;
    }

    const entry = parseSimpleMetadataLine(line);

    if (!entry) {
      return null;
    }

    metadata[entry.key] = entry.value;
  }

  if (index > lines.length || lines[index - 1]?.trim() !== "---") {
    return null;
  }

  return {
    metadata,
    nextIndex: index
  };
}

function parseSkillBodyMetadata(text) {
  const lines = trimOuterBlankLines(normalizeText(text).split("\n"));

  if (lines.length === 0) {
    return {
      metadata: {},
      body: ""
    };
  }

  const frontMatter = parseYamlFrontMatter(lines);

  if (frontMatter) {
    return {
      metadata: frontMatter.metadata,
      body: trimOuterBlankLines(lines.slice(frontMatter.nextIndex)).join("\n")
    };
  }

  const inlineMetadata = parseYamlLikeMetadata(lines);

  return {
    metadata: inlineMetadata.metadata,
    body: trimOuterBlankLines(lines.slice(inlineMetadata.nextIndex)).join("\n")
  };
}

const LITERAL_PROTOCOL_MARKER_NAMES = ["image", "proposed_plan"];
const LITERAL_PROTOCOL_MARKER_PATTERN = new RegExp(
  `<(${LITERAL_PROTOCOL_MARKER_NAMES.join("|")})><\\/\\1>|<\\/?(?:${LITERAL_PROTOCOL_MARKER_NAMES.join("|")})>`,
  "gu"
);
const SKILL_HEADER_PATTERN =
  /^\s*<skill>\s*(?:<name>([^<\n]+)<\/name>\s*)?(?:<path>([^<\n]+)<\/path>\s*)?(?:<\/skill>\s*)?([\s\S]*)$/u;
const SKILL_TRIGGER_PATTERN = /^\$([A-Za-z0-9][A-Za-z0-9_-]*)$/u;
const SKILL_TRIGGER_LINK_PATTERN = /^\[([^\]]+)\]\(([^)\s]+)\)$/u;

function formatLiteralProtocolMarkersInSegment(text) {
  return String(text ?? "").replace(LITERAL_PROTOCOL_MARKER_PATTERN, (match) => toInlineCode(match));
}

export function formatLiteralProtocolMarkersForPresentation(text) {
  const source = String(text ?? "");
  const parts = source.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g);

  return parts
    .map((part) => {
      if (!part) {
        return part;
      }

      if (/^(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)$/u.test(part)) {
        return part;
      }

      return formatLiteralProtocolMarkersInSegment(part);
    })
    .join("");
}

export function formatLiteralImageMarkersForPresentation(text) {
  return formatLiteralProtocolMarkersForPresentation(text);
}

export function parseSkillMessagePresentation(text) {
  const source = normalizeText(text);
  const match = source.match(SKILL_HEADER_PATTERN);

  if (!match) {
    return null;
  }

  const [, headerName = "", headerPath = "", remainder = ""] = match;
  const parsedBody = parseSkillBodyMetadata(remainder);
  const name = headerName.trim() || parsedBody.metadata.name || null;
  const path = headerPath.trim() || parsedBody.metadata.path || null;
  const description = parsedBody.metadata.description || null;

  if (!name && !path && !description) {
    return null;
  }

  return {
    name,
    path,
    description,
    body: parsedBody.body
  };
}

export function parseSkillTriggerMessage(text) {
  const source = normalizeText(text).trim();
  const match = source.match(SKILL_TRIGGER_PATTERN);

  if (match) {
    return {
      name: stripSkillTriggerPrefix(match[1]),
      path: null,
      trigger: source
    };
  }

  const linkMatch = source.match(SKILL_TRIGGER_LINK_PATTERN);

  if (!linkMatch) {
    return null;
  }

  const [, label = "", target = ""] = linkMatch;
  const path = target.trim();
  const name = stripSkillTriggerPrefix(label) || skillNameFromPath(path);

  if (!name && !path) {
    return null;
  }

  return {
    name,
    path,
    trigger: source
  };
}

export function collapsePairedSkillMessages(items) {
  const sourceItems = Array.isArray(items) ? items : [];
  const collapsed = [];

  for (let index = 0; index < sourceItems.length; index += 1) {
    const current = sourceItems[index];
    const next = sourceItems[index + 1];

    const trigger =
      current?.kind === "message" && current.role === "user"
        ? parseSkillTriggerMessage(current.text)
        : null;
    const skill =
      next?.kind === "message" && next.role === "user"
        ? parseSkillMessagePresentation(next.text)
        : null;

    const namesMatch =
      trigger &&
      skill &&
      trigger.name &&
      skill.name &&
      normalizeSkillName(trigger.name) === normalizeSkillName(skill.name);
    const pathsMatch =
      trigger &&
      skill &&
      trigger.path &&
      skill.path &&
      trigger.path.trim() === skill.path.trim();

    if (trigger && skill && (namesMatch || pathsMatch)) {
      collapsed.push({
        ...next,
        timestamp: next.timestamp || current.timestamp || null,
        mergedSkillTrigger: trigger.trigger
      });
      index += 1;
      continue;
    }

    collapsed.push(current);
  }

  return collapsed;
}

export function formatSkillMessageForPresentation(text) {
  const parsed = parseSkillMessagePresentation(text);

  if (!parsed) {
    return formatLiteralProtocolMarkersForPresentation(text);
  }

  const calloutLines = ["> **Skill**", ">"];

  if (parsed.name) {
    calloutLines.push(`> - **Name:** ${toInlineCode(parsed.name)}`);
  }

  if (parsed.path) {
    calloutLines.push(`> - **Path:** ${toInlineCode(parsed.path)}`);
  }

  if (parsed.description) {
    calloutLines.push(`> - **Description:** ${parsed.description}`);
  }

  const body = trimOuterBlankText(parsed.body);

  if (!body) {
    return calloutLines.join("\n");
  }

  return `${calloutLines.join("\n")}\n\n~~~text\n${body}\n~~~`;
}

export function parseUserMessagePresentation(text) {
  const lines = normalizeText(text).split("\n");
  const filesHeadingIndex = lines.findIndex((line) => isHeading(line, "files mentioned by the user"));

  if (filesHeadingIndex === -1) {
    return null;
  }

  const requestHeadingIndex = lines.findIndex(
    (line, index) => index > filesHeadingIndex && isHeading(line, "my request for codex")
  );

  if (requestHeadingIndex === -1) {
    return null;
  }

  const preambleLines = trimOuterBlankLines(lines.slice(0, filesHeadingIndex));
  const attachmentLines = trimOuterBlankLines(lines.slice(filesHeadingIndex + 1, requestHeadingIndex));
  const requestLines = trimOuterBlankLines(lines.slice(requestHeadingIndex + 1));

  if (attachmentLines.length === 0 || requestLines.length === 0) {
    return null;
  }

  const attachments = [];

  for (const line of attachmentLines.filter((candidate) => candidate.trim() !== "")) {
    const attachment = parseAttachmentLine(line);

    if (!attachment) {
      return null;
    }

    attachments.push(attachment);
  }

  if (attachments.length === 0) {
    return null;
  }

  return {
    preambleText: preambleLines.join("\n"),
    requestText: requestLines.join("\n"),
    attachments
  };
}

export function formatUserMessageForPresentation(text) {
  const parsed = parseUserMessagePresentation(text);

  if (!parsed) {
    return formatLiteralProtocolMarkersForPresentation(text);
  }

  const calloutLines = [
    `> **${parsed.attachments.length === 1 ? "Attached file" : `Attached files (${parsed.attachments.length})`}**`,
    ">"
  ];

  parsed.attachments.forEach((attachment, index) => {
    calloutLines.push(`> - ${toInlineCode(attachment.label)}  `);
    calloutLines.push(`>   ${toInlineCode(attachment.path)}`);

    if (index < parsed.attachments.length - 1) {
      calloutLines.push(">");
    }
  });

  return formatLiteralProtocolMarkersForPresentation(
    [parsed.preambleText, calloutLines.join("\n"), parsed.requestText].filter(Boolean).join("\n\n")
  );
}

export function formatMessageTextForPresentation(text, role) {
  const parsedSkill = parseSkillMessagePresentation(text);

  if (parsedSkill) {
    return formatSkillMessageForPresentation(text);
  }

  return role === "user"
    ? formatUserMessageForPresentation(text)
    : formatLiteralProtocolMarkersForPresentation(text);
}
