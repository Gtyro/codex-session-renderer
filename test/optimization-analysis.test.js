import test from "node:test";
import assert from "node:assert/strict";
import { deriveOptimizationAnalysis } from "../src/core/optimization-analysis.js";

function toolCall(name, callId, data) {
  return {
    kind: "tool_call",
    name,
    callId,
    data,
    body: JSON.stringify(data)
  };
}

function toolOutput(callId, body) {
  return {
    kind: "tool_output",
    callId,
    body
  };
}

test("deriveOptimizationAnalysis produces evidence without claiming exact per-skill attribution", () => {
  const session = {
    id: "session-1",
    activityEvents: [{ type: "task_complete", durationMs: 12_000 }],
    tokenSnapshots: [{ tokens: 240 }],
    items: [
      { kind: "message", role: "user", text: "优化会话浏览器" },
      {
        kind: "message",
        role: "developer",
        text: "<skill><name>commit-workflow</name><path>/tmp/commit-workflow/SKILL.md</path></skill>\nname: commit-workflow"
      },
      toolCall("exec_command", "read-1", { cmd: "sed -n '1,120p' AGENTS.md" }),
      toolOutput("read-1", "rules"),
      toolCall("exec_command", "read-2", { cmd: "sed -n '1,120p' AGENTS.md" }),
      toolOutput("read-2", "rules"),
      toolCall("exec_command", "test-1", { cmd: "npm test" }),
      toolOutput("test-1", "exit_code: 1\n1 failure"),
      toolCall("spawn_agent", "delegate-1", { task_name: "review" }),
      toolOutput("delegate-1", "Agent started")
    ]
  };

  const analysis = deriveOptimizationAnalysis(session);

  assert.equal(analysis.summary.totalTokens, 240);
  assert.equal(analysis.summary.durationMs, 12_000);
  assert.equal(analysis.summary.delegated, 1);
  assert.equal(analysis.summary.skills, 1);
  assert.equal(analysis.summary.documentsRead, 1);
  assert.equal(analysis.summary.verificationFailures, 1);
  assert.ok(analysis.observations.some((entry) => entry.code === "repeated-document-read"));
  assert.ok(analysis.observations.some((entry) => entry.code === "verification-failed"));
  assert.ok(analysis.recommendations.some((entry) => entry.scope === "measurement"));
  assert.match(analysis.agentBrief, /不要直接修改任何文件/u);
  assert.match(analysis.agentBrief, /AGENTS\.md/u);
  assert.match(analysis.agentBrief, /tool call · exec_command/u);
  assert.match(analysis.agentBrief, /tool output · exec_command/u);
  assert.equal(analysis.taskTrace.entries.length, 11);
});

test("deriveOptimizationAnalysis redacts secrets from its copyable agent brief", () => {
  const analysis = deriveOptimizationAnalysis({
    id: "session-2",
    items: [
      { kind: "message", role: "user", text: "检查 token=super-secret-value" },
      toolCall("exec_command", "repeat-1", { cmd: "export API_KEY=sk-abcdefghijklmnop && npm test" }),
      toolCall("exec_command", "repeat-2", { cmd: "export API_KEY=sk-abcdefghijklmnop && npm test" })
    ]
  });

  assert.doesNotMatch(analysis.agentBrief, /super-secret-value|sk-abcdefghijklmnop/u);
  assert.match(analysis.agentBrief, /\[REDACTED\]/u);
});
