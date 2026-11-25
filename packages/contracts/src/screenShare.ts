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

/** The first byte of a binary message on the viewer socket, and after the session id on the host socket. */
export const SCREEN_SHARE_WIRE = {
  hello: 1,
  challenge: 2,
  proof: 3,
  sealed: 16,
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
]);
export type ScreenShareEndReason = typeof ScreenShareEndReason.Type;

/** WebSocket close codes the viewer reads. 4401 stays "session ended" (auth). */
export const SCREEN_SHARE_CLOSE_REFUSED = 4460;
export const SCREEN_SHARE_CLOSE_ENDED = 4461;

export const ScreenShareViewerDevice = Schema.Struct({
  /** RFC 7638 thumbprint of the device's proof key, as the server read it from the session. */
  thumbprint: Schema.String,
  label: Schema.String,
  shortId: Schema.String,
  kind: Schema.Literals(["connect", "phone"]),
});
export type ScreenShareViewerDevice = typeof ScreenShareViewerDevice.Type;

/** Server to host. */
export const ScreenShareHostInbound = Schema.Union([
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

/** Host to server. */
export const ScreenShareHostOutbound = Schema.Union([
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

/** `GET /api/screen-share/status`, for an approved device or the machine's own app. */
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

export const ScreenShareLocalState = Schema.Struct({
  supported: Schema.Boolean,
  enabled: Schema.Boolean,
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
