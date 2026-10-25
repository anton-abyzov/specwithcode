/* Settings > Routines rows (`?routines`) at 1280 px, 760 px and 390 px, light and dark.
   Each row must lead with its title and state, give the next run as a short local date,
   name its project and destination, keep the prompt to one line and offer Run without
   opening a menu. `ROUTINES_MEASURE_ONLY=1` saves screenshots only, for a before capture.
   The host is synthetic; actions are recorded, never run. */
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE
    ? NodeURL.pathToFileURL(process.env.PLAYWRIGHT_MODULE).href
    : "playwright"
);
const output = process.env.UI_EVIDENCE_DIR ?? "/tmp/studio-routines-manager";
const measureOnly = process.env.ROUTINES_MEASURE_ONLY === "1";
const prefix = process.env.ROUTINES_PREFIX ?? (measureOnly ? "before" : "after");
await NodeFSP.mkdir(output, { recursive: true });
const origin = `http://127.0.0.1:${process.env.PROJECT_UI_PORT ?? 5796}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
    : {}),
});
const errors = [];
const measurements = {};
// Switch the theme the way the app does: `no-transitions` first, so a dark capture never lands
// mid-transition, and the page background recomputed (useTheme's syncBrowserChromeTheme
// pins the startup color inline on <html> and <body>, which would keep a light page).
async function setDark(page, on) {
  await page.evaluate((dark) => {
    const root = document.documentElement;
    root.classList.add("no-transitions");
    root.classList.toggle("dark", dark);
    root.style.backgroundColor = "";
    document.body.style.backgroundColor = "";
    void root.offsetHeight;
  }, on);
  await page.waitForTimeout(100);
}
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
      path: NodePath.join(output, `${prefix}-manager-${width}.png`),
      fullPage: true,
    });
    if (width !== 760) {
      await setDark(page, true);
      await page.screenshot({
        path: NodePath.join(output, `${prefix}-manager-${width}-dark.png`),
        fullPage: true,
      });
      await setDark(page, false);
    }
    if (!measureOnly) {
      NodeAssert.equal(overflow, false, `${width}: page scrolls sideways`);
      NodeAssert.equal(rows.length, 6);
      const [watch, results, release, clips, campaign, hook] = rows.map((row) => row.text);
      NodeAssert.match(watch, /Active/);
      NodeAssert.match(watch, /Every 30 min/);
      NodeAssert.match(watch, /Next Today \d{1,2}:\d{2}\s?[AP]M \S+ \(in \dh\)/);
      NodeAssert.match(watch, /Atlas Studio/);
      NodeAssert.doesNotMatch(watch, /Coordinator/);
      NodeAssert.match(campaign, /Its own thread/);
      // Every routine names its thread; a started one links to it.
      NodeAssert.match(watch, /Its own thread/);
      NodeAssert.match(results, /Own thread\b/);
      NodeAssert.match(release, /Continues a worker's thread/);
      NodeAssert.match(hook, /Own thread\b/);
      for (const row of rows) NodeAssert.doesNotMatch(row.text, /Coordinator/);
      const links = await page
        .locator("[data-slot='settings-row'] a[data-routine-thread]")
        .evaluateAll((list) => list.map((a) => [a.textContent, new URL(a.href).pathname]));
      NodeAssert.deepEqual(
        links.map(([text, path]) => [text, path.split("/").at(-1)]),
        [
          ["Its own thread", "idle"],
          ["Continues a worker's thread", "skills"],
          ["Its own thread", "idle"],
        ],
      );
      NodeAssert.match(results, /Paused/);
      NodeAssert.doesNotMatch(results, /Next/);
      NodeAssert.match(release, /could not reach the store listing/);
      NodeAssert.match(clips, /Monthly on the 1st at 08:00/);
      NodeAssert.match(campaign, /On request/);
      NodeAssert.match(hook, /Listening/);
      NodeAssert.match(hook, /Beacon/);
      for (const row of rows) NodeAssert.doesNotMatch(row.text, /\b(failed|succeeded|never)\b/);
      if (width === 1280) {
        // A long name may take a second line; nothing else does.
        for (const row of rows) {
          const limit = row.text.length > 260 ? 140 : 110;
          NodeAssert.ok(row.height <= limit, `row is ${row.height}px tall`);
        }
        // Run is one click; the title opens the editor.
        const first = page.locator("[data-slot='settings-row']").first();
        await first.getByRole("button", { name: "Run Error-rate repair watch now" }).click();
        await first.getByRole("button", { name: "Error-rate repair watch", exact: true }).click();
        const calls = await page.evaluate(() => window.__projectCalls);
        NodeAssert.deepEqual(
          calls.map((c) => [String(c.command), c.args.input.id]),
          [["routineRun", "routine-repair-watch"]],
        );
        NodeAssert.equal(
          await page.evaluate(() => document.body.dataset.edited),
          "routine-repair-watch",
        );
        // A webhook routine has no Run button: requests run it.
        const hookRow = page.locator("[data-slot='settings-row']").last();
        NodeAssert.equal(await hookRow.getByRole("button", { name: /^Run / }).count(), 0);
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
    await page.screenshot({
      path: NodePath.join(output, `${prefix}-project-settings-${width}.png`),
    });
    const settingsRows = await page.locator("li.sws-routine").evaluateAll((list) =>
      list.map((row) => ({
        title: row.querySelector("h3")?.textContent ?? "",
        height: Math.round(row.getBoundingClientRect().height),
        plain: !row.querySelector(".sws-routine-brief") && !row.querySelector(".sws-routine-error"),
      })),
    );
    measurements[`project-settings-${width}`] = settingsRows;
    if (!measureOnly && width === 1280) {
      // The dialog is wide enough for two columns: actions sit on the right, so a row with a
      // one-line title, no brief and no error is at most 84 px.
      const plain = settingsRows.filter((row) => row.plain && row.title.length <= 60);
      NodeAssert.ok(plain.length >= 3, "too few plain rows to measure");
      for (const row of plain) {
        NodeAssert.ok(row.height <= 84, `settings: "${row.title}" is ${row.height}px tall`);
      }
    }
    if (!measureOnly) {
      NodeAssert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
        false,
      );
    }
    await page.close();
  }
  if (!measureOnly) NodeAssert.deepEqual(errors, []);
  await NodeFSP.writeFile(
    NodePath.join(output, `${prefix}-manager.json`),
    JSON.stringify({ measureOnly, measurements, errors }, null, 2),
  );
  console.log(
    `Routines manager ${measureOnly ? "measured" : "checks passed"}; evidence in ${output}`,
  );
} finally {
  await browser.close();
}
