// Headless end-to-end check of the design canvas editor against the in-memory fake server.
// Writes screenshots, downloads, a video, a perf trace and report.json to the report folder.
// Usage: node apps/web/tests/design-canvas/verify.mjs /absolute/report-dir
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { launch, serveSite } from "./serve.mjs";

const out = NodePath.resolve(process.argv[2] ?? "/tmp/design-canvas-verify");
const shots = NodePath.join(out, "screenshots");
const downloads = NodePath.join(out, "downloads");
for (const dir of [out, shots, downloads]) NodeFS.mkdirSync(dir, { recursive: true });

const results = [];
const errors = [];
const site = await serveSite();
const browser = await launch();
const VIEWPORT = { width: 1600, height: 960 };

async function check(name, run) {
  const started = Date.now();
  try {
    const detail = await run();
    results.push({ name, ok: true, ms: Date.now() - started, ...(detail ? { detail } : {}) });
    console.log(`ok   ${name}${detail ? ` (${JSON.stringify(detail)})` : ""}`);
  } catch (error) {
    results.push({
      name,
      ok: false,
      ms: Date.now() - started,
      error: String(error?.message ?? error),
    });
    console.log(`FAIL ${name}: ${String(error?.message ?? error).split("\n")[0]}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(predicate, timeout = 3000, label = "condition") {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function open(context, query = "") {
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(`${query}: ${error}`));
  page.on(
    "console",
    (message) =>
      message.type() === "error" &&
      // The agent HTML probe's fetch is meant to be refused by the frame CSP.
      !(
        message.location().url === "about:srcdoc" && /Content Security Policy/.test(message.text())
      ) &&
      errors.push(`${query}: ${message.text()}`),
  );
  await page.goto(`${site.url}?${query}`);
  await page.waitForSelector("[data-testid=design-canvas]");
  await page.waitForTimeout(300);
  return page;
}

const head = (page) => page.evaluate(() => window.__design.head);
const node = async (page, id) => (await head(page)).pages[0].nodes.find((n) => n.id === id);
const nodeCount = async (page) => (await head(page)).pages[0].nodes.length;
const saved = (page) =>
  waitFor(
    async () => (await page.getByTestId("save-state").textContent())?.trim() === "Saved",
    4000,
    "Saved",
  );
const center = async (page, selector) => {
  const box = await page.locator(selector).first().boundingBox();
  assert(box !== null, `${selector} has no box`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
};
/** Clicks a layer near its bottom-left corner, clear of child layers in its middle. */
const clickCorner = async (page, id) => {
  const { box } = await center(page, `[data-node="${id}"]`);
  await page.mouse.click(box.x + 6, box.y + box.height - 6);
};
const focusCanvas = (page) => page.getByTestId("design-canvas").focus();
const selectNode = async (page, id, { shift = false } = {}) => {
  const { x, y } = await center(page, `[data-node="${id}"]`);
  // page.mouse.click ignores modifiers; hold Shift on the keyboard instead.
  if (shift) await page.keyboard.down("Shift");
  await page.mouse.click(x, y);
  if (shift) await page.keyboard.up("Shift");
};
const shot = (page, name) => page.screenshot({ path: NodePath.join(shots, `${name}.png`) });

// ---- main flow, light theme, recorded ------------------------------------------------------
const context = await browser.newContext({
  viewport: VIEWPORT,
  colorScheme: "light",
  acceptDownloads: true,
  recordVideo: { dir: NodePath.join(out, "video"), size: VIEWPORT },
});
const page = await open(context, "theme=light");
const frameId = (await head(page)).pages[0].nodes.find(
  (n) => n.type === "frame" && n.name === "Booking",
).id;

await check("loads with the Booking frame and Saved state", async () => {
  await saved(page);
  assert(await page.locator(`[data-node="${frameId}"]`).isVisible(), "frame not visible");
  await shot(page, "01-loaded-light");
});

await check(
  "html and component nodes run in sandboxed iframes without allow-same-origin",
  async () => {
    const frames = await page.locator("[data-testid=design-world] iframe").evaluateAll((list) =>
      list.map((frame) => ({
        sandbox: frame.getAttribute("sandbox"),
        srcdoc: frame.hasAttribute("srcdoc"),
      })),
    );
    assert(frames.length >= 2, `expected 2+ iframes, got ${frames.length}`);
    for (const frame of frames) {
      assert(frame.sandbox !== null, "iframe without sandbox");
      assert(
        !frame.sandbox.includes("allow-same-origin"),
        `sandbox "${frame.sandbox}" allows same origin`,
      );
      assert(frame.srcdoc, "iframe without srcdoc");
    }
    await page
      .frameLocator('[data-node="n_html"] iframe')
      .locator("#t", { hasText: "network" })
      .waitFor({ timeout: 3000 });
    const probed = await page
      .frameLocator('[data-node="n_html"] iframe')
      .locator("#t")
      .textContent();
    assert(
      probed.includes("opaque origin") && !probed.includes("LEAK"),
      `html node saw: ${probed}`,
    );
    assert(probed.includes("network blocked"), `html node network: ${probed}`);
    const csp = await page.locator('[data-node="n_html"] iframe').getAttribute("srcdoc");
    assert(
      csp?.includes("Content-Security-Policy") && csp.includes("default-src 'none'"),
      "no CSP in srcdoc",
    );
    return { iframes: frames.length, sandboxes: [...new Set(frames.map((f) => f.sandbox))] };
  },
);

await check("draw a rectangle with the pointer", async () => {
  const before = await nodeCount(page);
  const { box } = await center(page, `[data-node="${frameId}"]`);
  await focusCanvas(page);
  await page.keyboard.press("r");
  const start = { x: box.x + 40, y: box.y + box.height + 40 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 60, start.y + 30, { steps: 4 });
  await page.mouse.move(start.x + 120, start.y + 60, { steps: 4 });
  await page.mouse.up();
  await saved(page);
  const doc = await head(page);
  assert(doc.pages[0].nodes.length === before + 1, "no node added");
  const added = doc.pages[0].nodes.at(-1);
  assert(added.type === "rect" && added.width > 100, `added ${added.type} ${added.width}`);
  assert((await page.locator("[data-handle]").count()) === 8, "new rect not selected");
  return { type: added.type, width: added.width, height: added.height };
});

await check("draw frame, rect, ellipse, line, text, note from the keyboard", async () => {
  const created = [];
  for (const key of ["f", "r", "o", "l"]) {
    await focusCanvas(page);
    await page.keyboard.press("Escape");
    await page.keyboard.press(key);
    await page.keyboard.press("Enter");
    created.push(key);
  }
  for (const [key, text] of [
    ["t", "Keyboard text"],
    ["n", "Keyboard note"],
  ]) {
    await focusCanvas(page);
    await page.keyboard.press("Escape");
    await page.keyboard.press(key);
    await page.keyboard.press("Enter");
    await page.locator("[data-testid=design-canvas] textarea").fill(text);
    await page.keyboard.press("ControlOrMeta+Enter");
  }
  await saved(page);
  const nodes = (await head(page)).pages[0].nodes;
  const types = new Set(nodes.map((n) => n.type));
  for (const type of ["frame", "rect", "ellipse", "line", "text", "note"])
    assert(types.has(type), `no ${type}`);
  assert(
    nodes.some((n) => n.type === "text" && n.text === "Keyboard text"),
    "text content missing",
  );
  assert(
    nodes.some((n) => n.type === "note" && n.text === "Keyboard note"),
    "note content missing",
  );
  await shot(page, "02-drawn-from-keyboard");
});

await check("pen draws a path from clicks", async () => {
  const { box } = await center(page, `[data-node="${frameId}"]`);
  await focusCanvas(page);
  await page.keyboard.press("Escape");
  await page.keyboard.press("p");
  const y = box.y + box.height + 120;
  for (const [dx, dy] of [
    [300, 0],
    [360, 40],
    [420, 0],
  ])
    await page.mouse.click(box.x + dx, y + dy);
  await focusCanvas(page);
  await page.keyboard.press("Enter");
  await saved(page);
  const path_ = (await head(page)).pages[0].nodes.find((n) => n.type === "path");
  assert(path_ !== undefined, "no path node");
  return { points: path_.points?.length };
});

await check("image tool places an uploaded image", async () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8Dwn4GBgYGJgYGBAQAOCgEDf6v8oQAAAABJRU5ErkJggg==",
    "base64",
  );
  await page
    .getByTestId("image-input")
    .setInputFiles({ name: "berth.png", mimeType: "image/png", buffer: png });
  const image = await waitFor(
    async () => (await head(page)).pages[0].nodes.find((n) => n.type === "image"),
    5000,
    "image node",
  );
  assert(image !== undefined && typeof image.asset === "string", "no image node with asset");
  const src = await page.locator(`[data-node="${image.id}"] img`).getAttribute("src");
  assert(src?.startsWith("data:image/png"), `image src ${src?.slice(0, 30)}`);
  return { asset: image.asset };
});

await check("select and move a layer with the pointer", async () => {
  const before = await node(page, "n_title");
  const { x, y } = await center(page, '[data-node="n_title"]');
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 20, y + 10, { steps: 5 });
  await page.mouse.move(x + 40, y + 20, { steps: 5 });
  await page.mouse.up();
  await saved(page);
  const after = await node(page, "n_title");
  assert(after.x > before.x && after.y > before.y, `moved to ${after.x},${after.y}`);
  return { from: [before.x, before.y], to: [after.x, after.y] };
});

await check("resize from the corner handle", async () => {
  const before = await node(page, "n_card");
  await clickCorner(page, "n_card");
  const handle = await center(page, '[data-handle="se"]');
  await page.mouse.move(handle.x, handle.y);
  await page.mouse.down();
  await page.mouse.move(handle.x + 30, handle.y + 30, { steps: 6 });
  await page.mouse.up();
  await saved(page);
  const after = await node(page, "n_card");
  assert(after.width > before.width && after.height > before.height, "size did not grow");
  await shot(page, "03-resized-selection");
  return { from: [before.width, before.height], to: [after.width, after.height] };
});

await check("nudge, undo and redo", async () => {
  await selectNode(page, "n_body");
  await focusCanvas(page);
  const start = (await node(page, "n_body")).x;
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Shift+ArrowRight");
  await saved(page);
  assert((await node(page, "n_body")).x === start + 11, "nudge did not move by 11");
  await page.keyboard.press("ControlOrMeta+z");
  await saved(page);
  const undone = (await node(page, "n_body")).x;
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await saved(page);
  const redone = (await node(page, "n_body")).x;
  assert(undone < start + 11 && redone === start + 11, `undo ${undone}, redo ${redone}`);
  return { start, undone, redone };
});

await check("multi-select, align left, duplicate and delete", async () => {
  await selectNode(page, "n_title");
  await selectNode(page, "n_body", { shift: true });
  await focusCanvas(page);
  await page.keyboard.press("Alt+KeyA");
  await saved(page);
  const [title, body] = [await node(page, "n_title"), await node(page, "n_body")];
  assert(title.x === body.x, `align left gave ${title.x} and ${body.x}`);
  const before = await nodeCount(page);
  const leaked = await page.evaluate(() => {
    window.__leaked = 0;
    window.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "d") window.__leaked += 1;
    });
    return 0;
  });
  await page.keyboard.press("ControlOrMeta+d");
  await saved(page);
  const duplicated = await nodeCount(page);
  assert(duplicated === before + 2, `duplicate gave ${duplicated - before} nodes`);
  const reachedApp = await page.evaluate(() => window.__leaked);
  assert(reachedApp === leaked, "mod+d reached the window (app keybinding would fire)");
  await page.keyboard.press("Backspace");
  await saved(page);
  assert((await nodeCount(page)) === before, "delete did not remove the duplicates");
  return { aligned: title.x, duplicated: 2, modDReachedWindow: reachedApp };
});

await check("pick a color token in the properties panel", async () => {
  await selectNode(page, "n_header");
  await page
    .getByTestId("properties-panel")
    .getByRole("button", { name: /^Fill:/ })
    .click();
  await page
    .getByRole("option", { name: /^accent\b(?!-)/ })
    .first()
    .click();
  await saved(page);
  const header = await node(page, "n_header");
  assert(header.fill?.token === "accent", `fill is ${JSON.stringify(header.fill)}`);
  await shot(page, "04-token-picked");
  return { fill: header.fill };
});

await check("dragging the color picker previews live and saves one undo step", async () => {
  await selectNode(page, "n_header");
  const before = (await node(page, "n_header")).fill;
  const appliedBefore = await page.evaluate(() => window.__design.applied.length);
  await page
    .getByTestId("properties-panel")
    .getByRole("button", { name: /^Fill:/ })
    .click();
  const input = page.locator('input[type="color"][aria-label="Fill color"]');
  await input.waitFor();
  await input.evaluate(async (element) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    for (const color of ["#112233", "#223344", "#334455", "#445566", "#556677"]) {
      setter.call(element, color);
      element.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  });
  const previewed = await page
    .locator('[data-node="n_header"]')
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  assert(previewed === "rgb(85, 102, 119)", `preview shows ${previewed}`);
  await page.waitForTimeout(600);
  assert(
    (await page.evaluate(() => window.__design.applied.length)) === appliedBefore,
    "saved during the drag",
  );
  await input.evaluate((element) => element.dispatchEvent(new Event("change", { bubbles: true })));
  await page.keyboard.press("Escape");
  await saved(page);
  const applied = (await page.evaluate(() => window.__design.applied.length)) - appliedBefore;
  assert(applied === 1, `${applied} saves for one drag`);
  assert((await node(page, "n_header")).fill === "#556677", "final color not saved");
  await focusCanvas(page);
  await page.keyboard.press("ControlOrMeta+z");
  await saved(page);
  const undone = (await node(page, "n_header")).fill;
  assert(
    JSON.stringify(undone) === JSON.stringify(before),
    `one undo gave ${JSON.stringify(undone)}`,
  );
  return { saves: applied, undoneTo: undone };
});

await check("an agent edit shows on the canvas within 1 s", async () => {
  const started = await page.evaluate(() => {
    window.__design.agentEdit([
      {
        op: "update_node",
        pageId: window.__design.head.pages[0].id,
        id: "n_title",
        patch: { text: "Berths for tonight" },
      },
    ]);
    return performance.now();
  });
  await page.waitForFunction(
    () =>
      document.querySelector('[data-node="n_title"]')?.textContent?.includes("Berths for tonight"),
    null,
    { timeout: 1000 },
  );
  const ms = Math.round((await page.evaluate(() => performance.now())) - started);
  assert(ms < 1000, `took ${ms} ms`);
  return { ms };
});

await check("a true conflict shows the banner and Keep mine wins", async () => {
  await selectNode(page, "n_body");
  await focusCanvas(page);
  const before = (await node(page, "n_body")).y;
  await page.keyboard.press("Shift+ArrowDown");
  await page.evaluate(() =>
    window.__design.agentEdit([
      {
        op: "update_node",
        pageId: window.__design.head.pages[0].id,
        id: "n_body",
        patch: { y: 640 },
      },
    ]),
  );
  await page.getByTestId("conflict-banner").waitFor({ timeout: 3000 });
  await shot(page, "05-conflict-banner");
  await page.getByRole("button", { name: "Keep mine" }).click();
  await saved(page);
  const after = (await node(page, "n_body")).y;
  assert(after === before + 10, `kept ${after}, expected ${before + 10}`);
  return { mine: after, theirs: 640 };
});

await check("place a comment and see its pin", async () => {
  const before = (await head(page)).comments?.length ?? 0;
  const { x, y } = await center(page, '[data-node="n_card"]');
  await focusCanvas(page);
  await page.keyboard.press("Escape");
  await page.keyboard.press("c");
  await page.mouse.click(x, y);
  await page.getByPlaceholder("What should change?").fill("Show tide times under the map.");
  await page
    .getByTestId("comments-panel")
    .getByRole("button", { name: "Comment", exact: true })
    .click();
  await saved(page);
  const comments = (await head(page)).comments ?? [];
  assert(comments.length === before + 1, "comment not saved");
  assert((await page.locator("[data-comment-pin]").count()) >= 1, "no pin");
  await shot(page, "06-comment");
  return { comments: comments.length };
});

await check("ask the agent about a selection sends text and a PNG", async () => {
  await page
    .getByRole("button", { name: "Close comments" })
    .click()
    .catch(() => undefined);
  await focusCanvas(page);
  await page.keyboard.press("Escape");
  await page.keyboard.press("v");
  await clickCorner(page, "n_card");
  await page.getByTestId("mini-toolbar").waitFor();
  await page.getByRole("button", { name: "Ask agent about selection" }).click();
  await page.getByLabel("Request for the agent").fill("Make the map card taller.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const message = await waitFor(
    () =>
      page.evaluate(() =>
        window.__design.sent.find((m) => m.text.includes("Make the map card taller.")),
      ),
    5000,
    "sent message",
  );
  assert(message.images === 1, `images ${message.images}`);
  assert(message.text.includes("n_card"), "message does not name the layer id");
  await page.getByTestId("fixture-message").first().waitFor();
  await shot(page, "07-ask-agent");
  return { threadId: message.threadId, images: message.images };
});

await check("export PNG, SVG, HTML and PDF downloads", async () => {
  const files = {};
  for (const [item, ext] of [
    [/^PNG of Booking/, "png"],
    ["SVG", "svg"],
    ["Standalone HTML", "html"],
    ["PDF of all frames", "pdf"],
  ]) {
    await page.getByRole("button", { name: "Export", exact: true }).click();
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 10000 }),
      page.getByRole("menuitem", { name: item }).click(),
    ]);
    const file = NodePath.join(downloads, `booking.${ext}`);
    await download.saveAs(file);
    const bytes = NodeFS.readFileSync(file);
    files[ext] = bytes.length;
    if (ext === "png") assert(bytes.subarray(1, 4).toString() === "PNG", "not a PNG");
    if (ext === "svg") assert(bytes.toString().includes("<svg"), "not an SVG");
    if (ext === "html")
      assert(bytes.toString().includes("Berths for tonight"), "HTML lacks the headline");
    if (ext === "pdf") assert(bytes.subarray(0, 5).toString() === "%PDF-", "not a PDF");
  }
  return files;
});

await check("present mode steps through frames and exits with Escape", async () => {
  await page.getByRole("button", { name: "Present" }).click();
  const present = page.getByTestId("present-mode");
  await present.waitFor();
  await page.waitForTimeout(300);
  await shot(page, "08-present");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Escape");
  await present.waitFor({ state: "detached", timeout: 2000 });
});

await check("share dialog lists access and states public links are unavailable", async () => {
  await page.getByRole("button", { name: "Share" }).click();
  const dialog = page.getByTestId("share-dialog");
  await dialog.waitFor();
  try {
    const text = await dialog.textContent();
    // 94a06761d2 reworded the notice ("aren't available in this build yet") and moved the
    // link into the Copy link tooltip; both must still be stated.
    for (const expected of [
      "Can edit",
      "Agent threads",
      "Copy link",
      "Public web links aren't available",
    ])
      assert(text.includes(expected), `share dialog lacks "${expected}"`);
    await dialog.getByTestId("share-copy-link").hover();
    await page.getByText("/design/pg.d_fixture").waitFor({ timeout: 3000 });
    await dialog.getByRole("combobox", { name: "Agent threads access" }).click();
    await page.getByRole("option", { name: "Can comment" }).click();
    await saved(page);
    const access = (await head(page)).access;
    assert(access?.agents === "comment", `access ${JSON.stringify(access)}`);
    await shot(page, "09-share");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached", timeout: 2000 });
    return { access };
  } finally {
    // A failed assertion must not leave the modal open: that also failed the next three checks.
    for (let i = 0; i < 3 && (await dialog.count()) > 0; i += 1) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(150);
    }
  }
});

await check(
  "implement this frame sends JSON, PNG, tokens and components to a coding thread",
  async () => {
    await focusCanvas(page);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Implement this frame" }).click();
    const dialog = page.getByTestId("implement-frame-dialog");
    await dialog.waitFor();
    await dialog.getByText("Booking page in the web app").click();
    await shot(page, "10-implement");
    await dialog.getByRole("button", { name: "Send frame" }).click();
    const message = await waitFor(
      () => page.evaluate(() => window.__design.sent.find((m) => m.threadId === "thread-web")),
      8000,
      "implement message",
    );
    for (const expected of ["`surface-muted`", "- Button", "```json", '"n_title"'])
      assert(message.text.includes(expected), `message lacks ${expected}`);
    assert(message.images === 1, "no PNG attached");
    return { threadId: message.threadId, chars: message.text.length };
  },
);

await check("keyboard alone reaches the title, tools, canvas and header actions", async () => {
  await page.locator("body").focus();
  await page.evaluate(
    () => document.activeElement instanceof HTMLElement && document.activeElement.blur(),
  );
  const reached = new Set();
  for (let i = 0; i < 90; i += 1) {
    await page.keyboard.press("Tab");
    const label = await page.evaluate(() => {
      const el = document.activeElement;
      return (
        el?.getAttribute("aria-label") ??
        el?.getAttribute("data-tool") ??
        el?.textContent?.trim().slice(0, 24) ??
        ""
      );
    });
    reached.add(label);
  }
  for (const expected of ["Design title", "Design canvas", "Share", "Export", "Present"])
    assert(
      [...reached].some((label) => label.startsWith(expected)),
      `Tab never reached ${expected}`,
    );
  assert(
    [...reached].some((label) => label.startsWith("Rectangle") || label === "rect"),
    "Tab never reached the tool rail",
  );
  return { stops: reached.size };
});

await check("header picker sets the design system and copies another owner's", async () => {
  const picker = page.getByTestId("design-system-picker").getByRole("combobox");
  assert(
    (await picker.textContent()).includes("Harbor UI"),
    "picker does not show the current system",
  );
  await picker.click();
  await page.getByRole("option", { name: /Marina UI/ }).click();
  await page.waitForFunction(() => window.__design.head.designSystem === "s_marina_copy");
  await saved(page);
  const copies = await page.evaluate(() => window.__design.copies);
  assert(JSON.stringify(copies) === '["s_marina"]', `copies ${JSON.stringify(copies)}`);
  assert((await picker.textContent()).includes("Marina UI"), "copy not selected");
  await shot(page, "16-design-system-copied");
  await picker.click();
  await page.getByRole("option", { name: "Harbor UI" }).click();
  await page.waitForFunction(() => window.__design.head.designSystem === "s_fixture");
  await saved(page);
  return { copied: copies[0], head: "s_fixture" };
});

await check("no console errors in the main flow", async () => {
  assert(errors.length === 0, errors.join("\n"));
});

const video = page.video();
await page.close();
await context.close();
await video?.saveAs(NodePath.join(out, "canvas-flow.webm"));
await video?.delete();

// ---- dark theme ------------------------------------------------------------------------------
await check("dark theme renders tokens in the dark mode with a selection", async () => {
  const dark = await browser.newContext({ viewport: VIEWPORT, colorScheme: "dark" });
  const darkPage = await open(dark, "theme=dark");
  await selectNode(darkPage, "n_cta");
  await darkPage.waitForTimeout(200);
  await shot(darkPage, "11-dark-selection");
  const background = await darkPage
    .locator(`[data-node="${frameId}"]`)
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  assert(background === "rgb(23, 24, 28)", `frame background ${background}`);
  await dark.close();
  return { frameBackground: background };
});

// ---- access levels ---------------------------------------------------------------------------
await check(
  "view-only: no title edit, no undo, no comment tool, no Ask agent, no moves",
  async () => {
    const ctx = await browser.newContext({ viewport: VIEWPORT });
    const p = await open(ctx, "member=view");
    assert(
      (await p.locator('input[aria-label="Design title"]').count()) === 0,
      "title is editable",
    );
    assert(
      await p.getByTestId("design-system-picker").getByRole("combobox").isDisabled(),
      "view-only can change the design system",
    );
    await p.evaluate(() =>
      window.__design.agentEdit([
        {
          op: "update_node",
          pageId: window.__design.head.pages[0].id,
          id: "n_title",
          patch: { text: "Agent words" },
        },
      ]),
    );
    await p.waitForTimeout(200);
    await selectNode(p, "n_title");
    await focusCanvas(p);
    await p.keyboard.press("ControlOrMeta+z");
    await p.keyboard.press("c");
    await p.waitForTimeout(600);
    assert((await node(p, "n_title")).text === "Agent words", "Cmd+Z changed a view-only design");
    assert((await p.locator('[data-tool="comment"]').count()) === 0, "comment tool shown");
    const box = await p.getByTestId("design-canvas").boundingBox();
    await p.mouse.click(box.x + box.width - 40, box.y + box.height - 40);
    await p.waitForTimeout(200);
    assert(
      (await p.getByPlaceholder("What should change?").count()) === 0,
      "C opened a comment draft",
    );
    assert(
      (await p.getByRole("button", { name: "Ask agent about selection" }).count()) === 0,
      "Ask agent shown",
    );
    const before = await node(p, "n_title");
    const { x, y } = await center(p, '[data-node="n_title"]');
    await p.mouse.move(x, y);
    await p.mouse.down();
    await p.mouse.move(x + 60, y + 30, { steps: 6 });
    await p.mouse.up();
    await p.waitForTimeout(600);
    const after = await node(p, "n_title");
    assert(after.x === before.x && after.y === before.y, "a view-only drag moved the layer");
    await shot(p, "15-view-only");
    await ctx.close();
  },
);

await check("comment access: C picks the comment tool, Ask agent stays hidden", async () => {
  const ctx = await browser.newContext({ viewport: VIEWPORT });
  const p = await open(ctx, "member=comment");
  await focusCanvas(p);
  await p.keyboard.press("c");
  assert(
    (await p.locator('[data-tool="comment"]').getAttribute("aria-pressed")) === "true",
    "C did not pick the comment tool",
  );
  await p.keyboard.press("Escape");
  await selectNode(p, "n_title");
  assert(
    (await p.getByRole("button", { name: "Comment on selection" }).count()) === 1,
    "no Comment",
  );
  assert(
    await p.getByTestId("design-system-picker").getByRole("combobox").isDisabled(),
    "comment access can change the design system",
  );
  assert(
    (await p.getByRole("button", { name: "Ask agent about selection" }).count()) === 0,
    "Ask agent shown",
  );
  await ctx.close();
});

await check("an older server without SVG export keeps PNG, HTML and PDF", async () => {
  const ctx = await browser.newContext({ viewport: VIEWPORT });
  const p = await open(ctx, "noSvgExport");
  await p.getByRole("button", { name: "Export", exact: true }).click();
  await p.getByRole("menuitem", { name: "Standalone HTML" }).waitFor();
  const items = await p.getByRole("menuitem").allTextContents();
  await ctx.close();
  assert(!items.includes("SVG"), `SVG offered: ${items.join(", ")}`);
  for (const expected of ["PNG at 2x", "Standalone HTML", "PDF of all frames"])
    assert(items.includes(expected), `lacks "${expected}": ${items.join(", ")}`);
  return { items };
});

// ---- bound thread states ---------------------------------------------------------------------
await check("design without a thread offers Start a thread", async () => {
  const ctx = await browser.newContext({ viewport: VIEWPORT });
  const p = await open(ctx, "thread=none");
  await p.getByTestId("bound-thread-empty").waitFor();
  await shot(p, "12-thread-none");
  await p.getByRole("button", { name: "Start a thread" }).click();
  await p.getByTestId("fixture-chat").waitFor({ timeout: 3000 });
  await saved(p);
  const thread = (await head(p)).thread;
  assert(thread?.threadId === "thread-started", `bound ${JSON.stringify(thread)}`);
  await ctx.close();
  return { thread };
});

await check("thread on another machine offers Open there and Start a thread here", async () => {
  const ctx = await browser.newContext({ viewport: VIEWPORT });
  const p = await open(ctx, "thread=other");
  const empty = p.getByTestId("bound-thread-empty");
  await empty.waitFor();
  const text = await empty.textContent();
  for (const expected of ["Mac mini (studio)", "Open there", "Start a thread here"])
    assert(text.includes(expected), `lacks "${expected}"`);
  await shot(p, "13-thread-other-machine");
  await ctx.close();
});

// ---- AC-13 performance -----------------------------------------------------------------------
const perf = {};
await check("500 nodes: idle canvas schedules no frames and does no layout", async () => {
  const ctx = await browser.newContext({ viewport: VIEWPORT });
  await ctx.addInitScript(() => {
    const original = window.requestAnimationFrame.bind(window);
    window.__raf = { count: 0, original };
    window.requestAnimationFrame = (callback) => {
      window.__raf.count += 1;
      return original(callback);
    };
  });
  const p = await open(ctx, "nodes=500");
  perf.page = p;
  perf.context = ctx;
  const rendered = await p.locator("[data-testid=design-world] [data-node]").count();
  assert(rendered >= 500, `rendered ${rendered} nodes`);
  await p.waitForTimeout(1500);
  const cdp = await ctx.newCDPSession(p);
  perf.cdp = cdp;
  await cdp.send("Performance.enable");
  const metrics = async () =>
    Object.fromEntries(
      (await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]),
    );
  const before = await metrics();
  const rafBefore = await p.evaluate(() => window.__raf.count);
  await p.waitForTimeout(3000);
  const after = await metrics();
  const rafAfter = await p.evaluate(() => window.__raf.count);
  const idle = {
    rendered,
    rafCalls: rafAfter - rafBefore,
    layouts: after.LayoutCount - before.LayoutCount,
    styleRecalcs: after.RecalcStyleCount - before.RecalcStyleCount,
  };
  perf.idle = idle;
  assert(idle.rafCalls === 0, `${idle.rafCalls} rAF calls while idle`);
  assert(idle.layouts === 0, `${idle.layouts} layouts while idle`);
  return idle;
});

