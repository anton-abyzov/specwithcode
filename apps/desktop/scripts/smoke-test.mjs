// Launches the built desktop app against a throwaway Studio home and passes
// only after the backend answered and the offscreen main window was created. It never touches
// the real ~/.specweave-studio, Electron profile or keychain.
//
// STUDIO_SMOKE_EXECUTABLE launches an installed app (the NSIS install's .exe,
// the .deb's binary or an extracted AppImage) instead of the dev bundle, and
// STUDIO_SMOKE_RESULT names a JSON file that receives the backend URL and the
// HTTP checks made against it, offscreen receipts and complete process logs.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { resolveElectronLaunchCommand } from "./electron-launcher.mjs";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const desktopDir = NodePath.resolve(__dirname, "..");
const mainJs = NodePath.resolve(desktopDir, "dist-electron/boot.cjs");

const READY_TIMEOUT_MS = Number(process.env.STUDIO_SMOKE_TIMEOUT_MS ?? 60_000);
// Renderer errors surface shortly after the window loads.
const SETTLE_MS = 4_000;
const STOP_GRACE_MS = 10_000;
const READY_MARKERS = ["backend ready", "main window created"];
const FATAL_PATTERNS = [
  "fatal startup error",
  "Cannot find module",
  "MODULE_NOT_FOUND",
  "Refused to execute",
  "Uncaught Error",
  "Uncaught TypeError",
  "Uncaught ReferenceError",
  "[desktop-test-offscreen] failure:",
];

const installedExecutable = process.env.STUDIO_SMOKE_EXECUTABLE?.trim() || "";
const resultFile = process.env.STUDIO_SMOKE_RESULT?.trim() || "";
const launchTarget = installedExecutable || mainJs;
if (!NodeFS.existsSync(launchTarget)) {
  console.error(
    `Desktop smoke test: ${launchTarget} is missing. ${
      installedExecutable ? "Install the app first." : "Build the desktop app first."
    }`,
  );
  process.exit(1);
}

const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "specweave-studio-smoke-"));
const home = NodePath.join(root, "home");
const studioHome = NodePath.join(home, ".specweave-studio");
NodeFS.mkdirSync(studioHome, { recursive: true });
const evidenceDir = resultFile
  ? NodePath.dirname(NodePath.resolve(resultFile))
  : NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "specweave-studio-smoke-evidence-"));
NodeFS.mkdirSync(evidenceDir, { recursive: true });
const logFile = resultFile
  ? `${NodePath.resolve(resultFile)}.log`
  : NodePath.join(evidenceDir, "desktop.log");
NodeFS.writeFileSync(logFile, "");

const platformArgs =
  process.platform === "darwin"
    ? // Keeps safeStorage off the login keychain.
      ["--use-mock-keychain"]
    : // Chromium refuses its sandbox as root, as in CI containers.
      process.platform === "linux" && process.getuid?.() === 0
      ? ["--no-sandbox"]
      : [];
const electronCommand = installedExecutable
  ? { electronPath: installedExecutable, args: platformArgs }
  : resolveElectronLaunchCommand([mainJs, ...platformArgs]);

console.log(`\nLaunching Electron smoke test with private home ${home}`);

// On POSIX the app gets its own process group, so a forced stop also reaches
// anything an AppImage runtime forked.
const ownGroup = process.platform !== "win32";
const child = NodeChildProcess.spawn(electronCommand.electronPath, electronCommand.args, {
  stdio: ["ignore", "pipe", "pipe"],
  detached: ownGroup,
  env: {
    // A STUDIO_PORT or STUDIO_MODE inherited from a running SpecWithCode would
    // point the app at that live service instead of its own backend.
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("STUDIO_")),
    ),
    HOME: home,
    USERPROFILE: home,
    APPDATA: NodePath.join(home, "AppData", "Roaming"),
    XDG_CONFIG_HOME: NodePath.join(home, ".config"),
    XDG_DATA_HOME: NodePath.join(home, ".local", "share"),
    STUDIO_HOME: studioHome,
    STUDIO_DESKTOP_TEST_OFFSCREEN: "1",
    PWDEBUG: "0",
    PLAYWRIGHT_HTML_OPEN: "never",
    // Linux safeStorage reaches the user's keyring over the session bus.
    ...(process.platform === "linux" ? { DBUS_SESSION_BUS_ADDRESS: "disabled:" } : {}),
    VITE_DEV_SERVER_URL: "",
    ELECTRON_ENABLE_LOGGING: "1",
  },
});

