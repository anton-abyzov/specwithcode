import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const site = path.join(root, ".artifacts/output-formatting/site");
const output = path.resolve(
  process.argv[2] ?? path.join(root, ".artifacts/output-formatting/evidence"),
);
await fs.mkdir(output, { recursive: true });
const { chromium } = createRequire(import.meta.url)(
  process.env.STUDIO_PLAYWRIGHT_MODULE ??
    path.join(
      homedir(),
      ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright",
    ),
);
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = path.resolve(site, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(`${site}${path.sep}`)) {
      res.writeHead(403).end();
      return;
    }
    const mime =
      {
        ".js": "text/javascript",
        ".css": "text/css",
        ".woff2": "font/woff2",
        ".wasm": "application/wasm",
      }[path.extname(file)] ?? "text/html";
    const contents = await fs.readFile(file);
    res.writeHead(200, { "Content-Type": mime });
    res.end(contents);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const receipt = {
  headless: true,
  scope:
    "Actual output components; isolated fixture, no provider turns or installed runtime changes",
  cases: [],
};
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.STUDIO_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE }
      : {}),
  });
  for (const [width, theme, clock] of [
    [1440, "light", "12"],
    [390, "light", "12"],
    [1440, "dark", "24"],
    [390, "dark", "24"],
  ]) {
    const context = await browser.newContext({
      viewport: { width, height: 1050 },
      locale: "en-US",
      timezoneId: "America/New_York",
      colorScheme: theme,
      reducedMotion: "reduce",
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", (route) =>
      route.request().url().startsWith(origin) ? route.continue() : route.abort(),
    );
    await page.goto(`${origin}/?theme=${theme}&clock=${clock}`);
    const report = page.getByTestId("report");
    await report.locator("time").first().waitFor();
    const request = page.getByTestId("long-request");
    const preview = request.locator("p").first();
    const originalRequest = await request.getAttribute("data-source");
    assert.ok(
      (await preview.textContent()).length <= 321,
      "screen readers receive a bounded preview",
    );
    const toggle = request.getByRole("button", { name: "Show full message" });
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");
    assert.ok((await request.boundingBox()).height < 200, "long request stays compact");
    assert.equal(await request.getByRole("link").count(), 0, "hidden links cannot take focus");
    await request.getByRole("button", { name: "Copy full message" }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), originalRequest);
    await toggle.focus();
    await toggle.press("Enter");
    assert.equal(
      await request.getByRole("button", { name: "Show less" }).getAttribute("aria-expanded"),
      "true",
    );
    assert.equal(
      await request.getByRole("link", { name: "Reference" }).getAttribute("href"),
      "https://example.com/verification",
    );
    assert.equal(
      await request.locator("code").innerText(),
      '{"checkConnection":true,"timeMin":"2026-10-13T06:00:00Z"}',
    );
    assert.equal(await request.locator("li").count(), 2);
    await request.getByRole("button", { name: "Show less" }).focus();
    await request.getByRole("button", { name: "Show less" }).press("Enter");
    assert.equal(await request.getByRole("link").count(), 0);
    assert.equal(await page.getByTestId("assistant-answer").getByRole("button").count(), 0);
    const expected =
      clock === "12" ? "Oct 17, 2026, 11:58:37 PM EDT" : "Oct 17, 2026, 23:58:37 EDT";
    assert.ok((await page.getByTestId("error").innerText()).includes(expected));
    assert.equal(
      await page.getByTestId("error").locator(".line-clamp-3").count(),
      0,
      "reset date must stay visible",
    );
    assert.ok((await page.getByTestId("failure").innerText()).includes(expected));
    assert.ok((await page.getByTestId("countdown").innerText()).includes(expected));
    assert.ok((await report.locator("time").first().innerText()).includes(expected));
    assert.ok((await report.innerText()).includes("Oct 18, 2026"));
    assert.equal(await report.locator("code").innerText(), "2026-10-18T03:58:37.000Z");
    assert.equal(
      await report.getByRole("link", { name: "Source URL" }).getAttribute("href"),
      "https://example.com/2026-10-18T03:58:37.000Z",
    );
    assert.ok((await page.getByTestId("literal").innerText()).includes("2026-10-18T03:58:37.000Z"));
    assert.equal(await report.locator('ol[start="100"] li').count(), 2);
    assert.equal(await report.locator("ol ul li").count(), 2);
    assert.equal(await report.locator("th[scope=col]").count(), 5);
    const pageOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    );
    assert.equal(pageOverflow, false, `page overflow at ${width}`);
    const viewport = report.getByRole("region", { name: "Scrollable data table" });
    await viewport.focus();
    assert.equal(await viewport.getAttribute("tabindex"), "0");
    if (width === 390) {
      assert.ok(await viewport.evaluate((e) => e.scrollWidth > e.clientWidth));
      await viewport.press("ArrowRight");
      await page.waitForFunction(
        () => document.querySelector('[aria-label="Scrollable data table"]').scrollLeft > 0,
      );
      await viewport.evaluate((e) => {
        e.scrollLeft = 0;
      });
    }
    const table = report.locator("table");
    const numeric = table.locator("tbody tr").first().locator("td").nth(2);
    assert.equal(await numeric.evaluate((e) => getComputedStyle(e).textAlign), "right");
    await report.getByRole("button", { name: "Copy table" }).click();
    await page.getByRole("menuitem", { name: "Copy as CSV" }).click();
    const csv = await page.evaluate(() => navigator.clipboard.readText());
    assert.ok(csv.includes("2026-10-18T03:58:37.000Z"), "CSV must retain source timestamp");
    assert.ok(csv.includes('"1,250.50"'), "CSV must retain quoted numeric source");
    await viewport.evaluate((e) => e.scrollTo({ left: 0, behavior: "instant" }));
    await page.waitForFunction(
      () => document.querySelector('[aria-label="Scrollable data table"]').scrollLeft === 0,
    );
    const screenshot = path.join(output, `${width}-${theme}-${clock}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    assert.deepEqual(errors, [], "browser errors");
    receipt.cases.push({
      width,
      theme,
      clock,
      screenshot,
      pageOverflow,
      rawCsvPreserved: true,
      checks:
        "compact requests, keyboard expand/collapse, exact full-message copy, preserved user Markdown/code/links, full assistant replies, banner, failure, countdown, prose/list/table dates, code/URL/source preservation, numeric alignment, semantic lists/headers, keyboard scrolling, CSV copy",
    });
    await context.close();
  }
  await fs.writeFile(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
