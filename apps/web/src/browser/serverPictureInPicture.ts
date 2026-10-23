import {
  createPreviewFramePainter,
  createPreviewStreamClient,
  type PreviewStreamClient,
} from "@specweave-studio/client-runtime/preview/server-browser-stream";
import type { EnvironmentId } from "@specweave-studio/contracts";
import { useSyncExternalStore } from "react";

import { toastManager } from "~/components/ui/toast";
import { readPreviewStreamAccess } from "~/state/previewStream";

interface WebKitVideo {
  webkitSetPresentationMode?: (mode: string) => void;
  webkitPresentationMode?: string;
}

interface ActivePictureInPicture {
  readonly key: string;
  readonly stop: () => void;
}

// Owns its stream outside React so the floating window survives panel unmounts.
export const SERVER_PICTURE_IN_PICTURE_STARTUP_TIMEOUT_MS = 10_000;

let active: ActivePictureInPicture | null = null;
const listeners = new Set<() => void>();
// Native entry is not cancellable. Serialize entry and exit so a late OS reply
// from a closed preview cannot displace the replacement's floating window.
let nativePresentationChange: Promise<unknown> = Promise.resolve();
const changeNativePresentation = <T>(run: () => Promise<T>): Promise<T> => {
  const change = nativePresentationChange.then(run);
  nativePresentationChange = change.catch(() => undefined);
  return change;
};

