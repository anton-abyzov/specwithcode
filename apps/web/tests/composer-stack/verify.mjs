// Headless check of the composer notice stack. Build first:
//   vp build --config apps/web/tests/composer-stack/vite.config.ts
// then: PW=<playwright-core/index.mjs> OUT=<dir> node apps/web/tests/composer-stack/verify.mjs
// Always headless; writes screenshots and checks.json to OUT and exits 1 on a failed check.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(NodeURL.pathToFileURL(process.env.PW).href);
const root = NodeURL.fileURLToPath(
  new URL("../../../../.artifacts/composer-stack/site", import.meta.url),
);
const out =
  process.env.OUT ??
  NodeURL.fileURLToPath(new URL("../../../../.artifacts/composer-stack/evidence", import.meta.url));
await NodeFSP.mkdir(out, { recursive: true });

const server = NodeHttp.createServer(async (req, res) => {
  try {
    const p = new URL(req.url, "http://x").pathname;
    const file = NodePath.resolve(root, `.${p === "/" ? "/index.html" : p}`);
    const mime = file.endsWith(".js")
      ? "text/javascript"
      : file.endsWith(".css")
        ? "text/css"
        : file.endsWith(".woff2")
          ? "font/woff2"
          : "text/html";
    res.writeHead(200, { "Content-Type": mime });
    res.end(await NodeFSP.readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const cases = [
  "watcher",
  "screenshot",
  "question",
  "many",
  "many-expanded",
  "account",
  "account-manual",
];
const failures = [];
const report = [];
const errors = [];
const browser = await chromium.launch({ headless: true });
try {
  for (const theme of ["dark", "light"]) {
    for (const width of [360, 800, 1280]) {
      const touch = width === 360;
      const context = await browser.newContext({
        viewport: { width, height: 820 },
        deviceScaleFactor: 2,
        reducedMotion: "reduce",
        hasTouch: touch,
        isMobile: touch,
      });
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(`${theme}/${width}: ${error}`));
      for (const kase of cases) {
        const name = `${kase}-${theme}-${width}`;
        const q = new URLSearchParams({ case: kase === "many-expanded" ? "many" : kase, theme });
        await page.goto(`${origin}/?${q}`);
        await page.locator('[data-slot="composer-shell"]').waitFor();
        await page.waitForTimeout(200);
        if (kase === "many-expanded") {
          await page.locator("button[aria-expanded]").click();
          await page.waitForTimeout(200);
        }
        const geo = await page.evaluate(() => {
          const rect = (el) => {
            const b = el.getBoundingClientRect();
            return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, height: b.height };
          };
          const main = document.querySelector('[data-chat-composer-main-surface="true"]');
          const cards = [...document.querySelectorAll('[data-slot="composer-banner"]')]
            .filter((c) => c.getBoundingClientRect().height > 0)
            .map((c) => {
              const before = getComputedStyle(c, "::before");
              return {
                placement: c.dataset.composerBannerSurface,
                text: c.textContent.trim().slice(0, 48),
                role: c.getAttribute("role"),
                ...rect(c),
                borders: ["Top", "Right", "Bottom", "Left"].map((s) => before[`border${s}Width`]),
                radii: ["TopLeft", "TopRight", "BottomRight", "BottomLeft"].map(
                  (corner) => before[`border${corner}Radius`],
                ),
              };
            });
          const pill = document.querySelector("button[aria-expanded]");
          const targets = [...document.querySelectorAll("[data-composer-notice-stack] button")].map(
            (b) => {
              const r = b.getBoundingClientRect();
              const after = getComputedStyle(b, "::after");
              return {
                label: b.getAttribute("aria-label") ?? b.textContent.trim(),
                w: Math.max(r.width, parseFloat(after.minWidth) || 0),
                h: Math.max(r.height, parseFloat(after.minHeight) || 0),
              };
            },
          );
          return {
            main: rect(main),
            cards,
            pill: pill ? { ...rect(pill), expanded: pill.getAttribute("aria-expanded") } : null,
            targets,
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          };
        });
        const check = (ok, message) => {
          if (!ok) failures.push(`${name}: ${message}`);
        };
        const floating = geo.cards.filter((c) => c.placement === "floating");
        for (const card of floating) {
          check(
            card.borders.every((w) => w === "1px"),
            `"${card.text}" border ${card.borders}`,
          );
          check(
            card.radii.every((r) => r === card.radii[0] && parseFloat(r) >= 12),
            `"${card.text}" corners ${card.radii}`,
          );
          check(card.bottom <= geo.main.top - 4, `"${card.text}" reaches into the composer`);
        }
        for (let i = 1; i < floating.length; i++)
          check(
            floating[i].top - floating[i - 1].bottom >= 4,
            `"${floating[i].text}" overlaps the notice above`,
          );
        const limit = floating.findIndex((c) => /limit reached|subscription changed/.test(c.text));
        const watch = floating.findIndex((c) => c.text.includes("Watching pull request"));
        if (limit !== -1 && watch !== -1) check(limit < watch, "watcher shown before the limit");
        if (kase === "watcher" || kase === "screenshot") check(watch !== -1, "watcher hidden");
        if (kase !== "watcher") check(limit !== -1, "limit or account notice hidden");
        if (kase === "many") check(geo.pill?.expanded === "false" && floating.length === 2, "fold");
        if (kase === "many-expanded") check(floating.length === 4, "expanded shows 4");
        check(geo.overflow <= 0, `horizontal overflow ${geo.overflow}px`);
        if (touch)
          for (const t of geo.targets)
            check(
              t.w >= 44 && t.h >= 44,
              `target "${t.label}" ${Math.round(t.w)}x${Math.round(t.h)}`,
            );
        await page.screenshot({ path: NodePath.join(out, `${name}.png`), fullPage: false });
        report.push({ name, ...geo });
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
await NodeFSP.writeFile(
  NodePath.join(out, "checks.json"),
  JSON.stringify({ errors, failures, report }, null, 2),
);
console.log(JSON.stringify({ shots: report.length, errors: errors.length, failures }, null, 2));
process.exit(failures.length || errors.length ? 1 : 0);
