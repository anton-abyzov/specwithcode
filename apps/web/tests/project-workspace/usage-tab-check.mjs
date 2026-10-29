// Project settings > Usage on its own (`?usage`), headless: grouping, filters, trend,
// hidden empty rows, light/dark and phone width. Run serve.mjs first.
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
const shot = async (page, name) => {
  await page.waitForTimeout(300);
  return page.screenshot({ path: path.join(output, name), fullPage: true });
};
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${process.env.PROJECT_UI_PORT ?? 5788}/?usage`);
  const usage = page.locator(".project-usage-insights");
  await usage.getByRole("heading", { name: "Project usage" }).waitFor();
  const rows = async (caption) =>
    (
      await usage
        .locator("table", { has: page.locator("caption", { hasText: caption }) })
        .locator("tbody th")
        .allInnerTexts()
    ).map((row) => row.split("\n")[0]);

  const text = await usage.innerText();
  assert.match(text, /7 threads · 14 CLI sessions/);
  assert.match(text, /Daily tokens, last 30 days/);
  assert.equal(await usage.locator(".project-usage-trend-column").count(), 30);
  assert.deepEqual(await rows("Tokens by harness"), ["Claude", "Codex", "Copilot", "Grok"]);
  assert(!text.includes("acpRegistry"), "ACP agents are named by harness");
  const models = await rows("Tokens by model");
  // claude-opus-5.5, claude-opus-5-5 and claude-opus-5-5[1m] are one model.
  assert.equal(models.filter((row) => row === "Claude Opus 5.5").length, 1);
  assert.equal(models.at(-1), "Model not reported");
  assert(!/Not reported\t/.test(text), "no columns of Not reported");
  assert.match(text, /Some usage was not reported/);
  assert.match(text, /Show 1 thread without usage/);
  await shot(page, "usage-tab-light.png");

  await usage.locator(".project-usage-trend-column").last().hover();
  const tip = usage.locator(".project-usage-trend-tip");
  await tip.waitFor();
  assert.match(await tip.innerText(), /tokens/);
  await shot(page, "usage-tab-trend-hover.png");

  // Filters narrow every block together.
  await usage.getByRole("combobox", { name: "Filter by harness" }).click();
  await page.getByRole("option", { name: "Codex", exact: true }).click();
  assert.deepEqual(await rows("Tokens by harness"), ["Codex"]);
  assert.deepEqual(await rows("Tokens by model"), ["GPT-5.5", "Model not reported"]);
  await shot(page, "usage-tab-filter-codex.png");
  await usage.getByRole("button", { name: "Clear filters" }).click();
  await usage.getByRole("combobox", { name: "Filter by source" }).click();
  await page.getByRole("option", { name: "CLI sessions", exact: true }).click();
  assert.equal(await usage.getByRole("heading", { name: "Threads" }).count(), 0);
  assert.deepEqual(await rows("Tokens by harness"), ["Claude", "Codex", "Copilot"]);
  await usage.getByRole("button", { name: "Clear filters" }).click();
  await usage.getByRole("combobox", { name: "Filter by model family" }).click();
  await page.getByRole("option", { name: "Claude Opus", exact: true }).click();
  assert.deepEqual(await rows("Tokens by model"), ["Claude Opus 5.5"]);
  await usage.getByRole("button", { name: "Clear filters" }).click();

  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await shot(page, "usage-tab-dark.png");
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await shot(page, "usage-tab-mobile-dark.png");
  assert.deepEqual(errors, []);
  console.log(`usage tab: headless checks passed; screenshots in ${output}`);
} finally {
  await browser.close();
}
