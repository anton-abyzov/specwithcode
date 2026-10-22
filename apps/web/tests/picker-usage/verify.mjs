// Build first: node node_modules/vite-plus/bin/vp build --config apps/web/tests/picker-usage/vite.config.ts
// Then: node apps/web/tests/picker-usage/verify.mjs /absolute/report-dir
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

const root = resolve(".artifacts/picker-usage/site");
const output = resolve(process.argv[2] ?? ".artifacts/picker-usage/evidence");
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
const NOW = new Date("2026-10-21T15:00:00Z");

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
  const prepare = (target) => {
    target.setDefaultTimeout(10_000);
    target.on("pageerror", (error) => errors.push(String(error)));
    return target.route("**/*", (route) =>
      route.request().url().startsWith(origin) ? route.continue() : route.abort(),
    );
  };
  let page = await context.newPage();
  await prepare(page);

  const settle = () =>
    page.evaluate(async () => {
      await Promise.all(
        document.getAnimations().map((animation) => animation.finished.catch(() => {})),
      );
    });
  const open = async (scenario, theme, width) => {
    await page.setViewportSize({ width, height: 860 });
    await page.goto(`${origin}/?case=${scenario}&theme=${theme}`);
    await page.locator("[data-chat-provider-model-picker]").click();
    await page.locator("[data-model-picker-content]").waitFor();
    await settle();
  };
  const contained = async (width) => {
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      "page scrolls sideways",
    );
    const box = await page.locator("[data-model-picker-content]").boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= width + 0.5, "picker leaves the viewport");
  };
  const rail = (name) => page.locator(`[data-model-picker-sidebar] button[aria-label^="${name}"]`);
  const blocked = () => page.locator("[data-model-usage-blocked=true]").count();
  const pickerText = () => page.locator("[data-model-picker-content]").innerText();
  const selection = () => page.getByTestId("selection").first().textContent();

  const EXPECT_BLOCKED = { account: 3, model: 1 };
  const CASES = [
    "room",
    "account",
    "model",
    "stale",
    "reset",
    "loading",
    "unknown",
    "offline",
    "running",
  ];
  for (const width of [390, 1280]) {
    for (const theme of ["light", "dark"]) {
      for (const scenario of CASES) {
        await open(scenario, theme, width);
        await contained(width);
        await page.screenshot({
          path: join(output, `${scenario}-favorites-${width}-${theme}.png`),
        });
        const favoritesBlocked = await blocked();
        await rail("Claude").first().click();
        await page.locator("[data-model-picker-usage-band]").waitFor();
        await settle();
        await contained(width);
        await page.screenshot({ path: join(output, `${scenario}-claude-${width}-${theme}.png`) });
        const claudeBlocked = await blocked();
        const text = await pickerText();
        assert.equal(
          claudeBlocked,
          EXPECT_BLOCKED[scenario] ?? 0,
          `${scenario}: Claude rows blocked`,
        );
        if (scenario === "account") {
          assert.match(text, /Weekly limit reached · resets in 2d 5h/);
          assert.match(text, /Every Claude model on this account shares it/);
          assert.equal(
            await page.locator("[data-model-picker-usage-mark=full]").count(),
            1,
            "rail marks Claude as out",
          );
        }
        if (scenario === "model") {
          assert.match(text, /Fable limit reached · resets in 1d 6h/);
          assert.equal(await page.locator("[data-model-picker-usage-mark]").count(), 0);
        }
        if (["loading", "unknown", "offline", "reset"].includes(scenario)) {
          // Missing or untrusted telemetry is never drawn as a number.
          assert.doesNotMatch(text.replace(/Weekly\s+\S+\s+46% left/, ""), /\b(0|100)% left/);
        }
        if (scenario === "loading") assert.match(text, /usage has not been read yet/);
        if (scenario === "unknown") assert.match(text, /usage could not be read/);
        if (scenario === "offline") assert.match(text, /Studio Mac is not connected/);
        if (scenario === "stale") assert.match(text, /too old to rely on/);
        if (scenario === "reset") assert.match(text, /Reset since last read/);
        if (scenario === "running") {
          assert.match(
            text,
            /Running on Claude Opus 5\.5 \(Claude\)\. Your pick applies from the next message\./,
          );
        }
        // Copilot's Claude is another account: never blocked by native Claude's limit.
        await rail("GitHub Copilot").first().click();
        const copilotState = scenario === "offline" ? "offline" : "unreported";
        await page.locator(`[data-model-picker-usage-band=${copilotState}]`).waitFor();
        assert.equal(await blocked(), 0, `${scenario}: Copilot rows stay selectable`);
        if (copilotState === "unreported") {
          assert.match(await pickerText(), /GitHub Copilot does not report usage limits/);
        }
        if (width === 1280) {
          await page.screenshot({
            path: join(output, `${scenario}-copilot-${width}-${theme}.png`),
          });
        }
        checks.push(
          `${scenario} ${width}px ${theme}: ${claudeBlocked} Claude rows blocked (${favoritesBlocked} in favorites), Copilot open, no overflow`,
        );
      }

      for (const [scenario, usageLabel, detail] of [
        ["grok-no-windows", "No limits reported", /Grok reported no limit windows/],
        ["grok-probe-failed", "Usage unavailable", /Grok usage could not be read/],
      ]) {
        await open(scenario, theme, width);
        const trigger = page.locator("[data-chat-provider-model-picker]");
        assert.match(
          (await trigger.locator('[data-model-usage-meter="unknown"]').textContent()) ?? "",
          new RegExp(usageLabel),
        );
        if (width >= 520) assert.match(await trigger.innerText(), new RegExp(usageLabel));
        assert.doesNotMatch((await trigger.textContent()) ?? "", /\bUnknown\b/);
        assert.match((await trigger.getAttribute("aria-label")) ?? "", detail);
        assert.equal(await trigger.locator('[data-provider-logo="grok"]').count(), 1);
        await rail("Grok").click();
        assert.equal(await rail("Grok").locator('[data-provider-logo="grok"]').count(), 1);
        assert.equal(await blocked(), 0, "missing Grok usage never blocks selection");
        await contained(width);
        await page.screenshot({ path: join(output, `${scenario}-${width}-${theme}.png`) });
        await rail("Codex").click();
        await page.getByRole("option", { name: /^GPT-6\.1-Sol/ }).click();
        assert.equal(await selection(), "codex:gpt-6.1-sol");
        await trigger.click();
        await rail("Grok").click();
        await page.getByRole("option", { name: /^Grok 4\.7/ }).click();
        await page.locator("[data-model-picker-content]").waitFor({ state: "detached" });
        assert.equal(await selection(), "grok:grok-4.7");
        checks.push(
          `${scenario} ${width}px ${theme}: explicit usage reason, Grok logos, selectable`,
        );
      }

      // The thread's provider was never prepared here: the picker opens on it and
      // still lists the ready models (screenshot of October 21, 9:50 AM).
      await open("unprepared", theme, width);
      await contained(width);
      await page.locator("[data-model-picker-alternatives]").waitFor();
      const unpreparedText = await pickerText();
      assert.match(unpreparedText, /Copilot managed can't run on this machine yet/);
      assert.match(unpreparedText, /GPT-6\.1-Sol/);
      assert.match(unpreparedText, /Claude Opus 5\.5[\s\S]*Claude/);
      await page.screenshot({ path: join(output, `unprepared-${width}-${theme}.png`) });
      await page.getByText("GPT-6.1-Sol", { exact: true }).first().click();
      await page.getByTestId("selection").filter({ hasText: "codex:gpt-6.1-sol" }).waitFor();
      checks.push(
        `unprepared ${width}px ${theme}: ready models offered, manual switch to Codex works`,
      );

      // Blocked rows keep their shortcut and refuse it; other shortcuts still work.
      // Model shortcuts exist in the desktop app only, so this page poses as it.
      await page.addInitScript(() => {
        window.desktopBridge = {};
      });
      await open("account", theme, width);
      const labels = await page.locator("[data-model-picker-content] kbd").allTextContents();
      assert.deepEqual(labels.slice(0, 5), ["⌘1", "⌘2", "⌘3", "⌘4", "⌘5"]);
      const reasonOpacity = await page
        .locator("[data-model-usage-blocked=true]")
        .first()
        .evaluate((row) => getComputedStyle(row).opacity);
      assert.equal(reasonOpacity, "1", "a blocked row's reason is not faded");
      await page.keyboard.press("Meta+4");
      assert.equal(await selection(), "claudeAgent:claude-opus-5-5");
      assert.equal(
        await page.locator("[data-model-picker-content]").count(),
        1,
        "picker stays open",
      );
      await page.locator("[data-model-usage-blocked=true]").first().click({ force: true });
      assert.equal(await selection(), "claudeAgent:claude-opus-5-5");
      await page.keyboard.press("Meta+1");
      await page.getByTestId("selection").filter({ hasText: "codex:gpt-6.1-sol" }).waitFor();
      checks.push(
        `${width}px ${theme}: ⌘4 and a click on a spent model change nothing; ⌘1 still picks`,
      );
      await page.close();
      page = await context.newPage();
      await prepare(page);

      // The trigger names the state for screen readers, not only with a ring.
      await page.setViewportSize({ width, height: 860 });
      await page.goto(`${origin}/?case=account&theme=${theme}`);
      const label = await page
        .locator("[data-chat-provider-model-picker]")
        .getAttribute("aria-label");
      assert.match(label ?? "", /Claude Opus 5\.5\. The Claude account's weekly limit is used up/);
      await page.goto(`${origin}/?case=triggers&theme=${theme}`);
      await page.locator("[data-model-usage-meter=offline]").waitFor();
      await page.screenshot({
        path: join(output, `triggers-${width}-${theme}.png`),
        fullPage: true,
      });
      checks.push(`${width}px ${theme}: trigger meters for every state`);
    }
  }
  assert.deepEqual(errors, []);
  passed = true;
} finally {
  await browser.close();
  server.close();
  await writeFile(
    join(output, "report.json"),
    `${JSON.stringify({ passed, checks, errors, at: new Date().toISOString() }, null, 2)}\n`,
  );
}
console.log(`picker-usage: ${checks.length} checks passed; evidence in ${output}`);
