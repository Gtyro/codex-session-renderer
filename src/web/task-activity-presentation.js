const VERIFICATION_NAME_PATTERN = /(?:test|verify|validation|check|lint|build|typecheck|audit)/iu;
const VERIFICATION_COMMAND_PATTERN = /(?:\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|build|check|typecheck)\b|\b(?:node\s+--test|npx\s+(?:vitest|jest|eslint|tsc)|pytest|go\s+test|cargo\s+test|mvn\s+test|gradle\s+test)\b)/iu;
const FAILURE_PATTERN = /(?:exit[_\s-]*code["'\s:]*[1-9]\d*|#\s*fail(?:ures?)?\s+[1-9]\d*\b|^\s*not ok\b|^\s*(?:error|exception)\s*:|\b(?:script|process|command)\s+failed\b)/imu;
const SUCCESS_PATTERN = /(?:exit[_\s-]*code["'\s:]*0\b|script completed|\b(?:pass(?:ed)?|tests?\s+passed|all checks? passed|success)\b)/iu;
const DELEGATION_NAMES = new Set(["spawn_agent", "followup_task", "delegate_task", "assign_task"]);

function firstLine(value, maxLength = 96) {
  const text = String(value ?? "")
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .find(Boolean) || "";

  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}

function parsePossibleJson(value) {
  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function getToolSource(item) {
  if (item?.data && typeof item.data === "object") {
    return item.data;
  }

  return parsePossibleJson(item?.data ?? item?.body ?? "");
}

function getNamedValue(item, key) {
  const source = getToolSource(item);

  if (source && typeof source === "object" && !Array.isArray(source) && source[key] != null) {
    return String(source[key]);
  }

  const text = typeof source === "string" ? source : String(item?.body ?? "");
  const quoted = new RegExp(`["']?${key}["']?\\s*[:=]\\s*["']([^"']+)["']`, "iu");
  const bare = new RegExp(`["']?${key}["']?\\s*[:=]\\s*([^,}\\n]+)`, "iu");
  const match = text.match(quoted) || text.match(bare);

  return match?.[1]?.trim() || "";
}

function getToolInputText(item) {
  const source = getToolSource(item);

  if (typeof source === "string") {
    return source;
  }

  if (source && typeof source === "object") {
    return JSON.stringify(source);
  }

  return String(item?.body ?? "");
}

function getExecutableCommand(item) {
  const source = getToolSource(item);

  if (source && typeof source === "object" && !Array.isArray(source)) {
    return String(source.cmd ?? source.command ?? "").trim();
  }

  const text = typeof source === "string" ? source : String(item?.body ?? "");
  const name = String(item?.name ?? "").toLowerCase();

  if (name === "exec" || name === "functions.exec") {
    const nestedCall = text.match(
      /(?:tools\.)?exec_command\(\s*\{\s*["']?cmd["']?\s*:\s*["']([^"']+)["']/iu
    );
    return nestedCall?.[1]?.trim() || "";
  }

  return getNamedValue(item, "cmd") || getNamedValue(item, "command");
}

function findToolOutput(items, callId) {
  if (!callId) {
    return null;
  }

  return items.find((item) => item?.kind === "tool_output" && item.callId === callId) || null;
}

function classifyVerification(call, output) {
  const input = getToolInputText(call);
  const command = getExecutableCommand(call);
  const evidence = `${command}\n${output?.body ?? ""}`;
  const isVerification = VERIFICATION_NAME_PATTERN.test(call?.name || "") || VERIFICATION_COMMAND_PATTERN.test(command);

  if (!isVerification) {
    return null;
  }

  const status = FAILURE_PATTERN.test(evidence)
    ? "failed"
    : SUCCESS_PATTERN.test(evidence)
    ? "passed"
    : output
    ? "recorded"
    : "pending";
  const displayCommand =
    command ||
    firstLine(input, 120) ||
    call?.name ||
    "验证命令";

  return {
    status,
    command: displayCommand,
    outputPreview: firstLine(output?.body, 120) || (output ? "已记录输出" : "等待输出")
  };
}

function isDelegationCall(item) {
  const name = String(item?.name ?? "").toLowerCase();

  return DELEGATION_NAMES.has(name) || /(?:spawn|delegate|assign).*?(?:agent|task)|followup.*task/iu.test(name);
}

function getDelegationLabel(item) {
  return (
    getNamedValue(item, "task_name") ||
    getNamedValue(item, "target") ||
    firstLine(getNamedValue(item, "message"), 96) ||
    firstLine(getToolInputText(item), 96) ||
    item?.name ||
    "子任务"
  );
}

function getUserGoal(items) {
  const userMessage = [...items]
    .reverse()
    .find((item) => item?.kind === "message" && item.role === "user" && item.isContextPrelude !== true);

  return firstLine(userMessage?.displayText ?? userMessage?.text, 140);
}

function sortTimeline(events) {
  return [...events].sort((left, right) => {
    const leftTime = Date.parse(left.timestamp || "") || 0;
    const rightTime = Date.parse(right.timestamp || "") || 0;

    if (leftTime !== rightTime) {
      return leftTime - rightTime;
    }

    return (left.order ?? 0) - (right.order ?? 0);
  });
}

/**
 * Builds a compact, evidence-first representation of goals, delegations, and checks.
 * It intentionally labels inferred links as chronological so that the UI never claims
 * an unrecorded causal relationship.
 */
export function deriveTaskActivity(session) {
  const items = Array.isArray(session?.items) ? session.items : [];
  const lifecycleEvents = Array.isArray(session?.activityEvents) ? session.activityEvents : [];
  const goals = [];
  const tasks = [];
  const verifications = [];
  const timeline = [];
  let activeGoal = null;

  lifecycleEvents.forEach((event, index) => {
    if (!event?.type) {
      return;
    }

    const isStart = event.type === "task_started";
    const isComplete = event.type === "task_complete" || event.type === "task_completed";
    const isRollback = event.type === "thread_rolled_back";

    if (!isStart && !isComplete && !isRollback) {
      return;
    }

    timeline.push({
      id: `lifecycle-${index}`,
      kind: isStart ? "started" : isComplete ? "completed" : "rolled_back",
      title: isStart ? "task_started" : isComplete ? "task_complete" : "thread_rolled_back",
      detail: isStart
        ? event.turnId ? `Turn ${event.turnId}` : "新的任务轮次"
        : isComplete
        ? event.durationMs ? `耗时 ${Math.round(event.durationMs / 1000)} 秒` : "任务轮次已完成"
        : "会话回滚",
      timestamp: event.timestamp || null,
      order: index - lifecycleEvents.length,
      itemIndex: null
    });
  });

  items.forEach((item, itemIndex) => {
    if (item?.kind !== "tool_call") {
      return;
    }

    const name = String(item.name ?? "tool");
    const normalizedName = name.toLowerCase();
    const output = findToolOutput(items, item.callId);
    const timestamp = output?.timestamp || item.timestamp || null;

    if (normalizedName === "create_goal") {
      const objective = getNamedValue(item, "objective") || firstLine(getToolInputText(item), 140) || "未命名 Goal";
      const goal = {
        id: `goal-${itemIndex}`,
        label: objective,
        status: "active",
        timestamp,
        itemIndex,
        source: "create_goal"
      };
      goals.push(goal);
      activeGoal = goal;
      timeline.push({
        id: `goal-event-${itemIndex}`,
        kind: "goal",
        title: "Goal 已创建",
        detail: objective,
        timestamp,
        order: itemIndex,
        itemIndex
      });
      return;
    }

    if (normalizedName === "update_goal") {
      const status = getNamedValue(item, "status").toLowerCase();

      if (activeGoal && ["complete", "completed", "blocked"].includes(status)) {
        activeGoal.status = status === "blocked" ? "blocked" : "completed";
      }

      timeline.push({
        id: `goal-update-${itemIndex}`,
        kind: "goal_update",
        title: "Goal 状态更新",
        detail: status || firstLine(getToolInputText(item), 120) || "已记录更新",
        timestamp,
        order: itemIndex,
        itemIndex
      });
      return;
    }

    if (isDelegationCall(item)) {
      const task = {
        id: `task-${itemIndex}`,
        label: getDelegationLabel(item),
        status: FAILURE_PATTERN.test(output?.body || "") ? "failed" : "delegated",
        timestamp,
        itemIndex,
        goalId: activeGoal?.id || null,
        target: getNamedValue(item, "target") || getNamedValue(item, "task_name") || ""
      };
      tasks.push(task);
      timeline.push({
        id: `delegation-${itemIndex}`,
        kind: "delegation",
        title: "委派子任务",
        detail: task.label,
        timestamp,
        order: itemIndex,
        itemIndex
      });
      return;
    }

    const verification = classifyVerification(item, output);

    if (verification) {
      const parentTask = [...tasks].reverse().find((task) => task.itemIndex < itemIndex) || null;
      const result = {
        id: `verification-${itemIndex}`,
        ...verification,
        timestamp,
        itemIndex,
        goalId: activeGoal?.id || null,
        taskId: parentTask?.id || null
      };
      verifications.push(result);
      timeline.push({
        id: result.id,
        kind: "verification",
        title: verification.status === "passed" ? "验证通过" : verification.status === "failed" ? "验证失败" : "验证记录",
        detail: verification.command,
        timestamp,
        order: itemIndex,
        itemIndex
      });
      return;
    }

    timeline.push({
      id: `tool-${itemIndex}`,
      kind: "tool",
      title: name,
      detail: firstLine(getToolInputText(item), 120) || "工具调用",
      timestamp,
      order: itemIndex,
      itemIndex
    });
  });

  if (goals.length === 0) {
    const fallbackGoal = getUserGoal(items);

    if (fallbackGoal) {
      goals.push({
        id: "goal-request",
        label: fallbackGoal,
        status: "observed",
        timestamp: null,
        itemIndex: null,
        source: "user_request"
      });
    }
  }

  const orderedTimeline = sortTimeline(timeline);
  const summary = {
    starts: lifecycleEvents.filter((event) => event?.type === "task_started").length,
    tools: items.filter((item) => item?.kind === "tool_call").length,
    delegated: tasks.length,
    passed: verifications.filter((item) => item.status === "passed").length,
    failed: verifications.filter((item) => item.status === "failed").length,
    recorded: verifications.length
  };

  return {
    goals,
    tasks,
    verifications,
    timeline: orderedTimeline,
    summary,
    hasActivity: goals.length > 0 || orderedTimeline.length > 0
  };
}
