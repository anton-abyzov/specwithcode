// Build with vp build --config apps/web/tests/approval-card/vite.config.ts first.
// Supply the installed Playwright entry via STUDIO_PLAYWRIGHT_MODULE.
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);
const root = path.resolve(".artifacts/approval-card/site");
const output = path.resolve(".artifacts/approval-card/evidence");
await fs.mkdir(output, { recursive: true });
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = path.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(`${root}${path.sep}`)) {
      res.writeHead(403).end();
      return;
    }
    const mime = file.endsWith(".js")
      ? "text/javascript"
      : file.endsWith(".css")
        ? "text/css"
        : "text/html";
    res.writeHead(200, { "Content-Type": mime });
    res.end(await fs.readFile(file));
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
const receipt = { headless: true, checks: [], screenshots: [] };
try {
  for (const theme of ["light", "dark"]) {
    // 340 is the narrowest thread side panel; 720 the main pane.
    for (const width of [340, 720]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.route("**/*", (route) =>
        route.request().url().startsWith(origin) ? route.continue() : route.abort(),
      );
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${origin}/?theme=${theme}`);
      await page.locator("[data-case]").first().waitFor();
      const queued = page.locator('[data-case="queued-deletes"]');
      assert.equal(
        await queued
          .locator("[data-pending-user-input-waiting]")
          .getAttribute("data-pending-user-input-waiting"),
        "5",
      );
      for (const id of ["queued-deletes", "long-reason", "folder-change"]) {
        const section = page.locator(`[data-case="${id}"]`);
        const geometry = await section.evaluate((element) => {
          const box = (selector) => element.querySelector(selector).getBoundingClientRect();
          const header = box("[data-pending-user-input-toggle]");
          const options = [...element.querySelectorAll("[data-question-option]")].map((option) =>
            option.getBoundingClientRect(),
          );
          const details = box("[data-question-details]");
          const headline = element
            .querySelector("[data-question-card] > div")
            .getBoundingClientRect();
          const scroller = element.querySelector("[data-question-card]").closest("[data-slot]");
          return {
            sectionWidth: element.getBoundingClientRect().width,
            headerWidth: header.width,
            headerScrollWidth: element.querySelector("[data-pending-user-input-toggle]")
              .scrollWidth,
            headlineBottom: headline.bottom,
            detailsTop: details.top,
            optionsRight: Math.max(...options.map((option) => option.right)),
            sectionRight: element.getBoundingClientRect().right,
            scrollerHeight: scroller?.getBoundingClientRect().height ?? 0,
            viewportHeight: window.innerHeight,
          };
        });
        assert.ok(geometry.detailsTop >= geometry.headlineBottom, `${id}: details below headline`);
        assert.ok(geometry.optionsRight <= geometry.sectionRight + 0.5, `${id}: options fit`);
        assert.ok(
          geometry.headerScrollWidth <= geometry.headerWidth + 1,
          `${id}: header row does not overflow`,
        );
        assert.ok(
          geometry.scrollerHeight <= Math.min(24 * 16, 0.4 * geometry.viewportHeight) + 1,
          `${id}: card body caps its height and scrolls`,
        );
        const file = path.join(output, `${id}-${theme}-${width}.png`);
        await section.screenshot({ path: file });
        receipt.screenshots.push(file);
        receipt.checks.push({ id, theme, width, ok: true });
      }
      // An answered decision rests as one line and opens on click.
      for (const id of ["decision-resting", "decision-open"]) {
        const file = path.join(output, `${id}-${theme}-${width}.png`);
        await page.locator(`[data-case="${id}"]`).screenshot({ path: file });
        receipt.screenshots.push(file);
      }
      const resting = page.locator('[data-case="decision-resting"] [data-decision-card]').first();
      const restingHeight = (await resting.boundingBox()).height;
      // One line in the main pane; a narrow panel puts the status on a second.
      assert.ok(
        restingHeight <= (width < 400 ? 64 : 48),
        `answered decision rests compact (${restingHeight}px)`,
      );
      for (const toggle of await page.locator("[data-decision-toggle]").all()) {
        const box = await toggle.evaluate((element) => ({
          scroll: element.scrollWidth,
          width: element.clientWidth,
        }));
        assert.ok(box.scroll <= box.width + 1, "decision row does not overflow");
      }
      await resting.locator("[data-decision-toggle]").click();
      await page.waitForTimeout(300);
      assert.ok((await resting.boundingBox()).height > restingHeight + 40, "click opens it");
      const opened = path.join(output, `decision-clicked-${theme}-${width}.png`);
      await page.locator('[data-case="decision-resting"]').screenshot({ path: opened });
      receipt.screenshots.push(opened);
      // Collapsed, the header keeps only the question's first line.
      await queued.locator("[data-pending-user-input-toggle]").click();
      const collapsed = path.join(output, `queued-deletes-collapsed-${theme}-${width}.png`);
      await queued.screenshot({ path: collapsed });
      receipt.screenshots.push(collapsed);
      assert.deepEqual(errors, []);
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
await fs.writeFile(path.join(output, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(
  JSON.stringify({ checks: receipt.checks.length, screenshots: receipt.screenshots.length }),
);
