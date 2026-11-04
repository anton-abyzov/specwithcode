#!/usr/bin/env node
// The release's verify stage: the built desktop app, unpacked as a person gets it, runs headless
// in a throwaway home before anything is drafted or published (scripts/release/release.sh, stage
// verify, after sign). Two modes, both required by the release:
//
//   fresh     the app's bundled server starts on a fresh isolated home and a free loopback port,
//             /.well-known/studio/environment reports --version, and a thread and the project
//             coordinator answer through the offline fake ACP agent (scripts/desktop-e2e/
//             installed-e2e.mjs), within --timeout-ms (120 s). Then the startup acceptance proof
//             (scripts/studio-fleet/test-startup.mjs) against the same bundled server. With
//             --fixture-out, the home that run left is packed as this release's state fixture,
//             which the next release's upgraded mode starts from.
//   upgraded  a home seeded from the previous release's state fixture (--fixture, or made now
//             by the fresh run on --previous-archive / --previous-app) is captured, the new
//             build's server starts on it as the installed service does, reports --version and
//             the fixture's environment id, and passes the post-update check
//             (update.py verify --local) and scripts/studio-fleet/test-installed-startup.mjs --local.
//
// Usage:
//   node scripts/release/verify-built-app.mjs --mode fresh|upgraded|all
//     (--archive SpecWithCode-X.Y.Z-arm64.zip | --app <SpecWithCode.app | installed executable>)
//     --version X.Y.Z --out <dir>
//     [--fixture <state-fixture.tar.gz> | --previous-archive <zip> | --previous-app <app>]
//     [--fixture-out <state-fixture.tar.gz>] [--timeout-ms 120000] [--proof-timeout-ms 240000]
//     [--no-proofs] [--keep]
//
// --no-proofs leaves out the acceptance proofs, and the receipt says so. Only where they cannot
// run: Windows (its CLI cannot be wrapped in a shell script) and CI runners without the release
// Mac's pinned Node (test-startup.mjs asserts v22.20.0). release.sh's verify stage never gives it. A mode that cannot run
// (no previous state for upgraded) is a usage error, never a pass. Writes <out>/receipt.json and
// exits 0 only when every requested mode passed. Headless only (PWDEBUG=0,
// PLAYWRIGHT_HTML_OPEN=never); only the processes this script starts are stopped, and nothing is
// written outside --out, --fixture-out and its own temporary folders. Every child (the e2e run,
// the proofs, the post-update check, the server) gets a scratch HOME, STUDIO_HOME and TMPDIR in
// that mode's temporary folder, never the caller's home; the folder is removed when the mode ends,
// passed or not, unless --keep is given (the receipt then names it).
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const HERE = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const REPO_ROOT = NodePath.resolve(HERE, "../..");
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const MODES = ["fresh", "upgraded", "all"];
const RESERVED_PORT = 8319;
const IS_WIN = process.platform === "win32";

export const DEFAULT_SCRIPTS = {
  installedE2e: NodePath.join(REPO_ROOT, "scripts/desktop-e2e/installed-e2e.mjs"),
  startupProof: NodePath.join(REPO_ROOT, "scripts/studio-fleet/test-startup.mjs"),
  installedStartup: NodePath.join(REPO_ROOT, "scripts/studio-fleet/test-installed-startup.mjs"),
  update: NodePath.join(REPO_ROOT, "scripts/studio-fleet/update.py"),
};

export class UsageError extends Error {}

const VALUE_OPTIONS = {
  "--mode": "mode",
  "--archive": "archive",
  "--app": "app",
  "--version": "version",
  "--out": "out",
  "--fixture": "fixture",
  "--previous-archive": "previousArchive",
  "--previous-app": "previousApp",
  "--fixture-out": "fixtureOut",
  "--timeout-ms": "timeoutMs",
  "--proof-timeout-ms": "proofTimeoutMs",
};

