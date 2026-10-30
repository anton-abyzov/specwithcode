/* Settings > Routines list at 1280 and 390 px, light and dark: filters, grouping, the collapsed
   paused-and-finished tail, Pause in the row menu and a confirmed "Delete finished". The host is
   synthetic; actions are recorded in window.__projectCalls, never run. */
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE
    ? NodeURL.pathToFileURL(process.env.PLAYWRIGHT_MODULE).href
    : "playwright"
);
const output = process.env.UI_EVIDENCE_DIR ?? "/tmp/studio-routine-list";
await NodeFSP.mkdir(output, { recursive: true });
const origin = `http://127.0.0.1:${process.env.PROJECT_UI_PORT ?? 5797}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
    : {}),
});
const errors = [];
const shot = (page, name) =>
  page.screenshot({ path: NodePath.join(output, `${name}.png`), fullPage: true });
const titles = (page) =>
  page
    .locator("[data-routine-row]:visible [data-routine-meta]")
    .evaluateAll((nodes) =>
      nodes.map((node) => node.closest("[data-routine-row]").getAttribute("data-routine-row")),
    );
try {
  const page = await browser.newPage({ reducedMotion: "reduce" });
  page.on("pageerror", (error) => errors.push(String(error)));
  // The fixture has no host: its favicon and environment discovery 404 by design.
  page.on("response", (r) => {
    const url = new URL(r.url());
    if (r.status() < 400 || url.pathname === "/favicon.ico") return;
    if (url.pathname.startsWith("/.well-known/studio/")) return;
    errors.push(`${r.status()} ${r.url()}`);
  });
  page.on(
    "console",
    (m) =>
      m.type() === "error" &&
      !m.text().startsWith("Failed to load resource") &&
      errors.push(m.text()),
  );
  for (const [width, dark] of [
    [1280, false],
    [390, true],
  ]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(origin);
    await page.locator("[data-routine-toolbar]").waitFor();
    // Switch the theme the way the app does, and drop the startup color pinned on <html> and <body>.
    await page.evaluate((on) => {
      const root = document.documentElement;
      root.classList.add("no-transitions");
      root.classList.toggle("dark", on);
      root.style.backgroundColor = "";
      document.body.style.backgroundColor = "";
    }, dark);
    await page.waitForTimeout(100);
    NodeAssert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      `no horizontal scroll at ${width}`,
    );
    await shot(page, `machine-${width}${dark ? "-dark" : ""}`);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(origin);
  await page.locator("[data-routine-toolbar]").waitFor();
  // By machine (sorted by name): the failed routine leads its group, paused and finished fold away.
  NodeAssert.deepEqual(await titles(page), [
    "nightly",
    "deps",
    "export-once",
    "sentry",
    "release-notes",
  ]);
  await page.getByRole("button", { name: /Show paused and finished \(2\)/ }).click();
  NodeAssert.equal(await page.locator("[data-routine-compact]:visible").count(), 2);
  await shot(page, "machine-expanded");
  // Group by provider, then filter to Codex on the build server.
  await page.getByRole("combobox", { name: "Group by" }).click();
  await page.getByRole("option", { name: "Provider" }).click();
  NodeAssert.deepEqual(
    await page
      .locator("[data-routine-group]")
      .evaluateAll((n) => n.map((g) => g.dataset.routineGroup)),
    ["claudeAgent", "codex"],
  );
  await shot(page, "provider");
  await page.getByRole("combobox", { name: "Machine" }).click();
  await page.getByRole("option", { name: "Build server" }).click();
  await page.getByRole("combobox", { name: "Provider" }).click();
  await page.getByRole("option", { name: "codex" }).click();
  NodeAssert.deepEqual(await titles(page), ["nightly"]);
  await page.getByRole("button", { name: "Clear filters" }).click();
  // Search across title and prompt.
  await page.getByRole("searchbox", { name: "Search routines" }).fill("sentry");
  NodeAssert.deepEqual(await titles(page), ["sentry"]);
  await page.getByRole("searchbox", { name: "Search routines" }).fill("");
  // Group by state: every group open, failed first.
  await page.getByRole("combobox", { name: "Group by" }).click();
  await page.getByRole("option", { name: "State" }).click();
  NodeAssert.deepEqual(
    await page
      .locator("[data-routine-group]")
      .evaluateAll((n) => n.map((g) => g.dataset.routineGroup)),
    ["attention", "active", "paused", "finished"],
  );
  // A one-time routine turned off after a failure needs attention; it is not "finished".
  NodeAssert.equal(
    await page.locator('[data-routine-group="attention"] [data-routine-row="export-once"]').count(),
    1,
  );
  await shot(page, "state");
  // Pause from the row menu.
  await page.getByRole("button", { name: "Actions for Check Sentry issues" }).click();
  await page.getByRole("menuitem", { name: "Pause" }).click();
  // Delete finished asks first; dismissing deletes nothing, accepting deletes both.
  const calls = () => page.evaluate(() => window.__projectCalls.map((call) => call.command));
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.locator("[data-routine-delete-finished]").click();
  await page.waitForTimeout(200);
  NodeAssert.equal((await calls()).filter((c) => c === "routineDelete").length, 0);
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("[data-routine-delete-finished]").click();
  await page.waitForFunction(
    () => window.__projectCalls.filter((c) => c.command === "routineDelete").length === 2,
  );
  NodeAssert.ok((await calls()).includes("routineToggle"), "Pause sent a toggle");
  // One machine keeps the old plain list: no machine heading, no machine filter.
  await page.goto(`${origin}/?single`);
  await page.locator("[data-routine-toolbar]").waitFor();
  NodeAssert.equal(await page.getByRole("combobox", { name: "Machine" }).count(), 0);
  NodeAssert.ok(
    (await page.getByRole("heading", { name: /Development Mac/ }).boundingBox()).width <= 1,
  );
  await shot(page, "single-machine");
  NodeAssert.deepEqual(errors, []);
  console.log(`Routine list check passed; screenshots in ${output}`);
} finally {
  await browser.close();
}
