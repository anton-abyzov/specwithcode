// Run after building apps/web/tests/provider-usability/vite.config.ts.
// Serves fixture assets only; no account, provider, network or live store access.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, sep, join } from "node:path";
import { createRequire } from "node:module";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const require = createRequire(resolve("apps/server/package.json"));
const { chromium } = require("playwright-core");
const root = resolve(".artifacts/provider-usability/site");
const output = resolve(process.argv[2] ?? ".artifacts/provider-usability/evidence");
await mkdir(output, { recursive: true });
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(root + sep)) return res.writeHead(403).end();
    const body = await readFile(file);
    res
      .writeHead(200, {
        "Content-Type": file.endsWith(".js")
          ? "text/javascript"
          : file.endsWith(".css")
            ? "text/css"
            : "text/html",
      })
      .end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
let page;
let passed = false;
const errors = [];
const checks = [];
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.STUDIO_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE }
      : {}),
  });
  page = await browser.newPage({ reducedMotion: "reduce" });
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.route("**/*", (route) =>
    route.request().url().startsWith(origin) ? route.continue() : route.abort(),
  );
  const navigation = async (instanceId) => {
    await page.getByTestId("navigation").filter({ hasText: "settings/providers" }).waitFor();
    const call = JSON.parse(await page.getByTestId("navigation").textContent());
    assert.equal(call.to, "/settings/providers");
    assert.equal(call.search.environmentId, "remote-worker");
    if (instanceId) assert.equal(call.search.instanceId, instanceId);
  };
  const events = async () => JSON.parse(await page.getByTestId("events").textContent());
  const expectedRefresh = {
    command: "refreshProviders",
    input: {
      environmentId: "remote-worker",
      input: { instanceId: "codex-work", refreshModels: true },
    },
  };
  const savedSelection = { instanceId: "codex-work", model: "default" };
  const contained = async (locator, width) => {
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    const box = await locator.boundingBox();
    assert.ok(
      box && box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= 900,
    );
  };
  const beginRefresh = async () => {
    await page.getByRole("button", { name: "Check again", exact: true }).click();
    const pending = page.getByRole("button", { name: "Checking…", exact: true });
    await pending.waitFor();
    assert.equal(await pending.isDisabled(), true);
    assert.equal(await pending.getAttribute("aria-busy"), "true");
    // A second native DOM click while disabled must not issue another command.
    await pending.evaluate((button) => button.click());
  };
  for (const width of [320, 390, 768, 1440]) {
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${origin}/?theme=${theme}`);
      await page.getByRole("button", { name: /Coordinator model:/ }).click();
      const manage = page.getByRole("button", { name: "Add or manage providers", exact: true });
      await manage.waitFor();
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      const box = await manage.boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= width && box.y + box.height <= 900);
      await page.evaluate(async () => {
        await Promise.all(
          document
            .getAnimations()
            .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
            .map((animation) => animation.finished.catch(() => {})),
        );
      });
      await page.screenshot({ path: join(output, `picker-${width}-${theme}.png`), fullPage: true });
      await manage.focus();
      await page.keyboard.press("Enter");
      await navigation();
      checks.push(
        `${width}px ${theme}: visible footer, no overflow, keyboard opens correct machine`,
      );

      await page.goto(`${origin}/?state=recovery&theme=${theme}`);
      await contained(page.getByRole("button", { name: "Check again", exact: true }), width);
      assert.deepEqual(await events(), { commands: [], selections: [] });
      await beginRefresh();
      assert.deepEqual(await events(), { commands: [expectedRefresh], selections: [] });
      await page.screenshot({
        path: join(output, `recovery-busy-${width}-${theme}.png`),
        fullPage: true,
      });
      await page.getByRole("button", { name: "Complete fixture check", exact: true }).click();
      await page
        .getByRole("button", { name: "Checking…", exact: true })
        .waitFor({ state: "detached" });
      assert.equal(await page.getByRole("button", { name: "Check again", exact: true }).count(), 0);
      assert.deepEqual(
        JSON.parse(await page.getByTestId("selection").textContent()),
        savedSelection,
      );
      assert.deepEqual(await events(), { commands: [expectedRefresh], selections: [] });
      checks.push(
        `${width}px ${theme}: refreshes exact host/profile once, busy blocks duplicate, no selection or automatic send`,
      );

      await page.goto(`${origin}/?state=recovery-failure&theme=${theme}`);
      await beginRefresh();
      await page.getByRole("button", { name: "Complete fixture check", exact: true }).click();
      const alert = page.getByRole("alert").filter({ hasText: "Check failed" });
      await alert.waitFor();
      await contained(alert, width);
      await contained(page.getByRole("button", { name: "Check again", exact: true }), width);
      await page.screenshot({
        path: join(output, `recovery-error-${width}-${theme}.png`),
        fullPage: true,
      });
      await beginRefresh();
      assert.equal(await alert.count(), 0);
      await page.getByRole("button", { name: "Complete fixture check", exact: true }).click();
      await page
        .getByRole("button", { name: "Checking…", exact: true })
        .waitFor({ state: "detached" });
      assert.deepEqual(await events(), {
        commands: [expectedRefresh, expectedRefresh],
        selections: [],
      });
      checks.push(
        `${width}px ${theme}: readable failure feedback and explicit retry recover without sending`,
      );

      await page.goto(`${origin}/?state=recovery&theme=${theme}`);
      await page.getByRole("button", { name: /Coordinator model:/ }).click();
      await page.getByRole("button", { name: /Gemini CLI/ }).click();
      await page.getByRole("option", { name: /Default/ }).click();
      await page.getByTestId("selection").filter({ hasText: "gemini_work" }).waitFor();
      const alternative = { instanceId: "gemini_work", model: "default" };
      assert.deepEqual(await events(), { commands: [], selections: [alternative] });
      assert.equal(await page.getByRole("button", { name: "Check again", exact: true }).count(), 0);
      checks.push(
        `${width}px ${theme}: unavailable saved profile can be replaced without refresh or automatic send`,
      );
    }
  }
  for (const state of ["empty", "unavailable"]) {
    await page.goto(`${origin}/?state=${state}`);
    const setup = page.getByRole("button", {
      name: state === "empty" ? /Choose model for the coordinator/ : "Add or manage providers",
    });
    await setup.click();
    await navigation();
    checks.push(`${state}: setup remains reachable`);
  }
  await page.goto(`${origin}/`);
  await page.getByRole("button", { name: /Coordinator model:/ }).click();
  await page.getByRole("button", { name: /GitHub Copilot/ }).click();
  await page.getByRole("button", { name: "Open provider setup", exact: true }).click();
  await navigation("copilot_work");
  assert.equal(JSON.parse(await page.getByTestId("selection").textContent()).instanceId, "codex");
  checks.push("Signed-out Copilot opens exact setup without changing selection");
  await page.goto(`${origin}/?state=saving`);
  assert.equal(await page.getByRole("button", { name: /Coordinator model:/ }).isDisabled(), true);
  checks.push("Saving locks model writes and setup navigation");
  await page.goto(`${origin}/?state=recovery-readonly`);
  await page.getByRole("button", { name: /Coordinator model:/ }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Check again", exact: true }).count(), 0);
  assert.deepEqual(await events(), { commands: [], selections: [] });
  checks.push("Missing refresh permission hides retry without issuing commands");
  await page.goto(`${origin}/?state=recovery-saving`);
  assert.equal(
    await page.getByRole("button", { name: "Check again", exact: true }).isDisabled(),
    true,
  );
  assert.deepEqual(await events(), { commands: [], selections: [] });
  checks.push("Pending model save disables provider refresh");
  assert.deepEqual(errors, []);
  passed = true;
  console.log(JSON.stringify({ passed: checks.length, output }));
} catch (error) {
  errors.push(String(error));
  if (page)
    await page.screenshot({ path: join(output, "failure.png"), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await writeFile(
    join(output, "receipt.json"),
    JSON.stringify(
      {
        headless: true,
        passed,
        checks,
        errors,
        scope:
          "Actual picker components with fixture provider state; no authenticated inference or installed-runtime proof",
      },
      null,
      2,
    ) + "\n",
  );
  await browser?.close();
  await new Promise((done) => server.close(done));
}
