// Build first: node node_modules/vite-plus/bin/vp build --config apps/web/tests/integrations-tabs/vite.config.ts
// Then: node apps/web/tests/integrations-tabs/verify.mjs /absolute/report-dir
// Always headless. Serves the fixture only; every other request is aborted. Fictional data.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = process.env.STUDIO_PLAYWRIGHT_MODULE
  ? await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href)
  : NodeModule.createRequire(NodePath.resolve("apps/server/package.json"))("playwright-core");

const root = NodePath.resolve(".artifacts/integrations-tabs/site");
const output = NodePath.resolve(process.argv[2] ?? ".artifacts/integrations-tabs/evidence");
await NodeFSP.mkdir(output, { recursive: true });
const MIME = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = NodePath.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(root + NodePath.sep)) return void res.writeHead(403).end();
    const body = await NodeFSP.readFile(file);
    res.writeHead(200, { "Content-Type": MIME[NodePath.extname(file)] ?? "text/html" }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;

const TABS = ["Agent access", "MCP servers", "Devices", "Preview and recording"];
const checks = [];
const errors = [];
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.STUDIO_TEST_CHROMIUM
      ? { executablePath: process.env.STUDIO_TEST_CHROMIUM }
      : { channel: "chrome" }),
  });
  const open = async ({ width = 1100, ...query } = {}) => {
    const page = await browser.newPage({
      viewport: { width, height: 800 },
      reducedMotion: "reduce",
    });
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.route("**/*", (route) =>
      route.request().url().startsWith(origin) ? route.continue() : route.abort(),
    );
    await page.goto(`${origin}/?${new URLSearchParams(query)}`);
    await page.getByRole("tablist").waitFor();
    return page;
  };
  const where = (page) => page.evaluate(() => window.fixtureRouter.state.location.href);
  const noOverflow = async (page, label) =>
    NodeAssert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
      false,
      `${label}: the page scrolls sideways`,
    );
  const shot = (page, name) =>
    page.screenshot({ path: NodePath.join(output, `${name}.png`), fullPage: true });

  // Tabs, their panels and the keyboard.
  let page = await open();
  NodeAssert.deepEqual(await page.getByRole("tab").allInnerTexts(), TABS);
  NodeAssert.equal(await where(page), "/settings/integrations/access");
  NodeAssert.equal(
    await page.getByRole("tab", { selected: true }).innerText(),
    "Agent access",
    "the bare page opens the first tab",
  );
  await page.getByRole("tabpanel", { name: "Agent access" }).waitFor();
  await page.getByRole("tab", { name: "Agent access" }).focus();
  await page.keyboard.press("ArrowRight");
  await page.getByRole("tabpanel", { name: "MCP servers" }).waitFor();
  NodeAssert.equal(await where(page), "/settings/integrations/mcp");
  NodeAssert.equal(
    await page.evaluate(() => document.activeElement?.textContent),
    "MCP servers",
    "focus follows the arrow key",
  );
  await page.keyboard.press("End");
  await page.getByRole("tabpanel", { name: "Preview and recording" }).waitFor();
  await page.keyboard.press("ArrowRight");
  await page.getByRole("tabpanel", { name: "Agent access" }).waitFor();
  await page.getByRole("tab", { name: "Devices" }).click();
  await page.getByRole("tabpanel", { name: "Devices" }).waitFor();
  NodeAssert.equal(await page.getByRole("tabpanel").count(), 1);
  checks.push("Four tabs, one panel each, arrows, Home and End move and wrap");

  // The scope line and the one machine picker.
  await page.getByText("Set up on").waitFor();
  NodeAssert.equal(await page.getByTestId("settings-scope-status").innerText(), "Connected");
  NodeAssert.equal(
    await page.getByTestId("settings-scope-caption").innerText(),
    "Each machine keeps its own. Changes here only affect Desk.",
  );
  NodeAssert.equal(await page.getByTestId("settings-scope-seat").count(), 0);
  await page.getByRole("button", { name: "Machine: Desk" }).click();
  NodeAssert.equal(await page.getByRole("menuitemradio", { name: /All environments/ }).count(), 0);
  await page.getByRole("menuitemradio", { name: /Loft Mini/ }).click();
  // The picker stays open on a choice, as it does on the other settings pages.
  await page.keyboard.press("Escape");
  await page.getByRole("menu").waitFor({ state: "hidden" });
  NodeAssert.equal(await page.getByTestId("settings-scope-seat").innerText(), "You are on Desk");
  await page.getByRole("tab", { name: "MCP servers" }).click();
  await page.getByTestId("server-row").first().waitFor();
  NodeAssert.equal(
    await page.getByTestId("server-list-title").innerText(),
    "Your servers on Loft Mini",
  );
  NodeAssert.match(await page.getByTestId("server-row").first().innerText(), /Remote analytics/);
  // The built-in tools show that machine's own state: it is not a Mac.
  NodeAssert.match(await page.getByTestId("built-in-computer-use").innerText(), /Mac only/);
  NodeAssert.match(await page.getByTestId("built-in-chrome").innerText(), /Paired/);
  NodeAssert.match(await page.getByTestId("built-in-in-app-browser").innerText(), /Off/);
  await page.getByRole("button", { name: "Compare by AI tool" }).click();
  await page.getByRole("button", { name: "Remote analytics Claude Code details" }).waitFor();
  await page.getByRole("button", { name: "Compare by AI tool" }).click();
  NodeAssert.equal(
    await page.getByRole("combobox").count(),
    0,
    "the MCP section has no machine picker of its own",
  );
  await page.getByRole("tab", { name: "Preview and recording" }).click();
  NodeAssert.equal(await page.getByRole("button", { name: /^Machine:/ }).count(), 0);
  await page.close();
  checks.push("Set up on a machine, one picker, no All environments, seat line, MCP follows it");

  // Old links and settings search: the tab opens, the row scrolls into view, and
  // clearing the handled hash leaves the page on that tab.
  for (const [hash, tab, path] of [
    ["mcp-connections", "MCP servers", "/settings/integrations/mcp"],
    ["agent-browser-access", "Agent access", "/settings/integrations/access"],
    ["max-booted-devices", "Devices", "/settings/integrations/devices"],
    ["browser-default-zoom", "Preview and recording", "/settings/integrations/preview"],
  ]) {
    page = await open({ open: `/settings/integrations#${hash}` });
    await page.getByRole("tabpanel", { name: tab }).waitFor();
    await page.waitForFunction(() => !window.fixtureRouter.state.location.href.includes("#"));
    NodeAssert.equal(await where(page), path, `${hash}: the page left its tab`);
    NodeAssert.equal(await page.getByRole("tab", { selected: true }).innerText(), tab);
    await page.waitForFunction((id) => {
      const row = document.getElementById(id);
      if (!row) return false;
      const box = row.getBoundingClientRect();
      return box.top >= 0 && box.top < window.innerHeight;
    }, hash);
    await page.close();
  }
  checks.push("Old row links open the row's tab, scroll to the row and stay there");

  // Machine states.
  page = await open({ state: "single", open: "/settings/integrations/devices" });
  await page.getByText("Set up on").waitFor();
  NodeAssert.equal(await page.getByRole("button", { name: /^Machine:/ }).count(), 0);
  await page.close();
  page = await open({ state: "offline", open: "/settings/integrations/devices" });
  NodeAssert.match(
    await page.getByTestId("integrations-machine-away").innerText(),
    /Pick another machine above/,
  );
  NodeAssert.equal(await page.getByRole("switch").count(), 0);
  NodeAssert.equal(await page.getByRole("tab").count(), 4, "the tabs stay on an offline machine");
  await shot(page, "offline-1100-light");
  await page.close();
  page = await open({ state: "connecting", open: "/settings/integrations/devices" });
  NodeAssert.equal(
    await page.getByTestId("integrations-machine-away").innerText(),
    "Connecting to Loft Mini…",
  );
  NodeAssert.equal(await page.getByTestId("settings-scope-status").innerText(), "Connecting");
  await page.close();
  page = await open({ state: "viewonly", open: "/settings/integrations/access" });
  await page.getByTestId("integrations-machine-view-only").waitFor();
  // Out of reach for the pointer and the keyboard: a click and a focus both miss.
  const control = page.locator('[role="switch"]');
  const before = await control.getAttribute("aria-checked");
  const box = await control.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  NodeAssert.equal(await control.getAttribute("aria-checked"), before, "a view-only switch moved");
  NodeAssert.equal(
    await control.evaluate((element) => {
      element.focus();
      return document.activeElement === element;
    }),
    false,
    "a view-only row takes focus",
  );
  await page.keyboard.press("Tab");
  NodeAssert.equal(
    await page.evaluate(() => document.activeElement?.closest("[inert]") !== null),
    false,
  );
  await shot(page, "view-only-1100-light");
  await page.close();
  // Adding a server needs two rights. Without the second the tab says so, and its
  // rows stay in reach because the list gates its own buttons.
  page = await open({ state: "noterminal", open: "/settings/integrations/mcp" });
  await page.getByTestId("integrations-machine-view-only").waitFor();
  NodeAssert.equal(
    await page.getByTestId("integrations-machine-rows").getAttribute("inert"),
    null,
    "the MCP tab's rows went out of reach",
  );
  await page.close();
  page = await open({ state: "noterminal", open: "/settings/integrations/access" });
  await page.getByTestId("integrations-machine-rows").waitFor();
  NodeAssert.equal(await page.getByTestId("integrations-machine-view-only").count(), 0);
  await page.close();
  page = await open({ state: "unavailable", open: "/settings/integrations/mcp" });
  await page.getByText("This environment is no longer available.").first().waitFor();
  NodeAssert.equal(await page.getByRole("tab").count(), 4);
  await page.close();
  checks.push("One machine, offline, connecting, view only and a machine that left the list");

  // Guided add: one catalog server to two machines, each with its own files, result and Undo.
  page = await open({ state: "ready", open: "/settings/integrations/mcp" });
  const calls = () => page.evaluate(() => window.fixtureApplyCalls);
  const add = page.getByTestId("add-server");
  await page.getByTestId("add-server-paste").waitFor();
  NodeAssert.equal(await page.getByTestId("add-server-catalog").locator("li").count(), 6);
  await page.getByRole("button", { name: "Show all" }).click();
  NodeAssert.equal(await page.getByTestId("add-server-catalog").locator("li").count(), 7);
  await shot(page, "add-pick-1100-light");
  // A paste the app cannot use says why and offers the form.
  await page.getByTestId("add-server-paste").fill("claude mcp add -t sse x https://x.test/sse");
  await add.getByRole("button", { name: "Add", exact: true }).click();
  NodeAssert.match(await add.getByRole("alert").innerText(), /SSE server/);
  await page.getByTestId("add-server-paste").fill("");
  await page.getByRole("button", { name: "Add: Linear" }).click();
  await page.getByTestId("add-server-summary").waitFor();
  NodeAssert.equal(await page.getByTestId("add-server-name").innerText(), "linear");
  NodeAssert.equal(await add.getByRole("checkbox", { name: "Codex" }).isChecked(), true);
  NodeAssert.equal(await add.getByRole("checkbox", { name: "Claude Code" }).isChecked(), true);
  NodeAssert.match(
    await add.innerText(),
    /A thread sees this server when the tool it runs on is ticked\. Grok threads read Claude Code's list\./,
  );
  NodeAssert.equal(await page.getByTestId("add-server-where").innerText(), "On Desk only.");
  const loft = add.getByRole("checkbox", { name: "Loft Mini" });
  NodeAssert.equal(await loft.isChecked(), false, "another machine starts ticked");
  await loft.click();
  NodeAssert.equal(
    await page.getByTestId("add-server-where").innerText(),
    "On Desk and Loft Mini.",
  );
  await shot(page, "add-summary-1100-light");
  NodeAssert.deepEqual(await calls(), [], "a machine was asked before Review");
  await add.getByRole("button", { name: "Review" }).click();
  await page.getByTestId("add-server-review").waitFor();
  NodeAssert.deepEqual(
    await page
      .getByTestId("review-machine")
      .evaluateAll((machines) => machines.map((machine) => machine.dataset.machine)),
    ["Desk", "Loft Mini"],
  );
  for (const machine of await page.getByTestId("review-machine").all())
    NodeAssert.match(await machine.innerText(), /~\/\.codex\/config\.toml[\s\S]*~\/\.claude\.json/);
  NodeAssert.deepEqual(await calls(), [
    { environmentId: "mac", action: "add", preview: true },
    { environmentId: "remote", action: "add", preview: true },
  ]);
  await shot(page, "add-review-1100-light");
  await add.getByRole("button", { name: "Save on Desk and Loft Mini" }).click();
  await page.getByTestId("add-server-done").waitFor();
  const states = () =>
    page
      .getByTestId("add-server-result")
      .evaluateAll((rows) => rows.map((row) => row.dataset.state));
  NodeAssert.deepEqual(await states(), ["added", "added"]);
  await add.getByRole("button", { name: "Undo: Desk" }).waitFor();
  await add.getByRole("button", { name: "Undo: Loft Mini" }).waitFor();
  NodeAssert.deepEqual(
    await page.getByTestId("add-server-sign-in").locator("code").allInnerTexts(),
    ["codex mcp login linear", "claude mcp login linear"],
  );
  NodeAssert.match(
    await page.getByTestId("add-server-sign-in").innerText(),
    /Run it in a terminal on Desk and Loft Mini\./,
  );
  const row = page.getByTestId("server-row").filter({ hasText: "linear" });
  NodeAssert.match(await row.innerText(), /Added/);
  // The app cannot see sign-in state, so neither the row nor the result claims one.
  for (const part of [row, add])
    NodeAssert.doesNotMatch(await part.innerText(), /Needs sign-in|Connected|Signed in\b/);
  await shot(page, "add-done-1100-light");
  await add.getByRole("button", { name: "Undo: Loft Mini" }).click();
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('[data-testid="add-server-result"]')].map(
        (row) => row.dataset.state,
      )[1] === "undone",
  );
  NodeAssert.deepEqual(await states(), ["added", "undone"]);
  NodeAssert.deepEqual((await calls()).slice(2), [
    { environmentId: "mac", action: "add", preview: false },
    { environmentId: "remote", action: "add", preview: false },
    { environmentId: "remote", action: "undo", preview: false },
  ]);
  NodeAssert.equal(await row.count(), 1, "the selected machine lost its server to another's Undo");
  // The next add starts with no other machine ticked.
  await add.getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: "Add: Notion" }).click();
  NodeAssert.equal(await add.getByRole("checkbox", { name: "Loft Mini" }).isChecked(), false);
  await page.close();
  // A sign-in that cannot change files on the other machine sees it listed, never ticked.
  page = await open({ state: "ready", open: "/settings/integrations/mcp", width: 560 });
  await page.getByTestId("add-server-paste").waitFor();
  const tall = await page.getByRole("tabpanel").evaluate((panel) => panel.scrollHeight);
  NodeAssert.ok(tall <= 1800, `the MCP tab is ${tall} px tall at 560 x 800, over the 1,800 budget`);
  await noOverflow(page, "add 560");
  await page.getByRole("button", { name: "Add: Linear" }).click();
  await page.getByTestId("add-server-summary").waitFor();
  await noOverflow(page, "add summary 560");
  await shot(page, "add-summary-560-light");
  await page.close();
  checks.push(
    `Guided add reaches two machines with a review, a result and an Undo each; MCP tab is ${tall} px tall at 560 x 800`,
  );

  // Layout at the settings window's widths, in both themes and three languages.
  for (const width of [360, 390, 560, 728, 1100, 1600])
    for (const theme of ["light", "dark"])
      for (const locale of ["en", "de", "ru"]) {
        const label = `${width}-${theme}-${locale}`;
        page = await open({
          width,
          theme,
          locale,
          state: "other",
          open: "/settings/integrations/mcp",
        });
        await page.getByRole("tabpanel").waitFor();
        await noOverflow(page, label);
        const clipped = await page
          .getByRole("tab")
          .evaluateAll((tabs) =>
            tabs
              .filter((tab) => tab.scrollWidth > tab.clientWidth + 1)
              .map((tab) => tab.textContent),
          );
        NodeAssert.deepEqual(clipped, [], `${label}: a tab label is clipped`);
        const short = await page
          .getByRole("tab")
          .evaluateAll((tabs) =>
            tabs
              .filter((tab) => tab.getBoundingClientRect().height < 32)
              .map((tab) => tab.textContent),
          );
        NodeAssert.deepEqual(short, [], `${label}: a tab is under 32 px tall`);
        if (locale === "en" || width === 360 || width === 1100) await shot(page, `mcp-${label}`);
        await page.close();
      }
  checks.push(
    "No sideways scroll, clipped or short tab at 360 to 1600 px, light and dark, en/de/ru",
  );

  NodeAssert.deepEqual(errors, []);
  await NodeFSP.writeFile(
    NodePath.join(output, "browser.json"),
    JSON.stringify({ ok: true, headless: true, runtime: process.version, checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ ok: true, checks }));
} catch (error) {
  if (errors.length > 0) console.error("Page errors:", errors);
  throw error;
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}