async function measureFrames(p, action) {
  await p.evaluate(() => {
    window.__frames = [];
    const loop = (time) => {
      window.__frames.push(time);
      if (window.__frames.length < 100000 && window.__measuring) window.__raf.original(loop);
    };
    window.__measuring = true;
    window.__raf.original(loop);
  });
  await action();
  return p.evaluate(() => {
    window.__measuring = false;
    const frames = window.__frames;
    const gaps = frames
      .slice(1)
      .map((time, i) => time - frames[i])
      .sort((a, b) => a - b);
    const duration = frames.at(-1) - frames[0];
    return {
      frames: frames.length,
      fps: Math.round(((frames.length - 1) / duration) * 1000 * 10) / 10,
      p95FrameMs: Math.round(gaps[Math.floor(gaps.length * 0.95)] * 10) / 10,
      maxFrameMs: Math.round(gaps.at(-1) * 10) / 10,
    };
  });
}

await check("500 nodes: wheel pan holds 60 fps", async () => {
  const p = perf.page;
  assert(p, "perf page missing");
  await browser.startTracing(p, {
    path: NodePath.join(out, "perf-pan-trace.json"),
    screenshots: false,
  });
  const { x, y } = await center(p, "[data-testid=design-canvas]");
  await p.mouse.move(x, y);
  const result = await measureFrames(p, async () => {
    for (let i = 0; i < 90; i += 1) {
      await p.mouse.wheel(i < 45 ? 12 : -12, i < 45 ? 8 : -8);
      await p.waitForTimeout(16);
    }
  });
  await browser.stopTracing();
  perf.pan = result;
  assert(result.fps >= 55, `pan at ${result.fps} fps`);
  return result;
});

