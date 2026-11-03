// Headless check of the Threads pane for the November 2 report: a delegated
// worker whose turn ended with live background commands, and a remote worker
// read that has not answered. Run with the fixture served (serve.mjs);
// PWDEBUG=0, PLAYWRIGHT_HTML_OPEN=never. UI_EXPECT=before only captures.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const output = process.env.UI_EVIDENCE_DIR ?? "/tmp/swc-background-work-evidence";
const name = process.env.UI_SHOT_NAME ?? "after";
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
    : {}),
});
const rowsIn = (page, group) =>
  page
    .locator(`[data-group="${group}"] .sws-thread-row`)
    .evaluateAll((rows) => rows.map((row) => row.textContent.replace(/\s+/g, " ").trim()));
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(120_000);
  page.setDefaultNavigationTimeout(240_000);
  await page.goto(`http://127.0.0.1:${process.env.PROJECT_UI_PORT ?? 5799}/?attention`);
  await page
    .getByRole("button", { name: "background-work", exact: true })
    .evaluate((button) => button.click());
  await page.locator('[data-group="Idle"] .sws-thread-row').first().waitFor();
  const receipt = {
    summary: (await page.locator(".sws-threads-head [role=status]").textContent()) ?? "",
    waiting: await rowsIn(page, "Waiting"),
    idle: await rowsIn(page, "Idle"),
    tone: await page
      .locator('.sws-thread-row:has-text("Tournament chat video") .sws-dot')
      .first()
      .getAttribute("data-tone")
      .catch(() => null),
  };
  await page.screenshot({ path: path.join(output, `${name}.png`) });
  await fs.writeFile(path.join(output, `${name}.json`), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
  if (process.env.UI_EXPECT !== "before") {
    assert.ok(receipt.waiting.some((row) => row.includes("Tournament chat video")));
    assert.ok(receipt.waiting.some((row) => row.includes("Background command running")));
    assert.ok(!receipt.idle.some((row) => row.includes("Tournament chat video")));
    assert.ok(receipt.summary.includes("Some threads could not be read"), receipt.summary);
  }
} finally {
  await browser.close();
}
