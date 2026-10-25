#!/usr/bin/env node
// Headless end-to-end check of slides against a real, isolated server: built apps/server/dist
// and apps/web/dist, a private test home under ~/.local/share/specweave-studio/verification,
// every model provider off, and a scratch project holding one design system. Creates a deck
// from the gallery, builds it from layouts, reorders and edits it through the slide rail,
// writes speaker notes and presents it with the presenter view, in light and dark. Writes
// screenshots, downloads and report.json to the report folder.
// With STUDIO_LIVE_SERVER set (see kit.mjs) it runs against that server and never stops it.
// Build first: web `vp build`, server `node apps/server/scripts/cli.ts build`.
// Usage: node apps/web/tests/design-workspace/live/verify-slides.mjs /absolute/report-dir
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  assert,
  attachedServer,
  checker,
  entrypointSha256,
  gitHead,
  initRepository,
  launchBrowser,
  requireBuild,
  saved as savedState,
  startServer,
  waitFor,
  watchErrors,
} from "./kit.mjs";

if (Number(process.versions.node.split(".")[0]) !== 22) throw new Error("Use Node 22");
const out = NodePath.resolve(process.argv[2] ?? "/tmp/design-slides-real");
const shots = NodePath.join(out, "screenshots");
const downloads = NodePath.join(out, "downloads");
for (const dir of [out, shots, downloads]) NodeFS.mkdirSync(dir, { recursive: true });
requireBuild();

const attached = attachedServer();
const privateRoot =
  attached?.scratchRoot ??
  NodePath.join(NodeOS.homedir(), ".local/share/specweave-studio/verification/design-slides");
NodeFS.mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
const scratch = NodeFS.mkdtempSync(NodePath.join(privateRoot, "slides-run-"));
const data = NodePath.join(scratch, "data");
const workspace = NodePath.join(scratch, "harbor");
const results = [];
const errors = [];
const report = {
  source: gitHead(),
  evidenceKind: "real-isolated-server-headless-chromium",
  attached: attached !== null,
  builtEntrypointSha256: entrypointSha256(),
  browser: { headless: true, PWDEBUG: "0", PLAYWRIGHT_HTML_OPEN: "never" },
  modelTurns: 0,
  results,
  errors,
};

let failureShot = null;
const check = checker(results, { onFailure: (name) => failureShot?.(name) });

// ---- scratch project with one design system -----------------------------------------------
initRepository(workspace, { "README.md": "Synthetic slides check.\n" });
const systemId = "harbor-deck";
const token = (name, type, light, dark = light) => {
  const value = (raw, line) => ({
    raw,
    resolved: raw,
    provenance: { source: "file", location: "harbor/tokens.css", line, extractor: "css" },
  });
  return { name, type, values: { light: value(light, 1), dark: value(dark, 2) } };
};
const now = new Date().toISOString();
NodeFS.mkdirSync(NodePath.join(workspace, ".specweave/design/systems", systemId), {
  recursive: true,
});
NodeFS.writeFileSync(
  NodePath.join(workspace, ".specweave/design/systems", systemId, "system.json"),
  JSON.stringify(
    {
      schema: "swc.design-system/1",
      id: systemId,
      name: "Harbor deck",
      revision: 0,
      createdAt: now,
      updatedAt: now,
      modes: [
        { id: "light", name: "Light" },
        { id: "dark", name: "Dark" },
      ],
      tokens: [
        token("hb-background", "color", "#ffffff", "#0d1419"),
        token("hb-foreground", "color", "#0e1a24", "#e8eef2"),
        token("hb-muted-foreground", "color", "#536271", "#93a3b0"),
        token("hb-card", "color", "#e7eef1", "#17242c"),
        token("hb-primary", "color", "#0b6e69", "#3fb7ae"),
        token("hb-primary-foreground", "color", "#ffffff", "#062320"),
        token("hb-font-display", "fontFamily", '"Iowan Old Style", Georgia, serif'),
        token("hb-font-sans", "fontFamily", '"Avenir Next", "Helvetica Neue", sans-serif'),
      ],
      components: [],
      sources: [{ kind: "file", location: "harbor/tokens.css", readAt: now }],
      copiedFrom: null,
    },
    null,
    2,
  ),
);

