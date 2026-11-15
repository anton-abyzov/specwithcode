// Build first: node node_modules/vite-plus/bin/vp build --config apps/web/tests/picker-usage/vite.config.ts
// Then: node apps/web/tests/picker-usage/verify-1054.mjs /absolute/report-dir
// 1054: the usage meter in the model chip, the limits view by account, the account line.
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
const output = resolve(process.argv[2] ?? ".artifacts/picker-usage/evidence-1054");
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
  const warned = () => page.locator("[data-model-usage-warning=true]").count();
  const pickerText = () => page.locator("[data-model-picker-content]").innerText();
  const selection = () => page.getByTestId("selection").first().textContent();

  const check = (name, detail = "") => checks.push({ name, detail });
  const goto = async (scenario, theme, width) => {
    await page.setViewportSize({ width, height: scenario === "chips" ? 1100 : 860 });
    await page.goto(`${origin}/?case=${scenario}&theme=${theme}`);
    await page.waitForSelector("main");
    await page.evaluate(() => document.fonts.ready);
    await settle();
  };
  const noSideScroll = async (label) =>
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      `${label}: page scrolls sideways`,
    );

  // AC-01..AC-05, AC-08: one meter per chip, its words, its fit, its states.
  const chip = (name) =>
    page.locator(`[data-chip-case="${name}"] [data-chat-provider-model-picker]`);
  // The control that names the model: the model half of a chip whose usage ring is its
  // own button, else the whole chip.
  const model = (name) =>
    page.locator(
      `[data-chip-case="${name}"] :is([data-model-chip-main], [data-chat-provider-model-picker]:not([data-model-chip-split]))`,
    );
  const ringOf = (name) => chip(name).locator("[data-model-usage-meter] svg");
  const described = async (name) => {
    const id = await model(name).getAttribute("aria-describedby");
    return id ? page.locator(`[id="${id}"]`).textContent() : null;
  };
  const visibleText = (name, part) =>
    chip(name)
      .locator(`[data-model-chip-part="${part}"]`)
      .evaluateAll((nodes) =>
        nodes
          .filter((node) => getComputedStyle(node).visibility !== "hidden")
          .map((node) => node.textContent),
      );
  const fits = {};
  for (const width of [320, 390, 520, 1280]) {
    for (const theme of ["light", "dark"]) {
      await goto("chips", theme, width);
      await noSideScroll(`chips ${width} ${theme}`);
      await page.screenshot({ path: join(output, `chips-${width}-${theme}.png`), fullPage: true });
      for (const name of ["thread", "fallback", "spent", "spent-next", "switch", "pertoken"]) {
        const fit = await chip(name).getAttribute("data-model-fit");
        fits[`${name}@${width}`] = fit;
        // The model name keeps at least 2.5em while it shows.
        if (fit !== "icon") {
          const ok = await chip(name)
            .locator("[data-picker-model]")
            .evaluate((node) => {
              const em = Number.parseFloat(getComputedStyle(node).fontSize);
              return node.getBoundingClientRect().width >= 2.5 * em - 0.5;
            });
          assert.ok(ok, `${name}@${width}: model name narrower than 2.5em`);
        }
        const value = await visibleText(name, "usage-value");
        if ((fit === "full" || fit === "model") && name === "thread")
          assert.deepEqual(value, ["5%"], `thread@${width}: % hidden at ${fit}`);
        if (fit === "name") {
          const ring = await visibleText(name, "usage-ring");
          assert.equal(ring.length, 0, `${name}@${width}: ring shows at name`);
        }
      }
      if (width === 1280) {
        for (const name of ["thread", "spent", "spent-next"])
          assert.equal(fits[`${name}@1280`], "full", `${name} not full at 1280`);
      }
    }
  }
  check("fit matrix 320/390/520/1280 light+dark", JSON.stringify(fits));

  await goto("chips", "light", 1280);
  // AC-01: one meter on the chip, for the model it shows; a fallback gets no second ring.
  for (const name of ["thread", "home", "fallback", "returned", "spent"]) {
    assert.equal(
      await chip(name).locator("[data-model-usage-meter]").count(),
      1,
      `${name}: meters`,
    );
  }
  assert.equal(
    await chip("fallback")
      .locator("[data-model-usage-meter]")
      .getAttribute("data-model-usage-meter"),
    "room",
    "fallback meter is the running Codex model's",
  );
  check("AC-01 one meter per chip, the running model's on a fallback");
  // AC-02: short name, long description, no email.
  const threadName = await model("thread").getAttribute("aria-label");
  assert.match(
    threadName,
    /^Model: Claude Code · Opus 5\.5, 5% of 5-hour limit left\. Change model$/,
  );
  const threadDescription = await described("thread");
  assert.match(threadDescription, /Claude account on Studio Mac/);
  assert.match(threadDescription, /including use from other machines and apps/);
  // The description ends with who is signed in, as the chip's tooltip does.
  assert.match(threadDescription, /Signed in as pat@example\.com$/);
  check("AC-02 name and description, signed-in account", `${threadName} | ${threadDescription}`);
  // AC-08: 5% left is amber, never red.
  const threadRing = await ringOf("thread").getAttribute("class");
  assert.match(threadRing, /stroke-warning/);
  assert.doesNotMatch(threadRing, /stroke-destructive/);
  check("AC-08 5% left is amber");
  // AC-03: spent says when, or where the next turn goes; extra usage stays amber.
  assert.deepEqual(await visibleText("spent", "usage-value"), ["Limit"]);
  assert.deepEqual(await visibleText("spent", "usage-detail"), ["· resets in 2d 5h"]);
  assert.deepEqual(await visibleText("spent-next", "usage-detail"), ["· next on GPT-6.1-Sol"]);
  assert.match(
    await model("spent-next").getAttribute("aria-label"),
    /the next turn runs on GPT-6\.1-Sol/,
  );
  assert.deepEqual(await visibleText("extra", "usage-value"), ["Extra"]);
  const extraRing = await ringOf("extra").getAttribute("class");
  assert.match(extraRing, /stroke-warning/);
  check("AC-03 Limit · resets in, next on, extra usage amber");
  // AC-05: states.
  // A quiet state is the ring alone on a chip; its words are in the tooltip and the name.
  assert.deepEqual(await visibleText("stale", "usage-value"), []);
  assert.equal(await ringOf("stale").locator("circle[stroke-dasharray]").count(), 1);
  assert.deepEqual(await visibleText("loading", "usage-value"), []);
  assert.deepEqual(await visibleText("unknown", "usage-value"), []);
  assert.deepEqual(await visibleText("offline", "usage-value"), []);
  assert.deepEqual(await visibleText("pertoken", "usage-value"), ["per token"]);
  assert.equal(await chip("pertoken").locator('[data-model-chip-part="usage-ring"]').count(), 0);
  assert.equal(await chip("switch").locator("[data-model-usage-meter]").count(), 0);
  assert.doesNotMatch(await model("switch").getAttribute("aria-label"), /%/);
  check("AC-05 stale, loading, unknown, offline, per token, account switch");
  // The usage ring is its own button: it opens this account's usage, the model opens the picker.
  const ring = chip("home").locator("[data-model-usage-button]");
  assert.match(await ring.getAttribute("aria-label"), /^Usage: .+\. Show usage$/);
  await ring.click();
  await page.locator("[data-model-usage-popup] [data-model-picker-usage-band]").waitFor();
  assert.equal(await page.locator("[data-model-picker-content]").count(), 0);
  await page.keyboard.press("Escape");
  await page.locator("[data-model-usage-popup]").waitFor({ state: "detached" });
  await model("home").click();
  await page.locator("[data-model-picker-content]").waitFor();
  assert.equal(await page.locator("[data-model-usage-popup]").count(), 0);
  await page.keyboard.press("Escape");
  await page.locator("[data-model-picker-content]").waitFor({ state: "detached" });
  check("usage ring is its own button");

  // AC-06: the limits view by account.
  for (const width of [390, 1280]) {
    for (const theme of ["light", "dark"]) {
      await goto("accounts", theme, width);
      await noSideScroll(`accounts ${width}`);
      await page.screenshot({
        path: join(output, `accounts-${width}-${theme}.png`),
        fullPage: true,
      });
    }
  }
  const sections = await page
    .locator("[data-account-section]")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-account-section")));
  assert.deepEqual(sections, ["current", "fallback", "others"]);
  const accountsText = await page.locator("[data-account-limits]").innerText();
  assert.match(accountsText, /Coordinator now/);
  assert.match(accountsText, /Studio Mac · read 2m ago · also on MacBook Pro/);
  assert.match(accountsText, /1\. Codex · GPT-6\.1-Sol/);
  assert.match(accountsText, /2\. Copilot · Claude Opus 5\.5: not signed in/);
  assert.equal(
    (accountsText.match(/you@work\.example/g) ?? []).length,
    2,
    "Claude and Codex once each",
  );
  assert.match(accountsText, /team@company\.example/);
  check("AC-06 current, fallback order, other accounts once", sections.join(" > "));

  // AC-10..AC-12: rows, account line, rail copy, running footer.
  for (const width of [390, 1280]) {
    for (const theme of ["light", "dark"]) {
      await open("room", theme, width);
      await page.screenshot({ path: join(output, `account-line-favorites-${width}-${theme}.png`) });
      const line = await page.locator("[data-model-picker-account-line]").innerText();
      assert.match(line, /^Account limits: Claude 18% of weekly · 2d 5h \(this thread\)/);
      assert.match(line, /Codex 62% of 5-hour · 3h 2m/);
      await page.locator("[data-model-picker-content] input").first().fill("opus");
      await settle();
      assert.equal(await page.locator("[data-model-picker-account-line]").count(), 1);
      await page.screenshot({ path: join(output, `account-line-search-${width}-${theme}.png`) });
      await page.locator("[data-model-picker-content] input").first().fill("");
      await rail("Claude").first().click();
      await page.locator("[data-model-picker-usage-band]").waitFor();
      assert.equal(await page.locator("[data-model-picker-account-line]").count(), 0);
      const rows = await page.locator("[data-model-picker-content] [role=option]").allInnerTexts();
      assert.ok(!rows.some((text) => /\b18% left\b/.test(text)), "rows repeat account-wide room");
      assert.ok(
        rows.some((text) => /Fable 36% left/.test(text)),
        `family window left the row: ${JSON.stringify(rows)}`,
      );
      await page.screenshot({ path: join(output, `rows-claude-${width}-${theme}.png`) });
    }
  }
  check("AC-10 account line in Favorites and search, none under a band, rows keep family windows");
  await open("unprepared", "light", 1280);
  assert.equal(await page.locator("[data-model-picker-alternatives]").count(), 1);
  assert.equal(await page.locator("[data-model-picker-account-line]").count(), 1);
  await page.screenshot({ path: join(output, "account-line-alternatives-1280-light.png") });
  check("AC-10 account line over the alternatives view");
  await open("account", "light", 1280);
  const railName = await rail("Claude").first().getAttribute("aria-label");
  assert.equal(railName, "Claude: weekly limit reached, resets in 2d 5h");
  await open("room", "light", 1280);
  assert.equal(
    await rail("Claude").first().getAttribute("aria-label"),
    "Claude: 18% of the weekly limit left, resets in 2d 5h",
  );
  check("AC-11 rail dots name the window", railName);
  await open("running", "light", 1280);
  assert.match(
    await page.locator('[data-model-picker-running-note="differs"]').innerText(),
    /^This turn stays on Claude Opus 5\.5 \(Claude\)\. Your pick, GPT-6\.1-Sol \(Codex\), starts with your next message\.$/,
  );
  await page.screenshot({ path: join(output, "running-differs-1280-light.png") });
  await open("running-same", "dark", 390);
  assert.equal(
    await page.locator('[data-model-picker-running-note="same"]').innerText(),
    "Picks apply from your next message.",
  );
  await page.screenshot({ path: join(output, "running-same-390-dark.png") });
  check("AC-12 running footer, same and differing");

  assert.deepEqual(errors, [], "page errors");
  passed = true;
} finally {
  await writeFile(
    join(output, "receipt.json"),
    JSON.stringify({ headless: true, passed, checks, errors }, null, 2),
  );
  await browser.close();
  server.close();
}
console.log(`${checks.length} checks passed; evidence in ${output}`);
