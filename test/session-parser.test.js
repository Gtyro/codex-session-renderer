import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  loadSessionMemorySnapshot,
  loadSession,
  selectSessionMemorySnapshot,
  selectRecentRounds,
  splitSessionIntoRounds
} from "../src/core/session-parser.js";

function buildMessage(role, text, options = {}) {
  return {
    kind: "message",
    role,
    phase: options.phase || null,
    text,
    timestamp: options.timestamp || null,
    isContextPrelude: options.isContextPrelude || false
  };
}

function buildToolEvent(name) {
  return {
    kind: "tool_call",
    name,
    body: "{}",
    timestamp: null
  };
}

function buildTokenSnapshot(tokens, items, options = {}) {
  return {
    tokens,
    cumulativeTokens: options.cumulativeTokens ?? tokens,
    inputTokens: options.inputTokens ?? tokens,
    cachedInputTokens: options.cachedInputTokens ?? 0,
    outputTokens: options.outputTokens ?? 0,
    reasoningOutputTokens: options.reasoningOutputTokens ?? 0,
    startIndex: options.startIndex ?? 0,
    endIndex: options.endIndex ?? items.length,
    items
  };
}

test("selectRecentRounds keeps multiple user messages that belong to one final answer block", () => {
  const session = {
    id: "demo",
    items: [
      buildMessage("user", "需求 A"),
      buildMessage("assistant", "先看一下", { phase: "commentary" }),
      buildToolEvent("exec_command"),
      buildMessage("user", "补充需求 B"),
      buildMessage("assistant", "最后总结", { phase: "final_answer" }),
      buildMessage("user", "下一轮需求"),
      buildMessage("assistant", "下一轮总结", { phase: "final_answer" })
    ]
  };

  const selected = selectRecentRounds(session, 1);

  assert.equal(selected.selection.roundsIncluded, 1);
  assert.deepEqual(
    selected.items.map((item) => item.text || item.name),
    ["下一轮需求", "下一轮总结"]
  );

  const previousRound = selectRecentRounds(session, 2);

  assert.deepEqual(
    previousRound.items.map((item) => item.text || item.name),
    ["需求 A", "先看一下", "exec_command", "补充需求 B", "最后总结", "下一轮需求", "下一轮总结"]
  );
});

test("selectRecentRounds trims token snapshots together with the selected rounds", () => {
  const firstUser = buildMessage("user", "需求 A");
  const firstAssistant = buildMessage("assistant", "处理 1", { phase: "final_answer" });
  const secondUser = buildMessage("user", "需求 B");
  const secondAssistant = buildMessage("assistant", "处理 2", { phase: "final_answer" });
  const session = {
    id: "demo",
    items: [firstUser, firstAssistant, secondUser, secondAssistant],
    tokenSnapshots: [
      buildTokenSnapshot(100, [firstUser, firstAssistant], {
        cumulativeTokens: 100,
        startIndex: 0,
        endIndex: 2
      }),
      buildTokenSnapshot(60, [secondUser, secondAssistant], {
        cumulativeTokens: 160,
        startIndex: 2,
        endIndex: 4
      })
    ]
  };

  const selected = selectRecentRounds(session, 1);

  assert.deepEqual(
    selected.items.map((item) => item.text),
    ["需求 B", "处理 2"]
  );
  assert.equal(selected.tokenSnapshots.length, 1);
  assert.equal(selected.tokenSnapshots[0].tokens, 60);
  assert.deepEqual(
    selected.tokenSnapshots[0].items.map((item) => item.text),
    ["需求 B", "处理 2"]
  );
});

test("selectSessionMemorySnapshot keeps the first request and the last two requests with their answers", () => {
  const session = {
    id: "demo",
    items: [
      buildMessage("user", "最初需求"),
      buildMessage("assistant", "最初总结", { phase: "final_answer" }),
      buildMessage("user", "中间需求"),
      buildToolEvent("exec_command"),
      buildMessage("assistant", "中间总结", { phase: "final_answer" }),
      buildMessage("user", "倒数第二个需求"),
      buildMessage("assistant", "倒数第二个总结", { phase: "final_answer" }),
      buildMessage("user", "最新需求"),
      buildMessage("assistant", "最新总结", { phase: "final_answer" })
    ],
    tokenSnapshots: [buildTokenSnapshot(300, [])]
  };

  const snapshot = selectSessionMemorySnapshot(session);

  assert.deepEqual(
    snapshot.items.map((item) => item.text),
    ["最初需求", "最初总结", "倒数第二个需求", "倒数第二个总结", "最新需求", "最新总结"]
  );
  assert.equal(snapshot.items[0].snapshotLabel, "首个请求");
  assert.equal(snapshot.items[2].snapshotLabel, "倒数第 2 个请求");
  assert.equal(snapshot.items[4].snapshotLabel, "最新请求");
  assert.equal(snapshot.selection.mode, "memory_snapshot");
  assert.equal(snapshot.selection.totalRounds, 4);
  assert.equal(snapshot.selection.omittedItems, 3);
  assert.equal(snapshot.selection.totalTokens, 300);
  assert.deepEqual(snapshot.tokenSnapshots, []);
});

