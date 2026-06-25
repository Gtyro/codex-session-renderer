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
    titleSuffix
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
  const sourceItems = collapsePairedSkillMessages(session.items);
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
    ...session,
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
