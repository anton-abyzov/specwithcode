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
    const card = page.getByTestId("increment-card").locator('[data-thread-plan-card="increment"]');
    const opened = () => page.evaluate(() => window.planOpened.at(-1));
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
      /bound by SpecWeave for this thread/,
    );
    await card.getByRole("button", { name: /^Acceptance criteria/ }).click();
    // "Open spec" opens the app's viewer; the editor is the secondary link.
    const specPath =
      "/Users/dev/Projects/specweave/.specweave/increments/0930-studio-plan-progress/spec.md";
    await card.getByRole("button", { name: "Open spec", exact: true }).click();
    assert.deepEqual(await opened(), ["viewer", specPath]);
    await card.getByRole("button", { name: "Open spec in editor" }).click();
    assert.deepEqual(await opened(), ["editor", specPath]);
    await card.getByRole("button", { name: "Open increment" }).click();
    assert.equal((await opened())[0], "editor");
    await card.getByRole("button", { name: "Change increment" }).waitFor();
    await card.getByRole("button", { name: "Unlink" }).waitFor();

    await page.getByRole("button", { name: "Open folder" }).waitFor();
    assert.match(await page.locator("main").textContent(), /~\/Projects\/github\/specweave-umb/);

    const todo = page.locator('[data-thread-plan-card="todo"]');
    assert.equal((await todo.locator("[data-plan-count]").textContent())?.trim(), "3/5");
    assert.equal(await todo.getAttribute("data-thread-plan-card"), "todo");
    // Without an editor the spec still opens in the viewer; a bound increment
    // with no tasks says so instead of hiding.
    const noEditor = page.getByTestId("no-editor-card");
    assert.equal(
      (await noEditor.locator("[data-plan-current]").textContent())?.trim(),
      "No tasks yet",
    );
    assert.equal(await noEditor.locator("[data-plan-count]").count(), 0);
    assert.equal(await noEditor.getByRole("button", { name: "Open increment" }).count(), 0);
    assert.equal(await noEditor.getByRole("button", { name: "Open spec in editor" }).count(), 0);
    await noEditor.getByRole("button", { name: "Open spec", exact: true }).click();
    assert.deepEqual(await opened(), [
      "viewer",
      "/Users/dev/Projects/specweave/.specweave/increments/0996-connect-launches/spec.md",
    ]);

    const unplanned = page.locator("[data-plan-unplanned]");
    assert.equal(await unplanned.count(), 1);
    assert.equal(
      (await unplanned.locator("[data-plan-current]").textContent())?.trim(),
      "Changed code without an increment",
    );
    await unplanned.getByRole("button", { name: "Link increment" }).waitFor();
    await unplanned.getByRole("button", { name: "No increment needed" }).waitFor();
    assert.equal(await unplanned.getByRole("button", { name: "Unlink" }).count(), 0);

    const chips = page.locator("[data-plan-progress]");
    assert.deepEqual(
      await chips.evaluateAll((nodes) => nodes.map((node) => node.dataset.planProgress)),
      ["2/5", "0/0", "3/5"],
    );
    assert.deepEqual(
      await chips.evaluateAll((nodes) =>
        nodes.map((node) => node.querySelector("[aria-hidden]:not(svg)")?.textContent),
      ),
      ["0930 · 2/5", "0996", "3/5"],
    );
    const filter = page.locator("[data-unplanned-filter]");
    assert.equal(
      (await filter.textContent())?.trim(),
      "2 threads changed code without an increment",
    );
    assert.equal(await page.locator("[data-thread-unplanned]").count(), 1);
    await page.screenshot({ path: join(output, `plan-progress-${theme}.png`), fullPage: true });

    await filter.click();
    assert.equal(await filter.getAttribute("aria-pressed"), "true");
    assert.match((await filter.textContent()) ?? "", /Show all/);
    await todo.getByRole("button", { expanded: false }).click();
    await todo.getByRole("button", { name: "Link increment" }).waitFor();
    assert.equal(await todo.getByRole("button", { name: "Unlink" }).count(), 0);
    await page.screenshot({
      path: join(output, `plan-progress-${theme}-expanded.png`),
      fullPage: true,
    });

    // Increments are recommended, not required: the notice reads as
    // information, can be hidden for good, and comes back from the menu.
    const notice = page.locator("[data-unplanned-notice]");
    await filter.click();
    await page.mouse.move(0, 0);
    assert.equal(await filter.getAttribute("aria-pressed"), "false");
    const color = await filter.evaluate((node) => getComputedStyle(node).color);
    const muted = await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.color = "var(--muted-foreground)";
      document.body.append(probe);
      const value = getComputedStyle(probe).color;
      probe.remove();
      return value;
    });
    assert.equal(color, muted, "the notice uses the muted text color, not a warning color");
    assert.equal(
      (await page.locator("[data-thread-unplanned]").textContent())?.trim(),
      "No increment",
    );
    await page.locator("[data-unplanned-hide]").click();
    assert.equal(await notice.count(), 0);
    assert.equal(await page.locator("[data-thread-unplanned]").count(), 0);
    await page.reload();
    await page.locator('[data-thread-plan-card="increment"]').first().waitFor();
    assert.equal(await notice.count(), 0, "hiding persists across a reload");
    assert.equal(await page.locator("[data-thread-unplanned]").count(), 0);
    await page.screenshot({
      path: join(output, `plan-progress-${theme}-hidden.png`),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Sort threads" }).click();
    const toggle = page.locator("[data-unplanned-notice-toggle]");
    assert.equal(await toggle.getAttribute("aria-checked"), "false");
    await page.screenshot({ path: join(output, `plan-progress-${theme}-menu.png`) });
    await toggle.click();
    await notice.waitFor();
    assert.equal(await page.locator("[data-thread-unplanned]").count(), 1);
    await page.keyboard.press("Escape");
    await page.reload();
    await notice.waitFor({ timeout: 5000 });
    assert.equal(
      await page.locator("[data-thread-unplanned]").count(),
      1,
      "showing again persists too",
    );
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log(`plan-progress: passed; screenshots in ${output}`);
} finally {
  await browser?.close();
  server.close();
}
