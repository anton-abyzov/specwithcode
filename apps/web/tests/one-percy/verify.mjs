// Headless check and screenshots of one Percy per Connect account (1448).
//
//   node apps/web/tests/one-percy/verify.mjs <out dir>               builds, then checks
//   node apps/web/tests/one-percy/verify.mjs <site dir> <out dir>    checks a built site
//
// Real StudioSidebar, Percy switch and confirmation, Threads pane and offline
// line over fictional machines (Studio is this machine; Laptop, Desktop, Tower
// and Mini). Light and dark, 390 px and 1280 px wide. Screenshots and
// receipt.json go to the out dir, outside the repository.
// Env: STUDIO_PLAYWRIGHT_MODULE (default playwright-core), STUDIO_CHROME (a
// headless Chromium or chrome-headless-shell). Always headless.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const repo = NodePath.resolve(here, "../../../..");
const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("usage: verify.mjs [site dir] <out dir>");
  process.exit(2);
}
let site;
let output;
if (args.length >= 2) {
  [site, output] = args.map((path) => NodePath.resolve(path));
} else {
  site = NodePath.join(repo, ".artifacts/one-percy/site");
  output = NodePath.resolve(args[0]);
  const build = NodeChildProcess.spawnSync(
    process.execPath,
    [
      NodePath.join(repo, "node_modules/vite-plus/bin/vp"),
      "build",
      "--config",
      NodePath.join(here, "vite.config.ts"),
    ],
    { cwd: NodePath.join(repo, "apps/web"), stdio: ["ignore", "ignore", "inherit"] },
  );
  if (build.status !== 0) {
    console.error("one percy: the fixture did not build");
    process.exit(1);
  }
}
await NodeFSP.mkdir(output, { recursive: true });

const { chromium } = NodeModule.createRequire(NodePath.join(repo, "apps/server/package.json"))(
  process.env.STUDIO_PLAYWRIGHT_MODULE ?? "playwright-core",
);
const server = NodeHttp.createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  const file = NodePath.resolve(site, `.${pathname === "/" ? "/index.html" : pathname}`);
  const mime =
    { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" }[
      NodePath.extname(file)
    ] ?? "text/html";
  const body = file.startsWith(site) ? await NodeFSP.readFile(file).catch(() => null) : null;
  if (body === null) res.writeHead(404).end();
  else res.writeHead(200, { "Content-Type": mime }).end(body);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.STUDIO_CHROME ? { executablePath: process.env.STUDIO_CHROME } : {}),
});

const failures = [];
const receipt = [];
const squash = (text) => text.replace(/\s+/g, " ").trim();

// Elements wider than the viewport, or text cut off inside its own box.
const overflow = (page) =>
  page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const found = [];
    if (document.documentElement.scrollWidth > width + 1)
      found.push(`page scrolls sideways (${document.documentElement.scrollWidth} > ${width})`);
    for (const node of document.querySelectorAll("[data-fixture-check] *")) {
      const box = node.getBoundingClientRect();
      if (box.width === 0) continue;
      if (box.right > width + 1 && getComputedStyle(node).position !== "fixed")
        found.push(
          `${node.tagName.toLowerCase()} "${node.textContent.slice(0, 40)}" ends past the edge`,
        );
    }
    return found.slice(0, 5);
  });

