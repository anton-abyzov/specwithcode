// Build first: node node_modules/vite-plus/bin/vp build --config apps/web/tests/picker-calm/vite.config.ts
// Then: node apps/web/tests/picker-calm/verify-settings.mjs /absolute/report-dir
// Always headless, fictional data. Settings pieces: an order list whose same-model
// alternates rest behind one "+N" chip, and a section that rests closed, keeps its rows
// mounted for search and remembers being opened. Light and dark at 390px and desktop.
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
const axeSource = await readFile(
  NodeModule.createRequire(resolve("apps/web/package.json")).resolve("axe-core/axe.min.js"),
  "utf8",
);

const root = resolve(".artifacts/picker-calm/site");
const output = resolve(process.argv[2] ?? ".artifacts/picker-calm/usage-evidence");
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
const AXE_RULES = [
  "color-contrast",
  "button-name",
  "link-name",
  "label",
  "aria-command-name",
  "aria-prohibited-attr",
  "role-img-alt",
  "image-alt",
  "svg-img-alt",
];

const checks = [];
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
  await context.clock.setFixedTime(new Date("2026-11-10T15:00:00Z"));
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
  const axe = async (name) => {
    await page.evaluate(axeSource);
    const result = await page.evaluate(
      (rules) => window.axe.run(document, { runOnly: { type: "rule", values: rules } }),
      AXE_RULES,
    );
    const violations = result.violations.map((violation) => ({
      id: violation.id,
      nodes: violation.nodes.map((node) => ({
        target: node.target.join(" "),
        summary: node.failureSummary,
      })),
    }));
    assert.deepEqual(violations, [], `${name}: axe ${JSON.stringify(violations, null, 1)}`);
  };
  const shot = async (name) => {
    await settle();
    await page.screenshot({ path: join(output, `${name}.png`) });
    await axe(name);
    checks.push(name);
  };

  for (const theme of ["light", "dark"]) {
    for (const [size, width, height] of [
      ["390", 390, 760],
      ["desktop", 1280, 820],
    ]) {
      const tag = `${size}-${theme}`;
      await page.setViewportSize({ width, height });
      await page.goto(`${origin}/?scene=settings&theme=${theme}`);
      await page.locator("[data-scene=settings]").waitFor();
      // Alternates rest behind one "+2" chip; the list shows three rows, not five.
      const toggle = page.locator("[data-alternates-toggle]");
      assert.equal(await toggle.count(), 1, `${tag}: one alternates chip`);
      assert.equal(await toggle.getAttribute("aria-expanded"), "false");
      assert.match(await toggle.innerText(), /\+2/);
      assert.equal(await page.locator("ol[aria-label='Reviewer order'] ul li").count(), 0);
      // The section rests closed with its rows mounted for settings search.
      const section = page.locator("details#fixture-advanced");
      assert.equal(await section.evaluate((node) => node.open), false, `${tag}: section closed`);
      assert.equal(await page.locator("[data-fixture-row]").count(), 1);
      assert.equal(await page.locator("[data-fixture-row]").isVisible(), false);
      await shot(`settings-resting-${tag}`);

      await toggle.click();
      assert.equal(await page.locator("ol[aria-label='Reviewer order'] ul li").count(), 2);
      await section.locator("summary").click();
      assert.equal(await page.locator("[data-fixture-row]").isVisible(), true);
      await shot(`settings-open-${tag}`);

      // Open state is remembered on this device.
      await page.reload();
      await page.locator("[data-scene=settings]").waitFor();
      assert.equal(
        await page.locator("details#fixture-advanced").evaluate((node) => node.open),
        true,
        `${tag}: section stays open after reload`,
      );
      // Moving the second model up puts it first.
      const first = () =>
        page
          .locator("ol[aria-label='Reviewer order'] > li")
          .first()
          .locator("[data-label]")
          .first()
          .getAttribute("data-label");
      assert.match(await first(), /Fable/);
      await page
        .locator("ol[aria-label='Reviewer order'] > li")
        .nth(1)
        .getByRole("button", { name: /up/i })
        .click();
      assert.match(await first(), /Sol/);
      await page.evaluate(() => localStorage.clear());
    }
  }
  passed = true;
} finally {
  await browser.close();
  server.close();
  await writeFile(
    join(output, "result.json"),
    JSON.stringify({ passed, checks, errors, at: new Date().toISOString() }, null, 2),
  );
}
console.log(`settings-pieces: ${checks.length} screenshots in ${output}`);
