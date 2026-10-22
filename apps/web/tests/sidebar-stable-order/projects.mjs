// Headless check that projects checks made sit under Automated, apart from the person's own.
// Usage: node apps/web/tests/sidebar-stable-order/projects.mjs <evidence-dir> [--site DIR]
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
  args[0] && !args[0].startsWith("--") ? args[0] : ".artifacts/sidebar-stable-order/projects",
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
    "Real StudioSidebar and project list; simulated projects from the October 22 report with no origin flag, so their folders decide",
  cases: [],
};
const names = (page, selector) => page.locator(`${selector} .sws-side-row-label`).allTextContents();
try {
  for (const [width, height, theme] of [
    [1280, 900, "dark"],
    [390, 844, "light"],
  ]) {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(
      `http://127.0.0.1:${server.address().port}/?theme=${theme}&live=off&scenario=projects`,
    );
    await page.getByRole("button", { name: "Automated (2)" }).waitFor();
    const main = await names(page, '[aria-label="Projects"]');
    assert.deepEqual(main, ["EasyChamp", "olysense", "sketchmate_dont_confuse", "specweave"]);
    const sidebar = page.locator("aside");
    await sidebar.screenshot({ path: join(output, `${width}-${theme}-folded.png`) });

    await page.getByRole("button", { name: "Automated (2)" }).click();
    const automated = await names(page, '[aria-label="Automated projects"]');
    assert.deepEqual(automated, ["Run shell acceptance 357", "swc copy check 2026-10-20"]);
    await sidebar.screenshot({ path: join(output, `${width}-${theme}-open.png`) });

    const row = page.locator('[aria-label="Automated projects"] .sws-project-row').first();
    await row.hover();
    await page.getByRole("button", { name: "Actions for Run shell acceptance 357" }).click();
    const item = page.getByRole("menuitem", { name: "Move to my projects" });
    await item.waitFor();
    await page.screenshot({ path: join(output, `${width}-${theme}-menu.png`) });
    await item.click();
    await page
      .locator('[aria-label="Projects"] .sws-side-row-label', {
        hasText: "Run shell acceptance 357",
      })
      .waitFor();
    const updates = await page.evaluate(() => window.fixture.projectUpdates());
    assert.deepEqual(updates.at(-1), {
      environmentId: "host",
      input: { projectId: "run-shell", workspaceSettings: { expectedRevision: 1, origin: "user" } },
    });
    assert.deepEqual(errors, []);
    receipt.cases.push({ width, theme, main, automated, moved: updates.at(-1), errors });
    await page.close();
  }
  await writeFile(join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  await browser.close();
  server.close();
}
