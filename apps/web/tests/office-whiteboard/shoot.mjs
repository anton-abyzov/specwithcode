// Headless check and captures of the whiteboard editor (Excalidraw in its own
// frame) over an in-memory file: draws with Excalidraw's hotkeys, proves no key
// reaches the app around it, autosaves, reloads, round-trips an excalidraw.com
// file, shows the changed-on-disk banner, exports PNG, SVG and .excalidraw, and
// loads with every request outside the fixture refused (no CDN, no network).
// Captures light and dark. Always headless; serves the fixture only. Run:
//   node node_modules/vite-plus/bin/vp build --config apps/web/tests/office-whiteboard/vite.config.ts
//   node apps/web/tests/office-whiteboard/shoot.mjs /absolute/owned/report-dir
// Optional: STUDIO_PLAYWRIGHT_MODULE (a playwright-core entry), STUDIO_TEST_CHROMIUM.
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
const site = NodePath.resolve(
  process.env.OFFICE_FIXTURE_SITE ?? ".artifacts/office-whiteboard/site",
);
const output = NodePath.resolve(process.argv[2] ?? ".artifacts/office-whiteboard/evidence");
await NodeFSP.mkdir(output, { recursive: true });
const lifecycle = await NodeFSP.readFile(
  NodePath.resolve("apps/server/src/mcp/toolkits/office/fixtures/specweave-lifecycle.excalidraw"),
  "utf8",
);

const MIME = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".html": "text/html; charset=utf-8",
};
const served = [];
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    served.push(pathname);
    if (pathname === "/lifecycle.excalidraw") {
      return void res.writeHead(200, { "Content-Type": "application/json" }).end(lifecycle);
    }
    const file = NodePath.resolve(site, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(site + NodePath.sep)) return void res.writeHead(403).end();
    const body = await NodeFSP.readFile(file);
    res
      .writeHead(200, {
        "Content-Type": MIME[NodePath.extname(file)] ?? "application/octet-stream",
      })
      .end(body);
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
const passed = [];
const screenshots = [];
const refused = [];
const notes = new Set();
const fail = (where, what) => problems.push(`${where}: ${what}`);
const check = (where, ok, what) => (ok ? passed.push(`${where}: ${what}`) : fail(where, what));

async function open(query, options = {}) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    acceptDownloads: true,
    // Offline but for the fixture server.
    serviceWorkers: "block",
  });
  if (options.storage) {
    await context.addInitScript(
      (text) => sessionStorage.setItem("whiteboard", text),
      options.storage,
    );
  }
  const page = await context.newPage();
  page.on("pageerror", (error) => fail(query, `page error: ${error.message}`));
  page.on("console", (message) => {
    const text = message.text();
    // Export subsets fonts with code that needs eval, which the app's policy
    // refuses; Excalidraw then embeds the whole font. Recorded, not a failure.
    if (/glyph subsetting|workers for subsetting/.test(text))
      return void notes.add(text.split("\n")[0]);
    if (message.type() === "error" && !/Failed to load resource/.test(text))
      fail(query, `console: ${text}`);
  });
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(origin) || url.startsWith("data:") || url.startsWith("blob:"))
      return route.continue();
    refused.push(url);
    return route.abort();
  });
  await page.goto(`${origin}/?${query}`);
  const frame = page.frameLocator("iframe[data-whiteboard-frame]");
  await frame.locator(".excalidraw .App-menu_top, .excalidraw .App-toolbar").first().waitFor();
  await page.waitForSelector('[data-whiteboard-export="png"]:not([disabled])');
  // The frame's content, for evaluate().
  const handle = await page.waitForSelector("iframe[data-whiteboard-frame]");
  const inner = await handle.contentFrame();
  return { page, context, frame, inner };
}

async function shot(page, name) {
  const file = NodePath.join(output, `${name}.png`);
  await page.screenshot({ path: file });
  screenshots.push(file);
}

/** The canvas area inside the frame, in page coordinates. */
async function canvasBox(page) {
  const frameBox = await page.locator("iframe[data-whiteboard-frame]").boundingBox();
  return frameBox;
}

