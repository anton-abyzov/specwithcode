// Build with vp build --config apps/web/tests/computer-use-permissions/vite.config.ts first.
// Supply the installed Playwright entry via STUDIO_PLAYWRIGHT_MODULE.
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);
const root = path.resolve(".artifacts/computer-use-permissions/site");
const output = path.resolve(".artifacts/computer-use-permissions/evidence");
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
const check = (name) => receipt.checks.push(name);
try {
  for (const theme of ["light", "dark"]) {
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 1400 } });
      await page.route("**/*", (route) =>
        route.request().url().startsWith(origin) ? route.continue() : route.abort(),
      );
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${origin}/?theme=${theme}`);
      await page.locator("[data-case]").first().waitFor();
      const failed = page.locator('[data-case="failed"]');
      await failed.getByText("The agent stopped waiting").waitFor();
      // Both permissions start missing, so every local view offers Allow.
      assert.equal(
        await page.locator('[data-case="settings"] button:has-text("Allow")').count(),
        2,
      );
      assert.equal(await page.locator('[data-case="remote"] button').count(), 0);
      assert.match(
        await page.locator('[data-case="remote"]').innerText(),
        /On M1, open the SpecWithCode app/,
      );
      assert.match(
        await page.locator('[data-case="connections"]').innerText(),
        /own computer-use helpers/,
      );
      if (theme === "light" && width === 1280) {
        const shot = path.join(output, `before-${theme}-${width}.png`);
        await page.screenshot({ path: shot, fullPage: true });
        receipt.screenshots.push(shot);
      }
      await failed.locator('button:has-text("Allow")').click();
      assert.deepEqual(await page.evaluate(() => window.__calls), ["request:screen-recording"]);
      await failed.getByRole("button", { name: "Quit & Reopen" }).waitFor();
      check(`${theme}-${width}: Allow asks macOS and offers Quit & Reopen`);
      await page.evaluate(() => window.__grant("screen-recording"));
      await failed.getByText("Screen Recording is allowed.").waitFor({ timeout: 5000 });
      // One shared poll updates every view: the composer notice and Settings flip too.
      await page.locator('[data-case="composer"]').getByText("Allowed").waitFor();
      assert.equal(
        await page.locator('[data-case="settings"] button:has-text("Allow")').count(),
        1,
      );
      await failed.getByRole("button", { name: "Ask the agent to try again" }).click();
      await failed.getByRole("button", { name: "Asked the agent" }).waitFor();
      assert.ok(
        (await page.evaluate(() => window.__calls)).includes(
          "retry:Screen Recording is allowed for SpecWithCode now. Please try again.",
        ),
      );
      check(`${theme}-${width}: a grant updates every view and retry asks the agent`);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
      assert.equal(overflow, false, "no horizontal scroll");
      const shot = path.join(output, `after-${theme}-${width}.png`);
      await page.screenshot({ path: shot, fullPage: true });
      receipt.screenshots.push(shot);
      assert.deepEqual(errors, []);
      await page.close();
    }
  }
  await fs.writeFile(path.join(output, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  await browser.close();
  server.close();
}