test("selectSessionMemorySnapshot falls back to the latest assistant progress when a request has no final answer", () => {
  const session = {
    id: "demo",
    items: [
      buildMessage("user", "仍在处理的需求"),
      buildMessage("assistant", "正在检查", { phase: "commentary" }),
      buildToolEvent("exec_command")
    ]
  };

  const snapshot = selectSessionMemorySnapshot(session);

  assert.deepEqual(snapshot.items.map((item) => item.text || item.name), ["仍在处理的需求", "正在检查"]);
  assert.equal(snapshot.selection.omittedItems, 1);
});

test("selectSessionMemorySnapshot ignores injected turn-aborted control messages", () => {
  const session = {
    id: "demo",
    items: [
      buildMessage("user", "First request"),
      buildMessage("assistant", "First answer", { phase: "final_answer" }),
      buildMessage("user", "Second-last request"),
      buildMessage("user", "<turn_aborted>The user interrupted the previous turn.</turn_aborted>"),
      buildMessage("user", "Latest request"),
      buildMessage("assistant", "Latest answer", { phase: "final_answer" })
    ]
  };

  const snapshot = selectSessionMemorySnapshot(session);

  assert.deepEqual(
    snapshot.items.map((item) => item.text),
    ["First request", "First answer", "Second-last request", "Latest request", "Latest answer"]
  );
  assert.equal(snapshot.selection.totalUserMessages, 3);
});

test("selectSessionMemorySnapshot keeps legacy unphased answers with their own requests", () => {
  const session = {
    id: "legacy-demo",
    items: [
      buildMessage("user", "首个请求"),
      buildMessage("assistant", "首个答复"),
      buildMessage("user", "倒数第二个请求"),
      buildMessage("assistant", "倒数第二个答复"),
      buildMessage("user", "最新请求"),
      buildMessage("assistant", "最新答复")
    ]
  };

  const snapshot = selectSessionMemorySnapshot(session);

  assert.deepEqual(snapshot.items.map((item) => item.text), [
    "首个请求",
    "首个答复",
    "倒数第二个请求",
    "倒数第二个答复",
    "最新请求",
    "最新答复"
  ]);
});