export function parseArgs(argv) {
  const options = { proofs: true, keep: false, timeoutMs: 120_000, proofTimeoutMs: 240_000 };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--no-proofs" || arg === "--keep") {
      options[arg === "--keep" ? "keep" : "proofs"] = arg === "--keep";
      continue;
    }
    const key = VALUE_OPTIONS[arg];
    if (!key) throw new UsageError(`unknown option ${arg}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`${arg} needs a value`);
    if (options[key] !== undefined && !["timeoutMs", "proofTimeoutMs"].includes(key))
      throw new UsageError(`${arg} given twice`);
    options[key] = value;
    index++;
  }
  for (const key of ["timeoutMs", "proofTimeoutMs"]) {
    const value = Number(options[key]);
    if (!Number.isInteger(value) || value < 1_000 || value > 3_600_000)
      throw new UsageError(`--${key === "timeoutMs" ? "" : "proof-"}timeout-ms must be 1000 to 3600000`);
    options[key] = value;
  }
  if (!MODES.includes(options.mode)) throw new UsageError("--mode must be fresh, upgraded or all");
  if (!options.version || !VERSION_RE.test(options.version))
    throw new UsageError("--version X.Y.Z is required");
  if (!options.out) throw new UsageError("--out DIR is required");
  if (Boolean(options.archive) === Boolean(options.app))
    throw new UsageError("give one of --archive or --app");
  const sources = ["fixture", "previousArchive", "previousApp"].filter((key) => options[key]);
  if (sources.length > 1)
    throw new UsageError("give one of --fixture, --previous-archive or --previous-app");
  const upgraded = options.mode !== "fresh";
  if (upgraded && sources.length === 0)
    throw new UsageError(
      "upgraded mode needs the previous release's state (--fixture, --previous-archive or --previous-app); a skipped verify fails the release",
    );
  if (!upgraded && sources.length > 0)
    throw new UsageError("--fixture and --previous-* are for the upgraded mode");
  if (options.fixtureOut && !["fresh", "all"].includes(options.mode))
    throw new UsageError("--fixture-out needs the fresh mode");
  if (IS_WIN && options.proofs) throw new UsageError("on Windows give --no-proofs");
  if (IS_WIN && upgraded) throw new UsageError("the upgraded mode runs on macOS and Linux");
  for (const key of ["archive", "app", "out", "fixture", "previousArchive", "previousApp", "fixtureOut"])
    if (options[key]) options[key] = NodePath.resolve(options[key]);
  return options;
}

/** -1, 0 or 1 for two X.Y.Z versions. */
export function compareVersions(a, b) {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  return 0;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const errorText = (error) =>
  (error instanceof Error ? error.message : String(error)).split("\n")[0];

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
};

/** Stops a process this script started and, on POSIX, the group it leads. */
export async function stopTree(child, graceMs = 10_000) {
  if (!child?.pid) return true;
  const signal = (sig) => {
    if (IS_WIN) {
      NodeChildProcess.spawnSync("taskkill", ["/T", ...(sig === "SIGKILL" ? ["/F"] : []), "/PID", String(child.pid)], {
        stdio: "ignore",
      });
      return;
    }
    try {
      process.kill(-child.pid, sig);
    } catch {
      try {
        process.kill(child.pid, sig);
      } catch {}
    }
  };
  const groupAlive = () => {
    if (IS_WIN) return alive(child.pid);
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      return error?.code === "EPERM";
    }
  };
  if (!groupAlive()) return true;
  signal("SIGTERM");
  for (let waited = 0; waited < graceMs && groupAlive(); waited += 100) await sleep(100);
  if (groupAlive()) signal("SIGKILL");
  for (let waited = 0; waited < 5_000 && groupAlive(); waited += 100) await sleep(100);
  return !groupAlive();
}

/**
 * Runs one command in its own process group with its output in LOG, and stops the whole group
 * at the deadline. Never rejects: { code, signal, timedOut, error, seconds, log }.
 */
export function runStep(command, args, { timeoutMs, log, env = process.env, cwd } = {}) {
  return new Promise((resolve) => {
    NodeFS.mkdirSync(NodePath.dirname(log), { recursive: true });
    const fd = NodeFS.openSync(log, "a");
    const started = Date.now();
    let timedOut = false;
    let settled = false;
    const child = NodeChildProcess.spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", fd, fd],
      detached: !IS_WIN,
      windowsHide: true,
    });
    LIVE.add(child);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      LIVE.delete(child);
      clearTimeout(timer);
      NodeFS.closeSync(fd);
      resolve({ ...result, timedOut, seconds: Math.round((Date.now() - started) / 100) / 10, log });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      void stopTree(child, 5_000);
    }, timeoutMs);
    child.on("error", (error) => finish({ code: null, signal: null, error: errorText(error) }));
    child.on("exit", (code, signal) => {
      // What it left in its group (a server, a browser) goes with it.
      void stopTree(child, 2_000).then(() => finish({ code, signal, error: null }));
    });
  });
}

const stepFailure = (name, step, timeoutMs) => {
  if (step.timedOut) return `${name} did not finish within ${timeoutMs} ms (log ${step.log})`;
  if (step.error) return `${name} could not start: ${step.error}`;
  if (step.code !== 0)
    return `${name} exited ${step.code ?? step.signal} (log ${step.log})`;
  return null;
};

const readJson = (file) => {
  try {
    return JSON.parse(NodeFS.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = NodeNet.createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

// What an interrupted run must stop and remove: live children (each leads its own process
// group) and temporary folders. Both are kept current as steps start and finish.
const LIVE = new Set();
const TEMP = new Set();
let keepTemp = false;

const tempDir = (prefix) => {
  const dir = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix)));
  TEMP.add(dir);
  return dir;
};

const removeTemp = (dir) => {
  NodeFS.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  TEMP.delete(dir);
};

/**
 * SIGINT/SIGTERM/SIGHUP: children are detached into their own groups, so the terminal's signal
 * never reaches them. Kill each group, remove the temporary folders (unless --keep), and exit.
 */
export function interrupted(signal) {
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.removeAllListeners(sig).on(sig, () => {});
  for (const child of LIVE) {
    if (IS_WIN) NodeChildProcess.spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" });
    else {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {}
      }
    }
  }
  if (!keepTemp) for (const dir of [...TEMP]) {
    try {
      removeTemp(dir);
    } catch {}
  }
  console.error(`verify-built-app: stopped by ${signal}${keepTemp && TEMP.size ? `; kept ${[...TEMP].join(", ")}` : ""}`);
  process.exit(128 + (NodeOS.constants.signals[signal] ?? 1));
}

/**
 * The executable to run: the app inside an archive (unpacked with ditto, which keeps the
 * signature, into a temporary folder), the main executable of a .app bundle, or the path itself.
 */
export function resolveExecutable(target, { archive = false } = {}) {
  let path = target;
  let cleanup = null;
  if (archive) {
    if (!NodeFS.existsSync(target)) throw new Error(`the archive ${target} does not exist`);
    const dir = tempDir("swc-verify-app-");
    cleanup = dir;
    const unpack = NodeChildProcess.spawnSync("ditto", ["-x", "-k", target, dir], { encoding: "utf8" });
    if (unpack.status !== 0) throw new Error(`could not unpack ${target}: ${unpack.stderr || unpack.error}`);
    const bundle = NodeFS.readdirSync(dir).find((name) => name.endsWith(".app"));
    if (!bundle) throw new Error(`${target} holds no .app bundle`);
    path = NodePath.join(dir, bundle);
  }
  if (path.endsWith(".app")) {
    const macos = NodePath.join(path, "Contents", "MacOS");
    const plist = NodePath.join(path, "Contents", "Info.plist");
    const named = NodeFS.existsSync(plist)
      ? /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/u.exec(NodeFS.readFileSync(plist, "utf8"))?.[1]
      : undefined;
    const entries = NodeFS.existsSync(macos) ? NodeFS.readdirSync(macos) : [];
    const name = named ?? (entries.length === 1 ? entries[0] : undefined);
    if (!name) throw new Error(`${path} names no main executable`);
    path = NodePath.join(macos, name);
  }
  if (!NodeFS.existsSync(path)) throw new Error(`the app executable ${path} does not exist`);
  return { executable: path, cleanup };
}

/** A mode's temporary folder: the scratch home, base dir and TMPDIR every child of it gets. */
function modeScratch(mode) {
  const root = tempDir(`swc-verify-${mode}-`);
  const paths = { root, home: NodePath.join(root, "home"), base: NodePath.join(root, "base"), tmp: NodePath.join(root, "tmp") };
  for (const dir of [paths.home, paths.tmp]) NodeFS.mkdirSync(dir, { recursive: true });
  return paths;
}

/** Removes a mode's temporary folder unless --keep; the report names a kept one. */
function endScratch(scratch, options, report) {
  if (options.keep) report.scratch = scratch.root;
  else removeTemp(scratch.root);
}

/**
 * The environment of every child: a few inherited names (PATH resolves python3 and node), then
 * the scratch HOME, STUDIO_HOME and TMPDIR, so nothing reads or writes the caller's home.
 */
function childEnv(scratch, base = scratch.base) {
  const inherited = IS_WIN
    ? ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "windir", "COMSPEC", "PATHEXT"]
    : ["PATH", "LANG", "USER", "LOGNAME"];
  const env = Object.fromEntries(
    inherited.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]),
  );
  return {
    ...env,
    ...(IS_WIN ? { TEMP: scratch.tmp, TMP: scratch.tmp, USERPROFILE: scratch.home } : { TMPDIR: scratch.tmp, LANG: env.LANG ?? "en_US.UTF-8" }),
    HOME: scratch.home,
    XDG_CONFIG_HOME: NodePath.join(scratch.home, ".config"),
    XDG_DATA_HOME: NodePath.join(scratch.home, ".local", "share"),
    XDG_CACHE_HOME: NodePath.join(scratch.home, ".cache"),
    STUDIO_HOME: base,
    STUDIO_ENABLE_HOSTED_SERVICES: "false",
    STUDIO_LOG_LEVEL: "Warn",
    PWDEBUG: "0",
    PLAYWRIGHT_HTML_OPEN: "never",
  };
}

/** The child environment of the bundled server: the app as Node, on the scratch home. */
function serverEnv(scratch, base) {
  return {
    ...childEnv(scratch, base),
    ...(IS_WIN ? {} : { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }),
    ELECTRON_RUN_AS_NODE: "1",
    STUDIO_NO_BROWSER: "true",
    STUDIO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
  };
}

/** A shell script that runs the bundled CLI (ELECTRON_RUN_AS_NODE), for the acceptance proofs. */
function writeCliWrapper(dir, executable, entry) {
  const file = NodePath.join(dir, "studio-cli");
  const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
  NodeFS.writeFileSync(
    file,
    `#!/bin/sh\nELECTRON_RUN_AS_NODE=1\nexport ELECTRON_RUN_AS_NODE\nexec ${quote(executable)} ${quote(entry)} "$@"\n`,
    { mode: 0o700 },
  );
  return file;
}

