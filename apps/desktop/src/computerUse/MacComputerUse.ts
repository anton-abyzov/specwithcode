// @effect-diagnostics globalTimers:off -- Clipboard restore waits for the target app to read a paste.
// @effect-diagnostics globalDate:off -- Permission prompts are throttled outside Effect, at the native boundary.
// @effect-diagnostics nodeBuiltinImport:off -- Native input and capture run as child processes of the app.
import {
  COMPUTER_USE_PERMISSION_ERROR_PHRASES,
  COMPUTER_USE_PERMISSION_WAIT_MS,
  COMPUTER_USE_SETTINGS_URL_PREFIX,
  computerUsePermissionFor,
  type ComputerUseAction,
  type ComputerUseActionResult,
  type ComputerUsePermission,
  type ComputerUsePermissions,
} from "@specweave-studio/contracts";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Electron from "electron";

import { MAC_PERMISSION_SETTINGS_URLS, type MacPermission } from "../permissions/MacPermission.ts";
import {
  actionSteps,
  ComputerUseInputError,
  type DisplayGeometry,
  type InputStep,
  JXA_INPUT_SCRIPT,
  PASTE_STEPS,
  screenshotSize,
  toScreenshotPoint,
} from "./computerUseSteps.ts";

const execFile = (file: string, args: ReadonlyArray<string>, timeoutMs: number) =>
  new Promise<string>((resolve, reject) => {
    NodeChildProcess.execFile(
      file,
      [...args],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error)
          reject(
            new Error(
              String(stderr || error.message)
                .trim()
                .slice(0, 500),
            ),
          );
        else resolve(stdout);
      },
    );
  });

// The main process reads Screen Recording once at launch (CGPreflightScreenCaptureAccess
// caches it), so a grant made later reads as missing until the app reopens. A new child
// process has the app's identity and reads the current grant; screencapture and osascript,
// which perform the actions, are such children too.
const PERMISSION_PROBE_SCRIPT = `
ObjC.import("CoreGraphics");
ObjC.import("ApplicationServices");
ObjC.bindFunction("CGPreflightScreenCaptureAccess", ["bool", []]);
ObjC.bindFunction("AXIsProcessTrusted", ["bool", []]);
JSON.stringify({ screenRecording: $.CGPreflightScreenCaptureAccess(), accessibility: $.AXIsProcessTrusted() });`;

function launchPermissions(): ComputerUsePermissions {
  return {
    screenRecording: Electron.systemPreferences.getMediaAccessStatus("screen") === "granted",
    accessibility: Electron.systemPreferences.isTrustedAccessibilityClient(false),
  };
}

/** The app's current grants, including ones made after it launched. */
export async function currentPermissions(): Promise<ComputerUsePermissions> {
  const known = launchPermissions();
  if (known.screenRecording && known.accessibility) return known;
  try {
    const output = await execFile(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", PERMISSION_PROBE_SCRIPT],
      5_000,
    );
    const probed = JSON.parse(output.trim()) as Partial<ComputerUsePermissions>;
    return {
      screenRecording: known.screenRecording || probed.screenRecording === true,
      accessibility: known.accessibility || probed.accessibility === true,
    };
  } catch {
    return known;
  }
}

function primaryDisplay(): DisplayGeometry {
  const { width, height } = Electron.screen.getPrimaryDisplay().size;
  return { width, height };
}

const permissionGranted = async (permission: ComputerUsePermission) =>
  (await currentPermissions())[COMPUTER_USE_PERMISSION_KEYS[permission]];

const COMPUTER_USE_PERMISSION_KEYS = {
  "screen-recording": "screenRecording",
  accessibility: "accessibility",
} as const satisfies Record<ComputerUsePermission, keyof ComputerUsePermissions>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Asks for a permission at most once a minute, however often an agent retries. */
const lastPermissionPrompt = new Map<MacPermission, number>();

/**
 * Asks macOS for a missing permission the way it expects: its own prompt the
 * first time, which also adds the app to the list, then the matching Privacy
 * & Security pane, where `onPrompt` shows the drag-to-allow helper.
 */
export async function requestPermission(
  permission: ComputerUsePermission,
  onPrompt: (permission: MacPermission) => void,
): Promise<ComputerUsePermissions> {
  if (await permissionGranted(permission)) return currentPermissions();
  lastPermissionPrompt.set(permission, Date.now());
  if (permission === "accessibility") {
    // Shows the system prompt and adds the app to the Accessibility list.
    Electron.systemPreferences.isTrustedAccessibilityClient(true);
  } else if (Electron.systemPreferences.getMediaAccessStatus("screen") === "not-determined") {
    // A first capture attempt shows the system prompt and adds the app to the list.
    await Electron.desktopCapturer
      .getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } })
      .catch(() => []);
    if (await permissionGranted(permission)) return currentPermissions();
  }
  void Electron.shell.openExternal(MAC_PERMISSION_SETTINGS_URLS[permission]);
  onPrompt(permission);
  return currentPermissions();
}

