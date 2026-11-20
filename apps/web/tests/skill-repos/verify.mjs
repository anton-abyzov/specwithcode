// Component fixture only. Never opens a visible browser or reaches a machine, GitHub or a registry.
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { extname, resolve, sep, join } from "node:path";
import { pathToFileURL } from "node:url";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = process.env.STUDIO_PLAYWRIGHT_MODULE
  ? await import(pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href)
  : createRequire(resolve("apps/server/package.json"))("playwright-core");
const root = resolve(".artifacts/skill-repos/site");
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
const outside = [];
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.STUDIO_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage();
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(origin + "/")) return route.continue();
    outside.push(url);
    return route.abort();
  });
  const narrow = () => page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  for (const theme of ["light", "dark"])
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${origin}/?theme=${theme}`);
      const updates = page.getByTestId("skill-updates");
      await updates.getByText("1.1.0 · 3f9c2ab").first().waitFor();
      assert.equal(await updates.getByText("1.2.0 · 8d41e07").count(), 1);
      assert.equal(await updates.getByText("Changed at source").count(), 1);
      const repos = page.getByTestId("skill-repos");
      await repos
        .getByText("Sign in to GitHub on Workstation to read acme/private-skills")
        .waitFor();
      assert.equal(
        await repos.locator('[data-repo="anton-abyzov/vskill"] [data-skill]').count(),
        3,
      );
      assert.equal(await narrow(), false);
      await page.screenshot({
        path: join(output, `repos-updates-${theme}-${width}.png`),
        fullPage: true,
      });

      // Searching shows three groups and installs nothing.
      await page.getByRole("searchbox").fill("report");
      await page.locator('[data-group="notes"]').waitFor();
      assert.equal(await page.locator("[data-group]").count(), 3);
      assert.equal(await page.getByTestId("skill-update-outcome").count(), 0);
      await page.getByRole("button", { name: "Update all (2)", exact: true }).click();
      await page.getByText("Updated html-report to 1.2.0 · 8d41e07").waitFor();
      for (const chip of ["Codex: Loaded now", "Copilot: Next session", "Claude: Next session"])
        assert.equal(await updates.getByText(chip, { exact: true }).count(), 1);
      await page
        .locator('[data-group="available"]')
        .getByRole("button", { name: "Install" })
        .click();
      await page.getByText("Installed report-builder 0.4.0 · 8d41e07").waitFor();
      assert.equal(await narrow(), false);
      await page.screenshot({
        path: join(output, `search-update-${theme}-${width}.png`),
        fullPage: true,
      });
    }
  assert.deepEqual(errors, []);
  assert.deepEqual(outside, []);
  console.log(`ok: 8 screenshots in ${output}`);
} finally {
  await browser?.close();
  server.close();
}
