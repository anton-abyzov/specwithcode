// Build first: node node_modules/vite-plus/bin/vp build --config apps/web/tests/picker-calm/vite.config.ts
// Then: node apps/web/tests/picker-calm/verify-machine-chip.mjs /absolute/report-dir
// Always headless, fictional machines. A machine chip squeezed narrower keeps a
// short label of at least two characters in its color; it never shows the icon alone.
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
const output = resolve(process.argv[2] ?? ".artifacts/picker-calm/machine-chip-evidence");
await mkdir(output, { recursive: true });
const MIME = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };
const server = NodeHttp.createServer(async (req, res) => {
  let body;
  let file;
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    file = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(root + sep)) return void res.writeHead(403).end();
    body = await readFile(file);
  } catch {
    return void res.writeHead(404).end();
  }
  res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "text/html" }).end(body);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;

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
  const context = await browser.newContext({ reducedMotion: "reduce", locale: "en-US" });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.route("**/*", (route) =>
    route.request().url().startsWith(origin) ? route.continue() : route.abort(),
  );
  for (const theme of ["light", "dark"]) {
    for (const [size, width, height] of [
      ["390", 390, 900],
      ["desktop", 1280, 900],
    ]) {
      const tag = `${size}-${theme}`;
      await page.setViewportSize({ width, height });
      await page.goto(`${origin}/?scene=machines&theme=${theme}`);
      await page.locator("[data-thread-machine-chip]").first().waitFor();
      await page.evaluate(
        () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
      );
      const chips = await page.locator("[data-narrow-row]").evaluateAll((rows) =>
        rows.map((row) => {
          const chip = row.querySelector("[data-thread-machine-chip], [data-machine-chip]");
          const full = chip.querySelector("[data-machine-full]:not(svg)");
          const short = chip.querySelector("[data-machine-short]");
          const visible = (node) =>
            node !== null &&
            getComputedStyle(node).visibility !== "hidden" &&
            getComputedStyle(node).display !== "none" &&
            node.getBoundingClientRect().width > 0;
          const shortBox = short.getBoundingClientRect();
          const chipBox = chip.getBoundingClientRect();
          return {
            row: row.dataset.narrowRow,
            compact: chip.hasAttribute("data-machine-compact"),
            iconVisible: visible(chip.querySelector("svg")),
            nameShown: visible(full) ? full.clientWidth / Math.max(1, full.scrollWidth) : 0,
            nameLength: full.textContent.length,
            short: visible(short) ? short.textContent : null,
            // The label clears the chip's border by at least 4px.
            shortInside: shortBox.left + short.scrollWidth <= chipBox.right - 4,
            name: chip.getAttribute("aria-label") ?? chip.textContent,
            tinted: chip.hasAttribute("data-machine-color"),
          };
        }),
      );
      for (const chip of chips) {
        const where = `${tag} row ${chip.row}`;
        assert.ok(chip.tinted, `${where}: chip lost its color`);
        if (chip.compact) {
          assert.ok(!chip.iconVisible, `${where}: icon still shows beside the short label`);
          assert.ok(chip.short && chip.short.length >= 2, `${where}: short label "${chip.short}"`);
          assert.ok(chip.shortInside, `${where}: short label overflows the chip`);
        } else {
          // Not compact: the name must still show at least four characters (or all of a short name).
          const shown = chip.nameShown * chip.nameLength;
          assert.ok(
            chip.nameShown >= 0.99 || shown >= 4,
            `${where}: only ${shown.toFixed(1)} characters of the name show`,
          );
        }
        assert.ok(/linux-box|M1|Workstation W/.test(chip.name), `${where}: name`);
      }
      const narrowest = chips.filter((chip) => chip.row === "110");
      assert.deepEqual(
        narrowest.map((chip) => chip.short),
        ["LM", "M1", "WWW"],
        `${tag}: the narrowest chips' short labels`,
      );
      // The coordinator's Send to another machine: the name with room, the short label without.
      const sends = await page
        .locator("[data-send-row] button")
        .evaluateAll((buttons) =>
          buttons.map((button) => getComputedStyle(button, "::after").content.replace(/"/g, "")),
        );
      assert.deepEqual(
        sends,
        size === "390"
          ? ["LM", "M1", "WWW"]
          : ["Send to linux-box", "Send to M1", "Send to Workstation W"],
        `${tag}: send button labels`,
      );
      await page.screenshot({ path: join(output, `machine-chips-${tag}.png`), fullPage: true });
      await page.evaluate(axeSource);
      const result = await page.evaluate(() =>
        window.axe.run(document, {
          runOnly: {
            type: "rule",
            values: ["color-contrast", "aria-prohibited-attr", "aria-command-name", "svg-img-alt"],
          },
        }),
      );
      const violations = result.violations.map((v) => ({
        id: v.id,
        nodes: v.nodes.map((node) => node.target.join(" ")),
      }));
      assert.deepEqual(violations, [], `${tag}: axe ${JSON.stringify(violations)}`);
      checks.push({ tag, chips });
    }
  }
  assert.deepEqual(errors, []);
  passed = true;
} finally {
  await writeFile(
    join(output, "machine-chip-result.json"),
    JSON.stringify({ passed, checks, errors }, null, 2),
  );
  await browser.close();
  server.close();
}
console.log(`machine chips: ${passed ? "pass" : "FAIL"}, evidence in ${output}`);
