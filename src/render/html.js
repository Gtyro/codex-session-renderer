import { getInstalledFontUrls } from "../core/font-assets.js";
import { renderMarkdownFragment } from "./fragment.js";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function stripHtmlTags(value) {
  return String(value ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isToolHeading(headingText) {
  return /^\d+\.\s+Tool(?:\b|\s|-)/.test(headingText);
}

function enhanceRenderedBody(body) {
  const parts = String(body ?? "").split(/(<h3>.*?<\/h3>)/gs);

  if (parts.length < 3) {
    return body;
  }

  let hasToolGroup = false;
  let result = parts[0] || "";

  for (let index = 1; index < parts.length; index += 2) {
    const headingHtml = parts[index];
    const contentHtml = parts[index + 1] || "";
    const headingText = stripHtmlTags(headingHtml);

    if (isToolHeading(headingText)) {
      hasToolGroup = true;
      result += `
<details class="entry-group tool-group">
  <summary>
    <span class="entry-summary-title">${headingText}</span>
    <span class="entry-summary-hint">Expand</span>
  </summary>
  <div class="entry-body">${contentHtml.trim()}</div>
</details>`;
      continue;
    }

    result += `
<section class="entry-group">
  ${headingHtml}
  <div class="entry-body">${contentHtml.trim()}</div>
</section>`;
  }

  if (!hasToolGroup) {
    return result;
  }

  return `
<div class="transcript-toolbar">
  <button type="button" data-action="expand-tools">Expand tools</button>
  <button type="button" data-action="collapse-tools">Collapse tools</button>
</div>
${result}`;
}

function getOptionalInstalledFontUrls() {
  try {
    return getInstalledFontUrls();
  } catch (error) {
    if (error && error.code === "FONT_ASSETS_MISSING") {
      return null;
    }

    throw error;
  }
}

export function renderMarkdownDocument({
  session,
  markdown: markdownSource,
  generatedAt,
  titleSuffix = null,
  fontUrls = getOptionalInstalledFontUrls(),
  includeBrowserClientLifecycleTracking = false
}) {
  const body = enhanceRenderedBody(renderMarkdownFragment(markdownSource));
  const subtitle = [
    `Session ${session.id}`,
    session.startedAt ? `Started ${session.startedAt}` : null,
    session.cwd ? `cwd ${session.cwd}` : null,
    generatedAt ? `Rendered ${generatedAt}` : null
  ]
    .filter(Boolean)
    .join("  |  ");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Codex Session ${escapeHtml(session.id)}${titleSuffix ? ` - ${escapeHtml(titleSuffix)}` : ""}</title>
    <style>
      :root {
        --bg: #f5f7fa;
        --panel: #ffffff;
        --panel-soft: #f8fafc;
        --ink: #0f172a;
        --muted: #667085;
        --accent: #0f766e;
        --accent-soft: rgba(15, 118, 110, 0.08);
        --code-bg: #0f172a;
        --code-ink: #e2e8f0;
        --border: #e5e7eb;
        --shadow: 0 12px 36px rgba(15, 23, 42, 0.08);
      }

      * {
        box-sizing: border-box;
      }

      ${
        fontUrls
          ? `@font-face {
        font-family: "Source Han Sans SC";
        src: url("${escapeHtml(fontUrls.regular)}") format("opentype");
        font-style: normal;
        font-weight: 400;
        font-display: swap;
      }

      @font-face {
        font-family: "Source Han Sans SC";
        src: url("${escapeHtml(fontUrls.bold)}") format("opentype");
        font-style: normal;
        font-weight: 700;
        font-display: swap;
      }`
          : ""
      }

      html, body {
        margin: 0;
        padding: 0;
        background: var(--bg);
        color: var(--ink);
      }

      body {
        font-family: "IBM Plex Sans", "Segoe UI", "Source Han Sans SC", "PingFang SC", sans-serif;
        line-height: 1.6;
        padding: 24px;
      }

      .shell {
        width: min(1100px, 100%);
        margin: 0 auto;
      }

      .header {
        border: 1px solid var(--border);
        border-radius: 16px;
        padding: 18px 20px;
        background: var(--panel);
        box-shadow: var(--shadow);
      }

      .kicker {
        margin: 0 0 8px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        font-size: 11px;
        color: var(--accent);
        font-weight: 600;
      }

      h1 {
        margin: 0;
        font-size: clamp(16px, 2.4vw, 20px);
        line-height: 1.15;
        letter-spacing: -0.01em;
        font-weight: 600;
      }

      .subtitle {
        margin: 8px 0 0;
        color: var(--muted);
        font-size: 12px;
        font-family: "IBM Plex Mono", "SFMono-Regular", "Source Han Sans SC", Consolas, monospace;
        line-height: 1.5;
      }

      .content {
        margin-top: 16px;
        border: 1px solid var(--border);
        border-radius: 16px;
        padding: 24px 28px 32px;
        background: var(--panel);
        box-shadow: var(--shadow);
      }

      h2, h3 {
        font-family: inherit;
        letter-spacing: -0.01em;
      }

      h2 {
        margin-top: 2em;
        padding-bottom: 0.4em;
        border-bottom: 1px solid var(--border);
        font-size: 20px;
      }

      h3 {
        margin-top: 1.5em;
        font-size: 16px;
      }

      .entry-group {
        margin-top: 18px;
      }

      .entry-group:first-of-type {
        margin-top: 0;
      }

      .entry-body > :first-child {
        margin-top: 0;
      }

      .entry-body > :last-child {
        margin-bottom: 0;
      }

      .tool-group {
        border: 1px solid var(--border);
        border-radius: 12px;
        background: #fcfcfd;
        overflow: hidden;
      }

      .tool-group summary {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 12px 14px;
        cursor: pointer;
        list-style: none;
        user-select: none;
      }

      .tool-group summary::-webkit-details-marker {
        display: none;
      }

      .tool-group summary:hover {
        background: #f8fafc;
      }

      .tool-group[open] summary {
        border-bottom: 1px solid var(--border);
      }

      .entry-summary-title {
        font-size: 14px;
        font-weight: 600;
      }

      .entry-summary-hint {
        color: var(--muted);
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }

      .tool-group[open] .entry-summary-hint {
        content: "Collapse";
      }

      .tool-group .entry-body {
        padding: 0 14px 14px;
      }

      .transcript-toolbar {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-bottom: 16px;
      }

      .transcript-toolbar button {
        border: 1px solid var(--border);
        border-radius: 8px;
        background: var(--panel-soft);
        color: var(--muted-strong);
        padding: 6px 10px;
        cursor: pointer;
      }

      .transcript-toolbar button:hover {
        background: #eef2f7;
      }

      p, li {
        font-size: 15px;
      }

      ul {
        padding-left: 1.3em;
      }

      a {
        color: var(--accent);
      }

      code, pre {
        font-family: "IBM Plex Mono", "SFMono-Regular", "Source Han Sans SC", Consolas, monospace;
      }

      code {
        background: var(--panel-soft);
        border: 1px solid rgba(148, 163, 184, 0.18);
        border-radius: 6px;
        padding: 0.15em 0.32em;
        font-size: 0.92em;
      }

      pre {
        background: var(--code-bg);
        color: var(--code-ink);
        padding: 16px 18px;
        border-radius: 12px;
        overflow-x: auto;
        box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.06);
      }

      pre code {
        background: transparent;
        border: 0;
        padding: 0;
      }

      blockquote {
        margin: 1.5em 0;
        padding: 0.2em 0 0.2em 1em;
        border-left: 3px solid rgba(15, 118, 110, 0.3);
        color: var(--muted);
        background: rgba(15, 118, 110, 0.03);
      }

      @media (max-width: 720px) {
        body {
          padding: 12px;
        }

        .header,
        .content {
          border-radius: 14px;
          padding-left: 16px;
          padding-right: 16px;
        }

        .content {
          padding-top: 18px;
          padding-bottom: 24px;
        }

        p, li {
          font-size: 15px;
        }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <section class="header">
        <p class="kicker">Codex Session ${escapeHtml(titleSuffix || "Snapshot")}</p>
        <h1>${escapeHtml(`Codex Session ${titleSuffix || "Preview"}`)}</h1>
        <p class="subtitle">${escapeHtml(subtitle)}</p>
      </section>
      <article class="content">
        ${body}
      </article>
    </main>
    <script>
      document.querySelector('[data-action="expand-tools"]')?.addEventListener("click", () => {
        document.querySelectorAll("details.tool-group").forEach((node) => {
          node.open = true;
        });
      });

      document.querySelector('[data-action="collapse-tools"]')?.addEventListener("click", () => {
        document.querySelectorAll("details.tool-group").forEach((node) => {
          node.open = false;
        });
      });

      document.querySelectorAll("details.tool-group").forEach((node) => {
        const hint = node.querySelector(".entry-summary-hint");
        if (!hint) {
          return;
        }

        const sync = () => {
          hint.textContent = node.open ? "Collapse" : "Expand";
        };

        sync();
        node.addEventListener("toggle", sync);
      });
    </script>
    ${
      includeBrowserClientLifecycleTracking
        ? '<script type="module" src="/assets/browser-client-lifecycle.js"></script>'
        : ""
    }
  </body>
</html>
`;
}
