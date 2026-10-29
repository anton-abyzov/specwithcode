// Build first: node node_modules/vite-plus/bin/vp build --config apps/web/tests/usage-limits/vite.config.ts
// Then: node apps/web/tests/usage-limits/verify.mjs /absolute/report-dir
// Always headless. Serves the fixture only; every other request is aborted. Fictional data.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const assert = NodeAssert.default;
const { mkdir, readFile, writeFile } = NodeFSP;
const { extname, join, resolve, sep } = NodePath;

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = process.env.STUDIO_PLAYWRIGHT_MODULE
  ? await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href)
  : NodeModule.createRequire(resolve("apps/server/package.json"))("playwright-core");

const root = resolve(".artifacts/usage-limits/site");
const output = resolve(process.argv[2] ?? ".artifacts/usage-limits/evidence");
await mkdir(output, { recursive: true });
const MIME = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(root + sep)) return void res.writeHead(403).end();
    res
      .writeHead(200, { "Content-Type": MIME[extname(file)] ?? "text/html" })
      .end(await readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;

const checks = [];
const errors = [];
const browser = await chromium.launch({
  headless: true,
  ...(process.env.STUDIO_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE }
    : {}),
});
try {
  for (const theme of ["light", "dark"]) {
    for (const width of [1280, 390]) {
      const context = await browser.newContext({
        colorScheme: theme,
        timezoneId: "America/New_York",
        locale: "en-US",
        viewport: { width, height: 900 },
      });
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.route("**/*", (route) =>
        route.request().url().startsWith(origin) ? route.continue() : route.abort(),
      );
      await page.goto(`${origin}/?theme=${theme}`);
      await page.locator("[data-limit-accounts]").first().waitFor();
      await page.waitForTimeout(900);
      const claude = page.locator("section").filter({ hasText: "Claude" }).first();
      const cards = await claude.locator("[data-limit-account]").count();
      const hidden = await claude.locator("[data-limit-unreported]").count();
      const recent = await claude.locator("[data-limit-recent]").count();
      assert.equal(cards, 2, "two pooled Claude accounts");
      assert.equal(hidden, 1, "the Console-billed machine is shown");
      assert.equal(recent, 1, "the recently read account is shown");
      const text = await page.locator("main").innerText();
      assert.match(text, /Billed to the API/);
      assert.match(text, /max@example\.com/);
      assert.match(text, /of 2 accounts/);
      assert.doesNotMatch(text, /of 200%/);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      assert.ok(overflow <= 0, `no horizontal scroll at ${width}px (${overflow})`);
      const file = join(output, `limits-${theme}-${width}.png`);
      await page.screenshot({ path: file, fullPage: true });
      checks.push({ theme, width, cards, hidden, recent, screenshot: file });
      await context.close();
    }
  }
  assert.deepEqual(errors, []);
  await writeFile(join(output, "receipt.json"), JSON.stringify({ passed: true, checks }, null, 2));
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} finally {
  await browser.close();
  server.close();
}
