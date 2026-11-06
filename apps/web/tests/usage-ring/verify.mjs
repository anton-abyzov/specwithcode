// Headless check that the usage ring at the model chip's `icon` fit is concentric with every
// provider mark, clears it and the state glyph beside it, and shares the machine pill's vertical centre, at 1x and 2x.
// Build first with
// `node node_modules/vite-plus/bin/vp build --config apps/web/tests/usage-ring/vite.config.ts`.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const root = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../../..",
);
const site = NodePath.join(root, ".artifacts/usage-ring/site");
const output = NodePath.resolve(
  process.argv[2] ?? NodePath.join(root, ".artifacts/usage-ring/evidence"),
);
await NodeFSP.mkdir(output, { recursive: true });
const { chromium } = NodeModule.createRequire(import.meta.url)(
  process.env.STUDIO_PLAYWRIGHT_MODULE ?? "playwright",
);
const server = NodeHttp.createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  const file = NodePath.resolve(site, `.${pathname === "/" ? "/index.html" : pathname}`);
  if (!file.startsWith(`${site}${NodePath.sep}`)) return res.writeHead(403).end();
  try {
    const mime =
      { ".js": "text/javascript", ".css": "text/css" }[NodePath.extname(file)] ?? "text/html";
    res.writeHead(200, { "Content-Type": mime }).end(await NodeFSP.readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ headless: true });
const failures = [];
try {
  for (const scale of [1, 2]) {
    for (const theme of ["light", "dark"]) {
      const page = await browser.newPage({
        viewport: { width: 640, height: 900 },
        deviceScaleFactor: scale,
      });
      await page.goto(`${base}?theme=${theme}`);
      await page.locator("[data-ring-case]").first().waitFor();
      const rows = await page.evaluate(() =>
        [...document.querySelectorAll("[data-ring-case]")].map((row) => {
          const center = (box) => ({ x: box.left + box.width / 2, y: box.top + box.height / 2 });
          const mark = row.querySelector("[data-chat-provider-model-picker-icon] > span");
          const ring = row.querySelector(".sws-model-mark-ring svg");
          const pill = row.querySelector("[data-machine-pill]").getBoundingClientRect();
          const markBox = mark.getBoundingClientRect();
          const ringBox = ring.getBoundingClientRect();
          // The track's inner edge, in px: the circle's radius less half its stroke.
          const circle = ring.querySelector("circle");
          const style = getComputedStyle(circle);
          const unit = ringBox.width / 12;
          const inner =
            (Number.parseFloat(style.r) - Number.parseFloat(style.strokeWidth) / 2) * unit;
          // The ring's outer edge against the state glyph's box beside it.
          const glyph = row.querySelector(".sws-model-state svg").getBoundingClientRect();
          const outer =
            (Number.parseFloat(style.r) + Number.parseFloat(style.strokeWidth) / 2) * unit;
          const m = center(markBox);
          const r = center(ringBox);
          return {
            name: row.dataset.ringCase,
            dx: r.x - m.x,
            dy: r.y - m.y,
            square: ringBox.width - ringBox.height,
            clearance: inner - markBox.width / 2,
            glyphGap: glyph.left - (center(ringBox).x + outer),
            pillDy: r.y - (pill.top + pill.height / 2),
          };
        }),
      );
      for (const row of rows) {
        const label = `${scale}x/${theme}/${row.name}`;
        if (Math.abs(row.dx) > 0.25 || Math.abs(row.dy) > 0.25)
          failures.push(`${label}: ring off the mark's centre by ${row.dx},${row.dy}`);
        if (Math.abs(row.square) > 0.25) failures.push(`${label}: ring is not round`);
        if (row.clearance < 1 || row.clearance > 2.5)
          failures.push(`${label}: ring clears the mark by ${row.clearance.toFixed(2)}px`);
        if (row.glyphGap < 0.5)
          failures.push(`${label}: ring runs ${(-row.glyphGap).toFixed(2)}px into the state glyph`);
        if (Math.abs(row.pillDy) > 0.5)
          failures.push(`${label}: ring sits ${row.pillDy}px off the machine pill's centre`);
      }
      await page.screenshot({
        path: NodePath.join(output, `rings-${theme}-${scale}x.png`),
        fullPage: true,
      });
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`ok, captures in ${output}`);
