// Headless screenshots of the Claude Ship card. Run after building:
//   node node_modules/vite-plus/bin/vp build --config apps/web/tests/claude-ship/vite.config.ts
//   node apps/web/tests/claude-ship/verify.mjs /absolute/owned/report-dir
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const { chromium } = process.env.STUDIO_PLAYWRIGHT_MODULE
  ? await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href)
  : NodeModule.createRequire(NodePath.resolve("apps/server/package.json"))("playwright-core");
const site = NodePath.resolve(".artifacts/claude-ship/site");
const output = NodePath.resolve(process.argv[2] ?? ".artifacts/claude-ship/evidence");
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
for (const [kind, theme, width] of [
  ["fork", "light", 1280],
  ["fork", "dark", 1280],
  ["new", "light", 1280],
  ["outdated", "dark", 1280],
  ["steward", "light", 390],
]) {
  const page = await browser.newPage({ viewport: { width, height: 760 }, deviceScaleFactor: 2 });
  await page.goto(`${origin}/?case=${kind}&theme=${theme}`);
  await page.waitForSelector('[data-testid="claude-ship-dialog"]');
  await page.waitForTimeout(300);
  const facts = await page.evaluate(() => ({
    disabled: document.querySelector('[data-testid="claude-ship-open-terminal"]')?.disabled,
    line: document.querySelector('[data-testid="claude-ship-line"]')?.textContent,
    sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }));
  if (facts.sideways) problems.push(`${kind}/${theme}/${width}: sideways scroll`);
  if ((kind === "outdated") !== Boolean(facts.disabled))
    problems.push(`${kind}: Open disabled=${facts.disabled}`);
  await page.screenshot({
    path: NodePath.join(output, `claude-ship-${kind}-${theme}-${width}.png`),
  });
  console.log(kind, theme, width, JSON.stringify(facts));
  await page.close();
}
await browser.close();
server.close();
if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log("ok");
