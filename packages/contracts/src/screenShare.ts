import { Schema } from "effect";

/**
 * Screen sharing (1490): the owner sees the screen of another of their
 * machines from one of their approved devices. Slice 1 is view-only, macOS.
 *
 * The machine's app decides and encrypts; its server only checks who calls and
 * passes sealed bytes between two sockets:
 *
 * - `SCREEN_SHARE_HOST_PATH`: the machine's own app, one socket for all sessions.
 * - `SCREEN_SHARE_VIEW_PATH`: one socket per viewer session.
 *
 * Text messages on either socket are the JSON envelopes below. Binary messages
 * are the session's own bytes (`packages/shared/src/screenShareChannel.ts`):
 * on the viewer socket as they are, on the host socket behind the session id
 * (`encodeScreenShareHostFrame`).
 */

export const SCREEN_SHARE_ROUTE_PREFIX = "/api/screen-share";
export const SCREEN_SHARE_HOST_PATH = `${SCREEN_SHARE_ROUTE_PREFIX}/host`;
export const SCREEN_SHARE_VIEW_PATH = `${SCREEN_SHARE_ROUTE_PREFIX}/view`;

/** Operating systems whose app can show its screen today. */
export const SCREEN_SHARE_SUPPORTED_PLATFORMS: ReadonlyArray<string> = ["darwin"];

/** Longest side of a frame, in pixels. */
export const SCREEN_SHARE_MAX_FRAME_EDGE = 1920;
/** Shortest time between two frames, in milliseconds (about 3 a second). */
export const SCREEN_SHARE_FRAME_MIN_MS = 330;
export const SCREEN_SHARE_JPEG_QUALITY = 60;
/** How long the machine waits for a person to answer the prompt. */
export const SCREEN_SHARE_PROMPT_MS = 60_000;
/** How long a handshake may take before the machine gives up on it. */
export const SCREEN_SHARE_HANDSHAKE_MS = 15_000;
/** The longest a session lasts. */
export const SCREEN_SHARE_SESSION_MAX_MS = 2 * 60 * 60_000;
/** A viewer that confirms no frame for this long is gone. */
export const SCREEN_SHARE_SILENCE_MS = 2 * 60_000;
/** A grant ends this long after its last use. */
export const SCREEN_SHARE_GRANT_IDLE_MS = 30 * 24 * 60 * 60_000;
/** Refusals or timeouts from one device within the window that silence its prompts. */
export const SCREEN_SHARE_COOLDOWN_STRIKES = 3;
export const SCREEN_SHARE_COOLDOWN_WINDOW_MS = 10 * 60_000;
export const SCREEN_SHARE_AUDIT_LIMIT = 500;
/** Bytes the server holds for a slow reader before it drops the session. */
export const SCREEN_SHARE_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
/** The largest single message the server passes. */
export const SCREEN_SHARE_MAX_MESSAGE_BYTES = 4 * 1024 * 1024 + 64;
/** The largest hello, challenge or proof the server passes. */
export const SCREEN_SHARE_MAX_CONTROL_BYTES = 64 * 1024;
/** The largest sealed record the server passes from a viewer: a viewer sends words, never pictures. */
export const SCREEN_SHARE_MAX_VIEWER_RECORD_BYTES = 64 * 1024;
/**
 * The server's own bounds, a little wider than the app's so the app's reason
 * is the one a viewer reads. They hold even when the app enforces nothing.
 */
export const SCREEN_SHARE_RELAY_SLACK_MS = 5_000;
/** Sessions one device may open within `SCREEN_SHARE_COOLDOWN_WINDOW_MS` before the server refuses. */
export const SCREEN_SHARE_RELAY_OPENS = 12;
/** Wrong first-use codes a viewer may send before the session ends. */
export const SCREEN_SHARE_CODE_TRIES = 3;
/** With no frame for this long while live, the viewer says the display may be asleep. */
export const SCREEN_SHARE_NO_PICTURE_MS = 10_000;

/**
 * The first byte of a binary message on the viewer socket, and after the
 * session id on the host socket. What follows it: for hello, challenge and
 * proof, the message as UTF-8 JSON; for sealed, one sealed record, whose own
 * first byte inside the seal is a `SCREEN_SHARE_RECORD` type. The two number
 * spaces are separate on purpose and share no value.
 */
