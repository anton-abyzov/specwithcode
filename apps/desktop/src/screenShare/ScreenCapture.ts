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
  SCREEN_SHARE_FRAME_BUDGET_BYTES,
  type ScreenShareDisplay,
} from "@specweave-studio/contracts";
import * as Electron from "electron";

import {
  fitWithin,
  makeFrameGrabber,
  makeLockWatch,
  pointerInFrame,
  SAME_PICTURE,
  withTimeout,
  type Still,
} from "./screenCapture.logic.ts";
import { encodeWithinBudget, pictureFor, type PictureTarget } from "./screenSharePicture.logic.ts";
import type { ScreenShareLook, ScreenShareSessionDeps } from "./screenShareSession.logic.ts";

const CAPTURER_TIMEOUT_MS = 2_000;
const FALLBACK_TIMEOUT_MS = 5_000;

export const screenRecordingGranted = (): boolean =>
  Electron.systemPreferences.getMediaAccessStatus("screen") === "granted";

const displayOf = (displayId: string) =>
  Electron.screen.getAllDisplays().find((display) => String(display.id) === displayId);

/**
 * One picture made ready to send: compared with the one sent last before it is
 * encoded, so a still screen costs no encode, then encoded within the budget.
 */
const toStill = (
  image: Electron.NativeImage,
  target: PictureTarget,
  look: ScreenShareLook | undefined,
  grabMs: number,
): Still | typeof SAME_PICTURE | null => {
  if (image.isEmpty()) return null;
  const size = image.getSize();
  const fitted = fitWithin(size.width, size.height, target.maxEdge);
  const sized = fitted.width === size.width ? image : image.resize({ ...fitted, quality: "good" });
  const { width, height } = sized.getSize();
  const digest = `${width}x${height}:${NodeCrypto.createHash("sha1").update(sized.toBitmap()).digest("base64")}`;
  if (look !== undefined && digest === look.previousDigest) return SAME_PICTURE;
  const encodeStart = performance.now();
  const encoded = encodeWithinBudget(
    (edge, quality) => {
      const smaller = fitWithin(width, height, edge);
      const picture =
        smaller.width === width ? sized : sized.resize({ ...smaller, quality: "good" });
      return picture.toJPEG(quality);
    },
    { maxEdge: Math.max(width, height), quality: target.quality },
    SCREEN_SHARE_FRAME_BUDGET_BYTES,
  );
  if (encoded === null) return null;
  const out = fitWithin(width, height, encoded.maxEdge);
  return {
    jpeg: encoded.jpeg,
    width: out.width,
    height: out.height,
    digest,
    grabMs: Math.round(grabMs),
    encodeMs: Math.round(performance.now() - encodeStart),
    quality: encoded.quality,
  };
};

const targetFor = (display: Electron.Display, look: ScreenShareLook | undefined) =>
  pictureFor(look?.viewport ?? null, {
    width: display.size.width * display.scaleFactor,
    height: display.size.height * display.scaleFactor,
  });

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

  const fromCapturer = async (
    displayId: string,
    look: ScreenShareLook | undefined,
  ): Promise<Still | typeof SAME_PICTURE | null> => {
    const display = displayOf(displayId);
    if (display === undefined) return null;
    const target = targetFor(display, look);
    const thumbnailSize = fitWithin(
      display.size.width * display.scaleFactor,
      display.size.height * display.scaleFactor,
      target.maxEdge,
    );
    const grabStart = performance.now();
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
    return source === null
      ? null
      : toStill(source.thumbnail, target, look, performance.now() - grabStart);
  };

  const fromScreencapture = (
    displayId: string,
    look: ScreenShareLook | undefined,
  ): Promise<Still | typeof SAME_PICTURE | null> =>
    new Promise((resolve) => {
      const grabStart = performance.now();
      const display = displayOf(displayId);
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
          let still: Still | typeof SAME_PICTURE | null = null;
          try {
            if (error === null && display !== undefined)
              still = toStill(
                Electron.nativeImage.createFromBuffer(NodeFS.readFileSync(file)),
                targetFor(display, look),
                look,
                performance.now() - grabStart,
              );
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
    still: async (displayId, look) =>
      (capturerHung ? null : await fromCapturer(displayId, look)) ??
      (capturerHung ? await fromScreencapture(displayId, look) : null),
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
