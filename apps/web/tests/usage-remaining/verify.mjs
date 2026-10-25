// Build first: vp build --config apps/web/tests/usage-remaining/vite.config.ts
// Then: STUDIO_PLAYWRIGHT_MODULE=/abs/path/playwright-core/index.mjs node apps/web/tests/usage-remaining/verify.mjs
// Always headless. Screenshots go to USAGE_REMAINING_OUTPUT or .artifacts/usage-remaining/evidence/.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeAssert from "node:assert/strict";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);
const root = NodePath.resolve(".artifacts/usage-remaining/site");
const output = NodePath.resolve(
  process.env.USAGE_REMAINING_OUTPUT ?? ".artifacts/usage-remaining/evidence",
);
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
const errors = [];
try {
  const page = await browser.newPage({
    reducedMotion: "reduce",
    viewport: { width: 1100, height: 900 },
  });
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.route("**/*", (route) =>
    route.request().url().startsWith(origin) ? route.continue() : route.abort(),
  );
  for (const theme of ["dark", "light"]) {
    await page.goto(`${origin}/?theme=${theme}`);
    // The coordinator's limits now open from "Limits by machine" (in the picker, or
    // this button where the coordinator has no picker).
    const trigger = page.getByRole("button", { name: "Limits by machine" });
    await trigger.waitFor();
    await trigger.click();
    const panel = page.locator("[data-machine-limits]");
    await panel.waitFor();
    const text = await panel.innerText();
    NodeAssert.ok(/\d+% left/.test(text), `${theme} panel shows no remaining share: ${text}`);
    NodeAssert.ok(!/% used/.test(text), `${theme} panel still says used: ${text}`);
    await page.screenshot({ path: NodePath.join(output, `popover-${theme}.png`) });
    await page.keyboard.press("Escape");
    const settings = page.locator("[data-surface=settings]");
    const settingsText = await settings.innerText();
    NodeAssert.ok(!/% used/.test(settingsText), `${theme} settings still says used`);
    NodeAssert.ok(settingsText.includes("Limit reached"), `${theme} settings lacks Limit reached`);
    await settings.screenshot({ path: NodePath.join(output, `settings-${theme}.png`) });
    await page
      .locator("[data-surface=limits]")
      .screenshot({ path: NodePath.join(output, `limits-${theme}.png`) });
  }
  NodeAssert.deepEqual(errors, []);
} finally {
  await browser.close();
  server.close();
}
console.log(`usage-remaining: headless checks passed; screenshots in ${output}`);