await check("500 nodes: dragging a layer holds 60 fps", async () => {
  const p = perf.page;
  const id = await p.evaluate(
    () =>
      window.__design.head.pages[0].nodes.find((n) => n.parentId === "n_grid" && n.type === "rect")
        ?.id,
  );
  assert(id, "no stress cell");
  const { x, y } = await center(p, `[data-node="${id}"]`);
  await p.mouse.click(x, y);
  await p.mouse.move(x, y);
  await p.mouse.down();
  const result = await measureFrames(p, async () => {
    for (let i = 1; i <= 90; i += 1) {
      await p.mouse.move(x + i * 2, y + i);
      await p.waitForTimeout(16);
    }
  });
  await p.mouse.up();
  perf.drag = result;
  assert(result.fps >= 55, `drag at ${result.fps} fps`);
  await shot(p, "14-stress-500");
  return result;
});
await perf.context?.close();

// ---- report ----------------------------------------------------------------------------------
await browser.close();
await site.close();
const passed = results.filter((r) => r.ok).length;
const report = {
  at: new Date().toISOString(),
  passed,
  failed: results.length - passed,
  perf: { idle: perf.idle, pan: perf.pan, drag: perf.drag },
  results,
  consoleErrors: errors,
};
NodeFS.writeFileSync(NodePath.join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(
  `\n${passed}/${results.length} checks passed. Report: ${NodePath.join(out, "report.json")}`,
);
process.exit(passed === results.length ? 0 : 1);