let output = "";
const logs = { stdout: "", stderr: "" };
let ready = false;
let finished = false;
let closed = false;
let finalized = false;
let stopRequested = false;
let forcedStop = false;
let probeCompleted = false;
let exitStatus = null;
const finishFailures = [];
let settleTimer;
let stopTimer;
let drainTimer;

const onOutput = (chunk, stream) => {
  logs[stream] += chunk.toString();
  output += chunk.toString();
  NodeFS.appendFileSync(logFile, chunk);
  // A startup failure can leave the app open on an error dialog; stop at once.
  if (
    FATAL_PATTERNS.some((pattern) => logs.stdout.includes(pattern) || logs.stderr.includes(pattern))
  ) {
    return finish();
  }
  if (finished) return;
  if (!ready && READY_MARKERS.every((marker) => output.includes(marker))) {
    ready = true;
    console.log(
      "Backend answered and the main window was created; watching for renderer errors...",
    );
    settleTimer = setTimeout(() => {
      void probeBackend()
        .catch((error) => probe.failures.push(`backend probe failed: ${String(error)}`))
        .finally(() => {
          probeCompleted = true;
          stop();
        });
    }, SETTLE_MS);
  }
};
child.stdout.on("data", (chunk) => onOutput(chunk, "stdout"));
child.stderr.on("data", (chunk) => onOutput(chunk, "stderr"));

const readyTimer = setTimeout(() => {
  if (!ready) finish(`the app did not become ready within ${READY_TIMEOUT_MS} ms`);
}, READY_TIMEOUT_MS);

const probe = { backendUrl: null, checks: [], failures: [] };

// The "backend ready" log entry carries the loopback URL the window loaded, as
// a `url:` field on the lines after the message.
async function probeBackend() {
  const match = output.match(
    /backend ready[\s\S]{0,400}?(https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/?)/,
  );
  if (!match) {
    probe.failures.push("the backend ready log entry named no loopback URL");
    return;
  }
  probe.backendUrl = match[1];
  for (const path of ["/", "/.well-known/studio/environment"]) {
    const url = new URL(path, probe.backendUrl).href;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      const body = await response.text();
      probe.checks.push({ url, status: response.status, bytes: body.length });
      // "/" serves the web app; the environment descriptor is what pairing
      // reads from another machine.
      const expected = path === "/" ? /<html/i : /"environmentId"/;
      if (!response.ok || !expected.test(body)) {
        probe.failures.push(`GET ${url} returned ${response.status}: ${body.slice(0, 200)}`);
      }
    } catch (error) {
      probe.checks.push({ url, error: String(error) });
      probe.failures.push(`GET ${url} failed: ${error}`);
    }
  }
}

// Signals the spawned app, and on POSIX every process in the group it leads.
function signalApp(signal) {
  if (!ownGroup) return child.kill(signal);
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch {
    // ESRCH: the group is already empty.
    return child.kill(signal);
  }
}

// An AppImage runtime forks the app and waits for it without forwarding signals,
// so a graceful stop goes to the app it forked; the runtime then exits with the
// app's status. Chromium's own helpers are left for the app to shut down.
const isAppImage = /\.appimage$/i.test(installedExecutable);
function childPids(pid) {
  try {
    return NodeChildProcess.execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" })
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((value) => Number.isInteger(value) && value > 0);
  } catch {
    return [];
  }
}
function requestGracefulStop() {
  const forked = isAppImage ? childPids(child.pid) : [];
  if (forked.length === 0) return child.kill("SIGTERM");
  let sent = false;
  for (const pid of forked) {
    try {
      process.kill(pid, "SIGTERM");
      sent = true;
    } catch {
      // Already gone.
    }
  }
  return sent || child.kill("SIGTERM");
}