test("loadSessionMemorySnapshot reads only the first request and the last two requests with final answers", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "csr-session-snapshot-"));
  const filePath = path.join(tempDir, "11111111-1111-1111-1111-111111111111.jsonl");
  const records = [
    { type: "session_meta", timestamp: "2026-08-21T00:00:00.000Z", payload: { id: "snapshot-demo", cwd: tempDir } },
    {
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "First request" }] }
    },
    {
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "First follow-up" }] }
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "First final answer" }]
      }
    },
    { type: "response_item", payload: { type: "function_call", name: "exec", call_id: "middle", arguments: "{}" } },
    {
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Second-last request" }] }
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "Second-last final answer" }]
      }
    },
    {
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Latest request" }] }
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "Latest final answer" }]
      }
    }
  ];

  try {
    await writeFile(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
    const snapshot = await loadSessionMemorySnapshot(filePath);

    assert.equal(snapshot.id, "snapshot-demo");
    assert.equal(snapshot.cwd, tempDir);
    assert.deepEqual(
      snapshot.items.map((item) => item.text),
      ["First request", "First final answer", "Second-last request", "Second-last final answer", "Latest request", "Latest final answer"]
    );
    assert.equal(snapshot.items[0].snapshotLabel, "首个请求");
    assert.equal(snapshot.items[2].snapshotLabel, "倒数第 2 个请求");
    assert.equal(snapshot.items[4].snapshotLabel, "最新请求");
    assert.equal(snapshot.selection.summaryComplete, false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadSessionMemorySnapshot does not reuse the newest legacy answer for every request", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "csr-session-snapshot-legacy-"));
  const filePath = path.join(tempDir, "22222222-2222-2222-2222-222222222222.jsonl");
  const message = (role, text) => ({
    type: "response_item",
    payload: {
      type: "message",
      role,
      content: [{ type: role === "assistant" ? "output_text" : "input_text", text }]
    }
  });
  const records = [
    { type: "session_meta", timestamp: "2026-02-04T00:00:00.000Z", payload: { id: "legacy-snapshot" } },
    message("user", "首个请求"),
    message("assistant", "首个答复"),
    message("user", "倒数第二个请求"),
    message("assistant", "倒数第二个答复"),
    message("user", "最新请求"),
    message("assistant", "最新答复")
  ];

  try {
    await writeFile(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
    const snapshot = await loadSessionMemorySnapshot(filePath);

    assert.deepEqual(snapshot.items.map((item) => item.text), [
      "首个请求",
      "首个答复",
      "倒数第二个请求",
      "倒数第二个答复",
      "最新请求",
      "最新答复"
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("splitSessionIntoRounds groups interrupted user follow-ups into the same round until final answer", () => {
  const session = {
    id: "demo",
    items: [
      buildMessage("user", "需求 A"),
      buildMessage("assistant", "处理中 1", { phase: "commentary" }),
      buildToolEvent("exec_command"),
      buildMessage("user", "补充需求 B"),
      buildMessage("assistant", "处理中 2", { phase: "commentary" }),
      buildMessage("assistant", "最后总结", { phase: "final_answer" }),
      buildMessage("user", "下一轮需求"),
      buildMessage("assistant", "下一轮总结", { phase: "final_answer" })
    ]
  };

  const rounds = splitSessionIntoRounds(session);

  assert.equal(rounds.length, 2);
  assert.deepEqual(
    rounds[0].items.map((item) => item.text || item.name),
    ["需求 A", "处理中 1", "exec_command", "补充需求 B", "处理中 2", "最后总结"]
  );
  assert.deepEqual(
    rounds[1].items.map((item) => item.text || item.name),
    ["下一轮需求", "下一轮总结"]
  );
});

test("loadSession keeps input_image blocks structured and avoids dumping base64 into message text", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "csr-session-parser-"));
  const filePath = path.join(tempDir, "session.jsonl");

  try {
    await writeFile(
      filePath,
      `${JSON.stringify({
        type: "response_item",
        timestamp: "2026-06-23T00:00:00.000Z",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "请看这张图"
            },
            {
              type: "input_image",
              image_url: "data:image/png;base64,AAAA",
              detail: "high"
            }
          ]
        }
      })}\n`,
      "utf8"
    );

    const session = await loadSession(filePath);
    const [message] = session.items;

    assert.equal(message.kind, "message");
    assert.equal(message.text, "请看这张图\n\n[Image attachment: high]");
    assert.equal(message.contentBlocks.length, 2);
    assert.deepEqual(message.contentBlocks[1], {
      kind: "image",
      blockType: "input_image",
      imageUrl: "data:image/png;base64,AAAA",
      detail: "high"
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadSession records unique token snapshots from token_count events", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "csr-session-parser-"));
  const filePath = path.join(tempDir, "session.jsonl");

  try {
    await writeFile(
      filePath,
      `${[
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-06-23T00:00:00.000Z",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "需求 A" }]
          }
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-06-23T00:00:01.000Z",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "处理中" }]
          }
        }),
        JSON.stringify({
          timestamp: "2026-06-23T00:00:02.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: { total_tokens: 120 },
              last_token_usage: {
                total_tokens: 120,
                input_tokens: 80,
                cached_input_tokens: 0,
                output_tokens: 40,
                reasoning_output_tokens: 0
              }
            }
          }
        }),
        JSON.stringify({
          timestamp: "2026-06-23T00:00:03.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: { total_tokens: 120 },
              last_token_usage: {
                total_tokens: 120,
                input_tokens: 80,
                cached_input_tokens: 0,
                output_tokens: 40,
                reasoning_output_tokens: 0
              }
            }
          }
        })
      ].join("\n")}\n`,
      "utf8"
    );

    const session = await loadSession(filePath);

    assert.equal(session.items.length, 2);
    assert.equal(session.tokenSnapshots.length, 1);
    assert.equal(session.tokenSnapshots[0].tokens, 120);
    assert.deepEqual(
      session.tokenSnapshots[0].items.map((item) => item.text),
      ["需求 A", "处理中"]
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadSession preserves task lifecycle events for the task activity view", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "csr-session-parser-"));
  const filePath = path.join(tempDir, "session.jsonl");

  try {
    await writeFile(
      filePath,
      `${[
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-08-01T02:00:00.000Z",
          payload: {
            type: "task_started",
            turn_id: "turn-1",
            started_at: 1785559200,
            collaboration_mode_kind: "default"
          }
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-08-01T02:01:00.000Z",
          payload: {
            type: "task_complete",
            turn_id: "turn-1",
            completed_at: 1785559260,
            duration_ms: 60000
          }
        })
      ].join("\n")}\n`,
      "utf8"
    );

    const session = await loadSession(filePath);

    assert.deepEqual(session.activityEvents, [
      {
        type: "task_started",
        timestamp: "2026-08-01T02:00:00.000Z",
        turnId: "turn-1",
        startedAt: 1785559200,
        completedAt: null,
        durationMs: null,
        collaborationMode: "default",
        modelContextWindow: null
      },
      {
        type: "task_complete",
        timestamp: "2026-08-01T02:01:00.000Z",
        turnId: "turn-1",
        startedAt: null,
        completedAt: 1785559260,
        durationMs: 60000,
        collaborationMode: null,
        modelContextWindow: null
      }
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadSession strips wrapper <image> markers around structured image blocks", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "csr-session-parser-"));
  const filePath = path.join(tempDir, "session.jsonl");

  try {
    await writeFile(
      filePath,
      `${JSON.stringify({
        type: "response_item",
        timestamp: "2026-06-23T00:00:00.000Z",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "Please analyze this unsuccessful change."
            },
            {
              type: "input_text",
              text: "<image>\n"
            },
            {
              type: "input_image",
              image_url: "data:image/png;base64,AAAA",
              detail: "high"
            },
            {
              type: "input_text",
              text: "</image>"
            }
          ]
        }
      })}\n`,
      "utf8"
    );

    const session = await loadSession(filePath);
    const [message] = session.items;

    assert.equal(message.kind, "message");
    assert.equal(message.text, "Please analyze this unsuccessful change.\n\n[Image attachment: high]");
    assert.equal(
      message.contentBlocks.filter((block) => block.kind === "text" && /<\/?image>/.test(block.text)).length,
      0
    );
    assert.equal(message.contentBlocks.length, 2);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadSession strips wrapper <proposed_plan> markers around assistant plan blocks", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "csr-session-parser-"));
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
              text: "<proposed_plan>\n"
            },
            {
              type: "output_text",
              text: "# Demo Project: Session Workspace and Screenshot Support"
            },
            {
              type: "output_text",
              text: "</proposed_plan>"
            }
          ]
        }
      })}\n`,
      "utf8"
    );

    const session = await loadSession(filePath);
    const [message] = session.items;

    assert.equal(message.kind, "message");
    assert.equal(message.text, "# Demo Project: Session Workspace and Screenshot Support");
    assert.equal(
      message.contentBlocks.filter((block) => block.kind === "text" && /<\/?proposed_plan>/.test(block.text)).length,
      0
    );
    assert.equal(message.contentBlocks.length, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadSession strips standalone <proposed_plan> marker lines inside assistant text blocks", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "csr-session-parser-"));
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
              text: "<proposed_plan>\n\n# Demo Project: Session Workspace and Screenshot Support\n\n- Phase one\n\n</proposed_plan>"
            }
          ]
        }
      })}\n`,
      "utf8"
    );

    const session = await loadSession(filePath);
    const [message] = session.items;

    assert.equal(message.kind, "message");
    assert.equal(message.text, "# Demo Project: Session Workspace and Screenshot Support\n\n- Phase one");
    assert.equal(message.contentBlocks.length, 1);
    assert.equal(message.contentBlocks[0].kind, "text");
    assert.doesNotMatch(message.contentBlocks[0].text, /<\/?proposed_plan>/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadSession marks explicitly truncated tool output", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "csr-session-parser-"));
  const filePath = path.join(tempDir, "session.jsonl");

  try {
    await writeFile(
      filePath,
      [
        JSON.stringify({
          timestamp: "2026-06-23T00:00:00.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            call_id: "call-1",
            name: "exec_command",
            arguments: "{\"cmd\":\"rg foo\"}"
          }
        }),
        JSON.stringify({
          timestamp: "2026-06-23T00:00:01.000Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call-1",
            output: [
              "Chunk ID: demo",
              "Wall time: 0.0001 seconds",
              "Process exited with code 0",
              "Original token count: 104049",
              "Output:",
              "Total output lines: 3034",
              "",
              "/tmp/demo"
            ].join("\n")
          }
        })
      ].join("\n") + "\n",
      "utf8"
    );

    const session = await loadSession(filePath);
    const toolOutput = session.items[1];

    assert.equal(toolOutput.kind, "tool_output");
    assert.equal(toolOutput.isTruncated, true);
    assert.equal(toolOutput.truncationReason, "日志截断");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