const emit = () => {
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const serverPictureInPictureKey = (threadId: string, tabId: string) =>
  JSON.stringify([threadId, tabId]);

/** Chromium and Safari float a canvas-captured video; Firefox has no API for it. */
export function supportsServerPictureInPicture(): boolean {
  if (typeof document === "undefined") return false;
  if (typeof HTMLCanvasElement.prototype.captureStream !== "function") return false;
  const video = HTMLVideoElement.prototype as HTMLVideoElement & WebKitVideo;
  return (
    (document.pictureInPictureEnabled && typeof video.requestPictureInPicture === "function") ||
    typeof video.webkitSetPresentationMode === "function"
  );
}

export function useServerPictureInPictureKey(): string | null {
  return useSyncExternalStore(
    subscribe,
    () => active?.key ?? null,
    () => null,
  );
}

export function closeServerPictureInPicture(): void {
  const current = active;
  active = null;
  current?.stop();
  emit();
}

/** Open during user activation, seeding the video with the currently visible frame. */
export async function openServerPictureInPicture(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly tabId: string;
  readonly seed: HTMLCanvasElement | null;
}): Promise<void> {
  closeServerPictureInPicture();
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  const seed = input.seed && input.seed.width > 0 && input.seed.height > 0 ? input.seed : null;
  canvas.width = seed?.width ?? 640;
  canvas.height = seed?.height ?? 400;
  // The capture emits a frame per draw, so the seed is drawn after it starts.
  const stream = canvas.captureStream();
  if (seed) context?.drawImage(seed, 0, 0);
  else context?.fillRect(0, 0, canvas.width, canvas.height);
  const video = document.createElement("video") as HTMLVideoElement & WebKitVideo;
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  // Safari only floats a video that is in the document.
  video.style.cssText =
    "position:fixed;right:0;bottom:0;width:1px;height:1px;opacity:0;pointer-events:none";
  document.body.append(video);

  const painter = createPreviewFramePainter(canvas);
  let client: PreviewStreamClient | null = null;
  let stopped = false;
  let refusals = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let cancelStartup = () => {};
  let removeMetadataListeners = () => {};
  const interrupted = new Promise<void>((resolve) => {
    cancelStartup = resolve;
  });
  const leaveOwnedPresentation = async () => {
    // An old startup can finish after a replacement. Never close that replacement.
    if (document.pictureInPictureElement === video) {
      await document.exitPictureInPicture().catch(() => undefined);
    } else if (video.webkitPresentationMode === "picture-in-picture") {
      video.webkitSetPresentationMode?.("inline");
    }
  };
  const onLeave = () => {
    if (active === current) closeServerPictureInPicture();
  };
  const failLivePreview = (description: string) => {
    if (stopped) return;
    onLeave();
    toastManager.add({ type: "error", title: "Live preview disconnected", description });
  };
  const connect = async (refresh: boolean) => {
    const access = await readPreviewStreamAccess(input.environmentId, refresh);
    if (stopped) return;
    if (!access)
      throw new Error("Live preview access is unavailable. Reopen the preview and try again.");
    client?.stop();
    client = createPreviewStreamClient(
      {
        access,
        threadId: input.threadId,
        tabId: input.tabId,
        maxWidth: 1280,
        maxHeight: 1280,
        interactive: false,
      },
      {
        onFrame: (jpeg) => {
          refusals = 0;
          painter.paint(jpeg);
        },
        onViewport: () => undefined,
        onConnectedChange: () => undefined,
        onUnauthorized: () => {
          if (stopped) return;
          if (refusals >= 5) {
            failLivePreview("The preview could not renew access. Reopen the preview to reconnect.");
            return;
          }
          if (retryTimer !== null) clearTimeout(retryTimer);
          retryTimer = setTimeout(
            () => {
              retryTimer = null;
              void connect(true).catch(() =>
                failLivePreview(
                  "The preview could not renew access. Reopen the preview to reconnect.",
                ),
              );
            },
            1_000 * 2 ** refusals++,
          );
        },
        onGone: onLeave,
        onHostSetup: () =>
          failLivePreview("The browser host needs setup. Open the preview panel for setup steps."),
      },
    );
  };

  const onPresentationMode = () => {
    if (video.webkitPresentationMode !== "picture-in-picture") onLeave();
  };
  const current: ActivePictureInPicture = {
    key: serverPictureInPictureKey(input.threadId, input.tabId),
    stop: () => {
      void changeNativePresentation(leaveOwnedPresentation).catch(() => undefined);
      if (stopped) return;
      stopped = true;
      cancelStartup();
      removeMetadataListeners();
      if (retryTimer !== null) clearTimeout(retryTimer);
      client?.stop();
      painter.stop();
      video.removeEventListener("leavepictureinpicture", onLeave);
      video.removeEventListener("webkitpresentationmodechanged", onPresentationMode);
      for (const track of stream.getTracks()) track.stop();
      video.srcObject = null;
      video.remove();
    },
  };
  active = current;
  emit();

  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timedOut = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () =>
        reject(
          new Error(
            "The live preview did not become ready within 10 seconds. Try opening it again.",
          ),
        ),
      SERVER_PICTURE_IN_PICTURE_STARTUP_TIMEOUT_MS,
    );
  });
  const wait = <T>(operation: Promise<T>) => Promise.race([operation, interrupted, timedOut]);
  try {
    await wait(video.play());
    if (stopped) return;
    if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
      await wait(
        new Promise<void>((resolve, reject) => {
          const loaded = () => resolve();
          const failed = () =>
            reject(new Error("The live preview video could not be loaded. Try opening it again."));
          removeMetadataListeners = () => {
            video.removeEventListener("loadedmetadata", loaded);
            video.removeEventListener("error", failed);
          };
          video.addEventListener("loadedmetadata", loaded, { once: true });
          video.addEventListener("error", failed, { once: true });
        }),
      );
    }
    if (stopped) return;
    if (document.pictureInPictureEnabled && typeof video.requestPictureInPicture === "function") {
      video.addEventListener("leavepictureinpicture", onLeave);
      await wait(
        changeNativePresentation(async () => {
          if (stopped) return;
          await video.requestPictureInPicture();
          if (stopped) await leaveOwnedPresentation();
        }),
      );
    } else if (typeof video.webkitSetPresentationMode === "function") {
      video.addEventListener("webkitpresentationmodechanged", onPresentationMode);
      video.webkitSetPresentationMode("picture-in-picture");
    } else {
      throw new Error("This browser does not support a floating live preview.");
    }
    if (stopped) return;
    await wait(connect(false));
  } catch (error) {
    if (stopped) return;
    onLeave();
    throw error;
  } finally {
    if (timeout !== null) clearTimeout(timeout);
    removeMetadataListeners();
  }
}
