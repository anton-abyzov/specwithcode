// Headless screenshots of the Projects list at two sidebar widths, light and dark, with one
// project pinned and shared, plus a hovered row. Usage:
// node apps/web/tests/sidebar-stable-order/compact.mjs <evidence-dir> [--site DIR] [--name before|after]
// Build first: vp build --config apps/web/tests/sidebar-stable-order/vite.config.ts
import * as NodeAssert from "node:assert/strict";
import * as NodeHttp from "node:http";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
const assert = NodeAssert.default;
const { resolve, extname, join } = NodePath;
const { readFile, mkdir, writeFile } = NodeFSP;
const homedir = NodeOS.homedir;
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = NodeModule.createRequire(import.meta.url)(
  process.env.STUDIO_PLAYWRIGHT_MODULE ||
    join(
      homedir(),
      ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright",
    ),
);
const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const site = resolve(option("--site") || ".artifacts/sidebar-stable-order/site");
const output = resolve(
  args[0] && !args[0].startsWith("--") ? args[0] : ".artifacts/sidebar-stable-order/compact",
);
await mkdir(output, { recursive: true });
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = resolve(site, "." + (pathname === "/" ? "/index.html" : pathname));
    if (!file.startsWith(site + "/")) throw Error("path");
    res.setHeader(
      "content-type",
      { ".js": "text/javascript", ".css": "text/css", ".html": "text/html" }[extname(file)] ||
        "application/octet-stream",
    );
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.STUDIO_CHROMIUM_EXECUTABLE ||
    join(
      homedir(),
      "Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell",
    ),
});
const receipt = {
  headless: true,
  scope:
    "Real StudioSidebar and project list; simulated projects on several machines, viewed from one that holds two of them",
  cases: [],
};
const name = option("--name") || "after";
try {
  for (const sidebarWidth of [256, 320]) {
    for (const theme of ["light", "dark"]) {
      const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.addInitScript(() => {
        localStorage.setItem(
          "studio:sidebar-project-order:v1",
          JSON.stringify({ pinned: ["logical:specweave"], unpinned: [] }),
        );
      });
      await page.goto(
        `http://127.0.0.1:${server.address().port}/?theme=${theme}&live=off&scenario=elsewhere`,
      );
      await page.addStyleTag({
        content: `[style*="--sidebar-width"]{--sidebar-width:${sidebarWidth}px !important}`,
      });
      await page.locator("[data-project-elsewhere-divider]").waitFor();
      await page.mouse.move(1000, 700);
      const rows = await page.locator(".sws-project-row").evaluateAll((items) =>
        items.map((item) => {
          const label = item.querySelector(".sws-side-row-label");
          return {
            name: label?.textContent,
            truncated: label ? label.scrollWidth > label.clientWidth : null,
            labelWidth: label?.clientWidth ?? null,
          };
        }),
      );
      const sidebar = page.locator("aside").first();
      const box = await sidebar.boundingBox();
      const clip = { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 520) };
      await page.screenshot({ path: join(output, `${name}-${sidebarWidth}-${theme}.png`), clip });
      // Hovering the pinned, shared row shows its marks.
      await page.locator(".sws-project-row").first().hover();
      await page.screenshot({
        path: join(output, `${name}-${sidebarWidth}-${theme}-hover.png`),
        clip,
      });
      assert.deepEqual(errors, []);
      receipt.cases.push({ name, sidebarWidth, theme, rows, errors });
      await page.close();
    }
  }
  await writeFile(join(output, `${name}.json`), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt.cases.map((c) => [c.name, c.sidebarWidth, c.theme, c.rows.filter((r) => r.truncated).map((r) => r.name)])));
} finally {
  await browser.close();
  server.close();
}
