import path from "node:path";
import { pathToFileURL } from "node:url";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright"
);
const output = process.env.PROJECT_UI_OUTPUT ?? "/tmp/studio-project-ui";
await fs.mkdir(output, { recursive: true });
import assert from "node:assert/strict";
import fs from "node:fs/promises";
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
    : {}),
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${process.env.PROJECT_UI_PORT ?? 5788}`);
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: path.join(output, "0888-project-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: /^Open thread Review the landing page, / }).click();
  assert(await page.getByLabel("Project coordinator", { exact: true }).isVisible());
  await page.getByLabel("Worker reply").fill("Continue the selected review");
  await page.getByRole("button", { name: "Send worker reply", exact: true }).click();
  // A worker on this machine takes its reply itself: no coordinator turn.
  const calls = await page.evaluate(() => window.__projectCalls);
  assert.equal(calls.filter((call) => call.command === "send").length, 0);
  await page.getByLabel("Close thread pane").click();
  await page.getByLabel("Project settings", { exact: true }).click();
  await page.getByRole("dialog").waitFor();
  await page.screenshot({ path: path.join(output, "0888-project-settings.png"), fullPage: true });
  await page.getByRole("button", { name: "Memory", exact: true }).click();
  await page.getByRole("button", { name: /MEMORY\.md.*128 bytes/ }).click();
  // A file opens as a readable page first; editing is one step further.
  await page.getByRole("button", { name: "Copy", exact: true }).waitFor();
  await page.screenshot({
    path: path.join(output, "0888-project-memory-view.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByLabel("Content of MEMORY.md").fill("Keep this unsaved decision");
  await page.getByRole("button", { name: "General", exact: true }).click();
  await page.getByRole("button", { name: "Memory", exact: true }).click();
  assert.equal(
    await page.getByLabel("Content of MEMORY.md").inputValue(),
    "Keep this unsaved decision",
  );
  await page.screenshot({ path: path.join(output, "0888-project-memory.png"), fullPage: true });
  await page.getByRole("button", { name: "Discard edit", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Usage", exact: true }).click();
  assert(await page.getByText(/Some usage was not reported/).isVisible());
  assert((await page.getByRole("dialog").innerText()).includes("Not reported"));
  await page.screenshot({ path: path.join(output, "0888-project-usage.png"), fullPage: true });
  await page.getByRole("dialog").getByRole("button", { name: "Routines", exact: true }).click();
  assert(await page.getByRole("heading", { name: "Daily project review" }).isVisible());
  assert.equal(await page.getByText("Foreign routine").count(), 0);
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
  await page.screenshot({ path: path.join(output, "0888-project-dark.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
  await page.screenshot({ path: path.join(output, "0888-project-mobile.png"), fullPage: true });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.getByRole("button", { name: /^Open thread Review the landing page, / }).click();
  assert(!(await page.getByLabel("Project coordinator", { exact: true }).isVisible()));
  assert(await page.getByLabel("Worker reply").isVisible());
  await page.screenshot({
    path: path.join(output, "0888-project-mobile-worker.png"),
    fullPage: true,
  });
  await page.getByLabel("Close thread pane").click();
  await page.getByLabel("Project settings", { exact: true }).click();
  await page.screenshot({
    path: path.join(output, "0888-project-mobile-settings.png"),
    fullPage: true,
  });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  const dialogRect = await page.getByRole("dialog").boundingBox();
  assert(dialogRect.x >= 15);
  assert(dialogRect.x + dialogRect.width <= 376);
  assert.deepEqual(errors, []);
  await fs.writeFile(
    path.join(output, "0888-ui-browser-evidence.json"),
    JSON.stringify(
      {
        scope: "Isolated UI fixture; native provider and thread surface mocked",
        viewports: ["1440x1000", "390x844"],
        checks: [
          "link opens scoped worker",
          "coordinator remains visible on desktop",
          "worker reply skips the coordinator",
          "memory draft survives tabs",
          "usage incomplete categories",
          "routines project scope",
          "typed delete confirmation",
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
  console.log(`10 headless UI scenarios passed; fixture evidence saved in ${output}`);
} finally {
  await browser.close();
}
