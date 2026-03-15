#!/usr/bin/env node

import { mkdir, readdir, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { resolveSessionFile, getDefaultSessionsDir } from "./lib/session-store.js";
import { loadSession, selectRecentRounds, splitSessionIntoRounds } from "./lib/session-parser.js";
import { sessionToMarkdown } from "./lib/markdown.js";
import { renderMarkdownDocument, screenshotHtmlWithOptions } from "./lib/render.js";

const CLI_COMMANDS = ["codex-session-renderer", "csr"];
const COMPLETION_SHELLS = ["bash", "zsh", "fish"];

function printHelp() {
  const commandExamples = CLI_COMMANDS.flatMap((command) => [
    `  ${command} --latest [options]`,
    `  ${command} --id <session-id> [options]`
  ]).join("\n");

  console.log(`Usage:
${commandExamples}

Options:
  --latest                  Render the latest session file
  --id <session-id>         Render a specific session by ID or unique ID fragment
  --sessions-dir <path>     Override the default sessions dir
  --output-dir <path>       Write files into this directory (default: ./output)
  --width <px>              Screenshot viewport width in pixels (default: 1440)
  --rounds <n>              Include only the most recent n conversation rounds (default: 1)
  --all                     Include the whole session instead of only recent rounds
  --clean-output            Remove existing files in the output directory before rendering
  --only-images             Save only final PNG images and skip markdown/html artifacts
  --include-context         Keep injected AGENTS/environment context messages
  --include-developer       Keep developer messages
  --include-reasoning       Keep reasoning summaries when present
  --print-completion <sh>   Print a completion script for bash, zsh, or fish
  --help, -h                Show this help message
`);
}

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {
    latest: false,
    id: null,
    sessionsDir: getDefaultSessionsDir(),
    outputDir: path.resolve(process.cwd(), "output"),
    width: 1440,
    rounds: 1,
    all: false,
    cleanOutput: false,
    onlyImages: false,
    includeContext: false,
    includeDeveloper: false,
    includeReasoning: false,
    printCompletion: null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    switch (arg) {
      case "--latest":
        options.latest = true;
        break;
      case "--id":
        index += 1;
        options.id = argv[index] ?? fail("Missing value after --id");
        break;
      case "--sessions-dir":
        index += 1;
        options.sessionsDir = path.resolve(argv[index] ?? fail("Missing value after --sessions-dir"));
        break;
      case "--output-dir":
        index += 1;
        options.outputDir = path.resolve(argv[index] ?? fail("Missing value after --output-dir"));
        break;
      case "--width":
        index += 1;
        options.width = Number.parseInt(argv[index] ?? fail("Missing value after --width"), 10);
        break;
      case "--rounds":
        index += 1;
        options.rounds = Number.parseInt(argv[index] ?? fail("Missing value after --rounds"), 10);
        break;
      case "--all":
        options.all = true;
        break;
      case "--clean-output":
        options.cleanOutput = true;
        break;
      case "--only-images":
        options.onlyImages = true;
        break;
      case "--include-context":
        options.includeContext = true;
        break;
      case "--include-developer":
        options.includeDeveloper = true;
        break;
      case "--include-reasoning":
        options.includeReasoning = true;
        break;
      case "--print-completion":
        index += 1;
        options.printCompletion = argv[index] ?? fail("Missing value after --print-completion");
        if (!COMPLETION_SHELLS.includes(options.printCompletion)) {
          fail(`Unsupported shell for --print-completion: ${options.printCompletion}`);
        }
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        fail(`Unknown argument: ${arg}`);
    }
  }

  if (options.latest && options.id) {
    fail("Use either --latest or --id, not both.");
  }

  if (!Number.isFinite(options.width) || options.width < 720) {
    fail("--width must be a number greater than or equal to 720.");
  }

  if (!options.all && (!Number.isFinite(options.rounds) || options.rounds < 1)) {
    fail("--rounds must be an integer greater than or equal to 1.");
  }

  if (!options.printCompletion && !options.latest && !options.id) {
    options.latest = true;
  }

  return options;
}

