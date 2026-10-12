// Launches the built desktop app against a throwaway Studio home and passes
// only after the backend answered and the main window opened. It never touches
// the real ~/.specweave-studio, Electron profile or keychain.
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
];

if (!NodeFS.existsSync(mainJs)) {
  console.error(`Desktop smoke test: ${mainJs} is missing. Build the desktop app first.`);
  process.exit(1);
}

const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "specweave-studio-smoke-"));
const home = NodePath.join(root, "home");
const studioHome = NodePath.join(home, ".specweave-studio");
NodeFS.mkdirSync(studioHome, { recursive: true });

const platformArgs =
  process.platform === "darwin"
    ? // Keeps safeStorage off the login keychain.
      ["--use-mock-keychain"]
    : // Chromium refuses its sandbox as root, as in CI containers.
      process.platform === "linux" && process.getuid?.() === 0
      ? ["--no-sandbox"]
      : [];
const electronCommand = resolveElectronLaunchCommand([mainJs, ...platformArgs]);

console.log(`\nLaunching Electron smoke test with private home ${home}`);

const child = NodeChildProcess.spawn(electronCommand.electronPath, electronCommand.args, {
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: NodePath.join(home, "AppData", "Roaming"),
    XDG_CONFIG_HOME: NodePath.join(home, ".config"),
    XDG_DATA_HOME: NodePath.join(home, ".local", "share"),
    STUDIO_HOME: studioHome,
    // Linux safeStorage reaches the user's keyring over the session bus.
    ...(process.platform === "linux" ? { DBUS_SESSION_BUS_ADDRESS: "disabled:" } : {}),
    VITE_DEV_SERVER_URL: "",
    ELECTRON_ENABLE_LOGGING: "1",
  },
});

let output = "";
let ready = false;
let finished = false;
let settleTimer;
let stopTimer;

const onOutput = (chunk) => {
  output += chunk.toString();
  // A startup failure can leave the app open on an error dialog; stop at once.
  if (FATAL_PATTERNS.some((pattern) => output.includes(pattern))) return finish();
  if (!ready && READY_MARKERS.every((marker) => output.includes(marker))) {
    ready = true;
    console.log("Backend answered and the main window opened; watching for renderer errors...");
    settleTimer = setTimeout(stop, SETTLE_MS);
  }
};
child.stdout.on("data", onOutput);
child.stderr.on("data", onOutput);

const readyTimer = setTimeout(() => {
  if (!ready) finish(`the app did not become ready within ${READY_TIMEOUT_MS} ms`);
}, READY_TIMEOUT_MS);

function stop() {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  // Only the PID this script spawned is ever signalled.
  stopTimer = setTimeout(() => child.kill("SIGKILL"), STOP_GRACE_MS);
}

function finish(failure) {
  if (finished) return;
  finished = true;
  clearTimeout(readyTimer);
  clearTimeout(settleTimer);
  const failures = [
    ...(failure ? [failure] : []),
    ...FATAL_PATTERNS.filter((pattern) => output.includes(pattern)),
  ];
  const done = () => {
    clearTimeout(stopTimer);
    NodeFS.rmSync(root, { recursive: true, force: true });
    if (failures.length > 0) {
      console.error("\nDesktop smoke test failed:");
      for (const entry of failures) console.error(` - ${entry}`);
      console.error("\nFull output:\n" + output);
      process.exit(1);
    }
    console.log("Desktop smoke test passed.");
    process.exit(0);
  };
  if (child.exitCode !== null || child.signalCode !== null) return done();
  child.once("exit", done);
  stop();
}

child.on("error", (error) => finish(`could not start Electron: ${error.message}`));
child.on("exit", (code, signal) => {
  if (!ready) return finish(`the app exited before it was ready (code ${code}, signal ${signal})`);
  finish();
});
