// Headless captures of the ring panel's "Used before reset" summary in light
// and dark at 1280 and 390 px. Always headless; serves the fixture only. Run:
//   node node_modules/vite-plus/bin/vp build --config apps/web/tests/effectiveness-index/vite.config.ts
//   node apps/web/tests/effectiveness-index/verify.mjs /absolute/owned/report-dir
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
const site = NodePath.resolve(".artifacts/effectiveness-index/site");
const output = NodePath.resolve(process.argv[2] ?? ".artifacts/effectiveness-index/evidence");
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
try {
  for (const theme of ["light", "dark"]) {
    for (const width of [1280, 390]) {
      const page = await browser.newPage({
        viewport: { width, height: 640 },
        deviceScaleFactor: 2,
      });
      await page.route("**/*", (route) =>
        route.request().url().startsWith(origin) ? route.continue() : route.abort(),
      );
      await page.goto(`${origin}/?theme=${theme}`);
      await page.waitForSelector("[data-effectiveness-provider]");
      const rows = await page.$$eval("[data-effectiveness-provider]", (all) =>
        all.map((row) => ({
          driver: row.getAttribute("data-effectiveness-provider"),
          logoFirst:
            row.firstElementChild?.tagName !== "DIV" ||
            row.firstElementChild?.querySelector("svg,img") !== null,
        })),
      );
      if (rows.length !== 3) problems.push(`${theme} ${width}: ${rows.length} rows`);
      for (const row of rows)
        if (!row.logoFirst) problems.push(`${theme} ${width}: ${row.driver} has no logo first`);
      const sideways = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      if (sideways) problems.push(`${theme} ${width}: sideways scroll`);
      const panel = await page.$("[data-fixture-panel]");
      await panel.screenshot({
        path: NodePath.join(output, `effectiveness-${theme}-${width}.png`),
      });
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
console.log(problems.length === 0 ? `ok: 4 captures in ${output}` : problems.join("\n"));
process.exit(problems.length === 0 ? 0 : 1);
