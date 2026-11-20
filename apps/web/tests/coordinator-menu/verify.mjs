// Build first: vp build --config apps/web/tests/coordinator-menu/vite.config.ts
// Usage: node apps/web/tests/coordinator-menu/verify.mjs [/absolute/evidence-dir]
// Always headless. Playwright comes from STUDIO_PLAYWRIGHT_MODULE, else apps/server's
// playwright-core; STUDIO_CHROMIUM_EXECUTABLE picks a browser binary.
// 1427 AC-09: a window served by M5 that shows linux-mini's coordinator. Checks, light and
// dark at 1280 and 390 px, that the sidebar header, the project header's tag, the machine
// menu, the message labels, the reply source chip, a thread chip, a relayed note and the
// coordinator's question card each name their machine in visible text, and shoots each case.
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
const output = NodePath.resolve(
  process.argv.slice(2).find((a) => !a.startsWith("--")) ?? ".artifacts/coordinator-menu/evidence",
);
await NodeFSP.mkdir(output, { recursive: true });
const root = NodePath.resolve(".artifacts/coordinator-menu/site");
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = NodePath.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    NodeAssert.ok(file.startsWith(root + NodePath.sep));
    res.setHeader(
      "Content-Type",
      { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" }[
        NodePath.extname(file)
      ] ?? "text/html",
    );
    res.end(await NodeFSP.readFile(file));
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
/** The machine hues in index.css, written out so a stylesheet change cannot move both sides. */
const MACHINE_HUES = { teal: "#0e8177", blue: "#2f6fd6" };
const results = [];
const errors = [];

/** Visible text, not screen-reader text or a tooltip: a real box, inside the viewport. */
async function assertShown(page, locator, expected, width) {
  NodeAssert.equal((await locator.textContent())?.trim(), expected);
  const facts = await locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    let node = element;
    let srOnly = false;
    while (node) {
      if (node.classList?.contains("sr-only")) srOnly = true;
      node = node.parentElement;
    }
    const style = getComputedStyle(element);
    return {
      width: box.width,
      height: box.height,
      left: box.left,
      right: box.right,
      srOnly,
      hidden: style.visibility === "hidden" || style.display === "none",
      clipped: element.scrollWidth > element.clientWidth + 1,
    };
  });
  NodeAssert.equal(facts.srOnly, false, `${expected} is screen-reader text`);
  NodeAssert.equal(facts.hidden, false, `${expected} is hidden`);
  NodeAssert.ok(facts.width > 0 && facts.height > 0, `${expected} has no box`);
  NodeAssert.ok(facts.left >= 0 && facts.right <= width + 0.5, `${expected} leaves the window`);
  NodeAssert.equal(facts.clipped, false, `${expected} is cut off`);
}

/**
 * The name's colour as drawn: its references are linux-mini's teal and M5's blue, each mixed
 * toward this theme's text as a machine name is drawn, resolved on the page as sRGB bytes.
 */
async function machineReferences(page) {
  return page.evaluate(
    (hues) =>
      hues.map((hue) => {
        const probe = document.createElement("span");
        probe.style.color = `color-mix(in srgb, ${hue} 42%, var(--foreground))`;
        document.body.append(probe);
        const css = getComputedStyle(probe).color;
        probe.remove();
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const context = canvas.getContext("2d");
        context.fillStyle = css;
        context.fillRect(0, 0, 1, 1);
        return { css, rgb: [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)] };
      }),
    [MACHINE_HUES.teal, MACHINE_HUES.blue],
  );
}

/** The element's pixels as the screen shows them, decoded on the page from its screenshot. */
async function screenPixels(page, locator) {
  const png = await locator.screenshot({ animations: "disabled" });
  return page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, image.width, image.height).data;
    const pixels = [];
    for (let i = 0; i < data.length; i += 4) pixels.push([data[i], data[i + 1], data[i + 2]]);
    return pixels;
  }, png.toString("base64"));
}

const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * The name's colour under the production stylesheet: its computed colour and text fill equal
 * the teal reference, and its own screenshot has enough high-contrast pixels whose mean is
 * within 30 of teal and nearer teal than M5's blue. A stylesheet written to defeat the check,
 * for example an opaque overlay that hides the letters and paints a teal patch, is not caught:
 * the fixture guards production styles, not hostile ones.
 */
