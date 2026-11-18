// Build first: vp build --config apps/web/tests/coordinator-menu/vite.config.ts
// Usage: node apps/web/tests/coordinator-menu/verify.mjs [/absolute/evidence-dir]
// Always headless. Playwright comes from STUDIO_PLAYWRIGHT_MODULE, else apps/server's
// playwright-core; STUDIO_CHROMIUM_EXECUTABLE picks a browser binary.
// Checks and shoots, light and dark, 1280 and 390 px wide: the machine menu built from records
// (every row state), the Fix dialog, every state of the message box on a machine without the
// coordinator, the page after an offline switch, and the Settings label; then that each of the
// eight catalogs translates the new words. Each shot is measured for clipped or overlapping
// text in the menu; the numbers are in the results JSON.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = process.env.STUDIO_PLAYWRIGHT_MODULE
  ? await import(pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href)
  : createRequire(path.resolve("apps/server/package.json"))("playwright-core");
const output = path.resolve(
  process.argv.slice(2).find((a) => !a.startsWith("--")) ?? ".artifacts/coordinator-menu/evidence",
);
await fs.mkdir(output, { recursive: true });
const root = path.resolve(".artifacts/coordinator-menu/site");
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = path.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    assert(file.startsWith(root + path.sep));
    res.setHeader(
      "Content-Type",
      { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" }[
        path.extname(file)
      ] ?? "text/html",
    );
    res.end(await fs.readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.STUDIO_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE }
    : {}),
});
const results = [];
const errors = [];
/** Failures of the eight-language loop, kept apart so cases 1 to 5 report on their own. */
const languageFailures = [];
/** Rows of the message box's first-match order that resolve to another state. */
const orderFailures = [];
const WIDTHS = [1280, 390];
const MACHINE = /\b(m4|m5|m1|m3|linux-mini)\b/;
// Retired words: none may show anywhere in the menu.
const RETIRED_MENU = /\bMain\b|Make .* main|Copy · main|Start a coordinator/;

/** One page of the fixture; a script error anywhere fails the run. */
async function open(query, width = 1280, height = 820) {
  // The page's own background follows the system appearance, so that is set with the theme.
  const colorScheme = /(^|&)theme=dark(&|$)/.test(query) ? "dark" : "light";
  const page = await browser.newPage({ viewport: { width, height }, colorScheme });
  page.on("pageerror", (error) => errors.push(`${query}: ${error.message}`));
  await page.goto(`${origin}/?${query}`);
  return page;
}
async function openMenu(page) {
  await page.locator("[data-coordinator-machine]").click();
  await page.locator('[role="menu"]').waitFor();
  await page.waitForTimeout(250);
}
async function closeMenu(page) {
  if ((await page.locator('[role="menu"]').count()) > 0) await page.keyboard.press("Escape");
  await page.locator('[role="menu"]').waitFor({ state: "detached" });
  // Actions run after the popup has left the DOM.
  await page.waitForTimeout(100);
}
const texts = (page, selector) => page.locator(selector).allTextContents();
const events = (page) => page.evaluate(() => window.__events ?? []);
const viewing = (page) => page.locator("[data-viewing]").first().getAttribute("data-viewing");
const chip = (page) => page.locator("[data-coordinator-machine] .sws-host-name").textContent();

/**
 * Text in the open menu (or dialog) that is cut off or overlaps: a row part narrower than its
 * text, a row's action box over its row, or anything past the popup's or the window's edge.
 */
async function layoutProblems(page, scope = '[role="menu"]') {
  return page.evaluate((scope) => {
    const popup = document.querySelector(scope);
    if (!popup) return [];
    const problems = [];
    const edge = popup.getBoundingClientRect();
    const label = (el) =>
      `${el.getAttribute("data-row-pill") !== null ? "pill" : el.getAttribute("data-row-note") !== null ? "note" : el.getAttribute("data-row-reason") !== null ? "reason" : el.tagName.toLowerCase()} "${el.textContent.trim().slice(0, 60)}"`;
    for (const el of popup.querySelectorAll(
      "[data-row-pill],[data-row-reason],[data-row-note],.truncate,[role=menuitem],[role=menuitemradio],[data-slot=menu-label],h2,p,button",
    )) {
      const box = el.getBoundingClientRect();
      if (box.width === 0) continue;
      if (el.scrollWidth > el.clientWidth + 1)
        problems.push(`clipped ${label(el)}: ${el.scrollWidth}px of text in ${el.clientWidth}px`);
      if (box.right > edge.right + 1 || box.left < edge.left - 1)
        problems.push(`past the popup edge ${label(el)}`);
      if (box.right > window.innerWidth + 1 || box.left < -1)
        problems.push(`past the window edge ${label(el)}`);
    }
    for (const action of popup.querySelectorAll(
      "[data-orchestrator-fix],[data-orchestrator-connect]",
    )) {
      const row = action.parentElement?.querySelector("[role=menuitemradio]");
      if (!row) continue;
      const a = action.getBoundingClientRect();
      const r = row.getBoundingClientRect();
      const text = row.querySelector("[data-row-pill],[data-row-reason]")?.getBoundingClientRect();
      if (text && a.left < text.right - 1 && a.top < text.bottom && a.bottom > text.top)
        problems.push(`"${action.textContent}" covers the text of its row`);
      if (a.left < r.right - 1) problems.push(`"${action.textContent}" overlaps its row`);
    }
    return problems;
  }, scope);
}
const shot = async (page, name, scope) => {
  const file = path.join(output, `${name}.png`);
  await page.screenshot({ path: file });
  return { file, layout: scope === null ? [] : await layoutProblems(page, scope) };
};
/**
 * The Send button's drawn words (its `::after`, from `data-send-label`, or `data-send-short`
 * when narrow), the width its text needs and gets, and whether the button stays on screen.
 */
