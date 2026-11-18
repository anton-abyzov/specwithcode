// Component fixture only. Never opens a visible browser or reads a real skills folder.
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { extname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = process.env.STUDIO_PLAYWRIGHT_MODULE
  ? await import(pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href)
  : createRequire(resolve("apps/server/package.json"))("playwright-core");
const root = resolve(".artifacts/skills-machines/site");
if (!process.argv[2]) throw new Error("Pass an absolute evidence directory outside the checkout.");
const output = resolve(process.argv[2]);
assert(!output.startsWith(process.cwd() + sep), "Keep evidence outside the checkout");
await mkdir(output, { recursive: true });
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const path = resolve(root, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
    if (!path.startsWith(root + sep)) {
      res.writeHead(403).end();
      return;
    }
    const body = await readFile(path);
    res
      .writeHead(200, {
        "Content-Type":
          { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" }[extname(path)] ??
          "text/html",
      })
      .end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const errors = [];
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.STUDIO_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage();
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.route("**/*", (route) =>
    route
      .request()
      .url()
      .startsWith(origin + "/")
      ? route.continue()
      : route.abort(),
  );
  const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  for (const theme of ["light", "dark"])
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const shot = (name) =>
        page.screenshot({ path: join(output, `${name}-${theme}-${width}.png`), fullPage: true });

      // A home that holds only claude.ai-synced skills.
      await page.goto(`${origin}/?case=synced&theme=${theme}`);
      const builtIn = page.getByTestId("skills-built-in");
      await builtIn.waitFor();
      assert.match(
        await page.locator("main").innerText(),
        /Set up for\s+All projects\s+on\s+Laptop/,
      );
      assert.equal(
        await page.getByTestId("settings-scope-caption").innerText(),
        "Each machine keeps its own. Changes here only affect Laptop.",
      );
      assert.equal(await builtIn.locator("[data-skill]").count(), 6);
      assert.equal(await builtIn.getByText("Source: claude.ai").count(), 6);
      assert.equal(await builtIn.locator('[role="switch"]').count(), 0);
      assert.equal(await page.getByTestId("skills-table").count(), 0);
      assert.equal(
        await page.getByTestId("skills-empty-agents").innerText(),
        "Codex: no skills installed on Laptop",
      );
      assert.equal(await page.getByText(/environment/i).count(), 0);
      assert.equal(await fits(), true);
      await shot("synced-only-home");

      // A machine with only Codex and its own system skills.
      await page.goto(`${origin}/?case=codex&theme=${theme}`);
      await builtIn.waitFor();
      assert.equal(await builtIn.getByText("Source: Codex").count(), 6);
      assert.equal(
        await page.getByTestId("skills-empty-agents").innerText(),
        "Claude: no skills installed on Laptop",
      );
      assert.equal(await fits(), true);
      await shot("codex-only-machine");

      // Across machines, with one machine offline.
      await page.goto(`${origin}/?case=across&theme=${theme}`);
      await page.getByRole("button", { name: "Across machines", exact: true }).click();
      const matrix = page.getByTestId("skills-matrix");
      await matrix.waitFor();
      const headers = await matrix.locator("thead th").allInnerTexts();
      assert.equal(headers.length, 4);
      assert.match(headers[1], /^Laptop\s+Read /);
      assert.match(headers[2], /^Desktop\s+Read /);
      assert.match(headers[3], /^Mini\s+Offline, not read$/);
      const line = (name) => matrix.locator("tbody tr").filter({ hasText: name }).locator("td");
      assert.deepEqual(await line("release-notes").allInnerTexts(), [
        "On this machine\nv1.4.0",
        "v1.3.0",
        "Offline",
      ]);
      assert.deepEqual((await line("meeting-notes").allInnerTexts()).slice(1), [
        "Not on Desktop",
        "Offline",
      ]);
      // The offline machine is never reported as missing a skill.
      assert.equal(await matrix.getByText("Not on Mini").count(), 0);
      assert.equal(await matrix.locator('button, input, [role="switch"]').count(), 0);
      assert.equal(await fits(), true);
      await shot("across-machines-offline");
    }
  assert.deepEqual(errors, []);
  console.log(`skills-machines: 12 screenshots in ${output}`);
} finally {
  await browser?.close();
  server.close();
}
