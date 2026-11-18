// Headless walk of the real first-run setup (WelcomeWizard and its steps over
// stand-in answers, see main.tsx) with the shared walker every release check
// uses (scripts/studio-verify/first-run-walk.mjs). Checks the step ids, that
// the walk chose, granted and imported nothing, that each step fits the window,
// and that the walk passes with the app in German. It catches breaks in the
// step and neutral-action contract and in layout; it cannot catch server or
// desktop bridge breaks, which the installed-app walk does.
//   node apps/web/tests/first-run-walk/verify.mjs [/absolute/owned/report-dir]
// It builds the fixture first unless FIRST_RUN_WALK_SITE names a built one.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const repo = NodePath.resolve(NodeURL.fileURLToPath(new URL(".", import.meta.url)), "../../../..");
const { walkFirstRun } = await import(
  NodeURL.pathToFileURL(NodePath.join(repo, "scripts/studio-verify/first-run-walk.mjs")).href
);

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = process.env.STUDIO_PLAYWRIGHT_MODULE
  ? await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href)
  : NodeModule.createRequire(NodePath.join(repo, "apps/server/package.json"))("playwright-core");

let site = process.env.FIRST_RUN_WALK_SITE;
if (!site) {
  const build = NodeChildProcess.spawnSync(
    process.execPath,
    [
      NodePath.join(repo, "node_modules/vite-plus/bin/vp"),
      "build",
      "--config",
      "apps/web/tests/first-run-walk/vite.config.ts",
    ],
    { cwd: repo, stdio: ["ignore", "ignore", "inherit"] },
  );
  if (build.status !== 0) throw new Error(`the first-run fixture did not build (${build.status})`);
  site = NodePath.join(repo, ".artifacts/first-run-walk/site");
}
site = NodePath.resolve(site);
const output = NodePath.resolve(
  process.argv[2] ?? NodePath.join(repo, ".artifacts/first-run-walk/evidence"),
);
await NodeFSP.mkdir(output, { recursive: true });

const MIME = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
};
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

const WALKS = [
  { entry: "connection", locale: "en-US", theme: "light", width: 1280, height: 800 },
  { entry: "start", locale: "en-US", theme: "dark", width: 390, height: 844 },
  { entry: "start", locale: "de-DE", theme: "light", width: 1280, height: 800 },
  { entry: "connection", locale: "de-DE", theme: "dark", width: 390, height: 844 },
];
const EXPECTED = {
  start: ["start", "agents", "access", "import"],
  connection: ["connection", "agents", "access", "import"],
};
// Chosen, granted or imported: a walk on neutral actions does none of these.
const FORBIDDEN_CALLS = ["accept", "import", "createProject", "openSetupAuthPrompt"];

const problems = [];
const report = [];
const fail = (where, what) => problems.push(`${where}: ${what}`);
/** Nothing off the side, and the dialog inside the window. */
const layout = (page) =>
  page.evaluate(() => {
    const found = [];
    const root = document.documentElement;
    if (root.scrollWidth > root.clientWidth) found.push(`sideways scroll (${root.scrollWidth})`);
    const box = document.querySelector("[data-wizard-step]")?.getBoundingClientRect();
    if (box && (box.left < 0 || box.right > root.clientWidth + 0.5))
      found.push(`dialog off the side (${Math.round(box.left)}..${Math.round(box.right)})`);
    return found;
  });

for (const walk of WALKS) {
  const at = `${walk.entry} ${walk.locale} ${walk.theme} ${walk.width}`;
  const context = await browser.newContext({
    viewport: { width: walk.width, height: walk.height },
    deviceScaleFactor: 2,
    colorScheme: walk.theme,
    locale: walk.locale,
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const shots = [];
  const labels = [];
  let steps = [];
  try {
    await page.goto(`${origin}/?entry=${walk.entry}&theme=${walk.theme}`);
    await page.waitForLoadState("networkidle");
    steps = await walkFirstRun(page, {
      until: () => page.locator("[data-fixture-done]").isVisible(),
      stepTimeoutMs: 15_000,
      appearTimeoutMs: 15_000,
      onStep: async (step) => {
        await page.waitForTimeout(150);
        labels.push(
          await page
            .locator("[data-wizard-step] [data-wizard-neutral]:not(:disabled)")
            .innerText()
            .then((text) => text.trim().split("\n")[0]),
        );
        for (const problem of await layout(page)) fail(`${at} ${step}`, problem);
        const name = `${walk.entry}-${walk.locale}-${walk.theme}-${walk.width}-${shots.length + 1}-${step}.png`;
        await page.screenshot({ path: NodePath.join(output, name) });
        shots.push(name);
      },
    });
    await page.locator("[data-fixture-done]").waitFor({ timeout: 15_000 });
  } catch (error) {
    fail(at, error.message);
    steps = error.firstRunSteps ?? steps;
    await page.screenshot({ path: NodePath.join(output, `FAILED-${at.replaceAll(" ", "-")}.png`) });
  }
  if (steps.join() !== EXPECTED[walk.entry].join())
    fail(
      at,
      `walked ${steps.join(" > ") || "nothing"}, expected ${EXPECTED[walk.entry].join(" > ")}`,
    );
  const calls = await page.evaluate(() => window.fixtureCalls.map((call) => call[0]));
  for (const call of FORBIDDEN_CALLS) if (calls.includes(call)) fail(at, `the walk called ${call}`);
  if (!calls.includes("done")) fail(at, "setup did not finish");
  for (const error of errors) fail(at, `page error: ${error}`);
  report.push({ ...walk, steps, labels, calls, screenshots: shots });
  await context.close();
}
// The German walks went through German setup: no neutral action reads as in English.
for (const german of report.filter((walk) => walk.locale === "de-DE")) {
  const english = report.find((walk) => walk.locale === "en-US" && walk.entry === german.entry);
  const same = german.labels.filter((label, index) => label === english?.labels[index]);
  if (german.labels.length === 0 || same.length > 0)
    fail(`${german.entry} de-DE`, `labels not in German: ${JSON.stringify(german.labels)}`);
}
await browser.close();
server.close();
await NodeFSP.writeFile(
  NodePath.join(output, "report.json"),
  `${JSON.stringify({ walks: report, problems }, null, 2)}\n`,
);
if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`First-run walk: ${report.length} walks passed. ${output}`);
