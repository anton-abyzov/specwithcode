import {
  COMPUTER_USE_MAX_SCREENSHOT_EDGE,
  type ComputerUseAction,
  type ComputerUseModifier,
  type ComputerUseMouseButton,
} from "@specweave-studio/contracts";

/**
 * Turns computer-use actions into low-level macOS input steps. Pure, so the
 * coordinate scaling and key mapping are tested without posting events; the
 * JXA executor in `MacComputerUse.ts` only replays the steps.
 */

export type InputStep =
  | {
      readonly type: "mouse";
      /** A Quartz `CGEventType`. */
      readonly event: number;
      /** A Quartz `CGMouseButton`. */
      readonly button: number;
      readonly x: number;
      readonly y: number;
      readonly clickState: number;
      readonly flags: number;
    }
  | {
      readonly type: "key";
      readonly keyCode: number;
      readonly down: boolean;
      readonly flags: number;
      /**
       * "hid" posts the key from the HID system state, so a held modifier is
       * part of the keyboard's state and not only a flag on the event. Only
       * the iPhone Mirroring steps set it; other keys omit the field.
       */
      readonly source?: "hid";
    }
  | { readonly type: "scroll"; readonly vertical: number; readonly horizontal: number }
  | { readonly type: "sleep"; readonly ms: number }
  /**
   * Waits up to `ms` for the app with this bundle id to be frontmost and stops
   * the whole replay, posting nothing after it, when it never comes forward.
   */
  | { readonly type: "awaitFront"; readonly bundleId: string; readonly ms: number };

/** Main display size in points and the scale from points to screenshot pixels. */
export interface DisplayGeometry {
  readonly width: number;
  readonly height: number;
}

/** Screenshot pixels per display point: below 1 when the display is larger than the cap. */
export function screenshotScale(display: DisplayGeometry): number {
  const longest = Math.max(display.width, display.height);
  return longest > COMPUTER_USE_MAX_SCREENSHOT_EDGE
    ? COMPUTER_USE_MAX_SCREENSHOT_EDGE / longest
    : 1;
}

export function screenshotSize(display: DisplayGeometry): { width: number; height: number } {
  const scale = screenshotScale(display);
  return { width: Math.round(display.width * scale), height: Math.round(display.height * scale) };
}

/** A screenshot pixel as a display point, clamped onto the display. */
export function toDisplayPoint(
  display: DisplayGeometry,
  x: number,
  y: number,
): { x: number; y: number } {
  const scale = screenshotScale(display);
  return {
    x: Math.min(Math.max(x / scale, 0), display.width - 1),
    y: Math.min(Math.max(y / scale, 0), display.height - 1),
  };
}

export function toScreenshotPoint(
  display: DisplayGeometry,
  x: number,
  y: number,
): { x: number; y: number } {
  const scale = screenshotScale(display);
  return { x: Math.round(x * scale), y: Math.round(y * scale) };
}

// Quartz event flags.
const MODIFIER_FLAGS: Record<ComputerUseModifier, number> = {
  shift: 0x20000,
  ctrl: 0x40000,
  alt: 0x80000,
  cmd: 0x100000,
  fn: 0x800000,
};

// Virtual key codes of the modifier keys themselves.
const MODIFIER_KEY_CODES: Record<ComputerUseModifier, number> = {
  cmd: 55,
  shift: 56,
  alt: 58,
  ctrl: 59,
  fn: 63,
};

const MODIFIER_ALIASES: Record<string, ComputerUseModifier> = {
  cmd: "cmd",
  command: "cmd",
  meta: "cmd",
  super: "cmd",
  "⌘": "cmd",
  shift: "shift",
  "⇧": "shift",
  alt: "alt",
  opt: "alt",
  option: "alt",
  "⌥": "alt",
  ctrl: "ctrl",
  control: "ctrl",
  "⌃": "ctrl",
  fn: "fn",
};

/** ANSI virtual key codes. Shortcuts resolve by position, whatever the input layout. */
const KEY_CODES: Record<string, number> = {
  a: 0,
  s: 1,
  d: 2,
  f: 3,
  h: 4,
  g: 5,
  z: 6,
  x: 7,
  c: 8,
  v: 9,
  b: 11,
  q: 12,
  w: 13,
  e: 14,
  r: 15,
  y: 16,
  t: 17,
  "1": 18,
  "2": 19,
  "3": 20,
  "4": 21,
  "6": 22,
  "5": 23,
  "=": 24,
  "9": 25,
  "7": 26,
  "-": 27,
  "8": 28,
  "0": 29,
  "]": 30,
  o: 31,
  u: 32,
  "[": 33,
  i: 34,
  p: 35,
  return: 36,
  l: 37,
  j: 38,
  "'": 39,
  k: 40,
  ";": 41,
  "\\": 42,
  ",": 43,
  "/": 44,
  n: 45,
  m: 46,
  ".": 47,
  tab: 48,
  space: 49,
  "`": 50,
  backspace: 51,
  escape: 53,
  capslock: 57,
  f17: 64,
  f18: 79,
  f19: 80,
  f20: 90,
  f5: 96,
  f6: 97,
  f7: 98,
  f3: 99,
  f8: 100,
  f9: 101,
  f11: 103,
  f13: 105,
  f16: 106,
  f14: 107,
  f10: 109,
  f12: 111,
  f15: 113,
  help: 114,
  home: 115,
  pageup: 116,
  forwarddelete: 117,
  f4: 118,
  end: 119,
  f2: 120,
  pagedown: 121,
  f1: 122,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
};

