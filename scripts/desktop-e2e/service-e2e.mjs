#!/usr/bin/env node
// Real-OS check of the background behaviour of an INSTALLED SpecWithCode app
// on Windows or Linux:
//
// 1. Tray: the installed app, owning the backend it started, keeps running
//    with that backend after its last window closes, and Quit stops both.
// 2. Service: `service install`, run by the CLI bundled in the installed app
//    (the installed executable with ELECTRON_RUN_AS_NODE=1), registers the
//    Windows scheduled task or the systemd user unit, and the service serves.
//    The runtime it pins is the CLI archive built in the same run, served from
//    a loopback mirror through STUDIO_RELEASE_BASE_URL, so nothing published
//    is downloaded.
// 3. The installed app attaches to that running service instead of starting
//    a second backend, and quits on window close while the service runs on.
// 4. `service uninstall` removes the task or unit and stops the service.
//
// Usage:
//   node scripts/desktop-e2e/service-e2e.mjs --app <installed executable> \
//     --archive <studio-X.Y.Z-win32-x64.zip|studio-X.Y.Z-linux-x64.tar.gz> --out <dir>
//   (Linux: under xvfb-run, with a systemd user manager for this user.)
//
// It installs a real per-user service, so it runs only on CI (CI=true) or with
// --allow-machine-service. Results go to <out>/results.json.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
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
const IS_WIN = PLATFORM === "win32";
const TASK_NAME_PREFIX = "SpecWithCode Service";
const UNIT_NAME = "studio.service";

const argv = process.argv.slice(2);
const option = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith("--")
    ? argv[index + 1]
    : undefined;
};
const APP = option("--app") ? NodePath.resolve(option("--app")) : undefined;
const ARCHIVE = option("--archive") ? NodePath.resolve(option("--archive")) : undefined;
const OUT = option("--out") ? NodePath.resolve(option("--out")) : undefined;
const TIMEOUT_MS = Number(option("--timeout-ms") ?? 180_000);
if (!APP || !ARCHIVE || !OUT) {
  console.error("service-e2e: --app, --archive and --out are required.");
  process.exit(2);
}
if (PLATFORM !== "win32" && PLATFORM !== "linux") {
  console.error("service-e2e: Windows and Linux only.");
  process.exit(2);
}
if (process.env.CI !== "true" && !argv.includes("--allow-machine-service")) {
  console.error(
    "service-e2e: installs a real per-user service; runs only with CI=true or --allow-machine-service.",
  );
  process.exit(2);
}
for (const file of [APP, ARCHIVE]) {
  if (!NodeFS.existsSync(file)) {
    console.error(`service-e2e: ${file} does not exist.`);
    process.exit(2);
  }
}
NodeFS.mkdirSync(OUT, { recursive: true });
// Playwright captures child output before launch resolves, including early splash
// windows. Its driver log complements the later direct stdout/stderr listeners.
const DRIVER_LOG = NodePath.join(OUT, "electron-driver.log");
process.env.DEBUG = "pw:browser";
process.env.DEBUG_FILE = DRIVER_LOG;

const SCRATCH = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-svc-")));
const SERVICE_HOME = NodePath.join(SCRATCH, "service-home");
NodeFS.mkdirSync(SERVICE_HOME, { recursive: true });

const log = (...parts) => console.log(`[service-e2e ${new Date().toISOString()}]`, ...parts);
const results = {
  app: APP,
  archive: ARCHIVE,
  platform: PLATFORM,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  ok: false,
  serviceHome: SERVICE_HOME,
  offscreenRequested: true,
  driverLog: DRIVER_LOG,
  checks: [],
};
const record = (name, pass, observed = {}) => {
  results.checks.push({ name, status: pass ? "pass" : "fail", ...observed });
  log(pass ? "PASS" : "FAIL", name, pass ? "" : JSON.stringify(observed).slice(0, 800));
  return pass;
};
const errorText = (error) =>
  (error instanceof Error ? error.message : String(error)).split("\n")[0];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
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
    await sleep(interval);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${errorText(last)}` : ""}`);
};
const fetchEnvironment = async (origin) => {
  const response = await fetch(`${origin}/.well-known/studio/environment`, {
    signal: AbortSignal.timeout(5000),
  });
  return response.ok ? response.json() : null;
};
const answers = (origin) => fetchEnvironment(origin).then(Boolean, () => false);

