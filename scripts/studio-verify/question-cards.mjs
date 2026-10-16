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
const site = path.join(root, ".artifacts/question-cards/site");
const output = path.resolve(
  process.argv[2] ?? path.join(root, ".artifacts/question-cards/evidence"),
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
    "Actual question card components; isolated fixture, no provider turns or installed runtime changes",
  cases: [],
};
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.STUDIO_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE }
      : {}),
  });
  for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width: 760, height: 900 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/?theme=${theme}`);
    const card = page.locator("[data-question-card]");
    await card.waitFor();
    // Lettered options, one recommended, clickable links.
    assert.deepEqual(
      await page
        .locator("[data-question-option]")
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-question-option"))),
      ["A", "B", "C"],
    );
    assert.equal(await page.locator("[data-question-recommended]").count(), 1);
    assert.equal(
      await card.locator('a[href="https://spec-weave.com/pricing"]').count(),
      1,
      "URL in the question is a link",
    );
    assert.ok(
      (await card.locator(".chat-markdown-file-link").count()) >= 1,
      "file path in an option is a file link",
    );
    await page.locator('[data-question-option="B"]').hover();
    await page.screenshot({
      path: path.join(output, `question-card-${theme}.png`),
      fullPage: true,
    });
    // Arrow keys move between options; a letter key picks one.
    await page.locator('[data-question-option="A"]').focus();
    await page.keyboard.press("ArrowDown");
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute("data-question-option")),
      "B",
    );
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("c");
    await page.locator('[data-question-option="C"][aria-checked="true"]').waitFor();
    await page.locator("[data-fixture-result]", { hasText: "advanced" }).waitFor();
    await page.screenshot({
      path: path.join(output, `question-card-selected-${theme}.png`),
      fullPage: true,
    });
    // Reply in chat focuses the composer.
    await page.locator("[data-question-reply-in-chat]").click();
    assert.equal(await page.evaluate(() => document.activeElement?.id), "composer");
    // The answered record names the choice, who chose and when.
    const decision = page.locator("[data-decision-card]");
    assert.match(await decision.innerText(), /Decision[\s\S]*Clear caches[\s\S]*You chose ·/);
    await decision.screenshot({ path: path.join(output, `decision-card-${theme}.png`) });
    assert.deepEqual(errors, []);
    receipt.cases.push({ theme, passed: true });
    await page.close();
  }
  await fs.writeFile(path.join(output, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`question cards verified; evidence in ${output}`);
} finally {
  await browser?.close();
  server.close();
}
