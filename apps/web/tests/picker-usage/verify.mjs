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
  // Every band under the list is on top where it is drawn: no model row paints over it.
  const noOverlap = async (width, theme) => {
    const covered = await page.evaluate(() => {
      const bands = [
        ...document.querySelectorAll(
          "[data-model-picker-alternatives], [data-model-picker-elsewhere], [data-model-picker-actions]",
        ),
      ];
      const out = [];
      for (const band of bands) {
        const box = band.getBoundingClientRect();
        if (box.height === 0) continue;
        for (const fx of [0.25, 0.5, 0.75]) {
          for (const fy of [0.2, 0.5, 0.8]) {
            const x = box.left + box.width * fx;
            const y = box.top + box.height * fy;
            const top = document.elementFromPoint(x, y);
            if (top && !band.contains(top) && top.closest("[role=option]"))
              out.push(
                `${band.getAttribute("data-model-picker-elsewhere") !== null ? "elsewhere" : band.hasAttribute("data-model-picker-actions") ? "actions" : "note"} at ${Math.round(x)},${Math.round(y)}`,
              );
          }
        }
      }
      return out;
    });
    assert.deepEqual(covered, [], `model rows cover picker bands at ${width}px ${theme}`);
  };
  const rail = (name) => page.locator(`[data-model-picker-sidebar] button[aria-label^="${name}"]`);
  const warned = () => page.locator("[data-model-usage-warning=true]").count();
  const pickerText = () => page.locator("[data-model-picker-content]").innerText();
  const selection = () => page.getByTestId("selection").first().textContent();
  // A pick closes the picker; the popup leaves the DOM after its short exit fade.
  const closed = () =>
    page.locator("[data-model-picker-content]").waitFor({ state: "detached", timeout: 2_000 });

  const EXPECT_WARNED = { account: 3, model: 1, warning: 3, denied: 3 };
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
    "warning",
    "denied",
  ];
  for (const width of [390, 1280]) {
    for (const theme of ["light", "dark"]) {
      for (const scenario of CASES) {
        await open(scenario, theme, width);
        await contained(width);
        await page.screenshot({
          path: join(output, `${scenario}-favorites-${width}-${theme}.png`),
        });
        const favoritesBlocked = await warned();
        // Grouped rows keep the provider in their accessible name.
        const groupedNames = await page
          .getByRole("option")
          .evaluateAll((rows) => rows.map((row) => row.textContent ?? ""));
        assert.ok(groupedNames.length > 0, "favorites lists rows");
        for (const name of groupedNames)
          assert.match(name, /Claude|Codex|Copilot|Grok|Gemini|Cursor|OpenCode/, name);
        await rail("Claude").first().click();
        await page.locator("[data-model-picker-usage-band]").waitFor();
        await settle();
        await contained(width);
        await page.screenshot({ path: join(output, `${scenario}-claude-${width}-${theme}.png`) });
        const claudeBlocked = await warned();
        const text = await pickerText();
        assert.equal(
          claudeBlocked,
          EXPECT_WARNED[scenario] ?? 0,
          `${scenario}: Claude rows warned`,
        );
        if (scenario === "account") {
          assert.match(text, /Weekly limit reached · resets in 2d 5h/);
          assert.match(text, /Every Claude model on the account shares it/);
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
        if (scenario === "reset") assert.match(text, /Limit reset since last read/);
        if (scenario === "running") {
          assert.match(
            text,
            /This turn stays on Claude Opus 5\.5 \(Claude\)\. Your pick, GPT-6\.1-Sol \(Codex\), starts with your next message\./,
          );
        }
        // Copilot's Claude is another account: never blocked by native Claude's limit.
        await rail("GitHub Copilot").first().click();
        const copilotState = scenario === "offline" ? "offline" : "unreported";
        await page.locator(`[data-model-picker-usage-band=${copilotState}]`).waitFor();
        assert.equal(
          await warned(),
          0,
          `${scenario}: Copilot rows stay selectable without inherited warnings`,
        );
        if (copilotState === "unreported") {
          assert.match(await pickerText(), /GitHub Copilot does not report usage limits/);
        }
        if (width === 1280) {
          await page.screenshot({
            path: join(output, `${scenario}-copilot-${width}-${theme}.png`),
          });
        }
        if (EXPECT_WARNED[scenario]) {
          await rail("Claude").first().click();
          const row = page
            .locator("[data-model-usage-warning=true]")
            .filter({ hasText: "Claude Fable 5.1" })
            .first();
          assert.notEqual(await row.getAttribute("aria-disabled"), "true");
          await row.click();
          assert.equal(await selection(), "claudeAgent:claude-fable-5-1");
          await closed();
        }
        checks.push(
          `${scenario} ${width}px ${theme}: ${claudeBlocked} Claude rows warned (${favoritesBlocked} in favorites), Copilot open, no overflow`,
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
        // Since 1054 the name stays short and the reason is the trigger's description.
        assert.match((await trigger.getAttribute("aria-label")) ?? "", new RegExp(usageLabel, "i"));
        const describedBy = await trigger.getAttribute("aria-describedby");
        assert.ok(describedBy, "trigger describes its usage state");
        assert.match((await page.locator(`[id="${describedBy}"]`).textContent()) ?? "", detail);
        assert.equal(await trigger.locator('[data-provider-logo="grok"]').count(), 1);
        await rail("Grok").click();
        assert.equal(await rail("Grok").locator('[data-provider-logo="grok"]').count(), 1);
        assert.equal(await warned(), 0, "missing Grok usage never blocks selection");
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
      assert.match(unpreparedText, /Copilot managed isn't installed on M1 yet\./);
      assert.match(unpreparedText, /Ready on Anton's MacBook M4MAX/);
      assert.match(unpreparedText, /Ready now instead\. Picking one switches this chat/);
      assert.match(unpreparedText, /GPT-6\.1-Sol/);
      assert.match(unpreparedText, /Claude Opus 5\.5[\s\S]*Claude/);
      // One install offer, in the note; the footer no longer repeats it.
      assert.equal(await page.locator("[data-model-picker-install]").count(), 1);
      await page.screenshot({ path: join(output, `unprepared-${width}-${theme}.png`) });
      await noOverlap(width, theme);
      // The list keeps its own scroll: the picker fits the window and the list
      // either shows every model or scrolls inside itself.
      const listFit = await page.evaluate(() => {
        const option = document.querySelector("[role=option]");
        let scroller = option?.parentElement ?? null;
        while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY))
          scroller = scroller.parentElement;
        const picker = document.querySelector("[data-model-picker-content]").getBoundingClientRect();
        return {
          pickerFits: picker.bottom <= window.innerHeight + 0.5 && picker.top >= -0.5,
          scrollerHeight: scroller ? scroller.clientHeight : 0,
          scrolls: scroller ? scroller.scrollHeight > scroller.clientHeight : false,
          options: document.querySelectorAll("[role=option]").length,
        };
      });
      assert.ok(listFit.pickerFits, `picker overflows the window at ${width}px`);
      assert.ok(listFit.scrollerHeight >= 60, `list has no room at ${width}px: ${JSON.stringify(listFit)}`);
      await page.locator("[data-model-picker-install]").click();
      await page.getByText("Installing on M1…").waitFor();
      checks.push(`unprepared ${width}px ${theme}: one-click install on M1, no overlap`);
      await page.keyboard.press("Escape");
      await closed();
      await open("unprepared", theme, width);
      await page.locator("[data-model-picker-alternatives]").waitFor();
      await page.getByText("GPT-6.1-Sol", { exact: true }).first().click();
      await page.getByTestId("selection").filter({ hasText: "codex:gpt-6.1-sol" }).waitFor();
      checks.push(
        `unprepared ${width}px ${theme}: ready models offered, manual switch to Codex works`,
      );

      // Warning rows accept both desktop shortcuts and pointer selection.
      await page.addInitScript(() => {
        window.desktopBridge = {};
      });
      await open("account", theme, width);
      const labels = await page.locator("[data-model-picker-content] kbd").allTextContents();
      assert.deepEqual(labels.slice(0, 5), ["⌘1", "⌘2", "⌘3", "⌘4", "⌘5"]);
      // The first spent row's own shortcut picks it; row order follows the model groups.
      const spentKey = await page
        .locator("[data-model-usage-warning=true]")
        .first()
        .locator("kbd")
        .first()
        .textContent();
      await page.keyboard.press(`Meta+${spentKey?.replace("⌘", "")}`);
      assert.match((await selection()) ?? "", /^claudeAgent:/);
      await closed();
      await open("account", theme, width);
      const warningRow = page
        .locator("[data-model-usage-warning=true]")
        .filter({ hasText: "Claude Sonnet 5.5" })
        .first();
      await warningRow.click();
      assert.equal(await selection(), "claudeAgent:claude-sonnet-5-5");
      await open("account", theme, width);
      await page.keyboard.press("Meta+1");
      await page.getByTestId("selection").filter({ hasText: "codex:gpt-6.1-sol" }).waitFor();
      checks.push(
        `${width}px ${theme}: spent models accept shortcut and click, close picker and persist the exact selection`,
      );

      await open("locked", theme, width);
      await rail("Claude").first().click();
      const locked = page.getByRole("option").filter({ hasText: "Claude Fable 5.1" }).first();
      assert.equal(await locked.getAttribute("aria-disabled"), "true");
      await locked.click({ force: true });
      assert.equal(await selection(), "codex:gpt-6.1-sol");
      checks.push(
        `${width}px ${theme}: genuine thread compatibility restriction still blocks selection`,
      );
      await page.close();
      page = await context.newPage();
      await prepare(page);

      // The trigger names the state for screen readers, not only with a ring.
      await page.setViewportSize({ width, height: 860 });
      await page.goto(`${origin}/?case=account&selected-claude=1&theme=${theme}`);
      const label = await page
        .locator("[data-chat-provider-model-picker]")
        .getAttribute("aria-label");
      assert.match(label ?? "", /Claude Opus 5\.5, weekly limit reached, resets in 2d 5h/);
      await page.goto(`${origin}/?case=triggers&theme=${theme}`);
      await page.locator("[data-model-usage-meter=offline]").waitFor();
      await page.screenshot({
        path: join(output, `triggers-${width}-${theme}.png`),
        fullPage: true,
      });
      checks.push(`${width}px ${theme}: trigger meters for every state`);
      // A reset since the read is good news: the chip shows no meter for it.
      assert.equal(
        await page.locator("[data-model-usage-meter=stale]").filter({ hasText: /Reset/ }).count(),
        0,
        "a reset limit reads as a button-like Reset",
      );
      await page.goto(`${origin}/?case=reset&theme=${theme}`);
      const resetChip = page.locator("[data-chat-provider-model-picker]");
      await resetChip.waitFor();
      assert.equal(
        await resetChip.locator("[data-model-usage-meter]").count(),
        0,
        "a limit reset since the read still draws a meter on the chip",
      );
      await resetChip.hover();
      assert.match(
        await page.locator("[data-slot=tooltip-popup]").last().innerText(),
        /Limit reset since last read/,
      );
      await page.mouse.move(0, 0);
      checks.push(`${width}px ${theme}: reset state has no chip meter and says so in the tooltip`);

      // Taller than the room on either side of the chip, the picker still opens
      // above it, aligned to it, and never beside it.
      await page.setViewportSize({ width, height: 560 });
      await page.goto(`${origin}/?case=room&theme=${theme}`);
      const trigger = page.locator("[data-chat-provider-model-picker]");
      await trigger.click();
      await page.locator("[data-model-picker-content]").waitFor();
      await settle();
      const placement = await page.evaluate(() => {
        const picker = document.querySelector("[data-model-picker-content]");
        const chip = document.querySelector("[data-chat-provider-model-picker]");
        const p = picker.getBoundingClientRect();
        const c = chip.getBoundingClientRect();
        return {
          side: picker.closest("[data-slot=popover-positioner]")?.getAttribute("data-side"),
          gap: c.top - p.bottom,
          left: p.left - c.left,
          inside: p.top >= 0 && p.left >= 0 && p.right <= innerWidth + 0.5,
        };
      });
      assert.equal(placement.side, "top", "picker left the chip's axis");
      assert.ok(placement.gap >= 0 && placement.gap <= 12, `picker floats ${placement.gap}px off`);
      assert.ok(placement.inside, "picker leaves the viewport");
      if (width >= 1280) assert.ok(Math.abs(placement.left) <= 2, "picker not aligned to chip");
      await page.screenshot({ path: join(output, `placement-${width}-${theme}.png`) });
      checks.push(`${width}px ${theme}: short window keeps the picker above its chip`);

      // One placement from the first visible frame: the picker never opens high and
      // settles. Sampled with motion on, every animation frame, in a tall window where
      // the whole list is far taller than the picker's own cap.
      for (const height of [860, 560]) {
        const motion = await browser.newContext({
          timezoneId: "America/New_York",
          locale: "en-US",
        });
        await motion.clock.setFixedTime(NOW);
        const live = await motion.newPage();
        await live.route("**/*", (route) =>
          route.request().url().startsWith(origin) ? route.continue() : route.abort(),
        );
        await live.setViewportSize({ width, height });
        await live.goto(`${origin}/?case=long-list&theme=${theme}`);
        await live.evaluate(() => {
          window.__frames = [];
          const sample = () => {
            const picker = document.querySelector("[data-model-picker-content]");
            if (picker) {
              const box = picker.getBoundingClientRect();
              const popup = picker.closest("[data-slot=popover-popup]");
              window.__frames.push({
                bottom: box.bottom,
                left: box.left,
                visible: Number(getComputedStyle(popup).opacity) > 0.02,
              });
            }
            requestAnimationFrame(sample);
          };
          sample();
        });
        await live.locator("[data-chat-provider-model-picker]").click();
        await live.locator("[data-model-picker-content]").waitFor();
        await live.waitForTimeout(600);
        const frames = (await live.evaluate(() => window.__frames)).filter((f) => f.visible);
        assert.ok(frames.length > 3, "too few frames sampled");
        const rest = frames.at(-1);
        // The opening scale moves the edges by under 4% of the width; the chip's edge stays.
        const worst = Math.max(...frames.map((f) => Math.abs(f.bottom - rest.bottom)));
        assert.ok(worst <= 4, `picker jumps ${worst}px vertically while opening at ${height}px`);
        await motion.close();
      }
      // The cause of that jump, directly: Base UI measures with --available-height set to
      // max-content, and the size it measures must be the size the picker rests at.
      await page.setViewportSize({ width, height: 860 });
      await page.goto(`${origin}/?case=long-list&theme=${theme}`);
      await page.locator("[data-chat-provider-model-picker]").click();
      await page.locator("[data-model-picker-content]").waitFor();
      await settle();
      const heights = await page.evaluate(() => {
        const picker = document.querySelector("[data-model-picker-content]");
        const positioner = picker.closest("[data-slot=popover-positioner]");
        const resting = picker.getBoundingClientRect().height;
        positioner.style.setProperty("--available-height", "max-content");
        const measuring = picker.getBoundingClientRect().height;
        return { resting, measuring };
      });
      assert.equal(heights.measuring, heights.resting, "measured height differs from resting");
      checks.push(`${width}px ${theme}: picker opens once, in its final position`);

      // The chip's tooltip and the usage band name the account the provider reports.
      await page.setViewportSize({ width, height: 860 });
      await page.goto(`${origin}/?case=room&selected-claude=1&theme=${theme}`);
      const chip = page.locator("[data-chat-provider-model-picker]");
      await chip.hover();
      await page.locator("[data-model-chip-account]").waitFor();
      assert.equal(
        await page.locator("[data-model-chip-account]").textContent(),
        "Signed in as pat@example.com",
      );
      await chip.click();
      await rail("Claude").first().click();
      await page.locator("[data-model-picker-band-account]").first().waitFor();
      assert.equal(
        await page.locator("[data-model-picker-band-account]").first().textContent(),
        "Signed in as pat@example.com",
      );
      await rail("Codex").first().click();
      await page
        .locator("[data-model-picker-band-account]")
        .filter({ hasText: "Codex does not report an account email" })
        .waitFor();
      await page.screenshot({ path: join(output, `account-${width}-${theme}.png`) });
      checks.push(`${width}px ${theme}: account email shown, or said to be unreported`);
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
