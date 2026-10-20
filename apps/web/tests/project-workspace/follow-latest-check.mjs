// Run against serve.mjs. A coordinator reader at the end keeps following whatever
// grows it (streaming, late images, expansions, the end of a turn, a resized panel,
// scroll the browser makes on its own); only their own upward scroll pauses it, and
// scrolling back to the end, End, or "Jump to latest" resumes it with no extra click.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE
    ? NodeURL.pathToFileURL(process.env.PLAYWRIGHT_MODULE).href
    : "playwright"
);
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const output = process.env.UI_EVIDENCE_DIR ?? process.env.PROJECT_UI_OUTPUT;
NodeAssert.ok(output, "Set UI_EVIDENCE_DIR to an evidence directory");
const port = process.env.PROJECT_UI_PORT ?? 5788;
await NodeFSP.mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
    : {}),
});
const receipt = { failures: [] };
// FOLLOW_MEASURE_ONLY=1 records what failed instead of stopping, to measure a build without the fix.
const measureOnly = process.env.FOLLOW_MEASURE_ONLY === "1";
const check = (condition, message) => {
  if (condition) return;
  if (!measureOnly) NodeAssert.fail(message);
  receipt.failures.push(message);
};
const frame = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
// A picture that arrives after its message, the way an attachment preview loads.
const LATE_IMAGE = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420"><rect width="640" height="420" fill="#4a6"/></svg>`;
try {
  for (const [name, viewport] of [
    ["desktop", { width: 1440, height: 900 }],
    ["phone", { width: 390, height: 844 }],
  ]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    let imageCount = 0;
    await page.route("**/late-image/**", async (route) => {
      await new Promise((r) => setTimeout(r, 400));
      await route.fulfill({ contentType: "image/svg+xml", body: LATE_IMAGE });
    });
    await page.goto(`http://127.0.0.1:${port}/?stream&switch`);
    await page.waitForLoadState("networkidle");
    const conversation = page.locator('[aria-label="Coordinator conversation"]:visible');
    await conversation.waitFor();
    const latest = page.locator("[data-coordinator-latest] button:visible");
    const measure = () =>
      conversation.evaluate((el) => {
        const top = el.getBoundingClientRect().top;
        const row = [...el.querySelectorAll("[data-follow-anchor]")].find(
          (r) => r.getBoundingClientRect().bottom > top,
        );
        return {
          fromEnd: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
          anchor: row?.getAttribute("data-follow-anchor") ?? null,
          anchorOffset: row ? Math.round(row.getBoundingClientRect().top - top) : null,
        };
      });
    const steps = [];
    const step = async (label) => {
      await frame(page);
      await frame(page);
      const at = {
        label,
        ...(await measure()),
        button: (await latest.count()) ? await latest.getAttribute("aria-label") : null,
      };
      steps.push(at);
      return at;
    };
    const following = async (label) => {
      const at = await step(label);
      check(at.fromEnd <= 2, `${name}: ${label}: left the end (${at.fromEnd}px from it)`);
      check(at.button === null, `${name}: ${label}: offered "${at.button}" while following`);
      return at;
    };
    const push = (message) => page.evaluate((m) => window.__streamPush(m), message);
    const update = (id, text) => page.evaluate(([i, t]) => window.__streamUpdate(i, t), [id, text]);
    // Appends a late-loading picture to the message `id` and waits for it to load.
    const lateImage = async (id) => {
      imageCount += 1;
      await conversation.evaluate(
        (el, [rowId, src]) =>
          new Promise((resolve) => {
            const row = el.querySelector(`[data-follow-anchor="${rowId}"]`);
            const img = document.createElement("img");
            img.style.display = "block";
            img.style.maxWidth = "100%";
            img.addEventListener("load", () => resolve(), { once: true });
            img.addEventListener("error", () => resolve(), { once: true });
            img.src = src;
            row.append(img);
          }),
        [id, `/late-image/${imageCount}.svg`],
      );
    };
    const wheel = async (deltaY) => {
      const box = await conversation.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, deltaY);
      await page.waitForTimeout(300);
    };

    // --- At the end, everything that grows the conversation is followed. ---
    await following("opened");
    await push({
      id: "live",
      role: "assistant",
      createdBy: "agent",
      text: "Checking",
      streaming: true,
    });
    for (let i = 1; i <= 4; i++) {
      await update(
        "live",
        `Checking the workers. ${"A worker reported back with its result. ".repeat(i * 8)}`,
      );
      await following(`reply streamed ${i}`);
    }
    await lateImage("live");
    await following("late image in the reply");
    // A row above the last one grows (an expanded card, a loaded preview).
    await conversation.evaluate((el) => {
      const rows = el.querySelectorAll("[data-follow-anchor]");
      const block = document.createElement("div");
      block.style.height = "260px";
      rows[rows.length - 2].append(block);
    });
    await following("a row above grew");
    // Scroll the browser makes on its own (anchoring, a focused row): not the reader.
    await conversation.evaluate((el) => {
      el.scrollTop -= 160;
    });
    await page.waitForTimeout(100);
    await following("scroll nobody asked for");
    // A click on a message is not a scroll: selecting or opening a link keeps following.
    await page.locator('[data-follow-anchor="live"]').click({ position: { x: 20, y: 10 } });
    await update(
      "live",
      `Checking the workers. ${"A worker reported back with its result. ".repeat(40)}`,
    );
    await following("clicked a message, then it grew");
    // The turn ends: the long live text gives way to a short answer.
    await update("live", "All four workers are done; two pull requests are open.");
    await following("end of turn");
    await page.setViewportSize({
      width: Math.round(viewport.width * 0.7),
      height: viewport.height - 120,
    });
    await following("panel narrowed");
    await page.setViewportSize(viewport);
    await following("panel widened");
    // The person's own message with a picture that loads after it.
    await push({
      id: "own-image",
      role: "user",
      createdBy: "user",
      creationSource: "web",
      text: "Here is the screen.",
    });
    await lateImage("own-image");
    await following("own message's picture loaded");
    await page.screenshot({
      path: `${output}/follow-${name}-following.png`,
      animations: "disabled",
    });

    // --- Their own upward scroll pauses it and keeps their place. ---
    await wheel(-700);
    const reading = await step("scrolled up");
    check(reading.fromEnd > 300, `${name}: scrolled up: ${JSON.stringify(reading)}`);
    check(reading.button === "Jump to latest", `${name}: scrolled up: button ${reading.button}`);
    const kept = async (label, tolerance = 2) => {
      const at = await step(label);
      check(
        at.anchor === reading.anchor &&
          Math.abs(at.anchorOffset - reading.anchorOffset) <= tolerance,
        `${name}: ${label}: moved the reader from ${reading.anchor}@${reading.anchorOffset} to ${at.anchor}@${at.anchorOffset}`,
      );
      return at;
    };
    await push({
      id: "live2",
      role: "assistant",
      createdBy: "agent",
      text: "Next",
      streaming: true,
    });
    await kept("reply arrived while reading");
    for (let i = 1; i <= 3; i++) {
      await update("live2", `Next round. ${"Another worker reported back. ".repeat(i * 10)}`);
      await kept(`reply streamed ${i} while reading`);
    }
    await lateImage("live2");
    await kept("late image below while reading");
    await page.setViewportSize({ width: viewport.width, height: viewport.height - 120 });
    await kept("panel shorter while reading", 4);
    await page.setViewportSize(viewport);
    const stillReading = await kept("panel restored while reading", 4);
    check(
      stillReading.button === "Jump to latest, new messages below",
      `${name}: new while reading: button ${stillReading.button}`,
    );
    await page.screenshot({ path: `${output}/follow-${name}-reading.png`, animations: "disabled" });

    // --- Back to the end by scrolling: following again, no click. ---
    await wheel(6000);
    await following("scrolled back to the end");
    await push({
      id: "after-scroll",
      role: "assistant",
      createdBy: "agent",
      text: `Update. ${"More news. ".repeat(30)}`,
    });
    await following("followed after scrolling back");

    // --- The keyboard: PageUp pauses (not pulled back), End resumes. ---
    await conversation.focus();
    await page.keyboard.press("PageUp");
    await page.keyboard.press("PageUp");
    await page.waitForTimeout(400);
    const paged = await step("PageUp");
    check(
      paged.fromEnd > 300,
      `${name}: PageUp was pulled back to the end (${paged.fromEnd}px from it)`,
    );
    check(paged.button === "Jump to latest", `${name}: PageUp: button ${paged.button}`);
    await page.keyboard.press("End");
    await page.waitForTimeout(300);
    await following("End key");
    await push({
      id: "after-end",
      role: "assistant",
      createdBy: "agent",
      text: `Update. ${"More news. ".repeat(30)}`,
    });
    await following("followed after End");

    // --- One click on "Jump to latest" resumes for good. ---
    await wheel(-700);
    await step("scrolled up for the button");
    await latest.click();
    await page.waitForTimeout(300);
    await following("jumped to latest");
    await push({ id: "after-jump", role: "assistant", createdBy: "agent", text: "One more." });
    await update("after-jump", `One more. ${"Streaming on. ".repeat(80)}`);
    await lateImage("after-jump");
    await following("followed after the jump");

    // --- Another project and back, with news in between: at the latest. ---
    const nav = page.getByRole("navigation", { name: "Projects" });
    if (await nav.count()) {
      await nav.getByRole("button", { name: "Beacon" }).click();
      await page.waitForTimeout(200);
      await push({
        id: "while-away",
        role: "assistant",
        createdBy: "agent",
        text: `While away. ${"News. ".repeat(40)}`,
      });
      await nav.getByRole("button", { name: "Atlas Studio" }).click();
      await page.waitForTimeout(300);
      await following("back from another project");
    }
    await page.screenshot({ path: `${output}/follow-${name}-resumed.png`, animations: "disabled" });
    check(errors.length === 0, `${name}: page errors: ${errors}`);
    receipt[name] = steps;
    await page.close();
  }
} finally {
  await NodeFSP.writeFile(`${output}/follow-latest.json`, JSON.stringify(receipt, null, 2));
  await browser.close();
}
console.log(
  receipt.failures.length ? `${receipt.failures.length} failures: ${output}` : `ok: ${output}`,
);
