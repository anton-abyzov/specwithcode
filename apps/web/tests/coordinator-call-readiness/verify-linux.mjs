import { chromium } from "../../../desktop/node_modules/playwright-core/index.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const out = process.argv[2];
if (!out) throw new Error("Pass an absolute evidence directory");
await mkdir(out, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.STUDIO_TEST_CHROMIUM,
});
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.goto("http://127.0.0.1:18422/?mode=linux");
  const mic = page.getByRole("button", { name: "Dictate into the message" });
  await mic.waitFor();
  assert.equal(await page.getByRole("button", { name: "Start voice call" }).count(), 1);
  await page.screenshot({ path: `${out}/linux-composer-buttons.png` });
  await mic.click();
  await page.getByRole("alertdialog").waitFor();
  await page.waitForFunction(() => {
    const dialog = document.querySelector('[role="alertdialog"]');
    return dialog && getComputedStyle(dialog).opacity === "1";
  });
  const consent = await page.getByRole("alertdialog").innerText();
  assert.doesNotMatch(consent, /this Mac|macOS|System Settings/);
  assert.match(consent, /267 MB/);
  assert.equal(await page.evaluate(() => document.body.dataset.microphone ?? null), null);
  await page.screenshot({ path: `${out}/linux-consent.png` });
  await page.getByRole("button", { name: "Allow and dictate" }).click();
  await page.getByRole("button", { name: "Stop dictating" }).first().waitFor();
  await page.waitForFunction(() => document.body.dataset.microphone === "opened");
  await page.getByText("Listening", { exact: true }).waitFor();
  await page.screenshot({ path: `${out}/linux-dictating.png` });
  assert.deepEqual(errors, []);
  await writeFile(
    `${out}/linux-check.json`,
    JSON.stringify({ consentBeforeCapture: true }, null, 2),
  );
  console.log("linux fixture ok");
} finally {
  await browser.close();
}
