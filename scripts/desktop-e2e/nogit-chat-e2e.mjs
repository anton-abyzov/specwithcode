#!/usr/bin/env node
// Installed-app check that a fresh install on a machine WITHOUT Git can start a
// chat. Starts the server bundled in the installed app the way
// installed-e2e.mjs does (installed executable as Node, ELECTRON_RUN_AS_NODE=1,
// throwaway HOME and base dir, free loopback port), pairs a headless Chromium
// through the bundled CLI, then proves:
//   1. git resolves neither on the server's PATH nor in a login shell (the
//      server merges a login shell's PATH at startup);
//   2. server.getConfig on the fresh base dir offers scratchWorkspaceRoot (the
//      "No project" folder for chats);
//   3. the Chats heading plus and the top "New chat" row each open a /draft/
//      route with the composer and no "Could not start a chat" toast.
//
// Hiding Git is the caller's job (the Linux CI job moves /usr/bin/git away);
// this script only observes. Every check runs; any failure fails the run.
//
// Usage:
//   node scripts/desktop-e2e/nogit-chat-e2e.mjs --app <installed executable> --out <dir>
//     [--keep-scratch] [--timeout-ms 180000]
//
// Needs playwright-core (resolved from apps/server/node_modules) and its
// Chromium headless shell:
//   node apps/server/node_modules/playwright-core/cli.js install --only-shell chromium
//
// Only the processes this script starts are stopped; port 8319 is never used.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";

const SCRIPT_DIR = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const REPO_ROOT = NodePath.resolve(SCRIPT_DIR, "../..");
// oxlint-disable-next-line studio/no-global-process-runtime -- Standalone CI check has no Effect runtime.
const PLATFORM = NodeOS.platform();
// oxlint-disable-next-line studio/no-global-process-runtime -- Standalone CI check has no Effect runtime.
const ARCH = NodeOS.arch();
const RESERVED_PORT = 8319;
const TOAST_TEXT = "Could not start a chat";
const CHATS = '[aria-labelledby="sws-side-chats"]';
const PLUS = `${CHATS} .sws-side-heading button[aria-label="New chat"]`;
const COMPOSER = '[data-testid="composer-editor"]';

// ---------------------------------------------------------------- arguments
const argv = process.argv.slice(2);
const option = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith("--")
    ? argv[index + 1]
    : undefined;
};
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(
    "Usage: node scripts/desktop-e2e/nogit-chat-e2e.mjs --app <executable> --out <dir> [--keep-scratch] [--timeout-ms N]",
  );
  process.exit(0);
}
const APP = option("--app") ? NodePath.resolve(option("--app")) : undefined;
const OUT = option("--out") ? NodePath.resolve(option("--out")) : undefined;
const KEEP_SCRATCH = argv.includes("--keep-scratch");
const TIMEOUT_MS = Number(option("--timeout-ms") ?? 180_000);
if (!APP || !OUT) {
  console.error("nogit-chat-e2e: --app <installed executable> and --out <dir> are required.");
  process.exit(2);
}
if (PLATFORM === "win32") {
  console.error("nogit-chat-e2e: POSIX only (Linux CI; macOS for local trials).");
  process.exit(2);
}
if (!NodeFS.existsSync(APP)) {
  console.error(`nogit-chat-e2e: the app executable does not exist: ${APP}`);
  process.exit(2);
}
NodeFS.mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------- scratch isolation
const REAL_DATA_DIRS = [".specwithcode", ".specweave-studio"].map((name) =>
  NodePath.resolve(NodeOS.homedir(), name),
);
const insideRealData = (candidate) => {
  const resolved = NodePath.resolve(candidate);
  return REAL_DATA_DIRS.some((dir) => resolved === dir || resolved.startsWith(dir + NodePath.sep));
};
if (insideRealData(OUT)) {
  console.error(`nogit-chat-e2e: refusing to write into real SpecWithCode data: ${OUT}`);
  process.exit(2);
}
const SCRATCH = NodeFS.realpathSync(
  NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-nogit-")),
);
if (insideRealData(SCRATCH)) throw new Error(`Scratch directory is inside real data: ${SCRATCH}`);
const HOME = NodePath.join(SCRATCH, "home");
const BASE_DIR = NodePath.join(SCRATCH, "base");
for (const dir of [HOME, BASE_DIR]) NodeFS.mkdirSync(dir, { recursive: true });