// Launch the browser first, so a missing browser never leaves a server running.
const browser = await launchBrowser();
const server =
  attached ??
  (await startServer({
    home: data,
    cwd: scratch,
    logFile: NodePath.join(out, "server.log"),
    label: "Slides real-server check",
  }));
const { origin, request, rpc } = server;
report.serverPid = server.pid;

const projectId = crypto.randomUUID();
await request("/api/projects/mutate", {
  type: "project.create",
  commandId: crypto.randomUUID(),
  projectId,
  title: "Harbor",
  workspaceRoot: workspace,
  // A scratch folder reads as a check's own project, which takes no new designs.
  origin: "user",
});
const owner = { kind: "project", projectId };
report.project = { projectId, workspace };

// ---- browser ---------------------------------------------------------------------------------
const VIEWPORT = { width: 1600, height: 960 };
const NARROW_SIZES = [
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
];
const MIN_CANVAS = 480;
const signedInContext = (colorScheme) =>
  server.signedInContext(browser, { colorScheme, viewport: VIEWPORT });
const watch = (page, label) => watchErrors(page, label, errors);
const shot = (page, name) => page.screenshot({ path: NodePath.join(shots, `${name}.png`) });
const saved = (page) => savedState(page, 8000);
let designId = null;
const serverDoc = async () => (await rpc("design.get", { owner, designId })).document;
const rail = (page) => page.getByTestId("slide-rail");
const slideItems = (page) => rail(page).getByTestId("slide-item");
const canvas = (page) => page.getByTestId("design-canvas");

/**
 * The prompt must sit inside the canvas viewport, and inside the slide whenever the slide
 * is drawn larger than the prompt's minimum (264 x 168 plus insets); otherwise centered on it.
 */
async function promptPlacement(page, frameId) {
  const round = (box) =>
    Object.fromEntries(Object.entries(box).map(([k, v]) => [k, Math.round(v)]));
  const prompt = round(await page.getByTestId("slide-layout-prompt").boundingBox());
  const view = round(await canvas(page).boundingBox());
  const slide = round(await canvas(page).locator(`[data-node="${frameId}"]`).boundingBox());
  const inside = (a, b) =>
    a.x >= b.x - 1 &&
    a.y >= b.y - 1 &&
    a.x + a.width <= b.x + b.width + 1 &&
    a.y + a.height <= b.y + b.height + 1;
  assert(
    inside(prompt, view),
    `prompt ${JSON.stringify(prompt)} leaves the canvas ${JSON.stringify(view)}`,
  );
  if (slide.width >= 288 && slide.height >= 192)
    assert(
      inside(prompt, slide),
      `prompt ${JSON.stringify(prompt)} leaves the slide ${JSON.stringify(slide)}`,
    );
  else {
    const centerOff = Math.abs(prompt.x + prompt.width / 2 - (slide.x + slide.width / 2));
    assert(centerOff <= 14, `prompt is ${centerOff}px off the small slide's center`);
  }
  return { prompt, canvas: view, slide };
}

async function addLayoutSlide(page, layout) {
  await page.getByTestId("new-slide").click();
  const picker = page.locator(`[data-testid=slide-layout][data-layout="${layout}"]`).last();
  await picker.waitFor();
  await picker.click();
}

