// Build first: vp build --config apps/web/tests/runs-on-chip/vite.config.ts (from apps/web)
// Usage: node apps/web/tests/runs-on-chip/verify.mjs [/absolute/evidence-dir] [--before]
// Always headless. Playwright comes from STUDIO_PLAYWRIGHT_MODULE, else apps/server's
// playwright-core; STUDIO_CHROMIUM_EXECUTABLE picks a browser binary.
// Shoots every "Runs on" chip, light and dark, below and above the 640 px breakpoint, and
// checks that the plain chip (no machine menu, as Percy's) has the same shape as the
// coordinator's menu chip: height, padding, corners, type, border and gap. `--before`
// records the old shape instead: the plain chip had square corners and no padding.
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
const before = process.argv.includes("--before");
const output = path.resolve(
  process.argv.slice(2).find((a) => !a.startsWith("--")) ?? ".artifacts/runs-on-chip/evidence",
);
await fs.mkdir(output, { recursive: true });
const root = path.resolve(".artifacts/runs-on-chip/site");
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
const COLORS = ["violet", "teal", "amber", "rose", "blue", "green", "orange", "slate", "none"];
const CHIP = {
  coordinator: "[data-coordinator-machine]",
  percy: ".sws-host.machine-chip",
  local: "[data-thread-machine-chip]",
  remote: "[data-thread-machine-chip]",
};
const SHAPE = [
  "height",
  "paddingInlineStart",
  "paddingInlineEnd",
  "borderTopLeftRadius",
  "borderBottomRightRadius",
  "fontSize",
  "lineHeight",
  "borderTopWidth",
  "columnGap",
  "fontWeight",
];
const errors = [];
const results = [];
for (const theme of ["light", "dark"]) {
  for (const width of [560, 900]) {
    const page = await browser.newPage({
      viewport: { width, height: 1000 },
      colorScheme: theme,
    });
    page.on("pageerror", (error) => errors.push(`${theme} ${width}: ${error.message}`));
    await page.goto(`${origin}/?theme=${theme}`);
    await page.locator("[data-case=remote][data-color=none] [data-thread-machine-chip]").waitFor();
    await page.waitForTimeout(200);
    const styles = await page.evaluate(
      ({ CHIP, COLORS, SHAPE }) => {
        const out = {};
        for (const [name, selector] of Object.entries(CHIP)) {
          for (const color of COLORS) {
            const el = document.querySelector(
              `[data-case="${name}"][data-color="${color}"] ${selector}`,
            );
            if (!el) {
              out[`${name}/${color}`] = null;
              continue;
            }
            const cs = getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            out[`${name}/${color}`] = {
              ...Object.fromEntries(SHAPE.map((key) => [key, cs[key]])),
              background: cs.backgroundColor,
              borderColor: cs.borderTopColor,
              color: cs.color,
              rectHeight: Math.round(rect.height * 10) / 10,
              // The name never clips against the chip's own edge.
              textFits: (() => {
                const name = el.querySelector(".sws-host-name, [data-thread-machine-name]");
                if (!name) return true;
                const inner = name.getBoundingClientRect();
                return inner.left >= rect.left && inner.right <= rect.right + 0.5;
              })(),
            };
          }
        }
        return out;
      },
      { CHIP, COLORS, SHAPE },
    );
    const label = `${before ? "before" : "after"}-${theme}-${width}`;
    const file = path.join(output, `${label}.png`);
    await page.screenshot({ path: file, fullPage: true });
    // A close-up of the plain and the menu chip in m1's orange, as in the report.
    const crop = path.join(output, `${label}-orange.png`);
    const rows = page.locator(
      "[data-case=coordinator][data-color=orange], [data-case=percy][data-color=orange]",
    );
    const first = await rows.first().boundingBox();
    const last = await rows.last().boundingBox();
    await page.screenshot({
      path: crop,
      clip: { x: 0, y: first.y - 6, width: Math.min(width, 520), height: last.y + last.height - first.y + 12 },
    });
    results.push({ theme, width, file, crop, styles });
    await page.close();
  }
}
await browser.close();
server.close();

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};
for (const { theme, width, styles } of results) {
  for (const color of COLORS) {
    const plain = styles[`percy/${color}`];
    const menu = styles[`coordinator/${color}`];
    const at = `${theme} ${width}px ${color}`;
    check(plain && menu, `${at}: a chip is missing`);
    if (!plain || !menu) continue;
    for (const [name, chip] of Object.entries({ plain, menu })) {
      check(chip.textFits, `${at}: the ${name} chip clips its name`);
    }
    if (before) {
      if (color === "none") continue;
      check(plain.borderTopLeftRadius === "0px", `${at}: before, expected square corners`);
      check(plain.paddingInlineStart === "0px", `${at}: before, expected no padding`);
      continue;
    }
    for (const key of SHAPE)
      check(
        plain[key] === menu[key],
        `${at}: ${key} plain ${plain[key]} vs menu ${menu[key]}`,
      );
    check(
      plain.borderTopLeftRadius !== "0px",
      `${at}: the plain chip still has square corners`,
    );
    if (color === "none") {
      // No machine color: no box, as the menu chip's ghost button.
      check(
        plain.background === "rgba(0, 0, 0, 0)",
        `${at}: an uncolored plain chip has a fill ${plain.background}`,
      );
    } else {
      check(
        plain.background === menu.background,
        `${at}: fill plain ${plain.background} vs menu ${menu.background}`,
      );
      check(
        plain.borderColor === menu.borderColor,
        `${at}: border plain ${plain.borderColor} vs menu ${menu.borderColor}`,
      );
    }
  }
}
check(errors.length === 0, `page errors: ${errors.join("; ")}`);
const summary = {
  mode: before ? "before" : "after",
  failures,
  shots: results.map(({ file, crop }) => [file, crop]).flat(),
  sample: Object.fromEntries(
    results.map(({ theme, width, styles }) => [
      `${theme}-${width}`,
      { percy: styles["percy/orange"], coordinator: styles["coordinator/orange"] },
    ]),
  ),
};
await fs.writeFile(
  path.join(output, `${before ? "before" : "after"}-results.json`),
  JSON.stringify({ ...summary, results }, null, 2),
);
console.log(JSON.stringify(summary, null, 2));
if (failures.length) process.exit(1);