const SERVER_LOG = NodePath.join(OUT, "server.log");
for (const file of [SERVER_LOG, NodePath.join(OUT, "results.json")])
  NodeFS.rmSync(file, { force: true });
for (const file of NodeFS.readdirSync(OUT))
  if (/^\d\d-.*\.png$/u.test(file)) NodeFS.rmSync(NodePath.join(OUT, file));

// ---------------------------------------------------------------- results
const log = (...parts) => console.log(`[nogit-chat-e2e ${new Date().toISOString()}]`, ...parts);
const results = {
  app: APP,
  platform: PLATFORM,
  arch: ARCH,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  ok: false,
  scratch: SCRATCH,
  baseDir: BASE_DIR,
  home: HOME,
  port: null,
  serverPid: null,
  headless: true,
  checks: [],
  consoleErrors: [],
  cleanup: [],
};
const record = (name, pass, observed = {}) => {
  results.checks.push({ name, status: pass ? "pass" : "fail", ...observed });
  log(pass ? "PASS" : "FAIL", name, pass ? "" : JSON.stringify(observed).slice(0, 600));
  return pass;
};
const writeResults = () =>
  NodeFS.writeFileSync(NodePath.join(OUT, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
const errorText = (error) =>
  (error instanceof Error ? error.message : String(error)).split("\n")[0];

// ---------------------------------------------------------------- environment
// The same allowlist and system-only PATH as installed-e2e.mjs, which on a
// stock machine includes /usr/bin and so git; the caller removes git from it.
const childEnv = Object.fromEntries(
  ["TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME"]
    .filter((name) => process.env[name] !== undefined)
    .map((name) => [name, process.env[name]]),
);
Object.assign(childEnv, {
  HOME,
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  XDG_CONFIG_HOME: NodePath.join(HOME, ".config"),
  XDG_DATA_HOME: NodePath.join(HOME, ".local", "share"),
  XDG_STATE_HOME: NodePath.join(HOME, ".local", "state"),
  XDG_CACHE_HOME: NodePath.join(HOME, ".cache"),
  ELECTRON_RUN_AS_NODE: "1",
  STUDIO_HOME: BASE_DIR,
  STUDIO_DESKTOP_TEST_OFFSCREEN: "1",
  STUDIO_NO_BROWSER: "true",
});
childEnv.LANG ??= "en_US.UTF-8";

// ---------------------------------------------------------------- process tracking
let serverProcess = null;
let serverExit = null;

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const killTree = async (pid, label) => {
  if (!pid || !alive(pid)) return;
  // The server leads its own process group (detached spawn).
  const signal = (sig) => {
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        process.kill(pid, sig);
      } catch {}
    }
  };
  signal("SIGTERM");
  for (let i = 0; i < 60 && alive(pid); i++) await sleep(250);
  if (alive(pid)) signal("SIGKILL");
  for (let i = 0; i < 20 && alive(pid); i++) await sleep(250);
  results.cleanup.push({ pid, label, stopped: !alive(pid) });
};

let cleanedUp = false;
const cleanup = async () => {
  if (cleanedUp) return;
  cleanedUp = true;
  if (serverProcess && serverExit === null) await killTree(serverProcess.pid, "server");
  if (!KEEP_SCRATCH) {
    try {
      NodeFS.rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch (error) {
      results.cleanup.push({ scratch: SCRATCH, removed: false, reason: errorText(error) });
    }
  }
};
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    results.checks.push({ name: "interrupted", status: "fail", signal: sig });
    cleanup().finally(() => {
      results.finishedAt = new Date().toISOString();
      writeResults();
      process.exit(130);
    });
  });
}

// ---------------------------------------------------------------- helpers
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

const run = (command, args, { timeout = TIMEOUT_MS } = {}) => {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd: HOME,
    env: childEnv,
    encoding: "utf8",
    timeout,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    errorCode: result.error?.code ?? null,
    error: result.error ? errorText(result.error) : null,
  };
};
const runApp = (args, options) => run(APP, args, options);

