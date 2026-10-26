// Build with vp build --config apps/web/tests/lifecycle-delivery/vite.config.ts first.
// Supply the installed Playwright entry via STUDIO_PLAYWRIGHT_MODULE.
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);
const root = path.resolve(".artifacts/lifecycle-delivery/site");
const output = path.resolve(".artifacts/lifecycle-delivery/evidence");
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
const expected = {
  waiting: "Operational wait",
  user: "Waiting on you",
  pending: "Delivery not verified",
  expired: "Delivery evidence expired",
  verified: "Delivery verified",
};
try {
  for (const theme of ["light", "dark"]) {
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 1100 } });
      await page.route("**/*", (route) =>
        route.request().url().startsWith(origin) ? route.continue() : route.abort(),
      );
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${origin}/?theme=${theme}`);
      await page.locator("[data-case]").first().waitFor();
      for (const [id, title] of Object.entries(expected)) {
        const section = page.locator(`[data-case="${id}"]`);
        assert.equal(await section.getAttribute("data-title"), title);
        const text = (await section.textContent()) ?? "";
        assert.ok(text.includes(title), `${id} shows its title`);
        const box = await section.boundingBox();
        assert.ok(box && box.width <= width, `${id} fits the viewport`);
      }
      const waiting = (await page.locator('[data-case="waiting"]').textContent()) ?? "";
      assert.ok(waiting.includes("Owner: cleanup-owner. Next: verify recovered test capacity."));
      assert.ok(waiting.includes("Owner: release-owner. Next: installed acceptance receipt."));
      assert.deepEqual(errors, []);
      const file = path.join(output, `lifecycle-delivery-${theme}-${width}.png`);
      await page.screenshot({ path: file, fullPage: true });
      receipt.screenshots.push(file);
      receipt.checks.push({ theme, width, cases: Object.keys(expected).length, pass: true });
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
await fs.writeFile(path.join(output, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify(receipt, null, 2));
