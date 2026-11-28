// @effect-diagnostics globalTimers:off -- `withTimeout` bounds a native call that can hang; it runs outside any Effect fiber.
/**
 * The parts of capturing the screen that need no screen (1490): how big a
 * frame is, where the pointer falls in it, and the rule that no picture taken
 * across a lock ever leaves.
 */
import type { ScreenShareGrab, ScreenShareLook } from "./screenShareSession.logic.ts";

/** The size that fits within `maxEdge` on its longer side, keeping the shape. Never enlarges. */
export const fitWithin = (
  width: number,
  height: number,
  maxEdge: number,
): { readonly width: number; readonly height: number } => {
  const longer = Math.max(width, height);
  if (longer <= 0) return { width: 0, height: 0 };
  const scale = Math.min(1, maxEdge / longer);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
};

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The pointer in frame pixels, or nothing when it is on another display.
 * `cursor` and `bounds` are in the same screen points; the frame may be any size.
 */
export const pointerInFrame = (
  cursor: { readonly x: number; readonly y: number },
  bounds: Rect,
  frame: { readonly width: number; readonly height: number },
): { readonly x: number; readonly y: number } | undefined => {
  if (bounds.width <= 0 || bounds.height <= 0) return undefined;
  const x = cursor.x - bounds.x;
  const y = cursor.y - bounds.y;
  if (x < 0 || y < 0 || x >= bounds.width || y >= bounds.height) return undefined;
  return {
    x: Math.round((x / bounds.width) * frame.width),
    y: Math.round((y / bounds.height) * frame.height),
  };
};

/** `unknown` is treated as locked everywhere: no picture is sent on a guess. */
export type LockState = "unlocked" | "locked" | "unknown";

/**
 * Lock state from two sources: the system's lock and unlock events, which
 * arrive at once, and a direct question, which is right even if an event was
 * missed. Either saying locked is enough.
 */
export const makeLockWatch = (ask: () => string) => {
  let lockedByEvent = false;
  return {
    onLock: () => {
      lockedByEvent = true;
    },
    onUnlock: () => {
      lockedByEvent = false;
    },
    state: (): LockState => {
      let answer: string;
      try {
        answer = ask();
      } catch {
        return "unknown";
      }
      if (lockedByEvent || answer === "locked") return "locked";
      return answer === "active" || answer === "idle" ? "unlocked" : "unknown";
    },
  };
};

export interface Still {
  readonly jpeg: Uint8Array;
  readonly width: number;
  readonly height: number;
  /** 1519: the digest of the picture before encoding, when the capture made one. */
  readonly digest?: string;
  readonly grabMs?: number;
  readonly encodeMs?: number;
  readonly quality?: number;
}

/** The capture found the picture it sent last and did not encode it again. */
export const SAME_PICTURE = "same" as const;

/**
 * One look at a display. The lock is checked right before and right after the
 * picture is taken: a picture that met a lock on either side is thrown away,
 * so the lock screen, with whatever notifications sit on it, is never sent.
 */
export const makeFrameGrabber =
  (deps: {
    readonly lockState: () => LockState;
    readonly still: (
      displayId: string,
      look?: ScreenShareLook,
    ) => Promise<Still | typeof SAME_PICTURE | null>;
    readonly pointer: (
      displayId: string,
      frame: { readonly width: number; readonly height: number },
    ) => { readonly x: number; readonly y: number } | undefined;
    readonly digest: (jpeg: Uint8Array) => string;
  }) =>
  async (displayId: string, look?: ScreenShareLook): Promise<ScreenShareGrab> => {
    if (deps.lockState() !== "unlocked") return { kind: "locked" };
    let still: Still | typeof SAME_PICTURE | null;
    try {
      still = await deps.still(displayId, look);
    } catch {
      still = null;
    }
    if (deps.lockState() !== "unlocked") return { kind: "locked" };
    if (still === SAME_PICTURE) return { kind: "same" };
    if (still === null || still.jpeg.length === 0) return { kind: "none" };
    const pointer = deps.pointer(displayId, still);
    return {
      kind: "frame",
      jpeg: still.jpeg,
      width: still.width,
      height: still.height,
      ...(pointer === undefined ? {} : { pointer }),
      digest: still.digest ?? deps.digest(still.jpeg),
      ...(still.grabMs === undefined ? {} : { grabMs: still.grabMs }),
      ...(still.encodeMs === undefined ? {} : { encodeMs: still.encodeMs }),
      ...(still.quality === undefined ? {} : { quality: still.quality }),
    };
  };

/** Resolves with `fallback` when `work` has not finished in `ms`. */
export const withTimeout = <T>(work: Promise<T>, ms: number, fallback: T): Promise<T> =>
  new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
