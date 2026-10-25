// Run after building apps/web/tests/design-workspace-1046/vite.config.ts.
// Serves fixture assets on an owned loopback port; no account, provider,
// network or live store access. Headless Chromium only; screenshots and
// report.json go to the directory given as the first argument.
// Light and dark at 360, 768 and 1280 px, and 1280 px at 200% zoom (640 CSS px at 2x).
// Optional filters: ONLY_SCENES=system,files  ONLY_THEMES=light  ONLY_SIZES=360,1280
import * as NodeAssert from "node:assert/strict";
import * as NodeHttp from "node:http";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";

const assert = NodeAssert.default;
const { createServer } = NodeHttp;
const { mkdir, readFile, writeFile } = NodeFSP;
const { join, resolve, sep } = NodePath;
const { createRequire } = NodeModule;

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const require = createRequire(resolve("apps/server/package.json"));
const { chromium } = require(process.env.STUDIO_PLAYWRIGHT_MODULE ?? "playwright-core");
const root = resolve(".artifacts/design-workspace-1046/site");
const output = resolve(process.argv[2] ?? ".artifacts/design-workspace-1046/evidence");
await mkdir(output, { recursive: true });

const types = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".html": "text/html",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(root + sep)) return res.writeHead(403).end();
    const body = await readFile(file);
    const type = types[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream";
    res.writeHead(200, { "Content-Type": type }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;

const filter = (name) => process.env[name]?.split(",").filter(Boolean) ?? null;
const ALL_SIZES = [
  { name: "360", viewport: { width: 360, height: 780 }, scale: 1 },
  { name: "768", viewport: { width: 768, height: 900 }, scale: 1 },
  { name: "1280", viewport: { width: 1280, height: 900 }, scale: 1 },
  { name: "1280-zoom200", viewport: { width: 640, height: 450 }, scale: 2 },
];
const SIZES = ALL_SIZES.filter(
  (size) => !filter("ONLY_SIZES") || filter("ONLY_SIZES").includes(size.name),
);
const THEMES = ["light", "dark"].filter(
  (theme) => !filter("ONLY_THEMES") || filter("ONLY_THEMES").includes(theme),
);
const wanted = (scene) => !filter("ONLY_SCENES") || filter("ONLY_SCENES").includes(scene);

const SECTION_TITLES = [
  "Overview",
  "Colors",
  "Typography",
  "Spacing",
  "Corner radius",
  "Shadows",
  "Duration",
  "Easing",
  "Breakpoint",
  "Z index",
  "Control",
  "Opacity",
  "Components",
  "Assets",
];
/** Stored (README, voice, two logos, a screen, a font) + two sources + tokens.css and tokens.json. */
const FILE_COUNT = 10;

const results = [];
const errors = [];
const shots = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: String(error?.stack ?? error) });
  }
};