async function drag(page, from, to, options = {}) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  const steps = 8;
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(
      from.x + ((to.x - from.x) * i) / steps,
      from.y + ((to.y - from.y) * i) / steps,
    );
  }
  await page.mouse.up();
  if (options.settle !== false) await page.waitForTimeout(60);
}

const activeTool = (frame) =>
  frame
    .locator('.App-toolbar input[type="radio"]:checked, .App-toolbar [aria-checked="true"]')
    .first()
    .getAttribute("data-testid");

const appKeys = (page) => page.evaluate(() => window.appKeys.slice());
const saves = (page) => page.evaluate(() => window.saves.slice());
const lastSave = async (page) => {
  const all = await saves(page);
  return all.length > 0 ? JSON.parse(all[all.length - 1]) : null;
};
const live = (scene) => (scene?.elements ?? []).filter((element) => !element.isDeleted);
const waitForSaves = async (page, count) => {
  await page.waitForFunction((n) => window.saves.length >= n, count, { timeout: 8_000 });
};

// 1. Draw with the hotkeys -------------------------------------------------------
{
  const where = "draw";
  const { page, context, frame, inner } = await open("file=empty&theme=light");
  const box = await canvasBox(page);
  const at = (x, y) => ({ x: box.x + x, y: box.y + y });
  // Focus the canvas without drawing: the hand tool, then a click.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  const tools = [
    ["r", "toolbar-rectangle"],
    ["d", "toolbar-diamond"],
    ["o", "toolbar-ellipse"],
    ["a", "toolbar-arrow"],
    ["l", "toolbar-line"],
    ["p", "toolbar-freedraw"],
    ["t", "toolbar-text"],
    ["e", "toolbar-eraser"],
    ["h", "toolbar-hand"],
    ["v", "toolbar-selection"],
    ["2", "toolbar-rectangle"],
    ["3", "toolbar-diamond"],
    ["4", "toolbar-ellipse"],
    ["5", "toolbar-arrow"],
    ["6", "toolbar-line"],
    ["7", "toolbar-freedraw"],
    ["8", "toolbar-text"],
    ["0", "toolbar-eraser"],
    ["1", "toolbar-selection"],
  ];
  for (const [key, testId] of tools) {
    await page.keyboard.press(key);
    const active = await activeTool(frame);
    check(where, active === testId, `key ${key} picks ${testId} (got ${active})`);
  }

  // Shapes, drawn with their keys.
  await page.keyboard.press("r");
  await drag(page, at(400, 200), at(560, 290));
  await page.keyboard.press("o");
  await drag(page, at(650, 200), at(790, 290));
  await page.keyboard.press("d");
  await drag(page, at(880, 190), at(1020, 300));
  // Shift constrains the rectangle to a square.
  await page.keyboard.press("r");
  await page.keyboard.down("Shift");
  await drag(page, at(400, 400), at(530, 470));
  await page.keyboard.up("Shift");
  await page.keyboard.press("a");
  await drag(page, at(565, 245), at(645, 245));
  await page.keyboard.press("l");
  await drag(page, at(400, 560), at(620, 600));
  await page.keyboard.press("p");
  await drag(page, at(700, 560), at(840, 620));
  await page.keyboard.press("t");
  await page.mouse.click(box.x + 900, box.y + 420);
  await page.waitForTimeout(150);
  await page.keyboard.type("Hello whiteboard");
  await page.keyboard.press("Escape");
  await page.keyboard.press("v");
  await waitForSaves(page, 1);
  await page.waitForTimeout(1_200);
  let scene = await lastSave(page);
  const types = new Set(live(scene).map((element) => element.type));
  for (const type of ["rectangle", "ellipse", "diamond", "arrow", "line", "freedraw", "text"]) {
    check(where, types.has(type), `drew a ${type}`);
  }
  const square = live(scene)
    .filter((element) => element.type === "rectangle")
    .at(-1);
  check(
    where,
    square !== undefined && Math.abs(square.width - square.height) < 1,
    `Shift-drag draws a square (${square?.width}x${square?.height})`,
  );
  const text = live(scene).find((element) => element.type === "text");
  check(
    where,
    text?.text === "Hello whiteboard",
    `typed text lands in the drawing (${text?.text})`,
  );
  await shot(page, "draw-light");

  // Select all, duplicate, group, undo and redo.
  const before = live(scene).length;
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("ControlOrMeta+d");
  await page.waitForTimeout(1_200);
  scene = await lastSave(page);
  check(
    where,
    live(scene).length === before * 2,
    `Cmd/Ctrl+D duplicates (${before} to ${live(scene).length})`,
  );
  await page.keyboard.press("ControlOrMeta+z");
  await page.waitForTimeout(1_200);
  scene = await lastSave(page);
  check(where, live(scene).length === before, `Cmd/Ctrl+Z undoes (${live(scene).length})`);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await page.waitForTimeout(1_200);
  scene = await lastSave(page);
  check(
    where,
    live(scene).length === before * 2,
    `Cmd/Ctrl+Shift+Z redoes (${live(scene).length})`,
  );
  await page.keyboard.press("ControlOrMeta+z");
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("ControlOrMeta+g");
  await page.waitForTimeout(1_200);
  scene = await lastSave(page);
  const grouped = live(scene).filter((element) => (element.groupIds ?? []).length > 0).length;
  check(where, grouped === live(scene).length && grouped > 0, `Cmd/Ctrl+G groups (${grouped})`);

  // Alt-drag duplicates the selection.
  await page.keyboard.press("Escape");
  const count = live(scene).length;
  await page.mouse.click(box.x + 480, box.y + 200);
  await page.keyboard.down("Alt");
  await drag(page, at(480, 200), at(480, 720));
  await page.keyboard.up("Alt");
  await page.waitForTimeout(1_200);
  scene = await lastSave(page);
  check(
    where,
    live(scene).length > count,
    `Alt-drag duplicates (${count} to ${live(scene).length})`,
  );

  // Zoom keys and Space-drag pan change the view, not the drawing.
  const zoomOf = () =>
    frame
      .locator(".zoom-actions .reset-zoom-button, [data-testid='reset-zoom']")
      .first()
      .textContent();
  const zoomBefore = await zoomOf();
  await page.keyboard.press("ControlOrMeta+Equal");
  const zoomIn = await zoomOf();
  check(where, zoomIn !== zoomBefore, `Cmd/Ctrl+= zooms in (${zoomBefore} to ${zoomIn})`);
  await page.keyboard.press("ControlOrMeta+Minus");
  await page.keyboard.press("ControlOrMeta+0");
  const zoomReset = await zoomOf();
  check(where, zoomReset === "100%", `Cmd/Ctrl+0 resets zoom (${zoomReset})`);
  const scrollBefore = await inner.evaluate(() =>
    JSON.stringify(
      document.querySelector(".excalidraw canvas.interactive")?.getBoundingClientRect(),
    ),
  );
  const savesBeforePan = (await saves(page)).length;
  await page.keyboard.down("Space");
  await drag(page, at(900, 500), at(1000, 600));
  await page.keyboard.up("Space");
  await page.waitForTimeout(1_200);
  check(
    where,
    (await saves(page)).length === savesBeforePan,
    "Space-drag pans without changing the file",
  );
  check(where, typeof scrollBefore === "string", "the canvas is there to pan");

  // ? opens Excalidraw's shortcut help.
  await page.keyboard.press("Shift+Slash");
  const help = await frame
    .locator(".HelpDialog, [class*='HelpDialog']")
    .first()
    .isVisible()
    .catch(() => false);
  check(where, help, "? opens the shortcut help");
  if (help) await shot(page, "help-light");
  await page.keyboard.press("Escape");

  // Not one of those keys reached the app's own listener.
  const leaked = await appKeys(page);
  check(where, leaked.length === 0, `no key reached the app's shortcuts (${leaked.join(", ")})`);
  await context.close();

  // 2. Reload what was saved ------------------------------------------------------
  const savedText = JSON.stringify(scene);
  const reopened = await open("file=stored&theme=dark", { storage: savedText });
  await reopened.page.waitForTimeout(800);
  const reopenedSaves = await saves(reopened.page);
  check("reload", reopenedSaves.length === 0, "opening a saved drawing writes nothing");
  const exported = await (async () => {
    const download = reopened.page.waitForEvent("download");
    await reopened.page.click('[data-whiteboard-export="excalidraw"]');
    const file = await download;
    const path = NodePath.join(output, "reloaded.excalidraw");
    await file.saveAs(path);
    return JSON.parse(await NodeFSP.readFile(path, "utf8"));
  })();
  check(
    "reload",
    live(exported).length === live(scene).length,
    `the reloaded drawing has every element (${live(exported).length}/${live(scene).length})`,
  );
  await shot(reopened.page, "draw-dark");
  await reopened.context.close();
}

