/* Each routine names its own thread (`?routines=coordinator`): in the project's Routines
   pane and in Project settings > Routines, a routine that has run offers "Open thread",
   one that has not says "Own thread" (its first run starts it), and one set up from a worker opens
   that worker's thread. None says it goes to the coordinator. Opening a thread from
   Project settings closes the dialog and shows that thread. At 1440 px and 390 px, light and
   dark. The host is synthetic; no routine runs. */
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE
    ? NodeURL.pathToFileURL(process.env.PLAYWRIGHT_MODULE).href
    : "playwright"
);
const output = process.env.UI_EVIDENCE_DIR ?? "/tmp/studio-routine-threads";
await NodeFSP.mkdir(output, { recursive: true });
const origin = `http://127.0.0.1:${process.env.PROJECT_UI_PORT ?? 5788}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
    : {}),
});
const errors = [];
const shot = (page, name) => page.screenshot({ path: NodePath.join(output, `${name}.png`) });
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
const EXPECTED = {
  "Error-rate repair watch": { action: "Open thread", thread: "idle" },
  "Final matchday results": { text: "Own thread" },
  "Watch the mobile club release": { action: "Open thread", thread: "skills" },
  "Finish the approved analytics campaign": { action: "Open thread", thread: "idle" },
};
async function checkRows(scope, label) {
  const rows = await scope.locator("li.sws-routine").evaluateAll((list) =>
    list.map((row) => ({
      title: row.querySelector("h3")?.textContent ?? "",
      meta: row.querySelector(".sws-routine-meta")?.textContent ?? "",
      actionsTop: [...row.querySelectorAll(".sws-routine-actions button")].map((b) =>
        Math.round(b.getBoundingClientRect().top),
      ),
      link: row.querySelector("[data-routine-thread]")?.getAttribute("data-routine-thread") ?? null,
      linkText: row.querySelector("[data-routine-thread]")?.getAttribute("aria-label") ?? null,
    })),
  );
  NodeAssert.equal(rows.length, 5, `${label}: five routines`);
  for (const row of rows) {
    NodeAssert.equal(new Set(row.actionsTop).size, 1, `${label}: ${row.title} actions wrap`);
    NodeAssert.doesNotMatch(
      row.meta,
      /Coordinator/,
      `${label}: ${row.title} names the coordinator`,
    );
    NodeAssert.ok(
      row.link !== null || /Own thread/.test(row.meta),
      `${label}: ${row.title} names no thread`,
    );
    const expected = EXPECTED[row.title];
    if (expected?.action) {
      NodeAssert.equal(row.linkText, expected.action, `${label}: ${row.title}`);
      NodeAssert.equal(row.link, expected.thread, `${label}: ${row.title} thread`);
    } else if (expected?.text) {
      NodeAssert.match(row.meta, new RegExp(expected.text), `${label}: ${row.title}`);
      NodeAssert.equal(row.link, null);
    }
  }
  return rows;
}
const receipt = {};
try {
  for (const [width, height] of [
    [1440, 1000],
    [390, 900],
  ]) {
    // The project's Routines pane.
    const page = await browser.newPage({ viewport: { width, height } });
    page.on("pageerror", (e) => errors.push(`pane ${width}: ${e.message}`));
    await page.goto(`${origin}/?routines=coordinator`);
    await page.locator("#root *").first().waitFor({ timeout: 90_000 });
    await page.waitForTimeout(500);
    const overview = page.getByRole("button", { name: /^Overview/ });
    if (width < 700 && (await overview.count())) await overview.click();
    await page.getByRole("tab", { name: /Routines|Scheduled/ }).click();
    const pane = page.locator("#sws-pane-scheduled");
    await pane.locator("li.sws-routine").first().waitFor();
    receipt[`pane-${width}`] = await checkRows(pane, `pane ${width}`);
    await shot(page, `pane-${width}`);
    await setDark(page, true);
    await shot(page, `pane-${width}-dark`);
    await setDark(page, false);
    await pane
      .locator("li.sws-routine", { hasText: "Watch the mobile club release" })
      .getByRole("button", { name: "Open thread" })
      .click();
    await page.getByLabel("Close thread pane").waitFor();
    NodeAssert.ok(
      await page.getByRole("heading", { name: "Consolidate the skills" }).isVisible(),
      `pane ${width}: the worker's thread opened`,
    );
    await shot(page, `pane-${width}-opened`);
    await page.close();

    // Project settings > Routines: opening a thread closes the dialog and shows the thread.
    const settings = await browser.newPage({ viewport: { width, height } });
    settings.on("pageerror", (e) => errors.push(`settings ${width}: ${e.message}`));
    await settings.goto(`${origin}/?routines=coordinator`);
    await settings.locator("#root *").first().waitFor({ timeout: 90_000 });
    await settings.getByLabel("Project settings", { exact: true }).click();
    const dialog = settings.getByRole("dialog");
    await dialog.getByRole("button", { name: "Routines", exact: true }).click();
    await dialog.locator("li.sws-routine").first().waitFor();
    receipt[`settings-${width}`] = await checkRows(dialog, `settings ${width}`);
    await shot(settings, `settings-${width}`);
    await setDark(settings, true);
    await shot(settings, `settings-${width}-dark`);
    await setDark(settings, false);
    await dialog
      .locator("li.sws-routine", { hasText: "Error-rate repair watch" })
      .getByRole("button", { name: "Open thread" })
      .click();
    await dialog.waitFor({ state: "hidden" });
    await settings.getByLabel("Close thread pane").waitFor();
    NodeAssert.ok(
      await settings.getByRole("heading", { name: "Polish onboarding" }).isVisible(),
      `settings ${width}: the routine's thread opened`,
    );
    await shot(settings, `settings-${width}-opened`);
    await settings.close();
  }
  NodeAssert.deepEqual(errors, []);
  await NodeFSP.writeFile(
    NodePath.join(output, "receipt.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  console.log(`Routine thread checks passed; evidence in ${output}`);
} finally {
  await browser.close();
}
