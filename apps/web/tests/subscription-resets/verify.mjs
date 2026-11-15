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

  await open("full", "dark", 1280);
  await check("the banner names the expiring account, then the early reset", async () => {
    const banner = page.locator("[data-quota-alert-banner]");
    const text = await banner.innerText();
    assert.match(text, /Codex Pro on mini: 62% of its weekly quota resets in 9 h/);
    assert.match(text, /reset early: weekly back to 100%/);
    assert.equal(await banner.getByRole("button", { name: "Dismiss until the next reset" }).count(), 1);
    await banner.screenshot({ path: join(output, "quota-alert-banner-dark.png") });
  });
  await check("the boost starts for the picked projects, is named with its end, and ends", async () => {
    const banner = page.locator("[data-quota-alert-banner]");
    await banner.getByRole("button", { name: "Use it for new threads until it resets" }).click();
    // Focus follows the picker in, and comes back to the button on Cancel.
    assert.equal(await banner.getByLabel("Every project").evaluate((el) => el === document.activeElement), true);
    await banner.getByRole("button", { name: "Cancel" }).click();
    const start = banner.getByRole("button", { name: "Use it for new threads until it resets" });
    assert.equal(await start.evaluate((el) => el === document.activeElement), true);
    await start.click();
    await banner.getByLabel("Every project").uncheck();
    assert.equal(await banner.getByRole("button", { name: "Start" }).isDisabled(), true);
    await banner.getByLabel("Atlas").check();
    await banner.getByRole("button", { name: "Start" }).click();
    assert.match(await banner.innerText(), /New threads use Codex Pro until /);
    assert.equal(
      await banner.getByRole("button", { name: "End now" }).evaluate((el) => el === document.activeElement),
      true,
    );
    // Atlas lives on two machines: both of its ids are covered.
    assert.equal(
      await page.locator("[data-fixture-boost-projects]").getAttribute("data-fixture-boost-projects"),
      "2",
    );
    assert.equal(
      await banner.getByRole("button", { name: "Use it for new threads until it resets" }).count(),
      0,
    );
    await banner.screenshot({ path: join(output, "quota-boost-running-dark.png") });
    await banner.getByRole("button", { name: "End now" }).click();
    assert.equal(await banner.locator("[data-quota-boost]").count(), 0);
    // "See subscriptions" is the fixture's handler, never the browser's window.open.
    await banner.getByRole("button", { name: "See subscriptions" }).click();
    assert.equal(page.context().pages().length, 1);
    await banner.getByRole("button", { name: "Use it for new threads until it resets" }).click();
    await banner.screenshot({ path: join(output, "quota-boost-pick-dark.png") });
  });
  await open("full", "light", 1280);
  await page.locator("[data-quota-alert-banner]").screenshot({
    path: join(output, "quota-alert-banner-light.png"),
  });
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
  const dashboard = page.locator("[data-subscriptions-dashboard]");
  await check("the score, what was left unused and what resets soon lead the page", async () => {
    assert.match(await dashboard.locator("[data-efficiency-score]").innerText(), /^\d+%$/);
    // A reset in range was read long before it happened, so the score is a floor.
    assert.equal(await dashboard.locator("[data-efficiency-floor]").innerText(), "at least");
    const unused = await dashboard.locator('[data-dashboard-tile="unused"]').innerText();
    assert.match(unused, /up to \d+%/);
    assert.match(unused, /tokens \(estimate\)/);
    const expiring = await dashboard.locator('[data-dashboard-tile="expiring"]').innerText();
    assert.match(expiring, /62% left/);
    assert.match(expiring, /resets in 9h 0m/);
    const banked = await dashboard.locator('[data-dashboard-tile="banked"]').innerText();
    assert.match(banked, /2/);
    assert.match(banked, /next expires Nov 21/);
  });
  await check("twelve columns, four in range, and grouping by provider, account or machine", async () => {
    assert.equal(await dashboard.locator("[data-efficiency-column]").count(), 12);
    assert.equal(await dashboard.locator("[data-efficiency-column][data-in-range]").count(), 4);
    assert.equal(await dashboard.locator("[data-dashboard-group]").count(), 2);
    await dashboard.getByRole("button", { name: "Account", exact: true }).click();
    assert.equal(await dashboard.locator("[data-dashboard-group]").count(), 3);
    const spare = await dashboard
      .locator('[data-dashboard-group="codex:team@example.com"]')
      .innerText();
    assert.match(spare, /27%/);
    assert.match(spare, /plan 30%/);
    await dashboard.getByRole("button", { name: "Machine", exact: true }).click();
    assert.equal(await dashboard.locator('[data-dashboard-group="machine:mini"]').count(), 1);
  });
  await check("a plan takes 1 to 100 percent only", async () => {
    await dashboard.getByRole("button", { name: "Account", exact: true }).click();
    const group = dashboard.locator('[data-dashboard-group="codex:ada@example.com"]');
    await group.getByRole("button", { name: /plan 100%/ }).click();
    const input = group.getByLabel("Percent of this subscription you plan to use");
    await input.fill("150");
    assert.equal(await group.getByRole("button", { name: "Save" }).isDisabled(), true);
    await input.fill("60");
    assert.equal(await group.getByRole("button", { name: "Save" }).isDisabled(), false);
    await group.getByRole("button", { name: "Cancel" }).click();
  });
  await check("a column reads out its groups and scopes the resets table", async () => {
    const newest = dashboard.locator('[data-efficiency-column="11"]');
    await newest.hover();
    assert.match(
      await dashboard.locator("[data-efficiency-readout]").innerText(),
      /Week of .*: (at least )?\d+% across 2 resets/,
    );
    await newest.click();
    assert.match(await dashboard.locator("[data-resets-heading]").innerText(), /Resets · week of/);
    assert.equal(await dashboard.locator("[data-reset-row]").count(), 2);
    await dashboard.getByRole("button", { name: "Show the whole range" }).click();
    assert.match(await dashboard.locator("[data-resets-heading]").innerText(), /Resets in this range/);
  });
  await check("a reset opens in place with how exact it is and use through the period", async () => {
    const row = dashboard.locator('[data-reset-row^="codex:ada@example.com"]').first();
    await row.click();
    const detail = dashboard.locator("[data-reset-detail]");
    assert.equal(await detail.count(), 1);
    assert.match(await detail.innerText(), /so the figure is exact/);
    assert.match(await detail.innerText(), /mini/);
    assert.equal(await detail.locator("[data-use-path]").count(), 1);
    assert.match(await detail.innerText(), /Busiest \w+day, \w+ \d+/);
    assert.match(await detail.innerText(), /Renews \w+ \d+/);
    assert.match(await detail.innerText(), /Tokens not measurable/);
    await row.click();
    assert.equal(await dashboard.locator("[data-reset-detail]").count(), 0);
    const bound = dashboard.locator('[data-reset-row^="codex:team@example.com"]').first();
    assert.match(await bound.innerText(), /up to 73%/);
  });
  await check("twelve weeks page ten resets at a time, newest first", async () => {
    await dashboard.getByRole("button", { name: "12W", exact: true }).click();
    assert.equal(await dashboard.locator("[data-efficiency-column][data-in-range]").count(), 12);
    assert.match(await dashboard.locator("[data-resets-range]").innerText(), /1 to 10 of 25 resets/);
    await dashboard.getByRole("button", { name: "Next" }).click();
    assert.match(await dashboard.locator("[data-resets-range]").innerText(), /11 to 20 of 25 resets/);
    await dashboard.getByRole("button", { name: "4W", exact: true }).click();
  });
  await check("a month with no reset is reachable by keyboard and says so", async () => {
    await dashboard.getByRole("button", { name: "1Y", exact: true }).click();
    const emptyColumn = dashboard.locator('[data-efficiency-column][aria-disabled="true"]').first();
    await emptyColumn.focus();
    assert.match(await dashboard.locator("[data-efficiency-readout]").innerText(), /no reset recorded/);
    await emptyColumn.blur();
    await dashboard.getByRole("button", { name: "4W", exact: true }).click();
  });

  await open("empty", "light", 1280);
  await check("with no readings it says so, and never shows a zero", async () => {
    assert.equal(await page.locator("[data-fixture-empty]").count(), 1);
    assert.equal(await page.locator('[data-efficiency-chart="empty"]').count(), 1);
    assert.equal(await page.locator('[data-resets-table="empty"]').count(), 1);
    assert.equal(await page.locator("[data-quota-alert-banner]").count(), 0);
    assert.match(await page.locator('[data-dashboard-tile="efficiency"]').innerText(), /Not enough history yet/);
    assert.doesNotMatch(await page.locator("body").innerText(), /\b0%/);
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