const resolveServerEntry = () => {
  const resources =
    PLATFORM === "darwin"
      ? NodePath.resolve(NodePath.dirname(APP), "..", "Resources")
      : NodePath.join(NodePath.dirname(APP), "resources");
  const roots = ["server.asar", "app.asar", "app"].map((name) => NodePath.join(resources, name));
  const candidates = roots
    .filter((root) => NodeFS.existsSync(root))
    .map((root) => NodePath.join(root, "apps", "server", "dist", "bin.mjs"));
  // Plain Node cannot see inside an asar; ask the installed runtime.
  const probe = runApp(
    [
      "-e",
      "const fs=require('fs');process.stdout.write(JSON.stringify(process.argv.slice(1).map(p=>fs.existsSync(p))))",
      ...candidates,
    ],
    { timeout: 60_000 },
  );
  let found = [];
  try {
    found = JSON.parse(probe.stdout.trim() || "[]");
  } catch {}
  const entry = candidates.find((_, index) => found[index] === true) ?? null;
  return { resources, candidates, entry, probe };
};

const waitFor = async (what, fn, { timeout = TIMEOUT_MS, interval = 1000 } = {}) => {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    if (serverExit !== null)
      throw new Error(`server exited (${JSON.stringify(serverExit)}) while waiting for ${what}`);
    await sleep(interval);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${errorText(last)}` : ""}`);
};

const loadPlaywright = () =>
  NodeModule.createRequire(NodePath.join(REPO_ROOT, "apps", "server", "package.json"))(
    "playwright-core",
  );

// Shells the server tries for its login-shell PATH (listLoginShellCandidates in
// packages/shared/src/shell.ts): $SHELL, the account's shell, then the default.
const loginShells = () => {
  let accountShell;
  try {
    accountShell = NodeOS.userInfo().shell?.trim() || undefined;
  } catch {}
  const fallback = PLATFORM === "darwin" ? "/bin/zsh" : "/bin/bash";
  return [...new Set([childEnv.SHELL, accountShell, fallback].filter(Boolean))].filter((shell) =>
    NodeFS.existsSync(shell),
  );
};

