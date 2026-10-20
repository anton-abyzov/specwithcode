// Run against serve.mjs. Leaving a project for another in the sidebar and coming
// back shows the coordinator where the reader left it: at the latest message when
// they were following it, at the same message when they were reading further up.
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
// PROJECT_RETURN_MEASURE_ONLY=1 records what failed instead of stopping, to measure a build without the fix.
const measureOnly = process.env.PROJECT_RETURN_MEASURE_ONLY === "1";
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
    await page.goto(`http://127.0.0.1:${port}/?stream&switch`);
    await page.waitForLoadState("networkidle");
    // Each kept project page has its own conversation; only the shown one is visible.
    const conversation = page.locator('[aria-label="Coordinator conversation"]:visible');
    await conversation.waitFor();
    const nav = page.getByRole("navigation", { name: "Projects" });
    const open = async (title) => {
      await nav.getByRole("button", { name: title }).click();
      await conversation.waitFor();
    };
    const measure = () =>
      conversation.evaluate((el) => {
        const top = el.getBoundingClientRect().top;
        const first = [...el.querySelectorAll("article, .project-inline-notice")].find(
          (row) => row.getBoundingClientRect().bottom > top,
        );
        const latest = el.querySelector("[data-coordinator-latest] button");
        // "new" when something arrived below since the reader left the end, else "jump".
        const button = latest
          ? latest.hasAttribute("data-unseen") || /New messages/.test(latest.textContent ?? "")
            ? "new"
            : "jump"
          : null;
        return {
          scrollTop: Math.round(el.scrollTop),
          fromEnd: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
          rows: el.querySelectorAll("article, .project-inline-notice").length,
          // The first message in view, by the number its fixture text carries.
          firstVisible:
            first?.textContent?.match(
              /(Question|Answer) \d+|while you were|After the return/,
            )?.[0] ?? null,
          firstVisibleOffset: first ? Math.round(first.getBoundingClientRect().top - top) : null,
          earlierButton:
            [...el.querySelectorAll("button")]
              .map((b) => b.textContent)
              .find((t) => /earlier/i.test(t ?? "")) ?? null,
          button,
        };
      });
    const steps = [];
    const step = async (label) => {
      await frame(page);
      await frame(page);
      // The marker at the top mounts older messages from an IntersectionObserver.
      await page.waitForTimeout(150);
      const at = { label, ...(await measure()) };
      steps.push(at);
      return at;
    };
    const shoot = (label) =>
      page.screenshot({ path: `${output}/return-${name}-${label}.png`, animations: "disabled" });

    // 1. A first visit opens at the latest message.
    const opened = await step("opened Atlas");
    check(opened.fromEnd <= 2, `${name}: first visit opens at the end: ${JSON.stringify(opened)}`);

    // 2. Following the latest, Atlas → Beacon → Atlas lands on the latest again.
    await open("Beacon");
    const beacon = await step("opened Beacon");
    check(beacon.fromEnd <= 2, `${name}: Beacon's first visit opens at the end`);
    await open("Atlas Studio");
    const back = await step("back to Atlas, following");
    await shoot("following-returned");
    check(
      back.fromEnd <= 2,
      `${name}: return while following lands at the end: ${JSON.stringify(back)}`,
    );
    check(
      back.rows === opened.rows,
      `${name}: return mounted ${back.rows - opened.rows} older rows`,
    );
    check(back.button === null, `${name}: return while following shows "${back.button}"`);

    // 3. A message arriving while away is shown on return to a following reader.
    await open("Beacon");
    await page.evaluate(() =>
      window.__streamPush({
        id: "while-away",
        role: "assistant",
        createdBy: "agent",
        text: `Arrived while you were in Beacon. ${"A worker reported back. ".repeat(20)}`,
      }),
    );
    await open("Atlas Studio");
    const arrived = await step("back to Atlas after a reply arrived");
    check(
      arrived.fromEnd <= 2,
      `${name}: a reply that arrived while away is in view: ${JSON.stringify(arrived)}`,
    );

    // 4. A reader further up comes back to the same message, with the way down offered.
    const box = await conversation.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -1500);
    await page.waitForTimeout(300);
    const reading = await step("scrolled up in Atlas");
    check(reading.fromEnd > 500, `${name}: scrolled away: ${JSON.stringify(reading)}`);
    await open("Beacon");
    await open("Atlas Studio");
    const kept = await step("back to Atlas, reading");
    await shoot("reading-returned");
    const samePlace = (a, b) =>
      a.firstVisible === b.firstVisible &&
      Math.abs(a.firstVisibleOffset - b.firstVisibleOffset) <= 1;
    check(
      samePlace(kept, reading),
      `${name}: reader moved from ${reading.firstVisible} at ${reading.firstVisibleOffset}px to ${kept.firstVisible} at ${kept.firstVisibleOffset}px`,
    );
    check(kept.button === "jump", `${name}: reading return shows "${kept.button}"`);

    // 5. A reply while away leaves the reader in place and says so.
    await open("Beacon");
    await page.evaluate(() =>
      window.__streamPush({
        id: "while-reading",
        role: "assistant",
        createdBy: "agent",
        text: "Another reply arrived while you were away.",
      }),
    );
    await open("Atlas Studio");
    const unseen = await step("back to Atlas, reading, reply arrived");
    // The newest message mounting drops the oldest one above, so the place is the message in view.
    check(
      samePlace(unseen, reading),
      `${name}: reply while away moved the reader from ${reading.firstVisible} at ${reading.firstVisibleOffset}px to ${unseen.firstVisible} at ${unseen.firstVisibleOffset}px`,
    );
    check(unseen.button === "new", `${name}: reply while away shows "${unseen.button}"`);

    // 6. Rapid switching, without waiting for anything to settle.
    for (const title of [
      "Beacon",
      "Atlas Studio",
      "Beacon",
      "Atlas Studio",
      "Beacon",
      "Atlas Studio",
    ])
      await nav.getByRole("button", { name: title }).click();
    await conversation.waitFor();
    const rapid = await step("after rapid A-B-A switching");
    check(
      samePlace(rapid, reading),
      `${name}: rapid switching moved the reader from ${reading.firstVisible} at ${reading.firstVisibleOffset}px to ${rapid.firstVisible} at ${rapid.firstVisibleOffset}px`,
    );

    // 7. Older messages mounted from the top stay put across a switch.
    await conversation.evaluate((el) => (el.scrollTop = 0));
    await step("scrolled to the top, older messages mounted");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(300);
    const older = await step("reading older messages");
    await open("Beacon");
    await open("Atlas Studio");
    const olderBack = await step("back to Atlas, older messages");
    check(
      samePlace(olderBack, older) && olderBack.rows === older.rows,
      `${name}: older reading moved from ${older.firstVisible} at ${older.firstVisibleOffset}px to ${olderBack.firstVisible} at ${olderBack.firstVisibleOffset}px (${older.rows} to ${olderBack.rows} rows)`,
    );

    // 8. "Jump to latest" is always offered further up, and works from the keyboard:
    // it reaches the newest message and follows again from there.
    const jump = conversation.locator("[data-coordinator-latest] button");
    check(older.button !== null, `${name}: no way to the latest while reading older messages`);
    const jumpBox = await jump.boundingBox();
    const composerBox = await page.locator("#project-prompt:visible").boundingBox();
    check(
      jumpBox !== null && composerBox !== null && jumpBox.y + jumpBox.height <= composerBox.y,
      `${name}: the jump control overlaps the composer: ${JSON.stringify({ jumpBox, composerBox })}`,
    );
    check(
      (await jump.getAttribute("aria-label"))?.startsWith("Jump to latest") === true,
      `${name}: jump control has no accessible name`,
    );
    await shoot("jump-offered");
    await jump.focus();
    await page.keyboard.press("Enter");
    const jumped = await step("jumped to latest from the keyboard");
    check(
      jumped.fromEnd <= 2 && jumped.button === null,
      `${name}: jump did not reach the latest: ${JSON.stringify(jumped)}`,
    );
    check(jumped.firstVisible !== older.firstVisible, `${name}: jump stayed in the older messages`);
    await open("Beacon");
    await open("Atlas Studio");
    await page.evaluate(() =>
      window.__streamPush({
        id: "after-return",
        role: "assistant",
        createdBy: "agent",
        text: `After the return. ${"Still following. ".repeat(30)}`,
      }),
    );
    const follows = await step("reply after return, following");
    check(
      follows.fromEnd <= 2,
      `${name}: follows the latest after a return: ${JSON.stringify(follows)}`,
    );
    await shoot("follows-after-return");

    check(errors.length === 0, `${name}: page errors: ${errors}`);
    receipt[name] = steps;
    await page.close();
  }
  await NodeFSP.writeFile(`${output}/project-return.json`, JSON.stringify(receipt, null, 2));
  console.log(`${receipt.failures.length ? "FAILURES" : "ok"}: ${output}`);
  for (const f of receipt.failures) console.log(`  - ${f}`);
} finally {
  await browser.close();
}
