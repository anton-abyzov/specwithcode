import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const output = process.env.UI_EVIDENCE_DIR ?? "/tmp/swc-blocked-attention-evidence";
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const receipts = [];
try {
  for (const width of [1440, 600]) {
    const page = await browser.newPage({ viewport: { width, height: 1100 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${process.env.PROJECT_UI_PORT ?? 5799}/?attention`);
    await page.getByRole("button", { name: "operational", exact: true }).click();
    if (width < 768) await page.getByRole("button", { name: /^Overview,/ }).click();
    // This fixture declares report blockers on all six roots. Even with a
    // finished/failed runtime, every visible Blocked row must request attention.
    const waiting = page.locator('[data-group="Waiting on you"]');
    const idle = page.locator('[data-group="Idle"]');
    await waiting.locator(".sws-thread-row").first().waitFor();
    assert.equal(await waiting.locator(".sws-thread-row").count(), 5);
    assert.equal(await idle.locator(".sws-thread-row").count(), 0);
    assert.equal(
      await page
        .locator('[aria-label="Project sidebar"] .sws-count > [aria-hidden="true"]')
        .textContent(),
      "6",
    );
    assert.match(await page.locator(".sws-threads-head").textContent(), /6 waiting on you/);
    await page.getByRole("button", { name: "baseline", exact: true }).click();
    await page.waitForFunction(
      () => document.querySelectorAll('[data-group="Waiting on you"] .sws-thread-row').length === 0,
    );
    assert.equal(await page.locator('[aria-label="Project sidebar"] .sws-count').count(), 0);
    await page.getByRole("button", { name: "operational", exact: true }).click();
    await waiting.locator(".sws-thread-row").first().waitFor();
    for (const theme of ["light", "dark"]) {
      await page.evaluate(
        (dark) => document.documentElement.classList.toggle("dark", dark),
        theme === "dark",
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      await page.screenshot({
        path: path.join(output, `blocked-${width}-${theme}.png`),
        fullPage: true,
      });
      receipts.push({ width, theme, waitingRows: 5, idleRows: 0, attention: 6 });
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
  await fs.writeFile(path.join(output, "receipt.json"), JSON.stringify(receipts, null, 2));
  console.log(JSON.stringify(receipts));
} finally {
  await browser.close();
}
