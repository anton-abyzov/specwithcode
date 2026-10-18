// Build with vp build --config apps/web/tests/usage-by-machine/vite.config.ts first.
// Supply the installed Playwright entry via STUDIO_PLAYWRIGHT_MODULE.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeAssert from "node:assert/strict";
const assert = NodeAssert.strict;
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);
const root = NodePath.resolve(".artifacts/usage-by-machine/site");
const output = NodePath.resolve(".artifacts/usage-by-machine/evidence");
await NodeFSP.mkdir(output, { recursive: true });
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = NodePath.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(`${root}${NodePath.sep}`)) {
      res.writeHead(403).end();
      return;
    }
    const mime = file.endsWith(".js")
      ? "text/javascript"
      : file.endsWith(".css")
        ? "text/css"
        : file.endsWith(".svg")
          ? "image/svg+xml"
          : "text/html";
    res.writeHead(200, { "Content-Type": mime });
    res.end(await NodeFSP.readFile(file));
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
const lineOf = (box) => Math.round(box.y + box.height / 2);
try {
  // Desktop app and web, a tablet or narrow window, a phone, the smallest phone.
  for (const theme of ["light", "dark"]) {
    for (const width of [1440, 768, 390, 320]) {
      const page = await browser.newPage({
        viewport: { width, height: 900 },
        deviceScaleFactor: 2,
      });
      await page.route("**/*", (route) =>
        route.request().url().startsWith(origin) ? route.continue() : route.abort(),
      );
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${origin}/?theme=${theme}`);
      const popover = page.locator('[data-case="popover"]');
      await popover.waitFor();
      await page.waitForTimeout(300);
      const grid = popover.locator(".sws-hl-compact");
      const gridBox = await grid.boundingBox();
      assert.ok(gridBox && gridBox.x + gridBox.width <= width, "grid fits the viewport");
      // Nothing in a row wraps, and every column starts at the same x on every host.
      const columns = new Map();
      for (const rowEl of await popover.locator(".sws-hl-compact-row").all()) {
        const rowBox = await rowEl.boundingBox();
        assert.ok(rowBox.height <= 24, `row stays on one line (${rowBox.height}px)`);
        const cells = await rowEl.locator(":scope > *").all();
        for (const [index, cell] of cells.entries()) {
          if (!(await cell.isVisible())) continue;
          const box = await cell.boundingBox();
          assert.equal(lineOf(box), lineOf(rowBox), "cell sits on its row's line");
          const edge = index >= 3 ? Math.round(box.x + box.width) : Math.round(box.x);
          if (index === 4 && box.width === 0) continue;
          const seen = columns.get(index);
          if (seen === undefined) columns.set(index, edge);
          else
            assert.ok(Math.abs(seen - edge) <= 1, `column ${index} aligned (${seen} vs ${edge})`);
        }
      }
      for (const value of await popover.locator(".sws-hl-compact-value").all()) {
        const box = await value.boundingBox();
        assert.ok(box.height <= 20, "value on one line");
      }
      // Host headers: name, badge and status on one line.
      for (const head of await popover.locator(".sws-hl-compact-head").all()) {
        const headBox = await head.boundingBox();
        assert.ok(headBox.height <= 24, `host header on one line (${headBox.height}px)`);
      }
      // The provider section's windows stay on one line too.
      for (const windowEl of await popover.locator(".sws-usage-window").all()) {
        const box = await windowEl.boundingBox();
        assert.ok(box.height <= 20, `usage window on one line (${box.height}px)`);
      }
      const bars = await popover.locator(".sws-hl-compact-row > .sws-hl-bar").first().isVisible();
      assert.deepEqual(errors, []);
      const file = NodePath.join(output, `by-machine-${theme}-${width}.png`);
      await page.screenshot({ path: file, fullPage: false });
      receipt.screenshots.push(file);
      receipt.checks.push({ theme, width, bars, columns: Object.fromEntries(columns) });
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
await NodeFSP.writeFile(NodePath.join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt, null, 2));
