// How much of a long thread name the header shows at each panel width. Headless.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const output = process.env.PROJECT_UI_OUTPUT ?? "/tmp/studio-thread-title-width";
const assertRoom = process.env.THREAD_TITLE_ASSERT === "1";
const longTitle =
  "October invoice for Precocity and Roc Search with approved timesheet screenshots";
// Below each panel width, the least a long name may show once the fix is in.
const widths = [
  [320, 60],
  [360, 90],
  [420, 120],
  [520, 150],
  [640, 200],
  [795, 300],
  [960, 380],
  [1200, 500],
];
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH,
});
try {
  const page = await browser.newPage({
    viewport: { width: 1700, height: 900 },
    deviceScaleFactor: 2,
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(
    `http://127.0.0.1:${process.env.PROJECT_UI_PORT ?? 5794}/?followups&routed&thread=review`,
  );
  const header = page.locator(".sws-thread-head");
  await header.waitFor();
  // The fixture's chat has no panel toggles; the real one portals three here.
  await page.evaluate((title) => {
    document.querySelector(".sws-thread-head-text h2").textContent = title;
    const tools = document.querySelector(".sws-thread-head-tools");
    for (const label of ["Toggle thread details", "Toggle terminal drawer", "Toggle right panel"]) {
      const button = document.createElement("button");
      button.className = "sws-icon-button";
      button.setAttribute("aria-label", label);
      button.textContent = "▢";
      tools.append(button);
    }
  }, longTitle);
  const results = [];
  for (const [width, least] of widths) {
    await page.addStyleTag({
      content: `.sws-thread-head { width: ${width}px !important; flex: none !important; }`,
    });
    await page.waitForTimeout(150);
    const measured = await page.evaluate(() => {
      const head = document.querySelector(".sws-thread-head");
      const h2 = head.querySelector("h2");
      const close = head.querySelector('[aria-label="Close thread pane"]');
      return {
        shown: Math.round(h2.getBoundingClientRect().width),
        full: h2.scrollWidth,
        chips: Math.round(
          head.querySelector(".sws-thread-head-chips").getBoundingClientRect().width,
        ),
        closeInside:
          close.getBoundingClientRect().right <= head.getBoundingClientRect().right + 0.5,
      };
    });
    results.push({ width, ...measured });
    await header.screenshot({ path: `${output}/header-${width}.png` });
    assert.ok(measured.closeInside, `Close leaves the header at ${width}px`);
    if (assertRoom) {
      assert.ok(
        measured.shown >= least,
        `${measured.shown}px of the name at ${width}px, wanted ${least}`,
      );
    }
  }
  if (assertRoom) {
    // Hover shows the whole name and nothing else; a double-click opens the rename field.
    const title = page.locator(".sws-thread-head-text h2");
    await title.hover();
    const tip = page.locator("[data-slot='tooltip-popup']");
    await tip.waitFor();
    assert.doesNotMatch(await tip.innerText(), /named by/);
    // Dispatched: real mouse and key presses hang in this fixture's headless shell, on main
    // too. ProjectThreadHeader.test.tsx covers Enter, Escape and blur.
    await title.dispatchEvent("dblclick");
    const field = page.getByLabel("Thread title", { exact: true });
    await field.waitFor();
    await header.screenshot({ path: `${output}/header-renaming.png` });
  }
  assert.deepEqual(errors, []);
  await fs.writeFile(
    `${output}/receipt.json`,
    JSON.stringify({ headless: true, results }, null, 2),
  );
  console.table(results);
} finally {
  await browser.close();
}
