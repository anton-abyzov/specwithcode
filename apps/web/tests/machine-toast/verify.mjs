// Build first (from apps/web): node ../../node_modules/vite-plus/bin/vp build --config tests/machine-toast/vite.config.ts
// Usage (from the repository root): node apps/web/tests/machine-toast/verify.mjs /absolute/evidence-dir
// Always headless. Playwright comes from STUDIO_PLAYWRIGHT_MODULE, else apps/server's
// playwright-core; STUDIO_CHROMIUM_EXECUTABLE picks a browser binary.
// Shoots a toast for M5 (teal) and for M4 (violet) as another machine's window shows
// them, a plain one for the window's own machine and a right-to-left one, light and
// dark (1436 AC-08 to AC-10), and measures every machine colour's 3px leading edge
// against the canvas, which needs 3:1. The 1px border, the composer's edge tone, is reported.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = process.env.STUDIO_PLAYWRIGHT_MODULE
  ? await import(pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href)
  : createRequire(path.resolve("apps/server/package.json"))("playwright-core");
const output = path.resolve(process.argv[2] ?? ".artifacts/machine-toast/evidence");
await fs.mkdir(output, { recursive: true });
const root = path.resolve(".artifacts/machine-toast/site");
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = path.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    assert(file.startsWith(root + path.sep));
    res.setHeader(
      "Content-Type",
      { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" }[
        path.extname(file)
      ] ?? "text/html",
    );
    res.end(await fs.readFile(file));
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

const COLORS = ["violet", "teal", "amber", "rose", "blue", "green", "orange", "slate"];
const SHOTS = [
  ["m5-teal", "machine=teal&name=M5"],
  ["m4-violet", "machine=violet&name=M4"],
  ["own-machine", ""],
  ["m5-teal-rtl", "machine=teal&name=M5&dir=rtl"],
];

/** sRGB bytes as linear-light relative luminance. */
function luminance([r, g, b]) {
  const lin = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
};

const errors = [];
const results = { shots: [], colors: [] };
const failures = [];
for (const theme of ["light", "dark"]) {
  const page = await browser.newPage({ viewport: { width: 760, height: 260 }, colorScheme: theme });
  page.on("pageerror", (error) => errors.push(`${theme}: ${error.message}`));
  const read = () =>
    page.evaluate(() => {
      const toast = document.querySelector('[data-slot="toast-viewport"] > *');
      if (!toast) return null;
      const cs = getComputedStyle(toast);
      const probe = document.createElement("span");
      probe.style.color = "var(--machine)";
      toast.append(probe);
      const machine = getComputedStyle(probe).color;
      probe.remove();
      // Whatever space Chrome computes a colour in (oklch, color-mix), painted to sRGB bytes.
      const bytes = (css) => {
        const context = Object.assign(document.createElement("canvas"), {
          width: 1,
          height: 1,
        }).getContext("2d");
        context.fillStyle = css;
        context.fillRect(0, 0, 1, 1);
        return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)];
      };
      const canvas = getComputedStyle(document.body).backgroundColor;
      return {
        machineRgb: bytes(machine),
        borderRgb: bytes(cs.borderTopColor),
        canvasRgb: bytes(canvas),
        machineColor: toast.getAttribute("data-machine-color"),
        machineToast: toast.hasAttribute("data-machine-toast"),
        border: cs.borderTopColor,
        boxShadow: cs.boxShadow,
        machine,
        canvas: getComputedStyle(document.body).backgroundColor,
      };
    });
  for (const [name, query] of SHOTS) {
    await page.goto(`${origin}/?theme=${theme}&${query}`);
    await page.locator('[data-slot="toast-title"]').waitFor();
    await page.waitForTimeout(700);
    const style = await read();
    const file = path.join(output, `toast-${name}-${theme}.png`);
    await page.screenshot({ path: file });
    results.shots.push({ theme, name, file, style });
    if (name === "own-machine") {
      if (style.machineToast || style.machineColor)
        failures.push(`${theme}: own-machine toast is coloured`);
    } else {
      if (!style.machineToast) failures.push(`${theme} ${name}: no machine colour on the card`);
      const inset = name.endsWith("rtl") ? "inset -3px" : "inset 3px";
      if (
        !style.boxShadow.includes(
          name.endsWith("rtl") ? "-3px 0px 0px 0px inset" : " 3px 0px 0px 0px inset",
        ) &&
        !style.boxShadow.includes(inset)
      )
        failures.push(`${theme} ${name}: leading edge missing (${style.boxShadow})`);
    }
  }
  for (const color of COLORS) {
    await page.goto(`${origin}/?theme=${theme}&machine=${color}&name=M5`);
    await page.locator('[data-slot="toast-title"]').waitFor();
    await page.waitForTimeout(400);
    const style = await read();
    const edge = contrast(style.machineRgb, style.canvasRgb);
    const border = contrast(style.borderRgb, style.canvasRgb);
    results.colors.push({
      theme,
      color,
      edge,
      border,
      machine: style.machine,
      borderColor: style.border,
      canvas: style.canvas,
    });
    if (edge < 3) failures.push(`${theme} ${color}: leading edge ${edge}:1 against the canvas`);
    // The 1px border is the composer's softer edge tone (AC-08): reported, not gated.
  }
  await page.close();
}
await browser.close();
server.close();
results.errors = errors;
results.failures = failures;
await fs.writeFile(
  path.join(output, "machine-toast-results.json"),
  JSON.stringify(results, null, 2) + "\n",
);
for (const row of results.colors)
  console.log(
    `${row.theme.padEnd(5)} ${row.color.padEnd(7)} edge ${row.edge}:1  border ${row.border}:1`,
  );
console.log(`results: ${path.join(output, "machine-toast-results.json")}`);
if (errors.length) console.error(errors.join("\n"));
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
