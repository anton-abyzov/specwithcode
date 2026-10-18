// Build with vp build --config apps/web/tests/floating-preview/vite.config.ts first.
// Supply the installed Playwright entry via STUDIO_PLAYWRIGHT_MODULE.
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);
const root = path.resolve(".artifacts/floating-preview/site");
const output = path.resolve(".artifacts/floating-preview/evidence");
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
    for (const recording of [false, true]) {
      const page = await browser.newPage({ viewport: { width: 760, height: 560 } });
      await page.route("**/*", (route) =>
        route.request().url().startsWith(origin) ? route.continue() : route.abort(),
      );
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${origin}/?theme=${theme}${recording ? "&recording=1" : ""}`);
      const toolbar = page.getByRole("toolbar", { name: "Floating preview controls" });
      await toolbar.waitFor();
      // Visible with the pointer elsewhere: no hover needed to find a way back.
      await page.mouse.move(5, 5);
      const opacity = await toolbar.evaluate((node) => getComputedStyle(node).opacity);
      assert.equal(opacity, "1");
      const dock = page.getByRole("button", { name: "Dock preview in right panel" });
      assert.equal(await dock.isVisible(), true);
      assert.match(await dock.innerText(), /Dock/);
      assert.equal(
        await page.getByRole("button", { name: "Close floating preview" }).isVisible(),
        true,
      );
      assert.equal(
        await page.getByRole("status", { name: "Recording preview" }).count(),
        recording ? 1 : 0,
      );
      // The toolbar stays inside the frame's top-right corner.
      const box = await toolbar.boundingBox();
      const frame = await page.locator("[data-preview-mini-player]").boundingBox();
      assert.ok(box.x >= frame.x && box.x + box.width <= frame.x + frame.width);
      assert.ok(box.y >= frame.y && box.y + box.height <= frame.y + 48);
      const file = path.join(output, `${theme}${recording ? "-recording" : ""}.png`);
      await page.locator('[data-case="floating"]').screenshot({ path: file });
      receipt.screenshots.push(file);
      await dock.click();
      assert.equal(await page.evaluate(() => document.body.dataset.docked), "1");
      assert.deepEqual(errors, []);
      receipt.checks.push({ theme, recording, ok: true });
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
await fs.writeFile(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt, null, 2));
