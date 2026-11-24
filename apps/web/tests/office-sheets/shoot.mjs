// Headless check and captures of the sheet viewer: the demo workbook's three
// tabs in light and dark, chart motion part-way and settled, the hover state,
// no motion for a person who asked for less or a chart with animate: false,
// and the Excel and Word previews when files are given. Always headless;
// serves the fixture only. Run after building:
//   node node_modules/vite-plus/bin/vp build --config apps/web/tests/office-sheets/vite.config.ts
//   node apps/web/tests/office-sheets/shoot.mjs /absolute/owned/report-dir
// Optional: OFFICE_XLSX and OFFICE_DOCX (files to preview, parsed by the real
// importers), STUDIO_PLAYWRIGHT_MODULE (a playwright-core entry), STUDIO_TEST_CHROMIUM,
// OFFICE_ONLY=editor (only the editor's key and edit checks, see editor.mjs).
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { editorChecks } from "./editor.mjs";

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = process.env.STUDIO_PLAYWRIGHT_MODULE
  ? await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href)
  : NodeModule.createRequire(NodePath.resolve("apps/server/package.json"))("playwright-core");
const site = NodePath.resolve(process.env.OFFICE_FIXTURE_SITE ?? ".artifacts/office-sheets/site");
const output = NodePath.resolve(process.argv[2] ?? ".artifacts/office-sheets/evidence");
await NodeFSP.mkdir(output, { recursive: true });

// Parsed previews of real files, through the importers the server runs.
const parsed = new Map();
if (process.env.OFFICE_XLSX) {
  const { readXlsxWorkbook } = await import(
    NodeURL.pathToFileURL(NodePath.resolve("apps/server/src/design/import/xlsxImport.ts")).href
  );
  const file = process.env.OFFICE_XLSX;
  const title = NodePath.basename(file, NodePath.extname(file));
  parsed.set(
    "/workbook.json",
    JSON.stringify(await readXlsxWorkbook(await NodeFSP.readFile(file), title)),
  );
}
if (process.env.OFFICE_DOCX) {
  const { readDocxDocument } = await import(
    NodeURL.pathToFileURL(NodePath.resolve("apps/server/src/design/import/docxImport.ts")).href
  );
  parsed.set(
    "/document.json",
    JSON.stringify(await readDocxDocument(await NodeFSP.readFile(process.env.OFFICE_DOCX))),
  );
}

// The demo workbook as the single HTML file the Export button writes.
{
  const load = (file) => import(NodeURL.pathToFileURL(NodePath.resolve(file)).href);
  const { demoWorkbook } = await load("apps/web/tests/office-sheets/sheets.ts");
  const { parseSheetDocument } = await load("packages/shared/src/officeSheet/model.ts");
  const { exportSheetToStandaloneHtml } = await load("packages/shared/src/officeSheet/export.ts");
  const checked = parseSheetDocument(demoWorkbook({ animate: true }));
  if (!checked.ok) throw new Error(checked.error);
  for (const mode of ["light", "dark"]) {
    const html = exportSheetToStandaloneHtml(checked.document, { mode });
    parsed.set(`/export-${mode}.html`, html);
    await NodeFSP.writeFile(NodePath.join(output, `export-${mode}.html`), html);
  }
}

const MIME = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (parsed.has(pathname)) {
      const type = pathname.endsWith(".html") ? "text/html; charset=utf-8" : "application/json";
      return void res.writeHead(200, { "Content-Type": type }).end(parsed.get(pathname));
    }
    const file = NodePath.resolve(site, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(site + NodePath.sep)) return void res.writeHead(403).end();
    const body = await NodeFSP.readFile(file);
    res.writeHead(200, { "Content-Type": MIME[NodePath.extname(file)] ?? "text/html" }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const executablePath = process.env.STUDIO_TEST_CHROMIUM ?? process.env.STUDIO_CHROME;
const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
});

const problems = [];
const screenshots = [];
const fail = (where, what) => problems.push(`${where}: ${what}`);

