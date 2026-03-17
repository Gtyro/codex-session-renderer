import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

function getDefaultFontAssetDir() {
  const override = process.env.CODEX_SESSION_RENDERER_FONT_DIR;
  if (override) {
    return path.resolve(override);
  }

  const homeDir = os.homedir();

  switch (process.platform) {
    case "win32":
      return path.join(process.env.LOCALAPPDATA || path.join(homeDir, "AppData", "Local"), "codex-session-renderer", "fonts");
    case "darwin":
      return path.join(homeDir, "Library", "Application Support", "codex-session-renderer", "fonts");
    default:
      return path.join(process.env.XDG_DATA_HOME || path.join(homeDir, ".local", "share"), "codex-session-renderer", "fonts");
  }
}

export const FONT_ASSET_DIR = getDefaultFontAssetDir();
export const SOURCE_HAN_SANS_SC_VERSION = "2.005R";

const SOURCE_HAN_SANS_SC_BASE_URL =
  `https://raw.githubusercontent.com/adobe-fonts/source-han-sans/${SOURCE_HAN_SANS_SC_VERSION}`;

export const FONT_ASSETS = {
  regular: {
    filename: "SourceHanSansSC-Regular.otf",
    url: `${SOURCE_HAN_SANS_SC_BASE_URL}/OTF/SimplifiedChinese/SourceHanSansSC-Regular.otf`,
    sha256: "f1d8611151880c6c336aabeac4640ef434fa13cbfbf1ffe82d0a71b2a5637256"
  },
  bold: {
    filename: "SourceHanSansSC-Bold.otf",
    url: `${SOURCE_HAN_SANS_SC_BASE_URL}/OTF/SimplifiedChinese/SourceHanSansSC-Bold.otf`,
    sha256: "df2b90f5bcc6d01dfc964cec5f6d535d6b6aebd26ed7fd79a9c1b3f2112fcb6b"
  },
  license: {
    filename: "LICENSE.txt",
    url: `${SOURCE_HAN_SANS_SC_BASE_URL}/LICENSE.txt`,
    sha256: "fcac737e761ec63dbfbdce11030a1780161920d80315edba9c8beff1c2bac5a2"
  }
};

const REQUIRED_FONT_KEYS = ["regular", "bold"];

function getAssetPath(asset) {
  return path.join(FONT_ASSET_DIR, asset.filename);
}

function createMissingFontsError() {
  const error = new Error(
    `Chinese font assets are not installed yet. Run \`npm run install:fonts\` in a checkout, or \`codex-session-renderer --install-fonts\` after a global install, then try again. Expected fonts in ${FONT_ASSET_DIR}.`
  );
  error.code = "FONT_ASSETS_MISSING";
  return error;
}

export function getInstalledFontUrls() {
  const missingAssets = REQUIRED_FONT_KEYS.map((key) => FONT_ASSETS[key]).filter(
    (asset) => !existsSync(getAssetPath(asset))
  );

  if (missingAssets.length > 0) {
    throw createMissingFontsError();
  }

  return {
    regular: pathToFileURL(getAssetPath(FONT_ASSETS.regular)).href,
    bold: pathToFileURL(getAssetPath(FONT_ASSETS.bold)).href
  };
}

async function hashFile(filePath) {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);

  for await (const chunk of stream) {
    hash.update(chunk);
  }

  return hash.digest("hex");
}

async function downloadAssetWithFetch(asset, tempPath) {
  const response = await fetch(asset.url, {
    redirect: "follow",
    headers: {
      "user-agent": "codex-session-renderer"
    }
  });

  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${asset.filename}: ${response.status} ${response.statusText}`);
  }

  await pipeline(Readable.fromWeb(response.body), createWriteStream(tempPath));
}

async function downloadAssetWithCurl(asset, tempPath) {
  await new Promise((resolve, reject) => {
    const child = spawn("curl", ["-L", "--fail", "--silent", "--show-error", "-o", tempPath, asset.url], {
      stdio: "inherit"
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          signal
            ? `curl terminated while downloading ${asset.filename}: ${signal}`
            : `curl exited with code ${code} while downloading ${asset.filename}.`
        )
      );
    });
  });
}

async function downloadAsset(asset, logger) {
  const targetPath = getAssetPath(asset);
  const tempPath = `${targetPath}.download`;

  logger.log(`Downloading ${asset.filename}...`);

  try {
    try {
      await downloadAssetWithFetch(asset, tempPath);
    } catch (error) {
      logger.log(`Fetch failed for ${asset.filename}. Trying curl fallback.`);
      await downloadAssetWithCurl(asset, tempPath);
    }

    const digest = await hashFile(tempPath);
    if (digest !== asset.sha256) {
      throw new Error(`Checksum mismatch for ${asset.filename}. Expected ${asset.sha256}, got ${digest}.`);
    }

    await rename(tempPath, targetPath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

export async function installBundledFonts({ logger = console } = {}) {
  await mkdir(FONT_ASSET_DIR, { recursive: true });

  for (const asset of Object.values(FONT_ASSETS)) {
    const assetPath = getAssetPath(asset);

    if (existsSync(assetPath)) {
      const digest = await hashFile(assetPath);
      if (digest === asset.sha256) {
        logger.log(`Using existing ${asset.filename}.`);
        continue;
      }

      logger.log(`Replacing ${asset.filename} because its checksum does not match the pinned release.`);
      await rm(assetPath, { force: true });
    }

    await downloadAsset(asset, logger);
  }

  logger.log(`Installed Source Han Sans SC ${SOURCE_HAN_SANS_SC_VERSION} into ${FONT_ASSET_DIR}.`);
}
