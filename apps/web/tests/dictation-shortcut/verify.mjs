// Headless check of the dictation shortcut in a coordinator and a thread composer.
// Usage: node verify.mjs <evidence dir> [base URL]
import { chromium } from "../../../desktop/node_modules/playwright-core/index.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";

const out = process.argv[2];
const base = process.argv[3] ?? "http://127.0.0.1:18423";
if (!out) throw new Error("Pass an absolute evidence directory");
await mkdir(out, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.STUDIO_TEST_CHROMIUM,
});
const checks = [];
const errors = [];

/** A page whose `navigator.platform` reads like the given OS, so `mod` maps as it would there. */
async function open(platform, query) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 640 } });
  await context.addInitScript((value) => {
    Object.defineProperty(Navigator.prototype, "platform", { get: () => value });
  }, platform);
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(`${query}: ${error.message}`));
  await page.goto(`${base}/?${query}`);
  await page.locator("#shortcut").waitFor();
  return { page, context };
}
const listening = (page, pane) =>
  page.locator(`[data-pane="${pane}"] .sws-voice-call[data-phase="listening"]`);
const bar = (page, pane) => page.locator(`[data-pane="${pane}"] .sws-voice-call`);
const box = (page, pane) =>
  page.getByLabel(pane === "coordinator" ? "Coordinator message" : "Thread message");
const speak = (page) => page.evaluate(() => window.speak());

try {
  for (const os of [
    { name: "macos", platform: "MacIntel", mode: "darwin", chord: "Meta+Shift+D", label: "⇧⌘D" },
    {
      name: "linux",
      platform: "Linux x86_64",
      mode: "linux",
      chord: "Control+Shift+D",
      label: "Ctrl+Shift+D",
    },
  ]) {
    const { page, context } = await open(os.platform, `mode=${os.mode}`);
    assert.equal(await page.locator("#shortcut").textContent(), `Dictation shortcut: ${os.label}`);
    for (const pane of ["coordinator", "thread"]) {
      const other = pane === "coordinator" ? "thread" : "coordinator";
      await box(page, pane).click();
      await page.keyboard.press(os.chord);
      await listening(page, pane).waitFor();
      assert.equal(await bar(page, other).count(), 0, `${os.name}: only the ${pane} dictates`);
      await speak(page);
      await page.waitForFunction(
        (label) => document.querySelector(`[aria-label="${label}"]`).value.includes("merge"),
        pane === "coordinator" ? "Coordinator message" : "Thread message",
      );
      await page.screenshot({ path: `${out}/${os.name}-${pane}-listening.png` });
      await page.keyboard.press(os.chord);
      await bar(page, pane).waitFor({ state: "detached" });
      checks.push({
        os: os.name,
        pane,
        chord: os.chord,
        started: true,
        stopped: true,
        text: await box(page, pane).inputValue(),
      });
    }
    // The tip on the mic button names the shortcut.
    await page
      .locator('[data-pane="thread"] button[aria-label="Dictate into the message"]')
      .hover();
    const tip = await page
      .getByText(`Dictate into the message (${os.label})`)
      .first()
      .waitFor({ timeout: 3000 })
      .then(() => true)
      .catch(() => false);
    checks.push({ os: os.name, tooltip: tip });
    assert.ok(tip, `${os.name}: tooltip shows ${os.label}`);
    await context.close();
  }

  {
    const { page, context } = await open(
      "Linux x86_64",
      "mode=linux&dictation=hold&language=ru-RU",
    );
    await box(page, "thread").click();
    await page.keyboard.down("Control");
    await page.keyboard.down("Shift");
    await page.keyboard.down("D");
    await listening(page, "thread").waitFor();
    await speak(page);
    await page.waitForFunction(() => window.heard.length > 0);
    await page.screenshot({ path: `${out}/linux-hold-listening.png` });
    await page.keyboard.up("D");
    await page.keyboard.up("Shift");
    await page.keyboard.up("Control");
    await bar(page, "thread").waitFor({ state: "detached" });
    const heard = await page.evaluate(() => window.heard);
    assert.deepEqual(heard[0], { locale: "ru-RU", pinLanguage: true });
    checks.push({ os: "linux", mode: "hold", releasedStops: true, language: heard[0] });
    await context.close();
  }

  for (const mode of ["windows", "browser"]) {
    const { page, context } = await open(
      mode === "windows" ? "Win32" : "Linux x86_64",
      `mode=${mode}`,
    );
    await box(page, "thread").click();
    const prevented = await page.evaluate(() => {
      const event = new KeyboardEvent("keydown", {
        key: "D",
        code: "KeyD",
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      document.activeElement.dispatchEvent(event);
      return event.defaultPrevented;
    });
    await page.waitForTimeout(200);
    assert.equal(await page.locator(".sws-voice-call").count(), 0, mode);
    assert.equal(await page.locator("button[aria-label='Dictate into the message']").count(), 0);
    assert.equal(prevented, false, `${mode}: the key is left to the browser`);
    await page.screenshot({ path: `${out}/${mode}-no-dictation.png` });
    checks.push({ mode, dictation: false, keyLeftToBrowser: true });
    await context.close();
  }
  assert.deepEqual(errors, []);
  await writeFile(`${out}/summary.json`, `${JSON.stringify({ ok: true, checks }, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, checks: checks.length }));
} catch (error) {
  await writeFile(
    `${out}/summary.json`,
    `${JSON.stringify({ ok: false, error: String(error), checks, errors }, null, 2)}\n`,
  );
  throw error;
} finally {
  await browser.close();
}
