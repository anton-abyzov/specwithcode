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
    [1920, 1080],
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
      const readerBox = await reader.boundingBox();
      NodeAssert.ok(
        readerBox && readerBox.y >= 0 && readerBox.y + readerBox.height <= height + 1,
        `${label}: reader fits the viewport`,
      );
      // The reader opens in the app's one overlay: a card over nearly the
      // whole window, the report on the left and the worker's thread on the right.
      const overlay = page.locator('[data-viewer-overlay="true"]');
      NodeAssert.equal(await overlay.count(), 1, `${label}: one overlay`);
      if (width >= 832) {
        await page.waitForFunction(
          () =>
            document.querySelector('[data-viewer-overlay="true"]')?.getAnimations().length === 0,
        );
        const overlayBox = await overlay.boundingBox();
        NodeAssert.ok(
          overlayBox &&
            overlayBox.x <= 24 &&
            overlayBox.x + overlayBox.width >= width - 24 &&
            overlayBox.y <= 48 &&
            overlayBox.y + overlayBox.height >= height - 24,
          `${label}: the overlay covers nearly the whole window (${JSON.stringify(overlayBox)})`,
        );
        const thread = overlay.locator("[data-overlay-thread]");
        NodeAssert.equal(
          await thread.getAttribute("data-overlay-thread"),
          "skills",
          `${label}: the worker's thread beside the report`,
        );
        const pane = await overlay.getByRole("complementary", { name: "Thread" }).boundingBox();
        const readerWide = await reader.boundingBox();
        NodeAssert.ok(
          pane && readerWide && readerWide.x + readerWide.width <= pane.x + 1,
          `${label}: the report is on the left, the thread on the right`,
        );
        NodeAssert.ok(
          readerWide.width >= overlayBox.width * 0.55,
          `${label}: the report gets most of the card (${readerWide.width})`,
        );
        // The thread folds to a rail and back; the report takes the room.
        await overlay.getByRole("button", { name: "Hide thread" }).click();
        await overlay.locator('[data-thread-collapsed="true"]').waitFor();
        NodeAssert.equal(await thread.count(), 0, `${label}: thread folded`);
        const readerFolded = await reader.boundingBox();
        NodeAssert.ok(
          readerFolded.width > readerWide.width + 200,
          `${label}: the report widens when the thread folds`,
        );
        await page.screenshot({ path: shot("report-reader-thread-folded") });
        await overlay.getByRole("button", { name: /^Show thread/ }).click();
        await thread.waitFor();
      }
      await page.screenshot({ path: shot("report-reader") });

      // Saving from the reader writes it once and flips both surfaces to Saved.
      await reader.getByRole("button", { name: "More actions" }).click();
      // The menu names the folder saving puts it in.
      await page
        .getByRole("menuitem", {
          name: "Save to increment (.specweave/increments/0973-budget-vs-actuals/reports/)",
        })
        .click();
      await reader.getByText(/ · Saved$/).waitFor();
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
      // The close button closes it too.
      await card.getByRole("button", { name: "Open report", exact: true }).click();
      await reader.waitFor();
      await reader.getByRole("button", { name: "Close report" }).click();
      await reader.waitFor({ state: "detached" });
      await overlay.waitFor({ state: "detached" });
      if (width >= 832) {
        // And so does a press on the backdrop, outside the card.
        await card.getByRole("button", { name: "Open report", exact: true }).click();
        await reader.waitFor();
        await page.mouse.click(width - 6, Math.round(height / 2));
        await overlay.waitFor({ state: "detached" });
      }

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
