// Run against serve.mjs. A reader scrolled up in the coordinator stays put while
// replies stream in, a worker notice lands and they type; at the end it follows.
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
// SCROLL_MEASURE_ONLY=1 records what failed instead of stopping, to measure a build without the fix.
const measureOnly = process.env.SCROLL_MEASURE_ONLY === "1";
const check = (condition, message) => {
  if (condition) return;
  if (!measureOnly) NodeAssert.fail(message);
  receipt.failures.push(message);
};
const frame = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
try {
  for (const [name, viewport] of [
    ["desktop", { width: 1440, height: 900 }],
    ["phone", { width: 390, height: 844 }],
  ]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${port}/?stream`);
    await page.waitForLoadState("networkidle");
    const conversation = page.getByLabel("Coordinator conversation");
    await conversation.waitFor();
    const measure = () =>
      conversation.evaluate((el) => ({
        scrollTop: Math.round(el.scrollTop),
        fromEnd: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
        scrollHeight: el.scrollHeight,
        pageScrollY: Math.round(window.scrollY),
      }));
    const latest = page.locator("[data-coordinator-latest] button");
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

    const opened = await step("opened");
    check(opened.fromEnd <= 2, `opens at the end: ${JSON.stringify(opened)}`);

    // A real wheel gesture up over the conversation.
    const box = await conversation.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -700);
    await page.waitForTimeout(300);
    const reading = await step("scrolled up");
    check(reading.fromEnd > 300, `scrolled away: ${JSON.stringify(reading)}`);
    check(reading.button === "Jump to latest", `reading.button: ${reading.button}`);

    // A reply starts, then streams longer and longer.
    await page.evaluate(() =>
      window.__streamPush({
        id: "live",
        role: "assistant",
        createdBy: "agent",
        text: "Checking",
        streaming: true,
      }),
    );
    await step("reply arrived");
    for (let i = 1; i <= 6; i++) {
      await page.evaluate(
        (n) =>
          window.__streamUpdate(
            "live",
            `Checking the workers now. ${"Another worker reported back with its result. ".repeat(n * 6)}`,
          ),
        i,
      );
      await step(`reply streamed ${i}`);
    }
    // A worker's message routed to the coordinator, then a status-style notice.
    await page.evaluate(() =>
      window.__streamPush({
        id: "worker-note",
        role: "user",
        createdBy: "user",
        creationSource: "web",
        senderThreadId: "worker",
        text: "Worker finished: PR opened.",
      }),
    );
    await step("worker message arrived");
    // Typing, including new lines that grow the composer.
    const composer = page.locator("#project-prompt");
    await composer.click();
    await composer.pressSequentially("Where did worker two land", { delay: 5 });
    await composer.press("Shift+Enter");
    await composer.pressSequentially("and is the PR green?", { delay: 5 });
    await composer.press("Shift+Enter");
    await composer.pressSequentially("Also check the docs build.", { delay: 5 });
    await step("typed in composer");

    const stayed = steps.filter((s) => s.label !== "opened" && s.label !== "scrolled up");
    for (const s of stayed)
      check(
        Math.abs(s.scrollTop - reading.scrollTop) <= 1,
        `${name}: ${s.label} moved the reader from ${reading.scrollTop} to ${s.scrollTop}`,
      );
    check(
      stayed.every((s) => s.pageScrollY === reading.pageScrollY),
      `${name}: the page itself scrolled`,
    );
    check(
      stayed.at(-1).button === "Jump to latest, new messages below",
      `stayed.at(-1).button: ${stayed.at(-1).button}`,
    );
    await page.screenshot({
      path: `${output}/scroll-${name}-reader-stays.png`,
      animations: "disabled",
    });

    // The button returns to the end, and from there new content is followed.
    if (await latest.count()) await latest.click();
    else await conversation.evaluate((el) => (el.scrollTop = el.scrollHeight));
    const jumped = await step("jumped to latest");
    check(jumped.fromEnd <= 2, `${name}: jump lands at the end`);
    check(jumped.button === null, `jumped.button: ${jumped.button}`);
    await page.evaluate(() =>
      window.__streamUpdate("live", `Done. ${"Every worker is accounted for. ".repeat(60)}`),
    );
    await page.evaluate(() =>
      window.__streamPush({
        id: "after",
        role: "assistant",
        createdBy: "agent",
        text: "One more update.",
      }),
    );
    const followed = await step("followed at end");
    check(followed.fromEnd <= 2, `${name}: follows at the end: ${JSON.stringify(followed)}`);
    await page.screenshot({
      path: `${output}/scroll-${name}-follows-at-end.png`,
      animations: "disabled",
    });

    // The person's own message returns to the end even from further up.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -900);
    await page.waitForTimeout(300);
    const before = await step("scrolled up again");
    check(before.fromEnd > 300, `${name}: scrolled away again`);
    await page.evaluate(() =>
      window.__streamPush({
        id: "own",
        role: "user",
        createdBy: "user",
        creationSource: "web",
        text: "Where did worker two land?",
      }),
    );
    const sent = await step("own message sent");
    check(sent.fromEnd <= 2, `${name}: own message returns to the end`);
    check(errors.length === 0, `page errors: ${errors}`);
    receipt[name] = steps;
    await page.close();
  }
  await NodeFSP.writeFile(`${output}/scroll-offsets.json`, JSON.stringify(receipt, null, 2));
  console.log(`ok: ${output}`);
} finally {
  await browser.close();
}
