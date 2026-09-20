import test from "node:test";
import assert from "node:assert/strict";
import { createReadOnlyAnalysisArgs } from "../src/core/codex-analysis-runner.js";

test("createReadOnlyAnalysisArgs forces a non-persistent read-only Codex invocation", () => {
  const args = createReadOnlyAnalysisArgs("/tmp/result.txt", "/workspace/project");

  assert.deepEqual(args, [
    "exec",
    "--sandbox",
    "read-only",
    "--ephemeral",
    "--output-last-message",
    "/tmp/result.txt",
    "--cd",
    "/workspace/project",
    "-"
  ]);
  assert.ok(!args.includes("workspace-write"));
  assert.ok(!args.includes("dangerously-bypass-approvals-and-sandbox"));
});
