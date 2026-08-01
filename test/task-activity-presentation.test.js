import test from "node:test";
import assert from "node:assert/strict";
import { deriveTaskActivity } from "../src/web/task-activity-presentation.js";

function toolCall(name, callId, data, timestamp) {
  return {
    kind: "tool_call",
    name,
    callId,
    data,
    body: typeof data === "string" ? data : JSON.stringify(data),
    timestamp
  };
}

function toolOutput(callId, body, timestamp) {
  return {
    kind: "tool_output",
    callId,
    body,
    timestamp
  };
}

test("deriveTaskActivity relates an explicit goal, delegated work, and successful test evidence", () => {
  const activity = deriveTaskActivity({
    activityEvents: [
      {
        type: "task_started",
        timestamp: "2026-08-01T02:00:00.000Z",
        turnId: "turn-1"
      },
      {
        type: "task_complete",
        timestamp: "2026-08-01T02:05:00.000Z",
        durationMs: 300000
      }
    ],
    items: [
      {
        kind: "message",
        role: "user",
        text: "实现任务脉络视图",
        timestamp: "2026-08-01T02:00:01.000Z"
      },
      toolCall("create_goal", "goal-call", { objective: "让进度与验证可复核" }, "2026-08-01T02:00:05.000Z"),
      toolOutput("goal-call", "Goal created", "2026-08-01T02:00:06.000Z"),
      toolCall(
        "spawn_agent",
        "delegate-call",
        { task_name: "实现时间线", message: "实现时间线组件" },
        "2026-08-01T02:01:00.000Z"
      ),
      toolOutput("delegate-call", "Agent started", "2026-08-01T02:01:01.000Z"),
      toolCall("exec", "test-call", { cmd: "npm run test" }, "2026-08-01T02:03:00.000Z"),
      toolOutput("test-call", '{"exit_code":0,"output":"all tests passed"}', "2026-08-01T02:03:03.000Z"),
      toolCall("update_goal", "goal-update", { status: "complete" }, "2026-08-01T02:04:00.000Z")
    ]
  });

  assert.deepEqual(activity.goals.map((goal) => [goal.label, goal.status]), [["让进度与验证可复核", "completed"]]);
  assert.deepEqual(activity.tasks.map((task) => task.label), ["实现时间线"]);
  assert.equal(activity.verifications.length, 1);
  assert.equal(activity.verifications[0].status, "passed");
  assert.equal(activity.verifications[0].taskId, activity.tasks[0].id);
  assert.deepEqual(activity.summary, {
    starts: 1,
    tools: 4,
    delegated: 1,
    passed: 1,
    failed: 0,
    recorded: 1
  });
  assert.deepEqual(
    activity.timeline.map((event) => event.kind),
    ["started", "goal", "delegation", "verification", "goal_update", "completed"]
  );
});

test("deriveTaskActivity keeps failed checks as evidence instead of reporting them as passed", () => {
  const activity = deriveTaskActivity({
    items: [
      {
        kind: "message",
        role: "user",
        text: "修复失败测试"
      },
      toolCall("exec_command", "lint-call", { cmd: "npm run lint" }),
      toolOutput("lint-call", "Process exited with exit_code: 1\n1 error found")
    ]
  });

  assert.equal(activity.goals[0].source, "user_request");
  assert.equal(activity.verifications[0].status, "failed");
  assert.equal(activity.summary.failed, 1);
  assert.equal(activity.timeline[0].title, "验证失败");
});
