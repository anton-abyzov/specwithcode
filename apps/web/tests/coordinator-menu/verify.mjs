// Build first: vp build --config apps/web/tests/coordinator-menu/vite.config.ts
// Usage: node apps/web/tests/coordinator-menu/verify.mjs [/absolute/evidence-dir]
// Always headless. Playwright comes from STUDIO_PLAYWRIGHT_MODULE, else apps/server's
// playwright-core; STUDIO_CHROMIUM_EXECUTABLE picks a browser binary.
// Checks and shoots, light and dark: the machine menu on a copy ("Make m5 main"), the
// copy's message box, the page after an offline switch, and three unlinked checkouts.
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
/** One page of the fixture; a script error anywhere fails the run. */
async function open(query, viewport = { width: 560, height: 600 }) {
  // The page's own background follows the system appearance, so that is set with the theme.
  const colorScheme = /(^|&)theme=dark(&|$)/.test(query) ? "dark" : "light";
  const page = await browser.newPage({ viewport, colorScheme });
  page.on("pageerror", (error) => errors.push(`${query}: ${error.message}`));
  await page.goto(`${origin}/?${query}`);
  return page;
}
async function openMenu(page) {
  await page.locator("[data-coordinator-machine]").click();
  await page.locator('[role="menu"]').waitFor();
  await page.waitForTimeout(250);
}
const shot = async (page, name) => {
  const file = path.join(output, `${name}.png`);
  await page.screenshot({ path: file });
  return file;
};
const texts = (page, selector) => page.locator(selector).allTextContents();
const madeMain = (page) => page.evaluate(() => window.__madeMain ?? []);

