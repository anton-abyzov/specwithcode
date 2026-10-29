// Build the activity-diffs fixture first. No live state or provider credentials.
// STUDIO_PLAYWRIGHT_MODULE=/absolute/playwright/index.mjs node .../overlap-check.mjs /absolute/evidence
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const output = process.argv[2];
if (!output || !path.isAbsolute(output) || !process.env.STUDIO_PLAYWRIGHT_MODULE)
  throw new Error("Provide an absolute evidence directory and STUDIO_PLAYWRIGHT_MODULE");
await fs.mkdir(output, { recursive: true });
const root = path.resolve(".artifacts/activity-diffs/site");
const mime = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".html": "text/html",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = path.resolve(root, "." + (pathname === "/" ? "/index.html" : pathname));
    if (!file.startsWith(root + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    const body = await fs.readFile(file);
    res
      .writeHead(200, {
        "Content-Type": mime[path.extname(file)] ?? "application/octet-stream",
        "Cache-Control": "no-store",
      })
      .end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { chromium } = await import(pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);
let browser;
const checks = [];
const record = (name, pass, observed) => checks.push({ name, pass: Boolean(pass), observed });
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.STUDIO_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE }
      : {}),
  });
  for (const [theme, width] of [
    ["dark", 1280],
    ["light", 390],
  ]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto(
        `http://127.0.0.1:${server.address().port}/?thread=thread-overlap&detail=normal&theme=${theme}`,
      );
      await page.waitForFunction(
        () => window.__fixture?.probeLayout && document.querySelector("[data-timeline-row-id]"),
      );
      const matrix = await page.evaluate(() => window.__fixture.probeLayout());
      record(
        `${theme}/${width} row placement across ${matrix.samples.length} samples`,
        matrix.failures.length === 0,
        matrix.failures,
      );
      record(
        `${theme}/${width} no runtime or observer loop errors`,
        errors.length === 0 && matrix.errors.length === 0,
        { errors, observerErrors: matrix.errors },
      );
      await fs.writeFile(
        path.join(output, `${theme}-${width}-geometry.json`),
        JSON.stringify(matrix, null, 2),
      );
      await page.screenshot({ path: path.join(output, `${theme}-${width}.png`) });
      const scroller = page.locator(".messages-timeline-scroll");
      const before = await scroller.evaluate((e) => e.scrollTop);
      await scroller.hover();
      await page.mouse.wheel(0, -240);
      await page.waitForFunction(
        (old) => document.querySelector(".messages-timeline-scroll").scrollTop < old - 20,
        before,
      );
      record(`${theme}/${width} upward wheel scroll remains usable`, true, {
        before,
        after: await scroller.evaluate((e) => e.scrollTop),
      });
      const anchor = await page.evaluate(() => {
        const state = window.__fixture.listState();
        const viewport = document
          .querySelector(".messages-timeline-scroll")
          .getBoundingClientRect();
        return state.rows.find((r) => r.bottom > viewport.top + 10);
      });
      await page.evaluate(() =>
        window.__fixture.setAssistantText("Background growth while the reader is up. ".repeat(30)),
      );
      await page.waitForTimeout(100);
      const afterAnchor = await page.evaluate(
        (id) => window.__fixture.listState().rows.find((r) => r.id === id),
        anchor.id,
      );
      record(
        `${theme}/${width} reader position survives background growth`,
        afterAnchor && Math.abs(afterAnchor.top - anchor.top) < 3,
        { before: anchor, after: afterAnchor },
      );
      await page
        .locator('textarea[aria-label="Fixture composer"]')
        .fill("Draft survives resize and reveal.");
      await page.evaluate(() => window.__fixture.setHidden(true));
      await page.waitForTimeout(30);
      await page.evaluate(() => window.__fixture.setHidden(false));
      await page.waitForTimeout(80);
      record(
        `${theme}/${width} composer remains usable and draft preserved`,
        (await page.locator("textarea").inputValue()) === "Draft survives resize and reveal.",
        await page.locator("textarea").inputValue(),
      );
      await scroller.evaluate((e) => {
        e.tabIndex = 0;
        e.focus();
      });
      const keyBefore = await scroller.evaluate((e) => e.scrollTop);
      await page.keyboard.press("PageUp");
      await page.waitForTimeout(100);
      record(
        `${theme}/${width} keyboard scroll remains usable`,
        (await scroller.evaluate((e) => e.scrollTop)) < keyBefore,
        { before: keyBefore, after: await scroller.evaluate((e) => e.scrollTop) },
      );
    } finally {
      await context.tracing.stop({ path: path.join(output, `${theme}-${width}-trace.zip`) });
      await context.close();
    }
  }
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.writeFile(
    path.join(output, "receipt.json"),
    JSON.stringify(
      { headless: true, PWDEBUG: "0", PLAYWRIGHT_HTML_OPEN: "never", checks },
      null,
      2,
    ),
  );
}
const failed = checks.filter((check) => !check.pass);
console.log(
  `${checks.length - failed.length}/${checks.length} overlap checks passed. Evidence: ${output}`,
);
if (failed.length) process.exitCode = 1;
