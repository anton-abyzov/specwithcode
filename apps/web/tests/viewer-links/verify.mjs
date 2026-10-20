// Build first: vp build --config apps/web/tests/viewer-links/vite.config.ts
// Supply the installed Playwright entry via STUDIO_PLAYWRIGHT_MODULE. Always headless.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);
const root = NodePath.resolve(".artifacts/viewer-links/site");
const output = NodePath.resolve(
  process.argv[2] ?? process.env.VIEWER_LINKS_OUTPUT ?? ".artifacts/viewer-links/evidence",
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

/** True when the element is what the reader sees at its own centre: in front, not behind. */
const inFront = (page, selector) =>
  page.evaluate((selector) => {
    const element = document.querySelector(selector);
    if (!element) return false;
    const box = element.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return false;
    const top = document.elementFromPoint(
      box.left + box.width / 2,
      box.top + Math.min(box.height / 2, 40),
    );
    return top !== null && (element === top || element.contains(top));
  }, selector);
const focusInside = (page, selector) =>
  page.evaluate(
    (selector) => document.querySelector(selector)?.contains(document.activeElement) ?? false,
    selector,
  );
const state = (page) => page.evaluate(() => window.fixtureState());
const reportScroll = (page) =>
  page.evaluate(() => document.querySelector('[data-report-reader-body="true"]')?.scrollTop ?? -1);
/** The overlay animates out; what was behind it is in front once it has gone. */
const overlayGone = (page) =>
  page.locator("[data-viewer-overlay]").waitFor({ state: "detached", timeout: 5000 });
const crumb = (page) =>
  page.locator('[data-viewer-overlay-head="true"] [data-crumb="current"]').innerText();

async function open(theme, width) {
  const context = await browser.newContext({ viewport: { width, height: 760 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.route("**/*", (route) =>
    route.request().url().startsWith(origin) ? route.continue() : route.abort(),
  );
  await page.goto(`${origin}/?theme=${theme}`);
  await page.locator('[data-report-reader-body="true"]').waitFor();
  await page.waitForTimeout(300);
  return { context, page };
}

/** Scrolls the report so the links sit mid-page, and returns where it was left. */
async function scrollToLinks(page) {
  await page.evaluate(() => {
    const body = document.querySelector('[data-report-reader-body="true"]');
    const link = document.querySelector('[data-link="pull-request"]');
    body.scrollTop += link.getBoundingClientRect().top - body.getBoundingClientRect().top - 200;
  });
  await page.waitForTimeout(150);
  return reportScroll(page);
}

try {
  for (const theme of ["light", "dark"]) {
    for (const width of [1000, 390]) {
      const label = `${theme}-${width}`;
      const shot = (name) => NodePath.join(output, `${label}-${name}.png`);
      const row = { label, shots: {} };
      const { context, page } = await open(theme, width);

      // 1. A pull request link opens the pull request in front, in the report's place.
      const scrolled = await scrollToLinks(page);
      NodeAssert.ok(scrolled > 0, `${label}: report scrolled`);
      await page.screenshot({ path: shot("report") });
      row.shots.report = shot("report");
      await page.locator('[data-link="pull-request"]').click();
      await page.locator('[data-viewer-linked="pull-request"]').waitFor();
      NodeAssert.ok(await inFront(page, '[data-fixture-pr="true"]'), `${label}: PR in front`);
      NodeAssert.equal(await page.locator('[data-report-reader-body="true"]').isVisible(), false);
      NodeAssert.ok(
        await focusInside(page, '[data-viewer-linked="pull-request"]'),
        `${label}: focus on PR`,
      );
      NodeAssert.match(await crumb(page), /#442/);
      NodeAssert.equal(
        await page.locator('[data-behind-panel="true"]').count(),
        0,
        `${label}: nothing opened behind`,
      );
      NodeAssert.ok(await page.getByRole("button", { name: /^Back to/ }).isVisible());
      await page.screenshot({ path: shot("pull-request") });
      row.shots.pullRequest = shot("pull-request");

      // 2. Escape steps back to the report where it was left, focus on the link.
      await page.keyboard.press("Escape");
      await page.locator('[data-report-reader-body="true"]').waitFor({ state: "visible" });
      await page.waitForTimeout(100);
      NodeAssert.equal(await reportScroll(page), scrolled, `${label}: same place after Escape`);
      NodeAssert.equal((await state(page)).overlay, "Reduce Mac load and Spotlight scanning");
      NodeAssert.ok(
        await focusInside(page, '[data-link="pull-request"]'),
        `${label}: focus back on link`,
      );

      // 3. Keyboard: Enter on the focused link opens it again; the header's Back returns.
      await page.keyboard.press("Enter");
      await page.locator('[data-viewer-linked="pull-request"]').waitFor();
      await page.getByRole("button", { name: /^Back to/ }).click();
      await page.locator('[data-report-reader-body="true"]').waitFor({ state: "visible" });
      NodeAssert.equal(await reportScroll(page), scrolled, `${label}: same place after Back`);

      // 4. A file link opens the file in front, with Back.
      await page.locator('[data-link="file"]').click();
      await page.locator('[data-viewer-linked="file"]').waitFor();
      NodeAssert.ok(await inFront(page, '[data-viewer-linked="file"]'), `${label}: file in front`);
      NodeAssert.match(await crumb(page), /permissionWatcher\.ts/);
      await page.screenshot({ path: shot("file") });
      row.shots.file = shot("file");
      await page.keyboard.press("Escape");
      await page.locator('[data-report-reader-body="true"]').waitFor({ state: "visible" });

      // 5. "Open in panel" moves the pull request to the side panel, which is then in front.
      await page.locator('[data-link="pull-request"]').click();
      await page.locator('[data-viewer-linked="pull-request"]').waitFor();
      await page
        .locator('[data-viewer-linked-actions="true"]')
        .getByRole("button", { name: "Open in panel" })
        .click();
      await page.locator('[data-behind-panel="true"]').waitFor();
      await overlayGone(page);
      NodeAssert.equal((await state(page)).overlay, null, `${label}: overlay stepped aside`);
      NodeAssert.ok(
        await inFront(page, '[data-panel-surface^="pull-request:"]'),
        `${label}: panel PR in front`,
      );
      await page.screenshot({ path: shot("open-in-panel") });
      row.shots.openInPanel = shot("open-in-panel");

      // 6. A link to the in-app browser steps out so the page opens in front.
      await page.locator('[data-open-report="true"]').click();
      await page.locator('[data-report-reader-body="true"]').waitFor();
      await page.locator('[data-link="in-app-browser"]').click();
      await page.locator("[data-panel-preview]").waitFor();
      await overlayGone(page);
      NodeAssert.equal((await state(page)).overlay, null);
      NodeAssert.ok(await inFront(page, "[data-panel-preview]"), `${label}: browser in front`);

      // 7. A link to another page closes the overlay over a viewer the route keeps mounted.
      await page.locator('[data-open-report="true"]').click();
      await page.locator('[data-report-reader-body="true"]').waitFor();
      await page.locator('[data-link="thread"]').click();
      await page.locator('[data-thread-page="true"]').waitFor();
      await overlayGone(page);
      await page.waitForTimeout(150);
      NodeAssert.equal((await state(page)).overlay, null, `${label}: overlay closed on navigation`);
      NodeAssert.ok(
        await inFront(page, '[data-thread-page="true"]'),
        `${label}: thread page in front`,
      );
      await page.screenshot({ path: shot("thread-page") });
      row.shots.threadPage = shot("thread-page");

      row.reportScrollTop = scrolled;
      receipt.push(row);
      await context.close();
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
