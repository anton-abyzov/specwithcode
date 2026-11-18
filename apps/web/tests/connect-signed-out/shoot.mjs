// Headless check and screenshots of a window signed out of SpecWithCode Connect (1417).
//
//   node apps/web/tests/connect-signed-out/shoot.mjs [out dir]              builds, then shoots
//   node apps/web/tests/connect-signed-out/shoot.mjs <site dir> <out dir>   shoots a built site
//
// Screenshots and receipt.json go to the out dir, by default a new folder in
// the system's temporary directory, never into the repository.
// Env: STUDIO_PLAYWRIGHT_MODULE, STUDIO_CHROME. Always headless.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const repo = NodePath.resolve(here, "../../../..");
const args = process.argv.slice(2);

let site;
let output;
if (args.length >= 2) {
  [site, output] = args.map((path) => NodePath.resolve(path));
} else {
  site = NodePath.join(repo, ".artifacts/connect-signed-out/site");
  output = args[0]
    ? NodePath.resolve(args[0])
    : await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "connect-signed-out-"));
  const build = NodeChildProcess.spawnSync(
    process.execPath,
    [
      NodePath.join(repo, "node_modules/vite-plus/bin/vp"),
      "build",
      "--config",
      NodePath.join(here, "vite.config.ts"),
    ],
    { cwd: repo, stdio: ["ignore", "ignore", "inherit"] },
  );
  if (build.status !== 0) {
    console.error("connect signed out: the fixture did not build");
    process.exit(1);
  }
}
await NodeFSP.mkdir(output, { recursive: true });

const { chromium } = NodeModule.createRequire(NodePath.join(repo, "apps/server/package.json"))(
  process.env.STUDIO_PLAYWRIGHT_MODULE ?? "playwright-core",
);
const server = NodeHttp.createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  const file = NodePath.resolve(site, `.${pathname === "/" ? "/index.html" : pathname}`);
  const mime =
    { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" }[
      NodePath.extname(file)
    ] ?? "text/html";
  // Read first: a missing file answers 404, not a half-sent 200.
  const body = await NodeFSP.readFile(file).catch(() => null);
  if (body === null) res.writeHead(404).end();
  else res.writeHead(200, { "Content-Type": mime }).end(body);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.STUDIO_CHROME,
});

const BANNER = "[data-connect-signed-out]";
const RUNNING =
  "Office Mac is running, but this window can't reach it until you sign in. This machine is not affected. Still connected: Mac mini.";
const failures = [];
const receipt = [];

for (const account of ["signed-out", "signed-in"]) {
  for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({
      viewport: { width: 820, height: 900 },
      deviceScaleFactor: 2,
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    const fail = (message) => failures.push(`${account} ${theme}: ${message}`);
    await page.goto(`${origin}/?account=${account}&theme=${theme}`);
    await page.locator("[data-fixture-pane]").waitFor();
    await page.getByText("Read the device approval state").waitFor();
    await page.waitForTimeout(800);
    const pane = await page.locator("[data-fixture-pane]").innerText();
    const account_ = await page.locator("[data-fixture-account]").innerText();
    const banner = page.locator(BANNER);
    const bannerShown = (await banner.count()) > 0;
    const row = (id) => page.locator(`.sws-thread-row[data-thread-id=${id}]`).innerText();
    const officeRow = await row("office-1");
    const buildRow = await row("build-1");
    if (!pane.includes("Not reachable from here")) fail("no Not reachable from here heading");
    if (/^\s*Offline\b/m.test(pane)) fail("a group is still headed Offline");
    if (!/Not reachable from here/.test(buildRow)) fail(`Build box row reads: ${buildRow}`);
    if (account === "signed-out") {
      if (!bannerShown) fail("no signed-out banner");
      else {
        const text = await banner.innerText();
        if (!text.includes("Signed out of SpecWithCode Connect")) fail("banner title missing");
        if (!text.replace(/\s+/g, " ").includes(RUNNING)) fail(`banner body reads: ${text}`);
        if (/keep running|keeps running|can't be opened/i.test(text)) fail("banner overclaims");
        await banner.getByRole("button", { name: "Sign in" }).click();
        const opened = await page.evaluate(() => document.body.dataset.signInOpened === "true");
        if (!opened) fail("Sign in did not open the sign-in");
      }
      if (!/Needs sign-in/.test(officeRow)) fail(`Office Mac row reads: ${officeRow}`);
      if (!/Signed out/.test(account_)) fail(`account button reads: ${account_}`);
    } else {
      // The startup race: Clerk signed in, the relay client not yet handed the session.
      if (bannerShown) fail("a banner shows while Clerk says signed in");
      if (/Needs sign-in/.test(pane)) fail("Needs sign-in flashes while Clerk says signed in");
      if (!/Not connected/.test(officeRow)) fail(`Office Mac row reads: ${officeRow}`);
    }
    if (errors.length) fail(`page errors: ${errors.join(" | ")}`);
    const file = `${account}-${theme}.png`;
    await page.screenshot({ path: NodePath.join(output, file) });
    receipt.push({ account, theme, banner: bannerShown, officeRow, buildRow, screenshot: file });
    console.log(
      `${account} ${theme}: banner ${bannerShown}, office "${officeRow.replace(/\s+/g, " ")}"`,
    );
    await page.close();
  }
}
await browser.close();
server.close();
await NodeFSP.writeFile(
  NodePath.join(output, "receipt.json"),
  JSON.stringify({ at: new Date().toISOString(), failures, receipt }, null, 2),
);
console.log(`screenshots: ${output}`);
console.log(failures.length ? failures.join("\n") : "connect signed out: all states pass");
process.exit(failures.length ? 1 : 0);
