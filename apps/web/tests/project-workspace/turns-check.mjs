// Run against serve.mjs. Checks the coordinator turn layout on the `?turns` fixture.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE
    ? NodeURL.pathToFileURL(process.env.PLAYWRIGHT_MODULE).href
    : "playwright"
);
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const output = process.env.PROJECT_UI_OUTPUT;
NodeAssert.ok(output, "Set PROJECT_UI_OUTPUT to an evidence directory");
const port = process.env.PROJECT_UI_PORT ?? 5788;
await NodeFSP.mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
    : {}),
});
try {
  for (const [name, viewport, scheme] of [
    ["desktop-light", { width: 1440, height: 900 }, "light"],
    ["desktop-dark", { width: 1440, height: 900 }, "dark"],
    ["phone", { width: 390, height: 844 }, "light"],
  ]) {
    const page = await browser.newPage({ viewport, colorScheme: scheme });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(`http://127.0.0.1:${port}/?turns`);
    await page.waitForLoadState("networkidle");
    if (scheme === "dark")
      await page.evaluate(() => document.documentElement.classList.add("dark"));
    const conversation = page.getByLabel("Coordinator conversation");
    await conversation.waitFor();
    // Two separators: yesterday's turn and today's.
    const separators = await conversation.locator(".sws-turn-separator").allInnerTexts();
    NodeAssert.equal(separators.length, 2, `separators: ${separators}`);
    NodeAssert.doesNotMatch(separators[0], /^Today /);
    NodeAssert.match(separators[1], /^Today /);
    const summaries = await conversation.locator(".sws-turn-summary").allInnerTexts();
    NodeAssert.deepEqual(summaries, ["Worked for 41s", "Worked for 14s"]);
    // The answer is prose with no visible author label and no bubble.
    const answer = conversation.locator(".project-message-assistant").last();
    NodeAssert.equal(
      await answer.locator("h3").evaluate((h) => h.getBoundingClientRect().width),
      1,
    );
    NodeAssert.equal(
      await answer.evaluate((el) => getComputedStyle(el).backgroundColor),
      "rgba(0, 0, 0, 0)",
    );
    NodeAssert.equal(await answer.locator("strong").innerText(), "11:52 PM EDT");
    // The latest answer keeps its actions visible.
    NodeAssert.equal(
      await answer.locator(".sws-turn-actions").evaluate((el) => getComputedStyle(el).opacity),
      "1",
    );
    NodeAssert.ok(await answer.getByRole("button", { name: "Copy message" }).isVisible());
    NodeAssert.deepEqual(errors, []);
    await conversation.screenshot({
      path: `${output}/coordinator-turns-${name}.png`,
      animations: "disabled",
    });
    await page.screenshot({
      path: `${output}/coordinator-turns-${name}-page.png`,
      animations: "disabled",
    });
    await page.close();
  }
  console.log(`ok: ${output}`);
} finally {
  await browser.close();
}
