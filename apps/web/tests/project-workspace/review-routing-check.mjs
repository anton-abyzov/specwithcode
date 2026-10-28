// Headless check of the Threads pane for the October 26 review-routing report:
// finished subagent reports stay with their parent agent, a failed run reads
// "Run failed" under Idle, and real requests still wait on the person.
// Run with the fixture served (serve.mjs); PWDEBUG=0, PLAYWRIGHT_HTML_OPEN=never.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const output = process.env.UI_EVIDENCE_DIR ?? "/tmp/swc-review-routing-evidence";
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
const receipts = [];
try {
  for (const width of [1440, 600]) {
    const page = await browser.newPage({ viewport: { width, height: 1100 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${process.env.PROJECT_UI_PORT ?? 5799}/?attention`);
    await page.getByRole("button", { name: "review-routing", exact: true }).click();
    if (width < 768) await page.getByRole("button", { name: /^Overview,/ }).click();
    await page.locator('[data-group="Idle"] .sws-thread-row').first().waitFor();
    const waiting = await rowsIn(page, "Waiting on you");
    const dependencies = await rowsIn(page, "Waiting");
    assert.equal(dependencies.length, 4, JSON.stringify(dependencies));
    for (const reason of [
      "Waiting for CI",
      "Waiting for review",
      "Waiting for PR merge",
      "Waiting for subagents",
    ])
      assert.ok(
        dependencies.some((row) => row.includes(reason)),
        reason,
      );
    assert.ok(dependencies.every((row) => !/Answer needed|Blocked/.test(row)));
    const working = await rowsIn(page, "Working");
    const idle = await rowsIn(page, "Idle");
    // Real requests: a subagent's pending approval and a worker's own report blocker.
    assert.equal(waiting.length, 2, JSON.stringify(waiting));
    assert.ok(waiting.some((row) => row.includes("Schedule Mac and mobile release")));
    assert.ok(waiting.some((row) => /Release 1\.0\.35.*Blocked/.test(row)));
    // A running parent of a finished subagent report is Working, not waiting.
    assert.equal(working.length, 1, JSON.stringify(working));
    assert.match(working[0], /Usage-aware model picker/);
    assert.doesNotMatch(working[0], /Answer needed|Close increment 1054/);
    // Quiet parents of finished child reports (native and delegate_task) and the
    // failed Muse run are Idle.
    assert.equal(idle.length, 3, JSON.stringify(idle));
    assert.ok(idle.some((row) => /1041 design create/.test(row) && !/Answer needed/.test(row)));
    assert.ok(idle.some((row) => /disk audit/.test(row) && !/Answer needed/.test(row)));
    const muse = idle.find((row) => row.includes("Muse approval check"));
    assert.match(muse, /Run failed/);
    assert.doesNotMatch(muse, /Needs review/);
    assert.equal(
      await page
        .locator('[aria-label="Project sidebar"] .sws-count > [aria-hidden="true"]')
        .textContent(),
      "2",
    );
    assert.match(await page.locator(".sws-threads-head").textContent(), /2 waiting on you/);
    for (const theme of ["light", "dark"]) {
      await page.evaluate(
        (dark) => document.documentElement.classList.toggle("dark", dark),
        theme === "dark",
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      const file = path.join(output, `review-routing-${width}-${theme}.png`);
      await page.screenshot({ path: file, fullPage: true });
      receipts.push({ width, theme, waiting, dependencies, working, idle, screenshot: file });
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
  await fs.writeFile(path.join(output, "receipt.json"), JSON.stringify(receipts, null, 2));
  console.log(JSON.stringify({ passed: true, checks: receipts.length }));
} finally {
  await browser.close();
}
