// Build with vp build --config apps/web/tests/usage-machine-share/vite.config.ts first.
// Supply the installed Playwright entry via STUDIO_PLAYWRIGHT_MODULE.
// Usage: node apps/web/tests/usage-machine-share/verify.mjs /absolute/report-dir
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
const assert = NodeAssert.strict;
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);
const root = NodePath.resolve(".artifacts/usage-machine-share/site");
const output = NodePath.resolve(process.argv[2] ?? ".artifacts/usage-machine-share/evidence");
await NodeFSP.mkdir(output, { recursive: true });
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = NodePath.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(`${root}${NodePath.sep}`)) {
      res.writeHead(403).end();
      return;
    }
    const body = await NodeFSP.readFile(file);
    const mime = file.endsWith(".js")
      ? "text/javascript"
      : file.endsWith(".css")
        ? "text/css"
        : "text/html";
    res.writeHead(200, { "Content-Type": mime });
    res.end(body);
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
const CLAUDE = "claudeAgent:alex.rivers@example.com";
const card = (page, accountKey) => page.locator(`[data-share-subscription="${accountKey}"]`);

/** Contrast of an element's text against the fill behind it, resolved by the browser. */
const contrastOf = (locator) =>
  locator.evaluate((element) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const rgb = (color, under) => {
      context.clearRect(0, 0, 1, 1);
      if (under) {
        context.fillStyle = `rgb(${under.join(",")})`;
        context.fillRect(0, 0, 1, 1);
      }
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data];
    };
    let surface = [255, 255, 255];
    const chain = [];
    for (let node = element; node; node = node.parentElement) chain.unshift(node);
    for (const node of chain) {
      const fill = getComputedStyle(node).backgroundColor;
      const [r, g, b, a] = rgb(fill, null);
      if (a > 0) surface = rgb(fill, surface).slice(0, 3);
      (void r, g, b);
    }
    const text = rgb(getComputedStyle(element).color, surface).slice(0, 3);
    const luminance = (channels) =>
      channels
        .map((value) => value / 255)
        .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
        .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    const [light, dark] = [luminance(text), luminance(surface)].sort((a, b) => b - a);
    return (light + 0.05) / (dark + 0.05);
  });

