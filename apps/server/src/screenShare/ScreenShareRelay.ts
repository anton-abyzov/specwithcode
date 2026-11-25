/**
 * Screen sharing (1490), the server's part: it passes a session's bytes
 * between a viewer's socket and the socket of this machine's own app, and
 * reads none of them. Who may open either socket is decided before this is
 * reached (`ScreenShareHttp.ts`); whether a session may start is decided by
 * the app, which holds the switch, the grants and the keys.
 *
 * The relay keeps four promises of its own: a viewer's bytes only reach the
 * host and the other way round; a handshake is one hello, one challenge and
 * one proof, each small, in that order; a slow reader costs a bounded amount
 * of memory; and when either end goes the other hears of it at once.
 */
import {
  decodeScreenShareHostFrame,
  encodeScreenShareHostFrame,
  SCREEN_SHARE_CLOSE_ENDED,
  SCREEN_SHARE_CLOSE_REFUSED,
  SCREEN_SHARE_MAX_BUFFER_BYTES,
  SCREEN_SHARE_MAX_CONTROL_BYTES,
  SCREEN_SHARE_MAX_MESSAGE_BYTES,
  SCREEN_SHARE_WIRE,
  type ScreenShareEndReason,
  type ScreenShareHostInbound,
  type ScreenShareHostStatus,
  type ScreenShareStatus,
  type ScreenShareViewerDevice,
  type ScreenShareViewerOpened,
} from "@specweave-studio/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off - a synchronous random id; the relay is a plain class.
import * as NodeCrypto from "node:crypto";

/** One end of a socket, as the relay uses it. */
export interface ScreenSharePeer {
  readonly sendText: (text: string) => void;
  readonly sendBinary: (bytes: Uint8Array) => void;
  readonly close: (code: number, reason: string) => void;
  /** Bytes accepted by `send*` that the other end has not taken yet. */
  readonly bufferedBytes: () => number;
}

/**
 * What each side may send next. The viewer: hello, then proof, then sealed
 * records. The host: one challenge once the hello passed, then sealed records.
 */
const VIEWER_ORDER = [SCREEN_SHARE_WIRE.hello, SCREEN_SHARE_WIRE.proof] as const;

const OFF: ScreenShareHostStatus = { enabled: false, supported: false, busy: false };

const isHostStatus = (value: unknown): value is ScreenShareHostStatus => {
  if (typeof value !== "object" || value === null) return false;
  const status = value as Record<string, unknown>;
  return (
    typeof status.enabled === "boolean" &&
    typeof status.supported === "boolean" &&
    typeof status.busy === "boolean"
  );
};

/** Reasons a refusal may carry before a session exists; anything else reads as ended. */
const REFUSALS: ReadonlySet<string> = new Set([
  "off",
  "busy",
  "cooldown",
  "unsupported",
  "no_host",
  "no_permission",
  "denied",
  "prompt_timeout",
]);

/** The words the app may put in a close: lower-case letters and underscores, nothing else. */
const REASON = /^[a-z_]{1,32}$/;

interface Session {
  readonly sid: string;
  readonly viewer: ScreenSharePeer;
  /** How many of `VIEWER_ORDER` the viewer has sent. */
  viewerStep: number;
  challenged: boolean;
}

interface Host {
  readonly peer: ScreenSharePeer;
  /** What the app proved itself with when it attached; the routes check it again later. */
  readonly credential: string | undefined;
  status: ScreenShareHostStatus;
}

export interface ScreenShareRelayOptions {
  readonly newSessionId?: () => string;
  readonly maxBufferBytes?: number;
}

export class ScreenShareRelay {
  private host: Host | null = null;
  private readonly sessions = new Map<string, Session>();
  private readonly newSessionId: () => string;
  private readonly maxBufferBytes: number;

  constructor(options: ScreenShareRelayOptions = {}) {
    this.newSessionId = options.newSessionId ?? (() => NodeCrypto.randomUUID());
    this.maxBufferBytes = options.maxBufferBytes ?? SCREEN_SHARE_MAX_BUFFER_BYTES;
  }

  status(): ScreenShareStatus {
    const status = this.host?.status ?? OFF;
    return {
      host: this.host !== null,
      enabled: status.enabled,
      supported: status.supported,
      busy: status.busy || this.sessions.size > 0,
    };
  }

  /** What the attached app proved itself with, for the routes to check again. */
  hostCredential(): string | undefined {
    return this.host?.credential;
  }

  /** Drops the attached app (its proof no longer holds) and ends its sessions. */
  dropHost(reason: string): void {
    const host = this.host;
    if (host === null) return;
    this.host = null;
    this.endAll("no_host");
    host.peer.close(SCREEN_SHARE_CLOSE_REFUSED, reason);
  }