/** Playwright for the proofs: the build tree's own playwright-core, whose headless shell release.sh installs. */
function playwrightModule() {
  try {
    const require = NodeModule.createRequire(NodePath.join(REPO_ROOT, "apps", "server", "package.json"));
    return NodePath.dirname(require.resolve("playwright-core/package.json"));
  } catch {
    return undefined;
  }
}
/** Where Playwright keeps its browsers for the caller, read-only to the proofs on a scratch HOME. */
function browsersPath() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH;
  const home = NodeOS.userInfo().homedir;
  if (process.platform === "darwin") return NodePath.join(home, "Library", "Caches", "ms-playwright");
  if (IS_WIN) return NodePath.join(process.env.LOCALAPPDATA ?? NodePath.join(home, "AppData", "Local"), "ms-playwright");
  return NodePath.join(home, ".cache", "ms-playwright");
}
const proofEnv = (scratch, base) => {
  const module = playwrightModule();
  return {
    ...childEnv(scratch, base),
    PLAYWRIGHT_BROWSERS_PATH: browsersPath(),
    ...(module ? { STUDIO_PLAYWRIGHT_MODULE: module } : {}),
  };
};

// installed-e2e stops itself at --timeout-ms and writes its diagnostics then; this script stops it
// only if that does not happen, after this much more time (at most 60 s, at most the timeout).
export const killHeadroomMs = (timeoutMs) => Math.min(60_000, timeoutMs);
// The checks a passed run must have passed, not merely left out.
export const REQUIRED_CHECKS = ["bundled-server-entry", "server-start", "thread-reply", "coordinator-reply", "fake-agent-log"];

