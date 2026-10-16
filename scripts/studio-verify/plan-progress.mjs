// Run after building apps/web/tests/plan-progress/vite.config.ts.
// Serves fixture assets only; no account, provider, network or live store access.
// Headless Chromium; screenshots go to the report directory given as the first argument.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { resolve, sep, join } from "node:path";
import { createRequire } from "node:module";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const require = createRequire(resolve("apps/server/package.json"));
const { chromium } = require("playwright-core");
const root = resolve(".artifacts/plan-progress/site");
const output = resolve(process.argv[2] ?? ".artifacts/plan-progress/evidence");
await mkdir(output, { recursive: true });
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html" };
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(root + sep)) return res.writeHead(403).end();
    const body = await readFile(file);
    const type = types[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream";
    res.writeHead(200, { "Content-Type": type }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const errors = [];
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.STUDIO_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE }
      : {}),
  });
  for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({
      reducedMotion: "reduce",
      viewport: { width: 900, height: 1200 },
    });
    page.setDefaultTimeout(15_000);
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.route("**/*", (route) =>
      route.request().url().startsWith(origin) ? route.continue() : route.abort(),
    );
    await page.goto(`${origin}/?theme=${theme}`);
    const card = page.locator('[data-thread-plan-card="increment"]');
    await card.waitFor();
    assert.equal((await card.locator("[data-plan-count]").textContent())?.trim(), "2/5");
    assert.match(
      (await card.locator("[data-plan-current]").textContent()) ?? "",
      /Plan card in the thread/,
    );
    const topLevel = await card
      .locator('ul[aria-label="Steps"] > li')
      .evaluateAll((items) => items.map((item) => item.dataset.planStepState));
    assert.deepEqual(topLevel, ["done", "done", "current", "open", "blocked"]);
    assert.equal(await card.locator("[data-plan-step-mine]").count(), 1);
    assert.match(
      (await card.locator("[data-plan-step-mine]").textContent()) ?? "",
      /T-03.*this thread/,
    );
    assert.equal(await card.locator("[data-plan-substeps] > li").count(), 5);
    assert.match(
      (await card.locator("[data-plan-binding]").textContent()) ?? "",
      /bound by this thread's ledger writes/,
    );
    await card.getByRole("button", { name: /Acceptance criteria 1\/4/ }).click();
    await card.getByRole("button", { name: "Open spec" }).waitFor();
    await card.getByRole("button", { name: "Change increment" }).waitFor();
    await card.getByRole("button", { name: "Unlink" }).waitFor();

    const pills = page.locator("[data-thread-pull-request-pills]");
    assert.equal(await pills.getByRole("listitem").count(), 2);
    assert.equal(
      await pills.getByRole("listitem").first().getAttribute("href"),
      "https://github.com/anton-abyzov/specweave/pull/1962",
    );
    await pills.getByRole("button", { name: "Show 3 more" }).waitFor();
    await page.getByRole("button", { name: "Open folder" }).waitFor();
    assert.match(await page.locator("main").textContent(), /~\/Projects\/github\/specweave-umb/);

    const todo = page.locator('[data-thread-plan-card="todo"]');
    assert.equal((await todo.locator("[data-plan-count]").textContent())?.trim(), "3/5");
    assert.equal(await todo.getAttribute("data-thread-plan-card"), "todo");
    const chips = page.locator("[data-plan-progress]");
    assert.deepEqual(
      await chips.evaluateAll((nodes) => nodes.map((node) => node.dataset.planProgress)),
      ["2/5", "3/5"],
    );
    await page.screenshot({ path: join(output, `plan-progress-${theme}.png`), fullPage: true });

    await pills.getByRole("button", { name: "Show 3 more" }).click();
    assert.equal(await pills.getByRole("listitem").count(), 5);
    await todo.getByRole("button", { expanded: false }).click();
    await todo.getByRole("button", { name: "Link increment" }).waitFor();
    assert.equal(await todo.getByRole("button", { name: "Unlink" }).count(), 0);
    await page.screenshot({
      path: join(output, `plan-progress-${theme}-expanded.png`),
      fullPage: true,
    });
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log(`plan-progress: passed; screenshots in ${output}`);
} finally {
  await browser?.close();
  server.close();
}
