// Run against serve.mjs. All operations target its isolated in-memory fixtures.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
import assert from "node:assert/strict";
import fs from "node:fs/promises";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const output = process.env.UI_EVIDENCE_DIR ?? "/tmp/0888-ui-repair-evidence";
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE }
    : {}),
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1:5788");
  await page.waitForLoadState("networkidle");
  await page.screenshot({
    path: `${output}/0888-project-desktop.png`,
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: /^Open thread Review the landing page, / }).click();
  assert(await page.getByLabel("Project coordinator", { exact: true }).isVisible());
  await page.getByLabel("Worker reply").fill("Continue the selected review");
  await page.getByRole("button", { name: "Send worker reply", exact: true }).click();
  const calls = await page.evaluate(() => window.__projectCalls);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.input.sourceThreadId, "review");
  assert.equal(calls[0].args.input.prompt, "Continue the selected review");
  assert.equal(calls[0].args.environmentId, "host");
  await page.getByLabel("Close thread pane").click();
  await page.getByLabel("Project settings", { exact: true }).click();
  await page.getByRole("dialog").waitFor();
  await page.screenshot({
    path: `${output}/0888-project-settings.png`,
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Memory", exact: true }).click();
  await page.getByRole("button", { name: /MEMORY\.md.*128 bytes/ }).click();
  await page.getByLabel("Content of MEMORY.md").fill("Keep this unsaved decision");
  await page.getByRole("button", { name: "General", exact: true }).click();
  await page.getByRole("button", { name: "Memory", exact: true }).click();
  assert.equal(
    await page.getByLabel("Content of MEMORY.md").inputValue(),
    "Keep this unsaved decision",
  );
  await page.screenshot({
    path: `${output}/0888-project-memory.png`,
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Discard edit", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Usage", exact: true }).click();
  assert(await page.getByText(/Incomplete usage:/).isVisible());
  assert((await page.getByRole("dialog").innerText()).includes("Not reported"));
  await page.screenshot({
    path: `${output}/0888-project-usage.png`,
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("dialog").getByRole("button", { name: "Routines", exact: true }).click();
  assert(await page.getByRole("heading", { name: "Daily project review" }).isVisible());
  assert.equal(await page.getByText("Foreign routine").count(), 0);
  await page.getByRole("button", { name: "Run now", exact: true }).click();
  const firstRun = (await page.evaluate(() => window.__projectCalls)).find(
    (c) => c.command === "routineRun",
  );
  assert(firstRun.args.input.commandId);
  await page.getByRole("button", { name: "Run now", exact: true }).click();
  const runs = (await page.evaluate(() => window.__projectCalls)).filter(
    (c) => c.command === "routineRun",
  );
  assert.equal(runs.length, 2);
  assert.notEqual(runs[0].args.input.commandId, runs[1].args.input.commandId);
  await page.screenshot({
    path: `${output}/0888-project-routines.png`,
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("dialog").getByRole("button", { name: "General", exact: true }).click();
  const deletion = page.getByRole("button", { name: "Delete project and threads" });
  assert(await deletion.isDisabled());
  await page.getByLabel("Confirm project deletion").fill("atlas studio");
  assert(await deletion.isDisabled());
  await page.getByLabel("Confirm project deletion").fill("Atlas Studio");
  assert(await deletion.isEnabled());
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await page.screenshot({
    path: `${output}/0888-project-dark.png`,
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
  await page.screenshot({
    path: `${output}/0888-project-mobile.png`,
    fullPage: true,
    animations: "disabled",
  });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.getByRole("button", { name: /^Open thread Review the landing page, / }).click();
  assert(!(await page.getByLabel("Project coordinator", { exact: true }).isVisible()));
  assert(await page.getByLabel("Worker reply").isVisible());
  await page.screenshot({
    path: `${output}/0888-project-mobile-worker.png`,
    fullPage: true,
    animations: "disabled",
  });
  await page.getByLabel("Close thread pane").click();
  await page.getByLabel("Project settings", { exact: true }).click();
  await page.screenshot({
    path: `${output}/0888-project-mobile-settings.png`,
    fullPage: true,
    animations: "disabled",
  });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  const dialogRect = await page.getByRole("dialog").boundingBox();
  assert(dialogRect.x >= 15);
  assert(dialogRect.x + dialogRect.width <= 376);
  await page.goto("http://127.0.0.1:5788/?legacy-delete");
  await page.getByRole("button", { name: "Open legacy deletion" }).click();
  const legacyButton = page.getByRole("button", {
    name: "Delete project and threads",
    exact: true,
  });
  assert(await legacyButton.isDisabled());
  await page.getByLabel("Confirm project deletion").fill("atlas studio");
  assert(await legacyButton.isDisabled());
  await page.getByLabel("Confirm project deletion").fill("Atlas Studio");
  assert(await legacyButton.isEnabled());
  await page.screenshot({
    path: `${output}/0888-project-legacy-delete.png`,
    fullPage: true,
    animations: "disabled",
  });
  await legacyButton.click();
  assert.equal(await page.evaluate(() => window.__deletionReceipt), "Atlas Studio");
  assert.deepEqual(errors, []);
  await fs.writeFile(
    `${output}/0888-ui-browser-evidence.json`,
    JSON.stringify(
      {
        scope: "Isolated UI fixture; native provider and thread surface mocked",
        viewports: ["1440x1000", "390x844"],
        checks: [
          "link opens scoped worker",
          "coordinator remains visible on desktop",
          "worker reply exact sourceThreadId",
          "memory draft survives tabs",
          "usage incomplete categories",
          "routines project scope",
          "typed workspace and legacy delete confirmation",
          "routine new IDs after acknowledged runs",
          "dark theme",
          "mobile panel and no horizontal overflow",
        ],
        calls,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    `Headless UI scenarios passed; fixture scope recorded in ${output}/0888-ui-browser-evidence.json`,
  );
} finally {
  await browser.close();
}