/** Runs installed-e2e.mjs on EXECUTABLE and reads its results; keeps its scratch for a fixture. */
async function runInstalledE2e(name, executable, out, options, scripts, scratch) {
  const failures = [];
  const dir = NodePath.join(out, name);
  NodeFS.mkdirSync(dir, { recursive: true });
  // installed-e2e refuses to write under ~/.specwithcode, where the release staging folder is,
  // so it writes to a temporary folder that is copied into DIR afterwards.
  const e2eOut = tempDir("swc-verify-e2e-");
  const outerMs = options.timeoutMs + killHeadroomMs(options.timeoutMs);
  let step;
  try {
    step = await runStep(
      process.execPath,
      [scripts.installedE2e, "--app", executable, "--out", e2eOut, "--keep-scratch", "--timeout-ms", String(options.timeoutMs)],
      { timeoutMs: outerMs, log: NodePath.join(dir, "verify.log"), env: proofEnv(scratch) },
    );
  } finally {
    NodeFS.cpSync(e2eOut, dir, { recursive: true });
    removeTemp(e2eOut);
  }
  const results = readJson(NodePath.join(dir, "results.json"));
  const failed = stepFailure(`${name}: installed-e2e`, step, outerMs);
  if (failed) failures.push(failed);
  if (!results) {
    failures.push(`${name}: installed-e2e wrote no results.json`);
    return { step, results: null, failures, entry: null, serverVersion: null, environmentId: null };
  }
  for (const check of results.checks ?? [])
    if (check.status !== "pass") failures.push(`${name}: check ${check.name} failed`);
  const byName = Object.fromEntries((results.checks ?? []).map((check) => [check.name, check]));
  for (const required of REQUIRED_CHECKS)
    if (byName[required]?.status !== "pass" && !failures.some((f) => f.includes(`check ${required} `)))
      failures.push(`${name}: check ${required} did not run`);
  return {
    step,
    results,
    failures,
    entry: byName["bundled-server-entry"]?.entry ?? null,
    serverVersion: byName["server-start"]?.serverVersion ?? null,
    environmentId: byName["server-start"]?.environmentId ?? null,
  };
}

