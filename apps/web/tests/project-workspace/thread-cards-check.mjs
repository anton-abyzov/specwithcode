import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright"
);
const output = process.env.PROJECT_UI_OUTPUT ?? "/tmp/studio-project-ui";
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
    : {}),
});
// The coordinator's answer started one thread and names another that already existed.
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1:5788");
  await page.waitForLoadState("networkidle");
  const conversation = page.getByLabel("Coordinator conversation");
  const card = conversation.getByRole("group", { name: /^Thread Consolidate the skills, / });
  const view = card.getByRole("button", {
    name: "View thread Consolidate the skills",
    exact: true,
  });
  const chip = conversation.getByRole("button", { name: /^Open thread Consolidate the skills, / });
  const link = conversation.getByRole("button", {
    name: "Open thread Review the landing page, Plan ready",
    exact: true,
  });
  assert.equal(await card.count(), 1, "the started thread is announced by one card");
  assert.equal(await view.count(), 1, "the card always offers View thread");
  assert.equal(await chip.count(), 1, "the sentence names the started thread as a chip too");
  assert.equal(await chip.locator(".sws-dot").count(), 1, "the chip carries a status dot");
  assert.equal(
    await conversation.locator(".sws-thread-card").count(),
    2,
    "each thread started that turn has its own card",
  );
  assert.equal(
    await link.locator(".sws-dot").count(),
    1,
    "the link carries the thread's status dot",
  );
  assert.equal(await link.count(), 1, "the existing thread is a chip");
  const look = async () =>
    page.evaluate(() => {
      const c = getComputedStyle(document.querySelector(".sws-thread-card"));
      const l = getComputedStyle(document.querySelector(".sws-thread-link"));
      return {
        cardBorder: `${c.borderTopWidth} ${c.borderTopStyle}`,
        linkColor: l.color,
        linkUnderline: l.textDecorationLine,
      };
    });
  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (dark) => document.documentElement.classList.toggle("dark", dark),
      theme === "dark",
    );
    const style = await look();
    assert.equal(style.cardBorder, "1px solid", `${theme}: the card has a border`);
    assert.equal(style.linkUnderline, "none", `${theme}: the chip is a pill, not underlined text`);
    const [r, , b] = style.linkColor.match(/\d+/g).map(Number);
    assert.ok(b > r, `${theme}: the chip is blue (${style.linkColor})`);
    await conversation.screenshot({ path: path.join(output, `thread-cards-${theme}.png`) });
  }
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
  await view.click();
  await page.getByLabel("Thread Consolidate the skills", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, "thread-cards-open-card.png") });
  await page.getByLabel("Close thread pane").click();
  await link.click();
  await page.getByLabel("Thread Review the landing page", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, "thread-cards-open-link.png") });
  await page.getByLabel("Close thread pane").click();
  // A delegated worker's ID contains %3A; the coordinator pasted it raw. Its chip opens it.
  const delegated = conversation.getByRole("button", {
    name: /^Open thread Record the tutorials, /,
  });
  assert.equal(await delegated.count(), 1, "the delegated worker's link is a chip");
  assert.equal(await conversation.locator('a[href=""]').count(), 0, "no link renders empty");
  assert.match(
    (await delegated.getAttribute("data-markdown-copy")) ?? "",
    /\(studio:\/\/thread\/thread%3Adelegated-task%3Acommand%253Amcp%253A/,
    "copying keeps the canonical link",
  );
  await delegated.click();
  await page.getByLabel("Thread Record the tutorials", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, "thread-links-open-delegated.png") });
  await page.getByLabel("Close thread pane").click();
  // A link to a thread this machine does not have is a muted chip that says why.
  const dead = conversation.getByRole("link", {
    name: "Draft the launch post, Thread not found on this machine",
  });
  assert.equal(await dead.count(), 1, "the dead link still renders as a chip");
  assert.equal(await dead.getAttribute("aria-disabled"), "true");
  const deadStyle = await dead.evaluate((el) => {
    const s = getComputedStyle(el);
    return { border: s.borderTopStyle, cursor: s.cursor };
  });
  assert.deepEqual(deadStyle, { border: "dashed", cursor: "default" }, "the dead chip is inert");
  await dead.hover();
  await page.getByText("Thread not found on this machine", { exact: true }).waitFor();
  const message = conversation
    .locator("article.project-message")
    .filter({ has: page.getByRole("button", { name: /^Open thread Record the tutorials, / }) });
  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (dark) => document.documentElement.classList.toggle("dark", dark),
      theme === "dark",
    );
    await page.mouse.move(0, 0);
    await delegated.hover();
    await message.screenshot({ path: path.join(output, `thread-links-${theme}.png`) });
  }
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
  // A long title is cut short with an ellipsis instead of pushing the chat sideways.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.waitForLoadState("networkidle");
  const fit = await page.evaluate(() => {
    const title = document.querySelector(".sws-thread-card-title");
    title.textContent =
      "Consolidate every agent skill across Claude, Codex, Cursor and Copilot into one place";
    const conversation = document.querySelector('[aria-label="Coordinator conversation"]');
    const card = title.closest(".sws-thread-card").getBoundingClientRect();
    return {
      cardRight: card.right,
      viewport: window.innerWidth,
      sideways: conversation.scrollWidth > conversation.clientWidth,
      ellipsized: title.scrollWidth > title.clientWidth,
    };
  });
  assert.ok(fit.cardRight <= fit.viewport, `the card fits the phone (${fit.cardRight}px)`);
  assert.equal(fit.sideways, false, "the chat does not scroll sideways");
  assert.equal(fit.ellipsized, true, "the long title is cut short");
  await page.screenshot({ path: path.join(output, "thread-cards-phone.png") });
  assert.deepEqual(errors, []);
  console.log(`thread cards check passed; screenshots in ${output}`);
} finally {
  await browser.close();
}