// ---------------------------------------------------------------- environment
// The user's real profile (HOME, USERPROFILE, LOCALAPPDATA), because the task
// and the unit belong to it, minus anything that would redirect SpecWithCode.
const baseEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => !/^(STUDIO_|ELECTRON_|VITE_|NODE_OPTIONS$|PLAYWRIGHT_|PW|DEBUG$|DEBUG_FILE$)/u.test(name),
  ),
);
if (!IS_WIN) {
  // The CLI must find the user bus itself (systemdUserBus), as it does when a
  // launcher started it from `env -i`.
  delete baseEnv.XDG_RUNTIME_DIR;
  delete baseEnv.DBUS_SESSION_BUS_ADDRESS;
}
const cliEnv = (extra = {}) => ({
  ...baseEnv,
  ELECTRON_RUN_AS_NODE: "1",
  STUDIO_HOME: SERVICE_HOME,
  STUDIO_NO_BROWSER: "true",
  ...extra,
});
const run = (command, args, { env = baseEnv, timeout = TIMEOUT_MS } = {}) => {
  const result = NodeChildProcess.spawnSync(command, args, {
    env,
    encoding: "utf8",
    timeout,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ? errorText(result.error) : null,
  };
};
// Installation downloads from the mirror served by this process. A synchronous
// child would block its HTTP handlers until the CLI's download timed out.
const runAsync = (command, args, { env = baseEnv, timeout = TIMEOUT_MS } = {}) =>
  new Promise((resolve) => {
    NodeChildProcess.execFile(
      command,
      args,
      { env, encoding: "utf8", timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) =>
        resolve({
          status: error ? (typeof error.code === "number" ? error.code : null) : 0,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          error: error ? errorText(error) : null,
        }),
    );
  });
// systemctl from this script (not the CLI) talks to the user manager directly.
const userBusEnv = () => {
  const uid = process.getuid?.();
  const runtime = process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`;
  return {
    ...baseEnv,
    XDG_RUNTIME_DIR: runtime,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus`,
  };
};
const powershell = (script) =>
  run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 60_000 });
const taskName = () =>
  process.env.USERNAME ? `${TASK_NAME_PREFIX} - ${process.env.USERNAME}` : TASK_NAME_PREFIX;

const resolveServerEntry = () => {
  const resources = NodePath.join(NodePath.dirname(APP), "resources");
  const candidates = ["server.asar", "app.asar", "app"]
    .map((name) => NodePath.join(resources, name))
    .filter((root) => NodeFS.existsSync(root))
    .map((root) => NodePath.join(root, "apps", "server", "dist", "bin.mjs"));
  // Plain Node cannot see inside an asar; ask the installed runtime.
  const probe = run(
    APP,
    [
      "-e",
      "const fs=require('fs');process.stdout.write(JSON.stringify(process.argv.slice(1).map(p=>fs.existsSync(p))))",
      ...candidates,
    ],
    { env: cliEnv(), timeout: 60_000 },
  );
  let found = [];
  try {
    found = JSON.parse(probe.stdout.trim() || "[]");
  } catch {}
  return candidates.find((_, index) => found[index] === true) ?? null;
};

const findRuntimeState = (root) => {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = NodeFS.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = NodePath.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== "runtime") stack.push(full);
      else if (entry.name === "server-runtime.json") {
        try {
          return { file: full, ...JSON.parse(NodeFS.readFileSync(full, "utf8")) };
        } catch {}
      }
    }
  }
  return null;
};

const loadElectron = () =>
  NodeModule.createRequire(NodePath.join(REPO_ROOT, "apps", "server", "package.json"))(
    "playwright-core",
  )._electron;