async function assertPaintedTeal(page, locator, theme) {
  const [teal, blue] = await machineReferences(page);
  NodeAssert.ok(distance(teal.rgb, blue.rgb) > 40, `${theme}: teal and blue references alike`);
  // Bytes, not CSS text: a precomputed hex and a color-mix serialize differently.
  const computed = await locator.evaluate((element) => {
    const style = getComputedStyle(element);
    const context = document.createElement("canvas").getContext("2d");
    const bytes = (css) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = css;
      context.fillRect(0, 0, 1, 1);
      return { css, rgba: [...context.getImageData(0, 0, 1, 1).data] };
    };
    return { color: bytes(style.color), fill: bytes(style.webkitTextFillColor) };
  });
  for (const [what, value] of [
    ["colour", computed.color],
    ["text fill", computed.fill],
  ])
    NodeAssert.ok(
      value.rgba[3] === 255 && distance(value.rgba, teal.rgb) <= 2,
      `${theme}: the name's ${what} ${value.css} is not teal rgb(${teal.rgb})`,
    );

  const pixels = await screenPixels(page, locator);
  const counts = new Map();
  for (const pixel of pixels) counts.set(pixel.join(), (counts.get(pixel.join()) ?? 0) + 1);
  const background = [...counts]
    .sort((a, b) => b[1] - a[1])[0][0]
    .split(",")
    .map(Number);
  const away = pixels.map((pixel) => distance(pixel, background));
  const reach = Math.max(...away);
  NodeAssert.ok(reach >= 60, `${theme}: the name barely shows (contrast ${reach.toFixed(0)})`);
  const ink = pixels.filter((_, index) => away[index] >= 0.5 * reach);
  const core = pixels.filter((_, index) => away[index] >= 0.95 * reach);
  NodeAssert.ok(ink.length >= 40 && core.length >= 8, `${theme}: too few coloured pixels`);
  const mean = [0, 1, 2].map((c) => core.reduce((sum, pixel) => sum + pixel[c], 0) / core.length);
  const toTeal = distance(mean, teal.rgb);
  const toBlue = distance(mean, blue.rgb);
  NodeAssert.ok(
    toTeal < toBlue && toTeal <= 30,
    `${theme}: the name shows rgb(${mean.map(Math.round)}), ${toTeal.toFixed(0)} from teal ` +
      `rgb(${teal.rgb}) and ${toBlue.toFixed(0)} from blue rgb(${blue.rgb})`,
  );
}

try {
  for (const theme of ["light", "dark"])
    for (const width of [1280, 390]) {
      const page = await browser.newPage({
        viewport: { width, height: 900 },
        colorScheme: theme,
        deviceScaleFactor: 2,
      });
      page.on("pageerror", (error) => errors.push(`${theme} ${width}: ${error.message}`));
      await page.goto(`${origin}/?theme=${theme}`);
      await page.locator('[data-fixture="conversation"]').waitFor();
      await page.waitForTimeout(300);
      const at = (fixture, selector) => page.locator(`[data-fixture="${fixture}"] ${selector}`);
      // The window's own machine, in the sidebar header and beside the coordinator's tag.
      await assertShown(page, at("sidebar-header", "[data-window-machine]"), "Window on M5", width);
      await assertShown(
        page,
        at("project-header", "[data-project-machine]"),
        "linux-mini's coordinator",
        width,
      );
      await assertShown(page, at("project-header", "[data-window-machine]"), "Window on M5", width);
      // Messages: the user's goes to linux-mini's coordinator; the reply comes from it.
      NodeAssert.deepEqual(
        (await at("conversation", "[data-request-execution]").allTextContents()).map((t) =>
          t.trim(),
        ),
        ["To linux-mini's coordinator", "Coordinator on linux-mini · Claude Code · Opus 5.5"],
      );
      // The reply's sources: a worker on M5 says so; the coordinator's own thread adds nothing.
      const sources = (await at("conversation", ".sws-reply-source").allTextContents()).map((t) =>
        t.replace(/\s+/g, " ").trim(),
      );
      NodeAssert.deepEqual(sources, ["re: Release notes · M5 ↗", "re: Sign-in check ↗"]);
      await assertShown(page, at("conversation", "[data-reply-source-machine]"), "· M5", width);
      NodeAssert.equal(await at("conversation", "[data-reply-source-machine]").count(), 1);
      // A thread chip and a relayed note name the worker's machine.
      // The chip's title and machine are separate boxes, so the machine is checked on its own.
      await assertShown(
        page,
        at("conversation", "[data-thread-chip] .sws-thread-link-machine"),
        "· M5",
        width,
      );
      NodeAssert.equal(
        (await at("conversation", "[data-relayed-from]").textContent()).trim(),
        "Message from Release notes · M5",
      );
      // The coordinator's question card names the machine its answer goes to, in its colour.
      const card = at("question", "[data-coordinator-question]");
      await card.waitFor();
      await assertShown(page, card.locator("[data-action-machine-tag]"), "on linux-mini", width);
      NodeAssert.equal(
        await card.locator("[data-action-machine]").getAttribute("data-machine-color"),
        "teal",
      );
      NodeAssert.equal(await card.locator("[data-action-machine-tag]").count(), 1);
      // The colour painted, not the attribute (see assertPaintedTeal).
      await assertPaintedTeal(page, card.locator("[data-action-machine]"), theme);
      let file = NodePath.join(output, `coordinator-menu-remote-${theme}-${width}.png`);
      await page.screenshot({ path: file, fullPage: true });
      results.push({ theme, width, case: "remote coordinator, window on M5", file });

      // The machine menu marks the window's own row, in visible text.
      await page.locator('[aria-label^="Viewing linux-mini"]').click();
      await page.locator('[role="menu"]').waitFor();
      await page.waitForTimeout(200);
      const row = (key) => page.locator(`[data-orchestrator-view="${key}"]`);
      await assertShown(
        page,
        row("this-mac:atlas").locator("[data-row-window]"),
        "this window",
        width,
      );
      NodeAssert.equal(await row("linux-mini:atlas").locator("[data-row-window]").count(), 0);
      file = NodePath.join(output, `coordinator-menu-switcher-${theme}-${width}.png`);
      await page.screenshot({ path: file });
      results.push({ theme, width, case: "machine menu marks this window", file });
      await page.close();
    }
  NodeAssert.deepEqual(errors, []);
  await NodeFSP.writeFile(
    NodePath.join(output, "coordinator-menu-results.json"),
    `${JSON.stringify(results, null, 2)}\n`,
  );
  console.log(JSON.stringify({ ok: true, shots: results.length, output }, null, 2));
} finally {
  await browser.close();
  server.close();
}
