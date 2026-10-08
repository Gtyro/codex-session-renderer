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
  parseIdeContextMessagePresentation,
  parseSkillMessagePresentation,
  parseUserMessagePresentation
} from "../src/shared/message-presentation.js";

test("parseUserMessagePresentation extracts attachments and request text", () => {
  const parsed = parseUserMessagePresentation(`
# Files mentioned by the user:

- application.log: /workspace/demo/logs/application.log

# My request for Codex:

请检查这个日志文件。
`);

  assert.deepEqual(parsed, {
    preambleText: "",
    requestText: "请检查这个日志文件。",
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

请检查这个日志文件。
`.trim();

  const formatted = formatUserMessageForPresentation(source);

  assert.match(formatted, /> \*\*Attached file\*\*/);
  assert.match(formatted, /`application.log` — `\/workspace\/demo\/logs\/application.log`/);
  assert.doesNotMatch(formatted, /\n> - /);
  assert.doesNotMatch(formatted, /# Files mentioned by the user:/);
  assert.doesNotMatch(formatted, /# My request for Codex:/);
  assert.match(formatted, /请检查这个日志文件。/);
});

test("parseUserMessagePresentation accepts historical heading-style attachments", () => {
  const parsed = parseUserMessagePresentation(`
# Files mentioned by the user:

## example.py: /workspace/demo/src/example.py

## My request for Codex:

请修改这个程序。
`);

  assert.deepEqual(parsed, {
    preambleText: "",
    requestText: "请修改这个程序。",
    attachments: [
      {
        label: "example.py",
        path: "/workspace/demo/src/example.py"
      }
    ]
  });
});

test("parseIdeContextMessagePresentation separates IDE metadata from the user request", () => {
  const parsed = parseIdeContextMessagePresentation(`
# Context from my IDE setup:

## Active file: src/main.py

## Open tabs:
- main.py: src/main.py
- application.log: logs/application.log

## My request for Codex:
python main.py
ExampleError: sample failure

如何解决这个错误？
`.trim());

  assert.deepEqual(parsed, {
    activeFile: "src/main.py",
    openTabs: [
      { label: "main.py", path: "src/main.py" },
      { label: "application.log", path: "logs/application.log" }
    ],
    otherContextText: "",
    requestText: "python main.py\nExampleError: sample failure\n\n如何解决这个错误？"
  });
});

test("parseIdeContextMessagePresentation accepts the compact request heading emitted by newer Codex sessions", () => {
  const parsed = parseIdeContextMessagePresentation(`
# Context from my IDE setup:

## Active file: src/example.ts

## My request:
请检查示例页面。
将演示按钮文字改为“继续”。
`.trim());

  assert.deepEqual(parsed, {
    activeFile: "src/example.ts",
    openTabs: [],
    otherContextText: "",
    requestText: "请检查示例页面。\n将演示按钮文字改为“继续”。"
  });
});

test("formatted IDE context messages render metadata as a compact callout", () => {
  const source = `
# Context from my IDE setup:

## Active file: src/main.py

## Open tabs:
- main.py: src/main.py
- application.log: logs/application.log

## My request for Codex:
python main.py
ExampleError: sample failure

如何解决这个错误？
`.trim();
  const formatted = formatUserMessageForPresentation(source);

  assert.match(formatted, /> \*\*IDE context\*\*/);
  assert.match(formatted, /\*\*Active file:\*\* `src\/main.py`/);
  assert.match(formatted, /\*\*Open tabs:\*\*/);
  assert.match(formatted, /`application.log` — `logs\/application.log`/);
  assert.doesNotMatch(formatted, /# Context from my IDE setup:/);
  assert.doesNotMatch(formatted, /## My request for Codex:/);
  assert.match(formatted, /ExampleError/);
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

请检查这个日志文件。
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

test("session renderers present IDE context as metadata instead of markdown headings", () => {
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
# Context from my IDE setup:

## Active file: src/main.py

## Open tabs:
- main.py: src/main.py
- application.log: logs/application.log

## My request for Codex:
python main.py
ExampleError: sample failure

如何解决这个错误？
`.trim()
      }
    ]
  };

  const markdown = sessionToMarkdown(session, {
    mode: "full"
  });
  const interactive = buildInteractiveSession(session);

  assert.match(markdown, /> \*\*IDE context\*\*/);
  assert.doesNotMatch(markdown, /# Context from my IDE setup:/);
  assert.match(interactive.items[0].renderedHtml, /<blockquote>/);
  assert.match(interactive.items[0].renderedHtml, /Active file/);
  assert.doesNotMatch(interactive.items[0].renderedHtml, /<h1>Context from my IDE setup:<\/h1>/);
  assert.doesNotMatch(interactive.items[0].renderedHtml, /<h2>My request for Codex:<\/h2>/);
});

