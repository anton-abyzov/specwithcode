// @effect-diagnostics nodeBuiltinImport:off -- Electron main-process capture: a child process, one temporary file and a digest, outside any Effect fiber.
/**
 * Looking at this Mac's screen for a screen sharing session (1490). Runs in
 * the app's main process, which holds the Screen Recording grant.
 *
 * Stills come from Electron's `desktopCapturer`. Without the grant it can hang
 * instead of failing, so a call that takes over two seconds is abandoned and
 * `/usr/sbin/screencapture` is used for the rest of the session: slower, and
 * through a file that lives for one read in a folder only this user can open.
 * Neither path draws the cursor; its position travels beside the picture.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  SCREEN_SHARE_JPEG_QUALITY,
  SCREEN_SHARE_MAX_FRAME_EDGE,
  type ScreenShareDisplay,
} from "@specweave-studio/contracts";
import * as Electron from "electron";

import {
  fitWithin,
  makeFrameGrabber,
  makeLockWatch,
  pointerInFrame,
  withTimeout,
  type Still,
} from "./screenCapture.logic.ts";
import type { ScreenShareSessionDeps } from "./screenShareSession.logic.ts";

const CAPTURER_TIMEOUT_MS = 2_000;
const FALLBACK_TIMEOUT_MS = 5_000;

export const screenRecordingGranted = (): boolean =>
  Electron.systemPreferences.getMediaAccessStatus("screen") === "granted";

const displayOf = (displayId: string) =>
  Electron.screen.getAllDisplays().find((display) => String(display.id) === displayId);

const toStill = (image: Electron.NativeImage): Still | null => {
  if (image.isEmpty()) return null;
  const size = image.getSize();
  const fitted = fitWithin(size.width, size.height, SCREEN_SHARE_MAX_FRAME_EDGE);
  const sized = fitted.width === size.width ? image : image.resize({ ...fitted, quality: "good" });
  return { jpeg: sized.toJPEG(SCREEN_SHARE_JPEG_QUALITY), ...sized.getSize() };
};

/** What a session needs from the screen, and how to let go of it. */
export type ScreenCapture = ScreenShareSessionDeps["capture"] & {
  readonly dispose: () => void;
};

export const makeScreenCapture = (): ScreenCapture => {
  const lock = makeLockWatch(() => Electron.powerMonitor.getSystemIdleState(24 * 60 * 60));
  Electron.powerMonitor.on("lock-screen", lock.onLock);
  Electron.powerMonitor.on("unlock-screen", lock.onUnlock);

  let capturerHung = false;
  let folder: string | null = null;
  let blocker: number | null = null;

  const fromCapturer = async (displayId: string): Promise<Still | null> => {
    const display = displayOf(displayId);
    if (display === undefined) return null;
    const thumbnailSize = fitWithin(
      display.size.width * display.scaleFactor,
      display.size.height * display.scaleFactor,
      SCREEN_SHARE_MAX_FRAME_EDGE,
    );
    const sources = await withTimeout(
      Electron.desktopCapturer.getSources({ types: ["screen"], thumbnailSize }),
      CAPTURER_TIMEOUT_MS,
      null,
    );
    if (sources === null) {
      capturerHung = true;
      return null;
    }
    const source = sources.find((candidate) => candidate.display_id === displayId) ?? null;
    return source === null ? null : toStill(source.thumbnail);
  };

  const fromScreencapture = (displayId: string): Promise<Still | null> =>
    new Promise((resolve) => {
      const displays = Electron.screen.getAllDisplays();
      const primary = Electron.screen.getPrimaryDisplay().id;
      // `screencapture -D` counts from 1 with the main display first.
      const ordered = [...displays].sort(
        (a, b) => Number(b.id === primary) - Number(a.id === primary),
      );
      const index = ordered.findIndex((display) => String(display.id) === displayId);
      if (index < 0) return resolve(null);
      // mkdtemp makes the folder 0700: other users cannot read the one file in it.
      folder ??= NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "specwithcode-screen-"));
      const file = NodePath.join(folder, `${NodeCrypto.randomUUID()}.jpg`);
      NodeChildProcess.execFile(
        "/usr/sbin/screencapture",
        ["-x", "-t", "jpg", "-D", String(index + 1), file],
        { timeout: FALLBACK_TIMEOUT_MS },
        (error) => {
          let still: Still | null = null;
          try {
            if (error === null)
              still = toStill(Electron.nativeImage.createFromBuffer(NodeFS.readFileSync(file)));
          } catch {
            still = null;
          } finally {
            NodeFS.rmSync(file, { force: true });
          }
          resolve(still);
        },
      );
    });

  const grab = makeFrameGrabber({
    lockState: lock.state,
    still: async (displayId) =>
      (capturerHung ? null : await fromCapturer(displayId)) ??
      (capturerHung ? await fromScreencapture(displayId) : null),
    pointer: (displayId, frame) => {
      const display = displayOf(displayId);
      return display === undefined
        ? undefined
        : pointerInFrame(Electron.screen.getCursorScreenPoint(), display.bounds, frame);
    },
    digest: (jpeg) => NodeCrypto.createHash("sha1").update(jpeg).digest("base64"),
  });

  const removeFolder = () => {
    if (folder !== null) NodeFS.rmSync(folder, { recursive: true, force: true });
    folder = null;
  };

  return {
    displays: (): ReadonlyArray<ScreenShareDisplay> => {
      const primary = Electron.screen.getPrimaryDisplay().id;
      return Electron.screen.getAllDisplays().map((display, index) => ({
        id: String(display.id),
        label: display.label || `Display ${index + 1}`,
        primary: display.id === primary,
      }));
    },
    grab,
    keepAwake: (on) => {
      if (on && blocker === null) {
        // A new session gets a fresh try at the fast path.
        capturerHung = false;
        blocker = Electron.powerSaveBlocker.start("prevent-display-sleep");
      } else if (!on && blocker !== null) {
        if (Electron.powerSaveBlocker.isStarted(blocker)) Electron.powerSaveBlocker.stop(blocker);
        blocker = null;
        removeFolder();
      }
    },
    dispose: () => {
      Electron.powerMonitor.removeListener("lock-screen", lock.onLock);
      Electron.powerMonitor.removeListener("unlock-screen", lock.onUnlock);
      if (blocker !== null && Electron.powerSaveBlocker.isStarted(blocker))
        Electron.powerSaveBlocker.stop(blocker);
      blocker = null;
      removeFolder();
    },
  };
};