try {
  const context = await signedInContext("light");
  const page = await context.newPage();
  watch(page, "light");
  failureShot = (name) => shot(page, `fail-${name.replace(/[^a-z0-9]+/gi, "-").slice(0, 40)}`);

  await check(
    "gallery: Slides creates a 1920x1080 deck in the project with its system",
    async () => {
      await page.goto(`${origin}/design`);
      await page.getByTestId("design-gallery").waitFor({ timeout: 30000 });
      await page.locator('[data-testid=design-create][data-kind="slides"]').click();
      const dialog = page.locator('[data-testid=new-design-dialog][data-kind="slides"]');
      await dialog.waitFor();
      await dialog.getByLabel("Title").fill("Harbor launch");
      await dialog.getByLabel("Save in").click();
      await page.getByRole("option", { name: "Harbor" }).click();
      await dialog.getByTestId("creation-system-trigger").click();
      await page.getByRole("option", { name: /Harbor deck/ }).click();
      await shot(page, "01-new-slides-dialog-light");
      await dialog.getByRole("button", { name: "Create slides" }).click();
      await page.waitForURL(/\/design\/p\./, { timeout: 30000 });
      designId = decodeURIComponent(page.url().split("/design/")[1]).split(".").at(-1);
      await page.getByTestId("design-editor").waitFor({ timeout: 30000 });
      const document = await serverDoc();
      assert(document.kind === "slides", `kind ${document.kind}`);
      assert(document.designSystem === systemId, `system ${document.designSystem}`);
      const frame = document.pages[0].nodes[0];
      assert(frame.width === 1920 && frame.height === 1080, `frame ${frame.width}x${frame.height}`);
      return { designId, title: document.title, frame: `${frame.width}x${frame.height}` };
    },
  );

  await check("an empty slide offers the six layouts in the system's tokens", async () => {
    await rail(page).waitFor();
    assert((await slideItems(page).count()) === 1, "rail does not show one slide");
    const prompt = page.getByTestId("slide-layout-prompt");
    await prompt.waitFor();
    assert((await prompt.getByTestId("slide-layout").count()) === 6, "not six layouts");
    await page.waitForTimeout(300);
    await shot(page, "02-layout-prompt-light");
    const frameId = (await serverDoc()).pages[0].nodes[0].id;
    const placement = await promptPlacement(page, frameId);
    await prompt.locator('[data-layout="title"]').click();
    await saved(page);
    const nodes = (await serverDoc()).pages[0].nodes;
    const frame = nodes[0];
    const title = nodes.find((node) => node.name === "Title");
    assert(frame.fill?.token === "hb-background", `frame fill ${JSON.stringify(frame.fill)}`);
    assert(title?.color?.token === "hb-foreground", `title color ${JSON.stringify(title?.color)}`);
    assert(title?.fontFamily?.token === "hb-font-display", "title font is not the display token");
    await prompt.waitFor({ state: "detached" });
    return {
      nodes: nodes.length,
      frameFill: frame.fill,
      titleFont: title.fontFamily,
      placement,
    };
  });

  for (const size of NARROW_SIZES)
    await check(
      `${size.width}x${size.height}: the canvas keeps ${MIN_CANVAS}px, its toolbar and a 25% slide`,
      async () => {
        // A blank slide (Add slide after) brings the prompt back; then shrink the window.
        await slideItems(page).nth(0).click({ button: "right" });
        await page.getByRole("menuitem", { name: "Add slide after" }).click();
        await saved(page);
        await page.setViewportSize(size);
        await page.waitForTimeout(300);
        await canvas(page).focus();
        await page.keyboard.press("Shift+1");
        await page.getByTestId("slide-layout-prompt").waitFor();
        await page.waitForTimeout(400);
        const box = await canvas(page).boundingBox();
        assert(box.width >= MIN_CANVAS, `canvas is ${Math.round(box.width)}px wide`);
        // Every toolbar group, and every tool, stays inside the canvas.
        const groups = await page.getByTestId("canvas-toolbar").locator(":scope > *").all();
        const outside = [];
        for (const group of groups) {
          const rect = await group.boundingBox();
          if (
            rect.x < box.x - 1 ||
            rect.y < box.y - 1 ||
            rect.x + rect.width > box.x + box.width + 1 ||
            rect.y + rect.height > box.y + box.height + 1
          )
            outside.push(rect);
        }
        assert(outside.length === 0, `toolbar leaves the canvas: ${JSON.stringify(outside)}`);
        const tools = page.getByTestId("canvas-toolbar").locator("[data-tool]");
        const toolCount = await tools.count();
        assert(toolCount === 11, `${toolCount} tools in the toolbar`);
        for (const tool of await tools.all()) {
          const rect = await tool.boundingBox();
          assert(
            rect !== null && rect.x + rect.width <= box.x + box.width + 1,
            "a tool leaves the canvas",
          );
        }
        const zoom = Number(
          (await page.getByTestId("zoom-menu").textContent()).replace(/[^0-9]/g, ""),
        );
        assert(zoom >= 25, `zoom to fit shows the slide at ${zoom}%`);
        const editor = page.getByTestId("design-editor");
        const layout = await editor.locator("[data-chat]").evaluate((element) => ({
          chat: element.getAttribute("data-chat"),
          side: element.getAttribute("data-side"),
        }));
        const railCompact = (await rail(page).getAttribute("data-compact")) === "true";
        const document = await serverDoc();
        const placement = await promptPlacement(page, document.pages[1].nodes[0].id);
        await shot(page, `02b-narrow-${size.width}x${size.height}-light`);
        // A thread and a side panel that open over the canvas leave its width alone.
        const overlays = {};
        if (layout.chat === "overlay") {
          await page.getByRole("button", { name: "Show thread", exact: true }).click();
          await page.getByTestId("design-thread").waitFor();
          overlays.thread = Math.round((await canvas(page).boundingBox()).width);
          await page.getByRole("button", { name: "Hide thread", exact: true }).click();
          await page.getByTestId("design-thread").waitFor({ state: "detached" });
        }
        if (layout.side === "overlay") {
          await page.getByRole("button", { name: "Properties", exact: true }).click();
          await page.getByTestId("design-side-panel").waitFor();
          overlays.properties = Math.round((await canvas(page).boundingBox()).width);
          await shot(page, `02c-narrow-${size.width}x${size.height}-properties-light`);
          await page.getByRole("button", { name: "Properties", exact: true }).click();
          await page.getByTestId("design-side-panel").waitFor({ state: "detached" });
        }
        for (const width of Object.values(overlays))
          assert(Math.abs(width - box.width) <= 1, `an overlay changed the canvas to ${width}px`);
        // Remove the blank slide again and restore the window.
        await slideItems(page).nth(1).click({ button: "right" });
        await page.getByRole("menuitem", { name: /^Delete/ }).click();
        await saved(page);
        await page.setViewportSize(VIEWPORT);
        await waitFor(
          async () => (await serverDoc()).pages.length === 1,
          5000,
          "blank slide deleted",
        );
        return {
          canvasWidth: Math.round(box.width),
          zoom,
          tools: toolCount,
          layout: { ...layout, rail: railCompact ? "compact" : "full" },
          overlays,
          placement,
        };
      },
    );

  await check("New slide adds each layout after the current slide", async () => {
    await page.getByTestId("new-slide").click();
    await page.locator("[data-testid=slide-layout]").first().waitFor();
    await page.waitForTimeout(300);
    await shot(page, "03-layout-picker-light");
    await page.keyboard.press("Escape");
    for (const layout of ["section", "title-body", "two-columns", "image-caption", "quote"])
      await addLayoutSlide(page, layout);
    await saved(page);
    const document = await serverDoc();
    assert(document.pages.length === 6, `pages ${document.pages.length}`);
    const names = document.pages.map((p) => p.nodes.map((n) => n.name).join("|"));
    assert(names[5].includes("Quote"), "the last slide is not the quote layout");
    assert((await slideItems(page).count()) === 6, "rail does not show six slides");
    return { pages: document.pages.map((p) => p.name) };
  });

  await check("layout nodes stay editable: select and nudge the quote", async () => {
    const document = await serverDoc();
    const quote = document.pages[5].nodes.find((node) => node.name === "Quote");
    const node = canvas(page).locator(`[data-node="${quote.id}"]`);
    await node.click();
    await canvas(page).focus();
    await page.keyboard.press("Shift+ArrowRight");
    await saved(page);
    const moved = await waitFor(
      async () => {
        const next = (await serverDoc()).pages[5].nodes.find((n) => n.id === quote.id);
        return next.x === quote.x + 10 ? next : null;
      },
      5000,
      "nudged quote on the server",
    );
    await page.keyboard.press("Escape");
    return { from: quote.x, to: moved.x };
  });

  await check("speaker notes save to the slide (AC-04)", async () => {
    await slideItems(page).nth(1).click();
    const field = page.getByTestId("speaker-notes-field");
    await field.click();
    await field.fill("Name the three harbors, then pause for questions.");
    await canvas(page).click({ position: { x: 20, y: 300 } });
    await saved(page);
    const document = await waitFor(
      async () => {
        const value = await serverDoc();
        return value.pages[1].notes ? value : null;
      },
      5000,
      "notes on the server",
    );
    assert(
      document.pages[1].notes === "Name the three harbors, then pause for questions.",
      `notes ${document.pages[1].notes}`,
    );
    return { notes: document.pages[1].notes };
  });

  await check("reorder by keyboard (Alt+Up) and by drag", async () => {
    const before = (await serverDoc()).pages.map((p) => p.id);
    await slideItems(page).nth(2).click();
    await slideItems(page).nth(2).focus();
    await page.keyboard.press("Alt+ArrowUp");
    await saved(page);
    const keyed = await waitFor(
      async () => {
        const ids = (await serverDoc()).pages.map((p) => p.id);
        return ids[1] === before[2] ? ids : null;
      },
      5000,
      "keyboard move on the server",
    );
    await slideItems(page)
      .nth(5)
      .dragTo(slideItems(page).nth(0), {
        targetPosition: { x: 40, y: 4 },
      });
    await saved(page);
    const dragged = await waitFor(
      async () => {
        const ids = (await serverDoc()).pages.map((p) => p.id);
        return ids[0] === keyed[5] ? ids : null;
      },
      5000,
      "drag move on the server",
    );
    return { before, keyed, dragged };
  });

  await check("slide menu: duplicate, skip and delete", async () => {
    await slideItems(page).nth(1).click({ button: "right" });
    await page.getByRole("menuitem", { name: /^Duplicate/ }).click();
    await saved(page);
    await waitFor(async () => (await serverDoc()).pages.length === 7, 5000, "duplicate");
    await slideItems(page).nth(2).click({ button: "right" });
    await page.getByRole("menuitem", { name: /^Delete/ }).click();
    await saved(page);
    await waitFor(async () => (await serverDoc()).pages.length === 6, 5000, "delete");
    // Skip the image slide, wherever the moves left it.
    const document = await serverDoc();
    const imageIndex = document.pages.findIndex((p) => p.nodes.some((n) => n.name === "Caption"));
    await slideItems(page).nth(imageIndex).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Skip slide" }).click();
    await saved(page);
    const skipped = await waitFor(
      async () => {
        const value = await serverDoc();
        return value.pages[imageIndex].skipped === true ? value : null;
      },
      5000,
      "skip on the server",
    );
    assert(
      (await slideItems(page).nth(imageIndex).getAttribute("data-skipped")) === "true",
      "the rail does not mark the skipped slide",
    );
    await slideItems(page).nth(0).click();
    await page.waitForTimeout(300);
    await shot(page, "04-rail-light");
    return { pages: skipped.pages.length, skipped: imageIndex + 1 };
  });

  await check("present mode keys, skipped slide left out", async () => {
    await slideItems(page).nth(0).click();
    await page.getByRole("button", { name: "Present", exact: true }).click();
    const present = page.getByTestId("present-mode");
    await present.waitFor();
    const position = () => page.getByTestId("present-position").textContent();
    assert((await position()) === "1 / 5", `start ${await position()}`);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press(" ");
    await page.keyboard.press("PageDown");
    assert((await position()) === "4 / 5", `after three steps ${await position()}`);
    await page.keyboard.press("PageUp");
    await page.keyboard.press("ArrowLeft");
    assert((await position()) === "2 / 5", `after two back ${await position()}`);
    await page.keyboard.press("End");
    assert((await position()) === "5 / 5", `End ${await position()}`);
    await page.keyboard.press("Home");
    await page.keyboard.press("3");
    assert((await position()) === "3 / 5", `3 ${await position()}`);
    await page.keyboard.press("1");
    await page.waitForTimeout(400);
    await shot(page, "05-present-light");
    await page.keyboard.press("Escape");
    await present.waitFor({ state: "detached", timeout: 3000 });
  });

  await check("presenter view: current, next, notes and timer", async () => {
    // Open on the slide with notes.
    const document = await serverDoc();
    const notesIndex = document.pages.findIndex((p) => p.notes);
    await slideItems(page).nth(notesIndex).click();
    await page.getByRole("button", { name: "Presenter view", exact: true }).click();
    const view = page.getByTestId("presenter-view");
    await view.waitFor();
    await page.getByTestId("presenter-current").locator("[data-node]").first().waitFor();
    await page.getByTestId("presenter-next").locator("[data-node]").first().waitFor();
    const notes = await page.getByTestId("presenter-notes").textContent();
    assert(notes.includes("three harbors"), `notes ${notes}`);
    const first = await page.getByTestId("presenter-timer").textContent();
    await page.waitForTimeout(2200);
    const later = await page.getByTestId("presenter-timer").textContent();
    assert(first !== later, `timer did not run: ${first} -> ${later}`);
    await shot(page, "06-presenter-light");
    await page.keyboard.press("p");
    await view.waitFor({ state: "detached" });
    await page.keyboard.press("Escape");
    return { notes, timer: [first, later] };
  });

  await check("export PDF of all slides", async () => {
    await page.getByRole("button", { name: "Export", exact: true }).click();
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 120000 }),
      page.getByRole("menuitem", { name: "PDF of all slides" }).click(),
    ]);
    const file = NodePath.join(downloads, "harbor-launch.pdf");
    await download.saveAs(file);
    const bytes = NodeFS.readFileSync(file);
    assert(bytes.subarray(0, 5).toString() === "%PDF-", "not a PDF");
    const pages = (bytes.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    return { bytes: bytes.length, pages };
  });

  await check("export PowerPoint of all slides", async () => {
    await page.getByRole("button", { name: "Export", exact: true }).click();
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 120000 }),
      page.getByRole("menuitem", { name: "PowerPoint of all slides" }).click(),
    ]);
    const file = NodePath.join(downloads, "harbor-launch.pptx");
    await download.saveAs(file);
    const bytes = NodeFS.readFileSync(file);
    assert(bytes.subarray(0, 2).toString() === "PK", "not a zip");
    const names = new Set(bytes.toString("latin1").match(/ppt\/slides\/slide\d+\.xml/g) ?? []);
    const document = await serverDoc();
    const shown = document.pages.filter((p) => !p.skipped).length;
    assert(names.size === shown, `pptx has ${names.size} slides, deck shows ${shown}`);
    return { bytes: bytes.length, slides: names.size, fileName: download.suggestedFilename() };
  });

  await check("light: no console errors", async () => {
    assert(errors.length === 0, errors.join("\n"));
  });
  await context.close();

  const dark = await signedInContext("dark");
  const darkPage = await dark.newPage();
  watch(darkPage, "dark");
  failureShot = (name) => shot(darkPage, `fail-${name.replace(/[^a-z0-9]+/gi, "-").slice(0, 40)}`);
  // A deck renders in its system's first mode for every viewer (designRenderMode), so the
  // dark app theme shows the same slides as light, Present and the exports.
  await check(
    "dark: rail, layouts and presenter view; the slides keep the deck's colors",
    async () => {
      await darkPage.goto(`${origin}/design/p.${projectId}.${designId}`);
      await darkPage.getByTestId("design-editor").waitFor({ timeout: 30000 });
      await rail(darkPage).waitFor();
      await saved(darkPage);
      await darkPage.waitForTimeout(400);
      const frame = (await serverDoc()).pages[0].nodes[0];
      const background = await canvas(darkPage)
        .locator(`[data-node="${frame.id}"]`)
        .evaluate((element) => getComputedStyle(element).backgroundColor);
      assert(
        background === "rgb(255, 255, 255)",
        `slide background in the dark theme ${background}`,
      );
      await shot(darkPage, "07-rail-dark");
      await darkPage.getByTestId("new-slide").click();
      await darkPage.locator("[data-testid=slide-layout]").first().waitFor();
      await darkPage.waitForTimeout(300);
      await shot(darkPage, "08-layout-picker-dark");
      await darkPage.keyboard.press("Escape");
      const document = await serverDoc();
      await slideItems(darkPage)
        .nth(document.pages.findIndex((p) => p.notes))
        .click();
      await darkPage.getByRole("button", { name: "Presenter view", exact: true }).click();
      await darkPage.getByTestId("presenter-view").waitFor();
      await darkPage.waitForTimeout(400);
      await shot(darkPage, "09-presenter-dark");
      await darkPage.keyboard.press("Escape");
      return { background };
    },
  );
  await check("dark: no console errors", async () => {
    assert(errors.length === 0, errors.join("\n"));
  });
  await dark.close();
} catch (error) {
  results.push({ name: "fatal", ok: false, error: String(error?.stack ?? error).slice(0, 4000) });
  console.log(`FATAL ${error?.stack ?? error}`);
} finally {
  await browser.close().catch(() => undefined);
  report.server = await server.stop();
  const passed = results.filter((r) => r.ok).length;
  report.summary = `${passed}/${results.length} checks passed`;
  NodeFS.writeFileSync(NodePath.join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(report.summary);
  // An attached server still lists the scratch project; its owner removes the folder.
  if (attached === null) NodeFS.rmSync(scratch, { recursive: true, force: true });
  process.exitCode = passed === results.length ? 0 : 1;
}