const checks = {
  async sidebar(page, fail) {
    const list = page.locator('.sws-side-actions [aria-label="Personal assistant"]');
    await list.waitFor();
    const rows = await list.locator("li").evaluateAll((items) =>
      items.map((row) => ({
        label: row.querySelector(".sws-side-row-label")?.textContent ?? null,
        hint: row.querySelector(".sws-side-row-hint")?.textContent ?? null,
        count: row.querySelector(".sws-count-waiting")?.textContent ?? null,
        text: row.textContent,
      })),
    );
    const linked = rows.find((row) => row.label === "Percy");
    if (!linked) fail(`no linked Percy row: ${JSON.stringify(rows)}`);
    else {
      if (/Studio|Laptop|Desktop|Tower/.test(linked.text))
        fail(`the linked row names a machine: ${linked.text}`);
      if (!linked.count?.startsWith("3")) fail(`the linked row counts ${linked.count}`);
    }
    const tower = rows.find((row) => row.label === "Percy on Tower");
    if (!tower || tower.hint !== "not joined")
      fail(`no "Percy on Tower · not joined": ${JSON.stringify(rows)}`);
    if (rows.length !== 2) fail(`${rows.length} assistant rows`);
    if ((await page.getByText("Link assistants").count()) > 0) fail("the link wizard is offered");
    const clipped = await list
      .locator(".sws-side-row-hint")
      .evaluateAll((hints) => hints.filter((hint) => hint.scrollWidth > hint.clientWidth).length);
    if (clipped > 0) fail(`${clipped} hints are clipped`);
    return { rows: rows.map(({ text: _text, ...row }) => row) };
  },

  async settings(page, fail) {
    const table = page.locator("[data-percy-shared-machines]");
    await table.waitFor();
    const title = await page.getByText("Use my Percy on Studio").first().textContent();
    const toggle = page.getByRole("switch", { name: "Use my Percy on Studio" });
    if ((await toggle.getAttribute("aria-checked")) !== "true") fail("the switch is not on");
    const states = Object.fromEntries(
      await page
        .locator("[data-share-machine]")
        .evaluateAll((rows) =>
          rows.map((row) => [
            row.getAttribute("data-share-machine"),
            row.querySelector("[data-share-state]")?.textContent,
          ]),
        ),
    );
    const want = {
      studio: "On",
      laptop: "On",
      desktop: "Off",
      tower: "Offline",
      mini: "Needs an update",
    };
    for (const [id, state] of Object.entries(want))
      if (states[id] !== state) fail(`${id} reads "${states[id]}", not "${state}"`);
    const laptop = squash(await page.locator('[data-share-machine="laptop"]').innerText());
    if (!laptop.includes("Runs the shared routines")) fail(`Laptop row: ${laptop}`);
    if (!laptop.includes("Memory in step")) fail(`Laptop row: ${laptop}`);
    if ((await page.locator('[data-share-machine="desktop"] [data-share-turn-on]').count()) !== 1)
      fail("Desktop offers no Turn on");
    // The switch is on: the merge is what the button undoes.
    const undo = page.locator('[data-percy-shared-undo="undo-merge"]');
    if ((await undo.count()) !== 1) fail("no Undo the merge");
    else if (squash(await undo.innerText()) !== "Undo the merge on Studio…")
      fail(`the undo button reads ${await undo.innerText()}`);
    return { title, states, laptop };
  },

  async dialog(page, fail) {
    const toggle = page.getByRole("switch", { name: "Use my Percy on Studio" });
    await toggle.waitFor();
    await toggle.click();
    const dialog = page.locator("[data-percy-shared-confirm]");
    await dialog.waitFor();
    await dialog.getByText("21 memory files").waitFor();
    // Each candidate's own checkbox; its accessible name also carries the hint.
    const box = (id) => dialog.locator(`[data-share-candidate="${id}"] [role="checkbox"]`).first();
    const ticks = {};
    for (const [name, id] of [
      ["Laptop", "laptop"],
      ["Desktop", "desktop"],
    ]) {
      ticks[name] = {
        checked: (await box(id).getAttribute("aria-checked")) === "true",
        disabled:
          (await box(id).getAttribute("aria-disabled")) === "true" ||
          (await box(id).getAttribute("data-disabled")) !== null,
      };
    }
    if (!ticks.Laptop.checked) fail("Laptop, listed under the account, is not ticked");
    if (ticks.Desktop.checked) fail("Desktop, not listed under the account, is ticked");
    if (ticks.Desktop.disabled) fail("Desktop cannot be ticked by hand");
    const desktop = squash(await dialog.locator('[data-share-candidate="desktop"]').innerText());
    if (!desktop.includes("Not listed under your Connect account"))
      fail(`Desktop reads: ${desktop}`);
    const laptop = squash(await dialog.locator('[data-share-candidate="laptop"]').innerText());
    if (laptop.includes("Not listed")) fail(`Laptop reads: ${laptop}`);
    return { ticks, desktop, laptop };
  },

  async chats(page, fail) {
    await page.getByText("Estimated tax for Q4").waitFor();
    const pane = squash(await page.locator("[data-fixture-pane]").innerText());
    const rows = await page
      .locator(".sws-thread-row")
      .evaluateAll((items) => items.map((row) => row.innerText.replace(/\s+/g, " ").trim()));
    const tagOf = {
      "Estimated tax for Q4": "Studio",
      "Morning briefing": "Laptop",
      "Flights to Lisbon": "Desktop",
    };
    for (const [title, machine] of Object.entries(tagOf)) {
      const row = rows.find((text) => text.includes(title));
      if (!row) fail(`no row for ${title}`);
      else if (!row.includes(machine)) fail(`${title} is not tagged ${machine}: ${row}`);
    }
    if (rows.some((row) => /another machine/i.test(row))) fail("a row says another machine");
    const offline = await page.locator("[data-linked-seat-offline]").allInnerTexts();
    if (offline.length !== 1 || offline[0] !== "Tower is offline: its chats appear when it is back")
      fail(`offline lines: ${JSON.stringify(offline)}`);
    if (/lives on|own private assistant/i.test(pane)) fail("the other-machine notice shows");
    return { rows, offline };
  },
};

