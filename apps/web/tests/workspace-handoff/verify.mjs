// Build with vp build --config apps/web/tests/workspace-handoff/vite.config.ts first.
// Supply the installed Playwright entry via STUDIO_PLAYWRIGHT_MODULE.
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);
const root = path.resolve(".artifacts/workspace-handoff/site");
const output = path.resolve(".artifacts/workspace-handoff/evidence");
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
    for (const width of [728, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 1100 } });
      await page.route("**/*", (route) =>
        route.request().url().startsWith(origin) ? route.continue() : route.abort(),
      );
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${origin}/?theme=${theme}`);
      await page.locator('[data-slot="handoff-workspace-summary"]').waitFor();
      const summary = page.locator('[data-slot="handoff-workspace-summary"]');
      assert.ok((await summary.textContent()).includes("External worktrees"));
      assert.ok((await summary.textContent()).includes("feature/workspace-lifecycle"));
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      await page
        .getByRole("textbox", { name: "Folder on Windows workstation" })
        .fill("D:\\Long projects\\workspace-destination");
      await page
        .getByRole("radio", { name: "Copy and transfer coordinator context", exact: false })
        .check();
      await page.locator('[data-slot="copy-choose-first"] [data-slot="checkbox"]').click();
      assert.ok((await summary.textContent()).includes("workspace-destination"));
      assert.deepEqual(errors, []);
      const file = path.join(output, `workspace-handoff-${theme}-${width}.png`);
      await page.screenshot({ path: file, fullPage: true });
      receipt.screenshots.push(file);
      receipt.checks.push({ theme, width, pass: true });
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
await fs.writeFile(path.join(output, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify(receipt, null, 2));