  /**
   * The app's socket, once the routes accepted its proof. A new one replaces
   * the old (the app restarted), and the old one's sessions end. Returns what
   * to call with what arrives on it.
   */
  attachHost(
    peer: ScreenSharePeer,
    credential?: string,
  ): {
    readonly text: (message: string) => void;
    readonly binary: (message: Uint8Array) => void;
    readonly closed: () => void;
  } {
    const previous = this.host;
    if (previous !== null) {
      this.endAll("no_host");
      previous.peer.close(1012, "replaced");
    }
    const host: Host = { peer, credential, status: OFF };
    this.host = host;
    const attached: ScreenShareHostInbound = { t: "attached" };
    peer.sendText(JSON.stringify(attached));
    const current = () => this.host === host;
    return {
      text: (message) => {
        if (!current()) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(message);
        } catch {
          return;
        }
        if (typeof parsed !== "object" || parsed === null) return;
        const envelope = parsed as Record<string, unknown>;
        if (envelope.t === "status" && isHostStatus(envelope.status)) {
          host.status = {
            enabled: envelope.status.enabled,
            supported: envelope.status.supported,
            busy: envelope.status.busy,
          };
          // Turned off while a session runs: the app ends it too, this is the belt.
          if (!host.status.enabled) this.endAll("turned_off");
        } else if (
          envelope.t === "close" &&
          typeof envelope.sid === "string" &&
          typeof envelope.reason === "string" &&
          REASON.test(envelope.reason)
        ) {
          this.end(envelope.sid, envelope.reason as ScreenShareEndReason, false);
        }
      },
      binary: (message) => {
        if (!current()) return;
        const frame = decodeScreenShareHostFrame(message);
        if (frame === null) return;
        const session = this.sessions.get(frame.sid);
        if (session === undefined) return;
        if (!this.fromHost(session, frame.payload)) {
          this.end(frame.sid, "protocol_error", true);
          return;
        }
        if (!this.forward(session.viewer, frame.payload))
          this.end(frame.sid, "viewer_silent", true);
      },
      closed: () => {
        if (!current()) return;
        this.host = null;
        this.endAll("no_host");
      },
    };
  }

  /**
   * A viewer's socket, already known to belong to a person's approved device.
   * Refused here only for what the server can see; the app decides the rest.
   */
  openViewer(
    peer: ScreenSharePeer,
    device: ScreenShareViewerDevice,
    environmentId: string,
  ):
    | { readonly refused: ScreenShareEndReason }
    | {
        readonly sid: string;
        readonly binary: (message: Uint8Array) => void;
        readonly closed: () => void;
      } {
    const host = this.host;
    if (host === null) return { refused: "no_host" };
    if (!host.status.supported) return { refused: "unsupported" };
    if (!host.status.enabled) return { refused: "off" };
    if (host.status.busy || this.sessions.size > 0) return { refused: "busy" };
    const sid = this.newSessionId();
    const session: Session = { sid, viewer: peer, viewerStep: 0, challenged: false };
    this.sessions.set(sid, session);
    const opened: ScreenShareViewerOpened = { t: "open", sid, environmentId };
    peer.sendText(JSON.stringify(opened));
    const inbound: ScreenShareHostInbound = { t: "open", sid, environmentId, device };
    host.peer.sendText(JSON.stringify(inbound));
    return {
      sid,
      binary: (message) => {
        const live = this.host;
        if (live === null || this.sessions.get(sid) !== session) return;
        if (!this.fromViewer(session, message)) {
          this.end(sid, "protocol_error", true);
          return;
        }
        if (!this.forward(live.peer, encodeScreenShareHostFrame(sid, message)))
          this.end(sid, "protocol_error", true);
      },
      closed: () => {
        if (!this.sessions.delete(sid)) return;
        this.tellHostClosed(sid);
      },
    };
  }

  private fromViewer(session: Session, message: Uint8Array): boolean {
    const type = message[0];
    if (session.viewerStep < VIEWER_ORDER.length) {
      // The proof waits for the challenge it answers.
      if (type === SCREEN_SHARE_WIRE.proof && !session.challenged) return false;
      if (type !== VIEWER_ORDER[session.viewerStep]) return false;
      if (message.length > SCREEN_SHARE_MAX_CONTROL_BYTES) return false;
      session.viewerStep += 1;
      return true;
    }
    return (
      type === SCREEN_SHARE_WIRE.sealed &&
      message.length > 1 &&
      message.length <= SCREEN_SHARE_MAX_MESSAGE_BYTES
    );
  }

  private fromHost(session: Session, message: Uint8Array): boolean {
    const type = message[0];
    if (type === SCREEN_SHARE_WIRE.challenge) {
      if (session.challenged || session.viewerStep !== 1) return false;
      if (message.length > SCREEN_SHARE_MAX_CONTROL_BYTES) return false;
      session.challenged = true;
      return true;
    }
    // Nothing is sealed before the viewer's proof went by.
    return (
      type === SCREEN_SHARE_WIRE.sealed &&
      session.viewerStep === VIEWER_ORDER.length &&
      message.length > 1 &&
      message.length <= SCREEN_SHARE_MAX_MESSAGE_BYTES
    );
  }

  private forward(to: ScreenSharePeer, bytes: Uint8Array): boolean {
    if (to.bufferedBytes() + bytes.length > this.maxBufferBytes) return false;
    to.sendBinary(bytes);
    return true;
  }

  private tellHostClosed(sid: string): void {
    const inbound: ScreenShareHostInbound = { t: "closed", sid };
    this.host?.peer.sendText(JSON.stringify(inbound));
  }

  /** Ends one session. `tellHost` is false when the host asked for it. */
  private end(sid: string, reason: ScreenShareEndReason, tellHost: boolean): void {
    const session = this.sessions.get(sid);
    if (session === undefined) return;
    this.sessions.delete(sid);
    session.viewer.close(
      REFUSALS.has(reason) ? SCREEN_SHARE_CLOSE_REFUSED : SCREEN_SHARE_CLOSE_ENDED,
      reason,
    );
    if (tellHost) this.tellHostClosed(sid);
  }

  private endAll(reason: ScreenShareEndReason): void {
    for (const sid of [...this.sessions.keys()]) this.end(sid, reason, true);
  }
}