// 3. An excalidraw.com file round-trips ---------------------------------------------
{
  const where = "round-trip";
  const original = JSON.parse(lifecycle);
  const { page, context } = await open("file=lifecycle&theme=light");
  await page.waitForTimeout(1_500);
  check(where, (await saves(page)).length === 0, "opening the file does not rewrite it");
  await shot(page, "lifecycle-light");
  for (const kind of ["png", "svg", "excalidraw"]) {
    const download = page.waitForEvent("download");
    await page.click(`[data-whiteboard-export="${kind}"]`);
    const file = await download;
    const path = NodePath.join(output, `lifecycle.${kind}`);
    await file.saveAs(path);
    const size = (await NodeFSP.stat(path)).size;
    check(where, size > 500, `Export ${kind} writes ${file.suggestedFilename()} (${size} bytes)`);
    if (kind === "svg") {
      const svg = await NodeFSP.readFile(path, "utf8");
      check(
        where,
        svg.includes("<svg") && svg.includes("Idea / Issue"),
        "the SVG holds the labels",
      );
    }
    if (kind === "excalidraw") {
      const json = JSON.parse(await NodeFSP.readFile(path, "utf8"));
      const ids = new Set(json.elements.map((element) => element.id));
      const missing = original.elements.filter((element) => !ids.has(element.id));
      check(where, missing.length === 0, `export keeps every element (${missing.length} missing)`);
      check(
        where,
        json.type === "excalidraw" && json.version === 2,
        "export is an Excalidraw v2 file",
      );
    }
  }
  // One edit saves the file with everything it had.
  const box = await canvasBox(page);
  await page.mouse.click(box.x + 40, box.y + box.height - 60);
  await page.keyboard.press("r");
  await drag(page, { x: box.x + 1000, y: box.y + 600 }, { x: box.x + 1100, y: box.y + 680 });
  await waitForSaves(page, 1);
  const saved = await lastSave(page);
  const ids = new Set(saved.elements.map((element) => element.id));
  const lost = original.elements.filter((element) => !ids.has(element.id));
  check(where, lost.length === 0, `saving keeps every element of the file (${lost.length} lost)`);
  const bound = saved.elements.filter((element) => element.containerId);
  check(
    where,
    bound.length === original.elements.filter((e) => e.containerId).length,
    "bound labels survive",
  );
  check(
    where,
    saved.appState.viewBackgroundColor === original.appState.viewBackgroundColor,
    "the background colour survives",
  );

  // 4. A change on disk while editing shows the banner ----------------------------
  await page.keyboard.press("o");
  await drag(
    page,
    { x: box.x + 1150, y: box.y + 600 },
    { x: box.x + 1250, y: box.y + 680 },
    { settle: false },
  );
  // Before the autosave fires, someone else writes the file.
  await page.evaluate((text) => window.externalWrite(text), lifecycle);
  await page.waitForSelector("[data-whiteboard-conflict]");
  check("conflict", true, "a change on disk while editing shows the banner");
  await shot(page, "conflict-light");
  await page.click("[data-whiteboard-conflict-reload]");
  await page.waitForTimeout(400);
  check(
    "conflict",
    (await page.locator("[data-whiteboard-conflict]").count()) === 0,
    "Reload latest clears the banner",
  );
  const leaked = await appKeys(page);
  check(where, leaked.length === 0, `no key reached the app's shortcuts (${leaked.join(", ")})`);
  await context.close();
}