try {
  for (const theme of ["light", "dark"]) {
    // The menu on a copy's own page. Main is reachable: the switch moves the coordinator.
    let page = await open(`theme=${theme}&view=m5`);
    await openMenu(page);
    assert.deepEqual(await texts(page, '[role="menuitemradio"]'), [
      "m4Main",
      "m5Copy · main on m4",
      "linux-minicoordinator paused",
    ]);
    // One per linked copy, the viewed one included; main itself has none.
    assert.deepEqual(await texts(page, "[data-orchestrator-make-main]"), [
      "Make m5 main",
      "Make linux-mini main",
    ]);
    const items = await texts(page, '[role="menuitem"]');
    assert.equal(
      items.some((text) => /Move coordinator|Start|again/i.test(text)),
      false,
    );
    assert.equal(await page.locator("[data-orchestrator-unlinked-note]").count(), 0);
    let file = await shot(page, `menu-on-copy-make-main-${theme}`);
    await page.locator('[data-orchestrator-make-main="m5:p"]').click();
    await page.locator('[role="menu"]').waitFor({ state: "detached" });
    assert.deepEqual(await madeMain(page), ["m5:p"]);
    results.push({ theme, case: "menu on a copy", items, file });
    await page.close();

    // Main was lost a moment ago: the item is there, off, and says when it unlocks.
    page = await open(`theme=${theme}&view=m5&main=lost`);
    await openMenu(page);
    const waiting = page.locator('[data-orchestrator-make-main="m5:p"]');
    assert.equal(await waiting.textContent(), "Make m5 mainin 7 min");
    assert.equal(await waiting.getAttribute("aria-disabled"), "true");
    assert.match(await waiting.getAttribute("title"), /unlocks in 7 min/);
    file = await shot(page, `menu-on-copy-make-main-waiting-${theme}`);
    results.push({ theme, case: "menu on a copy, main just lost", file });
    await page.close();

    // The copy's message box: where main is, and the two ways on.
    page = await open(`theme=${theme}&case=box`, { width: 720, height: 520 });
    const box = page.locator("[data-workers-only]");
    await box.waitFor();
    assert.equal(
      await box.locator("p").first().textContent(),
      "Main for Atlas is m4. This copy takes work from there.",
    );
    assert.deepEqual(await texts(page, "[data-workers-only] button"), [
      "Write to m4's coordinator",
      "Make m5 main",
    ]);
    assert.equal(
      await page.locator("[data-write-to-main-note]").textContent(),
      "Write opens m4's page for this project, where its coordinator answers. Nothing is sent from here.",
    );
    assert.equal(
      await page.locator("[data-make-main-note]").textContent(),
      "Making m5 main moves the coordinator and its conversation here from m4, which becomes a copy.",
    );
    // Nothing typed here could go anywhere, so the box is off and says where to write.
    const prompt = page.locator("#project-prompt");
    assert.equal(await prompt.isDisabled(), true);
    assert.equal(await prompt.getAttribute("placeholder"), "Work for Atlas starts on m4.");
    const send = page.locator(".sws-composer-card button.sws-send");
    assert.equal(await send.isDisabled(), true);
    assert.equal(await send.getAttribute("data-send-label"), null);
    assert.equal(await page.locator(".sws-composer-card[data-inert]").count(), 1);
    file = await shot(page, `copy-message-box-${theme}`);
    await page.locator("[data-make-main]").click();
    assert.deepEqual(await madeMain(page), ["m5:p"]);
    // Writing opens main's page; nothing is sent from the copy.
    await page.locator("[data-write-to-main]").click();
    await page.locator('[data-viewing="m4:p"]').waitFor();
    assert.equal(await page.locator("[data-workers-only]").count(), 0);
    results.push({ theme, case: "copy's message box", file });
    await page.close();

    page = await open(`theme=${theme}&case=box&main=lost&kept=1`, { width: 720, height: 520 });
    await page.locator("[data-workers-only]").waitFor();
    assert.equal(await page.locator("[data-make-main]").isDisabled(), true);
    assert.equal(
      await page.locator("[data-make-main-note]").textContent(),
      "m4 must be unreachable for 10 minutes before m5 can become main. That unlocks in 7 min.",
    );
    assert.match(
      await page.locator("[data-workers-only] p").first().textContent(),
      /The conversation here is kept as history\.$/,
    );
    assert.equal(await page.locator(".sws-composer-card button.sws-send").isDisabled(), true);
    assert.equal(await page.locator("#project-prompt").isDisabled(), true);
    file = await shot(page, `copy-message-box-waiting-${theme}`);
    results.push({ theme, case: "copy's message box, main just lost", file });
    await page.close();

    page = await open(`theme=${theme}&case=box&main=gone`, { width: 720, height: 520 });
    await page.locator("[data-workers-only]").waitFor();
    assert.equal(await page.locator("[data-make-main]").isDisabled(), false);
    assert.equal(
      await page.locator('[data-make-main-note="takeover"]').textContent(),
      "m4 has been unreachable for 10 minutes or more. Making m5 main starts from the shared goal, memory and plan; the conversation on m4 stays there as history.",
    );
    assert.equal(await page.locator(".sws-composer-card button.sws-send").isDisabled(), true);
    file = await shot(page, `copy-message-box-main-unreachable-${theme}`);
    results.push({ theme, case: "copy's message box, main unreachable", file });
    await page.close();

    // m5's page from records like the M5's of November 17, 2026: main is m4 everywhere on
    // the page (not m1, whose side coordinator has a higher epoch), and Send routes to m4.
    page = await open(`theme=${theme}&case=m5`, { width: 760, height: 560 });
    const routedBox = page.locator("[data-workers-only]");
    await routedBox.waitFor();
    assert.equal(
      await page.locator("[data-followed-main]").getAttribute("data-followed-main"),
      "m4",
    );
    assert.equal(await page.locator("[data-move-source]").getAttribute("data-move-source"), "m4");
    assert.equal(
      await routedBox.locator("p").first().textContent(),
      "Main for Atlas is m4. This copy takes work from there.",
    );
    assert.equal(
      await page.locator("[data-make-main-note]").textContent(),
      "Making m5 main moves the coordinator and its conversation here from m4, which becomes a copy.",
    );
    assert.equal(
      await page.locator("[data-routes-to-main]").textContent(),
      "Send delivers your message to m4's coordinator and opens its page, where the answer comes.",
    );
    assert.equal(await page.locator("[data-write-to-main-note]").count(), 0);
    const routedPrompt = page.locator("#project-prompt");
    assert.equal(await routedPrompt.isDisabled(), false);
    assert.equal(
      await routedPrompt.getAttribute("placeholder"),
      "Message m4's coordinator for Atlas.",
    );
    await routedPrompt.fill("time now?");
    file = await shot(page, `m5-routes-to-m4-${theme}`);
    const routedSend = page.locator(".sws-composer-card button.sws-send");
    // The chip under the box and Send name one machine: main, where the coordinator runs.
    assert.deepEqual(await page.locator(".sws-host-name").allTextContents(), ["Runs on m4"]);
    assert.equal(await routedSend.getAttribute("data-send-label"), "Send to m4");
    // The menu still names and acts on the copy being viewed.
    const chip = page.locator("[data-coordinator-machine]");
    assert.equal(await chip.getAttribute("aria-label"), "Viewing m5. Choose a machine to view");
    await chip.click();
    assert.ok(
      (await page.locator('[role="menu"]').textContent()).includes("On m5"),
      "the machine actions are the viewed copy's",
    );
    await page.keyboard.press("Escape");
    assert.equal(await routedSend.isDisabled(), false);
    await routedSend.click();
    await page.waitForFunction(() => (window.__routed ?? []).length === 1);
    assert.deepEqual(await page.evaluate(() => window.__routed), [
      { environmentId: "m4", projectId: "p", text: "time now?" },
    ]);
    await page.locator("[data-make-main]").click();
    assert.deepEqual(await madeMain(page), ["m5:p"]);
    results.push({ theme, case: "m5 state, routed send and move from m4", file });
    await page.close();

    // m4 unreachable: Send cannot route and names no machine; the chip still names m4.
    page = await open(`theme=${theme}&case=m5&main=lost`, { width: 760, height: 560 });
    await page.locator("[data-workers-only]").waitFor();
    assert.deepEqual(await page.locator(".sws-host-name").allTextContents(), ["Runs on m4"]);
    const offSend = page.locator(".sws-composer-card button.sws-send");
    assert.equal(await offSend.getAttribute("data-send-label"), null);
    assert.equal(await offSend.isDisabled(), true);
    await page.close();

    // After an offline switch: the new main says where the earlier conversation is.
    page = await open(`theme=${theme}&case=switched`, { width: 720, height: 520 });
    const said = page.locator("[data-offline-switch]");
    await said.waitFor();
    assert.equal(
      await said.locator("p").textContent(),
      "m5 became main while m4 was unreachable. It started from the shared goal, memory and plan; the earlier conversation stays on m4 as history.",
    );
    file = await shot(page, `after-offline-switch-${theme}`);
    await said.locator("button").click();
    assert.equal(await page.locator("[data-offline-switch]").count(), 0);
    results.push({ theme, case: "after an offline switch", file });
    await page.close();

    // Checkouts of one repository that were never linked: Link, never a coordinator move.
    page = await open(`theme=${theme}&case=unlinked`);
    await openMenu(page);
    assert.deepEqual(await texts(page, '[role="menuitemradio"]'), [
      "m1not linked",
      "m3not linked",
      "m4not linked",
    ]);
    assert.equal(
      await page.locator("[data-orchestrator-unlinked-note]").textContent(),
      "Not linked: these are separate projects for this repository, each with its own coordinator, threads and memory. That does not stop you viewing or messaging any of them. Link them below to make one project.",
    );
    assert.deepEqual(await texts(page, "[data-orchestrator-link]"), [
      "Link m1 to this project…",
      "Link m3 to this project…",
    ]);
    assert.equal(await page.locator("[data-orchestrator-make-main]").count(), 0);
    assert.equal(
      (await texts(page, '[role="menuitem"]')).some((text) => /Move coordinator/.test(text)),
      false,
    );
    file = await shot(page, `menu-unlinked-link-${theme}`);
    results.push({ theme, case: "unlinked trio", file });
    await page.close();

    // Settings > Machines: an unlinked copy that exists elsewhere is Not linked.
    page = await open(`theme=${theme}&case=settings`);
    await page.locator("[data-settings-label]").waitFor();
    assert.equal(await page.locator("[data-role-label]").textContent(), "Not linked · also on m3");
    file = await shot(page, `settings-not-linked-${theme}`);
    results.push({ theme, case: "Settings label", file });
    await page.close();
  }

  // Every catalog has the new words: none of them falls back to English.
  for (const lang of ["ru", "es", "zh-CN", "ja", "pt-BR", "ko", "de", "fr"]) {
    let page = await open(`theme=light&view=m5&lang=${lang}`);
    await openMenu(page);
    const item = await page.locator('[data-orchestrator-make-main="m5:p"]').textContent();
    assert.match(item, /m5/);
    assert.notEqual(item, "Make m5 main", `${lang}: the menu item is not translated`);
    const file = lang === "ru" ? await shot(page, "menu-on-copy-make-main-ru-light") : undefined;
    await page.close();
    page = await open(`theme=light&case=box&lang=${lang}`, { width: 720, height: 520 });
    await page.locator("[data-workers-only]").waitFor();
    const said = await page.locator("[data-workers-only]").textContent();
    assert.match(said, /Atlas/);
    assert.doesNotMatch(said, /Main for Atlas|Write to m4|Make m5 main|Nothing is sent/, lang);
    assert.notEqual(
      await page.locator("#project-prompt").getAttribute("placeholder"),
      "Work for Atlas starts on m4.",
      `${lang}: the placeholder is not translated`,
    );
    if (lang === "ru") await shot(page, "copy-message-box-ru-light");
    results.push({ lang, item, ...(file ? { file } : {}) });
    await page.close();
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  server.close();
}
await fs.writeFile(path.join(output, "main-switch.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
