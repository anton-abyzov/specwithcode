// A project with no threads greets with three ways in and offers first tasks in the
// Threads pane; choosing one is a message to the coordinator.
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
const shot = (page, name) =>
  page.screenshot({ path: path.join(output, `starters-${name}.png`), fullPage: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1:5788/?fresh");
  await page.waitForLoadState("networkidle");
  const rows = page.locator('.sws-starters[data-layout="list"] button.sws-starter');
  const chips = page.locator(".sws-coordinator-greeting .sws-quick-start");
  const titles = (list) => list.locator("strong").allTextContents();
  // Claude's project home: a greeting and three ways in, nothing else beside the coordinator.
  assert.match(
    await page.locator(".sws-greeting").innerText(),
    /^Hi there,\s+Excited to get started on .+\. Here are a few ways to begin\.$/,
  );
  assert.deepEqual(await chips.allTextContents(), [
    "Set up from recent work",
    "Connect tools",
    "Make a plan",
  ]);
  assert.equal(await page.locator(".sws-coordinator-greeting .sws-starters").count(), 0);
  // The greeting sits at the top of the coordinator column, above the composer.
  const greetingTop = await page
    .locator(".sws-coordinator-greeting")
    .evaluate((node) => node.getBoundingClientRect().top);
  const composerTop = await page
    .locator("#project-prompt")
    .evaluate((node) => node.getBoundingClientRect().top);
  assert(greetingTop < 200 && greetingTop < composerTop - 200);
  assert.deepEqual(await titles(rows), [
    "Continue increment 0042",
    "Plan the first steps toward the goal",
    "Review 3 uncommitted changes",
    "Explore the codebase",
    "Write project memory",
    "Set up a routine",
  ]);
  assert(await page.getByText("No threads yet. Pick a first task").isVisible());
  assert(await page.getByRole("heading", { name: "Welcome.", exact: true }).isVisible());
  assert.equal(await page.locator(".sws-group-bar").count(), 0);
  // A prompt chip fills the composer for editing; it sends nothing.
  await chips.nth(2).click();
  assert.equal(await page.locator("#project-prompt").inputValue(), "Make a plan for ");
  // Focus moves on the next frame, after React has written the text.
  await page.waitForFunction(() => document.activeElement?.id === "project-prompt", null, {
    timeout: 2000,
  });
  assert.equal((await page.evaluate(() => window.__projectCalls)).length, 0);
  await page.locator("#project-prompt").fill("");
  await shot(page, "desktop");

  await rows.nth(2).click();
  await page.getByText("Sent to the coordinator.").first().waitFor();
  const calls = await page.evaluate(() => window.__projectCalls);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "send");
  assert.equal(calls[0].args.environmentId, "host");
  assert.equal(calls[0].args.input.projectId, "project");
  assert.equal(calls[0].args.input.sourceThreadId, undefined);
  assert.match(
    calls[0].args.input.prompt,
    /^Start a thread titled "Review uncommitted changes"\. /,
  );
  assert(await rows.nth(2).isDisabled());
  assert(await rows.nth(0).isEnabled());
  await shot(page, "desktop-sent");

  // Keyboard: the rows are ordinary buttons, reached and pressed without a mouse.
  await rows.nth(3).focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.__projectCalls.length === 2);
  assert.match(
    (await page.evaluate(() => window.__projectCalls))[1].args.input.prompt,
    /^Start a thread titled "Explore the codebase"\. /,
  );

  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await shot(page, "dark");
  await page.evaluate(() => document.documentElement.classList.remove("dark"));

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.waitForLoadState("networkidle");
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  // A phone shows one pane at a time: the greeting's chips wrap inside the screen.
  const phone = await chips.evaluateAll((nodes) =>
    nodes.map((node) => Math.round(node.getBoundingClientRect().right)),
  );
  assert(phone.every((right) => right <= 390));
  await shot(page, "mobile");

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("http://127.0.0.1:5788/?fresh=empty");
  await page.waitForLoadState("networkidle");
  assert.deepEqual(await titles(rows), [
    "Plan the first steps toward the goal",
    "Scaffold the project",
    "Set up a routine",
  ]);
  await shot(page, "empty-folder");

  // A coordinator turn that failed on the host is said in the project pane, not
  // only on the coordinator's own thread, and the first tasks stay on offer.
  await page.goto("http://127.0.0.1:5788/?fresh&failed");
  await page.waitForLoadState("networkidle");
  const failure = page.locator(
    '[aria-label="Coordinator conversation"] [data-coordinator-failure]',
  );
  await failure.waitFor();
  assert.equal(await failure.getAttribute("role"), "alert");
  assert.match(await failure.innerText(), /The coordinator did not answer\./);
  assert.match(await failure.innerText(), /no remaining permitted usage/);
  assert(await failure.getByRole("button", { name: "Open the coordinator thread" }).isVisible());
  assert.equal(await page.getByText("Queued for the coordinator.").count(), 0);
  assert(await rows.nth(0).isEnabled());
  await shot(page, "coordinator-failed");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.waitForLoadState("networkidle");
  await failure.waitFor();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await shot(page, "coordinator-failed-mobile");
  await page.setViewportSize({ width: 1440, height: 1000 });

  // A project that already has threads is not offered first tasks.
  await page.goto("http://127.0.0.1:5788/");
  await page.waitForLoadState("networkidle");
  assert.equal(await page.locator(".sws-starters").count(), 0);
  assert.deepEqual(errors, []);
  console.log(`Starter task scenarios passed; screenshots saved in ${output}`);
} finally {
  await browser.close();
}
