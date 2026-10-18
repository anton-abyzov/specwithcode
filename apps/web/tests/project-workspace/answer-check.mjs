// A worker's direct answer of a few hundred words stays in the chat, not a report card
// (`?report&answer`). Always headless.
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
// ANSWER_MEASURE_ONLY=1 records what a build shows instead of asserting, for a "before" capture.
const measureOnly = process.env.ANSWER_MEASURE_ONLY === "1";
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE }
    : {}),
});
const errors = [];
const results = [];

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
      await page.goto(`${origin}/?report&answer`);
      await page.waitForLoadState("networkidle");
      await page.evaluate(
        (dark) => document.documentElement.classList.toggle("dark", dark),
        theme === "dark",
      );
      const conversation = page.getByLabel("Coordinator conversation");
      const answer = conversation.getByText(/^Both machines are back and the UI no longer freezes/);
      const card = conversation.locator('[data-report-artifact="true"]');
      await card.or(answer).first().waitFor();
      // Line the worker's message up near the top, the way a person reads it.
      await card
        .or(answer)
        .first()
        .evaluate((node) => node.scrollIntoView({ block: "start" }));
      const result = {
        label,
        reportCards: await card.count(),
        openReport: await conversation.getByText("Open report").count(),
        answerVisible: (await answer.count()) > 0 && (await answer.first().isVisible()),
        lastLineInChat:
          (await conversation
            .getByText(/reconnecting the machine from Settings clears it/)
            .count()) > 0,
      };
      results.push(result);
      await page.screenshot({ path: NodePath.join(output, `answer-${label}.png`) });
      if (!measureOnly) {
        NodeAssert.equal(result.reportCards, 0, `${label}: no report card`);
        NodeAssert.equal(result.openReport, 0, `${label}: no Open report button`);
        NodeAssert.ok(result.answerVisible, `${label}: answer shown in the chat`);
        NodeAssert.ok(result.lastLineInChat, `${label}: whole answer in the chat`);
      }
      await context.close();
    }
  }
  NodeAssert.deepEqual(errors, [], "no page errors");
} finally {
  await NodeFSP.writeFile(
    NodePath.join(output, "answer-check.json"),
    `${JSON.stringify({ results, errors }, null, 2)}\n`,
  );
  await browser.close();
}
console.log(JSON.stringify(results));
