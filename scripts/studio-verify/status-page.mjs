// Run after building apps/web/tests/status-page/vite.config.ts.
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
const root = resolve(".artifacts/status-page/site");
const output = resolve(process.argv[2] ?? ".artifacts/status-page/evidence");
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
      viewport: { width: 1100, height: 1400 },
    });
    page.setDefaultTimeout(15_000);
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.route("**/*", (route) =>
      route.request().url().startsWith(origin) ? route.continue() : route.abort(),
    );
    await page.goto(`${origin}/?theme=${theme}`);
    const banner = page.getByTestId("status-banner");
    await banner.waitFor();
    // M3 is down: the app's own machines need attention, so the banner says so.
    assert.equal(await banner.getAttribute("data-level"), "major_outage");
    assert.match(await banner.textContent(), /need attention/);

    const groups = await page
      .getByTestId("status-group")
      .evaluateAll((nodes) => nodes.map((node) => node.dataset.groupId));
    assert.deepEqual(groups, ["app", "machines", "dependencies"]);
    const services = await page
      .getByTestId("status-service")
      .evaluateAll((nodes) => nodes.map((node) => node.dataset.serviceId));
    assert.deepEqual(services, [
      "local-service",
      "coordinators",
      "updates",
      "machine:m1",
      "machine:m3",
      "machine:air",
      "tailscale",
      "connect",
      "provider:claude",
      "provider:codex",
      "provider:copilot",
      "provider:gemini",
      "provider:grok",
      "github",
    ]);

    const m3 = page.locator('[data-service-id="machine:m3"]');
    assert.match(await m3.textContent(), /Major outage/);
    assert.match(await m3.textContent(), /Unreachable over its private connection/);
    // Rows stay compact; opening one shows its components and what depends on it.
    assert.doesNotMatch(await m3.textContent(), /Used by/);
    await m3.locator("button[aria-expanded]").click();
    assert.match(await m3.textContent(), /Used by/);
    assert.match(await m3.textContent(), /Workers on M3/);

    // A laptop shut 11 days ago is offline, not an outage, and not counted.
    const air = page.locator('[data-service-id="machine:air"]');
    assert.match(await air.textContent(), /Offline/);
    assert.match(await air.textContent(), /Offline for 11 days; not counted/);
    assert.doesNotMatch(await banner.textContent(), /Anna/);

    const claude = page.locator('[data-service-id="provider:claude"]');
    assert.match(await claude.textContent(), /Needs attention/);
    await claude.locator("button[aria-expanded]").click();
    assert.match(await claude.textContent(), /Errors seen in this app/);
    assert.match(await claude.textContent(), /Claude API \(api\.anthropic\.com\)/);

    const gemini = page.locator('[data-service-id="provider:gemini"]');
    assert.match(await gemini.textContent(), /Operational/);
    // OpenAI's component-less ChatGPT incident does not touch Codex.
    const codex = page.locator('[data-service-id="provider:codex"]');
    assert.match(await codex.textContent(), /Operational/);

    const incidents = page.getByTestId("status-incidents");
    assert.match(await incidents.textContent(), /Elevated errors on Claude API/);
    assert.match(await incidents.textContent(), /Unreachable over its private connection/);
    assert.doesNotMatch(await incidents.textContent(), /ChatGPT|Resolved/);

    // Past incidents are grouped by day and collapsed until asked for.
    const past = page.getByTestId("status-past-incidents");
    assert.doesNotMatch(await past.textContent(), /Increased Codex task latency/);
    await past.locator("button").first().click();
    assert.match(await past.textContent(), /Increased Codex task latency/);
    // The overnight crash shows as a resolved incident and marks today's bar.
    assert.match(await past.textContent(), /Local service stopped unexpectedly.*Resolved 1:40/u);
    const localLevels = await page
      .locator('[data-service-id="local-service"]')
      .getByTestId("status-day-bars")
      .locator("span")
      .evaluateAll((nodes) => nodes.map((node) => node.dataset.level));
    assert.equal(localLevels.at(-1), "degraded");

    const bars = page.getByTestId("status-day-bars");
    assert.equal(await bars.first().locator("span").count(), 90);
    const m3Levels = await m3
      .getByTestId("status-day-bars")
      .locator("span")
      .evaluateAll((nodes) => nodes.map((node) => node.dataset.level));
    assert.equal(m3Levels.at(-1), "major_outage");
    // Down from day 34: an outage for its first day, then offline and not counted.
    assert.equal(m3Levels.filter((level) => level === "major_outage").length, 2);
    assert.equal(m3Levels[56], "unknown");
    const githubLevels = await page
      .locator('[data-service-id="github"]')
      .getByTestId("status-day-bars")
      .locator("span")
      .evaluateAll((nodes) => nodes.map((node) => node.dataset.level));
    assert.equal(githubLevels[69], "degraded");

    await page.screenshot({ path: join(output, `status-page-${theme}.png`), fullPage: true });

    // Hovering a day shows its detail.
    await m3.getByTestId("status-day-bars").locator("span").nth(55).hover();
    const popover = page.getByTestId("status-day-popover");
    await popover.waitFor();
    assert.match(await popover.textContent(), /Major outage/);
    assert.match(await popover.textContent(), /6 of 6 checks found a problem/);
    assert.match(await popover.textContent(), /Unreachable over its private connection/);
    await m3.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(output, `status-page-${theme}-hover.png`) });

    // A group's first row: today's Claude popover (with related incidents)
    // rises above the group's edge and must not be clipped by the group card.
    const firstRowBars = claude.getByTestId("status-day-bars");
    await firstRowBars.evaluate((node) => node.scrollIntoView({ block: "center" }));
    await firstRowBars.locator("span").last().hover();
    const topVisible = await popover.evaluate((node) => {
      // The popover ignores the pointer; let the hit test see it.
      node.style.pointerEvents = "auto";
      const box = node.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + 4);
      node.style.pointerEvents = "";
      const group = node.closest('[data-testid="status-group"] > ul').getBoundingClientRect();
      // Only meaningful while the popover actually rises past the card's top.
      if (box.top >= group.top) throw new Error("popover no longer crosses the group's edge");
      return hit !== null && node.contains(hit);
    });
    assert.equal(topVisible, true, "day popover is clipped above the group's first row");
    await page.screenshot({ path: join(output, `status-page-${theme}-first-row-hover.png`) });
    await page.mouse.move(0, 0);

    // Keyboard: the strip is focusable and arrows move the day.
    await claude.getByTestId("status-day-bars").focus();
    await page.keyboard.press("End");
    assert.match(await page.getByTestId("status-day-popover").textContent(), /Related incidents/);

    await page.close();
  }

  // Phone width: the last 30 days, every bar inside its card, no sideways scroll.
  const narrow = await browser.newPage({ viewport: { width: 375, height: 812 } });
  narrow.on("pageerror", (error) => errors.push(String(error)));
  await narrow.goto(`${origin}/?theme=light`);
  await narrow.getByTestId("status-banner").waitFor();
  const overflow = await narrow.evaluate(() => {
    const spill = [...document.querySelectorAll('[data-testid="status-day-bars"]')].filter(
      (strip) => {
        const card = strip.closest('[data-testid="status-group"]').getBoundingClientRect();
        return strip.lastElementChild.getBoundingClientRect().right > card.right;
      },
    ).length;
    return { spill };
  });
  assert.deepEqual(overflow, { spill: 0 });
  assert.equal(await narrow.getByTestId("status-day-bars").first().locator("span").count(), 30);
  assert.match(await narrow.getByTestId("status-uptime-line").first().textContent(), /30 days ago/);
  // Reading today's bar must not scroll any container sideways, and its
  // popover must stay inside the window.
  await narrow.getByTestId("status-day-bars").last().locator("span").last().hover();
  const reading = await narrow.evaluate(() => {
    const strips = document.querySelectorAll('[data-testid="status-day-bars"]');
    const scrolled = [];
    for (let node = strips[strips.length - 1]; node; node = node.parentElement)
      if (node.scrollLeft !== 0) scrolled.push(node.id || node.tagName);
    const box = document
      .querySelector('[data-testid="status-day-popover"]')
      .getBoundingClientRect();
    return { scrolled, inside: box.left >= 0 && box.right <= window.innerWidth };
  });
  assert.deepEqual(reading, { scrolled: [], inside: true });
  await narrow.screenshot({ path: join(output, "status-page-narrow.png"), fullPage: true });
  await narrow.close();
  const narrowDark = await browser.newPage({ viewport: { width: 375, height: 812 } });
  narrowDark.on("pageerror", (error) => errors.push(String(error)));
  await narrowDark.goto(`${origin}/?theme=dark`);
  await narrowDark.getByTestId("status-banner").waitFor();
  await narrowDark.screenshot({
    path: join(output, "status-page-narrow-dark.png"),
    fullPage: true,
  });
  await narrowDark.close();

  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`${origin}/?state=empty`);
  await page.getByTestId("status-banner").waitFor();
  assert.match(await page.getByTestId("status-banner").textContent(), /Checking status/);
  await page.screenshot({ path: join(output, "status-page-empty.png") });
  await page.close();

  assert.deepEqual(errors, []);
  console.log(`status-page: passed; screenshots in ${output}`);
} finally {
  await browser?.close();
  server.close();
}
