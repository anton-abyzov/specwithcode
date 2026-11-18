// Headless capture of the Cursor account usage warning: opens it from the Usage
// page's Enable button, checks Cancel writes nothing and Turn on writes the
// switch, in light and dark at 1280 and 390 px. Always headless; serves the
// fixture only and aborts every other request. Run after building:
//   node node_modules/vite-plus/bin/vp build --config apps/web/tests/cursor-usage-warning/vite.config.ts
//   node apps/web/tests/cursor-usage-warning/shoot.mjs /absolute/owned/report-dir
// Optional: STUDIO_PLAYWRIGHT_MODULE (a playwright-core entry), STUDIO_TEST_CHROMIUM.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = process.env.STUDIO_PLAYWRIGHT_MODULE
  ? await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href)
  : NodeModule.createRequire(NodePath.resolve("apps/server/package.json"))("playwright-core");
const site = NodePath.resolve(".artifacts/cursor-usage-warning/site");
const output = NodePath.resolve(process.argv[2] ?? ".artifacts/cursor-usage-warning/evidence");
await NodeFSP.mkdir(output, { recursive: true });
const MIME = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = NodePath.resolve(site, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(site + NodePath.sep)) return void res.writeHead(403).end();
    const body = await NodeFSP.readFile(file);
    res.writeHead(200, { "Content-Type": MIME[NodePath.extname(file)] ?? "text/html" }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const executablePath = process.env.STUDIO_TEST_CHROMIUM ?? process.env.STUDIO_CHROME;
const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
});
const problems = [];
const shots = [];
try {
  for (const theme of ["light", "dark"]) {
    for (const width of [1280, 390]) {
      const where = `${theme} ${width}`;
      const page = await browser.newPage({ viewport: { width, height: 760 } });
      await page.route("**/*", (route) =>
        route.request().url().startsWith(origin) ? route.continue() : route.abort(),
      );
      await page.goto(`${origin}/?theme=${theme}`);
      const enable = page.getByRole("button", { name: "Enable Cursor usage from Build Mac" });
      await enable.click();
      const dialog = page.getByRole("alertdialog");
      await dialog.waitFor();
      // Capture the settled dialog, not its fade-in.
      await page.waitForFunction(() =>
        document.getAnimations().every((animation) => animation.playState !== "running"),
      );
      await page.waitForTimeout(250);
      const text = await dialog.innerText();
      if (!text.includes("can get your account banned")) problems.push(`${where}: no warning text`);
      const file = NodePath.join(output, `cursor-usage-warning-${theme}-${width}.png`);
      await page.screenshot({ path: file });
      shots.push(file);
      await dialog.getByRole("button", { name: "Cancel" }).click();
      if ((await page.evaluate(() => window.fixtureCalls.length)) !== 0)
        problems.push(`${where}: Cancel wrote a setting`);
      await enable.click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Turn on" }).click();
      await page.waitForFunction(() => window.fixtureCalls.length >= 2);
      const calls = await page.evaluate(() => window.fixtureCalls);
      if (JSON.stringify(calls[0]?.input?.input) !== '{"patch":{"cursorKeychainUsageEnabled":true}}')
        problems.push(`${where}: Turn on wrote ${JSON.stringify(calls[0])}`);
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
await NodeFSP.writeFile(
  NodePath.join(output, "cursor-usage-warning.json"),
  JSON.stringify({ problems, shots }, null, 2),
);
console.log(problems.length ? problems.join("\n") : `ok: ${shots.length} captures in ${output}`);
process.exit(problems.length ? 1 : 0);
