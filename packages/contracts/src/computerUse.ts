import { Schema } from "effect";
import { Rpc } from "effect/rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Computer use: agents see and drive the desktop of the machine the
 * SpecWithCode desktop app runs on. The server owns the MCP tools; the desktop
 * app is the host that performs each action, so the operating system's
 * Screen Recording and Accessibility permissions belong to the app.
 *
 * Coordinates are always pixels of the latest `computer_screenshot` image.
 * The host scales them to the display, so agents never handle Retina factors.
 */

/** Longest screenshot side sent to agents; larger displays are scaled down. */
export const COMPUTER_USE_MAX_SCREENSHOT_EDGE = 1568;

/**
 * How long an action waits for the user to allow a missing macOS permission
 * before it fails, so the first request goes through once they click Allow.
 */
export const COMPUTER_USE_PERMISSION_WAIT_MS = 120_000;

const Coordinate = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
  .check(Schema.isLessThanOrEqualTo(100_000))
  .annotate({ description: "Pixels from the top-left corner of the latest computer_screenshot." });

export const ComputerUseMouseButton = Schema.Literals(["left", "right", "middle"]);
export type ComputerUseMouseButton = typeof ComputerUseMouseButton.Type;

export const ComputerUseModifier = Schema.Literals(["cmd", "shift", "alt", "ctrl", "fn"]);
export type ComputerUseModifier = typeof ComputerUseModifier.Type;

const Modifiers = Schema.Array(ComputerUseModifier).annotate({
  description: 'Keys held during the action, for example ["cmd"] or ["shift", "alt"].',
});

/** A key chord such as `cmd+space`, `return`, `shift+tab` or `cmd+shift+4`. */
const KeyChord = Schema.String.check(Schema.isTrimmed())
  .check(Schema.isNonEmpty())
  .check(Schema.isMaxLength(64))
  .annotate({
    description:
      "One chord: modifiers joined with + then a key, for example cmd+space, return, escape, tab, shift+tab, cmd+comma, up, pagedown, f5, a.",
  });

const ApplicationName = TrimmedNonEmptyString.check(Schema.isMaxLength(200)).annotate({
  description: 'An installed application name such as "System Settings", "Finder" or "Notes".',
});

/** The only URL scheme `computer_open` accepts: System Settings panes. */
export const COMPUTER_USE_SETTINGS_URL_PREFIX = "x-apple.systempreferences:";

const SettingsPaneUrl = Schema.String.check(Schema.isTrimmed())
  .check(Schema.isMaxLength(512))
  .check(Schema.isPattern(/^x-apple\.systempreferences:[A-Za-z0-9._\-?=&%:/]+$/))
  .annotate({
    description:
      "A System Settings pane URL, for example x-apple.systempreferences:com.apple.Trackpad-Settings.extension or x-apple.systempreferences:com.apple.Mouse-Settings.extension.",
  });

export const ComputerUseAction = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("status") }),
  Schema.Struct({ kind: Schema.Literal("screenshot") }),
  Schema.Struct({
    kind: Schema.Literal("click"),
    x: Coordinate,
    y: Coordinate,
    button: Schema.optional(ComputerUseMouseButton),
    count: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 }))),
    modifiers: Schema.optional(Modifiers),
  }),
  Schema.Struct({ kind: Schema.Literal("move"), x: Coordinate, y: Coordinate }),
  Schema.Struct({
    kind: Schema.Literal("drag"),
    fromX: Coordinate,
    fromY: Coordinate,
    toX: Coordinate,
    toY: Coordinate,
  }),
  Schema.Struct({
    kind: Schema.Literal("scroll"),
    x: Coordinate,
    y: Coordinate,
    direction: Schema.Literals(["up", "down", "left", "right"]),
    amount: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
  }),
  Schema.Struct({
    kind: Schema.Literal("type"),
    text: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(10_000)),
  }),
  Schema.Struct({
    kind: Schema.Literal("key"),
    keys: KeyChord,
    repeat: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
  }),
  Schema.Struct({
    kind: Schema.Literal("open"),
    application: Schema.optional(ApplicationName),
    url: Schema.optional(SettingsPaneUrl),
  }),
]);
export type ComputerUseAction = typeof ComputerUseAction.Type;
export type ComputerUseActionKind = ComputerUseAction["kind"];

