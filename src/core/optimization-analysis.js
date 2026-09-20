import { parseSkillMessagePresentation, parseSkillTriggerMessage } from "../shared/message-presentation.js";

const VERIFICATION_COMMAND_PATTERN =
  /(?:\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|build|check|typecheck)\b|\b(?:node\s+--test|npx\s+(?:vitest|jest|eslint|tsc)|pytest|go\s+test|cargo\s+test|mvn\s+test|gradle\s+test)\b)/iu;
const FAILURE_PATTERN =
  /(?:exit[_\s-]*code["'\s:]*[1-9]\d*|#\s*fail(?:ures?)?\s+[1-9]\d*\b|^\s*not ok\b|^\s*(?:error|exception)\s*:|\b(?:script|process|command)\s+failed\b)/imu;
const DOCUMENT_PATH_PATTERN = /(?:^|[\s"'`])([^\s"'`|;&]*?(?:AGENTS\.md|README(?:\.[A-Za-z0-9_-]+)?\.md|SKILL\.md))/giu;
const DELEGATION_NAMES = new Set(["spawn_agent", "followup_task", "delegate_task", "assign_task"]);
const MAX_TRACE_ENTRY_CHARS = 6_000;
const MAX_TRACE_CHARS = 48_000;

export function redactSensitiveText(value) {
  return String(value ?? "")
    .replace(/(\b(?:authorization\s*:\s*bearer|bearer)\s+)[^\s,;]+/giu, "$1[REDACTED]")
    .replace(
      /(\b(?:api[_-]?key|access[_-]?token|token|secret|password|private[_-]?key)\b\s*[:=]\s*["']?)[^\s,"'}\]]+/giu,
      "$1[REDACTED]"
    )
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/gu, "[REDACTED]");
}

function firstLine(value, maxLength = 120) {
  const line = redactSensitiveText(value)
    .split(/\r?\n/gu)
    .map((entry) => entry.trim())
    .find(Boolean) || "";

  return line.length > maxLength ? `${line.slice(0, Math.max(0, maxLength - 1))}…` : line;
}

function normalizeForKey(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function getToolInput(item) {
  if (item?.data && typeof item.data === "object") {
    return JSON.stringify(item.data);
  }

  return typeof item?.data === "string" ? item.data : String(item?.body ?? "");
}

function getToolCommand(item) {
  if (item?.data && typeof item.data === "object" && !Array.isArray(item.data)) {
    const command = item.data.cmd ?? item.data.command;
    if (typeof command === "string" && command.trim()) {
      return command.trim();
    }
  }

  const input = getToolInput(item);
  const match = input.match(/(?:["']?cmd["']?\s*:\s*["'])([^"']+)/iu);
  return match?.[1]?.trim() || "";
}

function findToolOutput(items, callId) {
  if (!callId) {
    return null;
  }

  return items.find((item) => item?.kind === "tool_output" && item.callId === callId) || null;
}

function findUserRequest(items) {
  const message = items.find(
    (item) => item?.kind === "message" && item.role === "user" && item.isContextPrelude !== true
  );
  return firstLine(message?.displayText ?? message?.text, 180);
}

function collectSkillNames(items) {
  const names = new Map();

  items.forEach((item, itemIndex) => {
    if (item?.kind !== "message") {
      return;
    }

    const text = item.displayText ?? item.text;
    const payload = parseSkillMessagePresentation(text);
    const trigger = parseSkillTriggerMessage(text);
    const name = payload?.name || trigger?.name || null;

    if (!name) {
      return;
    }

    const normalizedName = String(name).trim();
    if (!normalizedName) {
      return;
    }

    const current = names.get(normalizedName) || {
      name: normalizedName,
      count: 0,
      itemIndexes: []
    };
    current.count += 1;
    current.itemIndexes.push(itemIndex);
    names.set(normalizedName, current);
  });

  return [...names.values()];
}

function collectDocumentReads(items) {
  const reads = new Map();

  items.forEach((item, itemIndex) => {
    if (item?.kind !== "tool_call") {
      return;
    }

    const command = getToolCommand(item);
    if (!command) {
      return;
    }

    for (const match of command.matchAll(DOCUMENT_PATH_PATTERN)) {
      const rawPath = match[1]?.trim();
      if (!rawPath) {
        continue;
      }

      const path = rawPath.replace(/[),.;:]+$/u, "");
      const current = reads.get(path) || {
        path,
        count: 0,
        itemIndexes: []
      };
      current.count += 1;
      current.itemIndexes.push(itemIndex);
      reads.set(path, current);
    }
  });

  return [...reads.values()].sort((left, right) => right.count - left.count || left.path.localeCompare(right.path));
}

function collectRepeatedToolCalls(items) {
  const calls = new Map();

  items.forEach((item, itemIndex) => {
    if (item?.kind !== "tool_call") {
      return;
    }

    const name = String(item.name ?? "tool");
    if (/^(?:wait|ping)$/iu.test(name)) {
      return;
    }

    const key = `${name}\u0000${normalizeForKey(getToolInput(item))}`;
    const current = calls.get(key) || {
      name,
      input: firstLine(getToolInput(item)),
      count: 0,
      itemIndexes: []
    };
    current.count += 1;
    current.itemIndexes.push(itemIndex);
    calls.set(key, current);
  });

  return [...calls.values()].filter((entry) => entry.count > 1);
}

function collectVerificationFailures(items) {
  const failures = [];

  items.forEach((item, itemIndex) => {
    if (item?.kind !== "tool_call") {
      return;
    }

    const command = getToolCommand(item);
    if (!VERIFICATION_COMMAND_PATTERN.test(command)) {
      return;
    }

    const output = findToolOutput(items, item.callId);
    if (output && FAILURE_PATTERN.test(String(output.body ?? ""))) {
      failures.push({
        command: firstLine(command),
        itemIndex
      });
    }
  });

  return failures;
}

function sumTokenSnapshots(tokenSnapshots) {
  return (Array.isArray(tokenSnapshots) ? tokenSnapshots : []).reduce((total, snapshot) => {
    const tokens = Number(snapshot?.tokens ?? snapshot?.totalTokens ?? 0);
    return Number.isFinite(tokens) && tokens > 0 ? total + tokens : total;
  }, 0);
}

function sumTaskDuration(activityEvents) {
  return (Array.isArray(activityEvents) ? activityEvents : []).reduce((total, event) => {
    const durationMs = Number(event?.durationMs);
    return Number.isFinite(durationMs) && durationMs > 0 ? total + durationMs : total;
  }, 0);
}

function createObservation(code, title, detail, options = {}) {
  return {
    code,
    title,
    detail,
    kind: options.kind || "observed",
    itemIndexes: options.itemIndexes || []
  };
}

function createRecommendation(scope, title, detail, options = {}) {
  return {
    scope,
    title,
    detail,
    confidence: options.confidence || "hypothesis",
    itemIndexes: options.itemIndexes || []
  };
}

function truncateTraceText(value, maxLength = MAX_TRACE_ENTRY_CHARS) {
  const text = redactSensitiveText(value).trim();

  if (text.length <= maxLength) {
    return {
      text,
      truncated: false
    };
  }

  return {
    text: `${text.slice(0, Math.max(0, maxLength - 1))}…`,
    truncated: true
  };
}

function getTraceItemLabel(item, linkedToolName = null) {
  if (item?.kind === "message") {
    const phase = item.phase ? ` · ${item.phase}` : "";
    return `${item.role || "unknown"} message${phase}`;
  }

  if (item?.kind === "reasoning") {
    return "reasoning summary";
  }

  if (item?.kind === "tool_call") {
    return `tool call · ${item.name || "unknown_tool"}`;
  }

  if (item?.kind === "tool_output") {
    return `tool output · ${item.name || linkedToolName || item.callId || "unknown_tool"}`;
  }

  return `tool event · ${item?.eventType || "unknown_event"}`;
}

function getTraceItemContent(item) {
  if (item?.kind === "message" || item?.kind === "reasoning") {
    return item.text ?? "";
  }

  return item?.body ?? "";
}

function buildTaskTrace(session) {
  const items = Array.isArray(session?.items) ? session.items : [];
  const activityEvents = Array.isArray(session?.activityEvents) ? session.activityEvents : [];
  const toolNamesByCallId = new Map(
    items
      .filter((item) => item?.kind === "tool_call" && item.callId && item.name)
      .map((item) => [item.callId, item.name])
  );
  const entries = [];
  let includedChars = 0;
  let omittedItems = 0;
  let truncatedEntries = 0;

  activityEvents.forEach((event) => {
    if (!event?.type) {
      return;
    }

    const detail = [
      event.turnId ? `turn: ${event.turnId}` : null,
      Number.isFinite(event.durationMs) ? `duration: ${event.durationMs}ms` : null,
      event.collaborationMode ? `mode: ${event.collaborationMode}` : null
    ]
      .filter(Boolean)
      .join(" · ");
    entries.push({
      kind: "lifecycle",
      label: event.type,
      timestamp: event.timestamp || null,
      content: detail || "lifecycle event recorded",
      itemIndex: null,
      order: -activityEvents.length + entries.length,
      truncated: false
    });
  });

  items.forEach((item, itemIndex) => {
    if (includedChars >= MAX_TRACE_CHARS) {
      omittedItems += 1;
      return;
    }

    const normalized = truncateTraceText(getTraceItemContent(item));
    const remainingChars = MAX_TRACE_CHARS - includedChars;
    const content = normalized.text.length > remainingChars
      ? truncateTraceText(normalized.text, remainingChars).text
      : normalized.text;
    const truncated = normalized.truncated || content.length < normalized.text.length;

    if (truncated) {
      truncatedEntries += 1;
    }

    includedChars += content.length;
    entries.push({
      kind: item.kind || "unknown",
      label: getTraceItemLabel(item, toolNamesByCallId.get(item.callId) || null),
      timestamp: item.timestamp || null,
      content,
      itemIndex,
      order: itemIndex,
      truncated
    });
  });

  entries.sort((left, right) => {
    const leftTime = Date.parse(left.timestamp || "") || 0;
    const rightTime = Date.parse(right.timestamp || "") || 0;

    if (leftTime !== rightTime) {
      return leftTime - rightTime;
    }

    return left.order - right.order;
  });

  const markdown = entries
    .map((entry, index) => {
      const timestamp = entry.timestamp ? ` · ${entry.timestamp}` : "";
      const truncation = entry.truncated ? " · truncated" : "";
      return `### ${index + 1}. ${entry.label}${timestamp}${truncation}\n\n${entry.content || "(empty)"}`;
    })
    .join("\n\n");

  return {
    entries: entries.map(({ order: _order, ...entry }) => entry),
    markdown,
    includedChars,
    truncatedEntries,
    omittedItems,
    isTruncated: truncatedEntries > 0 || omittedItems > 0
  };
}

function buildAgentBrief(session, analysis) {
  const observationLines = analysis.observations.length > 0
    ? analysis.observations.map((entry) => `- ${entry.title}: ${entry.detail}`).join("\n")
    : "- 当前记录没有识别出可直接归因的异常；不要把这解释为无需优化。";
  const recommendationLines = analysis.recommendations
    .map((entry) => `- [${entry.scope}] ${entry.title}: ${entry.detail}`)
    .join("\n");

  const trace = analysis.taskTrace;
  const traceNote = trace.isTruncated
    ? `轨迹为控制分析上下文而截断：${trace.truncatedEntries} 段截断，省略 ${trace.omittedItems} 个后续项目。请回到原 transcript 核对缺失内容。`
    : "轨迹包含当前已选范围内的全部已解析项目。";

  return redactSensitiveText([
    "请基于以下 Codex 会话证据提出优化方案。",
    "目标是提升后续相似任务的成功率、耗时或 token 效率；不要把相关性误报为因果关系。",
    "不要直接修改任何文件。先按资产分别提出补丁建议、风险和验证计划。",
    "如果建议涉及 AGENTS.md，只能给出编号的拟修改项，等待用户逐条批准。",
    "",
    `会话: ${session.id || "未知"}`,
    `用户任务: ${analysis.summary.userRequest || "日志中未识别"}`,
    `记录 token: ${analysis.summary.totalTokens}`,
    `工具调用: ${analysis.summary.toolCalls}`,
    `委派: ${analysis.summary.delegated}`,
    "",
    "已记录的事实：",
    observationLines,
    "",
    "初步优化方向：",
    recommendationLines,
    "",
    "任务执行轨迹：",
    traceNote,
    "",
    trace.markdown || "(当前范围没有可复制的执行项目)",
    "",
    "请输出：1) 证据与判断；2) 各候选资产的最小修改；3) 预期收益与风险；4) 可复现的验证任务集。"
  ].join("\n"));
}

/**
 * Produces a report-only evidence package from one persisted session.
 * It deliberately keeps unknown token attribution and cross-session links explicit.
 */
export function deriveOptimizationAnalysis(session) {
  const items = Array.isArray(session?.items) ? session.items : [];
  const documentReads = collectDocumentReads(items);
  const repeatedToolCalls = collectRepeatedToolCalls(items);
  const verificationFailures = collectVerificationFailures(items);
  const skills = collectSkillNames(items);
  const delegated = items.filter(
    (item) =>
      item?.kind === "tool_call" &&
      (DELEGATION_NAMES.has(String(item.name ?? "").toLowerCase()) || /(?:spawn|delegate|assign).*?(?:agent|task)/iu.test(String(item.name ?? "")))
  );
  const totalTokens = sumTokenSnapshots(session?.tokenSnapshots);
  const durationMs = sumTaskDuration(session?.activityEvents);
  const observations = [];
  const recommendations = [];

  if (totalTokens > 0) {
    observations.push(
      createObservation("token-total", "已记录会话成本", `会话共记录 ${totalTokens} token。`, {
        kind: "measurement"
      })
    );
  }

  if (verificationFailures.length > 0) {
    observations.push(
      createObservation(
        "verification-failed",
        "验证失败",
        `${verificationFailures.length} 个已识别验证命令失败；应先修复正确性问题，再比较效率。`,
        { itemIndexes: verificationFailures.map((entry) => entry.itemIndex) }
      )
    );
    recommendations.push(
      createRecommendation(
        "workflow",
        "把失败验证设为优化前门槛",
        "为该任务族保留失败命令及可复现输入；候选文档或 skill 必须先使其通过。",
        { confidence: "observed", itemIndexes: verificationFailures.map((entry) => entry.itemIndex) }
      )
    );
  }

  repeatedToolCalls.forEach((entry) => {
    observations.push(
      createObservation(
        "repeated-tool-call",
        "重复工具调用",
        `${entry.name} 使用相同输入执行 ${entry.count} 次：${entry.input || "未记录输入"}`,
        { itemIndexes: entry.itemIndexes }
      )
    );
    recommendations.push(
      createRecommendation(
        "workflow",
        "审查可缓存或可合并的步骤",
        "确认重复调用是否由失败、输入变化或必要验证造成；仅在等价且安全时将其合并为确定性脚本步骤。",
        { itemIndexes: entry.itemIndexes }
      )
    );
  });

  documentReads
    .filter((entry) => entry.count > 1)
    .forEach((entry) => {
      observations.push(
        createObservation(
          "repeated-document-read",
          "重复读取指令资产",
          `${entry.path} 在已记录命令中出现 ${entry.count} 次。`,
          { itemIndexes: entry.itemIndexes }
        )
      );
      recommendations.push(
        createRecommendation(
          "documentation",
          "检查文档结构与查找成本",
          "比较该文档被反复读取的位置；可考虑增加目录、摘要或确定性索引，但不要只为变短而删除约束。",
          { itemIndexes: entry.itemIndexes }
        )
      );
    });

  if (skills.length > 0) {
    observations.push(
      createObservation(
        "skill-observed",
        "已观察到 Skill 载荷",
        `会话记录了 ${skills.map((entry) => `${entry.name} ×${entry.count}`).join("、")}。`,
        { itemIndexes: skills.flatMap((entry) => entry.itemIndexes) }
      )
    );
    recommendations.push(
      createRecommendation(
        "skill",
        "为 Skill 建立版本化基准",
        "不要从单次会话推断效果。用同一 task family 的多条 case 比较候选版本的通过率、总 token、耗时和重试次数。",
        { confidence: "observed", itemIndexes: skills.flatMap((entry) => entry.itemIndexes) }
      )
    );
  }

  if (delegated.length > 0) {
    observations.push(
      createObservation(
        "delegation-observed",
        "已观察到子任务委派",
        `当前会话记录了 ${delegated.length} 次委派；子 agent 的独立 session 尚未自动关联。`,
        { itemIndexes: delegated.map((_, index) => items.indexOf(delegated[index])) }
      )
    );
    recommendations.push(
      createRecommendation(
        "measurement",
        "为后续批量运行记录 run_id",
        "在父任务、子任务和指令资产快照中保存相同 run_id、case_id 与版本哈希，之后才能跨 session 汇总成本与结果。",
        { confidence: "observed" }
      )
    );
  }

  if (verificationFailures.length === 0) {
    recommendations.push(
      createRecommendation(
        "measurement",
        "补充可执行验收标准",
        "当前记录没有失败的已识别验证命令；为重复任务准备独立、可自动判定的成功标准，再比较文档或 skill 版本。"
      )
    );
  }

  const summary = {
    userRequest: findUserRequest(items),
    totalTokens,
    durationMs,
    toolCalls: items.filter((item) => item?.kind === "tool_call").length,
    delegated: delegated.length,
    skills: skills.length,
    documentsRead: documentReads.length,
    verificationFailures: verificationFailures.length
  };
  const taskTrace = buildTaskTrace(session);
  const analysis = {
    summary,
    observations,
    recommendations,
    documentReads,
    skills,
    repeatedToolCalls,
    verificationFailures,
    taskTrace
  };

  return {
    ...analysis,
    agentBrief: buildAgentBrief(session || {}, analysis)
  };
}