test("memory snapshots prioritize the actual request over IDE context", () => {
  const session = {
    id: "snapshot-ide-context",
    items: [
      {
        kind: "message",
        role: "user",
        snapshotExcerpt: true,
        text: `
# Context from my IDE setup:

## Active file: src/main.py

## Open tabs:
- main.py: src/main.py

## My request for Codex:
ExampleError: sample failure

如何解决这个错误？
`.trim()
      }
    ],
    selection: { mode: "memory_snapshot" }
  };

  const interactive = buildInteractiveSession(session);

  assert.match(interactive.items[0].renderedHtml, /ExampleError/);
  assert.match(interactive.items[0].renderedHtml, /如何解决这个错误？/);
  assert.doesNotMatch(interactive.items[0].renderedHtml, /IDE context/);
  assert.doesNotMatch(interactive.items[0].renderedHtml, /Active file/);
});

test("memory snapshots render compact mentioned-file references beside the actual request", () => {
  const session = {
    id: "snapshot-attached-file",
    items: [
      {
        kind: "message",
        role: "user",
        snapshotExcerpt: true,
        text: `
# Files mentioned by the user:

## example.py: /workspace/demo/src/example.py

## My request for Codex:

请修改这个程序。
`.trim()
      }
    ],
    selection: { mode: "memory_snapshot" }
  };

  const interactive = buildInteractiveSession(session);

  assert.match(interactive.items[0].renderedHtml, /请修改这个程序。/);
  assert.match(interactive.items[0].renderedHtml, /提及文件/);
  assert.match(interactive.items[0].renderedHtml, /example\.py/);
  assert.match(interactive.items[0].renderedHtml, /snapshot-file-reference-details/);
  assert.match(interactive.items[0].renderedHtml, /\/workspace\/demo\/src\/example\.py/);
  assert.doesNotMatch(interactive.items[0].renderedHtml, /Files mentioned by the user/);
});

