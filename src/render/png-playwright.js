import { readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function isPngRuntimeAvailable() {
  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

export async function assertPngRuntimeAvailable() {
  let chromium;

  try {
    ({ chromium } = await import("playwright"));
  } catch (error) {
    if (error instanceof Error) {
      const wrapped = new Error(
        "Playwright is not installed. Install the `playwright` package and Chromium to enable PNG export."
      );
      wrapped.code = "PLAYWRIGHT_BROWSER_MISSING";
      wrapped.cause = error;
      throw wrapped;
    }

    throw error;
  }

  let browser;

  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    if (error instanceof Error && error.message.includes("Executable doesn't exist")) {
      const wrapped = new Error(
        "Playwright Chromium is not installed yet. Run `npm run install:browser` and try again."
      );
      wrapped.code = "PLAYWRIGHT_BROWSER_MISSING";
      throw wrapped;
    }

    throw error;
  } finally {
    await browser?.close();
  }
}

export async function exportHtmlToPng({
  htmlPath,
  imagePath,
  width,
  maxSliceHeight = 7000,
  deviceScaleFactor = 2
}) {
  let browser;
  let chromium;

  try {
    try {
      ({ chromium } = await import("playwright"));
    } catch (error) {
      if (error instanceof Error) {
        const wrapped = new Error(
          "Playwright is not installed. Install the `playwright` package and Chromium to enable PNG export."
        );
        wrapped.code = "PLAYWRIGHT_BROWSER_MISSING";
        wrapped.cause = error;
        throw wrapped;
      }

      throw error;
    }

    browser = await chromium.launch({ headless: true });
  } catch (error) {
    if (error instanceof Error && error.message.includes("Executable doesn't exist")) {
      const wrapped = new Error(
        "Playwright Chromium is not installed yet. Run `npm run install:browser` and try again."
      );
      wrapped.code = "PLAYWRIGHT_BROWSER_MISSING";
      throw wrapped;
    }

    throw error;
  }

  try {
    const page = await browser.newPage({
      viewport: {
        width,
        height: 900
      },
      deviceScaleFactor
    });

    page.setDefaultTimeout(0);
    page.setDefaultNavigationTimeout(0);

    await page.goto(pathToFileURL(htmlPath).href, {
      waitUntil: "networkidle"
    });
    await page.evaluate(async () => {
      if (document.fonts?.ready) {
        await document.fonts.ready;
      }
    });

    const totalHeight = await page.evaluate(() =>
      Math.ceil(
        Math.max(
          document.body.scrollHeight,
          document.body.offsetHeight,
          document.documentElement.scrollHeight,
          document.documentElement.offsetHeight
        )
      )
    );

    const imagePaths = [];
    const extension = path.extname(imagePath);
    const baseName = path.basename(imagePath, extension);
    const directory = path.dirname(imagePath);
    const slices = Math.max(1, Math.ceil(totalHeight / maxSliceHeight));
    const existingFiles = await readdir(directory);

    await Promise.all(
      existingFiles
        .filter(
          (entry) =>
            entry === `${baseName}${extension}` ||
            (entry.startsWith(`${baseName}-`) && entry.endsWith(extension))
        )
        .map((entry) => unlink(path.join(directory, entry)))
    );

    for (let index = 0; index < slices; index += 1) {
      const offset = index * maxSliceHeight;
      const sliceHeight = Math.min(maxSliceHeight, totalHeight - offset);
      const targetPath =
        slices === 1
          ? imagePath
          : path.join(directory, `${baseName}-${String(index + 1).padStart(2, "0")}${extension}`);

      await page.setViewportSize({
        width,
        height: Math.max(1, sliceHeight)
      });
      await page.evaluate((scrollY) => window.scrollTo(0, scrollY), offset);
      await page.waitForTimeout(50);

      await page.screenshot({
        path: targetPath,
        type: "png",
        timeout: 0,
        animations: "disabled"
      });

      imagePaths.push(targetPath);
    }

    return imagePaths;
  } finally {
    await browser.close();
  }
}

export async function screenshotHtml(options) {
  return exportHtmlToPng({
    ...options,
    maxSliceHeight: options.maxSliceHeight ?? 7000,
    deviceScaleFactor: options.deviceScaleFactor ?? 2
  });
}

export async function screenshotHtmlWithOptions(options) {
  return exportHtmlToPng(options);
}
