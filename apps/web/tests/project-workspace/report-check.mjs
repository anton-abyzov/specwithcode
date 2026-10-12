// A worker's long report as a card, its reader and save, and the coordinator's folded relay
// (`?report`). Always headless.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE
    ? NodeURL.pathToFileURL(process.env.PLAYWRIGHT_MODULE).href
    : "playwright"
);
const output = process.env.UI_EVIDENCE_DIR;
NodeAssert.ok(output, "Use a new explicit evidence directory");
await NodeFSP.mkdir(output, { recursive: false });
const origin = `http://127.0.0.1:${process.env.PROJECT_UI_PORT ?? 5788}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE }
    : {}),
});
const errors = [];
const checks = [];

try {
  for (const [width, height] of [
    [1440, 1000],
    [390, 844],
  ]) {
    for (const theme of ["light", "dark"]) {
      const label = `${width}-${theme}`;
      const context = await browser.newContext({ viewport: { width, height } });
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(`${label}: ${error.message}`));
      await page.goto(`${origin}/?report`);
      await page.waitForLoadState("networkidle");
      await page.evaluate(
        (dark) => document.documentElement.classList.toggle("dark", dark),
        theme === "dark",
      );
      const shot = (name) => NodePath.join(output, `${name}-${label}.png`);
      const conversation = page.getByLabel("Coordinator conversation");

      // The worker's report is a card: title, size, increment, opening lines.
      const card = conversation.locator('[data-report-artifact="true"]');
      NodeAssert.equal(await card.count(), 1, `${label}: one report card`);
      await card.scrollIntoViewIfNeeded();
      NodeAssert.ok(await card.getByText("Review cycle 2 of 0973").isVisible(), `${label}: title`);
      NodeAssert.equal(
        await card.locator("[data-report-increment]").textContent(),
        "0973-budget-vs-actuals",
        `${label}: increment chip`,
      );
      NodeAssert.ok(
        await card.getByText(/^No critical or high findings remain\./).isVisible(),
        `${label}: summary`,
      );
      NodeAssert.equal(
        await conversation.getByText("Check 12: budget-vs-actuals scenario 12 passes").count(),
        0,
        `${label}: the card does not dump the report`,
      );
      const box = await card.boundingBox();
      NodeAssert.ok(box && box.x >= 0 && box.x + box.width <= width + 1, `${label}: card fits`);
      await card.screenshot({ path: shot("report-card") });

      // The reader shows the whole report, and says where saving puts it.
      await card.getByRole("button", { name: "Open report", exact: true }).click();
      const reader = page.locator('[data-report-reader="true"]');
      await reader.waitFor();
      // Let the dialog finish opening (the phone sheet slides up): wait for a box that holds still.
      await page.waitForFunction(
        () =>
          new Promise((resolve) => {
            const popup = document.querySelector('[data-report-reader="true"]');
            if (popup === null) return resolve(false);
            const before = popup.getBoundingClientRect().bottom;
            setTimeout(() => {
              const after = popup.getBoundingClientRect().bottom;
              resolve(
                Math.abs(after - before) < 0.5 &&
                  popup.getAnimations({ subtree: true }).length === 0,
              );
            }, 150);
          }),
      );
      NodeAssert.ok(
        await reader.getByText(/Check 12: budget-vs-actuals scenario 12 passes/).isVisible(),
        `${label}: reader shows the end of the report`,
      );
      NodeAssert.ok(
        await reader
          .getByText(
            "Not saved yet. Saving puts it in .specweave/increments/0973-budget-vs-actuals/reports/",
          )
          .isVisible(),
        `${label}: reader names the folder`,
      );
      const readerBox = await reader.boundingBox();
      NodeAssert.ok(
        readerBox && readerBox.y >= 0 && readerBox.y + readerBox.height <= height + 1,
        `${label}: reader fits the viewport`,
      );
      await page.screenshot({ path: shot("report-reader") });

      // Saving from the reader writes it once and flips both surfaces to Saved.
      await reader.getByRole("button", { name: "Save to increment" }).click();
      await reader
        .getByText(/^Saved as \.specweave\/increments\/0973-budget-vs-actuals\/reports\//)
        .waitFor();
      const saves = await page.evaluate(() =>
        window.__projectCalls.filter((call) => call.command === "threadReportSave"),
      );
      NodeAssert.equal(saves.length, 1, `${label}: one save`);
      NodeAssert.equal(saves[0].args.input.threadId, "skills", `${label}: saves the worker thread`);
      await page.keyboard.press("Escape");
      await reader.waitFor({ state: "detached" });
      NodeAssert.ok(await card.getByText("Saved", { exact: true }).isVisible(), `${label}: saved`);
      NodeAssert.equal(
        await card.getByRole("button", { name: "Save to increment" }).count(),
        0,
        `${label}: no second save`,
      );

      // The coordinator's long relay folds inline; open, it is bounded and folds from the end.
      const relay = conversation.locator("article").filter({
        hasText: "The review worker finished cycle 2 of 0973.",
      });
      const expand = relay.getByRole("button", { name: "Show full message" });
      await expand.scrollIntoViewIfNeeded();
      NodeAssert.equal(
        await relay.locator('[data-report-collapsed="true"]').count(),
        1,
        `${label}: relay folded`,
      );
      await relay.screenshot({ path: shot("relay-folded") });
      await expand.click();
      const open = relay.locator('[data-report-expanded="true"]');
      await open.waitFor();
      const less = relay.getByRole("button", { name: "Show less" });
      NodeAssert.equal(await less.getAttribute("aria-expanded"), "true", `${label}: expanded`);
      const rule = await open.evaluate((element) => {
        const before = getComputedStyle(element, "::before");
        return { content: before.content, width: before.width, color: before.backgroundColor };
      });
      NodeAssert.notEqual(rule.content, "none", `${label}: open block draws its rule`);
      NodeAssert.ok(Number.parseFloat(rule.width) > 0, `${label}: rule has width`);
      // Scrolled into the middle of the open block, "Show less" stays on screen.
      await open.evaluate((element) => element.scrollIntoView({ block: "start" }));
      await page.waitForTimeout(150);
      const lessBox = await less.boundingBox();
      NodeAssert.ok(
        lessBox && lessBox.y >= 0 && lessBox.y + lessBox.height <= height + 1,
        `${label}: Show less reachable mid-block (${JSON.stringify(lessBox)})`,
      );
      await page.screenshot({ path: shot("relay-open") });
      await less.click();
      await relay.locator('[data-report-collapsed="true"]').waitFor();
      const top = await relay.evaluate((element) => element.getBoundingClientRect().top);
      NodeAssert.ok(top >= -1, `${label}: folding brings the block's top back (${top})`);
      checks.push(label);
      await context.close();
    }
  }
  NodeAssert.deepEqual(errors, [], "no page errors");
  await NodeFSP.writeFile(
    NodePath.join(output, "report-check.json"),
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(`report-check passed: ${checks.join(", ")}`);
} finally {
  await browser.close();
}