/** Packs the home an installed-e2e run left as a state fixture: base/ and fixture.json. */
function packFixture(results, version, environmentId, file) {
  const base = results.baseDir;
  if (!base || !NodeFS.existsSync(NodePath.join(base, "userdata", "statev2.sqlite")))
    throw new Error("the run left no home with a statev2.sqlite to pack");
  const stage = tempDir("swc-verify-fixture-");
  try {
    NodeFS.cpSync(base, NodePath.join(stage, "base"), { recursive: true, verbatimSymlinks: true });
    // Logs are evidence of that run, not state.
    for (const logs of [["logs"], ["userdata", "logs"]])
      NodeFS.rmSync(NodePath.join(stage, "base", ...logs), { recursive: true, force: true });
    NodeFS.writeFileSync(
      NodePath.join(stage, "fixture.json"),
      `${JSON.stringify({ schemaVersion: 1, version, environmentId, createdAt: new Date().toISOString() }, null, 2)}\n`,
    );
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    NodeFS.rmSync(file, { force: true });
    const tar = NodeChildProcess.spawnSync("tar", ["-czf", file, "-C", stage, "base", "fixture.json"], {
      encoding: "utf8",
    });
    if (tar.status !== 0) throw new Error(`could not pack the fixture: ${tar.stderr || tar.error}`);
  } finally {
    removeTemp(stage);
  }
}