export const ComputerUseScreenshot = Schema.Struct({
  mimeType: Schema.Literals(["image/jpeg", "image/png"]),
  data: Schema.String,
  width: Schema.Int,
  height: Schema.Int,
});
export type ComputerUseScreenshot = typeof ComputerUseScreenshot.Type;

export const ComputerUsePermissions = Schema.Struct({
  screenRecording: Schema.Boolean,
  accessibility: Schema.Boolean,
});
export type ComputerUsePermissions = typeof ComputerUsePermissions.Type;

/** A macOS permission computer use needs. Both belong to the SpecWithCode app. */
export const ComputerUsePermission = Schema.Literals(["screen-recording", "accessibility"]);
export type ComputerUsePermission = typeof ComputerUsePermission.Type;

/** The permission an action needs before it can run, if any. */
export function computerUsePermissionFor(
  kind: ComputerUseActionKind,
): ComputerUsePermission | undefined {
  if (kind === "screenshot") return "screen-recording";
  if (kind === "status" || kind === "open") return undefined;
  return "accessibility";
}

/**
 * The desktop app's errors for a missing permission start with these phrases,
 * so a thread can tell that failure apart and show the permission card.
 */
export const COMPUTER_USE_PERMISSION_ERROR_PHRASES: Record<ComputerUsePermission, string> = {
  "screen-recording": "SpecWithCode needs Screen Recording",
  accessibility: "SpecWithCode needs Accessibility",
};

// Desktop builds up to 1.0.43 wrote "The user did not allow Screen Recording for SpecWithCode".
const LEGACY_PERMISSION_ERROR = /did not allow (Screen Recording|Accessibility) for SpecWithCode/;

/** Which permission a computer-use error says is missing, if any. */
export function computerUsePermissionFromError(text: string): ComputerUsePermission | undefined {
  if (text.includes(COMPUTER_USE_PERMISSION_ERROR_PHRASES["screen-recording"])) {
    return "screen-recording";
  }
  if (text.includes(COMPUTER_USE_PERMISSION_ERROR_PHRASES.accessibility)) return "accessibility";
  const legacy = LEGACY_PERMISSION_ERROR.exec(text)?.[1];
  if (legacy === "Screen Recording") return "screen-recording";
  if (legacy === "Accessibility") return "accessibility";
  return undefined;
}

/** What the desktop host reports back for one action. */
export const ComputerUseActionResult = Schema.Struct({
  /** The host's platform, so agents know which shortcuts apply. */
  platform: Schema.String,
  permissions: ComputerUsePermissions,
  /** The main display in screenshot pixels. */
  display: Schema.optional(Schema.Struct({ width: Schema.Int, height: Schema.Int })),
  /** The pointer after the action, in screenshot pixels. */
  cursor: Schema.optional(Schema.Struct({ x: Schema.Int, y: Schema.Int })),
  frontmostApplication: Schema.optional(Schema.String),
  screenshot: Schema.optional(ComputerUseScreenshot),
});
export type ComputerUseActionResult = typeof ComputerUseActionResult.Type;

export const ComputerUseHostInput = Schema.Struct({
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  platform: TrimmedNonEmptyString.check(Schema.isMaxLength(32)),
});
export type ComputerUseHostInput = typeof ComputerUseHostInput.Type;

export const ComputerUseHostRequest = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  action: ComputerUseAction,
  /** The thread whose agent asked, so the app can show a permission card there. */
  threadId: Schema.optional(TrimmedNonEmptyString),
});
export type ComputerUseHostRequest = typeof ComputerUseHostRequest.Type;

export const ComputerUseHostEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("connected"), hostId: TrimmedNonEmptyString }),
  Schema.Struct({ type: Schema.Literal("request"), request: ComputerUseHostRequest }),
]);
export type ComputerUseHostEvent = typeof ComputerUseHostEvent.Type;

