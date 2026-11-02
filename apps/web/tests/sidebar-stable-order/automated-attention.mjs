// Headless check that a check's project raises no waiting count while the person's own do.
// Usage: node apps/web/tests/sidebar-stable-order/automated-attention.mjs <evidence-dir> [--site DIR] [--capture-only]
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
  args[0] && !args[0].startsWith("--")
    ? args[0]
    : ".artifacts/sidebar-stable-order/automated-attention",
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
const row = (page, name) =>
  page.locator(".sws-project-row", { has: page.getByText(name, { exact: true }) }).first();
const count = async (page, name) =>
  (await row(page, name).locator(".sws-count-waiting").count()) > 0
    ? await row(page, name).locator(".sws-count-waiting span").first().textContent()
    : null;
const receipt = { headless: true, cases: [] };
try {
  for (const [width, height, theme] of [
    [1280, 900, "dark"],
    [390, 844, "light"],
  ]) {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(
      `http://127.0.0.1:${server.address().port}/?theme=${theme}&live=off&scenario=automated-attention`,
    );
    const toggle = page.getByRole("button", { name: /^Automated \(3\)/ });
    await toggle.waitFor();
    const folded = (await toggle.textContent()).trim();
    await toggle.click();
    const seen = {};
    for (const name of [
      "EasyChamp",
      "specweave",
      "1164 handoff move check",
      "hello-handoff",
      "client-demo",
    ])
      seen[name] = await count(page, name);
    const initials = await row(page, "1164 handoff move check")
      .locator("[data-monogram]")
      .first()
      .textContent();
    await page.locator("aside").screenshot({ path: join(output, `${width}-${theme}.png`) });
    receipt.cases.push({ width, theme, folded, seen, initials, errors });
    if (!args.includes("--capture-only")) {
      assert.equal(seen.EasyChamp, "1");
      assert.equal(seen.specweave, null);
      assert.equal(seen["1164 handoff move check"], null);
      assert.equal(seen["hello-handoff"], null);
      // Merely named like a check: it may be real work, so it keeps its count.
      assert.equal(seen["client-demo"], "1");
      assert.equal(initials, "HC");
      assert.deepEqual(errors, []);
    }
    await page.close();
  }
  await writeFile(join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt.cases));
} finally {
  await browser.close();
  server.close();
}