// The installed app as a user starts it: a fresh profile, no ELECTRON_RUN_AS_NODE.
const launchApp = async (label, studioHome) => {
  const home = NodePath.join(SCRATCH, `${label}-profile`);
  NodeFS.mkdirSync(home, { recursive: true });
  const env = {
    ...baseEnv,
    HOME: home,
    USERPROFILE: home,
    APPDATA: NodePath.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: NodePath.join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: NodePath.join(home, ".config"),
    XDG_DATA_HOME: NodePath.join(home, ".local", "share"),
    STUDIO_HOME: studioHome,
    STUDIO_DESKTOP_TEST_OFFSCREEN: "1",
    ELECTRON_ENABLE_LOGGING: "1",
    PWDEBUG: "0",
    PLAYWRIGHT_HTML_OPEN: "never",
    // Linux safeStorage would reach a keyring over the session bus.
    ...(IS_WIN ? {} : { DBUS_SESSION_BUS_ADDRESS: "disabled:" }),
  };
  const app = await loadElectron().launch({
    executablePath: APP,
    args: !IS_WIN && process.getuid?.() === 0 ? ["--no-sandbox"] : [],
    env,
    timeout: TIMEOUT_MS,
  });
  const logFile = NodePath.join(OUT, `${label}-app.log`);
  let output = "";
  const capture = (chunk) => {
    output += chunk.toString();
    NodeFS.appendFileSync(logFile, chunk);
  };
  app.process().stdout?.on("data", capture);
  app.process().stderr?.on("data", capture);
  const pid = app.process().pid;
  let exited = false;
  let exitStatus = null;
  app.process().once("exit", (code, signal) => {
    exited = true;
    exitStatus = { code, signal };
  });
  const opened = {
    app,
    pid,
    origin: null,
    ownsBundledService: null,
    output: () => output,
    exited: () => exited || !alive(pid),
    exitStatus: () => exitStatus,
  };
  // Track immediately: a readiness failure must not leak an app or its backend.
  openApps.push(opened);
  const { window, origin, ownsBundledService } = await waitFor(
    `${label} window on a loopback backend`,
    async () => {
      // Packaged windows use studio://app, not the backend's HTTP origin.
      // firstWindow can also be a splash; inspect the loaded renderer's bridge.
      for (const window of app.windows()) {
        if (window.isClosed() || !URL.canParse(window.url())) continue;
        const url = new URL(window.url());
        if (url.protocol !== "studio:" || url.hostname !== "app") continue;
        const bootstrap = await window.evaluate(async () => {
          const bridge = globalThis.desktopBridge;
          if (!bridge) return null;
          return {
            environments: bridge.getLocalEnvironmentBootstraps(),
            ownsBundledService: await bridge.ownsBundledService(),
          };
        });
        for (const environment of bootstrap?.environments ?? []) {
          if (environment.id !== "primary") continue;
          if (!URL.canParse(environment.httpBaseUrl)) continue;
          const backend = new URL(environment.httpBaseUrl);
          if (
            ["http:", "https:"].includes(backend.protocol) &&
            ["127.0.0.1", "localhost", "[::1]"].includes(backend.hostname) &&
            (await answers(backend.origin))
          ) {
            return {
              window,
              origin: backend.origin,
              ownsBundledService: bootstrap.ownsBundledService,
            };
          }
        }
      }
      return null;
    },
    { interval: 1000 },
  );
  opened.origin = origin;
  opened.ownsBundledService = ownsBundledService;
  await assertOffscreen(opened, `${label}-ready`);
  await window.screenshot({ path: NodePath.join(OUT, `${label}.png`) }).catch(() => {});
  await app.evaluate(({ app }) => app.emit("activate"));
  await assertOffscreen(opened, `${label}-activated`);
  return opened;
};

const offscreenLogs = () => {
  const text = NodeFS.existsSync(DRIVER_LOG) ? NodeFS.readFileSync(DRIVER_LOG, "utf8") : "";
  const windows = [];
  for (const line of text.split("\n")) {
    const match = /\[desktop-test-offscreen\] (\{.*\})/u.exec(line);
    if (match) windows.push(JSON.parse(match[1]));
  }
  return { windows, failed: text.includes("[desktop-test-offscreen] failure:") };
};
const hiddenOffscreen = (window) =>
  window.offscreen === true && window.visible === false && window.focused === false;
const assertOffscreen = async (opened, phase, { allowEmpty = false } = {}) => {
  if (opened.exited()) throw new Error(`${phase}: app exited unexpectedly`);
  const windows = await opened.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .filter((window) => !window.isDestroyed())
      .map((window) => ({
        id: window.id,
        offscreen: window.webContents.isOffscreen(),
        visible: window.isVisible(),
        focused: window.isFocused(),
      })),
  );
  const guard = offscreenLogs();
  const valid =
    (allowEmpty || windows.length > 0) &&
    windows.every(hiddenOffscreen) &&
    guard.windows.length > 0 &&
    guard.windows.every(hiddenOffscreen) &&
    !guard.failed;
  if (!record(`offscreen-${phase}`, valid, {
    windows,
    createdWindowReceipts: guard.windows,
    driverLog: DRIVER_LOG,
  })) {
    throw new Error(`${phase}: offscreen window assertions failed`);
  }
};
const closeAllWindows = async (opened, phase) => {
  const state = await opened.app.evaluate(({ BrowserWindow }) => {
    const before = BrowserWindow.getAllWindows();
    for (const window of before) window.close();
    return {
      closedCount: before.length,
      remaining: BrowserWindow.getAllWindows()
        .filter((window) => !window.isDestroyed())
        .map((window) => ({
          id: window.id,
          offscreen: window.webContents.isOffscreen(),
          visible: window.isVisible(),
          focused: window.isFocused(),
        })),
    };
  });
  if (!record(
    `offscreen-${phase}`,
    state.closedCount > 0 && state.remaining.every(hiddenOffscreen) && !offscreenLogs().failed,
    state,
  )) {
    throw new Error(`${phase}: offscreen close assertions failed`);
  }
};

