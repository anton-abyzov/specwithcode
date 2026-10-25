import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const assert = NodeAssert.default;
const { readFile, mkdir, writeFile } = NodeFSP;
const { resolve, extname, join } = NodePath;
const { homedir } = NodeOS;
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = NodeModule.createRequire(import.meta.url)(
  process.env.STUDIO_PLAYWRIGHT_MODULE ||
    join(
      homedir(),
      ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright",
    ),
);
const site = resolve(".artifacts/core-recovery/site");
const output = resolve(process.argv[2] || ".artifacts/core-recovery/evidence");
await mkdir(output, { recursive: true });
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = resolve(site, "." + (pathname === "/" ? "/index.html" : pathname));
    if (!file.startsWith(site + "/")) throw Error("path");
    res.setHeader(
      "content-type",
      { ".js": "text/javascript", ".css": "text/css", ".html": "text/html" }[extname(file)] ||
        "application/octet-stream",
    );
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.STUDIO_TEST_CHROMIUM ||
    join(
      homedir(),
      "Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell",
    ),
});
const checks = {
  headless: true,
  scope:
    "Production QueuedRunsControl over the real thread-workflows queue derivation; simulated projections and command results; no live server",
  cases: [],
};
const shot = async (page, path) => {
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (animation) =>
          animation.effect?.getComputedTiming().iterations === Infinity ||
          animation.playState !== "running",
      ),
  );
  await page.screenshot({ path, fullPage: true, animations: "disabled" });
};
const open = async (width, height, theme, view) => {
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/?theme=${theme}&view=${view}`);
  await page
    .locator(view.startsWith("strip-") ? "[data-strip-fixture]" : "[data-queue-wait]")
    .waitFor();
  return { page, errors };
};
const noOverflow = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
const header = (page) => page.locator("[data-queue-wait]").textContent();
const reason = (page) => page.locator("[data-queue-reason]").textContent();
// The text must be painted inside the viewport, not clipped away.
const visibleText = (page, selector) =>
  page.evaluate((selector) => {
    const element = document.querySelector(selector);
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.right <= innerWidth + 1 &&
      style.visibility !== "hidden" &&
      element.scrollWidth <= element.clientWidth + 1
    );
  }, selector);

const views = {
  async busy(page) {
    assert.equal(await header(page), "Queue · after current turn");
    const rows = page.locator("ol > li");
    assert.equal(await rows.count(), 4);
    // Automatic deliveries are read-only rows, in delivery order.
    assert.match(await rows.nth(0).textContent(), /Automatic.*Delivers after this turn/s);
    assert.equal(await rows.nth(0).locator("button").count(), 0);
    assert.match(await rows.nth(3).textContent(), /Delivers after this turn/);
    assert.equal(await rows.nth(3).locator("button").count(), 0);
    // Who queued each row.
    assert.match(await rows.nth(1).textContent(), /1031 Simplify settings/);
    assert.match(await rows.nth(2).locator('[data-queued-sender="you"]').textContent(), /You/);
    assert.equal(await rows.nth(1).getByRole("button", { name: "Steer now" }).isEnabled(), true);
    return { rows: 4 };
  },
  async "not-steerable"(page) {
    assert.equal(await header(page), "Queue · after current turn");
    assert.equal(await page.locator("ol > li").count(), 13);
    assert.match(await reason(page), /Steer now is unavailable: No provider turn is running/);
    const steer = page.getByRole("button", { name: "Steer now" }).first();
    assert.equal(await steer.isDisabled(), true);
    assert.match(await steer.getAttribute("data-disabled-reason"), /No provider turn is running/);
    assert.equal(await visibleText(page, "[data-queue-reason]"), true);
    return { rows: 13, disabledReason: await steer.getAttribute("data-disabled-reason") };
  },
  async stopped(page) {
    assert.equal(await header(page), "Queue · held after Stop");
    assert.match(
      await page.locator("[data-queue-held]").textContent(),
      /2 queued messages held after Stop/,
    );
    assert.match(await reason(page), /You stopped the last turn/);
    return {};
  },
  async failure(page) {
    assert.equal(await header(page), "Queue · held after a failure");
    assert.match(await reason(page), /The last turn failed/);
    return {};
  },
  async "usage-limit"(page) {
    assert.equal(await header(page), "Queue · held by a usage limit");
    assert.match(await page.locator("[data-queue-held]").textContent(), /by the usage limit/);
    assert.match(await reason(page), /usage limit stopped this thread/);
    return {};
  },
  async refusal(page) {
    await page.getByRole("button", { name: "Steer now" }).first().click();
    const alert = page.getByRole("alert");
    await alert.waitFor();
    assert.match(
      await alert.textContent(),
      /Provider session provider-session:claude:7f3 is not active\./,
    );
    assert.equal(await visibleText(page, '[role="alert"] span'), true);
    const calls = await page.evaluate(() => window.calls);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "promote");
    return { alert: await alert.textContent() };
  },
  // The composer strip (AC-04): working while native subagents run, gone once
  // 1048 settles them, whether an outage or a person's Stop ended them.
  async "strip-working"(page) {
    const strip = page.locator('[data-background-work-strip="summary"]');
    assert.match(await strip.textContent(), /^3 subagents$/);
    assert.equal(
      await page.locator("[data-strip-fixture]").getAttribute("data-strip-title"),
      "Waiting on 3 subagents",
    );
    assert.equal(await page.locator('[data-background-work-kind="subagent"]').count(), 1);
    assert.equal(await visibleText(page, '[data-background-work-strip="summary"]'), true);
    return { strip: await strip.textContent() };
  },
  async "strip-one"(page) {
    const strip = page.locator('[data-background-work-strip="single"]');
    assert.match(await strip.textContent(), /Audit settings sync across machines/);
    assert.equal(
      await page
        .getByRole("button", { name: "Open subagent Audit settings sync across machines" })
        .count(),
      1,
    );
    return { strip: await strip.textContent() };
  },
  async "strip-mixed"(page) {
    const strip = page.locator('[data-background-work-strip="summary"]');
    assert.match(await strip.textContent(), /^2 subagents · 1 command$/);
    return { strip: await strip.textContent() };
  },
  async "strip-settled"(page) {
    assert.equal(await page.locator("[data-background-work-strip]").count(), 0);
    assert.equal(await page.getByRole("button", { name: "Stop background work" }).count(), 0);
    return { strip: null };
  },
  async "strip-stopped"(page) {
    assert.equal(await page.locator("[data-background-work-strip]").count(), 0);
    return { strip: null };
  },
  async disconnected(page) {
    assert.match(await reason(page), /Anton's Mac mini is not connected\./);
    for (const name of ["Steer now", "Edit queued message", "Remove queued message"]) {
      const buttons = page.getByRole("button", { name });
      for (let index = 0; index < (await buttons.count()); index += 1) {
        assert.equal(await buttons.nth(index).isDisabled(), true, name);
      }
    }
    assert.equal(await page.getByRole("button", { name: /^Reorder queued message/ }).count(), 0);
    return {};
  },
};

try {
  for (const [width, height, theme] of [
    [1280, 900, "light"],
    [390, 844, "light"],
    [1280, 900, "dark"],
    [390, 844, "dark"],
  ]) {
    for (const [view, check] of Object.entries(views)) {
      const { page, errors } = await open(width, height, theme, view);
      const detail = await check(page);
      // Row text never runs under the row's buttons.
      const overlaps = await page.evaluate(
        () =>
          [...document.querySelectorAll("ol > li")].filter((row) => {
            const content = row.querySelector('[data-slot="composer-banner-content"]');
            const actions = row.querySelector('[data-slot="composer-banner-actions"]');
            if (!content || !actions) return false;
            return content.getBoundingClientRect().right > actions.getBoundingClientRect().left + 1;
          }).length,
      );
      assert.equal(overlaps, 0, `${view} ${width}: row text overlaps its actions`);
      const overflow = !(await noOverflow(page));
      assert.equal(overflow, false, `${view} ${width} overflows`);
      const screenshot = join(output, `${view}-${width}-${theme}.png`);
      await shot(page, screenshot);
      assert.deepEqual(errors, []);
      checks.cases.push({
        view,
        width,
        height,
        theme,
        passed: true,
        overflow,
        screenshot,
        ...detail,
      });
      await page.close();
    }
  }
  await writeFile(join(output, "checks.json"), JSON.stringify(checks, null, 2) + "\n");
  console.log(`${checks.cases.length} cases passed; ${join(output, "checks.json")}`);
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