const KEY_ALIASES: Record<string, string> = {
  enter: "return",
  esc: "escape",
  delete: "backspace",
  del: "forwarddelete",
  comma: ",",
  period: ".",
  dot: ".",
  slash: "/",
  backslash: "\\",
  minus: "-",
  hyphen: "-",
  equal: "=",
  equals: "=",
  plus: "=",
  semicolon: ";",
  quote: "'",
  apostrophe: "'",
  grave: "`",
  backtick: "`",
  bracketleft: "[",
  bracketright: "]",
  arrowup: "up",
  arrowdown: "down",
  arrowleft: "left",
  arrowright: "right",
  pgup: "pageup",
  pgdn: "pagedown",
  spacebar: "space",
};

export class ComputerUseInputError extends Error {}

export interface ParsedChord {
  readonly modifiers: ReadonlyArray<ComputerUseModifier>;
  readonly keyCode: number;
}

/** Parses `cmd+shift+4`, `Return`, `option+left` into modifiers and a key code. */
export function parseChord(chord: string): ParsedChord {
  const parts = chord
    .trim()
    .toLowerCase()
    .split(/\s*\+\s*/)
    // `cmd++` means the plus key.
    .map((part, index, all) => (part === "" && index === all.length - 1 ? "=" : part))
    .filter((part) => part.length > 0);
  if (parts.length === 0) throw new ComputerUseInputError(`"${chord}" names no key.`);
  const modifiers: Array<ComputerUseModifier> = [];
  for (const part of parts.slice(0, -1)) {
    const modifier = MODIFIER_ALIASES[part];
    if (modifier === undefined) {
      throw new ComputerUseInputError(`"${part}" in "${chord}" is not a modifier.`);
    }
    if (!modifiers.includes(modifier)) modifiers.push(modifier);
  }
  const last = parts.at(-1)!;
  const keyName = KEY_ALIASES[last] ?? last;
  const keyCode = KEY_CODES[keyName];
  if (keyCode === undefined) {
    const lone = MODIFIER_ALIASES[last];
    if (lone !== undefined && modifiers.length === 0) {
      return { modifiers: [], keyCode: MODIFIER_KEY_CODES[lone] };
    }
    throw new ComputerUseInputError(
      `"${last}" is not a key I can press. Use names such as return, escape, tab, space, up, f5, a, comma.`,
    );
  }
  return { modifiers, keyCode };
}

export const flagsFor = (modifiers: ReadonlyArray<ComputerUseModifier>): number =>
  modifiers.reduce((flags, modifier) => flags | MODIFIER_FLAGS[modifier], 0);

/** Presses a chord: modifiers down, key down and up, modifiers up. */
export function chordSteps(chord: ParsedChord): Array<InputStep> {
  const flags = flagsFor(chord.modifiers);
  const steps: Array<InputStep> = [];
  let held = 0;
  for (const modifier of chord.modifiers) {
    held |= MODIFIER_FLAGS[modifier];
    steps.push({ type: "key", keyCode: MODIFIER_KEY_CODES[modifier], down: true, flags: held });
  }
  steps.push({ type: "key", keyCode: chord.keyCode, down: true, flags });
  steps.push({ type: "key", keyCode: chord.keyCode, down: false, flags });
  for (const modifier of chord.modifiers.toReversed()) {
    held &= ~MODIFIER_FLAGS[modifier];
    steps.push({ type: "key", keyCode: MODIFIER_KEY_CODES[modifier], down: false, flags: held });
  }
  return steps;
}

// Quartz CGEventType and CGMouseButton values.
const MOUSE_MOVED = 5;
const BUTTON_EVENTS: Record<
  ComputerUseMouseButton,
  { down: number; up: number; dragged: number; button: number }
> = {
  left: { down: 1, up: 2, dragged: 6, button: 0 },
  right: { down: 3, up: 4, dragged: 7, button: 1 },
  middle: { down: 25, up: 26, dragged: 27, button: 2 },
};

const move = (x: number, y: number, flags = 0): InputStep => ({
  type: "mouse",
  event: MOUSE_MOVED,
  button: 0,
  x,
  y,
  clickState: 0,
  flags,
});

