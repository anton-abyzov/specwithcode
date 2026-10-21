/* The project's Routines tab with a busy code project's routines (`?routines=coordinator`),
   an empty one (`?routines=none`) and a personal assistant's (`?personal&routines`),
   at 1440 px, 900 px and 390 px, light and dark. Rows must stay compact, actions must
   be real buttons lined up on the row, dates short and local, and nothing may spill.
   `ROUTINES_MEASURE_ONLY=1` saves screenshots and measurements without asserting,
   for a before capture. Everything here is synthetic; no real routine runs. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright"
);
const output = process.env.UI_EVIDENCE_DIR ?? "/tmp/studio-routines-layout";
const measureOnly = process.env.ROUTINES_MEASURE_ONLY === "1";
const prefix = process.env.ROUTINES_PREFIX ?? (measureOnly ? "before" : "after");
await fs.mkdir(output, { recursive: true });
const origin = `http://127.0.0.1:${process.env.PROJECT_UI_PORT ?? 5788}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
    : {}),
});
const shot = (target, name) =>
  target.screenshot({ path: path.join(output, `${prefix}-${name}.png`) });
const check = (fn) => {
  if (!measureOnly) fn();
};
const measurements = {};
const errors = [];

async function openPane(page, search) {
  await page.goto(`${origin}/?${search}`);
  await page.locator("#root *").first().waitFor({ timeout: 90_000 });
  await page.waitForTimeout(500);
  const overview = page.getByRole("button", { name: /^Overview/ });
  if ((page.viewportSize()?.width ?? 1440) < 700 && (await overview.count())) {
    await overview.click();
  }
  await page.getByRole("tab", { name: /Routines|Scheduled/ }).click();
  const pane = page.locator("#sws-pane-scheduled");
  await pane.waitFor();
  return pane;
}

async function measure(page, pane) {
  return pane.evaluate((root) => {
    const rows = [...root.querySelectorAll("li.sws-routine, article")];
    return {
      overflow: document.documentElement.scrollWidth > window.innerWidth,
      rows: rows.map((row) => {
        const box = row.getBoundingClientRect();
        const buttons = [...row.querySelectorAll("button")].filter((b) =>
          /^(Run now|Pause|Enable)$/.test(b.textContent?.trim() ?? ""),
        );
        return {
          title: row.querySelector("h3")?.textContent ?? "",
          height: Math.round(box.height),
          right: Math.round(box.right),
          text: row.innerText,
          hasError: row.querySelector(".sws-routine-error") !== null,
          buttons: buttons.map((b) => {
            const r = b.getBoundingClientRect();
            const s = getComputedStyle(b);
            return {
              label: b.textContent?.trim(),
              top: Math.round(r.top),
              height: Math.round(r.height),
              right: Math.round(r.right),
              border: s.borderTopWidth,
              background: s.backgroundColor,
            };
          }),
        };
      }),
      paneRight: Math.round(root.getBoundingClientRect().right),
    };
  });
}

try {
  for (const [width, height] of [
    [1440, 1000],
    [900, 900],
    [390, 844],
  ]) {
    // The phone is a touch screen, so buttons take their touch size there.
    const phone = width < 600 ? { hasTouch: true, isMobile: true } : {};
    const page = await browser.newPage({ viewport: { width, height }, ...phone });
    page.on("pageerror", (e) => errors.push(`${width}: ${e.message}`));
    const pane = await openPane(page, "routines=coordinator");
    await pane.getByRole("heading", { name: "Error-rate repair watch" }).waitFor();
    const m = await measure(page, pane);
    measurements[`coordinator-${width}`] = m;
    await shot(page, `coordinator-${width}`);
    check(() => {
      assert.equal(m.overflow, false, `${width}: page scrolls sideways`);
      assert.equal(m.rows.length, 5);
      for (const row of m.rows) {
        assert(row.right <= m.paneRight + 1, `${row.title} spills out of the pane`);
        // A title line, a meta line and the button row (about 175 px before); a long
        // name may wrap twice more, and a phone row adds taller touch buttons.
        const limit =
          (width < 600 ? 130 : 100) + (row.title.length > 60 ? 40 : 0) + (row.hasError ? 24 : 0);
        assert(row.height <= limit, `${width}: "${row.title}" is ${row.height}px tall`);
        assert.doesNotMatch(row.text, /\d+\/\d+\/\d{4}/, "numeric date");
        assert.doesNotMatch(row.text, /Goes to the coordinator/);
        // Every action is a bordered button, all on one line.
        const tops = new Set(row.buttons.map((b) => b.top));
        assert.equal(tops.size, 1, `${row.title}: actions are not aligned`);
        for (const b of row.buttons) {
          assert.notEqual(b.border, "0px", `${b.label} has no border`);
          assert(b.height >= (width < 600 ? 40 : 28), `${b.label} is ${b.height}px tall`);
        }
      }
      const watch = m.rows[0];
      assert.match(watch.text, /Active/);
      assert.match(watch.text, /Next Today \d{1,2}:\d{2}\s?[AP]M/);
      // Every routine here goes to the coordinator, so no row repeats it.
      for (const row of m.rows) assert.doesNotMatch(row.text, /Coordinator/);
      assert.deepEqual(
        watch.buttons.map((b) => b.label),
        ["Run now", "Pause"],
      );
      const paused = m.rows[1];
      assert.match(paused.text, /Paused/);
      assert.doesNotMatch(paused.text, /Next/);
      assert.match(m.rows[2].text, /could not reach the store listing/);
      assert.match(m.rows[4].text, /On request/);
      assert.deepEqual(
        m.rows[4].buttons.map((b) => b.label),
        ["Run now"],
      );
    });
    if (width === 1440) {
      const header = pane.locator(".sws-routines-head, .project-section-title").first();
      check(() => undefined);
      measurements.header = await header.innerText();
      if (!measureOnly) {
        assert.match(measurements.header, /Routines/);
        assert.match(measurements.header, /1 active · 3 paused · 1 on request/);
        // Actions send for the routine they sit on, and only once.
        const row = pane.locator("li.sws-routine").filter({ hasText: "Error-rate repair watch" });
        await row.getByRole("button", { name: "Pause" }).click();
        await row.getByRole("button", { name: "Run now" }).click();
        const calls = await page.evaluate(() =>
          window.__projectCalls.filter((c) => /^routine/.test(c.command)),
        );
        assert.deepEqual(
          calls.map((c) => [c.command, c.args.input.id, c.args.input.enabled]),
          [
            ["routineToggle", "routine-repair-watch", false],
            ["routineRun", "routine-repair-watch", undefined],
          ],
        );
        measurements.calls = calls;
        // Keyboard: actions take focus with a visible ring.
        await row.getByRole("button", { name: "Run now" }).focus();
        await page.keyboard.press("Tab");
        const ring = await page.evaluate(
          () => getComputedStyle(document.activeElement).outlineStyle,
        );
        assert.notEqual(ring, "none");
      }
      await page.evaluate(() => document.documentElement.classList.add("dark"));
      await shot(page, "coordinator-1440-dark");
      await page.evaluate(() => document.documentElement.classList.remove("dark"));
    }
    if (width === 390) {
      await page.evaluate(() => document.documentElement.classList.add("dark"));
      await shot(page, "coordinator-390-dark");
    }
    await page.close();
  }

  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", (e) => errors.push(`empty: ${e.message}`));
  let pane = await openPane(page, "routines=none");
  await pane.getByRole("heading", { name: "Routines" }).waitFor();
  measurements.empty = await pane.innerText();
  await shot(page, "empty-1440");
  check(() => {
    assert.match(measurements.empty, /No routines yet/);
  });
  if (!measureOnly) {
    const create = pane.getByRole("link", { name: /New routine/ });
    assert.equal(await create.count(), 1);
    assert.match((await create.getAttribute("href")) ?? "", /scheduled-tasks/);
  }
  pane = await openPane(page, "personal&routines");
  await pane.getByRole("heading", { name: "Monthly tax prep" }).waitFor();
  measurements.personal = await measure(page, pane);
  await shot(page, "personal-1440");
  await page.close();
  check(() => assert.deepEqual(errors, []));
  await fs.writeFile(
    path.join(output, `${prefix}-routines-layout.json`),
    JSON.stringify({ measureOnly, measurements, errors }, null, 2),
  );
  console.log(
    `Routines layout ${measureOnly ? "measured" : "checks passed"}; evidence in ${output}`,
  );
} finally {
  await browser.close();
}
