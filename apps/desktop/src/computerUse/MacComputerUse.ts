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
  applicationAtPoint,
  applicationName,
  canAttemptBackgroundAxClick,
  canSafelyFallbackHidClick,
  canSafelyFallbackHidType,
  clickStepsAtPoint,
  ComputerUseInputError,
  type DisplayGeometry,
  type DisplayPoint,
  dragStepsAtPoints,
  findWindowAtPointForApplication,
  findWindowForApplication,
  type InputStep,
  IPHONE_MIRRORING_BUNDLE_ID,
  isWindowCaptureFresh,
  JXA_AX_ACTION_SCRIPT,
  JXA_INPUT_SCRIPT,
  JXA_MIRRORING_SCRIPT,
  JXA_RUNNING_APP_NAME_SCRIPT,
  JXA_WINDOWS_SCRIPT,
  type MirroringScene,
  mirroringActionSteps,
  moveStepsAtPoint,
  type ReplayOptions,
  type ScreenArea,
  scrollStepsAtPoint,
  type ScreenScene,
  screenshotSize,
  toDisplayPoint,
  toScreenshotPoint,
  toWindowDisplayPoint,
} from "./computerUseSteps.ts";
import { isResettableBundleId, TCC_SERVICE, waitForPermission } from "./permissionWait.ts";