export const SCREEN_SHARE_WIRE = {
  hello: 1,
  challenge: 2,
  proof: 3,
  sealed: 4,
} as const;

/** Record types inside the sealed session. Slice 1 has no others. */
export const SCREEN_SHARE_RECORD = {
  /** Machine to viewer: `ScreenShareSessionState` as JSON. */
  state: 1,
  /** Machine to viewer: a frame (`encodeScreenShareFrame`). */
  frame: 2,
  /** Viewer to machine: `{ seq }`, the frame it has drawn. */
  frameReceived: 16,
  /** Viewer to machine: `{ displayId }`. */
  showDisplay: 17,
  /** Viewer to machine: the viewer is done. */
  end: 18,
  /** Viewer to machine, first use only: `{ code }`, what a person read off the machine's screen. */
  confirmCode: 19,
} as const;

/** Why the machine would not start, or ended, a session. Shown to the viewer in words. */
export const ScreenShareEndReason = Schema.Literals([
  "off",
  "busy",
  "cooldown",
  "unsupported",
  "no_host",
  "no_permission",
  "denied",
  "prompt_timeout",
  "stopped_at_machine",
  "viewer_ended",
  "viewer_silent",
  "time_limit",
  "device_removed",
  "handshake_failed",
  "protocol_error",
  "banner_lost",
  "app_quit",
  "turned_off",
  "wrong_code",
  "grant_removed",
  "host_refused",
  "host_replaced",
]);
export type ScreenShareEndReason = typeof ScreenShareEndReason.Type;

/** WebSocket close codes the viewer reads. 4401 stays "session ended" (auth). */
export const SCREEN_SHARE_CLOSE_REFUSED = 4460;
export const SCREEN_SHARE_CLOSE_ENDED = 4461;

export const ScreenShareViewerDevice = Schema.Struct({
  /** RFC 7638 thumbprint of the device's proof key, as the server read it from the session. */
  thumbprint: Schema.String,
  /** The name on this machine's approved list, not what the device says now. */
  label: Schema.String,
  /** What the device calls itself in this sign-in, when that differs from the list. */
  claimedLabel: Schema.optionalKey(Schema.String),
  shortId: Schema.String,
  kind: Schema.Literals(["connect", "phone"]),
});
export type ScreenShareViewerDevice = typeof ScreenShareViewerDevice.Type;

/** Server to host. `attached` answers the host's hello; nothing is passed before it. */
export const ScreenShareHostInbound = Schema.Union([
  Schema.Struct({ t: Schema.Literal("attached") }),
  Schema.Struct({
    t: Schema.Literal("open"),
    sid: Schema.String,
    environmentId: Schema.String,
    device: ScreenShareViewerDevice,
  }),
  Schema.Struct({ t: Schema.Literal("closed"), sid: Schema.String }),
]);
export type ScreenShareHostInbound = typeof ScreenShareHostInbound.Type;

/** What the app tells its server about itself; the server repeats it to viewers that ask. */
export const ScreenShareHostStatus = Schema.Struct({
  enabled: Schema.Boolean,
  supported: Schema.Boolean,
  busy: Schema.Boolean,
});
export type ScreenShareHostStatus = typeof ScreenShareHostStatus.Type;

/** The longest proof the server reads from a host's hello. */
export const SCREEN_SHARE_MAX_HOST_PROOF_LENGTH = 512;
/** How long a new host socket has to send its hello. */
export const SCREEN_SHARE_HOST_HELLO_MS = 5_000;
/** How often the app sends its proof again over an open link. */
export const SCREEN_SHARE_HOST_PROOF_RENEW_MS = 4 * 60_000;

/**
 * Host to server. `hello` comes first on every connection and carries the
 * app's proof that it is this machine's app: the desktop owner proof, or the
 * host proof of the secret a backend was launched with. The app sends it
 * again every few minutes; the server checks the latest one when a viewer
 * opens, and drops a host whose proof no longer holds.
 */
