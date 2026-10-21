import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright"
);
const output = process.env.PROJECT_UI_OUTPUT ?? "/tmp/studio-project-ui";
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
    : {}),
});
const shot = (page, name) =>
  page.screenshot({ path: path.join(output, `0980-${name}.png`), fullPage: true });
const fitsWidth = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // A personal assistant for a fictional household, with two routines.
  await page.goto(`http://127.0.0.1:${process.env.PROJECT_UI_PORT ?? 5788}/?personal&routines`);
  await page.getByRole("tab", { name: /Routines/ }).waitFor({ timeout: 90_000 });
  await page.getByRole("tab", { name: /Routines/ }).click();
  const pane = page.locator("#sws-pane-scheduled");
  await pane.getByRole("heading", { name: "Monthly tax prep" }).waitFor();
  const cadences = await pane.locator("[data-routine-cadence]").allInnerTexts();
  assert.deepEqual(cadences, ["When you ask", "Monthly on the 3rd at 09:00"]);
  assert.equal(await pane.getByText("Foreign routine").count(), 0);
  const tax = pane.locator("li.sws-routine").filter({
    has: page.getByRole("heading", { name: "Monthly tax prep" }),
  });
  const taxText = await tax.first().innerText();
  assert.match(taxText, /~\/Example Household\/receipts/);
  assert.match(taxText, /~\/Example Household\/tax\/\{period\}-prep\.md/);
  // A routine run by hand has nothing to pause; a monthly one does.
  assert.equal(await tax.first().getByRole("button", { name: "Pause" }).count(), 0);
  assert.equal(await pane.getByRole("button", { name: "Pause" }).count(), 1);
  assert(await pane.getByText("Own thread from the first run").isVisible());
  await shot(page, "routines-desktop");

  // Run now sends one request for that routine.
  await tax.first().getByRole("button", { name: "Run now" }).click();
  let calls = await page.evaluate(() => window.__projectCalls);
  const runs = calls.filter((call) => call.command === "routineRun");
  assert.equal(runs.length, 1);
  assert.equal(runs[0].args.input.id, "routine-tax-prep");

  // A template opens a form; nothing is saved until Save.
  const templates = pane.locator("button.sws-routine-template");
  assert.deepEqual(
    (await templates.locator("strong").allInnerTexts()).map((title) => title.trim()),
    [
      "Monthly tax prep",
      "Monthly profit and loss",
      "Research brief",
      "Email triage and draft replies",
    ],
  );
  await templates.filter({ hasText: "Email triage and draft replies" }).click();
  const form = pane.getByRole("form", { name: "New routine: Email triage and draft replies" });
  await form.waitFor();
  assert(await form.getByLabel("When you ask (Run now)").isChecked());
  assert(await form.getByLabel(/Prepare and draft only/).isChecked());
  assert.match(await form.getByLabel("What it does").inputValue(), /do not send, archive/);
  calls = await page.evaluate(() => window.__projectCalls);
  assert.equal(calls.filter((call) => call.command === "routineSave").length, 0);
  await shot(page, "routines-template-form");
  await form.getByRole("button", { name: "Cancel" }).click();

  await templates.filter({ hasText: "Monthly tax prep" }).click();
  const taxForm = pane.getByRole("form", { name: "New routine: Monthly tax prep" });
  await taxForm.getByLabel("Receipts").fill("~/Example Household/receipts");
  await taxForm.getByRole("button", { name: "Save routine" }).click();
  await taxForm.waitFor({ state: "hidden" });
  calls = await page.evaluate(() => window.__projectCalls);
  const saves = calls.filter((call) => call.command === "routineSave");
  assert.equal(saves.length, 1);
  const saved = saves[0].args.input;
  assert.deepEqual(saved.schedule, { type: "manual" });
  assert.equal(saved.ownThread, true);
  assert.equal(saved.threadId, null);
  assert.deepEqual(saved.brief, {
    inputs: [{ label: "Receipts", location: "~/Example Household/receipts" }],
    output: "tax/{period}-prep.md",
    prepareOnly: true,
  });

  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await shot(page, "routines-dark");
  await page.evaluate(() => document.documentElement.classList.remove("dark"));

  // A phone shows one pane at a time: the routines sit behind Overview.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole("button", { name: /^Overview/ }).waitFor({ timeout: 90_000 });
  await page.getByRole("button", { name: /^Overview/ }).click();
  await page.getByRole("tab", { name: /Routines/ }).click();
  await pane.getByRole("heading", { name: "Monthly tax prep" }).waitFor();
  assert(await fitsWidth(page));
  await shot(page, "routines-mobile");
  await templates.filter({ hasText: "Monthly profit and loss" }).click();
  const pnlForm = pane.getByRole("form", { name: "New routine: Monthly profit and loss" });
  await pnlForm.getByLabel("Every month").check();
  assert.equal(await pnlForm.getByLabel("Day").inputValue(), "3");
  assert(await fitsWidth(page));
  const box = await pnlForm.boundingBox();
  assert(box.x >= 0 && box.x + box.width <= 390);
  for (const button of await templates.all()) {
    const rect = await button.boundingBox();
    if (rect) assert(rect.height >= 44);
  }
  await shot(page, "routines-mobile-form");
  assert.deepEqual(errors, []);

  await fs.writeFile(
    path.join(output, "0980-routines-evidence.json"),
    JSON.stringify(
      {
        scope:
          "Isolated UI fixture with a fictional household; host, provider and threads are mocked",
        viewports: ["1440x1000", "390x844"],
        checks: [
          "cadence in words for manual and monthly routines",
          "inputs and result shown on the card; only this project's routines",
          "no Pause for a routine run by hand",
          "Run now sends one request for that routine",
          "four templates; a template opens a form and saves nothing until Save",
          "template defaults: When you ask, prepare and draft only, own thread",
          "saved routine payload: manual schedule, ownThread, brief",
          "monthly choice uses the template's suggested day",
          "dark theme",
          "390 px: no horizontal overflow, 44 px template targets",
        ],
        calls: calls.filter((call) => /^routine/.test(call.command)),
        errors,
      },
      null,
      2,
    ),
  );
  console.log(`Routines headless checks passed; evidence saved in ${output}`);
} finally {
  await browser.close();
}