export async function verifyFresh(options, executable, scripts = DEFAULT_SCRIPTS) {
  const out = NodePath.join(options.out, "fresh");
  const scratch = modeScratch("fresh");
  const report = { mode: "fresh", failures: [], proofs: options.proofs ? "ran" : "left out (--no-proofs)" };
  try {
    const run = await runInstalledE2e("fresh", executable, out, options, scripts, scratch);
    Object.assign(report, { serverVersion: run.serverVersion, checks: run.results?.checks?.map((c) => `${c.name}: ${c.status}`) ?? [] });
    report.failures.push(...run.failures);
    if (run.serverVersion !== null && run.serverVersion !== options.version)
      report.failures.push(`fresh: /.well-known/studio/environment reports ${run.serverVersion}, expected ${options.version}`);
    if (report.failures.length === 0 && options.proofs) {
      const dir = NodePath.join(out, "startup");
      const wrapper = writeCliWrapper(out, executable, run.entry);
      const step = await runStep(
        process.execPath,
        [scripts.startupProof, "--entrypoint", run.entry, "--cli-wrapper", wrapper, "--report-dir", dir],
        { timeoutMs: options.proofTimeoutMs, log: NodePath.join(out, "startup.log"), env: proofEnv(scratch) },
      );
      const failed = stepFailure("fresh: test-startup.mjs", step, options.proofTimeoutMs);
      if (failed) report.failures.push(failed);
      else if (readJson(NodePath.join(dir, "receipt.json"))?.result !== "passed")
        report.failures.push("fresh: test-startup.mjs wrote no passed receipt");
    }
    // Only a home every check and proof passed on becomes the next release's fixture.
    if (report.failures.length === 0 && options.fixtureOut) {
      packFixture(run.results, options.version, run.environmentId, options.fixtureOut);
      report.fixture = options.fixtureOut;
    }
  } catch (error) {
    report.failures.push(`fresh: ${errorText(error)}`);
  } finally {
    // The e2e scratch home and the proof's private homes live under the mode's TMPDIR.
    endScratch(scratch, options, report);
  }
  report.result = report.failures.length === 0 ? "passed" : "failed";
  return report;
}

/** The previous release's state as a fixture file: the given one, or made now from its app. */
async function previousFixture(options, out, scripts, scratch) {
  if (options.fixture) {
    if (!NodeFS.existsSync(options.fixture)) throw new Error(`the fixture ${options.fixture} does not exist`);
    return { file: options.fixture, failures: [] };
  }
  const resolved = resolveExecutable(options.previousArchive ?? options.previousApp, {
    archive: Boolean(options.previousArchive),
  });
  try {
    const run = await runInstalledE2e("previous", resolved.executable, out, options, scripts, scratch);
    const file = NodePath.join(out, "state-fixture.tar.gz");
    if (run.failures.length === 0) packFixture(run.results, run.serverVersion, run.environmentId, file);
    return { file, failures: run.failures.map((failure) => `the previous release's state: ${failure}`) };
  } finally {
    if (resolved.cleanup) removeTemp(resolved.cleanup);
  }
}

/** The bundled server entry inside the app's resources, found by the app itself (asar). */
function serverEntry(executable, env) {
  const resources =
    process.platform === "darwin"
      ? NodePath.resolve(NodePath.dirname(executable), "..", "Resources")
      : NodePath.join(NodePath.dirname(executable), "resources");
  const candidates = ["server.asar", "app.asar", "app"]
    .map((name) => NodePath.join(resources, name))
    .filter((root) => NodeFS.existsSync(root))
    .map((root) => NodePath.join(root, "apps", "server", "dist", "bin.mjs"));
  const probe = NodeChildProcess.spawnSync(
    executable,
    ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1).map(p=>require('fs').existsSync(p))))", ...candidates],
    { env, encoding: "utf8", timeout: 60_000 },
  );
  let found = [];
  try {
    found = JSON.parse(probe.stdout.trim() || "[]");
  } catch {}
  return candidates.find((_, index) => found[index] === true) ?? null;
}