export const ScreenShareHostOutbound = Schema.Union([
  Schema.Struct({ t: Schema.Literal("hello"), proof: Schema.String }),
  Schema.Struct({ t: Schema.Literal("status"), status: ScreenShareHostStatus }),
  Schema.Struct({ t: Schema.Literal("close"), sid: Schema.String, reason: ScreenShareEndReason }),
]);
export type ScreenShareHostOutbound = typeof ScreenShareHostOutbound.Type;

/** Server to viewer, once, before any binary message. */
export const ScreenShareViewerOpened = Schema.Struct({
  t: Schema.Literal("open"),
  sid: Schema.String,
  environmentId: Schema.String,
});
export type ScreenShareViewerOpened = typeof ScreenShareViewerOpened.Type;

/** What the server knows about screen sharing on this machine. No route serves it: a viewer reads the refusal from the close. */
export const ScreenShareStatus = Schema.Struct({
  /** False when no app is attached to this server (a service with no desktop). */
  host: Schema.Boolean,
  enabled: Schema.Boolean,
  supported: Schema.Boolean,
  busy: Schema.Boolean,
});
export type ScreenShareStatus = typeof ScreenShareStatus.Type;

export const ScreenShareDisplay = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  primary: Schema.Boolean,
});
export type ScreenShareDisplay = typeof ScreenShareDisplay.Type;

/** What the machine tells the viewer inside the sealed session. */
export const ScreenShareSessionState = Schema.Union([
  Schema.Struct({ phase: Schema.Literal("waiting_for_approval") }),
  /** First use: a person at the machine allowed it; now the code on its screen is typed here. */
  Schema.Struct({ phase: Schema.Literal("needs_code"), triesLeft: Schema.Int }),
  Schema.Struct({
    phase: Schema.Literal("live"),
    displays: Schema.Array(ScreenShareDisplay),
    displayId: Schema.String,
    /** Epoch milliseconds at which the machine will end the session. */
    endsAt: Schema.Number,
  }),
  Schema.Struct({ phase: Schema.Literal("locked") }),
  Schema.Struct({ phase: Schema.Literal("ended"), reason: ScreenShareEndReason }),
]);
export type ScreenShareSessionState = typeof ScreenShareSessionState.Type;

export const ScreenShareFrameHeader = Schema.Struct({
  seq: Schema.Int,
  displayId: Schema.String,
  width: Schema.Int,
  height: Schema.Int,
  /** The pointer in frame pixels, when it is on this display. */
  pointer: Schema.optionalKey(Schema.Struct({ x: Schema.Number, y: Schema.Number })),
});
export type ScreenShareFrameHeader = typeof ScreenShareFrameHeader.Type;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** A frame record's body: a 4-byte header length, the header as JSON, then the JPEG. */
export const encodeScreenShareFrame = (
  header: ScreenShareFrameHeader,
  jpeg: Uint8Array,
): Uint8Array<ArrayBuffer> => {
  const head = encoder.encode(JSON.stringify(header));
  const out = new Uint8Array(4 + head.length + jpeg.length);
  new DataView(out.buffer).setUint32(0, head.length);
  out.set(head, 4);
  out.set(jpeg, 4 + head.length);
  return out;
};

const decodeFrameHeader = Schema.decodeUnknownSync(ScreenShareFrameHeader);

/** Throws on anything that is not a frame body. */
export const decodeScreenShareFrame = (
  body: Uint8Array,
): { readonly header: ScreenShareFrameHeader; readonly jpeg: Uint8Array } => {
  if (body.length < 4) throw new Error("Not a frame.");
  const length = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(0);
  if (length > 4096 || 4 + length > body.length) throw new Error("Not a frame.");
  const header = decodeFrameHeader(JSON.parse(decoder.decode(body.subarray(4, 4 + length))));
  return { header, jpeg: body.subarray(4 + length) };
};

/** One wire message: the type byte, then the body. */
export const encodeScreenShareWire = (type: number, body: Uint8Array): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(1 + body.length);
  out[0] = type;
  out.set(body, 1);
  return out;
};

/** A hello, challenge or proof: the type byte, then the message as UTF-8 JSON. */
export const encodeScreenShareWireJson = (type: number, value: unknown): Uint8Array<ArrayBuffer> =>
  encodeScreenShareWire(type, encoder.encode(JSON.stringify(value)));