// ---------------------------------------------------------------- run
let browser = null;
const main = async () => {
  // 1. Git is not resolvable for the server: its PATH, a direct spawn, and
  //    every login shell it would merge a PATH from (`<shell> -ilc`).
  const pathProbe = run("/bin/sh", ["-c", "command -v git"], { timeout: 10_000 });
  const spawnProbe = run("git", ["--version"], { timeout: 10_000 });
  const shells = loginShells().map((shell) => {
    const probe = run(
      shell,
      ["-ilc", 'printf "PATH=%s\\n" "$PATH"; command -v git || echo "git: not found"'],
      { timeout: 15_000 },
    );
    const lines = probe.stdout.trim().split("\n");
    const pathLine = lines.find((line) => line.startsWith("PATH=")) ?? "";
    return {
      shell,
      status: probe.status,
      path: pathLine.slice(5),
      commandVGit: lines.at(-1) ?? "",
      gitFound: !probe.stdout.includes("git: not found"),
    };
  });
  record(
    "git-not-resolvable",
    // `command -v` exits 1 (or 127) when nothing is found, and only ENOENT
    // proves the spawn failed for want of a binary, not a timeout or signal.
    (pathProbe.status === 1 || pathProbe.status === 127) &&
      spawnProbe.errorCode === "ENOENT" &&
      shells.length > 0 &&
      shells.every((shell) => !shell.gitFound),
    {
      childPath: childEnv.PATH,
      commandVGit: { exitCode: pathProbe.status, stdout: pathProbe.stdout.trim() },
      gitVersionSpawn: {
        exitCode: spawnProbe.status,
        error: spawnProbe.error,
        stdout: spawnProbe.stdout.trim(),
      },
      loginShells: shells,
    },
  );

  // 2. Locate and start the bundled server on the fresh base dir.
  const located = resolveServerEntry();
  const versionProbe = located.entry
    ? runApp([located.entry, "--version"], { timeout: 60_000 })
    : null;
  const bundledVersion =
    versionProbe?.stdout.trim().split(/\s+/u).pop()?.replace(/^v/u, "") ?? null;
  if (
    !record("bundled-server-entry", located.entry !== null && versionProbe?.status === 0, {
      resources: located.resources,
      entry: located.entry,
      version: bundledVersion,
      probeError: located.entry
        ? undefined
        : located.probe.stderr.slice(0, 600) || located.probe.error,
    })
  )
    return;

  const freshBaseDir = NodeFS.readdirSync(BASE_DIR);
  let port = await freePort();
  while (port === RESERVED_PORT) port = await freePort();
  results.port = port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const serverLog = NodeFS.openSync(SERVER_LOG, "a");
  serverProcess = NodeChildProcess.spawn(
    APP,
    [located.entry, "serve", "--host", "127.0.0.1", "--port", String(port), "--base-dir", BASE_DIR],
    { cwd: HOME, env: childEnv, stdio: ["ignore", serverLog, serverLog], detached: true },
  );
  results.serverPid = serverProcess.pid;
  serverProcess.on("exit", (code, signal) => (serverExit = { code, signal }));
  log("server PID", serverProcess.pid, "port", port);

  let environment;
  try {
    environment = await waitFor("server readiness", async () => {
      const response = await fetch(`${baseUrl}/.well-known/studio/environment`, {
        signal: AbortSignal.timeout(5000),
      });
      return response.ok ? response.json() : null;
    });
  } catch (error) {
    record("server-start", false, { reason: errorText(error), log: SERVER_LOG });
    return;
  }
  record("server-start", environment.serverVersion === bundledVersion, {
    pid: serverProcess.pid,
    url: baseUrl,
    serverVersion: environment.serverVersion,
    bundledVersion,
    baseDirEntriesBeforeStart: freshBaseDir,
  });

  // 3. Pairing link from the bundled CLI, opened in headless Chromium.
  const pairing = runApp([
    located.entry,
    "auth",
    "pairing",
    "create",
    "--base-dir",
    BASE_DIR,
    "--ttl",
    "30m",
    "--label",
    "nogit-e2e",
    "--base-url",
    baseUrl,
    "--json",
  ]);
  let pairUrl = null;
  try {
    const text = pairing.stdout;
    pairUrl = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)).pairUrl ?? null;
  } catch {}
  if (
    !record(
      "pairing-link",
      pairing.status === 0 && typeof pairUrl === "string" && pairUrl.startsWith(baseUrl),
      {
        exitCode: pairing.status,
        stderr: pairing.status === 0 ? undefined : pairing.stderr.slice(0, 600),
      },
    )
  )
    return;

  const { chromium } = loadPlaywright();
  browser = await chromium.launch({ headless: true, timeout: TIMEOUT_MS });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  page.on("console", (message) => {
    if (message.type() === "error") results.consoleErrors.push(message.text().slice(0, 400));
  });
  page.on("pageerror", (error) =>
    results.consoleErrors.push(`pageerror: ${error.message.slice(0, 400)}`),
  );
  const shot = async (name) => {
    const file = NodePath.join(OUT, `${name}.png`);
    await page.screenshot({ path: file, animations: "disabled" }).catch(() => {});
    return NodeFS.existsSync(file) ? file : null;
  };

  // Effect RPC over the page's cookie-authenticated /ws, as the web app calls it.
  const rpcOne = async (tag, payload, waitMs = 30_000) => {
    const exit = await page.evaluate(
      async ({ tag, payload, waitMs, appVersion }) => {
        const ws = new WebSocket(
          `${location.origin.replace("http", "ws")}/ws?clientSurface=web&clientAppVersion=${encodeURIComponent(appVersion)}&clientDeviceType=desktop&connectionMethod=direct&orchestrationProtocol=2`,
        );
        await new Promise((resolve, reject) => {
          ws.addEventListener("open", resolve, { once: true });
          ws.addEventListener("error", () => reject(new Error("websocket error")), { once: true });
        });
        const out = {};
        ws.addEventListener("message", (event) => {
          const message = JSON.parse(String(event.data));
          if (message._tag === "Exit" && String(message.requestId) === "1") out.exit = message.exit;
          else if (message._tag === "Ping") ws.send(JSON.stringify({ _tag: "Pong" }));
        });
        ws.send(JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] }));
        const start = Date.now();
        while (!out.exit && Date.now() - start < waitMs)
          await new Promise((resolve) => setTimeout(resolve, 200));
        ws.close();
        return out.exit ?? { _tag: "Timeout" };
      },
      { tag, payload, waitMs, appVersion: environment.serverVersion },
    );
    if (exit?._tag !== "Success") throw new Error(`${tag}: ${JSON.stringify(exit).slice(0, 600)}`);
    return exit.value;
  };

  const nav = page.getByRole("navigation", { name: "Projects and chats" });
  const wizardSteps = [];
  // First-run wizard, as in installed-e2e.mjs: choose this machine as the main
  // one, then skip the agent and project-import steps.
  const finishWizard = async () => {
    const wizard = page.getByRole("dialog").filter({ hasText: "SpecWithCode" }).first();
    const wizardButtons = [
      /up as my main machine/u,
      /^Do not import projects$/u,
      /^Skip/u,
      /^Continue$/u,
      /^(Finish|Done|Get started|Close)$/u,
    ];
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await wizard.isVisible().catch(() => false)) {
        let clicked = null;
        for (const name of wizardButtons) {
          const button = wizard.getByRole("button", { name }).last();
          if (
            (await button.isVisible().catch(() => false)) &&
            (await button.isEnabled().catch(() => false))
          ) {
            clicked = (await button.innerText().catch(() => String(name))).trim().split("\n")[0];
            await button.click();
            break;
          }
        }
        if (clicked) wizardSteps.push(clicked);
        if (wizardSteps.length > 12) throw new Error("the first-run wizard did not finish");
      } else if (await nav.isVisible().catch(() => false)) {
        return;
      }
      await page.waitForTimeout(1000);
    }
    throw new Error("the sidebar navigation 'Projects and chats' never became visible");
  };
  try {
    await page.goto(pairUrl, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
    await finishWizard();
    record("pairing-authenticated-ui", true, {
      url: new URL(page.url()).pathname,
      wizardSteps,
      screenshot: await shot("01-paired"),
    });
  } catch (error) {
    record("pairing-authenticated-ui", false, {
      reason: errorText(error),
      wizardSteps,
      screenshot: await shot("01-paired-FAILED"),
    });
    return;
  }

  // 4. The fresh server offers the Scratch ("No project") folder.
  try {
    const config = await rpcOne("server.getConfig", {});
    const root = config.scratchWorkspaceRoot ?? null;
    record("scratch-workspace-root", typeof root === "string" && root.length > 0, {
      scratchWorkspaceRoot: root,
      insideBaseDir: typeof root === "string" && root.startsWith(BASE_DIR + NodePath.sep),
    });
  } catch (error) {
    record("scratch-workspace-root", false, { reason: errorText(error) });
  }

  // 5. Both New chat controls open a draft with the composer.
  const home = async () => {
    await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
    await finishWizard();
    await page.locator(`${CHATS} .sws-side-heading`).waitFor({ state: "visible" });
    // Let the sidebar settle on the server's config before clicking.
    await page.waitForTimeout(1500);
  };
  const attempt = async (name, screenshotName, locate) => {
    try {
      await home();
      const control = locate();
      const count = await control.count();
      if (count === 0) {
        record(name, false, {
          reason: "control not found",
          screenshot: await shot(`${screenshotName}-FAILED`),
        });
        return;
      }
      const before = new URL(page.url()).pathname;
      await control.first().click();
      const draftOpened = await page
        .waitForURL(/\/draft\//u, { timeout: 15_000 })
        .then(() => true)
        .catch(() => false);
      const composerVisible = await page
        .locator(COMPOSER)
        .first()
        .waitFor({ state: "visible", timeout: 15_000 })
        .then(() => true)
        .catch(() => false);
      await page.waitForTimeout(800);
      const toast = (await page.getByText(TOAST_TEXT).count()) > 0;
      // A draft open before the click would satisfy waitForURL on its own.
      const pass = !/\/draft\//u.test(before) && draftOpened && composerVisible && !toast;
      record(name, pass, {
        controls: count,
        before,
        after: new URL(page.url()).pathname,
        draftOpened,
        composerVisible,
        couldNotStartToast: toast,
        screenshot: await shot(pass ? screenshotName : `${screenshotName}-FAILED`),
      });
    } catch (error) {
      record(name, false, {
        reason: errorText(error),
        screenshot: await shot(`${screenshotName}-FAILED`),
      });
    }
  };
  await attempt("chats-heading-plus", "02-chats-plus-draft", () => page.locator(PLUS));
  await attempt("top-new-chat-row", "03-top-row-draft", () =>
    page.locator(".sws-side-actions button.sws-side-row", { hasText: "New chat" }),
  );
};

let exitCode = 1;
try {
  await main();
} catch (error) {
  record("harness", false, {
    reason: errorText(error),
    stack: error?.stack?.split("\n").slice(0, 6),
  });
} finally {
  await browser?.close().catch(() => {});
  await cleanup();
  results.ok =
    results.checks.length > 0 && results.checks.every((check) => check.status === "pass");
  results.finishedAt = new Date().toISOString();
  writeResults();
  exitCode = results.ok ? 0 : 1;
  log(results.ok ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED", NodePath.join(OUT, "results.json"));
}
process.exit(exitCode);