// ---------------------------------------------------------------- mirror
const startMirror = async (version, archiveName) => {
  const bytes = NodeFS.readFileSync(ARCHIVE);
  const digest = (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");
  const files = new Map([
    [`/v${version}/SHA256SUMS`, Buffer.from(`${digest}  ${archiveName}\n`)],
    [`/v${version}/${archiveName}`, bytes],
  ]);
  const hits = [];
  const server = NodeHttp.createServer((request, response) => {
    hits.push(request.url);
    const body = files.get(request.url ?? "");
    if (!body) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-length": body.length }).end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, hits, url: `http://127.0.0.1:${server.address().port}` };
};

// ---------------------------------------------------------------- registration
const registrationHome = (definition) => {
  if (typeof definition !== "string") return null;
  const taskHome = /^set "STUDIO_HOME=([^"\r\n]*)"\r?$/mu.exec(definition)?.[1];
  if (taskHome !== undefined) return taskHome.replaceAll("%%", "%");
  const unitHome = /^Environment=STUDIO_HOME=(.*)$/mu.exec(definition)?.[1]?.trim();
  if (unitHome === undefined) return null;
  const unquoted =
    unitHome.startsWith('"') && unitHome.endsWith('"')
      ? unitHome.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\\\", "\\")
      : unitHome;
  return unquoted.replaceAll("%%", "%");
};

const readRegistration = () => {
  if (IS_WIN) {
    const name = taskName().replaceAll("'", "''");
    const state = powershell(
      `$t = Get-ScheduledTask -TaskName '${name}' -ErrorAction SilentlyContinue; if ($t) { $t.State }`,
    ).stdout.trim();
    const script = NodePath.join(
      process.env.USERPROFILE ?? NodeOS.homedir(),
      "AppData",
      "Local",
      "SpecWithCode",
      "studio-service.cmd",
    );
    return {
      taskName: taskName(),
      registered: state !== "",
      running: state === "Running",
      state,
      definition: NodeFS.existsSync(script) ? NodeFS.readFileSync(script, "utf8") : null,
    };
  }
  const env = userBusEnv();
  const enabled = run("systemctl", ["--user", "is-enabled", UNIT_NAME], { env }).stdout.trim();
  const active = run("systemctl", ["--user", "is-active", UNIT_NAME], { env }).stdout.trim();
  const unit = NodePath.join(NodeOS.homedir(), ".config", "systemd", "user", UNIT_NAME);
  return {
    unit: UNIT_NAME,
    registered: enabled === "enabled",
    running: active === "active",
    state: `${enabled}/${active}`,
    definition: NodeFS.existsSync(unit) ? NodeFS.readFileSync(unit, "utf8") : null,
  };
};

// ---------------------------------------------------------------- run
let entry = null;
let installed = false;
let installAttempted = false;
let uninstalled = false;
const openApps = [];

const main = async () => {
  entry = resolveServerEntry();
  const versionProbe = entry
    ? run(APP, [entry, "--version"], { env: cliEnv(), timeout: 60_000 })
    : null;
  const version = versionProbe?.stdout.trim().split(/\s+/u).pop()?.replace(/^v/u, "") ?? null;
  const platformKey = IS_WIN ? "win32-x64" : "linux-x64";
  const archiveName = `studio-${version}-${platformKey}.${IS_WIN ? "zip" : "tar.gz"}`;
  if (
    !record(
      "bundled-cli",
      entry !== null && versionProbe?.status === 0 && NodePath.basename(ARCHIVE) === archiveName,
      {
        entry,
        version,
        archive: NodePath.basename(ARCHIVE),
        expectedArchive: archiveName,
      },
    )
  )
    return;

  // 1. Tray: own backend survives the last window, Quit stops it.
  try {
    const trayHome = NodePath.join(SCRATCH, "tray-home");
    NodeFS.mkdirSync(trayHome, { recursive: true });
    const own = await launchApp("tray", trayHome);
    await closeAllWindows(own, "tray-close");
    await sleep(8000);
    await assertOffscreen(own, "tray-closed", { allowEmpty: true });
    const keptRunning = !own.exited() && (await answers(own.origin));
    const trayLogged = own
      .output()
      .includes("keeping the app-owned backend running in the background");
    const trayFailed = own.output().includes("Could not create the tray icon");
    // The tray menu's Quit item runs exactly this (ElectronApp.quit).
    await own.app.evaluate(({ app }) => app.quit()).catch(() => {});
    await waitFor("the app to exit after Quit", () => own.exited(), { timeout: 30_000 }).catch(
      () => {},
    );
    const backendStopped = await waitFor(
      "the app-owned backend to stop",
      async () => !(await answers(own.origin)),
      {
        timeout: 30_000,
      },
    ).catch(() => false);
    record(
      "tray-keeps-backend-then-quits",
      own.ownsBundledService === true &&
        keptRunning &&
        trayLogged &&
        !trayFailed &&
        own.exited() &&
        own.exitStatus()?.code === 0 &&
        own.exitStatus()?.signal === null &&
        !offscreenLogs().failed &&
        backendStopped,
      {
        origin: own.origin,
        ownsBundledService: own.ownsBundledService,
        keptRunningAfterLastWindow: keptRunning,
        backgroundTrayLogged: trayLogged,
        trayCreationFailed: trayFailed,
        exitedAfterQuit: own.exited(),
        exitStatus: own.exitStatus(),
        backendStoppedAfterQuit: backendStopped,
      },
    );
  } catch (error) {
    record("tray-keeps-backend-then-quits", false, { reason: errorText(error) });
  }

  // 2. Service from the bundled CLI, pinned to this run's CLI archive.
  const before = readRegistration();
  if (before.registered || before.running || before.definition !== null) {
    record("service-install", false, {
      reason: "a SpecWithCode service is already registered",
      before,
    });
    return;
  }
  const mirror = await startMirror(version, archiveName);
  try {
    installAttempted = true;
    const install = await runAsync(APP, [entry, "service", "install", "--base-dir", SERVICE_HOME], {
      env: cliEnv({ STUDIO_RELEASE_BASE_URL: mirror.url }),
      timeout: 600_000,
    });
    installed = install.status === 0;
    NodeFS.writeFileSync(
      NodePath.join(OUT, "service-install.txt"),
      `${install.stdout}\n${install.stderr}`,
    );
    if (
      !record("service-install", installed, {
        exitCode: install.status,
        stdout: install.stdout.trim().slice(-600),
        stderr: install.status === 0 ? undefined : install.stderr.trim().slice(-1200),
        mirrorRequests: mirror.hits,
      })
    )
      return;
  } finally {
    mirror.server.close();
  }

  const pinned = NodePath.join(
    SERVICE_HOME,
    "runtime",
    "versions",
    version,
    IS_WIN ? "specweave-studio.exe" : "specweave-studio",
  );
  const registration = await waitFor(
    "the service to be registered and running",
    () => {
      const current = readRegistration();
      return current.registered && current.running ? current : null;
    },
    { timeout: 60_000 },
  ).catch(() => readRegistration());
  record(
    "service-registered",
    registration.registered &&
      registration.running &&
      (registration.definition ?? "").includes(pinned),
    {
      ...registration,
      pinnedRuntime: pinned,
      pinnedRuntimeExists: NodeFS.existsSync(pinned),
    },
  );

  let runtime = null;
  try {
    runtime = await waitFor(
      "the service to serve",
      async () => {
        const state = findRuntimeState(SERVICE_HOME);
        if (!state?.origin) return null;
        const environment = await fetchEnvironment(state.origin);
        return environment ? { ...state, serverVersion: environment.serverVersion } : null;
      },
      { interval: 2000 },
    );
    record(
      "service-serving",
      runtime.serverVersion === version && runtime.serviceManaged === true,
      runtime,
    );
  } catch (error) {
    record("service-serving", false, { reason: errorText(error) });
  }

  const status = run(APP, [entry, "service", "status", "--base-dir", SERVICE_HOME], {
    env: cliEnv(),
    timeout: 120_000,
  });
  const statusText = `${status.stdout}${status.stderr}`;
  record(
    "service-status",
    status.status === 0 &&
      /Status: installed/u.test(statusText) &&
      statusText.includes(version) &&
      !/\[(service|user-manager|linger)-/u.test(statusText),
    {
      exitCode: status.status,
      output: statusText.trim().slice(0, 800),
    },
  );

  // 3. The app attaches to the running service and quits on window close.
  if (runtime) {
    try {
      const attached = await launchApp("attached", SERVICE_HOME);
      const sameServer = attached.origin === new URL(runtime.origin).origin;
      await closeAllWindows(attached, "attached-close");
      const quit = await waitFor("the attached app to quit", () => attached.exited(), {
        timeout: 30_000,
      }).catch(() => false);
      const serviceStillServing = await answers(runtime.origin);
      record(
        "app-attaches-to-service",
        sameServer &&
          attached.ownsBundledService === false &&
          quit &&
          attached.exitStatus()?.code === 0 &&
          attached.exitStatus()?.signal === null &&
          !offscreenLogs().failed &&
          serviceStillServing,
        {
          appOrigin: attached.origin,
          ownsBundledService: attached.ownsBundledService,
          serviceOrigin: runtime.origin,
          quitOnLastWindow: quit,
          exitStatus: attached.exitStatus(),
          serviceStillServing,
        },
      );
    } catch (error) {
      record("app-attaches-to-service", false, { reason: errorText(error) });
    }
  }

  // 4. Uninstall removes the task or unit and stops the service.
  const uninstall = run(APP, [entry, "service", "uninstall", "--base-dir", SERVICE_HOME], {
    env: cliEnv(),
    timeout: 300_000,
  });
  uninstalled = uninstall.status === 0;
  const after = readRegistration();
  const stopped = runtime
    ? await waitFor(
        "the service to stop",
        async () => !alive(runtime.pid) && !(await answers(runtime.origin)),
        {
          timeout: 60_000,
        },
      ).catch(() => false)
    : true;
  record("service-uninstall", uninstalled && !after.registered && !after.running && stopped, {
    exitCode: uninstall.status,
    output: `${uninstall.stdout}${uninstall.stderr}`.trim().slice(0, 800),
    after: { ...after, definition: after.definition === null ? null : "still present" },
    serviceStopped: stopped,
  });
};

const copyLogs = () => {
  const target = NodePath.join(OUT, "service-home-logs");
  const stack = [SERVICE_HOME];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = NodeFS.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = NodePath.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== "versions") stack.push(full);
      else if (entry.name.endsWith(".log") || entry.name === "server-runtime.json") {
        const destination = NodePath.join(target, NodePath.relative(SERVICE_HOME, full));
        NodeFS.mkdirSync(NodePath.dirname(destination), { recursive: true });
        NodeFS.copyFileSync(full, destination);
      }
    }
  }
};

