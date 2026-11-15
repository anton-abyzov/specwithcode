// Build first: node node_modules/vite-plus/bin/vp build --config apps/web/tests/subscription-resets/vite.config.ts
// Then: node apps/web/tests/subscription-resets/verify.mjs /absolute/report-dir
// Always headless. Serves the fixture only; every other request is aborted. Fictional data.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const assert = NodeAssert.default;
const { mkdir, readFile, writeFile } = NodeFSP;
const { extname, join, resolve, sep } = NodePath;

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = process.env.STUDIO_PLAYWRIGHT_MODULE
  ? await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href)
  : NodeModule.createRequire(resolve("apps/server/package.json"))("playwright-core");

const root = resolve(".artifacts/subscription-resets/site");
const output = resolve(process.argv[2] ?? ".artifacts/subscription-resets/evidence");
await mkdir(output, { recursive: true });
const MIME = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(root + sep)) return void res.writeHead(403).end();
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "text/html" }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
// Saturday evening in New York, so week columns and "Nov" dates are fixed.
const NOW = new Date("2026-11-15T01:00:00Z");

const checks = [];
const errors = [];
const browser = await chromium.launch({
  headless: true,
  ...(process.env.STUDIO_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE }
    : {}),
});
let passed = false;
try {
  const context = await browser.newContext({
    reducedMotion: "reduce",
    timezoneId: "America/New_York",
    locale: "en-US",
  });
  await context.clock.setFixedTime(NOW);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.route("**/*", (route) =>
    route.request().url().startsWith(origin) ? route.continue() : route.abort(),
  );
  const open = async (scenario, theme, width) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${origin}/?case=${scenario}&theme=${theme}`);
    await page.locator("[data-fixture-ready]").waitFor();
  };
  const check = async (name, run) => {
    await run();
    checks.push(name);
  };

  for (const width of [390, 1280]) {
    for (const theme of ["light", "dark"]) {
      await open("full", theme, width);
      await check(`${width} ${theme}: no sideways scroll`, async () => {
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
        );
      });
      await page.screenshot({
        path: join(output, `subscriptions-${theme}-${width}.png`),
        fullPage: true,
      });
    }
  }

  await open("full", "light", 1280);
  const rows = page.locator("[data-subscription-row]");
  await check("the account about to lose quota is first and its window is marked", async () => {
    assert.equal(await rows.count(), 3);
    const first = rows.nth(0);
    assert.match(await first.innerText(), /Pro/);
    assert.match(await first.innerText(), /mini/);
    assert.match(await first.innerText(), /62% left · 9h 0m/);
    assert.equal(await first.locator("[data-expiring]").count(), 1);
    assert.equal(await page.locator("[data-expiring]").count(), 1);
  });
  await check("banked resets, set renewal day and the last loss show on the Codex row", async () => {
    const text = await rows.nth(0).innerText();
    assert.match(text, /2 banked resets, next expires Nov 21/);
    assert.match(text, /Renews Dec 2/);
    assert.match(text, /Lost at last reset: 41%/);
  });
  await check("the provider's renewal date shows without an edit action", async () => {
    const claude = page.locator('[data-subscription-row="claude"]');
    assert.match(await claude.innerText(), /Renews Nov 17/);
    assert.equal(await claude.getByRole("button", { name: "Set day" }).count(), 0);
    assert.match(await claude.innerText(), /Lost at last reset: 4%/);
  });
  await check("an offline machine keeps its reading, its age, and an upper-bound loss", async () => {
    const text = await page.locator('[data-subscription-row="codex-2"]').innerText();
    assert.match(text, /offline, read 3h 0m ago/);
    assert.match(text, /Renewal: Not reported/);
    assert.match(text, /up to 73%/);
  });
  await check("the renewal day editor accepts 1 to 31 only", async () => {
    const row = page.locator('[data-subscription-row="codex-2"]');
    await row.getByRole("button", { name: "Set day" }).click();
    const input = row.getByLabel("Day of the month the subscription renews");
    await input.fill("40");
    assert.equal(await row.getByRole("button", { name: "Save" }).isDisabled(), true);
    await input.fill("17");
    assert.equal(await row.getByRole("button", { name: "Save" }).isDisabled(), false);
    await row.getByRole("button", { name: "Cancel" }).click();
  });
  await check("the report totals, table and token estimate are stated", async () => {
    const report = page.locator("[data-reset-report]");
    const text = await report.innerText();
    assert.match(text, /Lost this week: 45%/);
    assert.match(text, /Claude.*Max 20x · studio-mac/);
    assert.match(text, /9% over 4 resets/);
    assert.match(text, /~127M/);
    assert.match(text, /Not measurable/);
    assert.equal(await report.locator("[data-report-account]").count(), 3);
  });

  await open("empty", "light", 1280);
  await check("with no readings it says so, and never shows a zero", async () => {
    assert.equal(await page.locator("[data-fixture-empty]").count(), 1);
    assert.equal(await page.locator('[data-reset-report="empty"]').count(), 1);
    assert.doesNotMatch(await page.locator("body").innerText(), /0%/);
  });
  await page.screenshot({ path: join(output, "subscriptions-empty.png"), fullPage: true });

  assert.deepEqual(errors, [], "page errors");
  passed = true;
} finally {
  await browser.close();
  server.close();
  await writeFile(
    join(output, "result.json"),
    `${JSON.stringify({ passed, checks, errors }, null, 2)}\n`,
  );
}
console.log(`${checks.length} checks passed; evidence in ${output}`);
