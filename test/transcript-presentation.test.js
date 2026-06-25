import test from "node:test";
import assert from "node:assert/strict";
import {
  getTranscriptEntryTimestamp,
  groupTranscriptItems,
  splitEntriesIntoDisplaySegments
} from "../src/web/transcript-presentation.js";

function buildMessage(role, text, options = {}) {
  return {
    kind: "message",
    role,
    phase: options.phase || null,
    timestamp: options.timestamp || null,
    text
  };
}

function buildToolCall(callId, name = "exec_command") {
  return {
    kind: "tool_call",
    callId,
    name,
    body: "{}"
  };
}

function buildToolOutput(callId, name = "exec_command") {
  return {
    kind: "tool_output",
    callId,
    name,
    body: "ok"
  };
}

test("groupTranscriptItems only merges adjacent tool call/output pairs", () => {
  const entries = groupTranscriptItems([
    buildToolCall("call-1", "tool-a"),
    buildToolCall("call-2", "tool-b"),
    buildToolOutput("call-1", "tool-a"),
    buildToolOutput("call-2", "tool-b"),
    buildToolCall("call-3", "tool-c"),
    buildToolOutput("call-3", "tool-c")
  ]);

  assert.deepEqual(
    entries.map((entry) => {
      if (entry.kind === "tool_interaction") {
        return `${entry.call.name}->${entry.output.name}`;
      }

      return `${entry.item.kind}:${entry.item.name}`;
    }),
    [
      "tool_call:tool-a",
      "tool_call:tool-b",
      "tool_output:tool-a",
      "tool_output:tool-b",
      "tool-c->tool-c"
    ]
  );
});

test("splitEntriesIntoDisplaySegments keeps process runs between user messages and final answer", () => {
  const entries = [
    { kind: "single", item: buildMessage("user", "需求 A") },
    { kind: "single", item: buildMessage("assistant", "处理中 1", { phase: "commentary" }) },
    { kind: "single", item: buildToolCall("call-1") },
    { kind: "single", item: buildMessage("user", "补充需求 B") },
    { kind: "single", item: { kind: "reasoning", text: "..." } },
    { kind: "single", item: buildMessage("assistant", "最后总结", { phase: "final_answer" }) }
  ];
  const visibleEntries = new Set([entries[0], entries[3], entries[5]]);
  const segments = splitEntriesIntoDisplaySegments(entries, (entry) => visibleEntries.has(entry));

  assert.deepEqual(
    segments.map((segment) => ({
      kind: segment.kind,
      values:
        segment.kind === "visible"
          ? [segment.entry.item.text]
          : segment.entries.map((entry) => entry.item.text || entry.item.kind)
    })),
    [
      { kind: "visible", values: ["需求 A"] },
      { kind: "process", values: ["处理中 1", "tool_call"] },
      { kind: "visible", values: ["补充需求 B"] },
      { kind: "process", values: ["..."] },
      { kind: "visible", values: ["最后总结"] }
    ]
  );
});

test("getTranscriptEntryTimestamp tolerates pending conversations without assistant entries", () => {
  assert.equal(getTranscriptEntryTimestamp(undefined), "");
  assert.equal(
    getTranscriptEntryTimestamp({
      kind: "single",
      item: buildMessage("user", "只有用户消息", { timestamp: "2026-05-06T06:38:36.291Z" })
    }),
    "2026-05-06T06:38:36.291Z"
  );
});
