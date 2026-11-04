// Build with vp build --config apps/web/tests/access-waiting/vite.config.ts first.
// Supply the installed Playwright entry via STUDIO_PLAYWRIGHT_MODULE.
// Usage: node apps/web/tests/access-waiting/verify.mjs [screenshot dir]
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);
const root = path.resolve(".artifacts/access-waiting/site");
const output = path.resolve(process.argv[2] ?? ".artifacts/access-waiting/evidence");
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
    for (const [width, height] of [
      [1440, 900],
      [390, 844],
    ]) {
      const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
      await page.route("**/*", (route) =>
        route.request().url().startsWith(origin) ? route.continue() : route.abort(),
      );
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${origin}/?theme=${theme}`);
      await page.locator("[data-access-waiting]").first().waitFor();
      const cards = page.locator("[data-access-waiting]");
      assert.equal(await cards.count(), 3);
      const first = cards.first();
      assert.equal(
        await first.locator(".sws-access-wait-title").textContent(),
        "Launch SpecWithCode iPhone Duo showcase",
      );
      assert.equal(
        await first.locator(".sws-access-wait-subtitle").textContent(),
        "Asking to use apps on your computer",
      );
      assert.match(
        await first.locator("[data-access-waiting-line]").textContent(),
        /is waiting for you to allow access to M4, so it can draft the launch post in Notes/,
      );
      // No subject machine: the thread's own machine, shortened.
      assert.match(
        await cards.nth(1).locator("[data-access-waiting-line]").textContent(),
        /allow access to MacBook M1, so it can run the pairing flow end to end on a simulator\.$/,
      );
      // A worker on another machine waits here too, named by its own machine.
      const remote = cards.nth(2);
      assert.equal(
        await remote.locator(".sws-access-wait-subtitle").textContent(),
        "Asking to work on another machine",
      );
      assert.match(
        await remote.locator("[data-access-waiting-line]").textContent(),
        /allow access to Mac mini M1, so it can run the Linux release build on that machine\.$/,
      );
      assert.equal(await page.locator("svg.lucide-hand").count(), 3);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      assert.ok(overflow <= 0, `no horizontal scroll (${overflow}px)`);
      const file = path.join(output, `part2-${theme}-${width}.png`);
      await page.screenshot({ path: file });
      receipt.screenshots.push(file);
      await first.getByRole("button", { name: /^View thread/ }).click();
      const localEnvironment = (
        await page.locator(".fixture-opened").getAttribute("data-opened")
      ).split("/")[0];
      assert.equal(
        await page.locator(".fixture-opened").getAttribute("data-opened"),
        `${localEnvironment}/thread-showcase`,
      );
      // Opening the remote one names its machine's environment.
      await remote.getByRole("button", { name: /^View thread/ }).click();
      assert.equal(
        await page.locator(".fixture-opened").getAttribute("data-opened"),
        "environment-m1/thread-remote",
      );
      receipt.checks.push({ theme, width, ok: true });
      assert.deepEqual(errors, []);
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
await fs.writeFile(
  path.join(output, "part2-receipt.json"),
  `${JSON.stringify(receipt, null, 2)}\n`,
);
console.log(JSON.stringify(receipt));
