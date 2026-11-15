// Build first: vp build --config apps/web/tests/project-board/vite.config.ts
// Usage: node apps/web/tests/project-board/verify.mjs [/absolute/evidence-dir]
// Always headless. Playwright comes from STUDIO_PLAYWRIGHT_MODULE, else apps/server's
// playwright-core; STUDIO_CHROMIUM_EXECUTABLE picks a browser binary.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = process.env.STUDIO_PLAYWRIGHT_MODULE
  ? await import(pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href)
  : createRequire(path.resolve("apps/server/package.json"))("playwright-core");
const output = path.resolve(process.argv[2] ?? ".artifacts/project-board/evidence");
await fs.mkdir(output, { recursive: true });
const root = path.resolve(".artifacts/project-board/site");
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = path.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    assert(file.startsWith(root + path.sep));
    res.setHeader(
      "Content-Type",
      { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" }[
        path.extname(file)
      ] ?? "text/html",
    );
    res.end(await fs.readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.STUDIO_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE }
    : {}),
});
const results = [];
const column = (page, name) => page.locator(`[data-column="${name}"]`);
const left = async (page, name) => (await column(page, name).boundingBox()).x;
const top = async (page, name) => (await column(page, name).boundingBox()).y;
try {
  for (const theme of ["light", "dark"]) {
    for (const [layout, viewport] of [
      ["expanded", { width: 1440, height: 900 }],
      ["narrow", { width: 440, height: 900 }],
    ]) {
      const page = await browser.newPage({ viewport });
      const errors = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.goto(`${origin}/?theme=${theme}`);
      await column(page, "active").waitFor();
      await page.waitForTimeout(250);
      const file = path.join(output, `board-${layout}-${theme}.png`);
      await page.screenshot({ path: file });

      const headings = await page.locator(".sws-board-column h3").allTextContents();
      assert.deepEqual(headings, [
        "Planned11 increments",
        "Active71 increments",
        "In review7 increments",
        "Done611 increments",
      ]);
      assert.equal(await column(page, "active").locator("[data-increment]").count(), 40);
      assert.equal(await column(page, "done").locator("[data-increment]").count(), 30);
      if (layout === "expanded") {
        // Side by side, in the order work moves.
        const xs = [];
        for (const name of ["planned", "active", "review", "done"]) xs.push(await left(page, name));
        assert.deepEqual(xs, xs.toSorted((a, b) => a - b));
        assert(new Set(xs).size === 4, "four separate columns");
      } else {
        // Stacked, work in motion first.
        assert((await top(page, "active")) < (await top(page, "review")));
        assert((await top(page, "review")) < (await top(page, "planned")));
        assert((await top(page, "planned")) < (await top(page, "done")));
        // Nothing runs off the side of a narrow panel.
        assert.equal(
          await page.evaluate(() => {
            const body = document.querySelector(".sws-board");
            return body.scrollWidth <= body.clientWidth;
          }),
          true,
        );
      }

      if (theme === "light") {
        // More cards, older Done cards, a pull request, the spec and search.
        await column(page, "active").locator(".sws-board-more").click();
        assert.equal(await column(page, "active").locator("[data-increment]").count(), 71);
        await column(page, "done").locator(".sws-board-more").click();
        await page.waitForFunction(
          () => document.querySelectorAll('[data-column="done"] [data-increment]').length === 90,
        );
        await page.locator('[aria-label^="Open pull request"]').first().click();
        assert.match(
          await page.evaluate(() => document.body.dataset.openedLink),
          /^https:\/\/github\.com\/example\/atlas\/pull\/\d+$/,
        );
        await column(page, "review").locator("button.sws-board-card-open").first().click();
        const viewer = page.locator("[data-viewer-path]");
        assert.match(await viewer.getAttribute("data-viewer-path"), /\/spec\.md$/);
        await viewer.click();
        await page.locator('[aria-label="Find an increment"]').fill("passkey");
        await page.waitForFunction(
          () =>
            [...document.querySelectorAll(".sws-board-card-title")].length > 0 &&
            [...document.querySelectorAll(".sws-board-card-title")].every((title) =>
              /passkey/i.test(title.textContent),
            ),
        );
        await page.screenshot({ path: path.join(output, `board-${layout}-search-${theme}.png`) });
        await page.locator('[aria-label="Find an increment"]').fill("no such increment");
        await page.getByText('No increment matches "no such increment".').waitFor();
      }
      assert.deepEqual(errors, []);
      results.push({ theme, layout, headings, file });
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
await fs.writeFile(path.join(output, "board.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
