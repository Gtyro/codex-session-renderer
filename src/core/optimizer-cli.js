import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { startAppServerCampaignBridge } from "./app-server-bridge.js";
import {
  activateCampaignOverlay,
  archiveCampaign,
  appendCampaignEvent,
  attachCampaignThread,
  createCampaign,
  getDefaultCampaignsDir,
  getCampaignRun,
  getTaskFamilyId,
  listCampaigns,
  readCampaign,
  readCampaignEvents,
  registerCampaignAsset,
  recordCampaignValidation,
  registerCampaignPatch,
  rollbackCampaignPatch,
  restoreCampaign,
  promoteCampaignPatch
} from "./campaign-store.js";
import { runCampaignCodex } from "./campaign-runner.js";
import { deriveOptimizationAnalysis } from "./optimization-analysis.js";
import { loadSession } from "./session-parser.js";
import { deriveSessionMeasurement } from "./session-measurement.js";
import { buildOptimizationHandoff, getSessionCandidateById, searchSessions } from "./session-resolver.js";

function fail(message) {
  throw new Error(message);
}

function parseOptions(argv) {
  const options = { _: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      options._.push(value);
      continue;
    }

    const key = value.slice(2);
    if (!key) {
      fail("Invalid empty option.");
    }

    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      options[key] = true;
      continue;
    }

    index += 1;
    if (Object.hasOwn(options, key)) {
      options[key] = Array.isArray(options[key]) ? [...options[key], next] : [options[key], next];
    } else {
      options[key] = next;
    }
  }

  return options;
}

function value(options, name, fallback = null) {
  const selected = options[name];
  return Array.isArray(selected) ? selected.at(-1) : selected ?? fallback;
}

function values(options, name) {
  const selected = options[name];
  if (selected === undefined || selected === true) {
    return [];
  }
  return Array.isArray(selected) ? selected : [selected];
}