let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.STUDIO_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE }
      : {}),
  });

  /** Opens a scene, runs `fn`, and always closes the page. */
  const withPage = async (theme, scene, size, fn) => {
    const page = await browser.newPage({
      reducedMotion: "reduce",
      viewport: size.viewport,
      deviceScaleFactor: size.scale,
      colorScheme: theme,
      acceptDownloads: true,
    });
    page.setDefaultTimeout(15_000);
    page.on("pageerror", (error) => errors.push(`${theme}/${scene}/${size.name}: ${error}`));
    page.on("console", (message) => {
      // A preview frame's HTML probe is meant to be refused by the frame CSP.
      const probe =
        message.location().url === "about:srcdoc" && /Content Security Policy/.test(message.text());
      if (message.type() === "error" && !probe)
        errors.push(
          `${theme}/${scene}/${size.name}: ${message.text()} (${message.location().url})`,
        );
    });
    await page.route("**/*", (route) =>
      route.request().url().startsWith(origin) ? route.continue() : route.abort(),
    );
    try {
      await page.goto(`${origin}/?theme=${theme}&scene=${scene}`);
      await fn(page);
    } finally {
      await page.close();
    }
  };
  const shot = async (page, name, theme, size) => {
    // Let entering menus, dialogs and toasts finish moving; infinite spinners are skipped.
    await page.evaluate(() =>
      Promise.race([
        Promise.all(
          document
            .getAnimations()
            .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
            .map((animation) => animation.finished.catch(() => null)),
        ),
        new Promise((done) => setTimeout(done, 2000)),
      ]),
    );
    await page.waitForTimeout(100);
    const file = `${name}-${theme}-${size.name}.png`;
    await page.screenshot({ path: join(output, file) });
    shots.push(file);
  };
  const calls = (page) => page.evaluate(() => window.__fixture.calls);
  const callFor = async (page, label) => {
    await page.waitForFunction(
      (label) => window.__fixture.calls.some((call) => call.label === label),
      label,
    );
    return (await calls(page)).findLast((call) => call.label === label);
  };
  const location = (page) => page.evaluate(() => window.__fixture.location());
  const wideLayout = (size) => size.viewport.width >= 768;
  const keySize = (size) => size.name === "1280" || size.name === "360";

  /** Nothing scrolls sideways at the page root. */
  const noOverflow = async (page) => {
    const sizes = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
      inner: window.innerWidth,
    }));
    assert.ok(
      sizes.document <= sizes.inner + 1 && sizes.body <= sizes.inner + 1,
      `no sideways scroll (${JSON.stringify(sizes)})`,
    );
  };
  /** A control is on screen once scrolled to: inside the viewport on both axes. */
  const inView = async (page, locator, label) => {
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    const { width, height } = page.viewportSize();
    assert.ok(box !== null, `${label} visible`);
    assert.ok(
      box.x >= -1 &&
        box.x + box.width <= width + 1 &&
        box.y >= -1 &&
        box.y + box.height <= height + 1,
      `${label} inside the ${width}x${height} viewport (${JSON.stringify(box)})`,
    );
  };
  const layout = async (page, controls) => {
    await noOverflow(page);
    for (const [label, locator] of controls) await inView(page, locator, label);
  };
  const systemPage = async (page) => {
    await page.getByTestId("design-system-page").waitFor();
    await page.getByTestId("section-add").first().waitFor();
  };
  /** Section titles and counts from the side column, or the Sections menu on narrow windows. */
  const sectionList = async (page, size) => {
    if (wideLayout(size)) {
      const rows = await page
        .locator("[data-testid=system-nav-list] [data-nav-section]")
        .evaluateAll((elements) =>
          elements.map((element) => {
            const spans = element.querySelectorAll(":scope > span");
            return {
              title: spans[0]?.textContent ?? "",
              count: spans.length > 1 ? spans[spans.length - 1].textContent : null,
            };
          }),
        );
      const files = await page.getByTestId("system-nav-files").textContent();
      return { rows, files };
    }
    await page.getByTestId("sections-menu").click();
    const menu = page.getByRole("menu");
    await menu.waitFor();
    const rows = await menu.getByRole("menuitemradio").evaluateAll((elements) =>
      elements.map((element) => {
        const spans = element.querySelectorAll("span span");
        return {
          title: element.querySelector(".truncate")?.textContent ?? "",
          count: spans.length > 1 ? spans[spans.length - 1].textContent : null,
        };
      }),
    );
    const files = await menu.getByRole("menuitem", { name: /Files/ }).textContent();
    return { rows, files, menu };
  };
  const scrollToSection = async (page, id) => {
    await page.evaluate((id) => {
      document.getElementById(`section-${id}`)?.scrollIntoView({ block: "start" });
    }, id);
    await page.waitForTimeout(250);
  };
  /** The read-only source view draws its lines in a shadow root. */
  const sourceShows = (page, text) =>
    page.waitForFunction((text) => {
      const host = document.querySelector("[data-testid=file-preview-source]");
      if (host === null) return false;
      let shown = "";
      const walk = (node) => {
        if (node.nodeType === Node.TEXT_NODE) shown += node.data;
        if (node.shadowRoot) walk(node.shadowRoot);
        for (const child of node.childNodes) walk(child);
      };
      walk(host);
      return shown.includes(text);
    }, text);
  const openFiles = async (page, size) => {
    if (wideLayout(size)) await page.getByTestId("system-nav-files").click();
    else {
      await page.getByTestId("sections-menu").click();
      await page.getByRole("menu").getByRole("menuitem", { name: /Files/ }).click();
    }
    await page.getByTestId("files-browser").waitFor();
  };

  for (const theme of THEMES) {
    for (const size of SIZES) {
      const tag = `${theme} ${size.name}`;

      if (wanted("system"))
        await check(`${tag}: system page sections, token tables and previews`, () =>
          withPage(theme, "system", size, async (page) => {
            await systemPage(page);
            assert.equal(await page.locator("h1").first().textContent(), "Harbor UI");
            await layout(page, [
              ["title menu", page.getByTestId("system-menu-trigger")],
              [
                wideLayout(size) ? "section column" : "Sections menu",
                wideLayout(size)
                  ? page.getByTestId("system-nav")
                  : page.getByTestId("sections-menu"),
              ],
            ]);
            await shot(page, "system", theme, size);
            const sections = await sectionList(page, size);
            assert.deepEqual(
              sections.rows.map((row) => row.title),
              SECTION_TITLES,
            );
            assert.equal(sections.rows.find((row) => row.title === "Colors").count, "21");
            assert.equal(sections.rows.find((row) => row.title === "Components").count, "3");
            assert.match(sections.files, new RegExp(`Files\\s*${FILE_COUNT}`));
            if (sections.menu) {
              await inView(page, sections.menu, "Sections menu popup");
              if (keySize(size)) await shot(page, "system-sections", theme, size);
              await page.keyboard.press("Escape");
            }

            await scrollToSection(page, "colors");
            const table = page.getByTestId("color-table");
            const headers = await table.getByRole("columnheader").allTextContents();
            assert.ok(headers.includes("Light") && headers.includes("Dark"), headers.join("|"));
            assert.equal(await table.locator("[role=cell][data-mode=light]").count(), 21);
            assert.equal(await table.locator("[role=cell][data-mode=dark]").count(), 21);
            const swatches = await table
              .locator("[role=cell][data-mode=dark] button[aria-label^='Copy'] > span")
              .evaluateAll((spans) => spans.map((span) => getComputedStyle(span).backgroundColor));
            assert.equal(swatches.length, 21);
            assert.ok(
              swatches.every((color) => color !== "rgba(0, 0, 0, 0)"),
              swatches.join("|"),
            );
            await noOverflow(page);
            await shot(page, "system-colors", theme, size);

            await scrollToSection(page, "type");
            const previews = page.getByTestId("type-preview");
            assert.ok((await previews.count()) >= 7, "type previews");
            assert.equal(
              await previews.first().evaluate((element) => getComputedStyle(element).fontSize),
              "40px",
            );
            assert.ok((await page.getByTestId("type-chip").count()) >= 7, "font chips");
            await shot(page, "system-typography", theme, size);

            await scrollToSection(page, "components");
            const frames = page.locator("iframe[data-testid=component-preview]");
            await frames.first().waitFor();
            const sandboxes = await frames.evaluateAll((elements) =>
              elements.map((frame) => ({
                sandbox: frame.getAttribute("sandbox"),
                html: frame.getAttribute("srcdoc") ?? "",
              })),
            );
            assert.ok(sandboxes.length >= 2, `component previews: ${sandboxes.length}`);
            assert.ok(
              sandboxes.every((frame) => frame.sandbox === ""),
              "every preview is sandboxed without scripts",
            );
            assert.ok(sandboxes.some((frame) => frame.html.includes("Book berth")));
            await noOverflow(page);
            await shot(page, "system-components", theme, size);
          }),
        );

      if (wanted("files"))
        await check(`${tag}: Files lists, previews and downloads every kind`, () =>
          withPage(theme, "files", size, async (page) => {
            await systemPage(page);
            await openFiles(page, size);
            const browserLayer = page.getByTestId("files-browser");
            await browserLayer.getByTestId("files-row").first().waitFor();
            assert.match(await browserLayer.locator("header").textContent(), /10 files/);
            const groups = await browserLayer
              .locator("[data-group]")
              .evaluateAll((elements) =>
                elements.map((element) => element.getAttribute("data-group")),
              );
            for (const group of ["Folders", "Documents", "Sources"])
              assert.ok(groups.includes(group), `group ${group} in ${groups.join("|")}`);
            await layout(page, [
              ["Close files", page.getByRole("button", { name: "Close the file browser" })],
            ]);
            await shot(page, "files", theme, size);

            const pane = page.getByTestId("files-preview");
            const back = pane.getByRole("button", { name: "All files" });
            const select = async (path, folders = [], origin) => {
              // One pane when the browser is narrow: the list sits behind All files.
              if ((await pane.isVisible()) && (await back.isVisible())) await back.click();
              for (const folder of folders) {
                const row = browserLayer.locator(
                  `[data-testid=files-folder][data-path="${folder}"]`,
                );
                if ((await row.getAttribute("aria-expanded")) !== "true") await row.click();
              }
              const originSelector = origin ? `[data-origin="${origin}"]` : "";
              await browserLayer
                .locator(`[data-testid=files-row][data-path="${path}"]${originSelector}`)
                .click();
              await pane.waitFor();
              const width = await page.evaluate(() => ({
                browser: document.querySelector("[data-testid=files-browser]").clientWidth,
                preview: document.querySelector("[data-testid=files-preview]").clientWidth,
              }));
              assert.ok(
                width.preview >= Math.min(320, width.browser - 1),
                `${path} preview is ${width.preview}px of ${width.browser}px`,
              );
              assert.equal(
                await pane.getByTestId("files-name").textContent(),
                path.slice(path.lastIndexOf("/") + 1),
              );
              const download = pane.getByRole("button", { name: "Download" });
              assert.equal(await download.isEnabled(), true, `${path} has Download`);
              await layout(page, [[`${path} Download`, download]]);
            };

            await select("README.md");
            const markdown = pane.getByTestId("file-preview-markdown");
            await markdown.locator("h1, h2").first().waitFor();
            assert.match(await markdown.textContent(), /Principles/);
            await shot(page, "files-md", theme, size);

            await select("docs/voice.md", ["docs"]);
            await markdown.locator("h1, h2").first().waitFor();
            assert.match(await markdown.textContent(), /Book berth/);

            await select("tokens.json", [], "generated");
            await pane.getByTestId("file-preview-source").waitFor();
            await sourceShows(page, "color-ground");
            assert.equal(await pane.getByTestId("file-preview-markdown").count(), 0);
            assert.match(await pane.getByTestId("files-where").textContent(), /Generated/);
            if (keySize(size)) await shot(page, "files-json", theme, size);

            await select("tokens.css", [], "generated");
            await sourceShows(page, "--color-ground");

            const imageLoaded = () =>
              page.waitForFunction(() => {
                const image = document.querySelector("[data-testid=file-preview-image]");
                return (
                  image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0
                );
              });
            await select("assets/Screens/berth-board.png", ["assets", "assets/Screens"]);
            await imageLoaded();
            await shot(page, "files-image", theme, size);
            if (size.name === "1280") {
              const [download] = await Promise.all([
                page.waitForEvent("download"),
                pane.getByRole("button", { name: "Download" }).click(),
              ]);
              assert.equal(download.suggestedFilename(), "berth-board.png");
              await download.delete();
            }

            await select("assets/Logos/harbor-mark.svg", ["assets", "assets/Logos"]);
            await imageLoaded();
            if (keySize(size)) await shot(page, "files-svg", theme, size);

            await select("fonts/DM Sans.woff2", ["fonts"]);
            await pane.locator("[data-testid=font-specimen][data-state=ready]").waitFor();
            const faces = await page.evaluate(() =>
              [...document.fonts]
                .filter((face) => face.family.includes("ds-specimen"))
                .map((face) => face.status),
            );
            assert.ok(faces.includes("loaded"), `specimen face loaded: ${faces.join("|")}`);
            await shot(page, "files-font", theme, size);

            await select("packages/ui-kit/src/styles/tokens.css", [], "source");
            await sourceShows(page, "--color-ground");
            assert.match(
              await pane.getByTestId("files-where").textContent(),
              /Read from the repository/,
            );
            if (keySize(size)) await shot(page, "files-source", theme, size);
            const reads = await page.evaluate(() => window.__fixture.reads);
            for (const read of [
              "stored:README.md",
              "stored:assets/Screens/berth-board.png",
              "stored:fonts/DM Sans.woff2",
              "source:packages/ui-kit/src/styles/tokens.css",
            ])
              assert.ok(reads.includes(read), `${read} read through designSystem.fileRead`);
          }),
        );

      if (wanted("assets"))
        await check(`${tag}: Assets sets, storage footer and controls`, () =>
          withPage(theme, "assets", size, async (page) => {
            await systemPage(page);
            const section = page.getByTestId("assets-section");
            await section.getByTestId("asset-set").first().waitFor();
            await scrollToSection(page, "assets");
            const sets = await section.getByTestId("asset-set").evaluateAll((elements) =>
              elements.map((element) => ({
                name: element.getAttribute("data-set"),
                header: element.querySelector("header")?.textContent ?? "",
              })),
            );
            assert.deepEqual(
              sets.map((set) => set.name),
              ["Logos", "Screens"],
            );
            assert.match(sets[0].header, /2 files/);
            assert.match(sets[1].header, /1 file/);
            const storage = await section.getByTestId("assets-storage").textContent();
            assert.match(storage, /^Stored with this design system: 6 files · .+ of 1024 MB used$/);
            const logos = section.locator("[data-set=Logos]");
            await layout(page, [
              ["New set", section.getByRole("button", { name: "New set" })],
              ["Upload to Logos", logos.getByRole("button", { name: "Upload file to Logos" })],
              ["Delete Logos", logos.getByRole("button", { name: "Delete the Logos set" })],
              ["Storage footer", section.getByTestId("assets-storage")],
            ]);
            await section.getByTestId("asset-set").first().scrollIntoViewIfNeeded();
            await shot(page, "assets", theme, size);
            await logos.getByRole("button", { name: "Actions for harbor-mark.svg" }).click();
            const menu = page.getByRole("menu");
            await menu.getByRole("menuitem").first().waitFor();
            const items = await menu.getByRole("menuitem").allTextContents();
            for (const item of ["Download", "Rename…", "Move to", "Remove from Logos"])
              assert.ok(
                items.some((text) => text.includes(item)),
                `${item} in ${items.join("|")}`,
              );
            await inView(page, menu, "asset row menu");
            if (keySize(size)) await shot(page, "assets-menu", theme, size);
            if (size.name !== "1280") return;
            const [download] = await Promise.all([
              page.waitForEvent("download"),
              menu.getByRole("menuitem", { name: "Download" }).click(),
            ]);
            assert.equal(download.suggestedFilename(), "harbor-mark.svg");
            await download.delete();
            await logos.getByTestId("asset-set-input").setInputFiles({
              name: "flag.svg",
              mimeType: "image/svg+xml",
              buffer: Buffer.from(
                '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="#e11d48"/></svg>',
              ),
            });
            const put = await callFor(page, "design.systemFilePut");
            assert.equal(put.rpc, "designSystem.filePut");
            assert.equal(put.input.path, "assets/Logos/flag.svg");
            await page.waitForFunction(() =>
              document.querySelector("[data-set=Logos] header")?.textContent?.includes("3 files"),
            );
            await section
              .locator("[data-set=Screens]")
              .getByRole("button", { name: "Delete the Screens set" })
              .click();
            await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
            const removed = await callFor(page, "design.systemFileDelete");
            assert.equal(removed.input.path, "assets/Screens/berth-board.png");
          }),
        );

      if (wanted("empty"))
        await check(`${tag}: an empty system shows the welcome sheet`, () =>
          withPage(theme, "empty", size, async (page) => {
            await page.getByTestId("welcome-sheet").waitFor();
            assert.equal(await page.locator("h1").first().textContent(), "Regatta brand");
            await layout(page, [
              ["Import", page.getByTestId("welcome-import")],
              ["Upload", page.getByTestId("welcome-upload")],
              ["Describe", page.getByTestId("welcome-describe")],
            ]);
            await page.getByTestId("welcome-sheet").scrollIntoViewIfNeeded();
            await shot(page, "empty", theme, size);
          }),
        );

      if (wanted("scratch"))
        await check(`${tag}: Start from scratch creates a Light and Dark system`, () =>
          withPage(theme, "scratch", size, async (page) => {
            await page.getByTestId("strip-new-system").click();
            await page.getByRole("menuitem", { name: "Start from scratch" }).click();
            const dialog = page.locator(
              "[data-testid=new-design-system-dialog][data-mode=scratch]",
            );
            await dialog.waitFor();
            const panel = dialog.getByTestId("scratch-panel");
            await panel.getByLabel("Name", { exact: true }).fill("Regatta race kit");
            await layout(page, [
              ["Name", panel.getByLabel("Name", { exact: true })],
              ["Create design system", panel.getByTestId("scratch-create")],
            ]);
            await shot(page, "scratch", theme, size);
            await panel.getByTestId("scratch-create").click();
            const create = await callFor(page, "design.systemCreate");
            assert.equal(create.rpc, "designSystem.create");
            assert.deepEqual(create.input.owner, { kind: "project", projectId: "harbor-app" });
            assert.equal(create.input.name, "Regatta race kit");
            assert.deepEqual(create.input.modes, [
              { id: "light", name: "Light" },
              { id: "dark", name: "Dark" },
            ]);
            await page.waitForFunction(() =>
              window.__fixture.location().startsWith("/design/systems/p.harbor-app.s_fixture"),
            );
            await dialog.waitFor({ state: "detached" });
          }),
        );

      if (wanted("menu"))
        await check(`${tag}: system menu and the delete warning`, () =>
          withPage(theme, "menu", size, async (page) => {
            await systemPage(page);
            await page.getByTestId("system-menu-trigger").click();
            const menu = page.getByTestId("system-menu");
            await menu.waitFor();
            assert.match(
              await menu.getByTestId("system-menu-header").textContent(),
              /Design system · Updated October 23, 2026/,
            );
            const items = await menu.getByRole("menuitem").allTextContents();
            for (const item of [
              "Switch system",
              "Rename",
              "Duplicate",
              "Open in Settings",
              "Rescan",
              "Storage",
              "Delete",
            ])
              assert.ok(
                items.some((text) => text.startsWith(item)),
                `${item} in ${items.join("|")}`,
              );
            await menu.getByRole("menuitem", { name: "Switch system" }).hover();
            const switcher = page.getByTestId("system-switch");
            await switcher.waitFor();
            const siblings = await switcher.getByRole("menuitemradio").allTextContents();
            assert.ok(siblings.some((text) => text.includes("Harbor UI")));
            assert.ok(siblings.some((text) => text.includes("Regatta brand")));
            await layout(page, [
              ["system menu", menu],
              ["Switch system list", switcher],
            ]);
            await shot(page, "menu", theme, size);
            await page.keyboard.press("Escape");
            await page.keyboard.press("Escape");
            await menu.waitFor({ state: "hidden" });
            await page.getByTestId("system-menu-trigger").click();
            await menu.getByRole("menuitem", { name: "Delete" }).click();
            const warning = page.getByTestId("system-delete-dialog");
            await warning.waitFor();
            assert.match(
              await warning.textContent(),
              /This deletes Harbor UI and its stored files from Harbor app\. 4 designs use it/,
            );
            await layout(page, [["Delete", page.getByTestId("system-delete-confirm")]]);
            await shot(page, "menu-delete", theme, size);
            if (size.name !== "1280") return;
            await page.getByTestId("system-delete-confirm").click();
            const removed = await callFor(page, "design.systemDelete");
            assert.equal(removed.rpc, "designSystem.delete");
            assert.equal(removed.input.expectedRevision, 7);
            await page.waitForFunction(
              () => window.__fixture.location() === "/design?project=harbor-app",
            );
          }),
        );

      if (wanted("edit"))
        await check(`${tag}: a color edit saves with revision 7`, () =>
          withPage(theme, "edit", size, async (page) => {
            await systemPage(page);
            await page.getByRole("button", { name: "Edit color-brand, Light" }).click();
            const field = page.getByTestId("color-field");
            await field.waitFor();
            await field.getByLabel("Color value").fill("#4f54c2");
            await layout(page, [
              ["color value", field.getByLabel("Color value")],
              ["Done", field.getByRole("button", { name: "Done" })],
            ]);
            await shot(page, "edit", theme, size);
            await field.getByLabel("Color value").press("Enter");
            const apply = await callFor(page, "design.systemApply");
            assert.equal(apply.rpc, "designSystem.apply");
            assert.equal(apply.input.expectedRevision, 7);
            assert.equal(apply.input.operations.length, 1);
            assert.equal(apply.input.operations[0].op, "put_token");
            assert.equal(apply.input.operations[0].token.name, "color-brand");
            assert.equal(apply.input.operations[0].token.values.light, "#4f54c2");
            await page.waitForFunction(() =>
              document
                .querySelector("[aria-label='Edit color-brand, Light']")
                ?.textContent?.toLowerCase()
                .includes("4f54c2"),
            );
            await noOverflow(page);
            if (keySize(size)) await shot(page, "edit-saved", theme, size);
          }),
        );

      if (wanted("connect"))
        await check(`${tag}: Connect to a project offers eligible projects and moves`, () =>
          withPage(theme, "connect", size, async (page) => {
            const dialog = page.getByTestId("connect-design-dialog");
            await dialog.waitFor();
            assert.match(await dialog.textContent(), /“Pricing page” moves out of your Playground/);
            await page.getByTestId("connect-design-project").click();
            const listbox = page.getByRole("listbox");
            await listbox.waitFor();
            const options = (await listbox.getByRole("option").allTextContents()).map((text) =>
              text.trim(),
            );
            assert.deepEqual(options, ["Harbor app", "Atlas web"]);
            await inView(page, listbox, "project list");
            if (keySize(size)) await shot(page, "connect-projects", theme, size);
            await listbox.getByRole("option", { name: "Harbor app" }).click();
            const thread = page.getByTestId("connect-design-thread");
            assert.equal(await thread.getAttribute("aria-checked"), "true");
            await layout(page, [
              ["project", page.getByTestId("connect-design-project")],
              ["Move", page.getByTestId("connect-design-move")],
            ]);
            await shot(page, "connect", theme, size);
            await page.getByTestId("connect-design-move").click();
            const move = await callFor(page, "design.move");
            assert.equal(move.rpc, "design.move");
            assert.deepEqual(move.input.to, { kind: "project", projectId: "harbor-app" });
            assert.equal(move.input.designId, "d_pricing");
            assert.equal(move.input.expectedRevision, 12);
            await page.waitForFunction(() =>
              window.__fixture.calls.some(
                (call) => /move/i.test(call.label) && call.label !== "design.move",
              ),
            );
            await page.getByTestId("fixture-moved").waitFor({ state: "attached" });
            await dialog.waitFor({ state: "detached" });
          }),
        );

      if (wanted("more-menu"))
        await check(`${tag}: the project More menu opens the design board`, () =>
          withPage(theme, "more-menu", size, async (page) => {
            await page.getByRole("button", { name: "More project actions" }).click();
            const menu = page.getByRole("menu");
            await menu.waitFor();
            const items = (await menu.getByRole("menuitem").allTextContents()).map((text) =>
              text.trim(),
            );
            for (const item of ["Plan", "Design", "Usage", "Routines"])
              assert.ok(items.includes(item), `${item} in ${items.join("|")}`);
            await layout(page, [["Design", page.getByTestId("project-more-design")]]);
            await shot(page, "more-menu", theme, size);
            await page.getByTestId("project-more-design").click();
            await page.waitForFunction(
              () => window.__fixture.location() === "/design?project=harbor-app",
            );
          }),
        );

      if (wanted("board"))
        await check(`${tag}: the project board shows its systems and Add from Playground`, () =>
          withPage(theme, "board", size, async (page) => {
            const strip = page.getByTestId("project-systems-strip");
            await strip.waitFor();
            const cards = strip.getByTestId("strip-system");
            await cards.first().waitFor();
            const texts = await cards.allTextContents();
            assert.equal(texts.length, 2);
            assert.match(texts[0], /Harbor UI\d+ tokens · 3 components/);
            assert.match(texts[1], /Regatta brand0 tokens · 0 components/);
            await page.waitForFunction(
              () =>
                document.querySelectorAll("[data-testid=strip-system] span[style*=background]")
                  .length >= 6,
            );
            const add = page.getByTestId("design-add-from-playground");
            await layout(page, [
              ["Add from Playground", add],
              ["New design system", page.getByTestId("strip-new-system")],
            ]);
            await page.evaluate(() =>
              document.querySelector("[data-testid=fixture-page]")?.scrollTo(0, 0),
            );
            await shot(page, "board", theme, size);
            if (!keySize(size)) return;
            await add.click();
            const items = page.getByTestId("design-add-from-playground-item");
            await items.first().waitFor();
            const names = await items.evaluateAll((elements) =>
              elements.map((element) => element.querySelector(".truncate")?.textContent ?? ""),
            );
            assert.deepEqual(names, ["Pricing page", "Marina moodboard"]);
            await inView(page, page.getByRole("menu"), "Add from Playground menu");
            await shot(page, "board-add", theme, size);
            if (size.name !== "1280") return;
            await items.first().click();
            const dialog = page.getByTestId("connect-design-dialog");
            await dialog.waitFor();
            assert.match(
              await page.getByTestId("connect-design-project").textContent(),
              /Harbor app/,
            );
            await page.getByTestId("connect-design-move").click();
            const move = await callFor(page, "design.move");
            assert.deepEqual(move.input.to, { kind: "project", projectId: "harbor-app" });
            await dialog.waitFor({ state: "detached" });
            await cards.first().click();
            await page.waitForFunction(
              () => window.__fixture.location() === "/design/systems/p.harbor-app.s_harborkit01",
            );
          }),
        );
    }
  }
} finally {
  await browser?.close();
  server.close();
}

const failed = results.filter((result) => !result.ok);
await writeFile(
  join(output, "report.json"),
  JSON.stringify(
    {
      origin: "fixture",
      increment: "1046",
      task: "T-07",
      generatedAt: new Date().toISOString(),
      sizes: SIZES.map((size) => size.name),
      themes: THEMES,
      passed: results.length - failed.length,
      total: results.length,
      results,
      errors,
      screenshots: shots,
    },
    null,
    2,
  ),
);
console.log(
  `${results.length - failed.length}/${results.length} checks passed; ${errors.length} page errors; ${shots.length} screenshots`,
);
for (const result of failed) console.log(`FAIL ${result.name}\n${result.error}`);
for (const error of errors.slice(0, 40)) console.log(`ERROR ${error}`);
process.exit(failed.length > 0 || errors.length > 0 ? 1 : 0);
