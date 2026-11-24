// Headless check and captures of the Word editor over a real .docx: type,
// Word's keys, autosave, reload from disk, the shortcuts list, the link bar,
// the "changed on disk" banner and the loss banner, in light and dark. The
// file is written and read by the server's own writer and reader. Always
// headless; serves the fixture only. Run after building:
//   node node_modules/vite-plus/bin/vp build --config apps/web/tests/office-document/vite.config.ts
//   node apps/web/tests/office-document/shoot.mjs /absolute/owned/evidence-dir
// Optional: STUDIO_PLAYWRIGHT_MODULE (a playwright-core entry), STUDIO_TEST_CHROMIUM.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = process.env.STUDIO_PLAYWRIGHT_MODULE
  ? await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href)
  : NodeModule.createRequire(NodePath.resolve("apps/server/package.json"))("playwright-core");
const site = NodePath.resolve(process.env.OFFICE_FIXTURE_SITE ?? ".artifacts/office-document/site");
const output = NodePath.resolve(process.argv[2] ?? ".artifacts/office-document/evidence");
await NodeFSP.mkdir(output, { recursive: true });

const load = (file) => import(NodeURL.pathToFileURL(NodePath.resolve(file)).href);
const { buildDocx } = await load("apps/server/src/design/import/docxExport.ts");
const { openDocxForEditing } = await load("apps/server/src/design/import/docxEdit.ts");
const { markdownToDocument, documentPlainText } = await load(
  "packages/shared/src/officeDocument/markdown.ts",
);

// A scratch folder of its own; nothing in the repository or the app is touched.
const scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "office-document-fixture-"));
const file = NodePath.join(scratch, "field-notes.docx");
const seed = markdownToDocument(
  [
    "# Field notes",
    "",
    "The survey ran for **three days** across *two sites*. See [the plan](https://example.com/plan).",
    "",
    "## Findings",
    "",
    "- Water levels held steady",
    "- Two new nesting pairs",
    "  - one by the reeds",
    "",
    "| Site | Count |",
    "| --- | --- |",
    "| North | 14 |",
    "| South | 9 |",
    "",
    "> Counts are provisional until the second pass.",
  ].join("\n"),
);
await NodeFSP.writeFile(file, await buildDocx(seed));
const revisionOf = (bytes) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

const readBody = (req) =>
  new Promise((done, fail) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => done(Buffer.concat(chunks).toString("utf8")));
    req.on("error", fail);
  });

const MIME = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (pathname === "/open") {
      const bytes = await NodeFSP.readFile(file);
      const opened = await openDocxForEditing(new Uint8Array(bytes));
      return void res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ ...opened, revision: revisionOf(bytes) }));
    }
    if (pathname === "/save" && req.method === "POST") {
      const { document, expectedRevision } = JSON.parse(await readBody(req));
      const base = await NodeFSP.readFile(file);
      if (expectedRevision !== null && expectedRevision !== revisionOf(base)) {
        return void res.writeHead(409).end();
      }
      const bytes = await buildDocx(document, { base: new Uint8Array(base) });
      await NodeFSP.writeFile(file, bytes);
      return void res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ revision: revisionOf(bytes) }));
    }
    const target = NodePath.resolve(site, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!target.startsWith(site + NodePath.sep)) return void res.writeHead(403).end();
    const body = await NodeFSP.readFile(target);
    res.writeHead(200, { "Content-Type": MIME[NodePath.extname(target)] ?? "text/html" }).end(body);
  } catch (error) {
    res.writeHead(500).end(String(error));
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const executablePath = process.env.STUDIO_TEST_CHROMIUM ?? process.env.STUDIO_CHROME;
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });

const problems = [];
const screenshots = [];
const fail = (where, what) => problems.push(`${where}: ${what}`);
const check = (where, ok, what) => ok || fail(where, what);

async function open(query) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  page.on("pageerror", (error) => fail(query, `page error: ${error.message}`));
  page.on("console", (message) => {
    // The conflict step's stale save is refused with 409 on purpose.
    if (message.type() === "error" && !message.text().includes("409")) {
      fail(query, `console: ${message.text()}`);
    }
  });
  await page.route("**/*", (route) =>
    route.request().url().startsWith(origin) ? route.continue() : route.abort(),
  );
  await page.goto(`${origin}/?${query}`);
  await page.waitForSelector(".office-doc-page");
  return { page, context };
}

async function shot(page, name) {
  const target = NodePath.join(output, `${name}.png`);
  await page.screenshot({ path: target });
  screenshots.push(target);
}

const saved = (page) =>
  page.waitForSelector('.office-doc-status[data-save-state="saved"]', { timeout: 10_000 });
const diskText = async () =>
  documentPlainText((await openDocxForEditing(new Uint8Array(await NodeFSP.readFile(file)))).document);

