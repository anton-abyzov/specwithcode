// Build first: vp build --config apps/web/tests/usage-limit-recovery/vite.config.ts
// Supply the installed Playwright entry via STUDIO_PLAYWRIGHT_MODULE. Always headless.
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);
const root = path.resolve(".artifacts/usage-limit-recovery/site");
const output = path.resolve(
  process.env.USAGE_LIMIT_UI_OUTPUT ?? ".artifacts/usage-limit-recovery/evidence",
);
await fs.mkdir(output, { recursive: true });
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = path.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(`${root}${path.sep}`)) {
      res.writeHead(403).end();
      return;
    }
    const mime = file.endsWith(".js")
      ? "text/javascript"
      : file.endsWith(".css")
        ? "text/css"
        : file.endsWith(".woff2")
          ? "font/woff2"
          : "text/html";
    res.writeHead(200, { "Content-Type": mime });
    res.end(await fs.readFile(file));
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
const errors = [];
const receipt = [];
const BUTTONS = ["Continue with Claude", "Check now", "Snooze until reset"];
try {
  const page = await browser.newPage({ reducedMotion: "reduce" });
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.route("**/*", (route) =>
    route.request().url().startsWith(origin) ? route.continue() : route.abort(),
  );
  for (const width of [320, 375, 768, 1024, 1440, 1920]) {
    for (const [theme, status] of [
      ["light", "changed"],
      ["dark", "changed"],
      ["light", "none"],
    ]) {
      await page.setViewportSize({ width, height: 700 });
      await page.goto(`${origin}/?theme=${theme}&status=${status}`);
      const card = page.locator('[data-slot="composer-banner"][role="alert"]');
      await card.waitFor();
      const title = card.getByText("Usage limit reached", { exact: true });
      const reset = card.getByText(/^Resets in 4 days/);
      const titleBox = await title.boundingBox();
      const resetBox = await reset.boundingBox();
      const cardBox = await card.boundingBox();
      const label = `${width}-${theme}-${status}`;
      assert.ok(titleBox.width > 100, `${label}: title is ${titleBox.width}px wide`);
      assert.ok(resetBox.width > 60, `${label}: reset text is ${resetBox.width}px wide`);
      const titleClipped = await title.evaluate((node) => node.scrollWidth > node.clientWidth + 1);
      assert.equal(titleClipped, false, `${label}: title is clipped`);
      // The whole reset text, clock time included, is readable without opening details.
      const resetText = await reset.evaluate((node) => node.textContent ?? "");
      assert.match(resetText, /^Resets in 4 days \(.+\)/, `${label}: reset text "${resetText}"`);
      const resetClipped = await reset.evaluate((node) => {
        const clips = (element) =>
          element.scrollWidth > element.clientWidth + 1 &&
          getComputedStyle(element).overflowX !== "visible";
        for (
          let element = node;
          element && element !== document.body;
          element = element.parentElement
        ) {
          if (clips(element)) return true;
        }
        return false;
      });
      assert.equal(resetClipped, false, `${label}: reset text is clipped`);
      const resetRight = resetBox.x + resetBox.width;
      assert.ok(
        resetRight <= cardBox.x + cardBox.width + 1,
        `${label}: reset text leaves the card`,
      );
      const details = await card.getByRole("button", { name: "Show notice details" }).count();
      assert.equal(details, 0, `${label}: reset text needs a details tap`);
      const checkbox = card.getByRole("checkbox", {
        name: "Auto-continue when usage is available",
      });
      assert.equal(await checkbox.isChecked(), true);
      await checkbox.uncheck();
      assert.equal(await checkbox.isChecked(), false);
      assert.equal(
        JSON.parse(await page.locator("body").getAttribute("data-recovery-change")).autoResume,
        false,
      );
      await checkbox.check();
      assert.equal(await checkbox.isChecked(), true);
      const buttons = [];
      for (const name of BUTTONS) {
        const box = await card.getByRole("button", { name, exact: true }).boundingBox();
        assert.ok(box && box.width > 0, `${label}: ${name} missing`);
        assert.ok(
          box.x >= cardBox.x - 1 && box.x + box.width <= cardBox.x + cardBox.width + 1,
          `${label}: ${name} leaves the card`,
        );
        // A button may sit beside the text or below it, never on top of it.
        const overlaps =
          box.x < titleBox.x + titleBox.width &&
          box.x + box.width > titleBox.x &&
          box.y < titleBox.y + titleBox.height &&
          box.y + box.height > titleBox.y;
        assert.equal(overlaps, false, `${label}: ${name} overlaps the title`);
        buttons.push(box);
      }
      if (width < 768) {
        for (const box of buttons)
          assert.ok(box.y >= titleBox.y + titleBox.height - 1, `${label}: buttons are not below`);
      }
      if (status === "changed") {
        const line = card.getByText(
          "The account or profile changed. Automatic recovery is blocked.",
        );
        const lineBox = await line.boundingBox();
        assert.ok(
          lineBox.y >= Math.max(...buttons.map((box) => box.y)),
          `${label}: status above buttons`,
        );
      }
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
        `${label}: horizontal page overflow`,
      );
      await card.screenshot({ path: path.join(output, `${label}.png`) });
      receipt.push({
        width,
        theme,
        status,
        titleWidth: Math.round(titleBox.width),
        resetWidth: Math.round(resetBox.width),
        buttonsBelowTitle: buttons.every((box) => box.y >= titleBox.y + titleBox.height - 1),
      });
    }
  }
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${origin}/?claude=1&unarmed=1&status=none&theme=dark`);
    const checkbox = page.getByRole("checkbox", { name: "Auto-continue when the limit resets" });
    assert.equal(await checkbox.isChecked(), false);
    await checkbox.check();
    assert.equal(await checkbox.isChecked(), true);
    assert.equal(await page.getByRole("button", { name: "Check now" }).count(), 0);
    await checkbox.uncheck();
    assert.equal(
      JSON.parse(await page.locator("body").getAttribute("data-recovery-change")).autoResume,
      false,
    );
    await checkbox.check();
    assert.equal(
      JSON.parse(await page.locator("body").getAttribute("data-recovery-change")).autoResume,
      true,
    );
    await page.getByRole("button", { name: "Continue with Codex", exact: true }).click();
    assert.equal(await page.locator("body").getAttribute("data-handoff"), "true");
    assert.equal(
      JSON.parse(await page.locator("body").getAttribute("data-recovery-change")).autoResume,
      false,
    );
    assert.equal(await checkbox.isChecked(), false);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({
      path: path.join(output, `claude-auto-continue-${width}.png`),
      fullPage: true,
    });
    receipt.push({ width, claudeCheckboxToggle: "passed", handoff: "passed" });
  }
  for (const width of [320, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${origin}/?credits=1&status=none`);
    await page.getByText("Included usage limit reached", { exact: true }).waitFor();
    await page.getByText(/39,034.07 credits reported available/).waitFor();
    await page.getByRole("button", { name: "Continue using credits", exact: true }).click();
    assert.equal(await page.locator("body").getAttribute("data-credit-continued"), "true");
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({
      path: path.join(output, `credit-recovery-${width}.png`),
      fullPage: true,
    });
    await page.goto(`${origin}/?resolved=1`);
    const resolved = page.locator("[data-resolved-warning]");
    assert.equal(await resolved.innerText(), "Usage limit resolved — chat continued.");
    assert.equal(await resolved.getByText(/Retry after/).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Continue using credits" }).count(), 0);
    await page.screenshot({
      path: path.join(output, `resolved-warning-${width}.png`),
      fullPage: true,
    });
    receipt.push({ width, creditContinuation: "passed" });
  }
  assert.deepEqual(errors, []);
  await fs.writeFile(
    path.join(output, "receipt.json"),
    JSON.stringify({ headless: true, checks: receipt }, null, 2) + "\n",
  );
  console.log(JSON.stringify({ passed: receipt.length, output }));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
