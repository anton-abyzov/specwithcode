// Headless screenshots of the GitHub star card. Run after building:
//   node node_modules/vite-plus/bin/vp build --config apps/web/tests/github-star-prompt/vite.config.ts
//   node apps/web/tests/github-star-prompt/verify.mjs /absolute/owned/report-dir
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const { chromium } = process.env.STUDIO_PLAYWRIGHT_MODULE
  ? await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href)
  : NodeModule.createRequire(NodePath.resolve("apps/server/package.json"))("playwright-core");
const site = NodePath.resolve(".artifacts/github-star-prompt/site");
const output = NodePath.resolve(process.argv[2] ?? ".artifacts/github-star-prompt/evidence");
await NodeFSP.mkdir(output, { recursive: true });
const MIME = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = NodePath.resolve(site, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(site + NodePath.sep)) return void res.writeHead(403).end();
    res
      .writeHead(200, { "Content-Type": MIME[NodePath.extname(file)] ?? "text/html" })
      .end(await NodeFSP.readFile(file));
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
for (const [theme, width] of [
  ["light", 1280],
  ["dark", 1280],
  ["light", 390],
]) {
  const page = await browser.newPage({ viewport: { width, height: 720 }, deviceScaleFactor: 2 });
  await page.goto(`${origin}/?theme=${theme}`);
  await page.waitForSelector('[data-testid="github-star-prompt"]');
  await page.waitForTimeout(300);
  const facts = await page.evaluate(() => ({
    buttons: [...document.querySelectorAll('[data-testid="github-star-prompt"] button')].map(
      (b) => b.textContent || b.getAttribute("aria-label"),
    ),
    sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }));
  if (facts.sideways) problems.push(`${theme}/${width}: sideways scroll`);
  for (const name of ["Star on GitHub", "Already starred", "Not now"])
    if (!facts.buttons.includes(name)) problems.push(`${theme}/${width}: no ${name}`);
  await page.screenshot({
    path: NodePath.join(output, `github-star-prompt-${theme}-${width}.png`),
  });
  console.log(theme, width, JSON.stringify(facts));
  await page.close();
}
await browser.close();
server.close();
if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log("ok");