// 1. Type, use Word's keys, autosave; the file on disk has it.
{
  const where = "edit";
  const { page, context } = await open("theme=light");
  await shot(page, "document-light-opened");
  const editor = page.locator(".office-doc-page");
  // The caret at the end of the first paragraph (Home and End differ by platform).
  const first = editor.locator("p").first();
  await first.click();
  await first.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.keyboard.press("Enter");
  await page.keyboard.press("ControlOrMeta+Alt+2");
  await page.keyboard.type("Next steps");
  check(where, (await editor.locator("h2", { hasText: "Next steps" }).count()) === 1, "Mod+Alt+2 made no heading");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Book the ");
  await page.keyboard.press("ControlOrMeta+b");
  await page.keyboard.type("second pass");
  await page.keyboard.press("ControlOrMeta+b");
  await page.keyboard.type(" for May.");
  check(where, (await editor.locator("strong", { hasText: "second pass" }).count()) === 1, "Mod+B made no bold");
  await page.keyboard.press("Enter");
  await page.keyboard.press("ControlOrMeta+Shift+8");
  await page.keyboard.type("Order rings");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await page.keyboard.type("size 4");
  check(where, (await editor.locator("ul ul li", { hasText: "size 4" }).count()) === 1, "Tab did not indent the item");
  await page.keyboard.press("ControlOrMeta+z");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  check(where, (await editor.locator("ul ul li", { hasText: "size 4" }).count()) === 1, "undo then redo lost the text");
  await saved(page);
  const text = await diskText();
  for (const expected of ["Next steps", "second pass", "size 4", "Counts are provisional"]) {
    check(where, text.includes(expected), `the saved file lacks "${expected}"`);
  }
  await shot(page, "document-light-edited");

  // Mod+K opens the link bar; Mod+/ the shortcuts list.
  await page.keyboard.press("ControlOrMeta+k");
  await page.waitForSelector(".office-doc-link-input");
  await shot(page, "document-link-bar");
  await page.keyboard.press("Escape");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+/");
  await page.waitForSelector('[role="dialog"][aria-label="Keyboard shortcuts"]');
  await shot(page, "document-shortcuts");
  await context.close();
}

// 2. Reload: what was typed comes back from the file.
for (const theme of ["light", "dark"]) {
  const where = `reload ${theme}`;
  const { page, context } = await open(`theme=${theme}`);
  const editor = page.locator(".office-doc-page");
  check(where, (await editor.locator("h2", { hasText: "Next steps" }).count()) === 1, "the heading did not survive");
  check(where, (await editor.locator("strong", { hasText: "second pass" }).count()) === 1, "bold did not survive");
  check(where, (await editor.locator("ul ul li", { hasText: "size 4" }).count()) === 1, "the nested item did not survive");
  check(where, (await editor.locator("table td", { hasText: "North" }).count()) === 1, "the table did not survive");
  check(where, (await editor.locator('a[href="https://example.com/plan"]').count()) === 1, "the link did not survive");
  await shot(page, `document-${theme}`);
  await context.close();
}

// 3. Changed on disk while editing: the Sheets banner, then Keep my edits.
{
  const where = "conflict";
  const { page, context } = await open("theme=light");
  const other = markdownToDocument("# Field notes\n\nRewritten elsewhere.");
  await NodeFSP.writeFile(file, await buildDocx(other, { base: new Uint8Array(await NodeFSP.readFile(file)) }));
  await page.locator(".office-doc-page p").first().click();
  await page.keyboard.type(" Mine.");
  await page.waitForSelector("[data-document-conflict]", { timeout: 10_000 });
  await shot(page, "document-conflict");
  await page.locator("[data-document-conflict-keep]").click();
  await saved(page);
  check(where, (await diskText()).includes("Mine."), "Keep my edits did not write the edits");
  await context.close();
}

// 4. A save that would drop something waits for the person.
{
  const where = "loss";
  const { page, context } = await open("theme=dark&loss=1");
  await page.waitForSelector("[data-document-loss]");
  await page.locator(".office-doc-page p").first().click();
  await page.keyboard.type(" Held.");
  await page.waitForTimeout(1200);
  check(where, (await page.evaluate(() => window.saves)) === 0, "autosave ran before the loss was accepted");
  await shot(page, "document-loss-dark");
  await page.locator("[data-document-loss-accept]").click();
  await saved(page);
  check(where, (await diskText()).includes("Held."), "Save anyway did not save");
  await context.close();
}

await browser.close();
server.close();
await NodeFSP.copyFile(file, NodePath.join(output, "field-notes.docx"));
await NodeFSP.rm(scratch, { recursive: true, force: true });
await NodeFSP.writeFile(NodePath.join(output, "report.json"), JSON.stringify({ problems, screenshots }, null, 2));
console.log(`${screenshots.length} captures in ${output}`);
if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
