// Build first: vp build --config apps/web/tests/coordinator-pick-back/vite.config.ts
// Then: STUDIO_PLAYWRIGHT_MODULE=/abs/path/playwright-core/index.mjs node apps/web/tests/coordinator-pick-back/verify.mjs [outDir]
// Always headless. Clicks the saved coordinator model in the real picker while a fallback runs.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);
const root = NodePath.resolve(".artifacts/coordinator-pick-back/site");
const output = NodePath.resolve(process.argv[2] ?? ".artifacts/coordinator-pick-back/evidence");
await NodeFSP.mkdir(output, { recursive: true });
const MIME = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = NodePath.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(`${root}${NodePath.sep}`)) return void res.writeHead(403).end();
    res.writeHead(200, { "Content-Type": MIME[NodePath.extname(file)] ?? "text/html" });
    res.end(await NodeFSP.readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const receipt = { headless: true, checks: [], screenshots: [] };
const expected = {
  // The reported case: 4% left is advisory, so the saved row switches back.
  fallback: { reason: null, switchBacks: 1, onFallback: false },
  // No way back from here: the row says so instead of swallowing the click.
  noback: { reason: "Switching back isn't available here", switchBacks: 0, onFallback: true },
  switching: { reason: "Switching models…", switchBacks: 0, onFallback: true },
  // No fallback: the saved model is already the one running, nothing to do.
  home: { reason: null, switchBacks: 0, onFallback: false },
};
try {
  for (const theme of ["light", "dark"])
    for (const width of [390, 1280])
      for (const [state, want] of Object.entries(expected)) {
        const page = await browser.newPage({
          reducedMotion: "reduce",
          viewport: { width, height: 820 },
          colorScheme: theme,
        });
        const errors = [];
        page.on("pageerror", (error) => errors.push(String(error)));
        await page.route("**/*", (route) =>
          route.request().url().startsWith(origin) ? route.continue() : route.abort(),
        );
        await page.goto(`${origin}/?state=${state}&theme=${theme}`);
        // A missing way back is not a provider problem: no provider recovery beside the chip.
        NodeAssert.equal(await page.getByText("Check again").count(), 0, `${state}: no recovery`);
        await page.locator("[data-chat-provider-model-picker]").first().click();
        await page.locator('[data-model-picker-provider="codex"] button').first().click();
        const row = page.getByRole("option", { name: /GPT-6\.1-Sol/ }).first();
        await row.waitFor();
        const name = `${state}-${theme}-${width}`;
        await page.screenshot({ path: NodePath.join(output, `${name}-open.png`) });
        const disabled = await row.getAttribute("aria-disabled");
        if (want.reason) {
          NodeAssert.equal(disabled, "true", `${name}: saved row is disabled with a reason`);
          await row.hover();
          await page.getByText(want.reason).first().waitFor();
          await page.screenshot({ path: NodePath.join(output, `${name}-reason.png`) });
        } else {
          NodeAssert.notEqual(disabled, "true", `${name}: saved row stays selectable`);
        }
        await row.click({ force: true });
        await page.waitForTimeout(150);
        const events = JSON.parse(await page.getByTestId("events").textContent());
        NodeAssert.equal(events.switchBacks, want.switchBacks, `${name}: switch-back count`);
        NodeAssert.deepEqual(events.selections, [], `${name}: no new save or other provider`);
        NodeAssert.equal(events.onFallback, want.onFallback, `${name}: fallback state`);
        await page.screenshot({ path: NodePath.join(output, `${name}-after.png`) });
        NodeAssert.deepEqual(errors, [], `${name}: page errors`);
        receipt.checks.push({ name, disabled, ...events });
        receipt.screenshots.push(`${name}-open.png`, `${name}-after.png`);
        await page.close();
      }
} finally {
  await browser.close();
  server.close();
  await NodeFSP.writeFile(NodePath.join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
}
console.log(`ok ${receipt.checks.length} checks, evidence in ${output}`);
