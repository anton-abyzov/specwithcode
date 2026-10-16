// A coordinator that names a worker by its plain title still gives a clickable link.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright"
);
const output = process.env.PROJECT_UI_OUTPUT ?? "/tmp/studio-project-ui";
const port = Number(process.env.PROJECT_UI_PORT ?? 5788);
await fs.mkdir(output, { recursive: true });
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
  await page.goto(`http://127.0.0.1:${port}/?mention`);
  await page.waitForLoadState("networkidle");
  const conversation = page.getByLabel("Coordinator conversation");
  const sentence = conversation.locator("article", {
    hasText: "Sent to the Release Chrome extension worker.",
  });
  await sentence.waitFor();
  const chip = sentence.getByRole("button", { name: /^Open thread Release Chrome extension/ });
  assert.equal(await chip.count(), 1, "the plain title is a thread chip");
  // Code and common words stay as written.
  const code = conversation.locator("article", { hasText: "Run Release Chrome extension only" });
  assert.equal(
    await code.getByRole("button", { name: /^Open thread / }).count(),
    0,
    "a title inside code is not linked",
  );
  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (dark) => document.documentElement.classList.toggle("dark", dark),
      theme === "dark",
    );
    await conversation.screenshot({ path: path.join(output, `mention-${theme}.png`) });
  }
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
  await chip.click();
  await page.getByLabel("Thread Release Chrome extension", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, "mention-open.png") });
  assert.deepEqual(errors, []);
  console.log(`mention check passed; screenshots in ${output}`);
} finally {
  await browser.close();
}
