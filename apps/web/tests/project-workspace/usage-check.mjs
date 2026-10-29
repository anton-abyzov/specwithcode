// Per-machine subscription limits and folder-session project usage, headless.
// Run serve.mjs first (port 5788). Never headed; screenshots go to PROJECT_UI_OUTPUT.
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
// Popovers fade in; let the animation settle so screenshots show the final frame.
const shot = async (page, name) => {
  await page.waitForTimeout(400);
  return page.screenshot({ path: path.join(output, name), fullPage: true });
};
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  // M1 is offline; its last reading was saved in this browser three hours ago.
  await context.addInitScript(() => {
    const savedAt = Date.now() - 3 * 3_600_000;
    localStorage.setItem(
      "studio.host-limit-readings.v1",
      JSON.stringify({
        "studio-m1": {
          label: "M1",
          savedAt,
          providers: [
            {
              key: "claudeAgent:laptop@example.com",
              driver: "claudeAgent",
              label: "Claude",
              identity: "laptop@example.com",
              plan: "Pro",
              sharedWith: [],
              windows: [
                {
                  id: "five_hour",
                  label: "5-hour",
                  kind: "session",
                  usedPercent: 91,
                  resetsAt: savedAt + 3_600_000,
                  stale: false,
                },
                {
                  id: "seven_day",
                  label: "Weekly",
                  kind: "weekly",
                  usedPercent: 47,
                  resetsAt: Date.now() + 50 * 3_600_000,
                  stale: false,
                },
              ],
              peak: 91,
              bankedResets: 0,
              notice: null,
              checkedAt: savedAt,
            },
          ],
        },
      }),
    );
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${process.env.PROJECT_UI_PORT ?? 5788}`);
  await page.waitForLoadState("networkidle");

  // Limits live with the coordinator's model: the picker's footer, or beside the chip
  // when nothing can run the coordinator on this host (this fixture's host).
  const openLimits = async () => {
    const picker = page.getByRole("button", { name: /^Coordinator model:/ });
    if (await picker.count()) await picker.click();
    await page.getByRole("button", { name: "Limits by machine" }).click();
  };
  await openLimits();
  const grid = page.getByRole("region", { name: "Limits by machine" });
  await grid.waitFor();
  const gridText = await grid.innerText();
  assert.match(gridText, /Development Mac[\s\S]*M3[\s\S]*M1/);
  assert.match(gridText, /3h ago/);
  await shot(page, "picker-limits-by-machine.png");
  await page.keyboard.press("Escape");

  await page.getByLabel("Project settings", { exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  await dialog.getByRole("button", { name: "Usage", exact: true }).click();
  const blocks = dialog.locator(".sws-hl-block");
  await blocks.first().waitFor();
  const labels = await blocks.locator("header strong").allInnerTexts();
  assert.deepEqual(labels, ["Development Mac", "M3", "M1"], "project device first, offline last");
  const first = await blocks.nth(0).innerText();
  assert.match(first, /Project device/);
  assert.match(first, /Online · read 4m ago/);
  assert.match(first, /Claude[\s\S]*dev@example\.com · Max 20x[\s\S]*Same account on M3/);
  assert.match(first, /GitHub Copilot[\s\S]*Does not report subscription limits\./);
  assert.match(first, /1 reset banked/);
  const second = await blocks.nth(1).innerText();
  assert.match(second, /Same account on Development Mac/);
  assert.match(second, /second@example\.com/);
  const offline = await blocks.nth(2).innerText();
  assert.match(offline, /Offline · last read 3h ago/);
  assert.match(offline, /reset since/);
  // Folder sessions next to Studio threads, grouped and filterable.
  const usageText = await dialog.innerText();
  assert.match(usageText, /7 threads · 14 CLI sessions/);
  assert.match(usageText, /Daily tokens, last 30 days/);
  const tableRows = (caption) =>
    dialog
      .locator("table", { has: page.locator("caption", { hasText: caption }) })
      .locator("tbody th")
      .allInnerTexts();
  const harnessRows = await tableRows("Tokens by harness");
  assert.deepEqual(
    harnessRows.map((row) => row.split("\n")[0]),
    ["Claude", "Codex", "Copilot", "Grok"],
  );
  assert(!usageText.includes("acpRegistry"), "ACP agents are named by harness");
  const modelRows = (await tableRows("Tokens by model")).map((row) => row.split("\n")[0]);
  // claude-opus-5.5, claude-opus-5-5 and claude-opus-5-5[1m] are one model.
  assert.equal(modelRows.filter((row) => row === "Claude Opus 5.5").length, 1);
  assert.equal(modelRows.at(-1), "Model not reported");
  assert(!usageText.includes("Not reported\t"), "no columns of Not reported");
  assert.match(usageText, /Show 1 thread without usage/);
  await shot(page, "usage-settings-by-machine-light.png");
  await dialog.locator(".project-usage-trend-column").last().hover();
  await page.locator(".project-usage-trend-tip").waitFor();
  await shot(page, "usage-trend-hover.png");

  // Filters narrow every block together.
  await dialog.getByRole("combobox", { name: "Filter by harness" }).click();
  await page.getByRole("option", { name: "Codex", exact: true }).click();
  assert.deepEqual(
    (await tableRows("Tokens by harness")).map((row) => row.split("\n")[0]),
    ["Codex"],
  );
  assert.deepEqual(
    (await tableRows("Tokens by model")).map((row) => row.split("\n")[0]),
    ["GPT-5.5", "Model not reported"],
  );
  await shot(page, "usage-filtered-codex.png");
  await dialog.getByRole("button", { name: "Clear filters" }).click();
  await dialog.getByRole("combobox", { name: "Filter by source" }).click();
  await page.getByRole("option", { name: "CLI sessions", exact: true }).click();
  assert.equal(await dialog.getByRole("heading", { name: "Threads" }).count(), 0);
  await dialog.getByRole("button", { name: "Clear filters" }).click();

  // Grouped dropdown: one machine, then pooled.
  await dialog.getByRole("combobox", { name: "Show limits for" }).click();
  await page.getByRole("group", { name: "Machine" }).waitFor();
  assert(await page.getByRole("group", { name: "Layout" }).isVisible());
  await shot(page, "usage-settings-dropdown.png");
  await page.getByRole("option", { name: "M3", exact: true }).click();
  assert.deepEqual(await blocks.locator("header strong").allInnerTexts(), ["M3"]);
  await dialog.getByRole("combobox", { name: "Show limits for" }).click();
  await page.getByRole("option", { name: "Pooled across machines" }).click();
  assert.equal(await blocks.count(), 0);
  await dialog.getByRole("combobox", { name: "Show limits for" }).click();
  await page.getByRole("option", { name: "All machines" }).click();
  assert.equal(await blocks.count(), 3);

  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await shot(page, "usage-settings-by-machine-dark.png");
  await page.keyboard.press("Escape");
  await openLimits();
  await grid.waitFor();
  await shot(page, "picker-limits-by-machine-dark.png");
  await page.keyboard.press("Escape");
  await page.evaluate(() => document.documentElement.classList.remove("dark"));

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel("Project settings", { exact: true }).click();
  await dialog.waitFor();
  await dialog.getByRole("button", { name: "Usage", exact: true }).click();
  await blocks.first().waitFor();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await shot(page, "usage-settings-by-machine-mobile.png");
  assert.deepEqual(errors, []);
  console.log(
    `per-machine limits and folder usage: headless checks passed; screenshots in ${output}`,
  );
} finally {
  await browser.close();
}
