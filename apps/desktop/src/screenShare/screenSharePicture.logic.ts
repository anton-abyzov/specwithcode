/**
 * How big, how sharp and how often the machine sends its picture (1519). No
 * screen and no clock in here: every rule runs in a plain test.
 *
 * Slice 1 sent at most 1920 px on the long edge at JPEG quality 60, one look
 * every 330 ms. A viewer that says how big its window is gets a picture that
 * fits it; a picture that changes is looked at again sooner.
 */
import {
  SCREEN_SHARE_FAST_LOOKS,
  SCREEN_SHARE_FRAME_FAST_MS,
  SCREEN_SHARE_FRAME_MIN_MS,
  SCREEN_SHARE_JPEG_QUALITY,
  SCREEN_SHARE_MAX_FRAME_EDGE,
  SCREEN_SHARE_PICTURE_LOW_EDGE,
  SCREEN_SHARE_PICTURE_MAX_EDGE,
  SCREEN_SHARE_PICTURE_MIN_EDGE,
  SCREEN_SHARE_VIEWPORT_PER_SECOND,
  ScreenSharePicture,
} from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";

/** What one look asks of the capture. */
export interface PictureTarget {
  /** Longest edge of the frame in pixels; never more than the display has. */
  readonly maxEdge: number;
  readonly quality: number;
}

/** Slice 1's numbers: what a viewer gets until it says otherwise. */
export const CLASSIC_PICTURE: PictureTarget = {
  maxEdge: SCREEN_SHARE_MAX_FRAME_EDGE,
  quality: SCREEN_SHARE_JPEG_QUALITY,
};

export interface Viewport {
  readonly width: number;
  readonly height: number;
  readonly picture: ScreenSharePicture;
}

const isPicture = Schema.is(ScreenSharePicture);
const LARGEST_VIEWPORT = 16_384;

/** A viewport record's body, or null for anything malformed. */
export const parseViewport = (body: Record<string, unknown>): Viewport | null => {
  const { width, height, picture } = body;
  if (!Number.isInteger(width) || !Number.isInteger(height) || !isPicture(picture)) return null;
  const w = width as number;
  const h = height as number;
  if (w < 1 || h < 1 || w > LARGEST_VIEWPORT || h > LARGEST_VIEWPORT) return null;
  return { width: w, height: h, picture };
};

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/**
 * The picture for one display in one viewer's window: the display scaled to
 * fit the window, its long edge between the floor and the cap. "low" caps it
 * lower and encodes rougher; "classic" is slice 1.
 */
export const pictureFor = (
  viewport: Viewport | null,
  display: { readonly width: number; readonly height: number },
): PictureTarget => {
  if (viewport === null || viewport.picture === "classic") return CLASSIC_PICTURE;
  const native = Math.max(display.width, display.height);
  const scale =
    display.width > 0 && display.height > 0
      ? Math.min(viewport.width / display.width, viewport.height / display.height, 1)
      : 1;
  const fitted = Math.round(native * scale);
  if (viewport.picture === "low")
    return {
      maxEdge: clamp(fitted, SCREEN_SHARE_PICTURE_MIN_EDGE, SCREEN_SHARE_PICTURE_LOW_EDGE),
      quality: 50,
    };
  const maxEdge = clamp(fitted, SCREEN_SHARE_PICTURE_MIN_EDGE, SCREEN_SHARE_PICTURE_MAX_EDGE);
  // Past slice 1's size the extra pixels carry the detail, so each one is encoded a little rougher.
  return { maxEdge, quality: maxEdge > SCREEN_SHARE_MAX_FRAME_EDGE ? 55 : 60 };
};

/**
 * Whether one more viewport record is read now: at most a few a second. The
 * rest are dropped, not an error: a window being dragged sends many.
 */
export const takeViewportTurn = (times: Array<number>, now: number): boolean => {
  while (times.length > 0 && now - times[0]! >= 1_000) times.shift();
  if (times.length >= SCREEN_SHARE_VIEWPORT_PER_SECOND) return false;
  times.push(now);
  return true;
};

/**
 * How long until the next look. After a changed picture the machine looks
 * again soon; after a few unchanged looks it goes back to its slow pace. A
 * viewer that has not sent its viewport (slice 1) and "classic" keep slice
 * 1's pace exactly.
 */
export const nextLookDelay = (fastLooksLeft: number, picture: ScreenSharePicture | null): number =>
  picture !== null && picture !== "classic" && fastLooksLeft > 0
    ? SCREEN_SHARE_FRAME_FAST_MS
    : SCREEN_SHARE_FRAME_MIN_MS;

/** Fast looks left after one look: back to the full count on a change, one fewer on none. */
export const fastLooksAfter = (fastLooksLeft: number, changed: boolean): number =>
  changed ? SCREEN_SHARE_FAST_LOOKS : Math.max(0, fastLooksLeft - 1);

export interface Encoded {
  readonly jpeg: Uint8Array;
  readonly quality: number;
  readonly maxEdge: number;
}

/**
 * Encodes within the byte budget: first as asked, then rougher, then smaller.
 * Null when even the smallest try is over: nothing that large is sent.
 */
export const encodeWithinBudget = (
  encode: (maxEdge: number, quality: number) => Uint8Array,
  target: PictureTarget,
  budget: number,
): Encoded | null => {
  let { maxEdge, quality } = target;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const jpeg = encode(maxEdge, quality);
    if (jpeg.length <= budget) return { jpeg, quality, maxEdge };
    if (quality > 40) quality = Math.max(40, quality - 15);
    else maxEdge = Math.max(SCREEN_SHARE_PICTURE_MIN_EDGE, Math.round(maxEdge * 0.75));
  }
  return null;
};
