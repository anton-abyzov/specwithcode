import type * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

// A monitor as the window code sees it. The id is null when Electron did not
// report one (tests, odd platforms); such a display can host a window but can
// never be matched to a saved one.
export interface ConnectedDisplay {
  readonly id: number | null;
  readonly bounds: Rect;
  readonly workArea: Rect;
}

export function toConnectedDisplay(display: {
  readonly id?: unknown;
  readonly bounds: Rect;
  readonly workArea?: Rect | undefined;
}): ConnectedDisplay {
  return {
    id: typeof display.id === "number" && Number.isSafeInteger(display.id) ? display.id : null,
    bounds: display.bounds,
    workArea: display.workArea ?? display.bounds,
  };
}

export function windowFitsWithinDisplay(windowBounds: Rect, displayBounds: Rect): boolean {
  return (
    windowBounds.x >= displayBounds.x &&
    windowBounds.y >= displayBounds.y &&
    windowBounds.x + windowBounds.width <= displayBounds.x + displayBounds.width &&
    windowBounds.y + windowBounds.height <= displayBounds.y + displayBounds.height
  );
}

function intersectionArea(a: Rect, b: Rect): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

// The display showing most of the window, or null when it is on none.
export function displayForBounds(
  bounds: Rect,
  displays: readonly ConnectedDisplay[],
): ConnectedDisplay | null {
  let best: ConnectedDisplay | null = null;
  let bestArea = 0;
  for (const display of displays) {
    const area = intersectionArea(bounds, display.bounds);
    if (area > bestArea) {
      best = display;
      bestArea = area;
    }
  }
  return best;
}

export function toSavedDisplay(
  display: ConnectedDisplay | null,
): DesktopAppSettings.DesktopWindowDisplay | null {
  if (display === null || display.id === null) return null;
  const { x, y, width, height } = display.bounds;
  return {
    id: display.id,
    bounds: {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height),
    },
  };
}

function clampInto(bounds: Rect, area: Rect): Rect {
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);
  return {
    x: Math.round(Math.min(Math.max(bounds.x, area.x), area.x + area.width - width)),
    y: Math.round(Math.min(Math.max(bounds.y, area.y), area.y + area.height - height)),
    width: Math.round(width),
    height: Math.round(height),
  };
}

function centerIn(bounds: Rect, area: Rect): Rect {
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width: Math.round(width),
    height: Math.round(height),
  };
}

// A display id is trusted only with the same size: on Windows ids hash the
// device name, which can move to another monitor after a reconnect. A dock
// that issues new ids each boot is still found by identical bounds.
function findSavedDisplay(
  saved: DesktopAppSettings.DesktopWindowDisplay,
  displays: readonly ConnectedDisplay[],
): ConnectedDisplay | undefined {
  const sameSize = (display: ConnectedDisplay) =>
    display.bounds.width === saved.bounds.width && display.bounds.height === saved.bounds.height;
  return (
    displays.find((display) => display.id === saved.id && sameSize(display)) ??
    displays.find(
      (display) =>
        sameSize(display) &&
        display.bounds.x === saved.bounds.x &&
        display.bounds.y === saved.bounds.y,
    )
  );
}

export type WindowPlacement =
  // The saved bounds, exactly as saved.
  | { readonly kind: "saved"; readonly bounds: Rect; readonly savedDisplayMissing: false }
  // Moved or shrunk onto a connected display: the saved monitor moved in the
  // arrangement, the window hung over an edge, or it was full screen on a
  // monitor other than the one its normal bounds are on.
  | { readonly kind: "adjusted"; readonly bounds: Rect; readonly savedDisplayMissing: boolean }
  // Nothing usable; the caller opens its default placement.
  | { readonly kind: "default"; readonly savedDisplayMissing: boolean };

// Where a window opens given what was saved and what is connected now. The
// saved monitor wins when it is connected, so a window comes back on the
// monitor it was on even after the arrangement changed. A window whose saved
// monitor is missing (unplugged, or still waking up after an update restart)
// stays on whatever display it overlaps, else gets the default placement, and
// `savedDisplayMissing` lets the caller move it once that monitor appears.
export function resolveWindowPlacement(
  saved: {
    readonly bounds: Rect | null;
    readonly display: DesktopAppSettings.DesktopWindowDisplay | null;
    readonly fullScreen: boolean;
  },
  displays: readonly ConnectedDisplay[],
): WindowPlacement {
  const bounds = saved.bounds;
  const savedDisplay =
    saved.display === null ? undefined : findSavedDisplay(saved.display, displays);
  const savedDisplayMissing = saved.display !== null && savedDisplay === undefined;
  if (bounds === null) {
    return { kind: "default", savedDisplayMissing };
  }

  if (savedDisplay !== undefined) {
    const moved =
      saved.display!.bounds.x !== savedDisplay.bounds.x ||
      saved.display!.bounds.y !== savedDisplay.bounds.y;
    const translated = moved
      ? {
          ...bounds,
          x: bounds.x + savedDisplay.bounds.x - saved.display!.bounds.x,
          y: bounds.y + savedDisplay.bounds.y - saved.display!.bounds.y,
        }
      : bounds;
    if (!moved && windowFitsWithinDisplay(bounds, savedDisplay.bounds)) {
      return { kind: "saved", bounds, savedDisplayMissing: false };
    }
    // Full screen comes back on the saved monitor even when the normal
    // bounds were left on another one.
    const onSavedDisplay = displayForBounds(translated, [savedDisplay]) !== null;
    return {
      kind: "adjusted",
      bounds: onSavedDisplay
        ? clampInto(translated, savedDisplay.workArea)
        : centerIn(translated, savedDisplay.workArea),
      savedDisplayMissing: false,
    };
  }

  if (displays.some((display) => windowFitsWithinDisplay(bounds, display.bounds))) {
    return savedDisplayMissing
      ? { kind: "adjusted", bounds, savedDisplayMissing }
      : { kind: "saved", bounds, savedDisplayMissing: false };
  }
  const overlapping = displayForBounds(bounds, displays);
  if (overlapping !== null) {
    return {
      kind: "adjusted",
      bounds: clampInto(bounds, overlapping.workArea),
      savedDisplayMissing,
    };
  }
  return { kind: "default", savedDisplayMissing };
}
