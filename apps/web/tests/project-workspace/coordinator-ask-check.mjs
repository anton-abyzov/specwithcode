// Headless check of the coordinator's ask in the Threads pane: a decision asked only in its
// last message goes to that message, and a native request still opens the requests dialog.
// Run with the fixture served (serve.mjs); PWDEBUG=0, PLAYWRIGHT_HTML_OPEN=never.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const output = process.env.UI_EVIDENCE_DIR ?? "/tmp/swc-coordinator-ask-evidence";
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
    : {}),
});
const base = `http://127.0.0.1:${process.env.PROJECT_UI_PORT ?? 5799}/`;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const requests = page.getByRole("dialog", { name: "Coordinator requests" });
  const ask = page.locator("[data-coordinator-ask]");

  await page.goto(`${base}?attention`);
  await page.getByRole("button", { name: "coordinator-report", exact: true }).click();
  assert.match(await ask.textContent(), /Coordinator · Reply needed/);
  await page.evaluate(() => {
    window.__scrolled = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (...args) {
      window.__scrolled.push(this.getAttribute("data-follow-anchor"));
      return original.apply(this, args);
    };
  });
  await page.screenshot({ path: path.join(output, "coordinator-ask-before-click.png") });
  await ask.click();
  await page.waitForFunction(() => window.__scrolled.length > 0);
  assert.equal(await requests.count(), 0);
  const scrolled = await page.evaluate(() => window.__scrolled.at(-1));
  assert.equal(
    await page
      .locator(`article.project-message-assistant[data-follow-anchor="${scrolled}"]`)
      .count(),
    1,
  );
  await page.screenshot({ path: path.join(output, "coordinator-ask-after-click.png") });

  await page.getByRole("button", { name: "coordinator", exact: true }).click();
  assert.match(await ask.textContent(), /Coordinator · Answer needed/);
  await ask.click();
  await requests.waitFor();
  await page.screenshot({ path: path.join(output, "coordinator-ask-native-request.png") });
  console.log(JSON.stringify({ scrolled, output }));
} finally {
  await browser.close();
}