export const ComputerUseRespondInput = Schema.Struct({
  hostId: TrimmedNonEmptyString,
  requestId: TrimmedNonEmptyString,
  result: Schema.optional(ComputerUseActionResult),
  /** A message the host wrote for the agent, when the action failed. */
  error: Schema.optional(Schema.String.check(Schema.isMaxLength(2_000))),
});
export type ComputerUseRespondInput = typeof ComputerUseRespondInput.Type;

export class ComputerUseHostError extends Schema.TaggedError<ComputerUseHostError>()(
  "ComputerUseHostError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

/** Every `computer_*` failure: a server-written reason the agent can act on. */
export class ComputerUseToolError extends Schema.TaggedError<ComputerUseToolError>()(
  "ComputerUseToolError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

// MCP tool inputs. Each is the action without its `kind`.

export const ComputerToolScreenshotInput = Schema.Struct({
  includeImage: Schema.optional(
    Schema.Boolean.annotate({ description: "Set false to get only the metadata. Default true." }),
  ),
});
export const ComputerToolClickInput = Schema.Struct({
  x: Coordinate,
  y: Coordinate,
  button: Schema.optional(ComputerUseMouseButton.annotate({ description: "Default left." })),
  count: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })).annotate({
      description: "2 for a double click, 3 for a triple click. Default 1.",
    }),
  ),
  modifiers: Schema.optional(Modifiers),
});
export const ComputerToolMoveInput = Schema.Struct({ x: Coordinate, y: Coordinate });
export const ComputerToolDragInput = Schema.Struct({
  fromX: Coordinate,
  fromY: Coordinate,
  toX: Coordinate,
  toY: Coordinate,
});
export const ComputerToolScrollInput = Schema.Struct({
  x: Coordinate,
  y: Coordinate,
  direction: Schema.Literals(["up", "down", "left", "right"]),
  amount: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })).annotate({
      description: "Wheel notches. Default 3.",
    }),
  ),
});
export const ComputerToolTypeInput = Schema.Struct({
  text: Schema.String.check(Schema.isNonEmpty())
    .check(Schema.isMaxLength(10_000))
    .annotate({ description: "Text to enter into the focused field. Any language works." }),
});
export const ComputerToolKeyInput = Schema.Struct({
  keys: KeyChord,
  repeat: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })).annotate({
      description: "Press the chord this many times. Default 1.",
    }),
  ),
});
export const ComputerToolOpenInput = Schema.Struct({
  application: Schema.optional(ApplicationName),
  url: Schema.optional(SettingsPaneUrl),
});

/** The result of a `computer_*` action other than the screenshot. */
export const ComputerToolActionResult = Schema.Struct({
  platform: Schema.String,
  permissions: ComputerUsePermissions,
  display: Schema.optional(Schema.Struct({ width: Schema.Int, height: Schema.Int })),
  cursor: Schema.optional(Schema.Struct({ x: Schema.Int, y: Schema.Int })),
  frontmostApplication: Schema.optional(Schema.String),
});
export type ComputerToolActionResult = typeof ComputerToolActionResult.Type;

export const ComputerToolScreenshotResult = Schema.Struct({
  platform: Schema.String,
  display: Schema.optional(Schema.Struct({ width: Schema.Int, height: Schema.Int })),
  cursor: Schema.optional(Schema.Struct({ x: Schema.Int, y: Schema.Int })),
  frontmostApplication: Schema.optional(Schema.String),
  screenshot: ComputerUseScreenshot,
});
export type ComputerToolScreenshotResult = typeof ComputerToolScreenshotResult.Type;

export const COMPUTER_USE_RPC_METHODS = {
  /** The desktop app offers itself as this machine's computer-use host. */
  computerUseHost: "computerUse.host",
  /** The host answers one request. */
  computerUseRespond: "computerUse.respond",
} as const;

export const computerUseRpcs = [
  Rpc.make(COMPUTER_USE_RPC_METHODS.computerUseHost, {
    payload: ComputerUseHostInput,
    success: ComputerUseHostEvent,
    error: EnvironmentAuthorizationError,
    stream: true,
  }),
  Rpc.make(COMPUTER_USE_RPC_METHODS.computerUseRespond, {
    payload: ComputerUseRespondInput,
    success: Schema.Struct({}),
    error: Schema.Union([ComputerUseHostError, EnvironmentAuthorizationError]),
  }),
] as const;
