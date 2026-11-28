// Headless screenshots of the skill install chooser (1440) over fictional data:
// the project view with each default source, the machine view, an older
// server, the progress line and the receipt, light and dark. Always headless;
// serves the fixture only and aborts every other request. Run after building:
//   node node_modules/vite-plus/bin/vp build --config apps/web/tests/skill-install-scope/vite.config.ts
//   node apps/web/tests/skill-install-scope/shoot.mjs /absolute/owned/report-dir
// Optional: STUDIO_PLAYWRIGHT_MODULE (a playwright-core entry), STUDIO_TEST_CHROMIUM.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const { chromium } = process.env.STUDIO_PLAYWRIGHT_MODULE
  ? await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href)
  : NodeModule.createRequire(NodePath.resolve("apps/server/package.json"))("playwright-core");
const site = NodePath.resolve(".artifacts/skill-install-scope/site");
const output = NodePath.resolve(process.argv[2] ?? ".artifacts/skill-install-scope/evidence");
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

const CASES = [
  {
    name: "project-default",
    query: "view=project",
    expect: ["Install for", "This project", "Studio Mac's default for projects."],
  },
  { name: "project-default-narrow", query: "view=project", expect: ["Install for"] },
  { name: "project-default-dark", query: "view=project&theme=dark", expect: ["Install for"] },
  {
    name: "project-own-user",
    query: "view=project&projectOwn=user",
    expect: ["This project's default."],
  },
  { name: "percy", query: "view=project&percy=1", expect: ["Percy installs skills for you"] },
  { name: "machine-view", query: "view=machine", expect: ["When a project is open, install for"] },
  { name: "older-server", query: "view=project&older=1", expect: ["runs an older SpecWithCode"] },
  {
    name: "installing",
    query: "view=project&hold=1",
    search: true,
    pickUser: true,
    install: true,
    expect: ["Installing obsidian-brain for you in every project on Studio Mac…"],
  },
  {
    name: "receipt-user",
    query: "view=project",
    search: true,
    pickUser: true,
    install: true,
    expect: ["Installed obsidian-brain 1.0.12", "For you, in every project."],
  },
];

for (const c of CASES) {
  const page = await browser.newPage({
    viewport: { width: c.name.endsWith("narrow") ? 390 : 1100, height: 760 },
  });
  await page.route("**/*", (route) =>
    route.request().url().startsWith(origin) ? route.continue() : route.abort(),
  );
  await page.goto(`${origin}/?${c.query}`);
  await page.waitForSelector('[data-testid="skill-search"]');
  if (c.pickUser) await page.getByTestId("skill-install-scope-user").click();
  if (c.search) {
    await page.getByRole("searchbox").fill("obsidian-brain");
    await page.waitForSelector('[data-group="available"]');
  }
  if (c.install) {
    await page.getByRole("button", { name: "Install", exact: true }).click();
    await page.waitForTimeout(300);
  }
  const text = await page.evaluate(() => document.body.innerText);
  for (const phrase of c.expect)
    if (!text.includes(phrase)) problems.push(`${c.name}: missing "${phrase}"`);
  const calls = await page.evaluate(() => window.fixtureCalls);
  if (c.install) {
    const sent = calls.find((call) => call.update)?.update?.install?.scope;
    if (sent !== "user") problems.push(`${c.name}: sent scope ${sent}`);
  }
  const file = NodePath.join(output, `${c.name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  shots.push(file);
  await page.close();
}
await browser.close();
server.close();
await NodeFSP.writeFile(
  NodePath.join(output, "result.json"),
  JSON.stringify({ shots, problems }, null, 2),
);
console.log(JSON.stringify({ shots: shots.length, problems }, null, 2));
process.exit(problems.length === 0 ? 0 : 1);