try {
  for (const theme of ["light", "dark"]) {
    // Desktop app and web, a tablet or narrow window, a phone, the smallest phone.
    for (const width of [1440, 768, 390, 320]) {
      const page = await browser.newPage({
        viewport: { width, height: 900 },
        deviceScaleFactor: 2,
        timezoneId: "UTC",
      });
      await page.route("**/*", (route) =>
        route.request().url().startsWith(origin) ? route.continue() : route.abort(),
      );
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${origin}/?theme=${theme}`);
      await page.locator("[data-fixture-ready]").waitFor();

      // Every subscription shows, most used first, and nothing spills sideways.
      const cards = page.locator("[data-share-subscription]");
      assert.equal(await cards.count(), 5, "five subscriptions");
      assert.equal(await cards.first().getAttribute("data-share-subscription"), CLAUDE);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      assert.ok(overflow <= 0, `no sideways scroll at ${width} (${overflow})`);

      // The bar's parts fill it, in machine order, with the estimate last.
      const first = card(page, CLAUDE);
      const parts = first.locator("[data-share-part]");
      const keys = await parts.evaluateAll((nodes) => nodes.map((node) => node.dataset.sharePart));
      assert.deepEqual(keys, ["studio:app", "studio:native", "laptop:app", "outside"]);
      const bar = await first.locator(".usage-machines-bar").boundingBox();
      const boxes = await parts.evaluateAll((nodes) =>
        nodes.map((node) => node.getBoundingClientRect().width),
      );
      const filled = boxes.reduce((sum, value) => sum + value, 0) + 2 * (boxes.length - 1);
      assert.ok(
        Math.abs(filled - bar.width) <= 1.5,
        `parts fill the bar (${filled} of ${bar.width})`,
      );
      assert.equal(
        await first.locator('[data-share-part="studio:app"]').getAttribute("data-machine-color"),
        "violet",
        "a part wears its machine's colour",
      );
      assert.equal(
        await first.locator("[data-share-estimate]").getAttribute("data-share-estimate"),
        "detected",
      );

      // The other outcomes each say what they are.
      const outcomes = await page
        .locator("[data-share-estimate]")
        .evaluateAll((nodes) => nodes.map((node) => node.dataset.shareEstimate));
      assert.deepEqual([...new Set(outcomes)].sort(), ["detected", "none", "unavailable"]);
      await assert.doesNotReject(
        page.getByText("No use outside your machines detected").first().waitFor(),
      );
      await assert.doesNotReject(page.getByText("did not report").first().waitFor());

      // The trend has a column a day and marks the reset.
      assert.equal(await first.locator("[data-share-day]").count(), 7, "seven days");
      assert.equal(await first.locator("[data-share-reset]").count(), 1, "one reset mark");

      // Text on every fill passes 4.5:1; labels a part is too narrow for are hidden.
      let worst = Infinity;
      let worstText = "";
      const texts = page.locator(
        ".usage-machines-part-label, [data-usage-machines] p, [data-usage-machines] li span, [data-usage-machines] h3, [data-usage-machines] h4",
      );
      for (const text of await texts.all()) {
        if (!(await text.isVisible()) || ((await text.textContent()) ?? "").trim() === "") continue;
        const contrast = await contrastOf(text);
        if (contrast < worst) {
          worst = contrast;
          worstText = (await text.textContent()) ?? "";
        }
      }
      assert.ok(
        worst >= 4.5,
        `text contrast at least 4.5:1 (${worst.toFixed(2)} on "${worstText}")`,
      );
      receipt.checks.push({ case: "contrast", theme, width, worst: Number(worst.toFixed(2)) });

      const file = NodePath.join(output, `machines-${theme}-${width}.png`);
      await page.screenshot({ path: file, fullPage: true });
      receipt.screenshots.push(file);

      // Keyboard focus names a part; choosing it filters the breakdown to its machine.
      const laptop = first.locator('[data-share-part="laptop:app"]');
      await laptop.focus();
      const tip = page.getByText(/Work laptop, in SpecWithCode: \$[\d.,]+, \d+%/).last();
      await tip.waitFor();
      await laptop.press("Enter");
      await first.locator('[data-share-breakdown="laptop"]').waitFor();
      assert.equal(await laptop.getAttribute("aria-pressed"), "true");
      if (width === 1440) {
        const focused = NodePath.join(output, `machines-${theme}-drilldown.png`);
        await first.screenshot({ path: focused });
        receipt.screenshots.push(focused);
      }

      // A day's column says what made it up.
      const day = first.locator('[data-share-day="2026-11-18"]');
      assert.match(await day.getAttribute("aria-label"), /Outside your machines \(estimate\)/);

      // The other measures, the reset window and the table.
      await page.getByRole("button", { name: "Tokens" }).click();
      await assert.doesNotReject(first.getByText("tokens on your machines").waitFor());
      await page.getByRole("button", { name: "Cost equivalent" }).click();
      await page.getByRole("button", { name: "Reset window" }).click();
      await assert.doesNotReject(first.getByText(/Since the limit reset on/).waitFor());
      if (width === 1440) {
        const reset = NodePath.join(output, `machines-${theme}-reset-window.png`);
        await page.screenshot({ path: reset, fullPage: true });
        receipt.screenshots.push(reset);
      }
      await page.getByRole("button", { name: "14 days" }).click();
      assert.equal(await first.locator("[data-share-day]").count(), 14, "fourteen days");
      await page.getByRole("button", { name: "Table" }).click();
      const rows = await page.locator("[data-share-table] tbody tr").count();
      assert.ok(rows >= 10, `the table lists every machine of every subscription (${rows})`);
      if (width === 1440 || width === 390) {
        const table = NodePath.join(output, `machines-${theme}-${width}-table.png`);
        await page.screenshot({ path: table, fullPage: true });
        receipt.screenshots.push(table);
      }

      assert.deepEqual(errors, [], "no page errors");
      receipt.checks.push({ case: "machines", theme, width, subscriptions: 5, rows });
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
await NodeFSP.writeFile(NodePath.join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt, null, 2));
