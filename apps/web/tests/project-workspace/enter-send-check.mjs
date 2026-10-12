// Enter sends from the coordinator composer, Shift+Enter breaks the line, and an Enter
// that belongs to an input method's composition is left to it. A desktop window narrower
// than the phone breakpoint still sends on Enter and keeps focus; a touch phone or tablet, in
// either orientation, keeps Return for new lines.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright"
);
const output =
  process.env.UI_EVIDENCE_DIR ?? process.env.PROJECT_UI_OUTPUT ?? "/tmp/studio-project-ui";
const port = Number(process.env.PROJECT_UI_PORT ?? 5788);
const executablePath = process.env.PLAYWRIGHT_EXECUTABLE ?? process.env.PLAYWRIGHT_EXECUTABLE_PATH;
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
});
const results = [];
const sends = (page) =>
  page.evaluate(() =>
    window.__projectCalls.filter((c) => c.command === "send").map((c) => c.args.input.prompt),
  );
async function open(name, options) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForLoadState("networkidle");
  const input = page.locator("#project-prompt");
  await input.waitFor();
  return { context, page, input, errors, name };
}
try {
  // Desktop: type, Shift+Enter, type, Enter.
  {
    const { context, page, input, errors } = await open("desktop", {
      viewport: { width: 1440, height: 1000 },
    });
    await input.click();
    await page.keyboard.type("First line");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("second line");
    assert.equal(await input.inputValue(), "First line\nsecond line");
    assert.deepEqual(await sends(page), []);
    await page.screenshot({ path: path.join(output, "enter-desktop-before.png") });
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.__projectCalls.some((c) => c.command === "send"));
    assert.deepEqual(await sends(page), ["First line\nsecond line"]);
    await page.waitForFunction(() => document.querySelector("#project-prompt").value === "");
    results.push({
      case: "desktop Enter sends, Shift+Enter is a new line",
      sends: await sends(page),
    });

    // Composition: an Enter that commits the input method's text is not a send.
    await input.click();
    await page.keyboard.type("nihao");
    const cdp = await context.newCDPSession(page);
    await page.evaluate(() =>
      document
        .querySelector("#project-prompt")
        .dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" })),
    );
    // Chromium marks the key that ends a composition with isComposing and keyCode 229.
    const composing = await page.evaluate(() => {
      const input = document.querySelector("#project-prompt");
      const event = new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
        cancelable: true,
        isComposing: true,
      });
      input.dispatchEvent(event);
      const ime229Enter = new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(ime229Enter, "keyCode", { value: 229 });
      input.dispatchEvent(ime229Enter);
      return [event.defaultPrevented, ime229Enter.defaultPrevented];
    });
    await page.evaluate(() =>
      document
        .querySelector("#project-prompt")
        .dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "你好" })),
    );
    // A real IME commit through the browser's own input pipeline.
    await cdp.send("Input.imeSetComposition", { text: "你好", selectionStart: 2, selectionEnd: 2 });
    await cdp.send("Input.insertText", { text: "你好" });
    await page.waitForTimeout(300);
    assert.deepEqual(composing, [false, false]);
    assert.deepEqual(await sends(page), ["First line\nsecond line"]);
    await page.screenshot({ path: path.join(output, "enter-composition.png") });
    results.push({ case: "Enter during composition does not send", defaultPrevented: composing });
    // After composition the next Enter sends.
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () => window.__projectCalls.filter((c) => c.command === "send").length === 2,
    );
    const sent = await sends(page);
    assert.match(sent[1], /^nihao/);
    results.push({ case: "Enter after composition sends", sent: sent[1] });

    // Cmd/Ctrl+Enter still sends.
    await input.click();
    await page.keyboard.type("With the modifier");
    await page.keyboard.press("ControlOrMeta+Enter");
    await page.waitForFunction(
      () => window.__projectCalls.filter((c) => c.command === "send").length === 3,
    );
    assert.equal((await sends(page))[2], "With the modifier");
    results.push({ case: "Cmd/Ctrl+Enter sends" });
    assert.deepEqual(errors, []);
    await context.close();
  }
  // A desktop window narrower than the phone breakpoint: Enter still sends.
  {
    const { context, page, input, errors } = await open("narrow", {
      viewport: { width: 600, height: 900 },
    });
    await input.click();
    await page.keyboard.type("Narrow window");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.__projectCalls.some((c) => c.command === "send"));
    assert.deepEqual(await sends(page), ["Narrow window"]);
    await page.waitForFunction(() => document.querySelector("#project-prompt").value === "");
    // A hardware keyboard keeps typing: the composer still holds focus after the send.
    assert.equal(await page.evaluate(() => document.activeElement?.id), "project-prompt");
    await page.screenshot({ path: path.join(output, "enter-narrow-desktop.png") });
    results.push({ case: "600px desktop window Enter sends and keeps focus" });
    assert.deepEqual(errors, []);
    await context.close();
  }
  // A touch phone: Return is the keyboard's new line; the Send button sends.
  {
    const { context, page, input, errors } = await open("phone", {
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    assert.equal(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), true);
    await input.tap();
    await page.keyboard.type("On a phone");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    assert.equal(await input.inputValue(), "On a phone\n");
    assert.deepEqual(await sends(page), []);
    await page.screenshot({ path: path.join(output, "enter-phone.png") });
    await page.locator('[aria-label="Send to coordinator"]').tap();
    await page.waitForFunction(() => window.__projectCalls.some((c) => c.command === "send"));
    results.push({ case: "touch phone Return is a new line; Send button sends" });
    assert.deepEqual(errors, []);
    await context.close();
  }
  // A landscape phone is wider than the phone layout, but Return is still the glass keyboard's.
  {
    const { context, page, input, errors } = await open("landscape-phone", {
      viewport: { width: 844, height: 390 },
      hasTouch: true,
      isMobile: true,
    });
    assert.equal(
      await page.evaluate(() => matchMedia("(pointer: coarse) and (hover: none)").matches),
      true,
    );
    await input.tap();
    await page.keyboard.type("Sideways");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    assert.equal(await input.inputValue(), "Sideways\n");
    assert.deepEqual(await sends(page), []);
    await page.screenshot({ path: path.join(output, "enter-landscape-phone.png") });
    results.push({ case: "844px landscape touch phone Return is a new line" });
    assert.deepEqual(errors, []);
    await context.close();
  }
  await fs.writeFile(path.join(output, "enter-send.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
}
