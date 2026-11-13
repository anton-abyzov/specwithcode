import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const assert = NodeAssert.default;
const fs = NodeFSP;
const path = NodePath;

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const root = path.resolve(path.dirname(NodeURL.fileURLToPath(import.meta.url)), "../..");
const site = path.join(root, ".artifacts/outside-document/site");
const output = path.resolve(
  process.argv[2] ?? path.join(root, ".artifacts/outside-document/evidence"),
);
await fs.mkdir(output, { recursive: true });
const { chromium } = NodeModule.createRequire(import.meta.url)(
  process.env.STUDIO_PLAYWRIGHT_MODULE ??
    path.join(
      NodeOS.homedir(),
      ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright",
    ),
);
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = path.resolve(site, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(`${site}${path.sep}`)) {
      res.writeHead(403).end();
      return;
    }
    const mime =
      {
        ".js": "text/javascript",
        ".css": "text/css",
        ".woff2": "font/woff2",
        ".wasm": "application/wasm",
      }[path.extname(file)] ?? "text/html";
    const contents = await fs.readFile(file);
    res.writeHead(200, { "Content-Type": mime });
    res.end(contents);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const receipt = {
  headless: true,
  scope:
    "Actual ChatMarkdown and outside-document chip; isolated fixture, no provider turns or installed runtime changes",
  cases: [],
};
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.STUDIO_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE }
      : {}),
  });
  for (const [theme, width] of [
    ["light", 760],
    ["dark", 760],
    ["light", 390],
  ]) {
    const name = width < 500 ? `${theme}-phone` : theme;
    const page = await browser.newPage({ viewport: { width, height: 760 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/?theme=${theme}`);
    const outside = page.locator('[data-fixture="outside"]');
    const chip = outside.locator("[data-outside-document]");
    await chip.waitFor();
    // The claude.ai page is a chip: document glyph, its title, a quiet "outside" tag, no favicon.
    assert.equal(await chip.count(), 1);
    assert.equal(await chip.getAttribute("data-outside-document"), "Claude");
    assert.equal(await chip.evaluate((node) => node.tagName), "BUTTON");
    assert.match(await chip.innerText(), /Release checklist\s*outside · Claude/);
    assert.equal(await chip.locator("img").count(), 0);
    assert.equal(await outside.locator('a[href*="claude.ai"]').count(), 0);
    // An ordinary link stays a link.
    assert.equal(await outside.locator('a[href="https://example.com/changelog"]').count(), 1);
    // The saved report is a local file link, never the chip.
    const saved = page.locator('[data-fixture="saved"]');
    assert.equal(await saved.locator("[data-outside-document]").count(), 0);
    assert.match(await saved.innerText(), /Release checklist/);
    await page.locator("main").screenshot({ path: path.join(output, `chip-${name}.png`) });

    await chip.click();
    const menu = page.getByRole("menu");
    await menu.waitFor();
    assert.deepEqual(await menu.getByRole("menuitem").allInnerTexts(), [
      "Save to this project",
      "Open in Claude",
      "Copy link",
    ]);
    assert.match(await menu.innerText(), /Made in Claude, outside SpecWithCode/);
    await page.waitForFunction(() => {
      const popup = document.querySelector('[role="menu"]');
      return popup !== null && getComputedStyle(popup).opacity === "1";
    });
    await page.screenshot({ path: path.join(output, `menu-${name}.png`) });

    await menu.getByRole("menuitem", { name: "Save to this project" }).click();
    const composer = page.locator("[data-fixture-composer]");
    await page.waitForFunction(() =>
      document.querySelector("[data-fixture-composer]")?.value.includes("studio_report_save"),
    );
    const draft = await composer.inputValue();
    assert.match(
      draft,
      /\[Release checklist\]\(https:\/\/claude\.ai\/artifact\/Xq7Lm2Rt9Vb4Nc8Pd3Kf6H\)/,
    );
    assert.match(draft, /keep its source and original link/);
    await page.locator('[role="menu"]').waitFor({ state: "detached" });
    await page.locator("main").screenshot({ path: path.join(output, `drafted-${name}.png`) });

    assert.deepEqual(errors, []);
    receipt.cases.push({ theme, width, passed: true });
    await page.close();
  }
  await fs.writeFile(path.join(output, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`outside-document: ${receipt.cases.length} cases passed; evidence in ${output}`);
} finally {
  await browser?.close();
  server.close();
}
