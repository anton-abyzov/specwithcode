/**
 * The rules of controlling this machine's screen from another device (1519),
 * with no Electron and no helper in them: which records are well formed, how
 * many a second are read, where a pointer lands on this machine's display, and
 * which keys and buttons are held so they can be let go.
 *
 * The helper (`native/screen-control/main.swift`) checks secure input, system
 * prompts and the front app itself, right before each event it posts.
 */
import {
  SCREEN_SHARE_INPUT_MAX_EVENTS,
  SCREEN_SHARE_INPUT_PER_SECOND,
  type ScreenShareInputEvent,
  type ScreenShareInputRecord,
} from "@specweave-studio/contracts";

/**
 * Physical keys the helper can press (`KeyboardEvent.code`). The same list is
 * the helper's key table; a test compares the two.
 */
export const CONTROL_KEY_CODES: ReadonlySet<string> = new Set([
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((letter) => `Key${letter}`),
  ..."0123456789".split("").map((digit) => `Digit${digit}`),
  ..."0123456789".split("").map((digit) => `Numpad${digit}`),
  ...Array.from({ length: 19 }, (_, index) => `F${index + 1}`),
  "Enter",
  "Escape",
  "Backspace",
  "Tab",
  "Space",
  "Minus",
  "Equal",
  "BracketLeft",
  "BracketRight",
  "Backslash",
  "IntlBackslash",
  "Semicolon",
  "Quote",
  "Backquote",
  "Comma",
  "Period",
  "Slash",
  "CapsLock",
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Delete",
  "NumpadDecimal",
  "NumpadMultiply",
  "NumpadAdd",
  "NumpadDivide",
  "NumpadEnter",
  "NumpadSubtract",
  "NumpadEqual",
]);

/**
 * Apps in front of which nothing is typed (1490 D-04): a web page's password
 * field does not turn macOS secure input on, so a browser cannot be told from
 * one. Clicks and scroll still work. Listed in `docs/studio/screen-sharing.md`.
 */
export const CONTROL_BROWSER_BUNDLE_IDS: ReadonlyArray<string> = [
  "com.apple.Safari",
  "com.apple.SafariTechnologyPreview",
  "com.google.Chrome",
  "com.google.Chrome.beta",
  "com.google.Chrome.dev",
  "com.google.Chrome.canary",
  "org.chromium.Chromium",
  "org.mozilla.firefox",
  "org.mozilla.firefoxdeveloperedition",
  "org.mozilla.nightly",
  "com.microsoft.edgemac",
  "com.microsoft.edgemac.Beta",
  "com.microsoft.edgemac.Dev",
  "com.brave.Browser",
  "com.brave.Browser.beta",
  "company.thebrowser.Browser",
  "com.operasoftware.Opera",
  "com.vivaldi.Vivaldi",
  "app.zen-browser.zen",
  "org.torproject.torbrowser",
  "com.kagi.kagimacOS",
  "ai.perplexity.comet",
  "com.openai.atlas",
];

export interface DisplayBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** An event as the helper takes it: global display points. */
export type HelperEvent =
  | { readonly t: "move"; readonly x: number; readonly y: number }
  | {
      readonly t: "button";
      readonly button: "left" | "right" | "middle";
      readonly down: boolean;
      readonly x: number;
      readonly y: number;
    }
  | {
      readonly t: "scroll";
      readonly dx: number;
      readonly dy: number;
      readonly x: number;
      readonly y: number;
    }
  | { readonly t: "key"; readonly code: string; readonly down: boolean };

const SCROLL_MAX = 10_000;
/** A pointer a hair outside the picture (a drag past its edge) lands on the edge. */
const EDGE_SLACK = 0.05;

const isFraction = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= -EDGE_SLACK &&
  value <= 1 + EDGE_SLACK;
const isScroll = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= SCROLL_MAX;

const parseEvent = (value: unknown): ScreenShareInputEvent | null => {
  if (typeof value !== "object" || value === null) return null;
  const event = value as Record<string, unknown>;
  switch (event.t) {
    case "move":
      return isFraction(event.x) && isFraction(event.y)
        ? { t: "move", x: event.x, y: event.y }
        : null;
    case "button":
      return (event.button === "left" || event.button === "right" || event.button === "middle") &&
        typeof event.down === "boolean" &&
        isFraction(event.x) &&
        isFraction(event.y)
        ? { t: "button", button: event.button, down: event.down, x: event.x, y: event.y }
        : null;
    case "scroll":
      return isScroll(event.dx) && isScroll(event.dy) && isFraction(event.x) && isFraction(event.y)
        ? { t: "scroll", dx: event.dx, dy: event.dy, x: event.x, y: event.y }
        : null;
    case "key":
      return typeof event.code === "string" &&
        CONTROL_KEY_CODES.has(event.code) &&
        typeof event.down === "boolean"
        ? { t: "key", code: event.code, down: event.down }
        : null;
    default:
      return null;
  }
};

