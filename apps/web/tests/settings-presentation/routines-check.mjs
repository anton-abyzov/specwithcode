/* Settings > Routines rows (`?routines`) at 1280 px, 760 px and 390 px, light and dark.
   Each row must lead with its title and state, give the next run as a short local date,
   name its project and destination, keep the prompt to one line and offer Run without
   opening a menu. `ROUTINES_MEASURE_ONLY=1` saves screenshots only, for a before capture.
   The host is synthetic; actions are recorded, never run. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright"
);
const output = process.env.UI_EVIDENCE_DIR ?? "/tmp/studio-routines-manager";
const measureOnly = process.env.ROUTINES_MEASURE_ONLY === "1";
const prefix = process.env.ROUTINES_PREFIX ?? (measureOnly ? "before" : "after");
await fs.mkdir(output, { recursive: true });
const origin = `http://127.0.0.1:${process.env.PROJECT_UI_PORT ?? 5796}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
    : {}),
});
const errors = [];
const measurements = {};
try {
  for (const [width, height] of [
    [1280, 1000],
    [760, 1000],
    [390, 1200],
  ]) {
    const page = await browser.newPage({ viewport: { width, height } });
    page.on("pageerror", (e) => errors.push(`${width}: ${e.message}`));
    await page.goto(`${origin}/?routines`);
    await page.getByText("Error-rate repair watch").first().waitFor({ timeout: 90_000 });
    const rows = await page.locator("[data-slot='settings-row']").evaluateAll((list) =>
      list.map((row) => ({
        text: row.innerText,
        height: Math.round(row.getBoundingClientRect().height),
      })),
    );
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    measurements[width] = { rows, overflow };
    await page.screenshot({
      path: path.join(output, `${prefix}-manager-${width}.png`),
      fullPage: true,
    });
    if (width !== 760) {
      await page.evaluate(() => document.documentElement.classList.add("dark"));
      await page.screenshot({
        path: path.join(output, `${prefix}-manager-${width}-dark.png`),
        fullPage: true,
      });
      await page.evaluate(() => document.documentElement.classList.remove("dark"));
    }
    if (!measureOnly) {
      assert.equal(overflow, false, `${width}: page scrolls sideways`);
      assert.equal(rows.length, 6);
      const [watch, results, release, clips, campaign, hook] = rows.map((row) => row.text);
      assert.match(watch, /Active/);
      assert.match(watch, /Every 30 min/);
      assert.match(watch, /Next Today \d{1,2}:\d{2}\s?[AP]M \S+ \(in \dh\)/);
      assert.match(watch, /Atlas Studio/);
      assert.doesNotMatch(watch, /Coordinator/);
      assert.match(campaign, /Its own thread/);
      assert.match(results, /Paused/);
      assert.doesNotMatch(results, /Next/);
      assert.match(release, /could not reach the store listing/);
      assert.match(clips, /Monthly on the 1st at 08:00/);
      assert.match(campaign, /On request/);
      assert.match(hook, /Listening/);
      assert.match(hook, /Beacon/);
      for (const row of rows) assert.doesNotMatch(row.text, /\b(failed|succeeded|never)\b/);
      if (width === 1280) {
        // A long name may take a second line; nothing else does.
        for (const row of rows) {
          const limit = row.text.length > 260 ? 140 : 110;
          assert(row.height <= limit, `row is ${row.height}px tall`);
        }
        // Run is one click; the title opens the editor.
        const first = page.locator("[data-slot='settings-row']").first();
        await first.getByRole("button", { name: "Run Error-rate repair watch now" }).click();
        await first.getByRole("button", { name: "Error-rate repair watch", exact: true }).click();
        const calls = await page.evaluate(() => window.__projectCalls);
        assert.deepEqual(
          calls.map((c) => [String(c.command), c.args.input.id]),
          [["routineRun", "routine-repair-watch"]],
        );
        assert.equal(
          await page.evaluate(() => document.body.dataset.edited),
          "routine-repair-watch",
        );
        // A webhook routine has no Run button: requests run it.
        const hookRow = page.locator("[data-slot='settings-row']").last();
        assert.equal(await hookRow.getByRole("button", { name: /^Run / }).count(), 0);
      }
    }
    await page.close();
  }
  // The same routines inside Project settings > Routines.
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.on("pageerror", (e) => errors.push(`settings ${width}: ${e.message}`));
    await page.goto(`${origin}/?tab=routines&routines=coordinator`);
    await page.locator(".sws-routines").first().waitFor({ timeout: 90_000 });
    await page.screenshot({ path: path.join(output, `${prefix}-project-settings-${width}.png`) });
    if (!measureOnly) {
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
        false,
      );
    }
    await page.close();
  }
  if (!measureOnly) assert.deepEqual(errors, []);
  await fs.writeFile(
    path.join(output, `${prefix}-manager.json`),
    JSON.stringify({ measureOnly, measurements, errors }, null, 2),
  );
  console.log(
    `Routines manager ${measureOnly ? "measured" : "checks passed"}; evidence in ${output}`,
  );
} finally {
  await browser.close();
}