const cleanupService = () => {
  if (!installAttempted || uninstalled || !entry) return;
  const registration = readRegistration();
  const home = registrationHome(registration.definition);
  // Install can register successfully then fail to start. Uninstall that partial
  // installation too, but never touch a task/unit belonging to another home.
  if (
    home !== SERVICE_HOME &&
    (registration.registered || registration.running || registration.definition !== null)
  ) {
    results.cleanupUninstall = { refused: "registration does not match this test home" };
    return;
  }
  const cleanup = run(APP, [entry, "service", "uninstall", "--base-dir", SERVICE_HOME], {
    env: cliEnv(),
    timeout: 300_000,
  });
  results.cleanupUninstall = cleanup.status;
  uninstalled = cleanup.status === 0;
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
  for (const opened of openApps) await opened.app.close().catch(() => {});
  cleanupService();
  try {
    copyLogs();
  } catch {}
  if (offscreenLogs().failed) record("offscreen-guard", false, { driverLog: DRIVER_LOG });
  try {
    // Failed checks cannot prove all processes stopped. Keep private scratch for
    // diagnosis and never recursively delete a possibly live database.
    if (
      results.checks.some((check) => check.status !== "pass") ||
      openApps.some((opened) => !opened.exited()) ||
      (installAttempted && !uninstalled)
    ) {
      results.scratchLeft = "retained after incomplete shutdown or failed checks";
    } else {
      NodeFS.rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    }
  } catch (error) {
    results.scratchLeft = errorText(error);
  }
  results.ok =
    results.checks.length > 0 && results.checks.every((check) => check.status === "pass");
  results.finishedAt = new Date().toISOString();
  NodeFS.writeFileSync(NodePath.join(OUT, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
  exitCode = results.ok ? 0 : 1;
  log(results.ok ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED", NodePath.join(OUT, "results.json"));
}
process.exit(exitCode);
