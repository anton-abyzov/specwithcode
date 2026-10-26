// The coordinator conversation at each timeline detail level (`?activity`). Always headless.
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

const COMMENTARY = /^Checking the open threads first\./;
const ANSWER = /^Started Consolidate the skills and Record the tutorials\./;
const LIVE_NOTE = "Reading the changelog before I hand this to a worker.";
const errors = [];
const checks = [];

const LEVEL_NAMES = { concise: "Results only", normal: "Folded steps", verbose: "Everything" };

async function choose(page, level) {
  await page.locator("[data-timeline-detail]").click();
  // The default group, the menu's last radio of that name.
  await page
    .getByRole("menuitemradio", { name: new RegExp(`^${LEVEL_NAMES[level]}`) })
    .last()
    .click();
  await page.waitForFunction(
    (value) => document.querySelector("[data-timeline-detail]")?.dataset.timelineDetail === value,
    level,
  );
}

/** The trigger names the project's reply style first, then what the timeline shows. */
const shows = (label, level) => label?.endsWith(`Show: ${LEVEL_NAMES[level]}`) ?? false;

try {
  for (const [width, height] of [
    [1440, 1000],
    [390, 844],
  ]) {
    for (const theme of ["light", "dark"]) {
      const label = `${width}-${theme}`;
      const context = await browser.newContext({ viewport: { width, height } });
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${origin}/?activity`);
      await page.waitForLoadState("networkidle");
      await page.evaluate(
        (dark) => document.documentElement.classList.toggle("dark", dark),
        theme === "dark",
      );
      const conversation = page.getByLabel("Coordinator conversation");
      const trigger = page.locator("[data-timeline-detail]");
      const text = (value) => conversation.getByText(value, { exact: typeof value === "string" });
      const shot = (level) => NodePath.join(output, `coordinator-${level}-${label}.png`);
      // The commentary starts "Consolidate the skills" and carries a file; whatever the
      // level, its card and file show once, under a reply that is on screen.
      const cards = conversation.locator('[aria-label="Threads started"] li');
      const file = conversation.getByRole("button", { name: "Preview triage-notes.md" });
      const startedOnce = async (level) => {
        NodeAssert.equal(await cards.count(), 1, `${label}: ${level} shows the new thread's card`);
        NodeAssert.equal(
          await cards.getByText("Consolidate the skills").count(),
          1,
          `${label}: ${level} card names its thread`,
        );
        NodeAssert.equal(await file.count(), 1, `${label}: ${level} shows the file`);
        NodeAssert.ok(await cards.first().isVisible(), `${label}: ${level} card visible`);
      };

      // Normal: the conversation as it always was, no activity blocks.
      NodeAssert.ok(shows(await trigger.getAttribute("aria-label"), "normal"), label);
      NodeAssert.equal(await text(COMMENTARY).count(), 1, `${label}: normal keeps commentary`);
      NodeAssert.equal(
        await conversation.locator(".sws-run-activity").count(),
        0,
        `${label}: normal`,
      );
      await startedOnce("normal");
      await page.screenshot({ path: shot("normal") });

      // Verbose: each finished turn's steps under its answer, the running turn's above progress.
      await choose(page, "verbose");
      NodeAssert.ok(shows(await trigger.getAttribute("aria-label"), "verbose"), label);
      const finished = conversation.locator("details.sws-run-activity[open]:not([data-live])");
      const live = conversation.locator("details.sws-run-activity[open][data-live]");
      NodeAssert.equal(await finished.count(), 1, `${label}: one finished turn's activity`);
      NodeAssert.equal(await live.count(), 1, `${label}: the running turn's activity`);
      NodeAssert.equal(
        await finished.locator("summary").innerText(),
        "Started 2 workers, checked threads, ran 1 command and read 1 file",
        `${label}: finished summary`,
      );
      NodeAssert.equal(
        await finished.locator("li").count(),
        6,
        `${label}: every step of the finished turn`,
      );
      NodeAssert.equal(
        await finished.getByText("git status --short", { exact: true }).count(),
        1,
        `${label}: command detail`,
      );
      NodeAssert.equal(
        await finished.getByText("Record the tutorials", { exact: true }).count(),
        1,
        `${label}: worker detail`,
      );
      NodeAssert.equal(
        await live
          .locator("li")
          .last()
          .innerText()
          .then((t) => t.split("\n")[0]),
        "Reading a file",
        `${label}: running step in present tense`,
      );
      // The answer sits above its activity, inside the same message.
      const answerBox = await text(ANSWER).boundingBox();
      const activityBox = await finished.boundingBox();
      NodeAssert.ok(answerBox.y < activityBox.y, `${label}: activity under its answer`);
      const working = await page.locator(".sws-coordinator-working").boundingBox();
      if (working) {
        NodeAssert.ok(
          (await live.boundingBox()).y < working.y,
          `${label}: live activity above progress`,
        );
      }
      NodeAssert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
        `${label}: horizontal page overflow`,
      );
      await startedOnce("verbose");
      await finished.scrollIntoViewIfNeeded();
      await page.screenshot({ path: shot("verbose") });
      await finished.screenshot({ path: shot("verbose-activity") });

      // Collapsing an activity block hides its steps; it is a native disclosure.
      const block = conversation.locator("details.sws-run-activity:not([data-live])");
      await block.locator("summary").click();
      NodeAssert.equal(await block.locator("li").first().isVisible(), false, `${label}: collapse`);
      await block.locator("summary").click();
      NodeAssert.equal(await block.locator("li").first().isVisible(), true, `${label}: reopen`);

      // Concise: one reply per turn; the person's messages stay.
      await choose(page, "concise");
      NodeAssert.ok(shows(await trigger.getAttribute("aria-label"), "concise"), label);
      NodeAssert.equal(await text(COMMENTARY).count(), 0, `${label}: concise hides commentary`);
      NodeAssert.equal(await text(ANSWER).count(), 1, `${label}: concise keeps the answer`);
      NodeAssert.equal(await text(LIVE_NOTE).count(), 1, `${label}: concise keeps the live reply`);
      NodeAssert.equal(
        await text("Keep the project moving. Show me the work that needs a decision.").count(),
        1,
        `${label}: concise keeps the person's message`,
      );
      NodeAssert.equal(
        await conversation.locator(".sws-run-activity").count(),
        0,
        `${label}: concise`,
      );
      await startedOnce("concise");
      // The card moved to the answer, the reply that shows.
      NodeAssert.equal(
        await conversation
          .locator("article", { has: page.getByText(ANSWER) })
          .locator('[aria-label="Threads started"] li')
          .count(),
        1,
        `${label}: concise card under the answer`,
      );
      await page.screenshot({ path: shot("concise") });

      // The project header's trigger is marked while a level other than Normal is on.
      NodeAssert.match((await trigger.getAttribute("class")) ?? "", /sws-icon-button-on/, label);
      await choose(page, "normal");
      NodeAssert.doesNotMatch(
        (await trigger.getAttribute("class")) ?? "",
        /sws-icon-button-on/,
        label,
      );
      NodeAssert.equal(await text(COMMENTARY).count(), 1, `${label}: back to normal`);
      checks.push({ width, theme, levels: ["normal", "verbose", "concise"] });
      await context.close();
    }
  }
  NodeAssert.deepEqual(errors, []);
  await NodeFSP.writeFile(
    NodePath.join(output, "receipt.json"),
    JSON.stringify({ headless: true, checks }, null, 2) + "\n",
  );
  console.log(`timeline detail check passed (${checks.length}); screenshots in ${output}`);
} finally {
  await browser.close();
}