const sendLabelFit = (page) =>
  page.locator(".sws-composer-card button.sws-send").evaluate((button) => {
    const after = getComputedStyle(button, "::after");
    const words = after.content.startsWith('"')
      ? after.content.slice(1, -1)
      : (button.getAttribute(
          after.content.includes("data-send-short") ? "data-send-short" : "data-send-label",
        ) ?? "");
    const context = document.createElement("canvas").getContext("2d");
    context.font = `${after.fontWeight} ${after.fontSize} ${after.fontFamily}`;
    const box = button.getBoundingClientRect();
    // The room the words get inside the button: its content box less the arrow and the gap.
    const style = getComputedStyle(button);
    const icon = button.querySelector("svg")?.getBoundingClientRect().width ?? 0;
    const room =
      box.width -
      Number.parseFloat(style.paddingLeft) -
      Number.parseFloat(style.paddingRight) -
      Number.parseFloat(style.borderLeftWidth) -
      Number.parseFloat(style.borderRightWidth) -
      icon -
      (Number.parseFloat(style.columnGap) || 0);
    const card = button.closest(".sws-composer-card").getBoundingClientRect();
    return {
      words,
      needs: Math.ceil(context.measureText(words).width),
      gets: Math.min(
        Number.parseFloat(after.maxWidth) || Number.POSITIVE_INFINITY,
        Math.floor(room + 1),
      ),
      inside: box.left >= card.left - 1 && box.right <= Math.min(card.right, window.innerWidth) + 1,
    };
  });
/** Machine names cut short in the open menu's rows: each name must show whole. */
const clippedNames = (page) =>
  page.locator('[role="menuitemradio"]').evaluateAll((rows) =>
    rows.flatMap((row) => {
      const name = row.querySelector(".truncate");
      const machine = row.getAttribute("data-orchestrator-view")?.split(":")[0];
      if (!name || name.textContent !== machine)
        return [`row ${machine}: its name element reads "${name?.textContent ?? ""}"`];
      return name.scrollWidth > name.clientWidth
        ? [`"${name.textContent}": ${name.scrollWidth}px of text in ${name.clientWidth}px`]
        : [];
    }),
  );
/** "Fix…" and "Connect…": their role, whether a radio row holds them, and whether they are off. */
const rowActions = (page) =>
  page.locator("[data-orchestrator-fix],[data-orchestrator-connect]").evaluateAll((items) =>
    items.map((item) => ({
      text: item.textContent,
      role: item.getAttribute("role"),
      inRow: item.parentElement?.closest('[role="menuitemradio"]') != null,
      disabled: item.getAttribute("aria-disabled") === "true" || item.hasAttribute("data-disabled"),
    })),
  );
/** The element keyboard focus is on, by its row or action attribute. */
const focused = (page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    for (const name of [
      "data-orchestrator-view",
      "data-orchestrator-fix",
      "data-orchestrator-connect",
    ])
      if (el?.hasAttribute(name)) return `${name}=${el.getAttribute(name)}`;
    return el ? `${el.tagName.toLowerCase()} ${el.textContent?.slice(0, 40)}` : null;
  });
async function assertSendNamesNoMachine(page) {
  const send = page.locator(".sws-composer-card button.sws-send");
  for (const value of [
    await send.textContent(),
    (await send.getAttribute("data-send-label")) ?? "",
    (await send.getAttribute("data-send-short")) ?? "",
  ])
    assert.doesNotMatch(value, MACHINE, "the Send button names a machine");
  assert.equal(await page.locator("#project-prompt").isDisabled(), false, "the box is off");
}

