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
        // One header says where you are: the worker's thread › the report, with
        // one Close (Esc). Nothing in it looks pressed when the overlay opens.
        const head = overlay.locator('[data-viewer-overlay-head="true"]');
        NodeAssert.equal(await overlay.locator("header").count(), 1, `${label}: one header`);
        const crumbs = head.getByRole("navigation", { name: "Breadcrumb" });
        NodeAssert.equal(
          await crumbs.locator('[data-crumb="source"]').innerText(),
          "Consolidate the skills",
          `${label}: the thread it came from`,
        );
        NodeAssert.match(
          await crumbs.locator('[data-crumb="current"]').innerText(),
          /Report\s*Review cycle 2 of 0973/,
          `${label}: what is open`,
        );
        NodeAssert.equal(
          await overlay.getByRole("button", { name: /^Close/ }).count(),
          1,
          `${label}: one close button`,
        );
        const headBox = await head.boundingBox();
        NodeAssert.ok(
          headBox && Math.abs(headBox.width - overlayBox.width) <= 2,
          `${label}: the header spans the viewer and the thread`,
        );
        NodeAssert.equal(
          await page.evaluate(
            () => document.activeElement?.getAttribute("data-viewer-overlay-content") ?? null,
          ),
          "true",
          `${label}: focus starts on the page, not a header button`,
        );
        await head.screenshot({ path: shot("overlay-header") });
        // The thread folds away from the header and back; the report takes the room.
        await overlay.getByRole("button", { name: "Hide thread" }).click();
        await thread.waitFor({ state: "detached" });
        const readerFolded = await reader.boundingBox();
        NodeAssert.ok(
          readerFolded.width > readerWide.width + 200,
          `${label}: the report widens when the thread folds`,
        );
        await page.screenshot({ path: shot("report-reader-thread-folded") });
        await overlay.getByRole("button", { name: "Show thread" }).click();
        await thread.waitFor();

        // The thread beside the report is live: its approval and its composer,
        // which steers it while the report stays open.
        NodeAssert.equal(
          await thread.getAttribute("data-overlay-thread-live"),
          "true",
          `${label}: the thread keeps its composer`,
        );
        NodeAssert.ok(
          await thread.getByRole("group", { name: "Approval" }).isVisible(),
          `${label}: its pending approval is beside the report`,
        );
        const steer = thread.getByRole("textbox", { name: "Steer this thread" });
        await steer.fill("Also check scenario 13");
        await steer.press("Enter");
        NodeAssert.equal(
          await page.evaluate(() => window.__overlaySteered),
          "Also check scenario 13",
          `${label}: the composer sends to the thread`,
        );
        NodeAssert.equal(await overlay.count(), 1, `${label}: sending keeps the report open`);
        // Above it, the thread's other artifacts; one press puts another on the left.
        const strip = overlay.getByRole("region", { name: "Artifacts in this thread" });
        const tiles = strip.locator("[data-strip-artifact]");
        NodeAssert.equal(await tiles.count(), 3, `${label}: the thread's three artifacts`);
        NodeAssert.equal(
          await tiles.first().getAttribute("aria-label"),
          "Document: closing-notes.md",
          `${label}: newest first`,
        );
        const stripBox = await strip.boundingBox();
        NodeAssert.ok(
          stripBox && pane && stripBox.y <= pane.y + 2 && stripBox.width <= pane.width + 1,
          `${label}: the strip heads the thread pane`,
        );
        await steer.fill("Draft kept while the report is open");
        await page.waitForFunction(() => {
          const card = document.querySelector('[data-viewer-overlay="true"]');
          return card !== null && getComputedStyle(card).opacity === "1";
        });
        await page.screenshot({ path: shot("viewer-live-thread") });
        await steer.fill("");
        await strip.getByRole("button", { name: "Image: budget-vs-actuals.png" }).click();
        await reader.waitFor({ state: "detached" });
        NodeAssert.match(
          await crumbs.locator('[data-crumb="current"]').innerText(),
          /Image\s*budget-vs-actuals\.png/,
          `${label}: the picked artifact takes the viewer`,
        );
        NodeAssert.equal(
          await strip
            .getByRole("button", { name: "Image: budget-vs-actuals.png" })
            .getAttribute("aria-current"),
          "true",
          `${label}: the strip marks what is open`,
        );
        NodeAssert.equal(
          await thread.getAttribute("data-overlay-thread"),
          "skills",
          `${label}: the same thread stays beside it`,
        );
        await page.screenshot({ path: shot("viewer-strip-picked") });
        // Escape from the composer closes the viewer too.
        await steer.focus();
        await page.keyboard.press("Escape");
        await overlay.waitFor({ state: "detached" });
        await card.getByRole("button", { name: "Open report", exact: true }).click();
        await reader.waitFor();

        // Escape closes it from inside the thread, even where a code block keeps the key.
        await thread.locator('[data-overlay-thread-code="true"]').focus();
        await page.keyboard.press("Escape");
        await overlay.waitFor({ state: "detached" });
        await card.getByRole("button", { name: "Open report", exact: true }).click();
        await reader.waitFor();

        // Find and menus answer Escape first; the next Escape closes the report.
        await overlay.getByRole("button", { name: "Find in report" }).click();
        await overlay.getByRole("textbox", { name: "Find in report" }).fill("Check 12");
        await page.keyboard.press("Escape");
        await overlay.getByRole("button", { name: "Find in report" }).waitFor();
        NodeAssert.equal(await overlay.count(), 1, `${label}: Escape closed find, not the report`);
        await overlay.getByRole("button", { name: "More actions" }).click();
        await page.getByRole("menu").waitFor();
        await page.keyboard.press("Escape");
        await page.getByRole("menu").waitFor({ state: "detached" });
        NodeAssert.equal(await overlay.count(), 1, `${label}: Escape closed the menu only`);
        await page.keyboard.press("Escape");
        await overlay.waitFor({ state: "detached" });
        await card.getByRole("button", { name: "Open report", exact: true }).click();
        await reader.waitFor();
      }
      await page.waitForFunction(() => {
        const card = document.querySelector('[data-viewer-overlay="true"]');
        return card !== null && getComputedStyle(card).opacity === "1";
      });
      await page.screenshot({ path: shot("report-reader") });

      // Saving from the reader writes it once and flips both surfaces to Saved.
      await overlay.getByRole("button", { name: "More actions" }).click();
      // The menu names the folder saving puts it in.
      await page
        .getByRole("menuitem", {
          name: "Save to increment (.specweave/increments/0973-budget-vs-actuals/reports/)",
        })
        .click();
      // On a phone the header drops the detail line; it still says Saved.
      await overlay.getByText(/ · Saved$/).waitFor({ state: "attached" });
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
      // The one Close button closes it too.
      await card.getByRole("button", { name: "Open report", exact: true }).click();
      await reader.waitFor();
      await overlay.getByRole("button", { name: "Close", exact: true }).click();
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
      if (width >= 832) {
        // Opened from the coordinator, the viewer borrows the coordinator's own
        // composer: one composer, moved beside the document and back, draft kept.
        await page.locator("[data-thread-artifacts]").first().click();
        await page.locator('[data-thread-artifact-row="markdown"] button').first().click();
        await overlay.waitFor();
        const lent = overlay.locator('[data-viewer-thread-composer="true"] #project-prompt');
        await lent.waitFor();
        NodeAssert.equal(
          await page.locator("#project-prompt").count(),
          1,
          `${label}: one coordinator composer`,
        );
        NodeAssert.equal(
          await overlay.locator("[data-overlay-thread]").getAttribute("data-overlay-thread-live"),
          null,
          `${label}: the coordinator's transcript, with its page's composer below`,
        );
        await lent.click();
        await page.keyboard.type("Steer from the viewer");
        await page.waitForFunction(() => {
          const card = document.querySelector('[data-viewer-overlay="true"]');
          return card !== null && getComputedStyle(card).opacity === "1";
        });
        await page.screenshot({ path: shot("viewer-coordinator-composer") });
        await page.keyboard.press("Escape");
        await overlay.waitFor({ state: "detached" });
        const home = page.locator("#project-prompt");
        NodeAssert.match(
          await home.evaluate((element) => element.value ?? element.textContent ?? ""),
          /Steer from the viewer/,
          `${label}: the composer is back on its page with the draft`,
        );
      }
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