export async function verifyUpgraded(options, executable, scripts = DEFAULT_SCRIPTS) {
  const out = NodePath.join(options.out, "upgraded");
  NodeFS.mkdirSync(out, { recursive: true });
  const report = { mode: "upgraded", failures: [] };
  const scratch = modeScratch("upgraded");
  let server = null;
  try {
    const fixture = await previousFixture(options, out, scripts, scratch);
    report.failures.push(...fixture.failures);
    if (report.failures.length > 0) return report;
    const unpack = NodeChildProcess.spawnSync("tar", ["-xzf", fixture.file, "-C", scratch.root], { encoding: "utf8" });
    const meta = readJson(NodePath.join(scratch.root, "fixture.json"));
    const base = scratch.base;
    if (unpack.status !== 0 || !meta || !NodeFS.existsSync(NodePath.join(base, "userdata", "statev2.sqlite"))) {
      report.failures.push(`upgraded: ${fixture.file} is not a state fixture (base/ and fixture.json)`);
      return report;
    }
    report.previousVersion = meta.version;
    if (!VERSION_RE.test(String(meta.version)) || compareVersions(meta.version, options.version) >= 0) {
      report.failures.push(`upgraded: the fixture is from ${meta.version}, not a release before ${options.version}`);
      return report;
    }
    const before = NodePath.join(out, "before.json");
    NodeFS.rmSync(before, { force: true });
    // Each step gets the whole --timeout-ms: a slow server start never eats the check's time.
    const python = (args, log) =>
      runStep("python3", ["-B", scripts.update, "verify", "--local", "--state", base, ...args], {
        timeoutMs: options.timeoutMs,
        log: NodePath.join(out, log),
        env: childEnv(scratch, base),
      });
    const capture = await python(["--capture", before], "capture.log");
    const captureFailure = stepFailure("upgraded: the capture before the update", capture, options.timeoutMs);
    if (captureFailure) {
      report.failures.push(captureFailure);
      return report;
    }
    const env = serverEnv(scratch, base);
    const entry = serverEntry(executable, env);
    if (!entry) {
      report.failures.push(`upgraded: no bundled server entry in ${executable}`);
      return report;
    }
    let port = await freePort();
    while (port === RESERVED_PORT) port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const serverLog = NodeFS.openSync(NodePath.join(out, "server.log"), "a");
    // As the installed service starts (scripts/studio-fleet/install.py), on the seeded home.
    server = NodeChildProcess.spawn(
      executable,
      [entry, "start", "--no-browser", "--host", "127.0.0.1", "--port", String(port), "--base-dir", base, "--mode", "web"],
      { cwd: base, env, stdio: ["ignore", serverLog, serverLog], detached: !IS_WIN, windowsHide: true },
    );
    LIVE.add(server);
    NodeFS.closeSync(serverLog);
    const deadline = Date.now() + options.timeoutMs;
    let exited = null;
    server.on("error", (error) => (exited = { error: errorText(error) }));
    server.on("exit", (code, signal) => (exited = { code, signal }));
    let environment = null;
    while (!environment && exited === null && Date.now() < deadline) {
      try {
        const response = await fetch(`${origin}/.well-known/studio/environment`, { signal: AbortSignal.timeout(5_000) });
        if (response.ok) environment = await response.json();
      } catch {}
      if (!environment) await sleep(500);
    }
    if (!environment) {
      report.failures.push(
        exited ? `upgraded: the server exited (${JSON.stringify(exited)}) on the seeded home (log ${NodePath.join(out, "server.log")})`
          : `upgraded: the server did not answer within ${options.timeoutMs} ms`,
      );
      return report;
    }
    report.serverVersion = environment.serverVersion;
    if (environment.serverVersion !== options.version)
      report.failures.push(`upgraded: /.well-known/studio/environment reports ${environment.serverVersion}, expected ${options.version}`);
    if (meta.environmentId && environment.environmentId !== meta.environmentId)
      report.failures.push("upgraded: the environment id changed after the update");
    const check = await python(["--against", before, "--output", NodePath.join(out, "post-update-check.json")], "post-update-check.log");
    const checkFailure = stepFailure("upgraded: the post-update check (update.py verify --local)", check, options.timeoutMs);
    if (checkFailure) report.failures.push(checkFailure);
    if (options.proofs) {
      const wrapper = writeCliWrapper(out, executable, entry);
      const step = await runStep(
        process.execPath,
        [scripts.installedStartup, "--local", "--origin", origin, "--cli-wrapper", wrapper, "--base-dir", base,
          "--expected", before, "--report-dir", NodePath.join(out, "installed-startup")],
        { timeoutMs: options.proofTimeoutMs, log: NodePath.join(out, "installed-startup.log"), env: proofEnv(scratch, base) },
      );
      const failed = stepFailure("upgraded: test-installed-startup.mjs --local", step, options.proofTimeoutMs);
      if (failed) report.failures.push(failed);
    }
    report.proofs = options.proofs ? "ran" : "left out (--no-proofs)";
    return report;
  } catch (error) {
    report.failures.push(`upgraded: ${errorText(error)}`);
    return report;
  } finally {
    if (server && !(await stopTree(server))) report.failures.push("upgraded: the server did not stop");
    if (server) LIVE.delete(server);
    report.result = report.failures.length === 0 ? "passed" : "failed";
    endScratch(scratch, options, report);
  }
}

