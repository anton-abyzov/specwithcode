// Headless check of the vocabulary editor and the dictation language row, Linux and Mac, light and dark.
// Serve the fixture, then run this with a folder for the captures:
//   cd apps/web && node ../../node_modules/vite-plus/bin/vp dev --config tests/voice-vocabulary/vite.config.ts --port 18437 --strictPort --host 127.0.0.1
//   STUDIO_TEST_CHROMIUM=<headless chromium> node tests/voice-vocabulary/verify.mjs <absolute evidence directory>
import { chromium } from "../../../desktop/node_modules/playwright-core/index.mjs";
import * as NodeFSP from "node:fs/promises";
import * as NodeAssert from "node:assert/strict";
const out = process.argv[2];
if (!out) throw new Error("Pass an absolute evidence directory");
const origin = process.env.STUDIO_FIXTURE_ORIGIN ?? "http://127.0.0.1:18437";
await NodeFSP.mkdir(out, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.STUDIO_TEST_CHROMIUM,
});
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const checks = [];
try {
  for (const mode of ["linux", "darwin"]) {
    for (const theme of ["light", "dark"]) {
      await page.goto(`${origin}/?mode=${mode}&theme=${theme}`);
      // The language row: Detect from speech is a Linux choice only.
      const language = page.getByRole("combobox", { name: "Dictation language" });
      await language.waitFor();
      const row = await page.locator("body").innerText();
      NodeAssert.match(row, /dictation and calls listen for/);
      NodeAssert.equal(/Detect from speech works out/.test(row), mode === "linux", mode);
      await language.click();
      const detect = page.getByRole("option", { name: "Detect from speech" });
      await page.getByRole("option", { name: "English (US)" }).waitFor();
      NodeAssert.equal(await detect.count(), mode === "linux" ? 1 : 0, mode);
      await page.screenshot({ path: `${out}/${mode}-${theme}-language.png` });
      if (mode === "linux") {
        await detect.click();
        await page.waitForFunction(() => document.body.dataset.language === "und");
        NodeAssert.equal(await language.innerText(), "Detect from speech");
      } else {
        await page.keyboard.press("Escape");
      }
      // The vocabulary editor: the person's list, and the product's words beside it.
      await page.getByRole("button", { name: "Voice settings" }).click();
      const editor = page.getByRole("textbox", { name: "Your vocabulary" });
      await editor.waitFor();
      await page.waitForFunction(() =>
        document.querySelector('[aria-label="Your vocabulary"]')?.value.includes("EasyChamp"),
      );
      const builtIn = page.locator("[data-voice-built-in-words]");
      await builtIn.scrollIntoViewIfNeeded();
      const words = await builtIn.innerText();
      NodeAssert.match(words, /^Always recognized: SpecWithCode, SpecWeave, worktree/);
      NodeAssert.match(words, /A line of your own for the same word wins\.$/);
      await page.screenshot({ path: `${out}/${mode}-${theme}-vocabulary.png` });
      checks.push({ mode, theme, detectOffered: mode === "linux", builtInWords: true });
    }
  }
  // A value saved on Linux reads as System on a Mac.
  await page.goto(`${origin}/?mode=darwin&theme=dark&language=und`);
  const carried = page.getByRole("combobox", { name: "Dictation language" });
  await carried.waitFor();
  NodeAssert.equal(await carried.innerText(), "System");
  checks.push({ mode: "darwin", carriedDetectReadsAs: "System" });
  NodeAssert.deepEqual(errors, []);
  await NodeFSP.writeFile(
    `${out}/voice-vocabulary-check.json`,
    JSON.stringify({ checks }, null, 2),
  );
  console.log("voice vocabulary fixture ok");
} finally {
  await browser.close();
}
