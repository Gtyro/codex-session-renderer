import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SESSION_ID_PATTERN = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

export function getDefaultSessionsDir() {
  return path.join(os.homedir(), ".codex", "sessions");
}

async function collectSessionFiles(rootDir) {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectSessionFiles(fullPath)));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }

  return files;
}

function sessionIdFromPath(filePath) {
  const match = path.basename(filePath).match(SESSION_ID_PATTERN);
  return match ? match[1] : path.basename(filePath, ".jsonl");
}

export async function resolveSessionFile({ sessionsDir, latest, id }) {
  const files = (await collectSessionFiles(sessionsDir)).sort((left, right) =>
    left.localeCompare(right)
  );

  if (files.length === 0) {
    throw new Error(`No session files were found in ${sessionsDir}`);
  }

  if (latest) {
    return files.at(-1);
  }

  const normalizedId = String(id).toLowerCase();
  const matches = files.filter((filePath) =>
    sessionIdFromPath(filePath).toLowerCase().includes(normalizedId)
  );

  if (matches.length === 0) {
    throw new Error(`No session matched ID fragment "${id}" in ${sessionsDir}`);
  }

  if (matches.length > 1) {
    const candidates = matches
      .slice(0, 10)
      .map((filePath) => `- ${sessionIdFromPath(filePath)} (${filePath})`)
      .join("\n");
    throw new Error(`More than one session matched "${id}":\n${candidates}`);
  }

  return matches[0];
}

export function extractSessionId(filePath) {
  return sessionIdFromPath(filePath);
}
