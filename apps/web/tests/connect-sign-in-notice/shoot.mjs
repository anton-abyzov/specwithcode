// Headless check and screenshots of the Connect sign-in notice, light and dark.
//
//   node tests/connect-sign-in-notice/shoot.mjs [out dir]              builds the fixture, then shoots
//   node tests/connect-sign-in-notice/shoot.mjs <site dir> <out dir>   shoots a site that is already built
//
// Screenshots go to the out dir, by default a new folder in the system's
// temporary directory, never into the repository.
// Env: STUDIO_PLAYWRIGHT_MODULE, STUDIO_CHROME.
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
  site = NodePath.join(repo, ".artifacts/connect-sign-in-notice/site");
  output = args[0]
    ? NodePath.resolve(args[0])
    : await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "connect-sign-in-notice-"));
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
    console.error("connect sign-in notice: the fixture did not build");
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
  try {
    const mime =
      { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" }[
        NodePath.extname(file)
      ] ?? "text/html";
    res.writeHead(200, { "Content-Type": mime }).end(await NodeFSP.readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.STUDIO_CHROME,
});

// The wording agreed in increment 1366 (D-04).
const notices = {
  waiting: {
    title: "Finish signing in in your browser",
    description:
      "The sign-in page opened in your browser. If you don't see it, look for a new browser tab or window. Click the button again to open it again.",
  },
  "open-failed": {
    title: "Couldn't open your browser",
    description: "Open a browser on this computer, then click the button again.",
  },
  "timed-out": {
    title: "Sign-in didn't finish",
    description: "The browser didn't come back within 3 minutes. Click the button again to retry.",
  },
};
const TOAST = '[data-slot="toast-viewport"] [data-slot="toast-title"]';
const failures = [];

for (const theme of ["light", "dark"]) {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
  });
  const fail = (message) => failures.push(`${theme}: ${message}`);
  await page.goto(`${origin}/?theme=${theme}`);
  await page.getByTestId("sign-in-dialog-stand-in").waitFor();
  const emit = (state) => page.evaluate((value) => window.emitConnectSignInState(value), state);
  const titles = () => page.locator(TOAST).allInnerTexts();
  const settle = () => page.waitForTimeout(700);

  if ((await titles()).length !== 0) fail("a notice shows before any sign-in");

  // The order a person can meet them in: waiting, a second click, a timeout,
  // a retry, then a browser that cannot be opened. One notice throughout.
  for (const state of ["waiting", "waiting", "timed-out", "waiting", "open-failed"]) {
    const startedAt = Date.now();
    await emit(state);
    const want = notices[state];
    try {
      await page.getByText(want.title, { exact: true }).waitFor({ timeout: 1000 });
    } catch {
      fail(`${state}: "${want.title}" did not show within one second`);
      continue;
    }
    const shownAfterMs = Date.now() - startedAt;
    await settle();
    const shown = await titles();
    if (shown.length !== 1) fail(`${state}: ${shown.length} notices (${shown.join(" | ")})`);
    const viewport = page.locator('[data-slot="toast-viewport"]');
    const text = await viewport.innerText();
    if (!text.includes(want.description)) fail(`${state}: description is not the agreed wording`);
    // The notice is in front of the sign-in dialog's backdrop, not dimmed under it.
    const onTop = await page.evaluate((selector) => {
      const title = document.querySelector(selector);
      if (!title) return false;
      const box = title.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return hit !== null && title.closest('[data-slot="toast-viewport"]').contains(hit);
    }, TOAST);
    if (!onTop) fail(`${state}: the notice is behind the sign-in dialog`);
    console.log(`${theme} ${state}: shown in ${shownAfterMs} ms, 1 notice, in front of the dialog`);
    await page.screenshot({ path: NodePath.join(output, `${state}-${theme}.png`) });
  }

  // The notice stays while the sign-in waits: no auto-dismiss.
  await emit("waiting");
  await page.waitForTimeout(11_000);
  if ((await titles()).join() !== notices.waiting.title) fail("waiting: the notice went away");

  for (const state of ["completed", "replaced"]) {
    await emit("waiting");
    await page.getByText(notices.waiting.title, { exact: true }).waitFor({ timeout: 1000 });
    await emit(state);
    try {
      await page.locator(TOAST).first().waitFor({ state: "detached", timeout: 3000 });
    } catch {
      fail(`${state}: the notice stayed`);
    }
  }
  await page.screenshot({ path: NodePath.join(output, `completed-${theme}.png`) });
  await page.close();
}
await browser.close();
server.close();
console.log(`screenshots: ${output}`);
console.log(failures.length ? failures.join("\n") : "connect sign-in notice: all states pass");
process.exit(failures.length ? 1 : 0);