/** Low-level steps for a pointer or keyboard action; `type`, `open` and reads have none. */
export function actionSteps(action: ComputerUseAction, display: DisplayGeometry): Array<InputStep> {
  switch (action.kind) {
    case "move": {
      const point = toDisplayPoint(display, action.x, action.y);
      return [move(point.x, point.y)];
    }
    case "click": {
      const point = toDisplayPoint(display, action.x, action.y);
      const events = BUTTON_EVENTS[action.button ?? "left"];
      const flags = flagsFor(action.modifiers ?? []);
      const steps: Array<InputStep> = [move(point.x, point.y, flags), { type: "sleep", ms: 40 }];
      const count = action.count ?? 1;
      for (let clickState = 1; clickState <= count; clickState++) {
        for (const event of [events.down, events.up]) {
          steps.push({
            type: "mouse",
            event,
            button: events.button,
            x: point.x,
            y: point.y,
            clickState,
            flags,
          });
        }
        if (clickState < count) steps.push({ type: "sleep", ms: 30 });
      }
      return steps;
    }
    case "drag": {
      const from = toDisplayPoint(display, action.fromX, action.fromY);
      const to = toDisplayPoint(display, action.toX, action.toY);
      const events = BUTTON_EVENTS.left;
      const press = (event: number, x: number, y: number): InputStep => ({
        type: "mouse",
        event,
        button: events.button,
        x,
        y,
        clickState: 1,
        flags: 0,
      });
      const steps: Array<InputStep> = [
        move(from.x, from.y),
        { type: "sleep", ms: 40 },
        press(events.down, from.x, from.y),
        { type: "sleep", ms: 60 },
      ];
      const segments = 12;
      for (let index = 1; index <= segments; index++) {
        const x = from.x + ((to.x - from.x) * index) / segments;
        const y = from.y + ((to.y - from.y) * index) / segments;
        steps.push(press(events.dragged, x, y), { type: "sleep", ms: 16 });
      }
      steps.push(press(events.up, to.x, to.y));
      return steps;
    }
    case "scroll": {
      const point = toDisplayPoint(display, action.x, action.y);
      const lines = 4;
      const vertical = action.direction === "up" ? lines : action.direction === "down" ? -lines : 0;
      const horizontal =
        action.direction === "left" ? lines : action.direction === "right" ? -lines : 0;
      const steps: Array<InputStep> = [move(point.x, point.y), { type: "sleep", ms: 40 }];
      for (let notch = 0; notch < (action.amount ?? 3); notch++) {
        steps.push({ type: "scroll", vertical, horizontal }, { type: "sleep", ms: 15 });
      }
      return steps;
    }
    case "key": {
      const chord = parseChord(action.keys);
      const steps: Array<InputStep> = [];
      for (let index = 0; index < (action.repeat ?? 1); index++) {
        if (index > 0) steps.push({ type: "sleep", ms: 30 });
        steps.push(...chordSteps(chord));
      }
      return steps;
    }
    case "status":
    case "screenshot":
    case "type":
    case "open":
    case "appInfo":
    case "appAt":
      return [];
  }
}

/** Paste: how `computer_type` enters text in any language and keyboard layout. */
export const PASTE_STEPS: ReadonlyArray<InputStep> = chordSteps({
  modifiers: ["cmd"],
  keyCode: KEY_CODES.v!,
});

/**
 * Replays steps with Quartz events through JavaScript for Automation, then
 * reports the frontmost application. Runs as a child of the desktop app, so
 * macOS checks the app's Accessibility permission.
 */
