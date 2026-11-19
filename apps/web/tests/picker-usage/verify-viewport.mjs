// Build first: node node_modules/vite-plus/bin/vp build --config apps/web/tests/picker-usage/vite.config.ts
// Then: node apps/web/tests/picker-usage/verify-viewport.mjs /absolute/report-dir [shot-prefix]
// Always headless. Serves the fixture only; every other request is aborted. Fictional data.
// The composer's model picker stays inside the window at narrow and laptop widths: the popup
// lies within the viewport, its content is no wider than the popup (nothing clipped on
// either side, nothing to slide sideways when a row's star takes focus), and the actions
// row with the key hints does not overflow. Saves <prefix>-<width>.png per width, dark.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const assert = NodeAssert.default;
const { mkdir, readFile, writeFile } = NodeFSP;
const { extname, join, resolve, sep } = NodePath;

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = process.env.STUDIO_PLAYWRIGHT_MODULE
  ? await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href)
  : NodeModule.createRequire(resolve("apps/server/package.json"))("playwright-core");

const root = resolve(".artifacts/picker-usage/site");
const output = resolve(process.argv[2] ?? ".artifacts/picker-usage/evidence");
const prefix = process.argv[3] ?? "picker-viewport";
await mkdir(output, { recursive: true });
const MIME = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(root + sep)) return void res.writeHead(403).end();
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "text/html" }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;

const checks = [];
const failures = [];
const errors = [];
const browser = await chromium.launch({
  headless: true,
  ...(process.env.STUDIO_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE }
    : {}),
});
let passed = false;
try {
  const context = await browser.newContext({
    reducedMotion: "reduce",
    timezoneId: "America/New_York",
    locale: "en-US",
  });
  await context.clock.setFixedTime(new Date("2026-10-21T15:00:00Z"));
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.route("**/*", (route) =>
    route.request().url().startsWith(origin) ? route.continue() : route.abort(),
  );
  const settle = () =>
    page.evaluate(async () => {
      await Promise.all(
        document.getAnimations().map((animation) => animation.finished.catch(() => {})),
      );
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    });
  const measure = () =>
    page.evaluate(() => {
      const box = (selector) => {
        const node = document.querySelector(selector);
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          scrollWidth: node.scrollWidth,
          clientWidth: node.clientWidth,
          scrollLeft: node.scrollLeft,
        };
      };
      return {
        popup: box("[data-model-picker-popup]"),
        viewport: box("[data-model-picker-popup] [data-slot=popover-viewport]"),
        content: box("[data-model-picker-content]"),
        actions: box("[data-model-picker-actions]"),
        pageScrolls: document.documentElement.scrollWidth > innerWidth,
      };
    });
  // Collects every violation at a width rather than stopping at the first.
  const expect = (ok, message) => {
    if (!ok) failures.push(message);
    return ok;
  };
  const inside = async (width, step) => {
    const m = await measure();
    const at = `${width}px ${step}`;
    expect(!m.pageScrolls, `${at}: page scrolls sideways`);
    expect(
      m.popup.left >= 0 && m.popup.right <= width,
      `${at}: popup spans ${m.popup.left}..${m.popup.right}, outside 0..${width}`,
    );
    expect(
      m.content.left >= m.popup.left && m.content.right <= m.popup.right,
      `${at}: picker spans ${m.content.left}..${m.content.right}, outside its popup ${m.popup.left}..${m.popup.right}`,
    );
    expect(
      m.viewport.scrollWidth <= m.viewport.clientWidth && m.viewport.scrollLeft === 0,
      `${at}: popup content is ${m.viewport.scrollWidth}px in a ${m.viewport.clientWidth}px frame, slid ${m.viewport.scrollLeft}px`,
    );
    expect(
      m.actions.scrollWidth <= m.actions.clientWidth && m.actions.right <= m.popup.right,
      `${at}: actions row overflows (${m.actions.scrollWidth} > ${m.actions.clientWidth}, right ${m.actions.right} > ${m.popup.right})`,
    );
    return m;
  };

  for (const width of [700, 1024]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`${origin}/?case=room&theme=dark`);
    await page.locator("[data-chat-provider-model-picker]").click();
    await page.locator("[data-model-picker-content]").waitFor();
    await settle();
    await inside(width, "open");

    await page.locator("[data-model-picker-content] input[data-slot=combobox-input]").fill("opus");
    await settle();
    await inside(width, "searching");

    // A row's star sits at the far edge; focusing it must not slide the picker sideways.
    const star = page.locator("[data-model-picker-content] [data-model-row-star]").first();
    await star.focus();
    await settle();
    await inside(width, "star focused");
    await page.screenshot({ path: join(output, `${prefix}-${width}.png`) });
    checks.push(`${width}px dark: popup, picker and actions row inside the window`);
  }
  assert.deepEqual(failures, [], failures.join("\n"));
  assert.deepEqual(errors, []);
  passed = true;
} finally {
  await browser.close();
  server.close();
  await writeFile(
    join(output, `${prefix}-report.json`),
    `${JSON.stringify({ passed, checks, failures, errors, at: new Date().toISOString() }, null, 2)}\n`,
  );
}
console.log(`picker-usage viewport: ${checks.length} checks passed; evidence in ${output}`);