/** Holds an action until the user allows its permission, so the agent's first request still goes through. */
async function ensurePermission(
  permission: ComputerUsePermission,
  onPrompt: (permission: MacPermission) => void,
) {
  if (await permissionGranted(permission)) return;
  if (Date.now() - (lastPermissionPrompt.get(permission) ?? 0) >= 60_000) {
    await requestPermission(permission, onPrompt);
  }
  const deadline = Date.now() + COMPUTER_USE_PERMISSION_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(1_000);
    if (await permissionGranted(permission)) return;
  }
  throw new Error(PERMISSION_REASON[permission]);
}

// Each reason opens with the contract's phrase, which threads use to show the permission card.
const PERMISSION_REASON: Record<ComputerUsePermission, string> = {
  "screen-recording": `${COMPUTER_USE_PERMISSION_ERROR_PHRASES["screen-recording"]} to see the screen, and the user did not allow it within two minutes. SpecWithCode shows a card in this thread with an Allow button and live status. Tell the user to allow Screen Recording for SpecWithCode there (choosing Quit & Reopen if macOS asks), then try again when they say it is done.`,
  accessibility: `${COMPUTER_USE_PERMISSION_ERROR_PHRASES.accessibility} to click and type, and the user did not allow it within two minutes. SpecWithCode shows a card in this thread with an Allow button and live status. Tell the user to allow Accessibility for SpecWithCode there, then try again when they say it is done.`,
};

async function captureScreen(display: DisplayGeometry) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "specwithcode-screen-"));
  const file = NodePath.join(directory, "screen.png");
  try {
    // -x: no sound, -m: main display only, -C: include the pointer.
    await execFile("/usr/sbin/screencapture", ["-x", "-m", "-C", "-t", "png", file], 15_000);
    const image = Electron.nativeImage.createFromPath(file);
    if (image.isEmpty()) throw new Error("The screen capture was empty.");
    const size = screenshotSize(display);
    const resized = image.resize({ width: size.width, height: size.height, quality: "good" });
    const actual = resized.getSize();
    return {
      mimeType: "image/jpeg" as const,
      data: resized.toJPEG(80).toString("base64"),
      width: actual.width,
      height: actual.height,
    };
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
}

async function replay(steps: ReadonlyArray<InputStep>): Promise<string | undefined> {
  const output = await execFile(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", JXA_INPUT_SCRIPT, JSON.stringify(steps)],
    30_000,
  );
  try {
    const parsed = JSON.parse(output.trim()) as { frontmostApplication?: string | null };
    return parsed.frontmostApplication ?? undefined;
  } catch {
    return undefined;
  }
}

async function frontmostApplication(): Promise<string | undefined> {
  return replay([]).catch(() => undefined);
}

/** Puts text on the clipboard, pastes it, then gives the user's clipboard back. */
async function typeText(text: string): Promise<string | undefined> {
  const saved = await Electron.clipboard.read().catch(() => []);
  await Electron.clipboard.writeText(text);
  try {
    return await replay(PASTE_STEPS);
  } finally {
    // The target app reads the pasteboard after the keystroke arrives.
    await sleep(300);
    if (saved.length === 0) Electron.clipboard.clear();
    else await Electron.clipboard.write(saved).catch(() => Electron.clipboard.clear());
  }
}

async function open(action: Extract<ComputerUseAction, { kind: "open" }>) {
  if (action.url !== undefined) {
    if (!action.url.startsWith(COMPUTER_USE_SETTINGS_URL_PREFIX)) {
      throw new ComputerUseInputError("Only System Settings URLs can be opened this way.");
    }
    await execFile("/usr/bin/open", [action.url], 20_000);
  } else if (action.application !== undefined) {
    await execFile("/usr/bin/open", ["-a", action.application], 20_000).catch((error: Error) => {
      throw new ComputerUseInputError(
        `Could not open "${action.application}": ${error.message || "no such application"}.`,
      );
    });
  }
  // Give the window time to come forward before the agent's next screenshot.
  await sleep(900);
}

/**
 * Performs one action on this Mac and reports the state afterwards. Throws an
 * error whose message is written for the agent.
 */
export async function runComputerUseAction(
  action: ComputerUseAction,
  onPermissionPrompt: (permission: MacPermission) => void,
): Promise<ComputerUseActionResult> {
  const required = computerUsePermissionFor(action.kind);
  if (required !== undefined) await ensurePermission(required, onPermissionPrompt);
  const permissions = await currentPermissions();
  const display = primaryDisplay();

  let frontmost: string | undefined;
  let screenshot: ComputerUseActionResult["screenshot"];
  switch (action.kind) {
    case "status":
      frontmost = await frontmostApplication();
      break;
    case "screenshot":
      [screenshot, frontmost] = await Promise.all([captureScreen(display), frontmostApplication()]);
      break;
    case "type":
      frontmost = await typeText(action.text);
      break;
    case "open":
      await open(action);
      frontmost = await frontmostApplication();
      break;
    default:
      frontmost = await replay(actionSteps(action, display));
  }

  const cursor = Electron.screen.getCursorScreenPoint();
  return {
    platform: "macos",
    permissions,
    display: screenshotSize(display),
    cursor: toScreenshotPoint(display, cursor.x, cursor.y),
    ...(frontmost === undefined ? {} : { frontmostApplication: frontmost }),
    ...(screenshot === undefined ? {} : { screenshot }),
  };
}
