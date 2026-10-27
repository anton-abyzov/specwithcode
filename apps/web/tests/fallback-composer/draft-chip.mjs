// Build first: vp build --config apps/web/tests/fallback-composer/vite.config.ts
// Then: STUDIO_PLAYWRIGHT_MODULE=/abs/path/playwright-core/index.mjs node apps/web/tests/fallback-composer/draft-chip.mjs [outDir]
// Always headless. A new chat's model chip names the model its first message goes to.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);
const output = NodePath.resolve(process.argv[2] ?? ".artifacts/fallback-composer/draft-chip");
await NodeFSP.mkdir(output, { recursive: true });
const root = NodePath.resolve(".artifacts/fallback-composer/site");
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const file = NodePath.resolve(
      root,
      "." + new URL(req.url, "http://localhost").pathname.replace(/\/$/, "/index.html"),
    );
    NodeAssert.ok(file.startsWith(root + NodePath.sep));
    res.setHeader(
      "Content-Type",
      { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" }[
        NodePath.extname(file)
      ] ?? "text/html",
    );
    res.end(await NodeFSP.readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE,
});
// What the chip must name, and whether a "next" tag may show.
const EXPECT = {
  draft: { model: "Opus 5.5", next: false },
  "draft-picked": { model: "GPT-6.1-Sol", next: false },
  next: { model: "GPT-6.1-Sol", next: true },
};
const receipt = { headless: true, checks: [], screenshots: [] };
try {
  for (const theme of ["light", "dark"])
    for (const width of [390, 900])
      for (const [scenario, expected] of Object.entries(EXPECT)) {
        const page = await browser.newPage({
          viewport: { width: 1100, height: 750 },
          colorScheme: theme,
        });
        const errors = [];
        page.on("pageerror", (e) => errors.push(String(e)));
        await page.goto(
          `http://127.0.0.1:${server.address().port}/?width=${width}&theme=${theme}&case=${scenario}`,
        );
        await page.locator('[data-fixture-ready="true"]').waitFor();
        await page.waitForTimeout(150);
        const result = await page.evaluate(() => {
          const trigger = document.querySelector("[data-chat-provider-model-picker]");
          return {
            text: trigger?.textContent ?? "",
            aria: trigger?.getAttribute("aria-label") ?? "",
          };
        });
        const file = NodePath.join(output, `${scenario}-${width}-${theme}.png`);
        await page.screenshot({ path: file });
        receipt.screenshots.push(file);
        NodeAssert.deepEqual(errors, [], `${scenario}: page errors`);
        NodeAssert.ok(!/Choose a model/.test(result.text), `${scenario}: ${result.text}`);
        NodeAssert.ok(result.text.includes(expected.model), `${scenario}: ${result.text}`);
        NodeAssert.equal(/next/.test(result.text), expected.next, `${scenario}: ${result.text}`);
        receipt.checks.push({ scenario, width, theme, ...result });
        await page.close();
      }
} finally {
  await browser.close();
  server.close();
  await NodeFSP.writeFile(NodePath.join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
}
console.log(`ok ${receipt.checks.length} checks, evidence in ${output}`);
