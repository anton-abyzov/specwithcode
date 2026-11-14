import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import assert from "node:assert/strict";
const { chromium } = createRequire(resolve("apps/server/package.json"))("playwright-core");
const root = resolve(".artifacts/composer-controls/site");
const output = resolve(process.argv[2]);
await mkdir(output, { recursive: true });
const server = createServer(async (req, res) => {
  try {
    const file = resolve(
      root,
      `.${new URL(req.url, "http://localhost").pathname === "/" ? "/index.html" : new URL(req.url, "http://localhost").pathname}`,
    );
    if (!file.startsWith(root + sep)) return res.writeHead(403).end();
    res.setHeader(
      "Content-Type",
      { ".js": "text/javascript", ".css": "text/css" }[extname(file)] ?? "text/html",
    );
    res.end(await readFile(file));
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
  args: ["--no-sandbox"],
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  for (const width of [1100, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(origin);
    await page.getByRole("button", { name: "Voice", exact: true }).waitFor();
    assert.equal(await page.locator("[data-coordinator-machine]").count(), 1);
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      "composer must fit viewport",
    );
    await page.screenshot({ animations: "disabled", path: resolve(output, `after-${width}.png`) });
    await page.getByRole("button", { name: "Voice", exact: true }).click();
    await page.getByRole("menuitem", { name: "Call the coordinator" }).waitFor();
    await page.waitForFunction(() =>
      [...document.querySelectorAll('[role="menu"]')].some(
        (el) => getComputedStyle(el).opacity === "1",
      ),
    );
    await page.screenshot({
      animations: "disabled",
      path: resolve(output, `voice-menu-${width}.png`),
    });
    await page.keyboard.press("Escape");
    await page.locator("[data-coordinator-machine]").click();
    await page.getByRole("menuitem", { name: "Copy to another machine…", exact: true }).waitFor();
    assert.deepEqual(
      await page.locator('[role="menu"] [data-slot="menu-label"]').allTextContents(),
      ["View this project on", "This project", "On Build machine"],
    );
    assert.deepEqual(await page.getByRole("menuitemradio").allTextContents(), [
      "Build machine",
      "Laptopworkers only",
      "Linux mini",
    ]);
    assert.ok(
      await page.evaluate(() => {
        const box = document.querySelector('[role="menu"]').getBoundingClientRect();
        return box.left >= 0 && box.right <= innerWidth && box.top >= 0;
      }),
      "machine menu must fit viewport",
    );
    await page.screenshot({
      animations: "disabled",
      path: resolve(output, `machine-menu-${width}.png`),
    });
  }
  assert.deepEqual(errors, []);
  console.log("Passed: desktop/narrow controls, voice menu, migration menu, no runtime errors.");
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
