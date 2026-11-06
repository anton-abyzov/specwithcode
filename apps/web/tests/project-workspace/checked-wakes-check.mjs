// Status-only replies to worker wakes in the coordinator (`?checked-wakes`, 1245):
// Results only folds each into one "Checked <worker>" line; Folded steps shows them.
// Always headless.
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
const LEVEL_NAMES = { concise: "Results only", normal: "Folded steps" };
const errors = [];
const results = [];

async function choose(page, level) {
  await page.locator("[data-timeline-detail]").click();
  await page
    .getByLabel("Show in this thread")
    .getByRole("menuitemradio", { name: new RegExp(`^${LEVEL_NAMES[level]}`) })
    .click();
  await page.waitForFunction(
    (value) => document.querySelector("[data-timeline-detail]")?.dataset.timelineDetail === value,
    level,
  );
}

try {
  for (const view of [
    { name: "1280", viewport: { width: 1280, height: 900 } },
    { name: "360", viewport: { width: 360, height: 780 } },
  ]) {
    for (const theme of ["light", "dark"]) {
      const context = await browser.newContext({
        viewport: view.viewport,
        colorScheme: theme,
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(`${view.name}-${theme}: ${error.message}`));
      await page.goto(`${origin}/?checked-wakes`);
      await page.waitForLoadState("networkidle");
      await page.evaluate(
        (dark) => document.documentElement.classList.toggle("dark", dark),
        theme === "dark",
      );
      if (process.env.EXTRA_CSS)
        await page.addStyleTag({ content: await NodeFSP.readFile(process.env.EXTRA_CSS, "utf8") });
      const conversation = page.getByLabel("Coordinator conversation");
      await conversation.waitFor();
      for (const level of ["normal", "concise"]) {
        await choose(page, level);
        const label = `${level}-${theme}-${view.name}`;
        const lines = await conversation.locator("[data-checked-wake] > summary").allInnerTexts();
        const text = await conversation.innerText();
        results.push({ label, lines, stillRunningShown: text.includes("No change") });
        await page.screenshot({ path: NodePath.join(output, `coordinator-${label}.png`) });
        if (level === "concise") {
          NodeAssert.deepEqual(
            lines,
            ["Checked 1209 skill authoring (app worktree) · 3 times"],
            label,
          );
          NodeAssert.ok(!text.includes("No change"), label);
          NodeAssert.ok(text.includes("The fixes to the skill-authoring changes"), label);
          await conversation.locator("[data-checked-wake] > summary").click();
          await conversation.getByText("No change", { exact: false }).waitFor();
          // All three replies open together.
          NodeAssert.ok((await conversation.innerText()).includes("web build passed"), label);
          await page.screenshot({ path: NodePath.join(output, `coordinator-${label}-opened.png`) });
        } else {
          NodeAssert.equal(lines.length, 0, label);
          NodeAssert.ok(text.includes("No change"), label);
        }
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
  await NodeFSP.writeFile(
    NodePath.join(output, "results.json"),
    JSON.stringify({ results, errors }, null, 2),
  );
}
NodeAssert.deepEqual(errors, []);
console.log(JSON.stringify(results));
