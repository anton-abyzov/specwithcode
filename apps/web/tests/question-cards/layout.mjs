// Build first: node node_modules/vite-plus/bin/vp build --config apps/web/tests/question-cards/vite.config.ts
// Usage: node apps/web/tests/question-cards/layout.mjs [/absolute/evidence-dir] [--before]
// Always headless. Playwright comes from STUDIO_PLAYWRIGHT_MODULE, else apps/server's
// playwright-core; STUDIO_CHROMIUM_EXECUTABLE picks a browser binary.
// Opens the question card whose option descriptions carry web links (`?case=link`) in a tall
// and a short thread panel, light and dark. It checks that a link's icon stays icon-sized in an
// option's one-line description, and that with room for every description the card does not
// move when the pointer rests on an option. --before only records (for shots of the old look).
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
const args = process.argv.slice(2);
const before = args.includes("--before");
const output = path.resolve(
  args.find((a) => !a.startsWith("--")) ?? ".artifacts/question-cards/layout",
);
await fs.mkdir(output, { recursive: true });
const root = path.resolve(".artifacts/question-cards/site");
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

// tall: the card has room for every description; short: it does not and scrolls.
const PANELS = [
  { name: "tall", panel: 1400, room: true },
  { name: "short", panel: 520, room: false },
];
const ICON_MAX = 16;
const results = [];
const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

// Positions of the card's options and the scroll offset of its body.
const layoutOf = () => {
  const card = document.querySelector("[data-question-card]");
  const scroller = card?.closest("[data-slot='scroll-area-viewport']") ?? card?.parentElement;
  return {
    card: card ? Math.round(card.getBoundingClientRect().height) : null,
    mode: card?.getAttribute("data-question-options") ?? null,
    clipped: [...document.querySelectorAll("[data-question-option-description]")].filter(
      (el) => el.scrollWidth > el.clientWidth + 1,
    ).length,
    scrollTop: scroller ? Math.round(scroller.scrollTop) : null,
    options: [...document.querySelectorAll("[data-question-option]")].map((el) => {
      const r = el.getBoundingClientRect();
      return { y: Math.round(r.y), h: Math.round(r.height) };
    }),
  };
};

try {
  for (const theme of ["light", "dark"]) {
    for (const panel of PANELS) {
      const id = `link-${panel.name}-${theme}`;
      const page = await browser.newPage({
        viewport: { width: 900, height: 1200 },
        colorScheme: theme,
        reducedMotion: "reduce",
      });
      await page.goto(`${origin}/?case=link&theme=${theme}&panel=${panel.panel}`);
      const card = page.locator("[data-fixture='pending']");
      await page.locator("[data-question-option]").first().waitFor({ timeout: 8000 });
      // Let a favicon load or fall back to the globe.
      await page.waitForTimeout(1200);
      await page.mouse.move(5, 5);
      await page.waitForTimeout(300);
      await card.screenshot({ path: path.join(output, `${id}.png`) });
      const icons = await page.evaluate(() =>
        [
          ...document.querySelectorAll(
            "[data-question-option] img, [data-question-option] svg, [data-question-details] img",
          ),
        ].map((el) => {
          const r = el.getBoundingClientRect();
          return { tag: el.tagName, w: Math.round(r.width), h: Math.round(r.height) };
        }),
      );
      const rest = await page.evaluate(layoutOf);
      // Rest the pointer on the second option, past the hover delay.
      await page.locator("[data-question-option]").nth(1).hover();
      await page.waitForTimeout(600);
      const hovered = await page.evaluate(layoutOf);
      await card.screenshot({ path: path.join(output, `${id}-hover.png`) });
      const largest = icons.reduce((m, i) => Math.max(m, i.w, i.h), 0);
      const moved =
        rest.card !== hovered.card ||
        rest.scrollTop !== hovered.scrollTop ||
        rest.options.some(
          (o, i) => Math.abs(o.y - hovered.options[i].y) > 1 || o.h !== hovered.options[i].h,
        );
      results.push({ id, largestIcon: largest, rest, hovered, moved });
      if (!before) {
        check(largest <= ICON_MAX, `${id}: an option icon is ${largest} px, over ${ICON_MAX}`);
        if (panel.room) {
          check(rest.mode === "all", `${id}: options layout ${rest.mode}, expected all`);
          check(rest.clipped === 0, `${id}: ${rest.clipped} descriptions clipped with room for them`);
          check(!moved, `${id}: the card moved on hover ${JSON.stringify({ rest, hovered })}`);
        } else {
          check(rest.mode === "compact", `${id}: options layout ${rest.mode}, expected compact`);
          check(moved, `${id}: hover did not open the option's description on a short panel`);
        }
      }
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
await fs.writeFile(
  path.join(output, "layout.json"),
  JSON.stringify({ before, results, failures }, null, 2),
);
for (const row of results)
  console.log(
    `${row.id.padEnd(20)} ${String(row.rest.mode).padEnd(8)} icon ${String(row.largestIcon).padStart(4)} px  moved on hover: ${row.moved}`,
  );
if (failures.length) {
  console.log(`failures (${failures.length}):\n  ${failures.join("\n  ")}`);
  if (!before) process.exit(1);
}
console.log(`${results.length} cases -> ${output}`);
