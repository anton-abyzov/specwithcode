// Build first: vp build --config apps/web/tests/coordinator-menu/vite.config.ts
// Usage: node apps/web/tests/coordinator-menu/verify.mjs [/absolute/evidence-dir] [--before]
// Always headless. Playwright comes from STUDIO_PLAYWRIGHT_MODULE, else apps/server's
// playwright-core; STUDIO_CHROMIUM_EXECUTABLE picks a browser binary.
// --before only shoots the menu (the old menu fails these checks on purpose).
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
const args = process.argv.slice(2);
const before = args.includes("--before");
const label = before ? "before" : "after";
const output = path.resolve(
  args.find((a) => !a.startsWith("--")) ?? ".artifacts/coordinator-menu/evidence",
);
await fs.mkdir(output, { recursive: true });
const root = path.resolve(".artifacts/coordinator-menu/site");
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
try {
  for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width: 520, height: 560 } });
    await page.goto(`${origin}/?theme=${theme}`);
    await page.locator("[data-coordinator-machine]").click();
    const menu = page.locator('[role="menu"]');
    await menu.waitFor();
    await page.waitForTimeout(250);
    const file = path.join(output, `coordinator-menu-${label}-${theme}.png`);
    await page.screenshot({ path: file });
    const items = await page.locator('[role="menuitem"]').allTextContents();
    results.push({ theme, items, file });
    if (!before) {
      // Each machine once: m1 kept its coordinator (paused), linux-mini runs its own, so
      // neither gets a coordinator item; viewing m1 is the way to its coordinator.
      assert.deepEqual(
        items.filter((text) => /coordinator/i.test(text)),
        [],
      );
      const rows = await page.locator('[role="menuitemradio"]').allTextContents();
      assert.deepEqual(rows, ["m1coordinator paused", "linux-miniCopy · main on m4", "m4Main"]);
      // Linked copies: nothing here is "not linked", so the menu does not explain it.
      assert.equal(await page.locator("[data-orchestrator-unlinked-note]").count(), 0);
      await page.locator('[role="menuitemradio"]', { hasText: "m1" }).click();
      await page.locator('[data-viewing="m1:p"]').waitFor();
      assert.match(await page.locator(".sws-host-name").textContent(), /Runs on m1/);
      await page.screenshot({ path: path.join(output, `coordinator-menu-viewed-m1-${theme}.png`) });
    }
    await page.close();
  }
  if (!before) {
    // Checkouts of one repository that were never linked: each says so.
    const page = await browser.newPage({ viewport: { width: 520, height: 560 } });
    await page.goto(`${origin}/?theme=dark&case=unlinked`);
    await page.locator("[data-coordinator-machine]").click();
    await page.locator('[role="menu"]').waitFor();
    await page.waitForTimeout(250);
    const rows = await page.locator('[role="menuitemradio"]').allTextContents();
    assert.deepEqual(rows, ["m1not linked", "m3not linked", "m4not linked"]);
    // Said once, in the open: it is about the projects, not the connection or access.
    assert.equal(
      await page.locator("[data-orchestrator-unlinked-note]").textContent(),
      "Not linked: these are separate projects for this repository, each with its own coordinator, threads and memory. It is not a connection or access problem. Link them below to make one project.",
    );
    assert.deepEqual(await page.locator("[data-orchestrator-link]").allTextContents(), [
      "Link with the project on m1…",
      "Link with the project on m3…",
    ]);
    await page.screenshot({ path: path.join(output, "coordinator-menu-unlinked-after-dark.png") });
    results.push({ theme: "dark", case: "unlinked", rows });
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
await fs.writeFile(
  path.join(output, `coordinator-menu-${label}.json`),
  JSON.stringify(results, null, 2),
);
console.log(JSON.stringify(results, null, 2));