export async function main(argv, { scripts = DEFAULT_SCRIPTS, log = console.log } = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`verify-built-app: ${error.message}`);
    return 2;
  }
  process.env.PWDEBUG = "0";
  process.env.PLAYWRIGHT_HTML_OPEN = "never";
  keepTemp = options.keep;
  NodeFS.mkdirSync(options.out, { recursive: true });
  const receipt = {
    schemaVersion: 1,
    version: options.version,
    target: options.archive ?? options.app,
    mode: options.mode,
    startedAt: new Date().toISOString(),
    headless: true,
    modes: {},
    failures: [],
  };
  const write = () =>
    NodeFS.writeFileSync(NodePath.join(options.out, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  let resolved = null;
  try {
    resolved = resolveExecutable(options.archive ?? options.app, { archive: Boolean(options.archive) });
    receipt.executable = resolved.executable;
    for (const mode of options.mode === "all" ? ["fresh", "upgraded"] : [options.mode]) {
      log(`verify-built-app: ${mode} ...`);
      const report = mode === "fresh"
        ? await verifyFresh(options, resolved.executable, scripts)
        : await verifyUpgraded(options, resolved.executable, scripts);
      receipt.modes[mode] = report;
      receipt.failures.push(...report.failures);
      log(`verify-built-app: ${mode} ${report.result}`);
      write();
    }
  } catch (error) {
    receipt.failures.push(errorText(error));
  } finally {
    if (resolved?.cleanup) removeTemp(resolved.cleanup);
  }
  const wanted = options.mode === "all" ? ["fresh", "upgraded"] : [options.mode];
  for (const mode of wanted)
    if (receipt.modes[mode] === undefined) receipt.failures.push(`${mode}: did not run`);
  receipt.result = receipt.failures.length === 0 ? "passed" : "failed";
  receipt.finishedAt = new Date().toISOString();
  write();
  for (const failure of receipt.failures) console.error(`verify-built-app: ${failure}`);
  log(`verify-built-app: ${receipt.result} (${NodePath.join(options.out, "receipt.json")})`);
  return receipt.result === "passed" ? 0 : 1;
}

if (process.argv[1] && NodeURL.pathToFileURL(NodePath.resolve(process.argv[1])).href === import.meta.url) {
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => interrupted(sig));
  process.exitCode = await main(process.argv.slice(2));
}
