import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Reading the source only: importing verify.mjs would start a private server run.
const source = readFileSync(fileURLToPath(new URL("./verify.mjs", import.meta.url)), "utf8");

test("loads Playwright from the repo's pinned dependency or an explicit override only", () => {
  assert.doesNotMatch(
    source,
    /codex-runtimes|\.cache\//,
    "no machine-specific runtime cache default",
  );
  assert.match(
    source,
    /createRequire\(join\(root, "apps\/server\/package\.json"\)\)\("playwright-core"\)/,
  );
  assert.match(source, /process\.env\.STUDIO_TEST_PLAYWRIGHT/);
  const { chromium } = createRequire(new URL("../../../server/package.json", import.meta.url))(
    "playwright-core",
  );
  assert.equal(typeof chromium.launch, "function");
});

test("the browser stays headless with debugging and report opening off", () => {
  assert.match(source, /headless: true/);
  assert.doesNotMatch(source, /headless: false/);
  assert.match(source, /process\.env\.PWDEBUG = "0"/);
  assert.match(source, /process\.env\.PLAYWRIGHT_HTML_OPEN = "never"/);
});
