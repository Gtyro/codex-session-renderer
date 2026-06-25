import test from "node:test";
import assert from "node:assert/strict";
import {
  buildBrowserUrlState,
  normalizeBrowserOptions,
  parseBrowserUrlState
} from "../src/web/browser-url-state.js";

test("parseBrowserUrlState restores session selection, scope, search, and reading options", () => {
  const route = parseBrowserUrlState(
    "/c/6a3c8ea2-82e8-83ee-b6e9-0e3fcf7bfab7?scope=archived&q=ssh&all=0&rounds=3&includeDeveloper=1&includeReasoning=1"
  );

  assert.deepEqual(route, {
    scope: "archived",
    search: "ssh",
    selectedSessionId: "6a3c8ea2-82e8-83ee-b6e9-0e3fcf7bfab7",
    selectedSession: null,
    options: {
      rounds: 3,
      all: false,
      includeContext: false,
      includeDeveloper: true,
      includeReasoning: true
    }
  });
});

test("parseBrowserUrlState derives archived scope from the selected session when scope is missing", () => {
  const route = parseBrowserUrlState("/?location=archived&relativePath=2026/06/25/demo.jsonl");

  assert.equal(route.scope, "archived");
  assert.equal(route.selectedSessionId, "");
  assert.deepEqual(route.selectedSession, {
    location: "archived_sessions",
    relativePath: "2026/06/25/demo.jsonl"
  });
  assert.deepEqual(route.options, normalizeBrowserOptions());
});

test("buildBrowserUrlState uses /c/<id> while preserving non-default reader state", () => {
  const url = buildBrowserUrlState({
    scope: "active",
    search: "",
    selectedSessionId: "6a3c8ea2-82e8-83ee-b6e9-0e3fcf7bfab7",
    options: {
      rounds: 2,
      all: false,
      includeContext: true,
      includeDeveloper: false,
      includeReasoning: true
    }
  });

  assert.equal(
    url,
    "/c/6a3c8ea2-82e8-83ee-b6e9-0e3fcf7bfab7?scope=active&all=0&rounds=2&includeContext=1&includeReasoning=1"
  );
});

test("buildBrowserUrlState round-trips with parseBrowserUrlState for deep links", () => {
  const source = {
    scope: "all",
    search: "latest",
    selectedSessionId: "6a3c8ea2-82e8-83ee-b6e9-0e3fcf7bfab7",
    selectedSession: null,
    options: {
      rounds: 1,
      all: true,
      includeContext: false,
      includeDeveloper: true,
      includeReasoning: false
    }
  };

  assert.deepEqual(parseBrowserUrlState(buildBrowserUrlState(source)), source);
});

test("buildBrowserUrlState falls back to the legacy query shape when only file coordinates are known", () => {
  const url = buildBrowserUrlState({
    scope: "active",
    search: "",
    selectedSession: {
      location: "sessions",
      relativePath: "2026/06/25/demo.jsonl"
    },
    options: normalizeBrowserOptions()
  });

  assert.equal(
    url,
    "/?scope=active&location=sessions&relativePath=2026%2F06%2F25%2Fdemo.jsonl"
  );
});
