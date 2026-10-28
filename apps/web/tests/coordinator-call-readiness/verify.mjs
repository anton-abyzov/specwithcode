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
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const checks = [];
try {
  for (const mode of ["unsupported", "cloud-missing", "provider-missing"]) {
    await page.goto(`http://127.0.0.1:18422/?mode=${mode}`);
    const button = page.getByRole("button", { name: "Start voice call" });
    await button.waitFor();
    await page.waitForFunction(
      () => document.querySelector("#readiness").textContent !== "Checking voice support…",
    );
    assert.equal(await button.isDisabled(), true, mode);
    assert.equal(await page.evaluate(() => document.body.dataset.microphone ?? null), null);
    await page.screenshot({ path: `${out}/${mode}.png` });
    checks.push({ mode, disabled: true, reason: await page.locator("#readiness").textContent() });
  }
  for (const mode of ["windows", "browser"]) {
    await page.goto(`http://127.0.0.1:18422/?mode=${mode}`);
    await page.locator("#readiness").waitFor();
    await page.waitForFunction(
      () => document.querySelector("#readiness").textContent !== "Checking voice support…",
    );
    assert.equal(await page.getByRole("button", { name: "Start voice call" }).count(), 0, mode);
    assert.equal(await page.evaluate(() => document.body.dataset.microphone ?? null), null);
    await page.screenshot({ path: `${out}/${mode}.png` });
    checks.push({ mode, callControls: false });
  }
  await page.goto("http://127.0.0.1:18422/?mode=fresh");
  await page.getByRole("button", { name: "Start voice call" }).click();
  await page.getByRole("alertdialog").waitFor();
  await page.waitForFunction(() => {
    const dialog = document.querySelector('[role="alertdialog"]');
    return dialog && getComputedStyle(dialog).opacity === "1";
  });
  assert.match(await page.getByRole("alertdialog").innerText(), /paid ElevenLabs/);
  assert.equal(await page.evaluate(() => document.body.dataset.microphone ?? null), null);
  await page.screenshot({ path: `${out}/consent.png` });
  await page.getByRole("button", { name: "Allow and call" }).click();
  await page.waitForFunction(() => document.querySelector("#phase").textContent === "listening");
  assert.equal(await page.evaluate(() => document.body.dataset.microphone), "opened");
  await page.screenshot({ path: `${out}/listening.png` });
  await page.locator("button.sws-voice-call-button").click();
  await page.waitForFunction(() => document.querySelector("#phase").textContent === "ended");
  assert.equal(await page.evaluate(() => document.body.dataset.microphone), "closed");
  checks.push({
    mode: "fresh",
    consentBeforeCapture: true,
    freeNativePath: true,
    hangupClosedCapture: true,
  });
  await page.goto("http://127.0.0.1:18422/?mode=missing-helper");
  await page.getByRole("button", { name: "Start voice call" }).click();
  await page.getByRole("button", { name: "Allow and call" }).click();
  await page.waitForFunction(() => document.querySelector("#phase").textContent === "error");
  assert.match(await page.getByRole("alert").innerText(), /not available in this build/);
  assert.equal(await page.evaluate(() => document.body.dataset.microphone ?? null), null);
  checks.push({ mode: "missing-helper", captureOpened: false, actionableError: true });
  assert.deepEqual(errors, []);
  await writeFile(
    `${out}/browser-receipt.json`,
    JSON.stringify(
      { headless: true, syntheticAudio: true, paidRequests: 0, errors, checks },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: checks.length, errors }));
} finally {
  await context.close();
  await browser.close();
}