function getBashCompletionScript() {
  const optionWords = [
    "--latest",
    "--id",
    "--sessions-dir",
    "--output-dir",
    "--width",
    "--rounds",
    "--all",
    "--clean-output",
    "--only-images",
    "--include-context",
    "--include-developer",
    "--include-reasoning",
    "--print-completion",
    "--help",
    "-h"
  ].join(" ");

  const shellWords = COMPLETION_SHELLS.join(" ");
  const commandWords = CLI_COMMANDS.join(" ");

  return `
_codex_session_renderer_complete() {
  local cur prev
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  local opts="${optionWords}"
  local shells="${shellWords}"

  case "$prev" in
    --print-completion)
      COMPREPLY=( $(compgen -W "$shells" -- "$cur") )
      return 0
      ;;
    --sessions-dir|--output-dir)
      COMPREPLY=( $(compgen -d -- "$cur") )
      return 0
      ;;
    --id|--width|--rounds)
      COMPREPLY=()
      return 0
      ;;
  esac

  if [[ "$cur" == -* ]]; then
    COMPREPLY=( $(compgen -W "$opts" -- "$cur") )
    return 0
  fi

  COMPREPLY=()
}

complete -F _codex_session_renderer_complete ${commandWords}
`.trimStart();
}

function getZshCompletionScript() {
  return `
_codex_session_renderer_complete() {
  _arguments -s \\
    '--latest[Render the latest session file]' \\
    '--id[Render a specific session by ID or unique ID fragment]:session id:' \\
    '--sessions-dir[Override the default sessions dir]:sessions directory:_files -/' \\
    '--output-dir[Write files into this directory (default: ./output)]:output directory:_files -/' \\
    '--width[Screenshot viewport width in pixels (default: 1440)]:width:' \\
    '--rounds[Include only the most recent n conversation rounds (default: 1)]:round count:' \\
    '--all[Include the whole session instead of only recent rounds]' \\
    '--clean-output[Remove existing files in the output directory before rendering]' \\
    '--only-images[Save only final PNG images and skip markdown/html artifacts]' \\
    '--include-context[Keep injected AGENTS/environment context messages]' \\
    '--include-developer[Keep developer messages]' \\
    '--include-reasoning[Keep reasoning summaries when present]' \\
    '--print-completion[Print a completion script]:shell:(${COMPLETION_SHELLS.join(" ")})' \\
    '--help[Show this help message]' \\
    '-h[Show this help message]'
}

compdef _codex_session_renderer_complete ${CLI_COMMANDS.join(" ")}
`.trimStart();
}

function getFishCompletionScript() {
  return `
for cmd in ${CLI_COMMANDS.join(" ")}
  complete -c $cmd -l latest -d "Render the latest session file"
  complete -c $cmd -l id -r -d "Render a specific session by ID or unique ID fragment"
  complete -c $cmd -l sessions-dir -r -a "(__fish_complete_directories)" -d "Override the default sessions dir"
  complete -c $cmd -l output-dir -r -a "(__fish_complete_directories)" -d "Write files into this directory"
  complete -c $cmd -l width -r -d "Screenshot viewport width in pixels"
  complete -c $cmd -l rounds -r -d "Include only the most recent n conversation rounds"
  complete -c $cmd -l all -d "Include the whole session instead of only recent rounds"
  complete -c $cmd -l clean-output -d "Remove existing files in the output directory before rendering"
  complete -c $cmd -l only-images -d "Save only final PNG images and skip markdown/html artifacts"
  complete -c $cmd -l include-context -d "Keep injected AGENTS/environment context messages"
  complete -c $cmd -l include-developer -d "Keep developer messages"
  complete -c $cmd -l include-reasoning -d "Keep reasoning summaries when present"
  complete -c $cmd -l print-completion -r -a "${COMPLETION_SHELLS.join(" ")}" -d "Print a completion script"
  complete -c $cmd -l help -s h -d "Show this help message"
end
`.trimStart();
}

