// Build first: vp build --config apps/web/tests/live-activity/vite.config.ts
// Supply the installed Playwright entry via STUDIO_PLAYWRIGHT_MODULE. Always headless.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);
const root = NodePath.resolve(".artifacts/live-activity/site");
const output = NodePath.resolve(
  process.argv[2] ?? process.env.LIVE_ACTIVITY_UI_OUTPUT ?? ".artifacts/live-activity/evidence",
);
await NodeFSP.mkdir(output, { recursive: true });
const MIME = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = NodePath.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(`${root}${NodePath.sep}`)) {
      res.writeHead(403).end();
      return;
    }
    const body = await NodeFSP.readFile(file);
    res.writeHead(200, { "Content-Type": MIME[NodePath.extname(file)] ?? "text/html" });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.STUDIO_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE }
    : {}),
});

const errors = [];
const receipt = [];
const text = (page, selector) => page.locator(selector).first().innerText();

async function open(theme, state, width) {
  const context = await browser.newContext({ viewport: { width, height: 760 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.route("**/*", (route) =>
    route.request().url().startsWith(origin) ? route.continue() : route.abort(),
  );
  await page.goto(`${origin}/?state=${state}&theme=${theme}`);
  await page
    .locator('[data-timeline-row-kind="working"]')
    .or(page.locator("main"))
    .first()
    .waitFor();
  await page.waitForTimeout(300);
  return { context, page };
}

async function noOverflow(page, label) {
  NodeAssert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
    `${label}: horizontal page overflow`,
  );
}

try {
  for (const width of [720, 390]) {
    for (const theme of ["light", "dark"]) {
      const shot = (name) => NodePath.join(output, `${name}-${theme}-${width}.png`);
      const row = { width, theme, shots: {} };

      // Running: the live row names the call, times it from its own start, shows its group.
      {
        const { context, page } = await open(theme, "running", width);
        const label = `${width}-${theme}-running`;
        const header = page.locator('[data-tool-group-header="live"]');
        NodeAssert.equal(await header.getAttribute("aria-expanded"), "false", label);
        // The accessible name keeps the live step and its time, then the disclosure.
        NodeAssert.equal(
          await page
            .getByRole("button", { name: /^Running .*\b4\ds show these 5 tool calls$/ })
            .count(),
          1,
          `${label}: accessible name`,
        );
        NodeAssert.match(await header.innerText(), /Running/, label);
        NodeAssert.match(await header.innerText(), /5 calls/, label);
        NodeAssert.match(
          await text(page, "[data-live-elapsed]"),
          /^4\ds$/,
          `${label}: step elapsed`,
        );
        NodeAssert.equal(await page.locator('[data-live-dot="fresh"]').count(), 1, label);
        NodeAssert.match(await text(page, "[data-working-host]"), /MacBook M4MAX/, label);
        NodeAssert.equal(await page.locator("[data-work-group-content]").count(), 0, label);
        await noOverflow(page, label);
        await page.screenshot({ path: shot("running-collapsed") });
        row.shots.runningCollapsed = shot("running-collapsed");

        // Open the group with the keyboard: a bounded list of sibling calls.
        await header.focus();
        await page.keyboard.press("Enter");
        await page.locator("[data-work-group-content]").waitFor();
        await page.waitForTimeout(500);
        NodeAssert.equal(await header.getAttribute("aria-expanded"), "true", label);
        NodeAssert.equal(
          await page.getByRole("button", { name: / hide these 5 tool calls$/ }).count(),
          1,
          `${label}: accessible name`,
        );
        const group = page.locator("[data-work-group-content]");
        const border = await group.evaluate((el) => getComputedStyle(el).borderInlineStartWidth);
        NodeAssert.equal(border, "1px", `${label}: group rule`);
        const groupBox = await group.boundingBox();
        const headerBox = await header.boundingBox();
        NodeAssert.ok(groupBox.x >= headerBox.x + 10, `${label}: group indented`);
        NodeAssert.ok(await group.getByText("ls ~/Projects/atlas/src/app").isVisible(), label);
        await noOverflow(page, `${label}-expanded`);
        await page.screenshot({ path: shot("running-expanded") });
        row.shots.runningExpanded = shot("running-expanded");
        await context.close();
      }

      // Thinking: only while events keep arriving; elapsed counts from the last one.
      {
        const { context, page } = await open(theme, "thinking", width);
        const label = `${width}-${theme}-thinking`;
        // Between calls the row keeps the last call and says the model has the turn.
        const live = page.locator('[data-tool-group-header="live"]');
        NodeAssert.match(await live.innerText(), /bash check\.sh/, label);
        NodeAssert.match(await text(page, "[data-live-elapsed]"), /^Thinking\s[6-9]s$/, label);
        NodeAssert.equal(await page.locator('[data-live-dot="fresh"]').count(), 1, label);
        await page.screenshot({ path: shot("thinking") });
        row.shots.thinking = shot("thinking");
        await context.close();
      }

      // Quiet: three minutes without a turn-item change is said plainly.
      {
        const { context, page } = await open(theme, "quiet", width);
        const label = `${width}-${theme}-quiet`;
        const live = page.locator('[data-tool-group-header="live"]');
        NodeAssert.doesNotMatch(await live.innerText(), /Thinking/, label);
        NodeAssert.equal(await text(page, "[data-live-elapsed]"), "No new events for 3m", label);
        NodeAssert.equal(await page.locator('[data-live-dot="quiet"]').count(), 1, label);
        await page.screenshot({ path: shot("quiet") });
        row.shots.quiet = shot("quiet");
        await context.close();
      }

      // Offline host: the header stops implying progress.
      {
        const { context, page } = await open(theme, "offline", width);
        const label = `${width}-${theme}-offline`;
        NodeAssert.match(
          await text(page, "[data-working-host]"),
          /offline, status may be stale/,
          label,
        );
        NodeAssert.equal(await page.locator('[data-live-dot="offline"]').count(), 1, label);
        // No elapsed clock or shine while the host is unreachable.
        NodeAssert.equal(await page.locator("[data-live-elapsed]").count(), 0, label);
        NodeAssert.equal(await page.locator(".live-tool-shine").count(), 0, label);
        await noOverflow(page, label);
        await page.screenshot({ path: shot("offline") });
        row.shots.offline = shot("offline");
        await context.close();
      }

      // Settled: no live rows; the finished group header has a chevron and opens bounded.
      {
        const { context, page } = await open(theme, "settled", width);
        const label = `${width}-${theme}-settled`;
        NodeAssert.equal(
          await page.locator('[data-timeline-row-kind="working"]').count(),
          0,
          label,
        );
        NodeAssert.equal(await page.locator("[data-live-elapsed]").count(), 0, label);
        await page.screenshot({ path: shot("settled-folded") });
        row.shots.settledFolded = shot("settled-folded");
        // Open the turn, then its tool group: a closed header with a chevron, then a bounded list.
        await page.locator('[data-timeline-row-kind="turn-fold"] button').first().click();
        const toggle = page
          .locator(
            '[data-timeline-row-kind="work-toggle"] button[aria-expanded], [data-timeline-row-kind="tool-activity"] button[aria-expanded]',
          )
          .first();
        await toggle.waitFor();
        NodeAssert.equal(await toggle.getAttribute("aria-expanded"), "false", label);
        NodeAssert.ok((await toggle.locator("svg").count()) >= 2, `${label}: chevron`);
        await page.screenshot({ path: shot("settled-collapsed") });
        row.shots.settledCollapsed = shot("settled-collapsed");
        await toggle.click();
        const inner = page.locator(
          '[data-timeline-row-kind="work-toggle"] button[aria-expanded="false"]',
        );
        if ((await inner.count()) > 0) await inner.first().click();
        await page.locator("[data-work-group-content]").first().waitFor();
        NodeAssert.equal(
          await page
            .locator('[data-timeline-row-kind="work-toggle"] button')
            .first()
            .getAttribute("aria-expanded"),
          "true",
          `${label}: open group header`,
        );
        // Let the chevrons finish turning before the capture.
        await page.waitForTimeout(500);
        await page.screenshot({ path: shot("settled-expanded") });
        row.shots.settledExpanded = shot("settled-expanded");
        await context.close();
      }
      receipt.push(row);
    }
  }
  NodeAssert.deepEqual(errors, []);
  await NodeFSP.writeFile(
    NodePath.join(output, "receipt.json"),
    JSON.stringify({ headless: true, checks: receipt }, null, 2) + "\n",
  );
  console.log(JSON.stringify({ passed: receipt.length, output }));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
