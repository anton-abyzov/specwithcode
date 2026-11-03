// Run against serve.mjs with `?filters`. The Threads pane keeps its machines in view with
// this machine first, a filter button for agent and pull request, chips that undo each
// filter, and a waiting mark on a machine the list no longer shows. Screenshots in
// light, dark and a narrow pane go to UI_EVIDENCE_DIR.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
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
const base = `http://127.0.0.1:${process.env.PROJECT_UI_PORT ?? 5788}/?filters`;
await NodeFSP.mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
    : {}),
});
const receipt = {};
const shot = async (page, name) => {
  await page.waitForTimeout(150);
  const box = await page.locator(".sws-threads-body").boundingBox();
  const clip = { ...box, height: Math.min(box.height, 720) };
  await page.screenshot({ path: NodePath.join(output, `${name}.png`), clip });
};
const rowIds = (page) =>
  page.$$eval(".sws-thread-row", (rows) => rows.map((row) => row.getAttribute("data-thread-id")));
const press = (page, selector) =>
  page.evaluate((target) => document.querySelector(target).click(), selector);
const choice = (id) => `[data-machine-choice='${id}']`;
const open = async (scheme, width = 1440) => {
  const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: scheme });
  await page.goto(base);
  await page.locator(".sws-thread-row").first().waitFor();
  return page;
};
try {
  const page = await open("light");
  const before = await rowIds(page);
  await page.waitForTimeout(150);
  receipt.order = await page.$$eval("[data-machine-choice]", (nodes) =>
    nodes.map((node) => node.getAttribute("data-machine-choice")),
  );
  NodeAssert.deepEqual(receipt.order.slice(0, 2), ["all", "host"], "this machine comes first");
  NodeAssert.equal(await page.getAttribute(choice("all"), "aria-pressed"), "true");
  await shot(page, "filters-all-light");

  await press(page, choice("host"));
  await page.waitForTimeout(100);
  const here = await rowIds(page);
  receipt.thisMachine = here;
  NodeAssert.ok(here.length > 0 && here.length < before.length, "one click narrows the list");
  NodeAssert.ok(!here.includes("release"), "the other machine's threads leave the list");
  NodeAssert.ok(
    (await page.getAttribute(choice("m4"), "aria-label")).includes("1 waiting on you"),
    "the other machine still says a thread waits on the person",
  );
  NodeAssert.equal(await page.locator(`${choice("m4")} .sws-dot`).count(), 1);
  NodeAssert.match(await page.locator(".sws-threads-head p").first().innerText(), /waiting on you/);
  await shot(page, "filters-this-machine-light");

  await page.reload();
  await page.locator("[data-thread-filters]").waitFor();
  NodeAssert.deepEqual(await rowIds(page), here, "the choice is remembered");
  await press(page, choice("all"));

  // Real input hangs this fixture page, as machine-column-check.mjs notes; these are the same events.
  await page.evaluate(() => {
    const trigger = document.querySelector("[data-thread-filter-menu]");
    const init = { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" };
    trigger.dispatchEvent(new PointerEvent("pointerdown", init));
    trigger.dispatchEvent(new MouseEvent("mousedown", init));
    trigger.dispatchEvent(new PointerEvent("pointerup", init));
    trigger.dispatchEvent(new MouseEvent("mouseup", init));
    trigger.dispatchEvent(new MouseEvent("click", init));
  });
  await page.locator("[data-agent-filter='all']").waitFor({ timeout: 8000 });
  await page.waitForTimeout(200);
  await page.screenshot({
    path: NodePath.join(output, "filters-menu-light.png"),
    clip: await page.locator(".sws-threads-body").boundingBox(),
  });
  receipt.agents = await page.$$eval("[data-agent-filter]", (nodes) =>
    nodes.map((node) => node.getAttribute("data-agent-filter")),
  );
  await press(page, `[data-agent-filter='${receipt.agents.at(-1)}']`);
  await page.locator("[data-filter-chip='agent']").waitFor();
  await page.waitForTimeout(250);
  receipt.oneAgent = await rowIds(page);
  NodeAssert.ok(receipt.oneAgent.length > 0 && receipt.oneAgent.length < before.length);
  await shot(page, "filters-agent-chip-light");
  await press(page, "[data-filter-chip='agent']");
  await page.waitForTimeout(100);
  NodeAssert.equal((await rowIds(page)).length, before.length, "the chip undoes its filter");
  await page.close();

  const dark = await open("dark");
  await press(dark, choice("host"));
  await shot(dark, "filters-this-machine-dark");
  await dark.close();

  const narrow = await open("light");
  await narrow.evaluate(() => {
    const body = document.querySelector(".sws-threads-body");
    body.style.width = "330px";
    body.style.flex = "none";
  });
  await narrow.waitForTimeout(200);
  const row = await narrow.locator("[data-thread-filters]").boundingBox();
  const body = await narrow.locator(".sws-threads-body").boundingBox();
  receipt.narrow = { row, body };
  NodeAssert.ok(row.x + row.width <= body.x + body.width + 1, "the row stays inside a narrow pane");
  await shot(narrow, "filters-narrow-light");
  await narrow.close();
} finally {
  await NodeFSP.writeFile(
    NodePath.join(output, "thread-filter.json"),
    JSON.stringify(receipt, null, 2),
  );
  await browser.close();
}
console.log(JSON.stringify(receipt));