function integer(valueToParse, fallback = null) {
  const parsed = Number.parseInt(valueToParse ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function outputJson(stdout, payload) {
  stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function formatCandidate(candidate, index) {
  return `${String(index + 1).padStart(2, " ")}. ${candidate.threadName || candidate.firstPrompt || "Untitled session"}\n    ${candidate.id} · ${candidate.cwd || "unknown cwd"} · ${candidate.modifiedAt}`;
}

async function chooseCandidate(candidates, io) {
  if (!io.stdin.isTTY || !io.stdout.isTTY) {
    fail("csr sessions pick requires an interactive terminal. Use csr sessions search --json and choose a candidate explicitly.");
  }

  if (candidates.length === 0) {
    fail("No session candidates were found.");
  }

  let selected = 0;
  io.stdout.write("Use ↑/↓ then Enter to choose a Codex session; Esc cancels.\n");
  const render = () => {
    io.stdout.write("\u001b[2J\u001b[H");
    io.stdout.write("Choose a Codex session (↑/↓, Enter):\n\n");
    candidates.slice(0, 12).forEach((candidate, index) => {
      io.stdout.write(`${index === selected ? "❯" : " "} ${formatCandidate(candidate, index)}\n`);
    });
  };

  return await new Promise((resolve, reject) => {
    readline.emitKeypressEvents(io.stdin);
    io.stdin.setRawMode(true);
    const onKeypress = (_, key) => {
      if (key.name === "up") {
        selected = (selected - 1 + Math.min(candidates.length, 12)) % Math.min(candidates.length, 12);
        render();
        return;
      }
      if (key.name === "down") {
        selected = (selected + 1) % Math.min(candidates.length, 12);
        render();
        return;
      }
      if (key.name === "return") {
        cleanup();
        resolve(candidates[selected]);
        return;
      }
      if (key.name === "escape" || (key.ctrl && key.name === "c")) {
        cleanup();
        reject(new Error("Session selection cancelled."));
      }
    };
    const cleanup = () => {
      io.stdin.off("keypress", onKeypress);
      io.stdin.setRawMode(false);
      io.stdin.pause();
    };
    io.stdin.on("keypress", onKeypress);
    render();
  });
}

function sessionOptions(options) {
  return {
    sessionsDir: value(options, "sessions-dir", undefined),
    archivedSessionsDir: value(options, "archived-sessions-dir", undefined),
    codexDir: value(options, "codex-dir", undefined)
  };
}

function campaignRoot(options) {
  return path.resolve(value(options, "campaigns-dir", getDefaultCampaignsDir()));
}

function requireRun(options) {
  const id = value(options, "run");
  if (!id || id === true) {
    fail("Missing --run <campaign-id>.");
  }
  return id;
}

function parseJsonOption(options, name, fallback = null) {
  const raw = value(options, name, null);
  if (!raw) {
    return fallback;
  }
  try {
    return JSON.parse(raw);
  } catch {
    fail(`--${name} must contain valid JSON.`);
  }
}

async function runSessions(argv, io) {
  const action = argv.shift();
  const options = parseOptions(argv);

  if (action === "search") {
    const query = value(options, "query", "");
    let candidates = await searchSessions(query, sessionOptions(options));
    const cwd = value(options, "cwd", null);
    if (cwd) {
      const resolvedCwd = path.resolve(cwd);
      candidates = candidates.filter((candidate) => candidate.cwd === resolvedCwd);
    }
    const limit = integer(value(options, "limit"), 20);
    candidates = candidates.slice(0, Math.max(1, limit));

    if (options.json) {
      outputJson(io.stdout, { query, candidates });
    } else {
      candidates.forEach((candidate, index) => io.stdout.write(`${formatCandidate(candidate, index)}\n`));
    }
    return;
  }

  if (action === "pick") {
    const query = value(options, "query", "");
    const selected = await chooseCandidate((await searchSessions(query, sessionOptions(options))).slice(0, 12), io);
    if (options.json) {
      outputJson(io.stdout, selected);
    } else {
      io.stdout.write(`${selected.id}\n`);
    }
    return;
  }

  fail("Usage: csr sessions <search|pick> [options]");
}

async function runSession(argv, io) {
  const action = argv.shift();
  const options = parseOptions(argv);

  if (action !== "evidence") {
    fail("Usage: csr session evidence --id <session-id> [--json]");
  }

  const id = value(options, "id");
  if (!id || id === true) {
    fail("Missing --id <session-id>.");
  }
  const candidate = await getSessionCandidateById(id, sessionOptions(options));
  const session = await loadSession(candidate.filePath);
  const evidence = {
    session: {
      id: candidate.id,
      location: candidate.location,
      relativePath: candidate.relativePath,
      threadName: candidate.threadName,
      cwd: candidate.cwd,
      modifiedAt: candidate.modifiedAt
    },
    analysis: deriveOptimizationAnalysis(session),
    handoff: buildOptimizationHandoff(candidate)
  };

  outputJson(io.stdout, evidence);
}

async function runCampaign(argv, io) {
  const action = argv.shift();
  const options = parseOptions(argv);
  const rootDir = campaignRoot(options);

  if (action === "create") {
    const cwd = value(options, "cwd", process.cwd());
    const intent = value(options, "intent", "Agent workflow optimization campaign");
    const taskFamilyId = value(options, "task-family", null) || getTaskFamilyId({ taskTemplate: intent });
    const campaign = await createCampaign({
      rootDir,
      cwd,
      intent,
      taskFamilyId,
      tasks: values(options, "task"),
      disposableWorkspace: Boolean(options["disposable-workspace"])
    });
    outputJson(io.stdout, campaign);
    return;
  }

  if (action === "list") {
    outputJson(io.stdout, { campaigns: await listCampaigns({ rootDir }) });
    return;
  }

  if (action === "archive") {
    const id = requireRun(options);
    outputJson(io.stdout, await archiveCampaign({
      rootDir,
      id,
      archiveRoot: value(options, "archive-dir", null)
    }));
    return;
  }

  if (action === "restore") {
    const id = requireRun(options);
    outputJson(io.stdout, await restoreCampaign({
      rootDir,
      id,
      archiveRoot: value(options, "archive-dir", null)
    }));
    return;
  }

  const id = requireRun(options);

  if (action === "attach") {
    const result = await attachCampaignThread({
      rootDir,
      id,
      threadId: value(options, "thread"),
      role: value(options, "role"),
      taskId: value(options, "task", null),
      revision: integer(value(options, "revision"), null)
    });
    outputJson(io.stdout, result);
    return;
  }

  if (action === "asset") {
    outputJson(
      io.stdout,
      await registerCampaignAsset({
        rootDir,
        id,
        assetPath: value(options, "path"),
        primary: Boolean(options.primary)
      })
    );
    return;
  }

  if (action === "status") {
    outputJson(io.stdout, await readCampaign({ rootDir, id }));
    return;
  }

  if (action === "events") {
    outputJson(io.stdout, {
      events: await readCampaignEvents({ rootDir, id, after: integer(value(options, "after"), 0) })
    });
    return;
  }

  if (action === "event") {
    const event = await appendCampaignEvent({
      rootDir,
      id,
      type: value(options, "type"),
      role: value(options, "role", "coordinator"),
      taskId: value(options, "task", null),
      revision: integer(value(options, "revision"), null),
      data: parseJsonOption(options, "data", null)
    });
    outputJson(io.stdout, event);
    return;
  }

  if (action === "overlay") {
    outputJson(
      io.stdout,
      await activateCampaignOverlay({
        rootDir,
        id,
        overlay: value(options, "body", ""),
        reason: value(options, "reason", "reviewer checkpoint"),
        evidenceRefs: values(options, "evidence")
      })
    );
    return;
  }

  if (action === "validate") {
    const fromRun = value(options, "from-run", null);
    if (fromRun) {
      const status = value(options, "status", null);
      if (!status || status === true) {
        fail("csr campaign validate --from-run requires an explicit --status <passed|failed|reviewer-verified>.");
      }
      const run = await getCampaignRun({ rootDir, id, runId: fromRun });
      if (run.role !== "worker" || !run.taskId) {
        fail("Only a completed worker run with an assigned task can supply validation measurements.");
      }
      if (run.status === "running") {
        fail("Campaign run is still running; wait for it to finish before validation.");
      }
      const selectedTaskId = value(options, "task", run.taskId);
      if (selectedTaskId !== run.taskId) {
        fail("--task must match the task associated with --from-run.");
      }
      const measurement = run.measurement || { source: "csr-owned-codex-exec", status: "unknown" };
      outputJson(
        io.stdout,
        await recordCampaignValidation({
          rootDir,
          id,
          taskId: run.taskId,
          status,
          source: "csr-owned-codex-exec",
          workerTokens: measurement.workerTokens,
          elapsedMs: measurement.elapsedMs,
          cohort: value(options, "cohort", null),
          revision: integer(value(options, "revision"), run.revision),
          evidenceRefs: [...values(options, "evidence"), `run:${run.id}`, measurement.evidenceRef].filter(Boolean),
          tokenMeasurement: measurement,
          runId: run.id
        })
      );
      return;
    }
    outputJson(
      io.stdout,
      await recordCampaignValidation({
        rootDir,
        id,
        taskId: value(options, "task"),
        status: value(options, "status"),
        source: value(options, "source", "command"),
        workerTokens: integer(value(options, "worker-tokens"), null),
        elapsedMs: integer(value(options, "elapsed-ms"), null),
        cohort: value(options, "cohort", null),
        revision: integer(value(options, "revision"), null),
        evidenceRefs: values(options, "evidence")
      })
    );
    return;
  }

  if (action === "run") {
    const role = value(options, "role");
    const taskId = value(options, "task", null);
    if (!role || role === true) {
      fail("csr campaign run requires --role <worker|reviewer>.");
    }
    if (role === "worker" && (!taskId || taskId === true)) {
      fail("csr campaign run --role worker requires --task <task-id>.");
    }
    outputJson(
      io.stdout,
      await runCampaignCodex({
        rootDir,
        id,
        role,
        taskId: taskId === true ? null : taskId,
        prompt: value(options, "prompt", ""),
        command: value(options, "codex-command", "codex"),
        commandArgs: values(options, "command-arg"),
        model: value(options, "model", null),
        executionCwd: value(options, "execution-cwd", null),
        sandbox: value(options, "sandbox", null),
        disposableExecutionCwd: Boolean(options["disposable-execution-cwd"])
      })
    );
    return;
  }

  if (action === "measure") {
    const sessionId = value(options, "session");
    if (!sessionId || sessionId === true) {
      fail("csr campaign measure requires --session <session-id>.");
    }
    const candidate = await getSessionCandidateById(sessionId, sessionOptions(options));
    const session = await loadSession(candidate.filePath);
    const measurement = deriveSessionMeasurement(session, candidate);
    const evidenceRefs = [...values(options, "evidence"), measurement.evidenceRef].filter(Boolean);
    const validation = await recordCampaignValidation({
      rootDir,
      id,
      taskId: value(options, "task"),
      status: value(options, "status", "passed"),
      source: "session-jsonl",
      workerTokens: measurement.workerTokens,
      elapsedMs: measurement.elapsedMs,
      cohort: value(options, "cohort", null),
      revision: integer(value(options, "revision"), null),
      evidenceRefs,
      tokenMeasurement: measurement
    });
    outputJson(io.stdout, { measurement, validation });
    return;
  }

  if (action === "patch") {
    const patchAction = options._.shift();
    if (patchAction === "add") {
      const baseFile = value(options, "base-file");
      const nextFile = value(options, "next-file");
      if (!baseFile || !nextFile) {
        fail("csr campaign patch add requires --base-file and --next-file.");
      }
      const comparisons = values(options, "comparison").map((entry) => {
        try {
          return JSON.parse(entry);
        } catch {
          fail("Each --comparison must contain valid JSON.");
        }
      });
      outputJson(
        io.stdout,
        await registerCampaignPatch({
          rootDir,
          id,
          assetPath: value(options, "path"),
          baseContent: await readFile(path.resolve(baseFile), "utf8"),
          nextContent: await readFile(path.resolve(nextFile), "utf8"),
          revision: integer(value(options, "revision"), null),
          comparisons,
          rationale: value(options, "rationale", "")
        })
      );
      return;
    }
    if (patchAction === "promote") {
      outputJson(io.stdout, await promoteCampaignPatch({ rootDir, id, patchId: value(options, "patch") }));
      return;
    }
    fail("Usage: csr campaign patch <add|promote> --run <campaign-id> ...");
  }

  if (action === "rollback") {
    outputJson(io.stdout, await rollbackCampaignPatch({ rootDir, id, patchId: value(options, "patch") }));
    return;
  }

  if (action === "bridge") {
    const bridge = startAppServerCampaignBridge({
      rootDir,
      campaignId: id,
      onError: (error) => {
        appendCampaignEvent({
          rootDir,
          id,
          type: "campaign.app-server.error",
          role: "system",
          data: { message: error.message }
        }).catch(() => {});
      }
    });
    try {
      await bridge.ready;
    } catch (error) {
      bridge.close();
      outputJson(io.stdout, {
        status: "unavailable",
        message: error.message,
        fallback: "Use csr campaign measure with an explicitly selected completed session."
      });
      return;
    }
    io.stdout.write(`Observing App Server for campaign ${id}. Press Ctrl+C to stop.\n`);
    await new Promise((resolve) => {
      process.once("SIGINT", () => {
        bridge.close();
        resolve();
      });
    });
    return;
  }

  fail("Usage: csr campaign <create|list|archive|restore|attach|asset|status|run|events|event|overlay|validate|measure|patch|rollback|bridge> ...");
}

export function isOptimizerCliCommand(argv) {
  return ["sessions", "session", "campaign"].includes(argv[0]);
}

export async function runOptimizerCli(argv, io = { stdin: process.stdin, stdout: process.stdout }) {
  const [scope, ...remaining] = argv;
  if (scope === "sessions") {
    await runSessions(remaining, io);
    return;
  }
  if (scope === "session") {
    await runSession(remaining, io);
    return;
  }
  if (scope === "campaign") {
    await runCampaign(remaining, io);
    return;
  }
  fail("Unknown optimizer CLI command.");
}