for (const view of ["sidebar", "settings", "dialog", "chats"]) {
  for (const [width, height] of [
    [1280, 860],
    [390, 844],
  ]) {
    for (const theme of ["light", "dark"]) {
      const name = `${view}-${width}-${theme}`;
      const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
      const errors = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      const fail = (message) => failures.push(`${name}: ${message}`);
      await page.goto(`${origin}/?view=${view}&theme=${theme}`);
      let facts = null;
      try {
        facts = await checks[view](page, fail);
      } catch (error) {
        fail(String(error).split("\n")[0]);
      }
      await page.waitForFunction(() =>
        document.getAnimations().every((animation) => animation.playState !== "running"),
      );
      for (const found of await overflow(page)) fail(found);
      if (errors.length) fail(`page errors: ${errors.join(" | ")}`);
      const file = `${name}.png`;
      await page.screenshot({ path: NodePath.join(output, file), fullPage: view !== "dialog" });
      receipt.push({ view, width, theme, facts, screenshot: file });
      // The confirmation sends only the ticked machines, Desktop left out.
      if (view === "dialog" && width === 1280 && theme === "light") {
        await page.locator("[data-share-confirm]").click();
        await page.locator("[data-percy-shared-confirm]").waitFor({ state: "detached" });
        const sent = await page.evaluate(() =>
          window.fixtureCalls
            .filter((call) => call.command === "personalLink.setShared")
            .map((call) => ({ environmentId: call.environmentId, machines: call.input.machines })),
        );
        const machines = sent.flatMap((call) => [call.environmentId, ...(call.machines ?? [])]);
        if (machines.includes("desktop")) fail(`Desktop was sent: ${JSON.stringify(sent)}`);
        const laptopCall = sent.find((call) => call.environmentId === "laptop");
        if (!laptopCall) fail(`Laptop was not turned on: ${JSON.stringify(sent)}`);
        // Laptop keeps Mini, which it confirmed on its own, and adds Studio.
        else if (JSON.stringify(laptopCall.machines) !== JSON.stringify(["mini", "studio"]))
          fail(`Laptop's machines were replaced: ${JSON.stringify(laptopCall.machines)}`);
        const studioCall = sent.find((call) => call.environmentId === "studio");
        if (JSON.stringify(studioCall?.machines) !== JSON.stringify(["laptop"]))
          fail(`Studio was not sent exactly the ticks: ${JSON.stringify(studioCall)}`);
        receipt.push({ view: "dialog-confirm", sent });
      }
      console.log(`${name}: ${errors.length} page errors`);
      await page.close();
    }
  }
}
await browser.close();
server.close();
await NodeFSP.writeFile(
  NodePath.join(output, "receipt.json"),
  JSON.stringify({ at: new Date().toISOString(), headless: true, failures, receipt }, null, 2),
);
console.log(`screenshots: ${output}`);
console.log(failures.length ? failures.join("\n") : "one percy: all views pass");
process.exit(failures.length ? 1 : 0);