const execFile = (file: string, args: ReadonlyArray<string>, timeoutMs: number, stdin?: string) =>
  new Promise<string>((resolve, reject) => {
    const child = NodeChildProcess.execFile(
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
    if (stdin !== undefined) {
      child.stdin?.end(stdin, "utf8");
    }
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

const PERMISSION_WAIT_MARGIN_MS = 5_000;

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
  const granted = await waitForPermission({
    granted: () => permissionGranted(permission),
    // Stop a little before the server does, leaving the last check and the
    // action itself inside the server's deadline.
    waitMs: COMPUTER_USE_PERMISSION_WAIT_MS - PERMISSION_WAIT_MARGIN_MS,
    now: Date.now,
    sleep,
  });
  if (!granted) throw new Error(PERMISSION_REASON[permission]);
}

async function ownBundleId(): Promise<string> {
  // process.execPath is <App>.app/Contents/MacOS/<name>; Info.plist sits in Contents.
  const info = NodePath.join(NodePath.dirname(NodePath.dirname(process.execPath)), "Info");
  return (await execFile("/usr/bin/defaults", ["read", info, "CFBundleIdentifier"], 5_000)).trim();
}

/**
 * Clears this app's own entry in a Privacy & Security list, then asks again.
 * macOS keeps a switch tied to the build that first asked: after a build
 * signed another way (a local development build, an older ad-hoc release),
 * the switch can read as on while this app is still refused. Resetting drops
 * that stale entry, and asking again adds one for this build.
 */
export async function resetPermission(
  permission: ComputerUsePermission,
  onPrompt: (permission: MacPermission) => void,
): Promise<ComputerUsePermissions> {
  const bundleId = await ownBundleId();
  if (!isResettableBundleId(bundleId)) {
    throw new Error(`Refusing to reset permissions for ${bundleId || "an unknown app"}.`);
  }
  await execFile("/usr/bin/tccutil", ["reset", TCC_SERVICE[permission], bundleId], 10_000);
  lastPermissionPrompt.delete(permission);
  return requestPermission(permission, onPrompt);
}

// Each reason opens with the contract's phrase, which threads use to show the permission card.
const PERMISSION_REASON: Record<ComputerUsePermission, string> = {
  "screen-recording": `${COMPUTER_USE_PERMISSION_ERROR_PHRASES["screen-recording"]} to see the screen, and macOS still refused it after two minutes. SpecWithCode shows a card in this thread with live status. If the user already turned SpecWithCode on in the list, macOS may need the app reopened (Quit & Reopen on the card), or it is holding that switch for another build of SpecWithCode: Reset on the card clears it so the user can turn it on again. Tell the user which step the card shows, then try again when they say it is done.`,
  accessibility: `${COMPUTER_USE_PERMISSION_ERROR_PHRASES.accessibility} to click and type, and macOS still refused it after two minutes. SpecWithCode shows a card in this thread with live status. If the user already turned SpecWithCode on in the list, macOS is holding that switch for another build of SpecWithCode: Reset on the card clears it so the user can turn it on again. Tell the user, then try again when they say it is done.`,
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

async function readWindowsScene(): Promise<ScreenScene | undefined> {
  try {
    const output = await execFile(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", JXA_WINDOWS_SCRIPT],
      5_000,
    );
    const scene = JSON.parse(output.trim()) as ScreenScene;
    return Array.isArray(scene.windows) ? scene : undefined;
  } catch {
    return undefined;
  }
}

type WindowCaptureState =
  | {
      readonly status: "active";
      readonly application: string;
      readonly pid: number;
      readonly windowId: number;
      readonly bounds: ScreenArea;
      readonly title?: string | undefined;
    }
  | {
      readonly status: "invalidated";
      readonly application: string;
      readonly reason: string;
    };

type ActiveWindowCapture = Extract<WindowCaptureState, { status: "active" }>;

type BackgroundFieldState =
  | {
      readonly status: "active";
      readonly application: string;
      readonly pid: number;
      readonly windowId: number;
      readonly bounds: ScreenArea;
      readonly title?: string | undefined;
      readonly x: number;
      readonly y: number;
      readonly role?: string | undefined;
      readonly fieldKey?: string | undefined;
    }
  | {
      readonly status: "invalidated";
      readonly application: string;
      readonly reason: string;
    };

/**
 * Only these explicit pre-dispatch AX refusal reasons may fall back to HID
 * click; post-dispatch or uncertain failures (e.g. `ax-exec-error`,
 * `ax-press-failed`, window-changed/occluded/ambiguous) must never be retried
 * via HID.
 */
const AX_PRE_DISPATCH_FALLBACK_REASONS: ReadonlySet<string> = new Set([
  "unsupported-ax",
  "hit-failed",
  "value-not-settable",
  "ax-field-unidentifiable",
  "invalid-pid",
  "app-element-null",
]);

const MAX_SESSION_STATE = 256;
/** Per-session last window capture, for mapping window-relative coordinates without cross-thread leaks. */
const windowCaptures = new Map<string, WindowCaptureState>();
/** Per-session last editable AX control targeted by a background click, for clipboard-free AX typing. */
const backgroundFields = new Map<string, BackgroundFieldState>();

const sessionKeyFor = (action: ComputerUseAction): string =>
  "sessionKey" in action && typeof action.sessionKey === "string" && action.sessionKey.length > 0
    ? action.sessionKey
    : "default";

const setBounded = <T>(map: Map<string, T>, key: string, value: T) => {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_SESSION_STATE) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
};

const sameAppName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

async function captureWindow(application: string, sessionKey: string) {
  const scene = await readWindowsScene();
  const win = scene === undefined ? undefined : findWindowForApplication(scene, application);
  if (win === undefined || win.windowId === undefined || win.pid === undefined) {
    throw new ComputerUseInputError(
      `Could not find an on-screen window for "${application}". Open it with computer_open first.`,
    );
  }
  if (win.pid === process.pid) {
    throw new ComputerUseInputError("Cannot target SpecWithCode itself.");
  }
  const bounds: ScreenArea = {
    x: Math.round(win.x),
    y: Math.round(win.y),
    width: Math.round(win.width),
    height: Math.round(win.height),
  };
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "specwithcode-window-"));
  const file = NodePath.join(directory, "window.png");
  try {
    // -x: no sound, -o: exclude window shadow so pixel geometry matches CGWindowBounds 1:1,
    // -l: capture this exact CGWindowID even when occluded in the background.
    await execFile(
      "/usr/sbin/screencapture",
      ["-x", "-o", "-l", String(win.windowId), "-t", "png", file],
      15_000,
    );
    const image = Electron.nativeImage.createFromPath(file);
    if (image.isEmpty()) {
      throw new Error(`The window capture for "${application}" was empty.`);
    }
    const size = screenshotSize(bounds);
    const resized = image.resize({ width: size.width, height: size.height, quality: "good" });
    const actual = resized.getSize();
    setBounded(windowCaptures, sessionKey, {
      status: "active",
      application,
      pid: win.pid,
      windowId: win.windowId,
      bounds,
      title: win.title,
    });
    return {
      screenshot: {
        mimeType: "image/jpeg" as const,
        data: resized.toJPEG(80).toString("base64"),
        width: actual.width,
        height: actual.height,
      },
      windowId: win.windowId,
      bounds,
    };
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
}

interface AxActionResult {
  readonly ok: boolean;
  readonly kind?: "pressed" | "editable" | "typed";
  readonly role?: string;
  readonly fieldKey?: string;
  readonly reason?: string;
  readonly frontmostApplication?: string | null;
}

async function runAxAction(request: {
  readonly mode: "click" | "type";
  readonly pid: number;
  readonly windowId?: number;
  readonly expectedWindowBounds?: ScreenArea | undefined;
  readonly expectedWindowTitle?: string | undefined;
  readonly x: number;
  readonly y: number;
  readonly text?: string;
  readonly expectedRole?: string | undefined;
  readonly expectedFieldKey?: string | undefined;
}): Promise<AxActionResult> {
  if (request.pid <= 0 || request.pid === process.pid) {
    return { ok: false, reason: "invalid-pid" };
  }
  try {
    const output = await execFile(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", JXA_AX_ACTION_SCRIPT],
      10_000,
      JSON.stringify(request),
    );
    return JSON.parse(output.trim()) as AxActionResult;
  } catch {
    return { ok: false, reason: "ax-exec-error" };
  }
}

async function replay(
  steps: ReadonlyArray<InputStep>,
  options?: ReplayOptions,
): Promise<string | undefined> {
  const payload = JSON.stringify({
    steps,
    ...(options === undefined ? {} : { options }),
  });
  const output = await execFile(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", JXA_INPUT_SCRIPT],
    30_000,
    payload,
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

/**
 * The app owning the topmost window under a screenshot point, scaled to
 * display points exactly as a click there is. Undefined when it cannot tell.
 */
async function applicationAt(
  display: DisplayGeometry,
  x: number,
  y: number,
): Promise<string | undefined> {
  const scene = await readWindowsScene();
  if (scene === undefined) return undefined;
  return applicationAtPoint(scene, toDisplayPoint(display, x, y));
}

/** iPhone Mirroring's process name, for a cheap check before reading any window. */
const IPHONE_MIRRORING_PROCESS = "iPhone Mirroring";
/** How long the window read may take; a busy Mac can need seconds to start osascript. */
const MIRRORING_SCENE_TIMEOUT_MS = 10_000;

/**
 * Whether iPhone Mirroring runs: one `pgrep`, so actions on a Mac that is not
 * mirroring a phone never start the window read. Undefined when it cannot tell.
 */
function mirroringRunning(): Promise<boolean | undefined> {
  return new Promise((resolve) => {
    NodeChildProcess.execFile(
      "/usr/bin/pgrep",
      ["-x", IPHONE_MIRRORING_PROCESS],
      { timeout: 5_000 },
      (error) => {
        if (error === null) resolve(true);
        else resolve((error as { code?: unknown }).code === 1 ? false : undefined);
      },
    );
  });
}

/**
 * The windows and frontmost app as iPhone Mirroring needs them; undefined when
 * they cannot be read.
 */
async function readMirroringScene(): Promise<MirroringScene | undefined> {
  try {
    const output = await execFile(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", JXA_MIRRORING_SCRIPT, IPHONE_MIRRORING_BUNDLE_ID],
      MIRRORING_SCENE_TIMEOUT_MS,
    );
    const scene = JSON.parse(output.trim()) as MirroringScene;
    return Array.isArray(scene.windows) ? scene : undefined;
  } catch {
    return undefined;
  }
}

/** The last display point an action used on the iPhone Mirroring window. */
let lastMirroringPoint: DisplayPoint | undefined;

/**
 * Runs an action on the iPhone Mirroring window when it lands there, and
 * reports the frontmost app afterwards; undefined when it does not land there,
 * and the action takes its usual steps. When iPhone Mirroring is not running
 * nothing is read. When it runs but its window cannot be read in time, a
 * click, scroll or drag takes its usual steps, while typing and keys are
 * refused, because pasted text and unguarded keys go wrong on the phone.
 * The app comes forward through Launch Services, as `computer_open` does.
 */
async function runOnMirroring(
  action: ComputerUseAction,
  display: DisplayGeometry,
  displayPoint?: DisplayPoint,
  displayToPoint?: DisplayPoint,
): Promise<{ frontmost: string | undefined } | undefined> {
  if ((await mirroringRunning()) === false) return undefined;
  const scene = await readMirroringScene();
  if (scene === undefined) {
    if (action.kind === "type" || action.kind === "key") {
      throw new ComputerUseInputError(
        "iPhone Mirroring is open and the Mac was too busy to tell whether it is in front, so nothing was sent, in case it would have reached the phone the wrong way. Try again.",
      );
    }
    return undefined;
  }
  if (scene.windows.length === 0) return undefined;
  const plan = mirroringActionSteps(action, display, {
    scene,
    cursor: Electron.screen.getCursorScreenPoint(),
    lastPoint: lastMirroringPoint,
    ...(displayPoint === undefined ? {} : { displayPoint }),
    ...(displayToPoint === undefined ? {} : { displayToPoint }),
  });
  if (plan === undefined) return undefined;
  if (plan.activate) {
    await execFile("/usr/bin/open", ["-b", IPHONE_MIRRORING_BUNDLE_ID], 10_000).catch(
      (error: Error) => {
        throw new ComputerUseInputError(
          `Could not bring iPhone Mirroring forward: ${error.message || "it did not open"}.`,
        );
      },
    );
  }
  if (plan.point !== undefined) lastMirroringPoint = plan.point;
  try {
    return { frontmost: await replay(plan.steps) };
  } catch (error) {
    if (error instanceof Error && error.message.includes("not-frontmost")) {
      throw new ComputerUseInputError(
        "iPhone Mirroring did not come to the front, so nothing was sent to the phone. Open it with computer_open, check that the phone is connected, then try again.",
      );
    }
    if (error instanceof Error && error.message.includes("left-front")) {
      throw new ComputerUseInputError(
        "iPhone Mirroring stopped being the app in front partway through, so the rest was not sent and nothing reached another app. Part of it may be on the phone: take a screenshot to see what arrived, then continue from there.",
      );
    }
    throw error;
  }
}

/** Types text directly to the verified frontmost PID via Unicode CGEvents without touching the clipboard. */
async function typeText(
  text: string,
  guard?: { readonly expectedFrontmost?: string | undefined; readonly forbidPid?: number },
): Promise<string | undefined> {
  try {
    return await replay([], {
      yieldForHumanInput: true,
      unicodeText: text,
      ...(guard?.expectedFrontmost === undefined
        ? {}
        : { expectedFrontmost: guard.expectedFrontmost }),
      ...(guard?.forbidPid === undefined ? {} : { forbidPid: guard.forbidPid }),
    });
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes("type-unsupported-control-chars")) {
        throw new ComputerUseInputError(
          "Foreground computer_type only supports literal printable text without newline or tab control characters. Use computer_key with return or tab for intentional form submission or focus movement, or click an Accessibility-editable text field first.",
        );
      }
      if (error.message.includes("type-uncertain")) {
        throw new ComputerUseInputError(
          "Focus changed partway through typing, so part of the text may have arrived. Take a screenshot to check what arrived before retrying.",
        );
      }
      if (
        error.message.includes("unicode-dispatch-unavailable") ||
        error.message.includes("pid-dispatch-unavailable")
      ) {
        throw new ComputerUseInputError(
          "Could not target the frontmost application directly for keyboard input. Bring the target app forward with computer_open and try again.",
        );
      }
      if (
        error.message.includes("not-frontmost-app") ||
        error.message.includes("forbidden-frontmost-pid")
      ) {
        throw new ComputerUseInputError(
          guard?.expectedFrontmost !== undefined
            ? `Cannot type into "${guard.expectedFrontmost}" in the background: frontmost app changed before input could be sent. Bring "${guard.expectedFrontmost}" to the front with computer_open and try again.`
            : "Cannot type while SpecWithCode is in front. Bring the target app forward with computer_open and try again.",
        );
      }
    }
    throw error;
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

const APP_INFO_TIMEOUT_MS = 3_000;
const APP_ICON_MAX_CHARS = 96_000;

/** Folders that hold most apps, searched before Spotlight. */
const appFolders = () => [
  "/Applications",
  "/System/Applications",
  "/System/Applications/Utilities",
  "/Applications/Utilities",
  NodePath.join(NodeOS.homedir(), "Applications"),
];

/** Escapes a value for a quoted Spotlight query string. */
const spotlightQuoted = (value: string) => value.replace(/[\\'"*]/g, (char) => `\\${char}`);

async function isDirectory(path: string) {
  return NodeFSP.stat(path).then(
    (stats) => stats.isDirectory(),
    () => false,
  );
}

async function findAppBundle(name: string): Promise<string | undefined> {
  // A name with a path separator is not an app name; never let it walk out of the folders.
  if (!name.includes("/") && name !== "." && name !== "..") {
    for (const folder of appFolders()) {
      const candidate = NodePath.join(folder, `${name}.app`);
      if (await isDirectory(candidate)) return candidate;
    }
  }
  const query = `kMDItemContentType == 'com.apple.application-bundle' && kMDItemDisplayName == '${spotlightQuoted(name)}'`;
  const output = await execFile("/usr/bin/mdfind", [query], APP_INFO_TIMEOUT_MS).catch(() => "");
  const first = output.split("\n").find((line) => line.trim().endsWith(".app"));
  return first?.trim();
}

async function readBundleInfo(bundle: string) {
  const output = await execFile(
    "/usr/bin/plutil",
    ["-convert", "json", "-o", "-", NodePath.join(bundle, "Contents", "Info.plist")],
    APP_INFO_TIMEOUT_MS,
  ).catch(() => "");
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    const text = (key: string) => {
      const value = parsed[key];
      return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
    };
    return {
      bundleId: text("CFBundleIdentifier"),
      displayName: text("CFBundleDisplayName"),
      bundleName: text("CFBundleName"),
    };
  } catch {
    return { bundleId: undefined, displayName: undefined, bundleName: undefined };
  }
}

/** The running app's own name, by bundle id or path; undefined when it is not running. */
async function runningApplicationName(bundleId: string | undefined, bundle: string) {
  const output = await execFile(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", JXA_RUNNING_APP_NAME_SCRIPT, bundleId ?? "", bundle],
    APP_INFO_TIMEOUT_MS,
  ).catch(() => "");
  const name = output.trim();
  return name === "" ? undefined : name;
}

async function appIcon(bundle: string) {
  try {
    const image = await Electron.nativeImage.createThumbnailFromPath(bundle, {
      width: 64,
      height: 64,
    });
    if (image.isEmpty()) return undefined;
    const data = image.toPNG().toString("base64");
    if (data.length === 0 || data.length > APP_ICON_MAX_CHARS) return undefined;
    return { mimeType: "image/png" as const, data };
  } catch {
    return undefined;
  }
}

type ApplicationInfo = NonNullable<ComputerUseActionResult["application"]>;

async function lookUpApplication(name: string): Promise<ApplicationInfo> {
  const bundle = await findAppBundle(name);
  if (bundle === undefined) return { name };
  const [info, icon] = await Promise.all([readBundleInfo(bundle), appIcon(bundle)]);
  // Grants are keyed by this name, so it is the one the gate later sees as the
  // frontmost app or a window's owner: the running app's own name first.
  const runningName = await runningApplicationName(info.bundleId, bundle);
  return {
    name: applicationName({
      requested: name,
      runningName,
      displayName: info.displayName,
      bundleName: info.bundleName,
      fileName: NodePath.basename(bundle, ".app"),
    }),
    ...(info.bundleId === undefined ? {} : { bundleId: info.bundleId }),
    ...(icon === undefined ? {} : { icon }),
  };
}

/** The installed app's real name and icon; an unknown app comes back as named, without an icon. */
async function applicationInfo(name: string): Promise<ApplicationInfo> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<ApplicationInfo>((resolve) => {
    timer = setTimeout(() => resolve({ name }), APP_INFO_TIMEOUT_MS);
  });
  try {
    return await Promise.race([lookUpApplication(name).catch(() => ({ name })), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function resolveWindowCaptureContext(
  sessionKey: string,
  application: string | undefined,
  coordinateSpace: "window" | "display" | undefined,
  scene: ScreenScene | undefined,
): ActiveWindowCapture | undefined {
  if (coordinateSpace === "display") return undefined;
  const cached = windowCaptures.get(sessionKey);
  if (coordinateSpace === "window") {
    if (cached === undefined) {
      throw new ComputerUseInputError(
        `The captured window context for "${application ?? "the target app"}" is no longer available. Take a fresh computer_screenshot first.`,
      );
    }
    if (cached.status === "invalidated") {
      throw new ComputerUseInputError(cached.reason);
    }
    if (application !== undefined && !sameAppName(cached.application, application)) {
      throw new ComputerUseInputError(
        `The captured window context belongs to "${cached.application}", not "${application}". Take a fresh computer_screenshot first.`,
      );
    }
    if (scene === undefined || !isWindowCaptureFresh(scene, cached)) {
      const reason = `The captured window for "${cached.application}" moved, resized, or closed since the last screenshot. Take a fresh computer_screenshot first.`;
      setBounded(windowCaptures, sessionKey, {
        status: "invalidated",
        application: cached.application,
        reason,
      });
      throw new ComputerUseInputError(reason);
    }
    return cached;
  }
  if (
    application !== undefined &&
    cached !== undefined &&
    sameAppName(cached.application, application)
  ) {
    if (cached.status === "invalidated") {
      throw new ComputerUseInputError(cached.reason);
    }
    if (scene === undefined || !isWindowCaptureFresh(scene, cached)) {
      const reason = `The captured window for "${cached.application}" moved, resized, or closed since the last screenshot. Take a fresh computer_screenshot first.`;
      setBounded(windowCaptures, sessionKey, {
        status: "invalidated",
        application: cached.application,
        reason,
      });
      throw new ComputerUseInputError(reason);
    }
    return cached;
  }
  return undefined;
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

  const sessionKey = sessionKeyFor(action);
  let frontmost: string | undefined;
  let screenshot: ComputerUseActionResult["screenshot"];
  let application: ComputerUseActionResult["application"];
  let delivery: ComputerUseActionResult["delivery"];
  let backgroundFieldSelected: ComputerUseActionResult["backgroundFieldSelected"];
  let windowId: ComputerUseActionResult["windowId"];
  let bounds: ComputerUseActionResult["bounds"];

  switch (action.kind) {
    case "status":
      frontmost = await frontmostApplication();
      break;
    case "screenshot":
      if (action.application !== undefined) {
        const [captured, front] = await Promise.all([
          captureWindow(action.application, sessionKey),
          frontmostApplication(),
        ]);
        screenshot = captured.screenshot;
        windowId = captured.windowId;
        bounds = captured.bounds;
        frontmost = front;
      } else {
        windowCaptures.delete(sessionKey);
        [screenshot, frontmost] = await Promise.all([
          captureScreen(display),
          frontmostApplication(),
        ]);
      }
      break;
    case "click": {
      const needsScene =
        action.coordinateSpace === "window" ||
        action.application !== undefined ||
        windowCaptures.has(sessionKey);
      const scene = needsScene ? await readWindowsScene() : undefined;
      const activeCapture = resolveWindowCaptureContext(
        sessionKey,
        action.application,
        action.coordinateSpace,
        scene,
      );
      const hasWindowContext = activeCapture !== undefined;
      const point = hasWindowContext
        ? toWindowDisplayPoint(activeCapture.bounds, action.x, action.y)
        : toDisplayPoint(display, action.x, action.y);
      const isNamedMirroring =
        action.application !== undefined &&
        sameAppName(action.application, IPHONE_MIRRORING_PROCESS);
      const shouldCheckMirroring = action.application === undefined || isNamedMirroring;
      const mirrored = shouldCheckMirroring
        ? await runOnMirroring(action, display, point)
        : undefined;
      if (mirrored !== undefined) {
        backgroundFields.delete(sessionKey);
        frontmost = mirrored.frontmost;
        delivery = "foreground_hid";
        break;
      }
      if (isNamedMirroring) {
        backgroundFields.delete(sessionKey);
        throw new ComputerUseInputError(
          "iPhone Mirroring is covered by another window or not at that point, so nothing was sent to the phone. Bring iPhone Mirroring to the front with computer_open and try again.",
        );
      }
      const liveTargetWindow = hasWindowContext
        ? scene?.windows.find(
            (w) => w.windowId === activeCapture.windowId && w.pid === activeCapture.pid,
          )
        : action.application !== undefined && scene !== undefined
          ? findWindowAtPointForApplication(scene, point, action.application)
          : undefined;
      const targetPid = hasWindowContext ? activeCapture.pid : liveTargetWindow?.pid;
      const targetWindowId = hasWindowContext ? activeCapture.windowId : liveTargetWindow?.windowId;
      const targetTitle = hasWindowContext ? activeCapture.title : liveTargetWindow?.title;
      const targetBounds: ScreenArea | undefined = hasWindowContext
        ? activeCapture.bounds
        : liveTargetWindow === undefined
          ? undefined
          : {
              x: Math.round(liveTargetWindow.x),
              y: Math.round(liveTargetWindow.y),
              width: Math.round(liveTargetWindow.width),
              height: Math.round(liveTargetWindow.height),
            };
      if (
        canAttemptBackgroundAxClick(action) &&
        targetPid !== undefined &&
        targetPid > 0 &&
        targetPid !== process.pid &&
        targetWindowId !== undefined &&
        targetWindowId > 0 &&
        targetBounds !== undefined
      ) {
        const ax = await runAxAction({
          mode: "click",
          pid: targetPid,
          windowId: targetWindowId,
          expectedWindowBounds: targetBounds,
          expectedWindowTitle: targetTitle,
          x: point.x,
          y: point.y,
        });
        if (ax.ok) {
          if (
            ax.kind === "editable" &&
            action.application !== undefined &&
            targetBounds !== undefined
          ) {
            setBounded(backgroundFields, sessionKey, {
              status: "active",
              application: action.application,
              pid: targetPid,
              windowId: targetWindowId,
              bounds: targetBounds,
              title: targetTitle,
              x: point.x,
              y: point.y,
              role: ax.role,
              fieldKey: ax.fieldKey,
            });
            backgroundFieldSelected = true;
          } else {
            backgroundFields.delete(sessionKey);
            backgroundFieldSelected = false;
          }
          frontmost = ax.frontmostApplication ?? undefined;
          delivery = "background_ax";
          break;
        }
        if (
          ax.reason === "ax-window-occluded" ||
          ax.reason === "ax-window-mismatch" ||
          ax.reason === "ax-window-unverifiable" ||
          ax.reason === "ax-window-ambiguous"
        ) {
          backgroundFields.delete(sessionKey);
          throw new ComputerUseInputError(
            `Cannot click "${action.application ?? "the target app"}" in the background: the target window is occluded, ambiguous, or no longer matches the captured window (${ax.reason}). Take a fresh computer_screenshot or bring "${action.application ?? "the target app"}" forward with computer_open and try again.`,
          );
        }
        if (ax.reason === undefined || !AX_PRE_DISPATCH_FALLBACK_REASONS.has(ax.reason)) {
          backgroundFields.delete(sessionKey);
          throw new ComputerUseInputError(
            `Cannot confirm whether the background Accessibility click in "${action.application ?? "the target app"}" completed (${ax.reason ?? "unknown"}). Take a fresh computer_screenshot to verify before retrying.`,
          );
        }
      }
      backgroundFields.delete(sessionKey);
      if (action.application !== undefined) {
        const fallbackScene = scene ?? (await readWindowsScene());
        const safety =
          fallbackScene === undefined
            ? ({ ok: false, actualOwner: "an unknown application" } as const)
            : canSafelyFallbackHidClick(
                fallbackScene,
                point,
                action.application,
                process.pid,
                targetWindowId,
              );
        if (!safety.ok) {
          throw new ComputerUseInputError(
            `Cannot click "${action.application}" in the background: Accessibility action was unavailable and the target point is currently covered by ${safety.actualOwner}. Bring "${action.application}" forward with computer_open and try again.`,
          );
        }
      }
      const steps = hasWindowContext
        ? clickStepsAtPoint(point, {
            button: action.button,
            count: action.count,
            modifiers: action.modifiers,
          })
        : actionSteps(action, display);
      try {
        frontmost = await replay(steps, {
          yieldForHumanInput: true,
          restoreCursor: true,
          forbidPid: process.pid,
          ...(action.application === undefined
            ? {}
            : {
                expectedPointOwner: {
                  x: point.x,
                  y: point.y,
                  application: action.application,
                  ...(targetWindowId === undefined ? {} : { windowId: targetWindowId }),
                  ...(hasWindowContext ? { bounds: activeCapture.bounds } : {}),
                },
              }),
        });
      } catch (error) {
        if (error instanceof Error) {
          if (error.message.includes("human-moved")) {
            throw new ComputerUseInputError(
              "Stopped clicking because the user moved the pointer during the action. Try again when the pointer is idle.",
            );
          }
          if (
            error.message.includes("point-owner-changed") ||
            error.message.includes("forbidden-frontmost-pid")
          ) {
            throw new ComputerUseInputError(
              action.application !== undefined
                ? `Cannot click "${action.application}" in the background: the window at the target point changed before input could be sent. Bring "${action.application}" forward with computer_open and try again.`
                : "Cannot click while SpecWithCode is in front. Bring the target app forward with computer_open and try again.",
            );
          }
        }
        throw error;
      }
      delivery = "foreground_hid";
      break;
    }
    case "type": {
      const isNamedMirroring =
        action.application !== undefined &&
        sameAppName(action.application, IPHONE_MIRRORING_PROCESS);
      const shouldCheckMirroring = action.application === undefined || isNamedMirroring;
      const mirrored = shouldCheckMirroring ? await runOnMirroring(action, display) : undefined;
      if (mirrored !== undefined) {
        backgroundFields.delete(sessionKey);
        frontmost = mirrored.frontmost;
        delivery = "foreground_hid";
        break;
      }
      if (isNamedMirroring) {
        backgroundFields.delete(sessionKey);
        throw new ComputerUseInputError(
          "iPhone Mirroring is not in front, so nothing was typed to the phone. Bring iPhone Mirroring to the front with computer_open and try again.",
        );
      }
      const field = backgroundFields.get(sessionKey);
      if (
        action.requireBackgroundField === true &&
        (field === undefined ||
          (action.application !== undefined && !sameAppName(field.application, action.application)))
      ) {
        throw new ComputerUseInputError(
          `The previously selected background field in "${action.application ?? "the target app"}" is no longer available. Take a fresh screenshot and click the field again before typing.`,
        );
      }
      const scene =
        field !== undefined || action.application !== undefined
          ? await readWindowsScene()
          : undefined;
      if (
        field !== undefined &&
        action.application !== undefined &&
        sameAppName(field.application, action.application)
      ) {
        if (field.status === "invalidated") {
          throw new ComputerUseInputError(field.reason);
        }
        if (field.pid !== process.pid) {
          if (scene === undefined || !isWindowCaptureFresh(scene, field)) {
            const reason = `The previously selected field in "${action.application}" moved, resized, or closed since it was clicked. Take a fresh screenshot and click the field again before typing.`;
            setBounded(backgroundFields, sessionKey, {
              status: "invalidated",
              application: action.application,
              reason,
            });
            throw new ComputerUseInputError(reason);
          }
          const ax = await runAxAction({
            mode: "type",
            pid: field.pid,
            windowId: field.windowId,
            expectedWindowBounds: field.bounds,
            expectedWindowTitle: field.title,
            x: field.x,
            y: field.y,
            text: action.text,
            expectedRole: field.role,
            expectedFieldKey: field.fieldKey,
          });
          if (ax.ok) {
            frontmost = ax.frontmostApplication ?? undefined;
            delivery = "background_ax";
            break;
          }
          const reason =
            ax.reason === "ax-set-uncertain"
              ? `Background text input into "${action.application}" returned an uncertain Accessibility result (${ax.reason}); the text may already have been inserted. Take a fresh screenshot to inspect the field before retrying.`
              : `The previously selected field in "${action.application}" could not be updated in the background (${ax.reason ?? "ax-failed"}). Take a fresh screenshot and click the field again before typing.`;
          setBounded(backgroundFields, sessionKey, {
            status: "invalidated",
            application: action.application,
            reason,
          });
          throw new ComputerUseInputError(reason);
        }
      }
      if (action.application !== undefined) {
        const safety =
          scene === undefined
            ? ({ ok: false, actualFrontmost: "an unknown application" } as const)
            : canSafelyFallbackHidType(scene, action.application);
        if (!safety.ok) {
          throw new ComputerUseInputError(
            `Cannot type into "${action.application}" in the background: Accessibility text input was unavailable and ${safety.actualFrontmost} is currently in front. Bring "${action.application}" forward with computer_open and try again.`,
          );
        }
      }
      frontmost = await typeText(action.text, {
        expectedFrontmost: action.application,
        forbidPid: process.pid,
      });
      delivery = "foreground_hid";
      break;
    }
    case "scroll": {
      backgroundFields.delete(sessionKey);
      const needsScene =
        action.coordinateSpace === "window" ||
        action.application !== undefined ||
        windowCaptures.has(sessionKey);
      const scene = needsScene ? await readWindowsScene() : undefined;
      const activeCapture = resolveWindowCaptureContext(
        sessionKey,
        action.application,
        action.coordinateSpace,
        scene,
      );
      const hasWindowContext = activeCapture !== undefined;
      const point = hasWindowContext
        ? toWindowDisplayPoint(activeCapture.bounds, action.x, action.y)
        : toDisplayPoint(display, action.x, action.y);
      const isNamedMirroring =
        action.application !== undefined &&
        sameAppName(action.application, IPHONE_MIRRORING_PROCESS);
      const shouldCheckMirroring = action.application === undefined || isNamedMirroring;
      const mirrored = shouldCheckMirroring
        ? await runOnMirroring(action, display, point)
        : undefined;
      if (mirrored !== undefined) {
        frontmost = mirrored.frontmost;
      } else {
        if (isNamedMirroring) {
          throw new ComputerUseInputError(
            "iPhone Mirroring is covered by another window or not at that point, so nothing was scrolled on the phone. Bring iPhone Mirroring to the front with computer_open and try again.",
          );
        }
        if (action.application !== undefined) {
          const safety =
            scene === undefined
              ? ({ ok: false, actualOwner: "an unknown application" } as const)
              : canSafelyFallbackHidClick(
                  scene,
                  point,
                  action.application,
                  process.pid,
                  hasWindowContext ? activeCapture.windowId : undefined,
                );
          if (!safety.ok) {
            throw new ComputerUseInputError(
              `Cannot scroll "${action.application}" in the background: the target point is currently covered by ${safety.actualOwner}. Bring "${action.application}" forward with computer_open and try again.`,
            );
          }
        }
        try {
          frontmost = await replay(scrollStepsAtPoint(point, action.direction, action.amount), {
            yieldForHumanInput: true,
            restoreCursor: true,
            forbidPid: process.pid,
            ...(action.application === undefined
              ? {}
              : {
                  expectedPointOwner: {
                    x: point.x,
                    y: point.y,
                    application: action.application,
                    ...(hasWindowContext
                      ? { windowId: activeCapture.windowId, bounds: activeCapture.bounds }
                      : {}),
                  },
                }),
          });
        } catch (error) {
          if (error instanceof Error) {
            if (error.message.includes("human-moved")) {
              throw new ComputerUseInputError(
                "Stopped scrolling because the user moved the pointer during the action. Try again when the pointer is idle.",
              );
            }
            if (
              error.message.includes("point-owner-changed") ||
              error.message.includes("forbidden-frontmost-pid")
            ) {
              throw new ComputerUseInputError(
                action.application !== undefined
                  ? `Cannot scroll "${action.application}" in the background: the window at the target point changed before input could be sent. Bring "${action.application}" forward with computer_open and try again.`
                  : "Cannot scroll while SpecWithCode is in front. Bring the target app forward with computer_open and try again.",
              );
            }
          }
          throw error;
        }
      }
      delivery = "foreground_hid";
      break;
    }
    case "open":
      windowCaptures.delete(sessionKey);
      backgroundFields.delete(sessionKey);
      await open(action);
      frontmost = await frontmostApplication();
      break;
    case "appInfo":
      application = await applicationInfo(action.application);
      break;
    case "appAt": {
      const owner = await applicationAt(display, action.x, action.y);
      if (owner !== undefined) application = { name: owner };
      break;
    }
    case "move": {
      backgroundFields.delete(sessionKey);
      const needsScene =
        action.coordinateSpace === "window" ||
        action.application !== undefined ||
        windowCaptures.has(sessionKey);
      const scene = needsScene ? await readWindowsScene() : undefined;
      const activeCapture = resolveWindowCaptureContext(
        sessionKey,
        action.application,
        action.coordinateSpace,
        scene,
      );
      const point =
        activeCapture !== undefined
          ? toWindowDisplayPoint(activeCapture.bounds, action.x, action.y)
          : toDisplayPoint(display, action.x, action.y);
      frontmost = await replay(moveStepsAtPoint(point));
      break;
    }
    case "drag": {
      backgroundFields.delete(sessionKey);
      const needsScene =
        action.coordinateSpace === "window" ||
        action.application !== undefined ||
        action.toApplication !== undefined ||
        windowCaptures.has(sessionKey);
      const scene = needsScene ? await readWindowsScene() : undefined;
      const activeCapture = resolveWindowCaptureContext(
        sessionKey,
        action.application,
        action.coordinateSpace,
        scene,
      );
      const hasWindowContext = activeCapture !== undefined;
      const from = hasWindowContext
        ? toWindowDisplayPoint(activeCapture.bounds, action.fromX, action.fromY)
        : toDisplayPoint(display, action.fromX, action.fromY);
      const to = hasWindowContext
        ? toWindowDisplayPoint(activeCapture.bounds, action.toX, action.toY)
        : toDisplayPoint(display, action.toX, action.toY);
      const fromApplication = action.application;
      const toApplication = action.toApplication ?? action.application;
      const isNamedMirroring =
        fromApplication !== undefined &&
        sameAppName(fromApplication, IPHONE_MIRRORING_PROCESS) &&
        toApplication !== undefined &&
        sameAppName(toApplication, IPHONE_MIRRORING_PROCESS);
      const shouldCheckMirroring =
        (fromApplication === undefined && toApplication === undefined) || isNamedMirroring;
      const mirrored = shouldCheckMirroring
        ? await runOnMirroring(action, display, from, to)
        : undefined;
      if (mirrored !== undefined) {
        frontmost = mirrored.frontmost;
        delivery = "foreground_hid";
        break;
      }
      if (isNamedMirroring) {
        throw new ComputerUseInputError(
          "iPhone Mirroring is covered by another window or not at that point, so nothing was dragged on the phone. Bring iPhone Mirroring to the front with computer_open and try again.",
        );
      }
      if (fromApplication !== undefined) {
        const startSafety =
          scene === undefined
            ? ({ ok: false, actualOwner: "an unknown application" } as const)
            : canSafelyFallbackHidClick(
                scene,
                from,
                fromApplication,
                process.pid,
                hasWindowContext ? activeCapture.windowId : undefined,
              );
        if (!startSafety.ok) {
          throw new ComputerUseInputError(
            `Cannot drag in "${fromApplication}" in the background: the start point is currently covered by ${startSafety.actualOwner}. Bring "${fromApplication}" forward with computer_open and try again.`,
          );
        }
      }
      if (toApplication !== undefined) {
        const dropSafety =
          scene === undefined
            ? ({ ok: false, actualOwner: "an unknown application" } as const)
            : canSafelyFallbackHidClick(
                scene,
                to,
                toApplication,
                process.pid,
                hasWindowContext ? activeCapture.windowId : undefined,
              );
        if (!dropSafety.ok) {
          throw new ComputerUseInputError(
            `Cannot drag to "${toApplication}" in the background: the drop point is currently covered by ${dropSafety.actualOwner}. Bring "${toApplication}" forward with computer_open and try again.`,
          );
        }
      }
      try {
        frontmost = await replay(dragStepsAtPoints(from, to), {
          yieldForHumanInput: true,
          restoreCursor: true,
          forbidPid: process.pid,
          ...(fromApplication === undefined
            ? {}
            : {
                expectedPointOwner: {
                  x: from.x,
                  y: from.y,
                  application: fromApplication,
                  ...(hasWindowContext
                    ? { windowId: activeCapture.windowId, bounds: activeCapture.bounds }
                    : {}),
                },
              }),
          ...(toApplication === undefined
            ? {}
            : {
                expectedDropOwner: {
                  x: to.x,
                  y: to.y,
                  application: toApplication,
                  ...(hasWindowContext
                    ? { windowId: activeCapture.windowId, bounds: activeCapture.bounds }
                    : {}),
                },
              }),
        });
      } catch (error) {
        if (error instanceof Error) {
          if (error.message.includes("human-moved")) {
            throw new ComputerUseInputError(
              "Stopped dragging because the user moved the pointer during the action. Try again when the pointer is idle.",
            );
          }
          if (
            error.message.includes("point-owner-changed") ||
            error.message.includes("drop-owner-changed") ||
            error.message.includes("drag-path-owner-changed") ||
            error.message.includes("forbidden-frontmost-pid")
          ) {
            throw new ComputerUseInputError(
              fromApplication !== undefined
                ? `Cannot drag in "${fromApplication}" in the background: the window at the start or drop point changed before input could complete. Bring "${fromApplication}" forward with computer_open and try again.`
                : "Cannot drag while SpecWithCode is in front. Bring the target app forward with computer_open and try again.",
            );
          }
        }
        throw error;
      }
      delivery = "foreground_hid";
      break;
    }
    case "key": {
      backgroundFields.delete(sessionKey);
      const isNamedMirroringKey =
        action.application !== undefined &&
        sameAppName(action.application, IPHONE_MIRRORING_PROCESS);
      const shouldCheckMirroringKey = action.application === undefined || isNamedMirroringKey;
      const mirrored = shouldCheckMirroringKey ? await runOnMirroring(action, display) : undefined;
      if (mirrored !== undefined) {
        frontmost = mirrored.frontmost;
      } else {
        try {
          frontmost = await replay(actionSteps(action, display), {
            yieldForHumanInput: true,
            forbidPid: process.pid,
            ...(action.application === undefined ? {} : { expectedFrontmost: action.application }),
          });
        } catch (error) {
          if (
            error instanceof Error &&
            (error.message.includes("not-frontmost-app") ||
              error.message.includes("forbidden-frontmost-pid"))
          ) {
            throw new ComputerUseInputError(
              action.application !== undefined
                ? `Cannot send keys to "${action.application}": the frontmost app changed before input could be sent. Bring "${action.application}" forward with computer_open and try again.`
                : "Cannot send keys while SpecWithCode is in front. Bring the target app forward with computer_open and try again.",
            );
          }
          throw error;
        }
      }
      delivery = "foreground_hid";
      break;
    }
    default: {
      backgroundFields.delete(sessionKey);
      const mirrored = await runOnMirroring(action, display);
      frontmost =
        mirrored === undefined
          ? await replay(actionSteps(action, display), {
              yieldForHumanInput: true,
              forbidPid: process.pid,
            })
          : mirrored.frontmost;
      delivery = "foreground_hid";
    }
  }

  const cursor = Electron.screen.getCursorScreenPoint();
  return {
    platform: "macos",
    permissions,
    display: screenshotSize(display),
    cursor: toScreenshotPoint(display, cursor.x, cursor.y),
    ...(frontmost === undefined ? {} : { frontmostApplication: frontmost }),
    ...(screenshot === undefined ? {} : { screenshot }),
    ...(delivery === undefined ? {} : { delivery }),
    ...(backgroundFieldSelected === undefined ? {} : { backgroundFieldSelected }),
    ...(windowId === undefined ? {} : { windowId }),
    ...(bounds === undefined ? {} : { bounds }),
    ...(application === undefined ? {} : { application }),
  };
}
