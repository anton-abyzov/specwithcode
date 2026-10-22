import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import os from "node:os";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const root = process.cwd();
const site = path.join(root, ".artifacts/folder-copy/site");
const output = path.resolve(process.argv[2] ?? ".artifacts/folder-copy/evidence");
await fs.mkdir(output, { recursive: true });
const { chromium } = createRequire(import.meta.url)(
  process.env.STUDIO_PLAYWRIGHT_MODULE ??
    path.join(
      os.homedir(),
      ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright",
    ),
);
const server = http.createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const file = path.resolve(site, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(site + path.sep)) return response.writeHead(403).end();
    response.writeHead(200, {
      "Content-Type":
        { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" }[
          path.extname(file)
        ] ?? "text/html",
    });
    response.end(await fs.readFile(file));
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({
  headless: true,
  ...(process.env.STUDIO_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE }
    : {}),
});
const receipt = {
  headless: true,
  source: "Real HandoffFolderCopy with synthetic RPC; no live accounts or provider turns",
  cases: [],
};
try {
  for (const viewport of [
    { width: 1280, height: 1600 },
    { width: 390, height: 844 },
  ]) {
    for (const theme of ["light", "dark"]) {
      const label = `${theme}-${viewport.width}`;
      const page = await browser.newPage({ viewport });
      const noHorizontalOverflow = async (slot) => {
        const dimensions = await page.locator(`[data-slot="${slot}"]`).evaluate((element) => ({
          pageWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
          width: element.clientWidth,
          scrollWidth: element.scrollWidth,
        }));
        assert.ok(dimensions.pageWidth <= dimensions.viewportWidth, `${label}: page overflow`);
        assert.ok(dimensions.scrollWidth <= dimensions.width, `${label}: ${slot} overflow`);
      };
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.address().port}/?theme=${theme}`);
      await page.getByRole("textbox", { name: "Folder on ministorm" }).waitFor();
      assert.equal(
        await page.getByRole("textbox", { name: "Folder on ministorm" }).inputValue(),
        "/home/anton/Projects/github/specweave-umb",
      );
      assert.ok(
        await page
          .locator('[data-slot="copy-source-folder"]')
          .getByText("/Users/you/Projects/github/specweave-umb", { exact: true })
          .isVisible(),
      );
      await noHorizontalOverflow("copy-source-folder");
      await page.locator('[data-slot="copy-source-folder"]').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(output, `${label}-source.png`), fullPage: true });
      await page
        .locator("label")
        .filter({ hasText: "Copy and transfer coordinator context" })
        .click();
      await page.screenshot({ path: path.join(output, `${label}-setup.png`), fullPage: true });
      await page.getByRole("button", { name: "Measure the folder", exact: true }).click();
      await page.getByRole("button", { name: "Preview on ministorm", exact: true }).click();
      await page
        .getByRole("button", { name: "Copy and transfer context to ministorm", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Transfer coordinator context", exact: true })
        .waitFor();
      assert.ok(await page.locator('[data-slot="copy-done"]').isVisible());
      assert.match(
        await page.locator('[data-slot="copy-done"]').textContent(),
        /files are copied. Work is still running/,
      );
      await noHorizontalOverflow("copy-done");
      await page.screenshot({ path: path.join(output, `${label}-deferred.png`), fullPage: true });
      assert.deepEqual(errors, []);
      receipt.cases.push({
        theme,
        viewport,
        horizontalOverflow: false,
        result: "passed",
        destination: "/home/anton/Projects/github/specweave-umb",
        transfer: "deferred; explicit button remains",
      });
      await page.close();
    }
  }
  await fs.writeFile(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify(receipt));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