/** The type byte and the body of a wire message; null for an empty one. */
export const decodeScreenShareWire = (
  message: Uint8Array,
): { readonly type: number; readonly body: Uint8Array } | null =>
  message.length === 0 ? null : { type: message[0]!, body: message.subarray(1) };

/** A body that is one JSON object, or null for anything else. */
export const decodeScreenShareJson = (body: Uint8Array): Record<string, unknown> | null => {
  try {
    const value: unknown = JSON.parse(decoder.decode(body));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isScreenShareSessionId = (value: string): boolean => SESSION_ID.test(value);

/** On the host socket every binary message starts with the 36-character session id. */
export const encodeScreenShareHostFrame = (
  sid: string,
  payload: Uint8Array,
): Uint8Array<ArrayBuffer> => {
  if (!isScreenShareSessionId(sid)) throw new Error("Bad session id.");
  const out = new Uint8Array(36 + payload.length);
  out.set(encoder.encode(sid), 0);
  out.set(payload, 36);
  return out;
};

export const decodeScreenShareHostFrame = (
  message: Uint8Array,
): { readonly sid: string; readonly payload: Uint8Array } | null => {
  if (message.length < 37) return null;
  let sid: string;
  try {
    sid = decoder.decode(message.subarray(0, 36));
  } catch {
    return null;
  }
  return isScreenShareSessionId(sid) ? { sid, payload: message.subarray(36) } : null;
};

// ---------------------------------------------------------------------------
// What the machine's own app shows in its settings (through the desktop bridge only).

export const ScreenShareGrant = Schema.Struct({
  thumbprint: Schema.String,
  label: Schema.String,
  shortId: Schema.String,
  grantedAt: Schema.String,
  lastUsedAt: Schema.String,
});
export type ScreenShareGrant = typeof ScreenShareGrant.Type;

export const ScreenShareAuditOutcome = Schema.Literals([
  "allowed_once",
  "allowed_always",
  "allowed_by_grant",
  "refused",
]);
export type ScreenShareAuditOutcome = typeof ScreenShareAuditOutcome.Type;

export const ScreenShareAuditEntry = Schema.Struct({
  id: Schema.String,
  at: Schema.String,
  label: Schema.String,
  shortId: Schema.String,
  mode: Schema.Literal("view"),
  outcome: ScreenShareAuditOutcome,
  startedAt: Schema.optionalKey(Schema.String),
  endedAt: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(ScreenShareEndReason),
  frames: Schema.optionalKey(Schema.Int),
});
export type ScreenShareAuditEntry = typeof ScreenShareAuditEntry.Type;

/** How this app's link to its own server stands; `refused` and `replaced` mean another program holds it. */
export const ScreenShareHostLink = Schema.Literals([
  "connecting",
  "attached",
  "refused",
  "replaced",
]);
export type ScreenShareHostLink = typeof ScreenShareHostLink.Type;

export const ScreenShareLocalState = Schema.Struct({
  supported: Schema.Boolean,
  enabled: Schema.Boolean,
  link: ScreenShareHostLink,
  /** macOS Screen Recording for the app: without it nothing can be shown. */
  screenRecording: Schema.Boolean,
  /** False when the store could not be read; sharing is then off until it is turned on again. */
  storeHealthy: Schema.Boolean,
  grants: Schema.Array(ScreenShareGrant),
  audit: Schema.Array(ScreenShareAuditEntry),
  active: Schema.NullOr(
    Schema.Struct({ label: Schema.String, shortId: Schema.String, startedAt: Schema.String }),
  ),
});
export type ScreenShareLocalState = typeof ScreenShareLocalState.Type;

/**
 * What the app's own window may ask its main process about screen sharing on
 * this machine. It reaches only the machine the app runs on: a window showing
 * another machine has no way to that machine's switch.
 */
export interface ScreenShareBridge {
  readonly getState: () => Promise<ScreenShareLocalState>;
  /** Turning on asks the system for Touch ID or the password; the answer says what is true afterwards. */
  readonly setEnabled: (enabled: boolean) => Promise<ScreenShareLocalState>;
  readonly removeGrant: (thumbprint: string) => Promise<ScreenShareLocalState>;
  /** Says this window is showing another machine's screen, so computer use here holds off. */
  readonly setViewing: (viewing: boolean) => Promise<void>;
}
