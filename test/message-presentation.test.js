import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { sessionToMarkdown } from "../src/core/markdown.js";
import { loadSession } from "../src/core/session-parser.js";
import { buildInteractiveSession } from "../src/core/session-view-model.js";
import {
  collapsePairedSkillMessages,
  formatLiteralProtocolMarkersForPresentation,
  formatLiteralImageMarkersForPresentation,
  formatSkillMessageForPresentation,
  parseSkillTriggerMessage,
  formatUserMessageForPresentation,
  parseSkillMessagePresentation,
  parseUserMessagePresentation
} from "../src/shared/message-presentation.js";

test("parseUserMessagePresentation extracts attachments and request text", () => {
  const parsed = parseUserMessagePresentation(`
# Files mentioned by the user:

- application.log: /workspace/demo/logs/application.log

# My request for Codex:

Please inspect this log file.
`);

  assert.deepEqual(parsed, {
    preambleText: "",
    requestText: "Please inspect this log file.",
    attachments: [
      {
        label: "application.log",
        path: "/workspace/demo/logs/application.log"
      }
    ]
  });
});

test("formatted user messages render attachments as a callout instead of large headings", () => {
  const source = `
# Files mentioned by the user:

application.log: /workspace/demo/logs/application.log

# My request for Codex:

Please inspect this log file.
`.trim();

  const formatted = formatUserMessageForPresentation(source);

  assert.match(formatted, /> \*\*Attached file\*\*/);
  assert.doesNotMatch(formatted, /# Files mentioned by the user:/);
  assert.doesNotMatch(formatted, /# My request for Codex:/);
  assert.match(formatted, /Please inspect this log file./);
});

test("formatLiteralImageMarkersForPresentation renders literal image markers as inline code", () => {
  const formatted = formatLiteralImageMarkersForPresentation("出现了奇怪的<image></image>");

  assert.equal(formatted, "出现了奇怪的`<image></image>`");
});

test("formatLiteralProtocolMarkersForPresentation renders literal proposed plan markers as inline code", () => {
  const formatted = formatLiteralProtocolMarkersForPresentation("这里还有<proposed_plan></proposed_plan>");

  assert.equal(formatted, "这里还有`<proposed_plan></proposed_plan>`");
});

test("formatLiteralImageMarkersForPresentation leaves existing code spans unchanged", () => {
  const formatted = formatLiteralImageMarkersForPresentation("这里已经有 `&lt;image&gt;&lt;/image&gt;` 和 `<image>`");

  assert.equal(formatted, "这里已经有 `&lt;image&gt;&lt;/image&gt;` 和 `<image>`");
});

test("parseSkillMessagePresentation extracts skill header metadata and body", () => {
  const parsed = parseSkillMessagePresentation(`
<skill>
<name>commit-workflow</name>
<path>/workspace/.codex/skills/commit-workflow/SKILL.md</path>

---
name: commit-workflow
description: Stage git changes with git add.
---

# Commit Workflow

Stage changes safely.
`);

  assert.deepEqual(parsed, {
    name: "commit-workflow",
    path: "/workspace/.codex/skills/commit-workflow/SKILL.md",
    description: "Stage git changes with git add.",
    body: "# Commit Workflow\n\nStage changes safely."
  });
});

test("formatted skill messages render a skill callout and keep body as code", () => {
  const formatted = formatSkillMessageForPresentation(`
<skill> <name>commit-workflow</name>
<path>/workspace/.codex/skills/commit-workflow/SKILL.md</path>

name: commit-workflow
description: Stage git changes with git add.

# Commit Workflow
`);

  assert.match(formatted, /> \*\*Skill\*\*/);
  assert.match(formatted, /- \*\*Name:\*\* `commit-workflow`/);
  assert.match(formatted, /~~~text\n# Commit Workflow\n~~~/);
  assert.doesNotMatch(formatted, /<skill>/);
});

test("parseSkillTriggerMessage extracts trigger names from standalone skill calls", () => {
  assert.deepEqual(parseSkillTriggerMessage("$commit-workflow"), {
    name: "commit-workflow",
    path: null,
    trigger: "$commit-workflow"
  });
  assert.deepEqual(
    parseSkillTriggerMessage("[$commit-workflow](/workspace/.codex/skills/commit-workflow/SKILL.md)"),
    {
      name: "commit-workflow",
      path: "/workspace/.codex/skills/commit-workflow/SKILL.md",
      trigger: "[$commit-workflow](/workspace/.codex/skills/commit-workflow/SKILL.md)"
    }
  );
  assert.equal(parseSkillTriggerMessage("请使用 $commit-workflow"), null);
});

test("collapsePairedSkillMessages merges a skill trigger with the following skill payload", () => {
  const items = collapsePairedSkillMessages([
    {
      kind: "message",
      role: "user",
      timestamp: "2026-06-23T03:48:00.000Z",
      text: "[$commit-workflow](/workspace/.codex/skills/commit-workflow/SKILL.md)"
    },
    {
      kind: "message",
      role: "user",
      timestamp: "2026-06-23T03:48:01.000Z",
      text: `
<skill>
<name>commit-workflow</name>
<path>/workspace/.codex/skills/commit-workflow/SKILL.md</path>

name: commit-workflow
description: Stage git changes with git add.

# Commit Workflow
`.trim()
    }
  ]);

  assert.equal(items.length, 1);
  assert.equal(
    items[0].mergedSkillTrigger,
    "[$commit-workflow](/workspace/.codex/skills/commit-workflow/SKILL.md)"
  );
  assert.match(items[0].text, /<name>commit-workflow<\/name>/);
});

test("session renderers reuse the presentation transform for markdown and interactive html", () => {
  const session = {
    id: "session-demo",
    filePath: "/tmp/session-demo.jsonl",
    startedAt: "2026-06-23T00:00:00.000Z",
    cwd: "/tmp",
    source: "codex",
    originator: "codex",
    cliVersion: "0.0.0",
    modelProvider: "openai",
    items: [
      {
        kind: "message",
        role: "user",
        timestamp: "2026-06-23T00:00:00.000Z",
        text: `
# Files mentioned by the user:

application.log: /workspace/demo/logs/application.log

# My request for Codex:

Please inspect this log file.
`.trim()
      }
    ]
  };

  const markdown = sessionToMarkdown(session, {
    mode: "full"
  });
  const interactive = buildInteractiveSession(session);

  assert.match(markdown, /> \*\*Attached file\*\*/);
  assert.doesNotMatch(markdown, /# Files mentioned by the user:/);
  assert.match(interactive.items[0].renderedHtml, /<blockquote>/);
  assert.doesNotMatch(interactive.items[0].renderedHtml, /Files mentioned by the user/);
});

test("interactive session renders structured image attachments as image cards", () => {
  const session = {
    id: "session-demo",
    filePath: "/tmp/session-demo.jsonl",
    startedAt: "2026-06-23T00:00:00.000Z",
    cwd: "/tmp",
    source: "codex",
    originator: "codex",
    cliVersion: "0.0.0",
    modelProvider: "openai",
    items: [
      {
        kind: "message",
        role: "user",
        timestamp: "2026-06-23T00:00:00.000Z",
        text: "请看这张图\n\n[Image attachment: high]",
        contentBlocks: [
          {
            kind: "text",
            blockType: "input_text",
            text: "请看这张图"
          },
          {
            kind: "image",
            blockType: "input_image",
            imageUrl: "data:image/png;base64,AAAA",
            detail: "high"
          }
        ]
      }
    ]
  };

  const interactive = buildInteractiveSession(session);

  assert.match(interactive.items[0].renderedHtml, /message-image-card/);
  assert.match(interactive.items[0].renderedHtml, /<img /);
  assert.doesNotMatch(interactive.items[0].renderedHtml, /Image attachment: high/);
});

test("interactive session renders skill payloads as skill cards instead of markdown headings", () => {
  const session = {
    id: "session-demo",
    filePath: "/tmp/session-demo.jsonl",
    startedAt: "2026-06-23T00:00:00.000Z",
    cwd: "/tmp",
    source: "codex",
    originator: "codex",
    cliVersion: "0.0.0",
    modelProvider: "openai",
    items: [
      {
        kind: "message",
        role: "user",
        timestamp: "2026-06-23T00:00:00.000Z",
        text: "[$commit-workflow](/workspace/.codex/skills/commit-workflow/SKILL.md)"
      },
      {
        kind: "message",
        role: "user",
        timestamp: "2026-06-23T00:00:01.000Z",
        text: `
<skill>
<name>commit-workflow</name>
<path>/workspace/.codex/skills/commit-workflow/SKILL.md</path>

name: commit-workflow
description: Stage git changes with git add.

# Commit Workflow

1. Inspect workspace state.
`.trim(),
        contentBlocks: [
          {
            kind: "text",
            blockType: "input_text",
            text: `
<skill>
<name>commit-workflow</name>
<path>/workspace/.codex/skills/commit-workflow/SKILL.md</path>

name: commit-workflow
description: Stage git changes with git add.

# Commit Workflow

1. Inspect workspace state.
`.trim()
          }
        ]
      }
    ]
  };

  const interactive = buildInteractiveSession(session);
  const markdown = sessionToMarkdown(session, {
    mode: "full"
  });

  assert.equal(interactive.items.length, 1);
  assert.equal(interactive.conversationBlocks[0].userMessageCount, 1);
  assert.match(interactive.items[0].renderedHtml, /message-skill-card/);
  assert.match(interactive.items[0].renderedHtml, /<details class="message-media message-skill-card">/);
  assert.match(interactive.items[0].renderedHtml, /commit-workflow/);
  assert.match(interactive.items[0].renderedHtml, /Description/);
  assert.match(interactive.items[0].renderedHtml, /<pre><code># Commit Workflow/);
  assert.doesNotMatch(interactive.items[0].renderedHtml, /<h1>Commit Workflow<\/h1>/);
  assert.doesNotMatch(interactive.items[0].renderedHtml, /&lt;skill&gt;/);
  assert.doesNotMatch(markdown, /\$commit-workflow/);
  assert.equal(markdown.match(/### \d+\. User/g)?.length ?? 0, 1);
});

test("session renderers show literal image markers in user text as code beside image cards", () => {
  const session = {
    id: "session-demo",
    filePath: "/tmp/session-demo.jsonl",
    startedAt: "2026-06-23T00:00:00.000Z",
    cwd: "/tmp",
    source: "codex",
    originator: "codex",
    cliVersion: "0.0.0",
    modelProvider: "openai",
    items: [
      {
        kind: "message",
        role: "user",
        timestamp: "2026-06-23T00:00:00.000Z",
        text: "出现了奇怪的<image></image>\n\n[Image attachment: high]",
        contentBlocks: [
          {
            kind: "text",
            blockType: "input_text",
            text: "出现了奇怪的<image></image>"
          },
          {
            kind: "image",
            blockType: "input_image",
            imageUrl: "data:image/png;base64,AAAA",
            detail: "high"
          }
        ]
      }
    ]
  };

  const markdown = sessionToMarkdown(session, {
    mode: "full"
  });
  const interactive = buildInteractiveSession(session);

  assert.match(markdown, /`<image><\/image>`/);
  assert.match(interactive.items[0].renderedHtml, /<code>&lt;image&gt;&lt;\/image&gt;<\/code>/);
  assert.match(interactive.items[0].renderedHtml, /message-image-card/);
});

test("session renderers hide standalone proposed plan wrapper markers in assistant output", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "csr-message-presentation-"));
  const filePath = path.join(tempDir, "session.jsonl");

  try {
    await writeFile(
      filePath,
      `${JSON.stringify({
        type: "response_item",
        timestamp: "2026-06-23T00:00:00.000Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "<proposed_plan>\n\n# Demo Project: Session Workspace and Screenshot Support\n\n</proposed_plan>"
            }
          ]
        }
      })}\n`,
      "utf8"
    );

    const session = await loadSession(filePath);
    const markdown = sessionToMarkdown(session, {
      mode: "full"
    });
    const interactive = buildInteractiveSession(session);

    assert.doesNotMatch(markdown, /proposed_plan/);
    assert.match(markdown, /# Demo Project: Session Workspace and Screenshot Support/);
    assert.doesNotMatch(interactive.items[0].renderedHtml, /proposed_plan/);
    assert.match(interactive.items[0].renderedHtml, /Demo Project: Session Workspace and Screenshot Support/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
