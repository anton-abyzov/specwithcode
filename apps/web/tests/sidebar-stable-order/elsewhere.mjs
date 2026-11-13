// Headless check that projects with no copy on this device sit last, greyed, under "On other machines".
// Usage: node apps/web/tests/sidebar-stable-order/elsewhere.mjs <evidence-dir> [--site DIR]
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
  args[0] && !args[0].startsWith("--") ? args[0] : ".artifacts/sidebar-stable-order/elsewhere",
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
};try {
  for (const [width, height, theme] of [
    [1280, 900, "light"],
    [1280, 900, "dark"],
    [390, 844, "light"],
    [390, 844, "dark"],
  ]) {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(
      `http://127.0.0.1:${server.address().port}/?theme=${theme}&live=off&scenario=elsewhere`,
    );
    const divider = page.locator("[data-project-elsewhere-divider]");
    await divider.waitFor();
    // This device's projects first, in the person's order, then the rest under the label.
    const rows = await page.locator('[aria-label="Projects"] li').evaluateAll((items) =>
      items.map((item) =>
        item.hasAttribute("data-project-elsewhere-divider")
          ? "--"
          : `${item.querySelector(".sws-side-row-label")?.textContent}${item.hasAttribute("data-elsewhere") ? "*" : ""}`,
      ),
    );
    const cut = rows.indexOf("--");
    assert.ok(cut > 0, "label after the local projects");
    assert.ok(rows.slice(0, cut).every((row) => !row.endsWith("*")), rows.join(","));
    assert.ok(rows.slice(cut + 1).every((row) => row.endsWith("*")), rows.join(","));
    const tags = await page.locator("[data-project-elsewhere]").allTextContents();
    const look = await page.evaluate(() => {
      const row = document.querySelector(".sws-project-row[data-elsewhere] .sws-side-row");
      const icon = row?.firstElementChild;
      const label = row?.querySelector(".sws-side-row-label");
      return {
        iconFilter: icon ? getComputedStyle(icon).filter : null,
        iconOpacity: icon ? getComputedStyle(icon).opacity : null,
        labelColor: label ? getComputedStyle(label).color : null,
      };
    });
    const sidebar = page.locator("aside").first();
    await sidebar.screenshot({ path: join(output, `${width}-${theme}.png`) });
    assert.deepEqual(errors, []);
    receipt.cases.push({ width, theme, rows, tags, look, errors });
    await page.close();
  }

  await writeFile(join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  await browser.close();
  server.close();
}