async function open(query, options = {}) {
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    reducedMotion: options.reducedMotion ?? "no-preference",
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => fail(query, `page error: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") fail(query, `console: ${message.text()}`);
  });
  await page.route("**/*", (route) =>
    route.request().url().startsWith(origin) ? route.continue() : route.abort(),
  );
  await page.goto(`${origin}/?${query}`);
  await page.waitForSelector(options.ready ?? ".office-chart");
  return { page, context };
}

async function shot(page, name) {
  const file = NodePath.join(output, `${name}.png`);
  await page.screenshot({ path: file });
  screenshots.push(file);
}

/** Chart animations that are still running. */
const running = (page) =>
  page.evaluate(
    () =>
      document
        .getAnimations()
        .filter(
          (animation) =>
            animation.playState === "running" &&
            animation.effect?.target?.closest?.(".office-chart"),
        ).length,
  );

const settle = (page) => page.waitForTimeout(1900);

// The editor: every key and edit, with Cmd and with Ctrl.
for (const [platform, mod] of [
  ["mac", "Meta"],
  ["other", "Control"],
]) {
  for (const [name, check] of Object.entries(editorChecks({ mod }))) {
    const where = `editor ${platform}: ${name}`;
    const { page, context } = await open(`view=edit&platform=${platform}`, { ready: ".office-grid" });
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    try {
      await check(page);
    } catch (error) {
      fail(where, error instanceof Error ? error.message.split("\n")[0] : String(error));
      await shot(page, `editor-failed-${platform}-${Object.keys(editorChecks({ mod })).indexOf(name)}`);
    }
    await context.close();
  }
}

// Captures of the editor, light and dark: editing a formula, the fill menu,
// the row menu and the shortcuts list.
for (const theme of ["light", "dark"]) {
  const mod = "Meta";
  const { page, context } = await open(`view=edit&platform=mac&theme=${theme}`, {
    ready: ".office-grid",
    viewport: { width: 1280, height: 760 },
  });
  await page.locator('[data-cell="C2"]').click();
  await page.keyboard.type("=SUM(");
  await page.locator('[data-cell="B2"]').click();
  await page.locator('[data-cell="B3"]').click({ modifiers: ["Shift"] });
  await shot(page, `editor-formula-${theme}`);
  await page.keyboard.press("Escape");
  await page.locator('[data-cell="A1"]').click();
  await page.keyboard.press("Shift+ArrowRight");
  await page.locator('[data-sheet-tool="fill"]').click();
  await page.locator('[data-sheet-fill="accent"]').waitFor();
  await page.waitForTimeout(300);
  await shot(page, `editor-fill-menu-${theme}`);
  await page.keyboard.press("Escape");
  await page.locator('[data-row-header="3"]').click({ button: "right" });
  await page.locator('[data-sheet-menu="rowAbove"]').waitFor();
  await page.waitForTimeout(300);
  await shot(page, `editor-row-menu-${theme}`);
  await page.keyboard.press("Escape");
  await page.locator('[data-cell="A1"]').click();
  await page.keyboard.press(`${mod}+Slash`);
  await page.locator("[data-sheet-shortcuts]").waitFor();
  await shot(page, `editor-shortcuts-${theme}`);
  await context.close();
}

if (process.env.OFFICE_ONLY !== "editor") {
  for (const theme of ["light", "dark"]) {
    for (const tab of ["Loan", "Investment", "Revenue"]) {
      const where = `${tab} ${theme}`;
      const { page, context } = await open(`tab=${tab}&theme=${theme}`);
      await page.waitForSelector(`.office-sheet-tabs > button[data-active="true"]:text-is("${tab}")`);
      if (theme === "light") {
        // Part-way through the entry: marks are moving.
        await page.waitForTimeout(260);
        if ((await running(page)) === 0) fail(where, "no chart animation runs on entry");
        await shot(page, `${tab.toLowerCase()}-entry`);
      }
      await settle(page);
      if ((await running(page)) !== 0) fail(where, "a chart animation is still running after 2 s");
      const errors = await page.locator(".office-grid td", { hasText: /^#[A-Z/0!?]+$/ }).count();
      if (errors > 0) fail(where, `${errors} cells show a formula error`);
      await shot(page, `${tab.toLowerCase()}-${theme}`);
      if (theme === "light" && tab === "Loan") {
        // The pointer on the line: a hairline, a ringed dot and the value.
        const plot = page.locator('[data-chart-id="balance"] .office-chart-plot');
        const box = await plot.boundingBox();
        await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.5);
        await page.waitForSelector('[data-chart-id="balance"] .office-chart-tip');
        await shot(page, "loan-hover");
        // The same from the keyboard.
        await page.mouse.move(2, 2);
        await plot.focus();
        await page.keyboard.press("ArrowRight");
        await page.keyboard.press("ArrowRight");
        const said = await page.locator('[data-chart-id="balance"] [aria-live]').textContent();
        if (!(said ?? "").startsWith("2: ")) fail(where, `the keyboard readout says "${said}"`);
      }
      if (theme === "light" && tab === "Revenue") {
        // A filter re-ranks the bars; they glide to their new places.
        const before = await page
          .locator('[data-chart-id="by-region"] .office-bars-label')
          .allTextContents();
        await page.locator('[data-chart-id="by-region"] [data-chart-sort]').selectOption("value-asc");
        await page.waitForTimeout(120);
        if ((await running(page)) === 0) fail(where, "bars do not move when the order changes");
        await shot(page, "revenue-reorder");
        await settle(page);
        const after = await page
          .locator('[data-chart-id="by-region"] .office-bars-label')
          .allTextContents();
        if (after.join() !== before.toReversed().join())
          fail(where, `sort gave ${after.join()} from ${before.join()}`);
        await page.locator('[data-chart-id="by-product"] .office-chart-legend > li').nth(1).hover();
        await page.waitForTimeout(300);
        await shot(page, "revenue-donut-hover");
      }
      await context.close();
    }
  }

  // Less motion, asked for by the person or by the chart: nothing animates.
  for (const [name, query, options] of [
    ["reduced-motion", "tab=Revenue", { reducedMotion: "reduce" }],
    ["animate-off", "tab=Revenue&animate=off", {}],
  ]) {
    const { page, context } = await open(query, options);
    await page.waitForSelector('.office-sheet-tabs > button[data-active="true"]:text-is("Revenue")');
    await page.waitForTimeout(120);
    if ((await running(page)) !== 0) fail(name, "a chart animation runs");
    const total = await page.locator(".office-chart-total").first().textContent();
    if (total === "0") fail(name, "the donut total counts up");
    await shot(page, name);
    await context.close();
  }

  if (parsed.has("/workbook.json")) {
    const { page, context } = await open("view=workbook", { ready: "[data-xlsx-preview]" });
    await page.waitForSelector(".office-grid");
    const tabs = page.locator(".office-sheet-tabs > button");
    const names = await tabs.allTextContents();
    for (const [index, name] of names.entries()) {
      await tabs.nth(index).click();
      await page.waitForSelector(`.office-sheet-tabs > button[data-active="true"]:text-is("${name}")`);
      const errors = await page.locator(".office-grid td", { hasText: /^#[A-Z/0!?]+$/ }).count();
      if (errors > 0) fail(`excel ${name}`, `${errors} cells show a formula error`);
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      await shot(page, index === 0 ? "excel-preview" : `excel-preview-${slug}`);
    }
    await context.close();
  }
  if (parsed.has("/document.json")) {
    const { page, context } = await open("view=document", {
      ready: "[data-docx-preview]",
      viewport: { width: 1100, height: 900 },
    });
    await shot(page, "word-preview");
    // A contents link scrolls to its heading and leaves the address alone.
    const link = page.locator("[data-docx-link]").last();
    if ((await link.count()) > 0) {
      const address = page.url();
      const target = await link.getAttribute("href");
      await link.click();
      await page.waitForTimeout(200);
      if (page.url() !== address) fail("word", `a link changed the address to ${page.url()}`);
      // The heading is at the top, or as near as a short document can scroll.
      const place = await page.locator(`[id="${target.slice(1)}"]`).evaluate((element) => {
        const scroller = element.closest("[data-docx-preview]");
        return {
          top: Math.round(element.getBoundingClientRect().top - scroller.getBoundingClientRect().top),
          atEnd: scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2,
          moved: scroller.scrollTop > 0,
        };
      });
      if (!place.moved || (place.top > 200 && !place.atEnd))
        fail("word", `the link's heading is ${place.top}px from the top`);
      await shot(page, "word-preview-link");
    }
    await context.close();
  }

  // The exported file: charts move with CSS alone, and not at all when asked for less.
  for (const [name, mode, reducedMotion] of [
    ["export-light", "light", "no-preference"],
    ["export-dark", "dark", "no-preference"],
    ["export-reduced-motion", "light", "reduce"],
  ]) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      deviceScaleFactor: 2,
      reducedMotion,
    });
    const page = await context.newPage();
    const requests = [];
    page.on("pageerror", (error) => fail(name, `page error: ${error.message}`));
    page.on("request", (request) => requests.push(request.url()));
    await page.goto(`${origin}/export-${mode}.html`);
    await page.waitForSelector(".chart-card");
    const moving = () =>
      page.evaluate(
        () => document.getAnimations().filter((animation) => animation.playState === "running").length,
      );
    await page.waitForTimeout(200);
    const count = await moving();
    if (reducedMotion === "reduce" ? count !== 0 : count === 0)
      fail(name, `${count} animations run 200 ms after opening`);
    if ((await page.locator("script").count()) > 0) fail(name, "the export holds a script");
    if (requests.length !== 1) fail(name, `the export made ${requests.length} requests`);
    if (name === "export-light") {
      await page.locator(".chart-card").first().scrollIntoViewIfNeeded();
      await shot(page, "export-entry");
    }
    await page.waitForTimeout(1800);
    if ((await moving()) !== 0) fail(name, "an animation is still running after 2 s");
    await page.screenshot({ path: NodePath.join(output, `${name}.png`), fullPage: true });
    screenshots.push(NodePath.join(output, `${name}.png`));
    await context.close();
  }
}

await browser.close();
server.close();
await NodeFSP.writeFile(
  NodePath.join(output, "report.json"),
  JSON.stringify({ problems, screenshots }, null, 2),
);
console.log(`${screenshots.length} captures in ${output}`);
if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