try {
  for (const theme of ["light", "dark"])
    for (const width of WIDTHS) {
      const tag = `${theme}-${width}`;
      // 1. The machine menu on m5's page, built from records through the real resolvers.
      let page = await open(`theme=${theme}&case=menu`, width);
      assert.equal(await chip(page), "On m5");
      await openMenu(page);
      assert.equal(
        await page.locator('[role="menu"] [data-slot="menu-label"]').first().textContent(),
        "Atlas on your machines",
      );
      // m4 holds the coordinator; m5 handed it on (no role word); m1 runs an extra coordinator
      // at a higher epoch; linux-mini is listed and never opened here, so it is greyed (last).
      assert.deepEqual(await texts(page, '[role="menuitemradio"]'), [
        "m4Coordinator",
        "m5",
        "m1Extra coordinator",
        "linux-miniThis window cannot open linux-mini",
      ]);
      assert.deepEqual(
        await page
          .locator('[role="menuitemradio"]')
          .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-row-state"))),
        ["coordinator", "plain", "extra-coordinator", "cannot-open"],
      );
      assert.deepEqual(await texts(page, "[data-row-pill]"), ["Coordinator", "Extra coordinator"]);
      assert.equal(await page.locator("[data-row-note]").count(), 0);
      assert.equal(
        await page.locator('[data-orchestrator-view="m5:p"]').getAttribute("aria-checked"),
        "true",
      );
      const greyed = page.locator('[data-orchestrator-view="linux-mini:p"]');
      assert.equal(await greyed.getAttribute("aria-disabled"), "true");
      assert.deepEqual(await texts(page, "[data-orchestrator-connect]"), ["Connect…"]);
      assert.deepEqual(await texts(page, "[data-orchestrator-fix]"), ["Fix…"]);
      assert.equal(await page.locator('[data-orchestrator-fix="m1:p"]').count(), 1);
      // Read out with the machine each one acts on; the visible words stay short.
      assert.equal(
        await page.locator('[data-orchestrator-fix="m1:p"]').getAttribute("aria-label"),
        "Fix the extra coordinator on m1",
      );
      assert.equal(
        await page.locator('[data-orchestrator-connect="linux-mini:p"]').getAttribute("aria-label"),
        "Connect linux-mini",
      );
      assert.equal(await page.locator('[data-orchestrator-connect="linux-mini:p"]').count(), 1);
      // Each is a menu item of its own beside its row, never inside it; "Connect…" stays on
      // while its row is greyed.
      assert.deepEqual(await rowActions(page), [
        { text: "Fix…", role: "menuitem", inRow: false, disabled: false },
        { text: "Connect…", role: "menuitem", inRow: false, disabled: false },
      ]);
      assert.deepEqual(await clippedNames(page), [], "a machine name is cut short");
      // One coordinator item, for the machine shown, under "Work on m5".
      const continueItem = page.locator("[data-orchestrator-continue]");
      assert.equal(await continueItem.count(), 1);
      assert.equal(await continueItem.textContent(), "Continue the coordinator here");
      assert.equal(
        await continueItem.evaluate(
          (el) =>
            el.closest('[data-slot="menu-group"]')?.querySelector('[data-slot="menu-label"]')
              ?.textContent,
        ),
        "Work on m5",
      );
      const items = await texts(page, '[role="menuitem"]');
      for (const item of [
        "Send to another machine…",
        "Move running threads…",
        "Leave this machine…",
      ])
        assert.ok(items.includes(item), `menu item ${item}`);
      assert.doesNotMatch(await page.locator('[role="menu"]').textContent(), RETIRED_MENU);
      let taken = await shot(page, `menu-rows-from-records-${tag}`, '[role="menu"]');
      // In the keyboard order each action follows its row.
      await page.locator('[data-orchestrator-view="m1:p"]').hover();
      await page.waitForFunction(
        () => document.activeElement?.getAttribute("data-orchestrator-view") === "m1:p",
      );
      await page.keyboard.press("ArrowDown");
      assert.equal(await focused(page), "data-orchestrator-fix=m1:p", "ArrowDown from m1's row");
      const afterFix = [];
      for (let step = 0; step < 2; step++) {
        await page.keyboard.press("ArrowDown");
        afterFix.push(await focused(page));
        if (afterFix.at(-1) === "data-orchestrator-connect=linux-mini:p") break;
      }
      assert.equal(
        afterFix.at(-1),
        "data-orchestrator-connect=linux-mini:p",
        `ArrowDown from "Fix…" reached ${afterFix.join(", ")}`,
      );
      assert.ok(
        afterFix.length === 1 || afterFix[0] === "data-orchestrator-view=linux-mini:p",
        `between "Fix…" and "Connect…": ${afterFix.join(", ")}`,
      );
      // The greyed row picks nothing.
      await greyed.click({ force: true });
      await closeMenu(page);
      assert.equal(await viewing(page), "m5:p");
      assert.equal(
        (await events(page)).some((event) => event.startsWith("view:")),
        false,
      );
      // "Fix…" opens the Fix dialog and never picks the row beside it.
      await openMenu(page);
      await page.locator('[data-orchestrator-fix="m1:p"]').click();
      await page.locator('[data-extra-coordinator-fix="explain"]').waitFor();
      assert.equal(
        await page.locator('[data-slot="dialog-title"]').textContent(),
        "Extra coordinator on m1",
      );
      assert.equal(await viewing(page), "m5:p");
      assert.deepEqual(await events(page), ["fix:m1:p"]);
      const fixShot = await shot(page, `menu-fix-opened-${tag}`, '[data-slot="dialog-popup"]');
      await page.keyboard.press("Escape");
      await page.locator("[data-extra-coordinator-fix]").waitFor({ state: "detached" });
      // "Connect…" on the greyed row, then the chip follows the machine picked.
      await openMenu(page);
      await page.locator('[data-orchestrator-connect="linux-mini:p"]').click();
      await closeMenu(page);
      assert.ok((await events(page)).includes("connect"));
      await openMenu(page);
      await page.locator('[data-orchestrator-view="m4:p"]').click();
      await closeMenu(page);
      assert.equal(await viewing(page), "m4:p");
      assert.equal(await chip(page), "On m4");
      await openMenu(page);
      assert.equal(await page.locator("[data-orchestrator-continue]").count(), 0);
      assert.ok((await texts(page, '[data-slot="menu-label"]')).includes("Work on m4"));
      await closeMenu(page);
      results.push({ theme, width, case: "menu rows from records", ...taken, fix: fixShot });
      await page.close();

      // 2a. Offline, kept conversation and a hand off under way.
      page = await open(`theme=${theme}&case=offline`, width);
      await openMenu(page);
      const offlineRows = await texts(page, '[role="menuitemradio"]');
      assert.deepEqual(offlineRows.slice(1), [
        "m5Old conversation kept",
        "linux-miniHanding off the coordinator…",
        "m1Extra coordinator",
      ]);
      assert.equal(offlineRows[0], "m4CoordinatorOffline · last seen 2h ago");
      assert.deepEqual(
        await page
          .locator('[role="menuitemradio"]')
          .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-row-state"))),
        ["coordinator", "plain", "handing-off", "extra-coordinator"],
      );
      const notes = await texts(page, "[data-row-note]");
      assert.equal(notes.length, 2);
      assert.deepEqual(notes, ["Offline · last seen 2h ago", "Old conversation kept"]);
      assert.deepEqual(await clippedNames(page), [], "a machine name is cut short");
      assert.equal(
        await page.locator('[data-orchestrator-view="m4:p"]').getAttribute("aria-disabled"),
        null,
      );
      assert.doesNotMatch(await page.locator('[role="menu"]').textContent(), RETIRED_MENU);
      taken = await shot(page, `menu-offline-kept-handing-off-${tag}`, '[role="menu"]');
      // The offline row is pressable: it opens what this window last saved.
      await page.locator('[data-orchestrator-view="m4:p"]').click();
      await closeMenu(page);
      assert.equal(await viewing(page), "m4:p");
      results.push({ theme, width, case: "offline, kept, handing off", ...taken });
      await page.close();

      // 2b. The same repository added on three machines on its own: separate projects.
      page = await open(`theme=${theme}&case=unlinked`, width);
      await openMenu(page);
      assert.deepEqual(await texts(page, '[role="menuitemradio"]'), [
        "m1Separate project",
        "m3Separate project",
        "m4Separate project",
      ]);
      await page.locator('[data-slot="menu-info-button"]').click();
      assert.equal(
        await page.locator("[data-orchestrator-unlinked-note]").textContent(),
        "These are separate projects for this repository, each with its own coordinator, threads and memory. You can still open and message each one. Link them below to make one project.",
      );
      assert.deepEqual(await texts(page, "[data-orchestrator-link]"), [
        "Link m1 to this project…",
        "Link m3 to this project…",
      ]);
      assert.equal(await page.locator("[data-orchestrator-continue]").count(), 0);
      assert.equal(await page.locator("[data-orchestrator-fix]").count(), 0);
      assert.doesNotMatch(await page.locator('[role="menu"]').textContent(), RETIRED_MENU);
      taken = await shot(page, `menu-separate-projects-${tag}`, '[role="menu"]');
      results.push({ theme, width, case: "separate projects", ...taken });
      await page.close();

      // 3. The Fix dialog: what is so, one action, its confirmation, and the guard.
      page = await open(`theme=${theme}&case=fix`, width);
      const fix = page.locator("[data-extra-coordinator-fix]");
      await fix.waitFor();
      assert.equal(await fix.getAttribute("data-extra-coordinator-fix"), "explain");
      assert.equal(
        await page.locator('[data-slot="dialog-title"]').textContent(),
        "Extra coordinator on m1",
      );
      assert.equal(
        await page.locator('[data-slot="dialog-description"]').textContent(),
        "m1 also runs a coordinator for Atlas. The project's coordinator is on m4.",
      );
      assert.equal(
        await page.locator("[data-fix-relink]").textContent(),
        "To make m1 part of this project again, link it afterwards. Linking makes it give way to the coordinator on m4.",
      );
      assert.equal(await page.locator("[data-fix-refused]").count(), 0);
      assert.equal(await page.locator("[data-fix-settings]").count(), 0);
      const unlink = page.locator("[data-fix-unlink]");
      assert.equal(await unlink.textContent(), "Unlink Atlas on m1");
      assert.equal(await unlink.isDisabled(), false);
      taken = await shot(page, `fix-dialog-${tag}`, '[data-slot="dialog-popup"]');
      await unlink.click();
      assert.equal(await fix.getAttribute("data-extra-coordinator-fix"), "confirm");
      assert.equal(
        await page.locator('[data-slot="dialog-title"]').textContent(),
        "Unlink Atlas on m1?",
      );
      assert.equal(
        await page.locator('[data-slot="dialog-description"]').textContent(),
        "It becomes its own project again, with an active coordinator and a copy of this project's notes. m4 stops sending it work. Threads and files stay where they are.",
      );
      assert.equal(await page.locator("[data-fix-confirm]").textContent(), "Unlink");
      const confirmShot = await shot(
        page,
        `fix-dialog-confirm-${tag}`,
        '[data-slot="dialog-popup"]',
      );
      // Cancel goes back a step; nothing was unlinked.
      await page.getByRole("button", { name: "Cancel" }).click();
      assert.equal(await fix.getAttribute("data-extra-coordinator-fix"), "explain");
      results.push({ theme, width, case: "Fix dialog", ...taken, confirm: confirmShot });
      await page.close();

      page = await open(`theme=${theme}&case=fix&guard=1`, width);
      await page.locator("[data-extra-coordinator-fix]").waitFor();
      assert.equal(
        await page.locator("[data-fix-refused]").textContent(),
        "linux-mini still follows the coordinator on m1. Continue the coordinator on another machine first.",
      );
      assert.equal(await page.locator("[data-fix-unlink]").isDisabled(), true);
      assert.equal(await page.locator("[data-fix-settings]").count(), 0);
      taken = await shot(page, `fix-dialog-guarded-${tag}`, '[data-slot="dialog-popup"]');
      results.push({ theme, width, case: "Fix dialog, guarded", ...taken });
      await page.close();

      // m1 cannot be changed from this window: the action is off, with the reason.
      page = await open(`theme=${theme}&case=fix&problem=permission`, width);
      await page.locator("[data-extra-coordinator-fix]").waitFor();
      assert.equal(
        await page.locator("[data-fix-refused]").textContent(),
        "This app's connection to m1 needs permission to change settings and run work.",
      );
      assert.equal(await page.locator("[data-fix-unlink]").textContent(), "Unlink Atlas on m1");
      assert.equal(await page.locator("[data-fix-unlink]").isDisabled(), true);
      assert.equal(await page.locator("[data-fix-settings]").count(), 0);
      taken = await shot(page, `fix-dialog-problem-${tag}`, '[data-slot="dialog-popup"]');
      results.push({ theme, width, case: "Fix dialog, machine problem", ...taken });
      await page.close();

      // m1 alone in its list cannot leave for another reason: no unlink, only the settings.
      page = await open(`theme=${theme}&case=fix&alone=1`, width);
      await page.locator("[data-extra-coordinator-fix]").waitFor();
      assert.equal(
        await page.locator("[data-fix-refused]").textContent(),
        "m1 cannot be unlinked from this window.",
      );
      assert.equal(await page.locator("[data-fix-unlink]").count(), 0);
      const settings = page.locator("[data-fix-settings]");
      assert.equal(await settings.textContent(), "Open project settings");
      assert.equal(await settings.isDisabled(), false);
      taken = await shot(page, `fix-dialog-cannot-unlink-${tag}`, '[data-slot="dialog-popup"]');
      await settings.click();
      assert.deepEqual(await events(page), ["fix-closed", "open-settings"]);
      results.push({ theme, width, case: "Fix dialog, cannot unlink", ...taken });
      await page.close();

      // 4. The message box on m5, the coordinator on m4: AC-07.
      const boxPage = async (state) => {
        const p = await open(`theme=${theme}&case=box&state=${state}`, width, 720);
        await p.locator("[data-workers-only]").waitFor();
        return p;
      };
      const line = (p) => p.locator("[data-box-line]").textContent();
      const send = (p) => p.locator(".sws-composer-card button.sws-send");
      const prompt = (p) => p.locator("#project-prompt");
      const routed = (p) => p.evaluate(() => window.__routed ?? []);

      page = await boxPage("routes");
      assert.equal(await page.locator("[data-box-state]").getAttribute("data-box-state"), "routes");
      assert.equal(await line(page), "The coordinator for Atlas is on m4. Send opens it there.");
      assert.equal(await chip(page), "On m5");
      assert.equal(await send(page).getAttribute("data-send-label"), null);
      assert.equal(await page.locator("[data-continue-here]").textContent(), "Continue here");
      assert.equal(await page.locator("[data-continue-here]").isDisabled(), false);
      assert.equal(
        await page.locator("[data-continue-here-note]").textContent(),
        "Continue here syncs m5, then moves the coordinator conversation here from m4.",
      );
      assert.equal(
        await prompt(page).getAttribute("placeholder"),
        "Ask the coordinator for Atlas (on m4).",
      );
      await assertSendNamesNoMachine(page);
      await prompt(page).fill("time now?");
      await assertSendNamesNoMachine(page);
      taken = await shot(page, `box-routes-${tag}`, null);
      assert.equal(await send(page).isDisabled(), false);
      await send(page).click();
      await page.locator('[data-viewing="m4:p"]').waitFor();
      assert.deepEqual(await routed(page), [
        { environmentId: "m4", projectId: "p", text: "time now?" },
      ]);
      assert.equal(await chip(page), "On m4");
      assert.equal(await page.locator("[data-workers-only]").count(), 0);
      await assertSendNamesNoMachine(page);
      const after = await shot(page, `box-routes-sent-shows-m4-${tag}`, null);
      results.push({ theme, width, case: "box: routes (AC-07)", ...taken, after });
      await page.close();

      // "Continue here" beside the line runs the page's continue.
      page = await boxPage("routes");
      await page.locator("[data-continue-here]").click();
      assert.deepEqual(await events(page), ["continue:m5:p"]);
      await page.locator("[data-coordinator-here]").waitFor();
      await page.close();

      // AC-08, row by row.
      const blocked = [
        {
          state: "unloaded",
          line: "Connect m4 first. This window has not opened Atlas on m4, so it cannot hand the coordinator off yet.",
          continueEnabled: false,
          note: "connect m4 first",
        },
        {
          state: "not-ready",
          line: "m5 cannot continue the coordinator yet. Update SpecWithCode there, or connect to it with permission to change settings and run work.",
          continueEnabled: false,
          note: "not ready",
        },
        {
          state: "waiting",
          line: "m4 is not answering. Continue here unlocks in 7 min.",
          continueEnabled: false,
          note: "in 7 min",
        },
        {
          state: "read-only",
          line: "This window can only read m4, so it cannot send there. Open SpecWithCode on m4, or connect to it with full access.",
          continueEnabled: false,
          note: "read-only on m4",
        },
        {
          state: "files",
          line: "Files stay on this machine. Remove them to send the text, or open Atlas on m4 to attach them there.",
          continueEnabled: true,
          note: "Continue here syncs m5, then moves the coordinator conversation here from m4.",
        },
      ];
      for (const row of blocked) {
        page = await boxPage(row.state);
        assert.equal(
          await page.locator("[data-box-state]").getAttribute("data-box-state"),
          row.state,
        );
        assert.equal(await line(page), row.line);
        await prompt(page).fill("is the build green?");
        assert.equal(await send(page).isDisabled(), true, `${row.state}: Send is greyed`);
        await prompt(page).press("Enter");
        assert.equal(await prompt(page).inputValue(), "is the build green?", "the text stays");
        assert.deepEqual(await routed(page), []);
        const button = page.locator("[data-continue-here]");
        assert.equal(await button.isDisabled(), !row.continueEnabled, `${row.state}: Continue`);
        const note = page.locator("[data-continue-here-note]");
        assert.equal((await note.count()) ? await note.textContent() : null, row.note);
        await assertSendNamesNoMachine(page);
        taken = await shot(page, `box-${row.state}-${tag}`, null);
        results.push({ theme, width, case: `box: ${row.state} (AC-08)`, ...taken });
        await page.close();
      }

      // The coordinator's machine refused the message just sent: the text stays, nothing went.
      page = await boxPage("refused");
      await prompt(page).fill("ship it?");
      await send(page).click();
      await page.locator('[data-box-state="refused"]').waitFor();
      assert.equal(
        await line(page),
        "m4 did not take the message: The coordinator is answering another message. Nothing was sent.",
      );
      assert.deepEqual(await routed(page), []);
      assert.deepEqual(await events(page), [
        "refused:m4:ship it?",
        "error:The coordinator is answering another message.",
      ]);
      assert.equal(await prompt(page).inputValue(), "ship it?");
      assert.equal(await send(page).isDisabled(), false);
      assert.equal(await page.locator("[data-continue-here]").isDisabled(), false);
      assert.equal(await viewing(page), "m5:p");
      await assertSendNamesNoMachine(page);
      taken = await shot(page, `box-refused-${tag}`, null);
      results.push({ theme, width, case: "box: refused", ...taken });
      await page.close();

      // Moved while typed: the line says so, nothing went, and Send goes to the new machine.
      page = await boxPage("moved");
      await prompt(page).fill("status?");
      await page.evaluate(() => window.__moveCoordinator?.("linux-mini"));
      await page.locator('[data-box-state="moved"]').waitFor();
      assert.equal(await line(page), "The coordinator moved to linux-mini. Nothing was sent.");
      assert.deepEqual(await routed(page), []);
      assert.equal(await send(page).isDisabled(), false);
      assert.equal(await prompt(page).inputValue(), "status?");
      await assertSendNamesNoMachine(page);
      taken = await shot(page, `box-moved-${tag}`, null);
      await send(page).click();
      await page.locator('[data-viewing="linux-mini:p"]').waitFor();
      assert.deepEqual(await routed(page), [
        { environmentId: "linux-mini", projectId: "p", text: "status?" },
      ]);
      results.push({ theme, width, case: "box: moved (AC-08)", ...taken });
      await page.close();

      // AC-09: silent 10 minutes or more. The box's own button continues here, then sends.
      page = await boxPage("silent");
      assert.equal(await page.locator("[data-box-state]").getAttribute("data-box-state"), "silent");
      assert.equal(
        await line(page),
        "m4 has been offline for 12 minutes. Continue here: the coordinator starts on m5 from the shared goal, memory and plan. Its conversation on m4 stays readable there, and m4 gives way when it is back.",
      );
      assert.equal(await page.locator("[data-continue-here]").count(), 0);
      assert.equal(await send(page).getAttribute("data-send-label"), "Continue here and send");
      await assertSendNamesNoMachine(page);
      await prompt(page).fill("pick up the plan");
      const fit = await sendLabelFit(page);
      assert.equal(fit.words, "Continue here and send");
      assert.ok(
        fit.needs <= fit.gets,
        `"${fit.words}" at ${width} px: ${fit.needs}px of text in ${fit.gets}px`,
      );
      assert.ok(fit.inside, `"${fit.words}" at ${width} px runs past the message box`);
      taken = await shot(page, `box-silent-continue-and-send-${tag}`, null);
      await send(page).click();
      await page.locator("[data-coordinator-here]").waitFor();
      await page.waitForFunction(() => (window.__events ?? []).length >= 2);
      assert.deepEqual(await events(page), ["continue:m5:p", "send-here:pick up the plan"]);
      assert.deepEqual(await routed(page), []);
      assert.equal(await chip(page), "On m5");
      await page.waitForFunction(() => document.querySelector("#project-prompt")?.value === "");
      results.push({ theme, width, case: "box: silent (AC-09)", ...taken });
      await page.close();

      // With files the button only continues; the draft, text and files, stays.
      page = await boxPage("silent-files");
      assert.equal(await send(page).getAttribute("data-send-label"), "Continue here");
      const filesFit = await sendLabelFit(page);
      assert.equal(filesFit.words, "Continue here");
      assert.ok(filesFit.needs <= filesFit.gets && filesFit.inside, "Continue here fits");
      await assertSendNamesNoMachine(page);
      await prompt(page).fill("with the notes");
      taken = await shot(page, `box-silent-files-${tag}`, null);
      await send(page).click();
      await page.locator("[data-coordinator-here]").waitFor();
      assert.deepEqual(await events(page), ["continue:m5:p"]);
      assert.equal(await prompt(page).inputValue(), "with the notes");
      assert.ok((await page.locator(".sws-composer-card").textContent()).includes("notes.pdf"));
      results.push({ theme, width, case: "box: silent with files (AC-09)", ...taken });
      await page.close();

      // The box's first-match order (round 3), through the real makeMainPath, mainOffer and
      // coordinatorBoxState: each pair of conditions resolves to the earlier state.
      if (theme === "light" && width === 1280) {
        page = await open("case=box&state=routes", width, 720);
        await page.locator("[data-workers-only]").waitFor();
        const order = [
          [{ mainLoaded: false, hasFiles: true }, "unloaded"],
          [{ mainLoaded: false, silentMinutes: 12 }, "unloaded"],
          [{ silentMinutes: 12, hasFiles: true }, "silent"],
          [{ silentMinutes: 12 }, "silent"],
          [{ silentMinutes: 12, takeoverReady: false, hasFiles: true }, "not-ready"],
          [{ silentMinutes: 3, hasFiles: true }, "waiting"],
          [{ silentMinutes: 3, takeoverReady: false }, "waiting"],
          [{ mayOperate: false, hasFiles: true, movedTo: "linux-mini" }, "read-only"],
          [{ hasFiles: true, movedTo: "linux-mini" }, "files"],
          [{ refused: "Busy." }, "refused"],
          [{}, "routes"],
        ];
        const got = await page.evaluate(
          (cases) => cases.map(([input]) => window.__boxKind(input)),
          order,
        );
        // Every row is checked; a wrong one fails the run after the shots are taken.
        for (const [index, [input, kind]] of order.entries())
          if (got[index] !== kind)
            orderFailures.push(`${JSON.stringify(input)}: expected ${kind}, got ${got[index]}`);
        results.push({ case: "box: first-match order", order: got });
        await page.close();
      }

      // 5. After an offline switch, and the Settings label.
      page = await open(`theme=${theme}&case=switched`, width, 720);
      const said = page.locator("[data-offline-switch]");
      await said.waitFor();
      assert.equal(
        await said.locator("p").textContent(),
        "The coordinator continued on m5 while m4 was offline. It started from the shared goal, memory and plan; the earlier conversation stays on m4 as history.",
      );
      assert.equal(await chip(page), "On m5");
      taken = await shot(page, `after-offline-switch-${tag}`, null);
      await said.locator("button").click();
      assert.equal(await page.locator("[data-offline-switch]").count(), 0);
      results.push({ theme, width, case: "after an offline switch", ...taken });
      await page.close();

      page = await open(`theme=${theme}&case=settings`, width, 400);
      await page.locator("[data-settings-label]").waitFor();
      assert.equal(
        await page.locator("[data-role-label]").textContent(),
        "Separate project · also on m3",
      );
      taken = await shot(page, `settings-separate-project-${tag}`, null);
      results.push({ theme, width, case: "Settings label", ...taken });
      await page.close();
    }
  assert.deepEqual(errors, []);

  // 6. Every catalog has the new words: none of them falls back to English. Selected by data
  // attributes only. A miss is recorded, and the run fails after the results are written.
  const english = {
    pills: ["Coordinator", "Extra coordinator"],
    reason: "This window cannot open linux-mini",
    continueItem: "Continue the coordinator here",
    group: "Atlas on your machines",
    line: "The coordinator for Atlas is on m4. Send opens it there.",
  };
  for (const lang of ["ru", "es", "zh-CN", "ja", "pt-BR", "ko", "de", "fr"]) {
    const misses = [];
    let page = await open(`theme=light&case=menu&lang=${lang}`);
    await openMenu(page);
    const said = {
      pills: await texts(page, "[data-row-pill]"),
      reason: await page.locator("[data-row-reason]").textContent(),
      continueItem: await page.locator("[data-orchestrator-continue]").textContent(),
      group: await page.locator('[role="menu"] [data-slot="menu-label"]').first().textContent(),
    };
    for (const [index, pill] of said.pills.entries())
      if (pill === english.pills[index]) misses.push(`pill "${pill}"`);
    if (said.reason === english.reason) misses.push(`greyed reason "${said.reason}"`);
    if (said.continueItem.includes(english.continueItem))
      misses.push(`item "${english.continueItem}"`);
    if (said.group === english.group) misses.push(`group label "${said.group}"`);
    // Longer words must still fit the 20rem menu: measured in every language, shot in each.
    const { file, layout: menuLayout } = await shot(page, `menu-${lang}-light`, '[role="menu"]');
    const names = await clippedNames(page);
    if (names.length) languageFailures.push(`${lang}: machine name cut short: ${names.join("; ")}`);
    await page.close();
    page = await open(`theme=light&case=box&state=routes&lang=${lang}`, 1280, 720);
    await page.locator("[data-workers-only]").waitFor();
    const boxLine = await page.locator("[data-box-line]").textContent();
    if (boxLine === english.line) misses.push(`box line "${boxLine}"`);
    if (lang === "ru") await shot(page, "box-routes-ru-light", null);
    await page.close();
    if (misses.length) languageFailures.push(`${lang}: not translated: ${misses.join("; ")}`);
    results.push({ lang, ...said, line: boxLine, misses, file, layout: menuLayout });
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  server.close();
}
const layout = results.flatMap((item) =>
  [item, item.fix, item.confirm, item.after]
    .filter((part) => part?.layout?.length)
    .map((part) => ({ file: part.file, problems: part.layout })),
);
await fs.writeFile(
  path.join(output, "main-switch.json"),
  JSON.stringify({ results, layout, orderFailures, languageFailures }, null, 2),
);
console.log(
  JSON.stringify({ shots: results.length, layout, orderFailures, languageFailures }, null, 2),
);
if (layout.length) {
  console.error(`Clipped or overlapping text in ${layout.length} shots.`);
  process.exitCode = 1;
}
if (orderFailures.length) {
  console.error(`Message box order: ${orderFailures.length} rows resolve to another state.`);
  process.exitCode = 1;
}
if (languageFailures.length) {
  console.error(`Eight-language loop: ${languageFailures.length} problems in the 8 catalogs.`);
  process.exitCode = 1;
}