function stop() {
  if (stopRequested || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
  stopRequested = requestGracefulStop();
  if (!stopRequested) finishFailures.push("could not request graceful shutdown of the owned app");
  // Only the PID this script spawned, what it forked, and its group are ever signalled.
  stopTimer = setTimeout(() => {
    forcedStop = true;
    finishFailures.push("the app did not stop within the graceful shutdown deadline");
    signalApp("SIGKILL");
  }, STOP_GRACE_MS);
}

function finish(failure) {
  if (failure) finishFailures.push(failure);
  if (!finished) {
    finished = true;
    clearTimeout(readyTimer);
    clearTimeout(settleTimer);
    stop();
  }
  // Exit can precede the final stderr data. Close means both pipes drained, so
  // late guard failures and early creation records are included in the result.
  if (!closed || finalized) return;
  finalized = true;
  clearTimeout(stopTimer);
  clearTimeout(drainTimer);
  const offscreenWindows = [];
  const offscreenFailures = [];
  for (const line of logs.stderr.split("\n")) {
    const marker = "[desktop-test-offscreen] ";
    const index = line.indexOf(marker);
    if (index < 0) continue;
    const payload = line.slice(index + marker.length).trim();
    try {
      const state = JSON.parse(payload);
      if (
        state.event !== "window-created" ||
        !Number.isInteger(state.id) ||
        state.id <= 0 ||
        state.offscreen !== true ||
        state.visible !== false ||
        state.focused !== false
      ) {
        offscreenFailures.push(`invalid offscreen receipt: ${payload}`);
      } else {
        offscreenWindows.push(state);
      }
    } catch {
      offscreenFailures.push(`invalid offscreen receipt or guard failure: ${payload}`);
    }
  }
  if (offscreenWindows.length === 0) {
    offscreenFailures.push("no valid offscreen window creation receipts");
  }
  const failures = [
    ...finishFailures,
    ...probe.failures,
    ...offscreenFailures,
    ...(!ready ? ["the app did not reach backend and main-window readiness"] : []),
    ...(!probeCompleted ? ["the backend HTTP checks did not complete"] : []),
    ...FATAL_PATTERNS.filter(
      (pattern) => logs.stdout.includes(pattern) || logs.stderr.includes(pattern),
    ),
  ];
  if (resultFile) {
    NodeFS.writeFileSync(
      resultFile,
      JSON.stringify(
        {
          platform: process.platform,
          launchTarget,
          ...probe,
          offscreenWindows,
          exitStatus,
          stopRequested,
          forcedStop,
          logFile,
          logs,
          failures,
        },
        null,
        2,
      ),
    );
  }
  // Failed shutdown cannot prove the backend stopped; retain that private home.
  if (failures.length === 0) {
    NodeFS.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
  console.log(`Desktop smoke log: ${logFile}`);
  if (failures.length > 0) {
    console.error("\nDesktop smoke test failed:");
    for (const entry of failures) console.error(` - ${entry}`);
    console.error("\nFull output:\n" + output);
    process.exit(1);
  }
  console.log("Desktop smoke test passed.");
  process.exit(0);
}

child.on("error", (error) => finish(`could not start Electron: ${error.message}`));
child.on("exit", (code, signal) => {
  exitStatus = { code, signal };
  clearTimeout(stopTimer);
  if (!stopRequested) finishFailures.push(`unexpected app exit (code ${code}, signal ${signal})`);
  if (code !== null && code !== 0) finishFailures.push(`app exited with nonzero code ${code}`);
  if (signal !== null && !(stopRequested && !forcedStop && signal === "SIGTERM")) {
    finishFailures.push(`app exited with unexpected signal ${signal}`);
  }
  drainTimer = setTimeout(() => {
    // A descendant holding the pipes open is not a successful shutdown. Retain
    // the evidence and private home instead of hanging or reporting success.
    closed = true;
    finish("app output pipes did not close after process exit; logs may be incomplete");
  }, STOP_GRACE_MS);
  finish();
});
child.on("close", () => {
  closed = true;
  finish();
});