export const JXA_INPUT_SCRIPT = `
ObjC.import("CoreGraphics");
ObjC.import("AppKit");
function frontBundleId() {
  var front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  if (front.isNil()) return null;
  var id = front.bundleIdentifier;
  return id && typeof id.isNil === "function" && !id.isNil() ? id.js : null;
}
// Mouse button down event types and the up that releases each; the dragged events in between.
var MOUSE_UPS = { 1: 2, 3: 4, 25: 26 };
var MOUSE_DRAGGED = { 6: true, 7: true, 27: true };
var MODIFIER_FLAGS = { 55: 0x100000, 56: 0x20000, 58: 0x80000, 59: 0x40000, 63: 0x800000 };
function run(argv) {
  var steps = JSON.parse(argv[0]);
  var hid = null;
  // Once an awaitFront step passes, every later event first checks that its app is still in front.
  var guarded = null;
  // Events that reach an app (pointer moves do not), and the presses not yet released, in order.
  var posted = 0;
  var held = [];
  function heldIndex(type, id) {
    for (var h = 0; h < held.length; h++) if (held[h].type === type && held[h].id === id) return h;
    return -1;
  }
  function stop(bundleId) {
    // Never leave a button or key down: release what this replay pressed, last first,
    // built the way the plan's own up steps are.
    var modifiers = 0;
    for (var m = 0; m < held.length; m++) {
      if (held[m].type === "key" && MODIFIER_FLAGS[held[m].id] !== undefined) modifiers |= MODIFIER_FLAGS[held[m].id];
    }
    for (var r = held.length - 1; r >= 0; r--) {
      var press = held[r];
      var release;
      if (press.type === "mouse") {
        release = $.CGEventCreateMouseEvent(null, MOUSE_UPS[press.event], { x: press.x, y: press.y }, press.button);
        if (press.clickState > 0) $.CGEventSetIntegerValueField(release, 1, press.clickState);
        $.CGEventSetFlags(release, press.flags || 0);
      } else {
        if (MODIFIER_FLAGS[press.id] !== undefined) modifiers &= ~MODIFIER_FLAGS[press.id];
        release = $.CGEventCreateKeyboardEvent(press.source === "hid" ? hid : null, press.id, false);
        $.CGEventSetFlags(release, modifiers);
      }
      $.CGEventPost(0, release);
    }
    throw new Error((posted === 0 ? "not-frontmost: " : "left-front: ") + bundleId);
  }
  for (var i = 0; i < steps.length; i++) {
    var step = steps[i];
    var event = null;
    if (step.type === "sleep") { delay(step.ms / 1000); continue; }
    if (step.type === "awaitFront") {
      var waited = 0;
      while (frontBundleId() !== step.bundleId) {
        if (waited >= step.ms) stop(step.bundleId);
        delay(0.05);
        waited += 50;
      }
      guarded = step.bundleId;
      continue;
    }
    if (guarded !== null && frontBundleId() !== guarded) stop(guarded);
    if (step.type === "mouse") {
      event = $.CGEventCreateMouseEvent(null, step.event, { x: step.x, y: step.y }, step.button);
      if (step.clickState > 0) $.CGEventSetIntegerValueField(event, 1, step.clickState);
    } else if (step.type === "key") {
      if (step.source === "hid" && hid === null) hid = $.CGEventSourceCreate(1);
      event = $.CGEventCreateKeyboardEvent(step.source === "hid" ? hid : null, step.keyCode, step.down);
    } else if (step.type === "scroll") {
      event = $.CGEventCreateScrollWheelEvent2(null, 1, 2, step.vertical, step.horizontal, 0);
    }
    if (event === null) continue;
    if (step.flags !== undefined) $.CGEventSetFlags(event, step.flags);
    $.CGEventPost(0, event);
    if (step.type === "mouse") {
      var at = heldIndex("mouse", step.button);
      if (MOUSE_UPS[step.event] !== undefined) {
        if (at < 0) held.push({ type: "mouse", id: step.button, event: step.event, button: step.button, x: step.x, y: step.y, clickState: step.clickState, flags: step.flags });
      } else if (MOUSE_DRAGGED[step.event] && at >= 0) {
        held[at].x = step.x;
        held[at].y = step.y;
      } else if (step.event !== 5 && at >= 0) {
        held.splice(at, 1);
      }
      if (step.event !== 5) posted++;
    } else {
      if (step.type === "key") {
        var k = heldIndex("key", step.keyCode);
        if (step.down && k < 0) held.push({ type: "key", id: step.keyCode, source: step.source });
        else if (!step.down && k >= 0) held.splice(k, 1);
      }
      posted++;
    }
  }
  var front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  return JSON.stringify({ frontmostApplication: front.isNil() ? null : front.localizedName.js });
}
`;

