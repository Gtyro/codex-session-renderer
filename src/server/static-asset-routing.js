import path from "node:path";
import { fileURLToPath } from "node:url";

export const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../web");
export const INDEX_FILE = path.join(WEB_ROOT, "index.html");
export const WEB_ASSET_PREFIX = "/assets/";

const STATIC_CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8"
};

export function isBrowserAppRoute(pathname) {
  return pathname === "/" || /^\/c\/[^/]+\/?$/u.test(pathname);
}

export function getRawRequestPathname(requestUrl) {
  const value = String(requestUrl ?? "");
  const queryIndex = value.indexOf("?");

  return queryIndex === -1 ? value : value.slice(0, queryIndex);
}

export function getStaticContentType(filePath) {
  return STATIC_CONTENT_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

export function resolveWebAsset(pathname) {
  if (!pathname.startsWith(WEB_ASSET_PREFIX)) {
    return null;
  }

  const encodedRelativePath = pathname.slice(WEB_ASSET_PREFIX.length);

  if (!encodedRelativePath) {
    return {
      error: new Error("Asset path is missing."),
      statusCode: 404
    };
  }

  let relativePath;

  try {
    relativePath = decodeURIComponent(encodedRelativePath);
  } catch {
    return {
      error: new Error("Asset path is invalid."),
      statusCode: 400
    };
  }

  const filePath = path.resolve(WEB_ROOT, relativePath);
  const relativeFromRoot = path.relative(WEB_ROOT, filePath);

  if (
    relativeFromRoot === "" ||
    relativeFromRoot.startsWith("..") ||
    path.isAbsolute(relativeFromRoot)
  ) {
    return {
      error: new Error("Asset path is outside the web root."),
      statusCode: 403
    };
  }

  return {
    filePath,
    contentType: getStaticContentType(filePath)
  };
}