test("memory snapshots extract Windows file line ranges from mentioned-file references", () => {
  const session = {
    id: "snapshot-windows-mentioned-file",
    items: [
      {
        kind: "message",
        role: "user",
        snapshotExcerpt: true,
        text: `
# Files mentioned by the user:

## README.md: c:\\Users\\example\\Documents\\Project\\DemoApp\\README.md (lines 67-68)

# My request for Codex:

这一步有必要吗？依赖应该已经安装。
`.trim()
      }
    ],
    selection: { mode: "memory_snapshot" }
  };

  const interactive = buildInteractiveSession(session);

  assert.match(interactive.items[0].renderedHtml, /README\.md/);
  assert.match(interactive.items[0].renderedHtml, /第 67–68 行/);
  assert.match(interactive.items[0].renderedHtml, /c:\\Users\\example\\Documents\\Project\\DemoApp\\README\.md/);
  assert.match(interactive.items[0].renderedHtml, /这一步有必要吗？依赖应该已经安装。/);
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

test("interactive session derives token stats from token snapshots", () => {
  const user = {
    kind: "message",
    role: "user",
    timestamp: "2026-06-23T00:00:00.000Z",
    text: "需求 A"
  };
  const assistant = {
    kind: "message",
    role: "assistant",
    timestamp: "2026-06-23T00:00:01.000Z",
    text: "处理中",
    phase: "commentary"
  };
  const toolCall = {
    kind: "tool_call",
    timestamp: "2026-06-23T00:00:02.000Z",
    name: "exec_command",
    body: "echo hello"
  };
  const toolOutput = {
    kind: "tool_output",
    timestamp: "2026-06-23T00:00:03.000Z",
    name: "exec_command",
    body: "ok"
  };
  const interactive = buildInteractiveSession({
    id: "session-demo",
    filePath: "/tmp/session-demo.jsonl",
    startedAt: "2026-06-23T00:00:00.000Z",
    cwd: "/tmp",
    source: "codex",
    originator: "codex",
    cliVersion: "0.0.0",
    modelProvider: "openai",
    items: [user, assistant, toolCall, toolOutput],
    tokenSnapshots: [
      {
        tokens: 100,
        cumulativeTokens: 100,
        inputTokens: 80,
        cachedInputTokens: 0,
        outputTokens: 20,
        reasoningOutputTokens: 0,
        startIndex: 0,
        endIndex: 2,
        items: [user, assistant]
      },
      {
        tokens: 50,
        cumulativeTokens: 150,
        inputTokens: 20,
        cachedInputTokens: 0,
        outputTokens: 30,
        reasoningOutputTokens: 0,
        startIndex: 2,
        endIndex: 4,
        items: [toolCall, toolOutput]
      }
    ]
  });

  assert.equal(interactive.tokenStats.totalTokens, 150);
  assert.ok(interactive.tokenStats.knownTokens < interactive.tokenStats.totalTokens);
  assert.ok(interactive.tokenStats.hiddenTokens > 0);
  assert.ok(interactive.tokenStats.categories.some((entry) => entry.key === "assistant"));
  assert.ok(interactive.tokenStats.categories.some((entry) => entry.key === "tool"));
  assert.ok(interactive.tokenStats.categories.some((entry) => entry.key === "hidden"));
  assert.equal(interactive.tokenSegments.length, 2);
  assert.equal(interactive.tokenSegments[0].startIndex, 0);
  assert.equal(interactive.tokenSegments[1].endIndex, 4);
  assert.equal(interactive.tokenStats.toolStats.totalCount, 2);
  assert.deepEqual(interactive.tokenStats.unattributedStats, {
    totalCount: 2,
    webSearchCount: 0,
    truncatedCount: 0,
    noVisibleDataCount: 0,
    residualCount: 2
  });
});

test("interactive session groups web_search token usage by call and overall share", () => {
  const user = {
    kind: "message",
    role: "user",
    timestamp: "2026-06-23T00:00:00.000Z",
    text: "需求 A"
  };
  const assistant = {
    kind: "message",
    role: "assistant",
    timestamp: "2026-06-23T00:00:01.000Z",
    text: "处理中",
    phase: "commentary"
  };
  const webSearchCall = {
    kind: "tool_call",
    timestamp: "2026-06-23T00:00:02.000Z",
    name: "web_search",
    callId: "ws-1",
    body: "{\n  \"query\": \"codex\"\n}"
  };
  const webSearchOutput = {
    kind: "tool_output",
    timestamp: "2026-06-23T00:00:03.000Z",
    name: "web_search",
    callId: "ws-1",
    body: "{\n  \"results\": []\n}"
  };
  const execCall = {
    kind: "tool_call",
    timestamp: "2026-06-23T00:00:04.000Z",
    name: "exec_command",
    callId: "exec-1",
    body: "echo hello"
  };
  const execOutput = {
    kind: "tool_output",
    timestamp: "2026-06-23T00:00:05.000Z",
    name: "exec_command",
    callId: "exec-1",
    body: "ok"
  };
  const interactive = buildInteractiveSession({
    id: "session-demo",
    filePath: "/tmp/session-demo.jsonl",
    startedAt: "2026-06-23T00:00:00.000Z",
    cwd: "/tmp",
    source: "codex",
    originator: "codex",
    cliVersion: "0.0.0",
    modelProvider: "openai",
    items: [user, assistant, webSearchCall, webSearchOutput, execCall, execOutput],
    tokenSnapshots: [
      {
        tokens: 100,
        cumulativeTokens: 100,
        inputTokens: 80,
        cachedInputTokens: 0,
        outputTokens: 20,
        reasoningOutputTokens: 0,
        startIndex: 0,
        endIndex: 2,
        items: [user, assistant]
      },
      {
        tokens: 30,
        cumulativeTokens: 130,
        inputTokens: 10,
        cachedInputTokens: 0,
        outputTokens: 20,
        reasoningOutputTokens: 0,
        startIndex: 0,
        endIndex: 2,
        items: [webSearchCall, webSearchOutput]
      },
      {
        tokens: 20,
        cumulativeTokens: 150,
        inputTokens: 8,
        cachedInputTokens: 0,
        outputTokens: 12,
        reasoningOutputTokens: 0,
        startIndex: 2,
        endIndex: 4,
        items: [execCall, execOutput]
      }
    ]
  });

  const webSearchGroup = interactive.tokenStats.toolStats.groups.find((entry) => entry.key === "web_search");

  assert.ok(webSearchGroup);
  assert.equal(interactive.tokenStats.toolStats.totalCount, 2);
  assert.equal(webSearchGroup.count, 1);
  assert.equal(webSearchGroup.instances[0].shareOfToolTotal, 1);
  assert.ok(interactive.tokenStats.hiddenTokens > 0);
  assert.ok(interactive.tokenStats.categories.some((entry) => entry.key === "hidden"));
  assert.deepEqual(interactive.tokenStats.unattributedStats, {
    totalCount: 3,
    webSearchCount: 1,
    truncatedCount: 0,
    noVisibleDataCount: 0,
    residualCount: 2
  });
});

test("interactive session carries explicit truncation markers into tool stats", () => {
  const user = {
    kind: "message",
    role: "user",
    timestamp: "2026-06-23T00:00:00.000Z",
    text: "需求 A"
  };
  const toolCall = {
    kind: "tool_call",
    timestamp: "2026-06-23T00:00:01.000Z",
    name: "exec_command",
    callId: "exec-1",
    body: "rg foo"
  };
  const toolOutput = {
    kind: "tool_output",
    timestamp: "2026-06-23T00:00:02.000Z",
    name: "exec_command",
    callId: "exec-1",
    body: "Total output lines: 3034\n/tmp/demo",
    isTruncated: true,
    truncationReason: "日志截断"
  };
  const interactive = buildInteractiveSession({
    id: "session-demo",
    filePath: "/tmp/session-demo.jsonl",
    startedAt: "2026-06-23T00:00:00.000Z",
    cwd: "/tmp",
    source: "codex",
    originator: "codex",
    cliVersion: "0.0.0",
    modelProvider: "openai",
    items: [user, toolCall, toolOutput],
    tokenSnapshots: [
      {
        tokens: 100,
        cumulativeTokens: 100,
        inputTokens: 60,
        cachedInputTokens: 0,
        outputTokens: 40,
        reasoningOutputTokens: 0,
        startIndex: 0,
        endIndex: 3,
        items: [user, toolCall, toolOutput]
      }
    ]
  });

  const execGroup = interactive.tokenStats.toolStats.groups.find((entry) => entry.key === "exec_command");

  assert.equal(interactive.tokenStats.explicitTruncationCount, 1);
  assert.ok(execGroup);
  assert.equal(execGroup.truncatedCount, 1);
  assert.equal(execGroup.instances[0].isTruncated, true);
  assert.equal(execGroup.instances[0].truncationReason, "日志截断");
  assert.deepEqual(interactive.tokenStats.unattributedStats, {
    totalCount: 1,
    webSearchCount: 0,
    truncatedCount: 1,
    noVisibleDataCount: 0,
    residualCount: 0
  });
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
