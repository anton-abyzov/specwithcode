// TEMPORARY (increment 1387, T-06). Removed before the PR is ready.
//
// On a fresh macOS account (a GitHub runner), opens Chrome once so a profile
// exists, starts the built app the way a person does (`open -n`, the runner's
// real HOME, a throwaway STUDIO_HOME), asks the renderer for
// `window.desktopBridge.listExternalBrowsers()` over the DevTools port, and
// saves what it returned plus the TCC log lines of three windows: launch, idle,
// and the list call.
//
//   node scripts/desktop-e2e/chrome-profile-diagnostic.mjs <SpecWithCode.app> <out-dir>
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const [appPath, outDir] = process.argv.slice(2);
if (!appPath || !outDir) {
  console.error("usage: chrome-profile-diagnostic.mjs <SpecWithCode.app> <out-dir>");
  process.exit(2);
}
NodeFS.mkdirSync(outDir, { recursive: true });
const { chromium } = NodeModule.createRequire(NodePath.resolve("apps/server/package.json"))(
  "playwright-core",
);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const run = (cmd, args, options = {}) => {
  const result = NodeChildProcess.spawnSync(cmd, args, { encoding: "utf8", ...options });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};
const stamp = () => run("date", ["+%Y-%m-%d %H:%M:%S"]).stdout.trim();
const result = { steps: [] };
const note = (what, data = {}) => {
  const entry = { at: new Date().toISOString(), what, ...data };
  result.steps.push(entry);
  console.log(JSON.stringify(entry));
};
const save = () =>
  NodeFS.writeFileSync(NodePath.join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);

/** Every TCC line in the window, and the ones that name the app, Chrome or App Data. */
function tccWindow(name, start, end) {
  const log = run("log", [
    "show",
    "--start",
    start,
    "--end",
    end,
    "--info",
    "--debug",
    "--style",
    "compact",
    "--predicate",
    'subsystem == "com.apple.TCC" OR process == "tccd"',
  ]);
  NodeFS.writeFileSync(NodePath.join(outDir, `tcc-${name}.log`), log.stdout + log.stderr);
  const lines = log.stdout.split("\n");
  const relevant = lines.filter((line) =>
    /SpecWithCode|Electron|specwithcode|Google Chrome|SystemPolicyAppData|AppData|AUTHREQ|prompt/i.test(
      line,
    ),
  );
  NodeFS.writeFileSync(NodePath.join(outDir, `tcc-${name}-relevant.log`), relevant.join("\n"));
  return { start, end, lines: lines.length, relevant: relevant.length, sample: relevant.slice(0, 40) };
}

const home = NodeOS.homedir();
const chromeApp = "/Applications/Google Chrome.app";
const localState = NodePath.join(home, "Library/Application Support/Google/Chrome/Local State");
result.machine = {
  user: NodeOS.userInfo().username,
  home,
  macos: run("sw_vers", []).stdout.trim(),
  chromeInstalled: NodeFS.existsSync(chromeApp),
  chromeVersion: run("defaults", ["read", `${chromeApp}/Contents/Info.plist`, "CFBundleShortVersionString"])
    .stdout.trim(),
  localStateBefore: NodeFS.existsSync(localState),
  appSignature: run("codesign", ["-dv", appPath]).stderr.trim(),
};
note("machine", result.machine);

// 1. Chrome once, so a profile and its Local State exist.
const chromeStart = stamp();
run("open", ["-na", chromeApp, "--args", "--no-first-run", "--no-default-browser-check", "about:blank"]);
for (let i = 0; i < 60 && !NodeFS.existsSync(localState); i++) await sleep(1000);
await sleep(8000);
const chromePids = run("pgrep", ["-x", "Google Chrome"]).stdout.trim().split(/\s+/).filter(Boolean);
for (const pid of chromePids) {
  try {
    process.kill(Number(pid), "SIGTERM");
  } catch {}
}
for (let i = 0; i < 20 && run("pgrep", ["-x", "Google Chrome"]).stdout.trim(); i++) await sleep(500);
await sleep(2000);
result.chrome = {
  pids: chromePids,
  localStateAfter: NodeFS.existsSync(localState),
  profilesOnDisk: (() => {
    try {
      const state = JSON.parse(NodeFS.readFileSync(localState, "utf8"));
      return Object.entries(state.profile?.info_cache ?? {}).map(([dir, info]) => ({
        directory: dir,
        name: info?.name ?? null,
      }));
    } catch (error) {
      return { error: String(error) };
    }
  })(),
};
note("chrome opened once", result.chrome);
result.tccChrome = tccWindow("chrome", chromeStart, stamp());

// 2. The app, started as a person starts it.
const studioHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-diag-"));
const port = 9339;
const launchStart = stamp();
const opened = run("open", [
  "-n",
  "--env",
  `STUDIO_HOME=${studioHome}`,
  "--env",
  "STUDIO_DESKTOP_TEST_OFFSCREEN=1",
  appPath,
  "--args",
  "--use-mock-keychain",
  `--remote-debugging-port=${port}`,
]);
note("open app", opened);
let page = null;
let browser = null;
for (let i = 0; i < 120 && page === null; i++) {
  await sleep(1000);
  try {
    browser ??= await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 5000 });
    for (const context of browser.contexts()) {
      for (const candidate of context.pages()) {
        const has = await candidate
          .evaluate(() => typeof window.desktopBridge?.listExternalBrowsers === "function")
          .catch(() => false);
        if (has) page = candidate;
      }
    }
  } catch {}
}
const appPids = run("pgrep", ["-x", "SpecWithCode"]).stdout.trim().split(/\s+/).filter(Boolean);
note("app window", { found: page !== null, url: page?.url() ?? null, appPids });
result.tccLaunch = tccWindow("launch", launchStart, stamp());

// 3. Idle, with the window open and nothing pressed.
const idleStart = stamp();
await sleep(10_000);
result.tccIdle = tccWindow("idle", idleStart, stamp());

// 4. The list, through the same bridge method the Chrome row calls.
const listStart = stamp();
if (page) {
  const began = Date.now();
  result.list = await page
    .evaluate(
      () =>
        Promise.race([
          window.desktopBridge.listExternalBrowsers().then((value) => ({ value })),
          new Promise((done) => setTimeout(() => done({ timedOut: true }), 30_000)),
        ]),
    )
    .catch((error) => ({ error: String(error) }));
  result.list.ms = Date.now() - began;
} else {
  result.list = { error: "no app window with the desktop bridge" };
}
note("listExternalBrowsers", result.list);
await sleep(5000);
result.tccList = tccWindow("list", listStart, stamp());

for (const pid of appPids) {
  try {
    process.kill(Number(pid), "SIGTERM");
  } catch {}
}
await browser?.close().catch(() => {});
save();
console.log(`Chrome profile diagnostic written to ${outDir}`);