// 5. Dark ----------------------------------------------------------------------------
{
  const { page, context } = await open("file=lifecycle&theme=dark");
  await page.waitForTimeout(1_000);
  const darkTheme = await page
    .frameLocator("iframe[data-whiteboard-frame]")
    .locator(".excalidraw.theme--dark")
    .count();
  check("theme", darkTheme === 1, "the editor is dark when the app is dark");
  await shot(page, "lifecycle-dark");
  await page.evaluate(() => window.setTheme("light"));
  await page.waitForTimeout(300);
  const lightAgain = await page
    .frameLocator("iframe[data-whiteboard-frame]")
    .locator(".excalidraw.theme--dark")
    .count();
  check("theme", lightAgain === 0, "the editor follows the app back to light");
  await context.close();
}

// 5b. Mermaid to Excalidraw ------------------------------------------------------------
// The only path through the Mermaid stack: a flowchart becomes shapes (new element
// ids from nanoid), a pie chart is parsed by Mermaid's chevrotain grammar (lodash-es)
// and lands as an image.
{
  const where = "mermaid";
  const { page, context, frame } = await open("file=empty&theme=light");
  const insert = async (source, settle) => {
    await frame.locator(".App-toolbar__extra-tools-trigger").click();
    await frame.getByText("Mermaid to Excalidraw").click();
    const input = frame.locator(".ttd-dialog-input");
    await input.fill(source);
    await frame
      .locator(".ttd-dialog-output-canvas-container canvas")
      .first()
      .waitFor({ timeout: 15_000 });
    await page.waitForTimeout(settle);
    await frame.locator(".ttd-dialog-panel-button", { hasText: "Insert" }).click();
    await frame.locator(".ttd-dialog").waitFor({ state: "detached", timeout: 5_000 });
  };
  try {
    await insert("flowchart LR\n  Start --> Review --> Ship", 800);
    await waitForSaves(page, 1);
    const flow = live(await lastSave(page));
    const labels = flow.filter((e) => e.type === "text").map((e) => e.text);
    check(
      where,
      ["Start", "Review", "Ship"].every((l) => labels.includes(l)),
      `flowchart inserts shapes (${labels.join(", ")})`,
    );
    check(
      where,
      new Set(flow.map((e) => e.id)).size === flow.length,
      "every inserted element has its own id",
    );
    const before = (await saves(page)).length;
    await insert('pie title Pets\n  "Dogs" : 3\n  "Cats" : 2', 1_500);
    await waitForSaves(page, before + 1);
    const images = live(await lastSave(page)).filter((e) => e.type === "image");
    check(where, images.length === 1, `pie chart inserts as an image (${images.length})`);
    await shot(page, "mermaid-light");
  } catch (error) {
    fail(where, `Mermaid dialog: ${error.message.split("\n")[0]}`);
  }
  await context.close();
}

// 6. Offline -------------------------------------------------------------------------
const fonts = served.filter((path) => path.startsWith("/excalidraw-assets/fonts/"));
check("offline", fonts.length > 0, `fonts come from the app bundle (${fonts.length} requests)`);
check(
  "offline",
  refused.length === 0,
  `nothing asked for the network (${[...new Set(refused)].slice(0, 5).join(", ")})`,
);

await browser.close();
server.close();
const report = {
  passed,
  problems,
  notes: [...notes],
  screenshots,
  fontsServed: [...new Set(fonts)],
  refused,
};
await NodeFSP.writeFile(NodePath.join(output, "result.json"), JSON.stringify(report, null, 2));
for (const line of passed) console.log(`ok   ${line}`);
for (const line of problems) console.log(`FAIL ${line}`);
console.log(`${passed.length} passed, ${problems.length} failed; captures in ${output}`);
process.exitCode = problems.length === 0 ? 0 : 1;
