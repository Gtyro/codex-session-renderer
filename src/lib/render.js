import { chromium } from "playwright";
import MarkdownIt from "markdown-it";
import { readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: false
});

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function renderMarkdownDocument({ session, markdown: markdownSource, generatedAt, titleSuffix = null }) {
  const body = markdown.render(markdownSource);
  const subtitle = [
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
        --paper: #fbf7ef;
        --ink: #1d1d1b;
        --muted: #6a6259;
        --accent: #b95c38;
        --accent-soft: rgba(185, 92, 56, 0.14);
        --panel: rgba(255, 252, 246, 0.9);
        --code-bg: #191919;
        --code-ink: #f8f5ee;
        --border: rgba(29, 29, 27, 0.12);
        --shadow: 0 24px 80px rgba(50, 34, 22, 0.18);
      }

      * {
        box-sizing: border-box;
      }

      html, body {
        margin: 0;
        padding: 0;
        background:
          radial-gradient(circle at top left, rgba(255, 193, 136, 0.38), transparent 35%),
          radial-gradient(circle at top right, rgba(208, 119, 80, 0.18), transparent 32%),
          linear-gradient(180deg, #f4efe4 0%, #efe6d6 100%);
        color: var(--ink);
      }

      body {
        font-family: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif;
        line-height: 1.65;
        padding: 56px 28px 72px;
      }

      .frame {
        width: min(1080px, 100%);
        margin: 0 auto;
      }

      .hero {
        position: relative;
        overflow: hidden;
        background: linear-gradient(145deg, rgba(255, 250, 242, 0.92), rgba(253, 244, 228, 0.84));
        border: 1px solid var(--border);
        border-radius: 28px;
        padding: 28px 30px 22px;
        box-shadow: var(--shadow);
      }

      .hero::after {
        content: "";
        position: absolute;
        inset: auto -48px -72px auto;
        width: 220px;
        height: 220px;
        border-radius: 999px;
        background: radial-gradient(circle, rgba(185, 92, 56, 0.22), transparent 70%);
      }

      .kicker {
        margin: 0 0 10px;
        text-transform: uppercase;
        letter-spacing: 0.16em;
        font-size: 12px;
        color: var(--accent);
      }

      h1 {
        margin: 0;
        font-size: clamp(32px, 5vw, 52px);
        line-height: 1.06;
      }

      .subtitle {
        margin: 14px 0 0;
        color: var(--muted);
        font-size: 14px;
      }

      .card {
        margin-top: 22px;
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 28px;
        padding: 34px 36px 42px;
        box-shadow: var(--shadow);
        backdrop-filter: blur(8px);
      }

      h2, h3 {
        font-family: "Avenir Next", "Segoe UI", sans-serif;
        letter-spacing: 0.01em;
      }

      h2 {
        margin-top: 1.9em;
        padding-bottom: 0.35em;
        border-bottom: 1px solid rgba(29, 29, 27, 0.1);
      }

      h3 {
        margin-top: 1.6em;
      }

      p, li {
        font-size: 17px;
      }

      ul {
        padding-left: 1.3em;
      }

      a {
        color: var(--accent);
      }

      code, pre {
        font-family: "IBM Plex Mono", "SFMono-Regular", Consolas, monospace;
      }

      code {
        background: rgba(185, 92, 56, 0.1);
        border-radius: 0.35em;
        padding: 0.15em 0.32em;
        font-size: 0.94em;
      }

      pre {
        background: var(--code-bg);
        color: var(--code-ink);
        padding: 18px 20px;
        border-radius: 18px;
        overflow-x: auto;
        box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.06);
      }

      pre code {
        background: transparent;
        padding: 0;
      }

      blockquote {
        margin: 1.5em 0;
        padding: 0.2em 0 0.2em 1em;
        border-left: 4px solid rgba(185, 92, 56, 0.35);
        color: var(--muted);
      }

      @media (max-width: 720px) {
        body {
          padding: 22px 14px 42px;
        }

        .hero, .card {
          border-radius: 20px;
          padding-left: 20px;
          padding-right: 20px;
        }

        .card {
          padding-top: 24px;
          padding-bottom: 28px;
        }

        p, li {
          font-size: 15px;
        }
      }
    </style>
  </head>
  <body>
    <main class="frame">
      <section class="hero">
        <p class="kicker">Codex Session ${escapeHtml(titleSuffix || "Snapshot")}</p>
        <h1>${escapeHtml(session.id)}</h1>
        <p class="subtitle">${escapeHtml(subtitle)}</p>
      </section>
      <article class="card">
        ${body}
      </article>
    </main>
  </body>
</html>
`;
}

export async function screenshotHtml({ htmlPath, imagePath, width }) {
  return screenshotHtmlWithOptions({
    htmlPath,
    imagePath,
    width,
    maxSliceHeight: 7000,
    deviceScaleFactor: 2
  });
}

export async function screenshotHtmlWithOptions({
  htmlPath,
  imagePath,
  width,
  maxSliceHeight = 7000,
  deviceScaleFactor = 2
}) {
  let browser;

  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    if (error instanceof Error && error.message.includes("Executable doesn't exist")) {
      const wrapped = new Error(
        "Playwright Chromium is not installed yet. Run `npm run install:browser` and try again."
      );
      wrapped.code = "PLAYWRIGHT_BROWSER_MISSING";
      throw wrapped;
    }

    throw error;
  }

  try {
    const page = await browser.newPage({
      viewport: {
        width,
        height: 900
      },
      deviceScaleFactor
    });

    page.setDefaultTimeout(0);
    page.setDefaultNavigationTimeout(0);

    await page.goto(pathToFileURL(htmlPath).href, {
      waitUntil: "networkidle"
    });

    const totalHeight = await page.evaluate(() =>
      Math.ceil(
        Math.max(
          document.body.scrollHeight,
          document.body.offsetHeight,
          document.documentElement.scrollHeight,
          document.documentElement.offsetHeight
        )
      )
    );

    const imagePaths = [];
    const extension = path.extname(imagePath);
    const baseName = path.basename(imagePath, extension);
    const directory = path.dirname(imagePath);
    const slices = Math.max(1, Math.ceil(totalHeight / maxSliceHeight));
    const existingFiles = await readdir(directory);

    await Promise.all(
      existingFiles
        .filter(
          (entry) =>
            entry === `${baseName}${extension}` ||
            (entry.startsWith(`${baseName}-`) && entry.endsWith(extension))
        )
        .map((entry) => unlink(path.join(directory, entry)))
    );

    for (let index = 0; index < slices; index += 1) {
      const offset = index * maxSliceHeight;
      const sliceHeight = Math.min(maxSliceHeight, totalHeight - offset);
      const targetPath =
        slices === 1
          ? imagePath
          : path.join(directory, `${baseName}-${String(index + 1).padStart(2, "0")}${extension}`);

      await page.setViewportSize({
        width,
        height: Math.max(1, sliceHeight)
      });
      await page.evaluate((scrollY) => window.scrollTo(0, scrollY), offset);
      await page.waitForTimeout(50);

      await page.screenshot({
        path: targetPath,
        type: "png",
        timeout: 0,
        animations: "disabled"
      });

      imagePaths.push(targetPath);
    }

    return imagePaths;
  } finally {
    await browser.close();
  }
}
