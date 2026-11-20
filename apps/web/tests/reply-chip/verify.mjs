// Build first: vp build --config apps/web/tests/reply-chip/vite.config.ts
//
// The project header's replies chip, as Anton's November 19 screenshot shows it, between
// the workers button and project settings. At each width, light and dark:
// - the chip's label is one word, the reply style ("Concise", "Detailed" or "Mixed"),
//   beside its icon, and never names what the timeline shows;
// - a narrow bar keeps only the icon, and the bar never overflows;
// - the tooltip and the menu still name the view level ("Folded steps").
//
// Headless Chromium only. Usage:
// STUDIO_PLAYWRIGHT_MODULE=/abs/playwright-core/index.mjs node apps/web/tests/reply-chip/verify.mjs <report-dir> [--site <dir>] [--baseline]
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);

const args = process.argv.slice(2);
const output = NodePath.resolve(args[0] ?? ".artifacts/reply-chip/evidence");
const baseline = args.includes("--baseline");
const siteArg = args.indexOf("--site");
const site =
  siteArg >= 0
    ? NodePath.resolve(args[siteArg + 1])
    : NodeURL.fileURLToPath(new URL("../../../../.artifacts/reply-chip/site", import.meta.url));
await NodeFSP.mkdir(output, { recursive: true });

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = NodeHttp.createServer(async (request, response) => {
  const path = new URL(request.url ?? "/", "http://fixture").pathname;
  const file = NodePath.join(site, path === "/" ? "index.html" : path);
  try {
    const body = await NodeFSP.readFile(file);
    response.writeHead(200, {
      "content-type": types[NodePath.extname(file)] ?? "application/octet-stream",
    });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const STYLES = { concise: "Concise", detailed: "Detailed", mixed: "Mixed" };
const failures = [];
const receipt = { baseline, cases: [] };
function check(name, fn) {
  try {
    fn();
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
  }
}

const browser = await chromium.launch({
  headless: true,
  ...(process.env.STUDIO_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE }
    : {}),
});
try {
  for (const theme of ["light", "dark"]) {
    for (const [style, word] of Object.entries(STYLES)) {
      for (const width of [900, 560]) {
        const page = await browser.newPage({
          viewport: { width, height: 260 },
          deviceScaleFactor: 2,
        });
        await page.goto(`${origin}/?theme=${theme}&style=${style}`);
        await page.waitForSelector("body[data-fixture-ready]");
        const chip = page.locator("[data-timeline-detail]");
        const measured = await page.evaluate(() => {
          const chipEl = document.querySelector("[data-timeline-detail]");
          const label = chipEl.querySelector("[data-timeline-detail-label]");
          const bar = document.querySelector("[data-bar]");
          return {
            label: label.textContent,
            labelShown: getComputedStyle(label).display !== "none",
            icon: chipEl.querySelector("svg") !== null,
            ariaLabel: chipEl.getAttribute("aria-label"),
            chipWidth: Math.round(chipEl.getBoundingClientRect().width),
            overflow: bar.scrollWidth > bar.clientWidth,
          };
        });
        const name = `${theme} ${style} ${width}px`;
        receipt.cases.push({ name, ...measured });
        await page.locator("[data-bar]").screenshot({
          path: NodePath.join(output, `bar-${theme}-${style}-${width}.png`),
        });
        if (!baseline) {
          check(`${name} label is the reply style`, () => NodeAssert.equal(measured.label, word));
          check(`${name} icon`, () => NodeAssert.ok(measured.icon));
          check(`${name} name keeps the view level`, () =>
            NodeAssert.match(measured.ariaLabel, /Show: Folded steps/),
          );
          check(`${name} no overflow`, () => NodeAssert.equal(measured.overflow, false));
          check(`${name} label folds only when narrow`, () =>
            NodeAssert.equal(measured.labelShown, width > 620),
          );
        }
        if (theme === "light" && style === "concise" && width === 900) {
          await chip.hover();
          await page
            .waitForSelector('[data-slot="tooltip-popup"], [role="tooltip"]', {
              timeout: 3000,
            })
            .catch(() => {});
          await page.waitForTimeout(400);
          await page.screenshot({ path: NodePath.join(output, "tooltip-light-concise.png") });
          await page.mouse.move(0, 200);
          await chip.click();
          await page.waitForSelector('[role="menu"]');
          const menu = await page.locator('[role="menu"]').innerText();
          if (!baseline)
            check("menu names the view levels", () => NodeAssert.match(menu, /Folded steps/));
          await page.setViewportSize({ width, height: 620 });
          await page.waitForTimeout(200);
          await page.screenshot({ path: NodePath.join(output, "menu-light-concise.png") });
        }
        await page.close();
      }
    }
  }
} finally {
  await browser.close();
  server.close();
}
receipt.failures = failures;
await NodeFSP.writeFile(
  NodePath.join(output, "receipt.json"),
  `${JSON.stringify(receipt, null, 2)}\n`,
);
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(
  `reply-chip: ${receipt.cases.length} cases passed${baseline ? " (baseline)" : ""}; ${output}`,
);
