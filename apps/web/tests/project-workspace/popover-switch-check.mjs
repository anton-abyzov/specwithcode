// Run against serve.mjs. A popover or menu left open in a project closes when the
// reader switches to another project: it neither stays on the new project nor
// opens again on return to the old one.
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
// POPOVER_SWITCH_MEASURE_ONLY=1 records what failed instead of stopping, to measure a build without the fix.
const measureOnly = process.env.POPOVER_SWITCH_MEASURE_ONLY === "1";
const failures = [];
const check = (condition, message) => {
  if (condition) return;
  if (!measureOnly) NodeAssert.fail(message);
  failures.push(message);
};
const settle = (page) => page.waitForTimeout(400);
const openPopups = (page) =>
  page.evaluate(() =>
    [
      ...document.querySelectorAll(
        "[data-slot='popover-popup'], [data-slot='menu-popup'], [role='menu'], [role='dialog']",
      ),
    ]
      .filter((el) => el.checkVisibility())
      .map((el) => (el.textContent ?? "").slice(0, 60)),
  );
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/?switch&fallback`);
  await page.waitForLoadState("networkidle");
  await page.locator('[aria-label="Coordinator conversation"]:visible').waitFor();
  const nav = page.getByRole("navigation", { name: "Projects" });
  const project = async (title) => {
    await nav.getByRole("button", { name: title }).click();
    await settle(page);
  };
  // A modal menu takes the press on the sidebar itself, so only the route can switch under it.
  const triggers = [
    ["limits popover", page.locator(".sws-usage-chip:visible").first(), false],
    ["project menu", page.locator('[aria-label="More project actions"]:visible').first(), true],
  ];
  for (const [label, trigger, modal] of triggers) {
    NodeAssert.ok((await trigger.count()) > 0, `${label}: trigger not rendered in the fixture`);
    if (!modal) {
      // By pointer: open it in Atlas, then pick Beacon in the sidebar.
      await trigger.click();
      await settle(page);
      const opened = await openPopups(page);
      check(opened.length > 0, `${label}: opened`);
      await page.screenshot({ path: `${output}/popover-switch-${label}-open.png` });
      await project("Beacon");
      check(
        (await openPopups(page)).length === 0,
        `${label}: closed on Beacon: ${JSON.stringify(await openPopups(page))}`,
      );
      await project("Atlas Studio");
      await page.screenshot({ path: `${output}/popover-switch-${label}-returned.png` });
      check(
        (await openPopups(page)).length === 0,
        `${label}: still closed back on Atlas: ${JSON.stringify(await openPopups(page))}`,
      );
    }

    // Without an outside press: the project changes while the popup is open
    // (a keyboard shortcut, a notification, a link in a message).
    await trigger.click();
    await settle(page);
    check((await openPopups(page)).length > 0, `${label}: opened again`);
    await page.evaluate(() => window.__fixtureSwitchProject?.("Beacon"));
    await settle(page);
    check(
      (await openPopups(page)).length === 0,
      `${label}: closed when the route changed: ${JSON.stringify(await openPopups(page))}`,
    );
    await page.evaluate(() => window.__fixtureSwitchProject?.("Atlas Studio"));
    await settle(page);
    await page.screenshot({ path: `${output}/popover-switch-${label}-route-returned.png` });
    check(
      (await openPopups(page)).length === 0,
      `${label}: still closed after the route returned: ${JSON.stringify(await openPopups(page))}`,
    );
    await page.keyboard.press("Escape");
    await settle(page);
  }
  check(errors.length === 0, `page errors: ${errors.join("; ")}`);
  await page.close();
} finally {
  await NodeFSP.writeFile(
    `${output}/popover-switch-receipt.json`,
    JSON.stringify({ measureOnly, failures }, null, 2),
  );
  await browser.close();
}
console.log(failures.length ? `FAILURES:\n${failures.join("\n")}` : "popover-switch-check passed");