function getCompletionScript(shell) {
  switch (shell) {
    case "bash":
      return getBashCompletionScript();
    case "zsh":
      return getZshCompletionScript();
    case "fish":
      return getFishCompletionScript();
    default:
      fail(`Unsupported shell: ${shell}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.printCompletion) {
    console.log(getCompletionScript(options.printCompletion));
    return;
  }

  const sessionFile = await resolveSessionFile({
    sessionsDir: options.sessionsDir,
    latest: options.latest,
    id: options.id
  });

  const loadedSession = await loadSession(sessionFile, {
    includeContext: options.includeContext,
    includeDeveloper: options.includeDeveloper,
    includeReasoning: options.includeReasoning
  });
  const session = options.all ? selectRecentRounds(loadedSession, 0) : selectRecentRounds(loadedSession, options.rounds);

  const markdown = sessionToMarkdown(session, { mode: "full" });
  const compactMarkdown = sessionToMarkdown(session, { mode: "compact" });
  const html = renderMarkdownDocument({
    session,
    markdown: compactMarkdown,
    generatedAt: new Date().toISOString(),
    titleSuffix: "Compact"
  });
  const roundSessions = splitSessionIntoRounds(session);

  await mkdir(options.outputDir, { recursive: true });
  if (options.cleanOutput) {
    await emptyDirectory(options.outputDir);
  }

  const markdownPath = path.join(options.outputDir, `${session.id}.md`);
  const compactMarkdownPath = path.join(options.outputDir, `${session.id}.compact.md`);
  const htmlPath = path.join(options.outputDir, `${session.id}.compact.html`);

  if (!options.onlyImages) {
    await writeFile(markdownPath, markdown, "utf8");
    await writeFile(compactMarkdownPath, compactMarkdown, "utf8");
    await writeFile(htmlPath, html, "utf8");
  }

  await removeSessionArtifacts(options.outputDir, session.id, {
    removeDocuments: options.onlyImages
  });

  const roundArtifacts = [];

  for (const roundSession of roundSessions) {
    const roundLabel = `Round ${String(roundSession.round?.index ?? 1)}`;
    const roundSuffix = `.round-${String(roundSession.round?.index ?? 1).padStart(2, "0")}.compact`;
    const roundHtmlPath = path.join(options.outputDir, `${session.id}${roundSuffix}.html`);
    const roundImagePath = path.join(options.outputDir, `${session.id}${roundSuffix}.png`);
    const roundMarkdown = sessionToMarkdown(roundSession, { mode: "compact" });
    const roundHtml = renderMarkdownDocument({
      session: roundSession,
      markdown: roundMarkdown,
      generatedAt: new Date().toISOString(),
      titleSuffix: `Compact ${roundLabel}`
    });

    await writeFile(roundHtmlPath, roundHtml, "utf8");
    const roundImagePaths = await screenshotHtmlWithOptions({
      htmlPath: roundHtmlPath,
      imagePath: roundImagePath,
      width: options.width,
      maxSliceHeight: 14000,
      deviceScaleFactor: 1
    });

    if (options.onlyImages) {
      await unlink(roundHtmlPath);
    }

    roundArtifacts.push({
      roundLabel,
      htmlPath: options.onlyImages ? null : roundHtmlPath,
      imagePaths: roundImagePaths
    });
  }

  console.log(`Session: ${session.id}`);
  console.log(`Source:  ${session.filePath}`);
  if (session.selection?.mode === "recent_rounds") {
    const total = session.selection.totalRounds ?? session.selection.roundsIncluded;
    console.log(`Rounds:  last ${session.selection.roundsIncluded} of ${total}`);
  } else {
    console.log(`Rounds:  all`);
  }
  if (options.onlyImages) {
    console.log("Mode:    images only");
  } else {
    console.log(`Full Markdown:    ${markdownPath}`);
    console.log(`Compact Markdown: ${compactMarkdownPath}`);
    console.log(`Compact HTML:     ${htmlPath}`);
    console.log("Round HTML:");
    roundArtifacts.forEach((artifact) => {
      console.log(`  - ${artifact.roundLabel}: ${artifact.htmlPath}`);
    });
  }
  console.log("Round Images:");
  roundArtifacts.forEach((artifact) => {
    artifact.imagePaths.forEach((itemPath) => {
      console.log(`  - ${artifact.roundLabel}: ${itemPath}`);
    });
  });
}

async function emptyDirectory(outputDir) {
  const entries = await readdir(outputDir, { withFileTypes: true });

  await Promise.all(
    entries.map((entry) =>
      rm(path.join(outputDir, entry.name), {
        recursive: true,
        force: true
      })
    )
  );
}

async function removeSessionArtifacts(outputDir, sessionId, options = {}) {
  const entries = await readdir(outputDir);

  await Promise.all(
    entries
      .filter(
        (entry) =>
          entry === `${sessionId}.compact.png` ||
          (entry.startsWith(`${sessionId}.compact-`) && entry.endsWith(".png")) ||
          (options.removeDocuments &&
            (entry === `${sessionId}.md` ||
              entry === `${sessionId}.compact.md` ||
              entry === `${sessionId}.compact.html`)) ||
          (entry.startsWith(`${sessionId}.round-`) &&
            (entry.endsWith(".png") || entry.endsWith(".html")))
      )
      .map((entry) => unlink(path.join(outputDir, entry)))
  );
}

main().catch((error) => {
  if (error && error.code === "PLAYWRIGHT_BROWSER_MISSING") {
    console.error(error.message);
    process.exit(1);
    return;
  }

  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