/** A whole input record, or null when any part of it is not what a viewer sends. */
export const parseInputRecord = (value: unknown): ScreenShareInputRecord | null => {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.displayId !== "string" || record.displayId.length > 128) return null;
  if (!Array.isArray(record.events) || record.events.length > SCREEN_SHARE_INPUT_MAX_EVENTS)
    return null;
  const events: Array<ScreenShareInputEvent> = [];
  for (const raw of record.events) {
    const event = parseEvent(raw);
    if (event === null) return null;
    events.push(event);
  }
  return { displayId: record.displayId, events };
};

/** True when another input record may be read now; `times` is the session's own list. */
export const takeInputTurn = (times: Array<number>, now: number): boolean => {
  while (times.length > 0 && now - times[0]! >= 1_000) times.shift();
  if (times.length >= SCREEN_SHARE_INPUT_PER_SECOND) return false;
  times.push(now);
  return true;
};

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** A place on the frame, as fractions, on the display in global points. */
export const toDisplayPoint = (
  bounds: DisplayBounds,
  x: number,
  y: number,
): { readonly x: number; readonly y: number } => ({
  // The last point is width - 1 of a point inside, never the next display's first.
  x: bounds.x + Math.min(clamp01(x) * bounds.width, bounds.width - 1),
  y: bounds.y + Math.min(clamp01(y) * bounds.height, bounds.height - 1),
});

export const toHelperEvents = (
  bounds: DisplayBounds,
  events: ReadonlyArray<ScreenShareInputEvent>,
): Array<HelperEvent> =>
  events.map((event): HelperEvent => {
    if (event.t === "key") return event;
    const point = toDisplayPoint(bounds, event.x, event.y);
    if (event.t === "move") return { t: "move", ...point };
    if (event.t === "button")
      return { t: "button", button: event.button, down: event.down, ...point };
    return { t: "scroll", dx: event.dx, dy: event.dy, ...point };
  });

/**
 * The keys and buttons a viewer pressed and has not let go, as this machine
 * forwarded them. Kept here as well as in the helper, so they can be let go
 * when the helper is gone.
 */
export class HeldInput {
  private readonly keys = new Set<string>();
  private readonly buttons = new Set<"left" | "right" | "middle">();

  note(events: ReadonlyArray<HelperEvent>): void {
    for (const event of events) {
      if (event.t === "key") {
        if (event.down) this.keys.add(event.code);
        else this.keys.delete(event.code);
      } else if (event.t === "button") {
        if (event.down) this.buttons.add(event.button);
        else this.buttons.delete(event.button);
      }
    }
  }

  get any(): boolean {
    return this.keys.size > 0 || this.buttons.size > 0;
  }

  /** What is held, then nothing. */
  take(): { readonly keys: ReadonlyArray<string>; readonly buttons: ReadonlyArray<string> } {
    const held = { keys: [...this.keys], buttons: [...this.buttons] };
    this.keys.clear();
    this.buttons.clear();
    return held;
  }
}

/** One running helper, for one control session. */
export interface ScreenControlLink {
  readonly post: (events: ReadonlyArray<HelperEvent>) => void;
  /** Lets go of everything held; resolves once the helper said so, or after a short wait. */
  readonly release: (held: {
    readonly keys: ReadonlyArray<string>;
    readonly buttons: ReadonlyArray<string>;
  }) => Promise<void>;
  /** Ends the helper. It lets go of anything still held as it exits. */
  readonly stop: () => void;
}

export type ScreenControlStart =
  | { readonly kind: "ok"; readonly link: ScreenControlLink }
  /** The helper runs but macOS has not given the app Accessibility. */
  | { readonly kind: "no_permission" }
  | { readonly kind: "unavailable" };

/** What a helper line says, or null when it says nothing the app reads. */
export const parseHelperLine = (
  line: string,
):
  | { readonly t: "ready"; readonly trusted: boolean }
  | { readonly t: "gate"; readonly blocked: string | null }
  | { readonly t: "released" }
  | null => {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const message = value as Record<string, unknown>;
  if (message.t === "ready") return { t: "ready", trusted: message.trusted === true };
  if (message.t === "released") return { t: "released" };
  if (message.t === "gate" && (message.blocked === null || typeof message.blocked === "string"))
    return { t: "gate", blocked: message.blocked };
  return null;
};

/**
 * Whether a device controls this machine's screen right now. Computer use on
 * this machine holds off while it does, so an agent and a person never move
 * the same pointer.
 */
class ScreenControlled {
  private on = false;
  get active(): boolean {
    return this.on;
  }
  set(on: boolean): void {
    this.on = on;
  }
}
export const screenControlled = new ScreenControlled();
