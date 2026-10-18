// @effect-diagnostics globalTimers:off -- Clipboard restore waits for the target app to read a paste.
// @effect-diagnostics globalDate:off -- Permission prompts are throttled outside Effect, at the native boundary.
// @effect-diagnostics nodeBuiltinImport:off -- Native input and capture run as child processes of the app.
import {
  COMPUTER_USE_PERMISSION_WAIT_MS,
  COMPUTER_USE_SETTINGS_URL_PREFIX,
  type ComputerUseAction,
  type ComputerUseActionResult,
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

export function currentPermissions(): ComputerUsePermissions {
  return {
    screenRecording: Electron.systemPreferences.getMediaAccessStatus("screen") === "granted",
    accessibility: Electron.systemPreferences.isTrustedAccessibilityClient(false),
  };
}

function primaryDisplay(): DisplayGeometry {
  const { width, height } = Electron.screen.getPrimaryDisplay().size;
  return { width, height };
}

type ComputerUsePermission = "screen-recording" | "accessibility";

const permissionGranted = (permission: ComputerUsePermission) =>
  permission === "accessibility"
    ? Electron.systemPreferences.isTrustedAccessibilityClient(false)
    : Electron.systemPreferences.getMediaAccessStatus("screen") === "granted";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Asks for a permission at most once a minute, however often an agent retries. */
const lastPermissionPrompt = new Map<MacPermission, number>();

/**
 * Asks the user for a missing permission the way macOS expects, with its own
 * prompt and the matching Privacy & Security pane, then holds the action until
 * they allow it so the agent's first request still goes through.
 */
async function ensurePermission(
  permission: ComputerUsePermission,
  onPrompt: (permission: MacPermission) => void,
) {
  if (permissionGranted(permission)) return;
  const now = Date.now();
  if (now - (lastPermissionPrompt.get(permission) ?? 0) >= 60_000) {
    lastPermissionPrompt.set(permission, now);
    if (permission === "accessibility") {
      // Shows the system prompt and adds the app to the Accessibility list.
      Electron.systemPreferences.isTrustedAccessibilityClient(true);
    } else if (Electron.systemPreferences.getMediaAccessStatus("screen") === "not-determined") {
      // A first capture attempt shows the system prompt and adds the app to the list.
      await Electron.desktopCapturer
        .getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } })
        .catch(() => []);
      if (permissionGranted(permission)) return;
    }
    void Electron.shell.openExternal(MAC_PERMISSION_SETTINGS_URLS[permission]);
    onPrompt(permission);
  }
  const deadline = Date.now() + COMPUTER_USE_PERMISSION_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(1_000);
    if (permissionGranted(permission)) return;
  }
  throw new Error(PERMISSION_REASON[permission]);
}

const PERMISSION_REASON: Record<ComputerUsePermission, string> = {
  "screen-recording":
    "The user did not allow Screen Recording for SpecWithCode within two minutes, so it cannot see the screen. System Settings is open at Privacy & Security > Screen Recording: ask the user to turn on SpecWithCode there (and choose Quit & Reopen if macOS asks), then try again.",
  accessibility:
    "The user did not allow Accessibility for SpecWithCode within two minutes, so it cannot click or type. System Settings is open at Privacy & Security > Accessibility: ask the user to turn on SpecWithCode there, then try again.",
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
  if (action.kind === "screenshot") await ensurePermission("screen-recording", onPermissionPrompt);
  else if (action.kind !== "status" && action.kind !== "open") {
    await ensurePermission("accessibility", onPermissionPrompt);
  }
  const permissions = currentPermissions();
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
