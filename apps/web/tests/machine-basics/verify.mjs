// Headless check of first-run setup's Machine basics block: each machine answer
// in light and dark at 1100 and 390 px, with no sideways scroll and the right rows.
// Run after building:
//   node node_modules/vite-plus/bin/vp build --config apps/web/tests/machine-basics/vite.config.ts
//   node apps/web/tests/machine-basics/verify.mjs /absolute/owned/report-dir
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
const site = NodePath.resolve(".artifacts/machine-basics/site");
const output = NodePath.resolve(process.argv[2] ?? ".artifacts/machine-basics/evidence");
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

const CASES = [
  { view: "ready", os: "darwin", rows: [], text: "Git, Node.js and GitHub CLI are ready." },
  { view: "no-gh", os: "windows", rows: ["gh"], text: "Git and Node.js are ready." },
  {
    view: "missing",
    os: "darwin",
    rows: ["git", "node", "gh"],
    text: "Install Node.js",
    open: true,
  },
  { view: "installing", os: "darwin", rows: ["node"], text: "Unpacking Node.js" },
  { view: "linux", os: "linux", rows: ["git", "node"], text: "sudo apt install git" },
];
const problems = [];
const report = [];
try {
  for (const theme of ["light", "dark"]) {
    for (const width of [1100, 390]) {
      const page = await browser.newPage({
        viewport: { width, height: 900 },
        deviceScaleFactor: 2,
      });
      for (const c of CASES) {
        const where = `${c.view} ${c.os} ${theme} ${width}`;
        await page.goto(
          `${origin}/?view=${c.view}&os=${c.os}&theme=${theme}${c.open ? "&open=1" : ""}`,
        );
        await page.waitForSelector("[data-machine-basics]");
        await page.waitForTimeout(150);
        const found = await page.evaluate(() => ({
          rows: [...document.querySelectorAll("[data-agent-row]")].map((n) =>
            n.getAttribute("data-agent-row"),
          ),
          text: document.body.innerText,
          sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        }));
        if (JSON.stringify(found.rows) !== JSON.stringify(c.rows))
          problems.push(`${where}: rows ${found.rows.join(",")}`);
        if (!found.text.includes(c.text)) problems.push(`${where}: no "${c.text}"`);
        if (found.sideways) problems.push(`${where}: sideways scroll`);
        const file = NodePath.join(output, `${c.view}-${c.os}-${theme}-${width}.png`);
        await page.locator("[data-fixture]").screenshot({ path: file });
        report.push(file);
      }
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
await NodeFSP.writeFile(
  NodePath.join(output, "report.json"),
  JSON.stringify({ problems, screenshots: report }, null, 2),
);
console.log(
  problems.length === 0 ? `ok: ${report.length} screenshots in ${output}` : problems.join("\n"),
);
process.exitCode = problems.length === 0 ? 0 : 1;