/** One on-screen window as `JXA_WINDOWS_SCRIPT` reports it, front to back. */
export interface ScreenWindow {
  readonly owner: string | null;
  readonly layer: number;
  readonly alpha: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A display as `JXA_WINDOWS_SCRIPT` reports it, in global display points. */
export interface ScreenArea {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ScreenDisplay {
  readonly frame: ScreenArea;
  /** The frame without the menu bar and the Dock. */
  readonly visible: ScreenArea;
}

/** What `JXA_WINDOWS_SCRIPT` reports: the windows front to back, the displays and the frontmost app. */
export interface ScreenScene {
  readonly frontmost?: string | null | undefined;
  readonly windows: ReadonlyArray<ScreenWindow>;
  readonly screens?: ReadonlyArray<ScreenDisplay> | undefined;
}

/** The owner of the menu bar and of system overlays such as the cursor. */
const WINDOW_SERVER = "Window Server";
/** kCGMainMenuWindowLevel and kCGStatusWindowLevel: the menu bar. */
const MENU_BAR_LAYERS: ReadonlySet<number> = new Set([24, 25]);
const DOCK = "Dock";

const contains = (area: ScreenArea, point: { readonly x: number; readonly y: number }) =>
  point.x >= area.x &&
  point.x < area.x + area.width &&
  point.y >= area.y &&
  point.y < area.y + area.height;

const sameArea = (a: ScreenArea, b: ScreenArea) =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

const named = (name: string | null | undefined) => {
  const trimmed = name?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
};

/**
 * The app a click at a display point reaches: the owner of the topmost visible
 * window there, at any layer, so the Dock, Notification Center and banners
 * count as themselves. Two system cases are read differently:
 * - the menu bar belongs to Window Server and shows the frontmost app's menus,
 *   so it counts as the frontmost app; other Window Server windows (the
 *   cursor, screen shields) take no clicks and are passed over;
 * - the Dock spans its whole display in one see-through window, so it counts
 *   only outside that display's visible frame, where the Dock is drawn.
 * Undefined when it cannot tell.
 */
export function applicationAtPoint(
  scene: ScreenScene,
  point: { readonly x: number; readonly y: number },
): string | undefined {
  const hit = windowAtPoint(scene.windows, scene.screens, point);
  if (hit === "menu-bar") return named(scene.frontmost);
  if (hit === undefined) return undefined;
  return hit.owner === DOCK && hit.layer !== 0 ? DOCK : named(hit.owner);
}

/**
 * The topmost window a click at a display point reaches, as `applicationAtPoint`
 * reads it: "menu-bar" for the menu bar, other Window Server windows and the
 * see-through part of the Dock's display-wide window passed over.
 */
function windowAtPoint<W extends ScreenWindow>(
  windows: ReadonlyArray<W>,
  screens: ReadonlyArray<ScreenDisplay> | undefined,
  point: { readonly x: number; readonly y: number },
): W | "menu-bar" | undefined {
  for (const window of windows) {
    if (!(window.alpha > 0) || !contains(window, point)) continue;
    const owner = named(window.owner);
    if (owner === WINDOW_SERVER) {
      if (MENU_BAR_LAYERS.has(window.layer)) return "menu-bar";
      continue;
    }
    if (owner === DOCK && window.layer !== 0) {
      const display = screens?.find((screen) => sameArea(screen.frame, window));
      if (display !== undefined) {
        // Above the visible frame is the menu bar's strip; inside it, the windows below.
        if (contains(display.visible, point) || point.y < display.visible.y) continue;
        return window;
      }
    }
    return window;
  }
  return undefined;
}

/**
 * Lists on-screen windows front to back (CGWindowListCopyWindowInfo with
 * on-screen-only and no desktop elements) and the displays, in the global
 * display points a click is posted at, with the frontmost app. Owner names
 * need no Screen Recording permission.
 */
export const JXA_WINDOWS_SCRIPT = `
ObjC.import("CoreGraphics");
ObjC.import("AppKit");
function area(rect, primaryHeight) {
  return {
    x: Number(rect.origin.x),
    y: primaryHeight - Number(rect.origin.y) - Number(rect.size.height),
    width: Number(rect.size.width),
    height: Number(rect.size.height)
  };
}
function run() {
  var list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1 | 16, 0))) || [];
  var windows = [];
  for (var i = 0; i < list.length; i++) {
    var w = list[i];
    var b = w.kCGWindowBounds || {};
    windows.push({
      owner: w.kCGWindowOwnerName || null,
      layer: Number(w.kCGWindowLayer),
      alpha: w.kCGWindowAlpha === undefined ? 1 : Number(w.kCGWindowAlpha),
      x: Number(b.X), y: Number(b.Y), width: Number(b.Width), height: Number(b.Height)
    });
  }
  var screens = [];
  var all = $.NSScreen.screens;
  if (all.count > 0) {
    var primaryHeight = Number(all.objectAtIndex(0).frame.size.height);
    for (var j = 0; j < all.count; j++) {
      var screen = all.objectAtIndex(j);
      screens.push({ frame: area(screen.frame, primaryHeight), visible: area(screen.visibleFrame, primaryHeight) });
    }
  }
  var front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  return JSON.stringify({
    frontmost: front.isNil() ? null : front.localizedName.js,
    windows: windows,
    screens: screens
  });
}
`;

/**
 * The name an app goes by while it runs, the one the access gate sees as the
 * frontmost app or a window's owner: its running name (NSRunningApplication
 * localizedName), else the bundle's display name, its bundle name, its file
 * name, and last the name it was asked for.
 */
export function applicationName(input: {
  readonly requested: string;
  readonly runningName?: string | undefined;
  readonly displayName?: string | undefined;
  readonly bundleName?: string | undefined;
  readonly fileName?: string | undefined;
}): string {
  for (const candidate of [
    input.runningName,
    input.displayName,
    input.bundleName,
    input.fileName,
  ]) {
    const name = candidate?.trim();
    if (name !== undefined && name !== "") return name;
  }
  return input.requested.trim() || input.requested;
}

/**
 * The localizedName of a running app, matched by bundle id (argv[0]) or
 * bundle path (argv[1]); an empty string when it is not running.
 */
export const JXA_RUNNING_APP_NAME_SCRIPT = `
ObjC.import("AppKit");
function run(argv) {
  var bundleId = argv[0] || "";
  var bundlePath = argv[1] || "";
  var apps = $.NSWorkspace.sharedWorkspace.runningApplications;
  for (var i = 0; i < apps.count; i++) {
    var app = apps.objectAtIndex(i);
    var id = app.bundleIdentifier;
    var url = app.bundleURL;
    var byId = bundleId !== "" && !id.isNil() && id.js === bundleId;
    var byPath = bundlePath !== "" && !url.isNil() && url.path.js === bundlePath;
    if (byId || byPath) return app.localizedName.isNil() ? "" : app.localizedName.js;
  }
  return "";
}
`;

// iPhone Mirroring ------------------------------------------------------------

/**
 * macOS's iPhone Mirroring app, by bundle id so the check holds in every
 * language. Its window takes input only while the app is frontmost: a click
 * posted while another app is in front does nothing, and keys reach the phone
 * only while the pointer is inside the window. Paste does not reach the phone,
 * so text is typed key by key, which limits it to a US keyboard's characters.
 */
export const IPHONE_MIRRORING_BUNDLE_ID = "com.apple.ScreenContinuity";

/** How long the steps wait for iPhone Mirroring to come forward before giving up. */
export const MIRRORING_FRONT_WAIT_MS = 1_500;
/** How long a tap holds the button down: the phone ignores a press and release in the same instant. */
export const MIRRORING_TAP_HOLD_MS = 50;
/** The pause between typed characters. */
export const MIRRORING_KEY_GAP_MS = 15;
/** The most characters one `computer_type` sends to the phone, well inside the replay's 30 s limit. */
export const MIRRORING_MAX_TYPED_CHARS = 1_000;

/** An on-screen window, front to back, marked when iPhone Mirroring owns it. */
export interface MirroringSceneWindow extends ScreenWindow {
  readonly mirroring: boolean;
}

/** What `JXA_MIRRORING_SCRIPT` reports. */
export interface MirroringScene {
  readonly frontmostBundleId: string | null;
  /** Empty when iPhone Mirroring is not running. */
  readonly windows: ReadonlyArray<MirroringSceneWindow>;
  /** The displays, so the Dock's display-wide window is read as `applicationAtPoint` reads it. */
  readonly screens?: ReadonlyArray<ScreenDisplay> | undefined;
}

export interface DisplayPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Reports the frontmost app's bundle id and, while iPhone Mirroring runs, the
 * on-screen windows front to back with the ones it owns marked (by process
 * id). Reads only; owner names and bounds need no Screen Recording permission.
 */
export const JXA_MIRRORING_SCRIPT = `
ObjC.import("CoreGraphics");
ObjC.import("AppKit");
function area(rect, primaryHeight) {
  return {
    x: Number(rect.origin.x),
    y: primaryHeight - Number(rect.origin.y) - Number(rect.size.height),
    width: Number(rect.size.width),
    height: Number(rect.size.height)
  };
}
function run(argv) {
  var bundleId = argv[0];
  var front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  var frontId = null;
  if (!front.isNil()) {
    var id = front.bundleIdentifier;
    if (id && typeof id.isNil === "function" && !id.isNil()) frontId = id.js;
  }
  var apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(bundleId);
  if (apps.count === 0) return JSON.stringify({ frontmostBundleId: frontId, windows: [] });
  var pids = {};
  for (var a = 0; a < apps.count; a++) pids[String(apps.objectAtIndex(a).processIdentifier)] = true;
  var list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1 | 16, 0))) || [];
  var windows = [];
  for (var i = 0; i < list.length; i++) {
    var w = list[i];
    var b = w.kCGWindowBounds || {};
    windows.push({
      owner: w.kCGWindowOwnerName || null,
      layer: Number(w.kCGWindowLayer),
      alpha: w.kCGWindowAlpha === undefined ? 1 : Number(w.kCGWindowAlpha),
      x: Number(b.X), y: Number(b.Y), width: Number(b.Width), height: Number(b.Height),
      mirroring: pids[String(w.kCGWindowOwnerPID)] === true
    });
  }
  var screens = [];
  var all = $.NSScreen.screens;
  if (all.count > 0) {
    var primaryHeight = Number(all.objectAtIndex(0).frame.size.height);
    for (var j = 0; j < all.count; j++) {
      var screen = all.objectAtIndex(j);
      screens.push({ frame: area(screen.frame, primaryHeight), visible: area(screen.visibleFrame, primaryHeight) });
    }
  }
  return JSON.stringify({ frontmostBundleId: frontId, windows: windows, screens: screens });
}
`;

const boundsOf = (window: ScreenArea): ScreenArea => ({
  x: window.x,
  y: window.y,
  width: window.width,
  height: window.height,
});

const isMirroringWindow = (window: MirroringSceneWindow) =>
  window.mirroring && window.layer === 0 && window.alpha > 0 && window.width > 0;

/**
 * The iPhone Mirroring window a point falls on: the window a click there
 * reaches, read as `applicationAtPoint` reads it, must be one of its own.
 */
export function mirroringWindowAt(
  scene: MirroringScene,
  point: DisplayPoint,
): ScreenArea | undefined {
  const hit = windowAtPoint(scene.windows, scene.screens, point);
  return hit !== undefined && hit !== "menu-bar" && isMirroringWindow(hit)
    ? boundsOf(hit)
    : undefined;
}

/** iPhone Mirroring's front window, when the app is frontmost. */
export function frontMirroringWindow(scene: MirroringScene): ScreenArea | undefined {
  if (scene.frontmostBundleId !== IPHONE_MIRRORING_BUNDLE_ID) return undefined;
  const window = scene.windows.find(isMirroringWindow);
  return window === undefined ? undefined : boundsOf(window);
}

/**
 * Where the pointer goes before keys are sent to the phone: nowhere when it
 * is already inside the window, else back to the last point an action used
 * there, else the window's centre.
 */
export function mirroringPointerTarget(
  window: ScreenArea,
  cursor: DisplayPoint | undefined,
  lastPoint: DisplayPoint | undefined,
): DisplayPoint | undefined {
  if (cursor !== undefined && contains(window, cursor)) return undefined;
  if (lastPoint !== undefined && contains(window, lastPoint)) return lastPoint;
  return { x: window.x + window.width / 2, y: window.y + window.height / 2 };
}

const SHIFTED_KEYS: Record<string, string> = {
  "!": "1",
  "@": "2",
  "#": "3",
  $: "4",
  "%": "5",
  "^": "6",
  "&": "7",
  "*": "8",
  "(": "9",
  ")": "0",
  _: "-",
  "+": "=",
  "{": "[",
  "}": "]",
  "|": "\\",
  ":": ";",
  '"': "'",
  "<": ",",
  ">": ".",
  "?": "/",
  "~": "`",
};

const TYPED_SPECIAL_KEYS: Record<string, string> = { " ": "space", "\n": "return", "\t": "tab" };

/** The US-keyboard key for one character, or undefined when the phone cannot be sent it. */
export function latinKeystroke(char: string): { keyCode: number; shift: boolean } | undefined {
  const special = TYPED_SPECIAL_KEYS[char];
  if (special !== undefined) return { keyCode: KEY_CODES[special]!, shift: false };
  if (/^[a-z0-9]$/.test(char) || "-=[]\\;',./`".includes(char)) {
    const keyCode = KEY_CODES[char];
    return keyCode === undefined ? undefined : { keyCode, shift: false };
  }
  if (/^[A-Z]$/.test(char)) return { keyCode: KEY_CODES[char.toLowerCase()]!, shift: true };
  const base = SHIFTED_KEYS[char];
  return base === undefined ? undefined : { keyCode: KEY_CODES[base]!, shift: true };
}

const SHIFT_FLAG = MODIFIER_FLAGS.shift;
const SHIFT_KEY = MODIFIER_KEY_CODES.shift;

const awaitMirroring = (): InputStep => ({
  type: "awaitFront",
  bundleId: IPHONE_MIRRORING_BUNDLE_ID,
  ms: MIRRORING_FRONT_WAIT_MS,
});

const pointerSteps = (point: DisplayPoint | undefined): Array<InputStep> =>
  point === undefined ? [] : [move(point.x, point.y), { type: "sleep", ms: 40 }];

const hidKey = (keyCode: number, down: boolean, flags: number): InputStep => ({
  type: "key",
  keyCode,
  down,
  flags,
  source: "hid",
});

/**
 * Types text into the phone key by key. Every character is checked before
 * any key is pressed, so text the phone cannot take changes nothing.
 */
export function mirroringTypeSteps(
  text: string,
  pointer: DisplayPoint | undefined,
): Array<InputStep> {
  const chars = Array.from(text.replace(/\r\n?/g, "\n"));
  if (chars.length > MIRRORING_MAX_TYPED_CHARS) {
    throw new ComputerUseInputError(
      `iPhone Mirroring types key by key, so one computer_type sends at most ${MIRRORING_MAX_TYPED_CHARS} characters to the phone; this text has ${chars.length} and nothing was typed. Send it in parts.`,
    );
  }
  const strokes = chars.map((char) => ({ char, stroke: latinKeystroke(char) }));
  const refused = [
    ...new Set(strokes.filter((entry) => entry.stroke === undefined).map((e) => e.char)),
  ];
  if (refused.length > 0) {
    const shown = refused
      .slice(0, 5)
      .map((char) => JSON.stringify(char))
      .join(", ");
    throw new ComputerUseInputError(
      `iPhone Mirroring passes only the keys of a US keyboard to the phone, so ${shown} cannot be typed there and nothing was typed. Type Latin letters, digits and US punctuation, or ask the user to type the rest on the phone.`,
    );
  }
  const steps: Array<InputStep> = [awaitMirroring(), ...pointerSteps(pointer)];
  for (const { stroke } of strokes) {
    const { keyCode, shift } = stroke!;
    if (shift) steps.push(hidKey(SHIFT_KEY, true, SHIFT_FLAG));
    const flags = shift ? SHIFT_FLAG : 0;
    steps.push(hidKey(keyCode, true, flags), hidKey(keyCode, false, flags));
    if (shift) steps.push(hidKey(SHIFT_KEY, false, 0));
    steps.push({ type: "sleep", ms: MIRRORING_KEY_GAP_MS });
  }
  return steps;
}

/** What `mirroringActionSteps` needs besides the action: where things are on screen. */
export interface MirroringContext {
  readonly scene: MirroringScene;
  /** The pointer, in display points. */
  readonly cursor?: DisplayPoint | undefined;
  /** The last point an action used on the Mirroring window, in display points. */
  readonly lastPoint?: DisplayPoint | undefined;
}

export interface MirroringPlan {
  readonly steps: Array<InputStep>;
  /** The display point the action used inside the window, to remember for the next keys. */
  readonly point?: DisplayPoint;
  /** Whether iPhone Mirroring has to be brought forward before the steps run. */
  readonly activate: boolean;
}

/**
 * Steps for an action that lands on the iPhone Mirroring window, or undefined
 * when it does not, and the action takes its usual steps. Clicks, scrolls and
 * drags count when their point is on the window; keys when iPhone Mirroring is
 * frontmost. Every plan waits for iPhone Mirroring to be frontmost first, so a
 * click is never spent bringing the window forward, and the replay stops at
 * the first event after it leaves the front, so the rest never reaches
 * another app. Taps hold the button for a moment; keys come from the HID state
 * with the pointer inside the window.
 */
export function mirroringActionSteps(
  action: ComputerUseAction,
  display: DisplayGeometry,
  context: MirroringContext,
): MirroringPlan | undefined {
  const activate = context.scene.frontmostBundleId !== IPHONE_MIRRORING_BUNDLE_ID;
  switch (action.kind) {
    case "click": {
      const point = toDisplayPoint(display, action.x, action.y);
      if (mirroringWindowAt(context.scene, point) === undefined) return undefined;
      const events = BUTTON_EVENTS[action.button ?? "left"];
      const flags = flagsFor(action.modifiers ?? []);
      const steps: Array<InputStep> = [
        awaitMirroring(),
        move(point.x, point.y, flags),
        { type: "sleep", ms: 40 },
      ];
      const count = action.count ?? 1;
      for (let clickState = 1; clickState <= count; clickState++) {
        const press = (event: number): InputStep => ({
          type: "mouse",
          event,
          button: events.button,
          x: point.x,
          y: point.y,
          clickState,
          flags,
        });
        steps.push(press(events.down), { type: "sleep", ms: MIRRORING_TAP_HOLD_MS });
        steps.push(press(events.up));
        if (clickState < count) steps.push({ type: "sleep", ms: 30 });
      }
      return { steps, point, activate };
    }
    case "scroll":
    case "drag": {
      const point =
        action.kind === "scroll"
          ? toDisplayPoint(display, action.x, action.y)
          : toDisplayPoint(display, action.fromX, action.fromY);
      if (mirroringWindowAt(context.scene, point) === undefined) return undefined;
      return { steps: [awaitMirroring(), ...actionSteps(action, display)], point, activate };
    }
    case "key": {
      const window = frontMirroringWindow(context.scene);
      if (window === undefined) return undefined;
      const chord = parseChord(action.keys);
      const steps: Array<InputStep> = [
        awaitMirroring(),
        ...pointerSteps(mirroringPointerTarget(window, context.cursor, context.lastPoint)),
      ];
      for (let index = 0; index < (action.repeat ?? 1); index++) {
        if (index > 0) steps.push({ type: "sleep", ms: 30 });
        for (const step of chordSteps(chord)) {
          steps.push(step.type === "key" ? { ...step, source: "hid" } : step);
        }
      }
      return { steps, activate: false };
    }
    case "type": {
      const window = frontMirroringWindow(context.scene);
      if (window === undefined) return undefined;
      const pointer = mirroringPointerTarget(window, context.cursor, context.lastPoint);
      return { steps: mirroringTypeSteps(action.text, pointer), activate: false };
    }
    default:
      return undefined;
  }
}
