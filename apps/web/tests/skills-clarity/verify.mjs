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
const root = resolve(".artifacts/skills-clarity/site");
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
let shots = 0;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.STUDIO_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage({ reducedMotion: "reduce" });
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
  const settled = () =>
    page.evaluate(() =>
      Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {}))),
    );
  for (const theme of ["light", "dark"])
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const shot = async (name, fullPage = true) => {
        await settled();
        await page.screenshot({ path: join(output, `${name}-${theme}-${width}.png`), fullPage });
        shots += 1;
      };

      // Settings: 72 skills, 25 to a page, with what was not read said above the table.
      await page.goto(`${origin}/?view=settings&theme=${theme}`);
      const table = page.getByTestId("skills-table");
      await table.waitFor();
      const pager = page.getByTestId("skills-pager").first();
      assert.equal(await table.locator("tbody tr[data-skill]").count(), 25);
      assert.equal(await pager.getByTestId("pager-range").innerText(), "1–25 of 72");
      assert.equal(await pager.getByTestId("pager-page").innerText(), "Page 1 of 3");
      const read = page.getByTestId("skills-read-state");
      assert.equal(await read.getAttribute("data-partial"), "true");
      const readText = await read.innerText();
      assert.match(readText, /Gemini[\s\S]*The folder scan did not finish/);
      assert.match(readText, /Copilot[\s\S]*not checked for this folder/);
      assert.doesNotMatch(readText, /not installed here|not listed/i);
      assert.ok((await table.getByTestId("skill-folder-scan").count()) > 0);
      assert.ok((await table.getByText("No lock entry found").count()) > 0);
      assert.ok((await table.getByText("Lock names no source").count()) > 0);
      assert.ok((await table.getByText(/also found/).count()) > 0);
      assert.equal(await fits(), true);
      await shot("settings-page-1");

      // Search covers every page, then the result is paged.
      const search = page.getByPlaceholder("Search skills, agents, sources");
      await search.fill("legacy");
      await page
        .getByText("12 of 72", { exact: false })
        .first()
        .waitFor({ timeout: 5000 })
        .catch(() => {});
      assert.equal(await table.locator("tbody tr[data-skill]").count(), 12);
      assert.equal(await page.getByTestId("skills-pager").count(), 0);
      await shot("settings-search-all-pages");
      await search.fill("");
      await pager.getByRole("button", { name: "Next page of skills" }).click();
      await pager.getByRole("button", { name: "Next page of skills" }).click();
      assert.equal(await pager.getByTestId("pager-range").innerText(), "51–72 of 72");
      assert.equal(await table.locator("tbody tr[data-skill]").count(), 22);
      await shot("settings-last-page");

      // Across machines: searchable, paged, and an offline machine is never "missing".
      await page.getByRole("button", { name: "Across machines", exact: true }).click();
      const matrix = page.getByTestId("skills-matrix");
      await matrix.waitFor();
      assert.equal(await matrix.locator("tbody tr").count(), 25);
      await shot("across-machines-paged");
      assert.equal(await matrix.getByText("Not on Mini").count(), 0);
      assert.ok((await matrix.getByText("Not on Desktop").count()) > 0);
      assert.ok((await matrix.getByTestId("matrix-scope").count()) > 0);
      assert.equal(await fits(), true);

      // Composer popover: the agent's own list, matched by name to files the app found.
      await page.goto(`${origin}/?view=popover&theme=${theme}`);
      await page.getByTestId("composer-skills-trigger").click();
      const popover = page.getByTestId("composer-skills-popover");
      await popover.waitFor();
      const source = await popover.getByTestId("composer-skills-source").innerText();
      assert.match(source, /Copilot/);
      assert.match(source, /Laptop/);
      assert.equal(await popover.locator("[data-skill-name]").count(), 20);
      assert.equal(await popover.getByTestId("pager-range").innerText(), "1–20 of 40");
      const text = await popover.innerText();
      assert.doesNotMatch(text, /untracked/i);
      assert.match(text, /Matching file/);
      await shot("popover-page-1", false);
      await popover.getByRole("button", { name: "Next page of skills" }).click();
      assert.equal(await popover.getByTestId("pager-range").innerText(), "21–40 of 40");
      assert.match(await popover.innerText(), /Location unknown/i);
      await popover.locator("[data-skill-name=session-recap]").scrollIntoViewIfNeeded();
      await shot("popover-location-unknown", false);
      await popover.getByRole("textbox", { name: "Search skills" }).fill("session");
      assert.equal(await popover.locator("[data-skill-name]").count(), 1);
      assert.equal(await popover.getByTestId("skills-pager").count(), 0);
      await shot("popover-search", false);
    }
  assert.deepEqual(errors, []);
  console.log(`skills-clarity: ${shots} screenshots in ${output}`);
} finally {
  await browser?.close();
  server.close();
}
