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
    }
  | { readonly type: "scroll"; readonly vertical: number; readonly horizontal: number }
  | { readonly type: "sleep"; readonly ms: number };

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
function run(argv) {
  var steps = JSON.parse(argv[0]);
  for (var i = 0; i < steps.length; i++) {
    var step = steps[i];
    var event = null;
    if (step.type === "sleep") { delay(step.ms / 1000); continue; }
    if (step.type === "mouse") {
      event = $.CGEventCreateMouseEvent(null, step.event, { x: step.x, y: step.y }, step.button);
      if (step.clickState > 0) $.CGEventSetIntegerValueField(event, 1, step.clickState);
    } else if (step.type === "key") {
      event = $.CGEventCreateKeyboardEvent(null, step.keyCode, step.down);
    } else if (step.type === "scroll") {
      event = $.CGEventCreateScrollWheelEvent2(null, 1, 2, step.vertical, step.horizontal, 0);
    }
    if (event === null) continue;
    if (step.flags !== undefined) $.CGEventSetFlags(event, step.flags);
    $.CGEventPost(0, event);
  }
  var front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  return JSON.stringify({ frontmostApplication: front.isNil() ? null : front.localizedName.js });
}
`;
