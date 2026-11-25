/**
 * Screen sharing (1490), the server's part: it passes a session's bytes
 * between a viewer's socket and the socket of this machine's own app, and
 * reads none of them. Who may open either socket is decided before this is
 * reached (`ScreenShareHttp.ts`); whether a session may start is decided by
 * the app, which holds the switch, the grants and the keys.
 *
 * The relay keeps its own promises, whatever the app on the other socket does:
 * a viewer's bytes only reach the host and the other way round; a handshake is
 * one hello, one challenge and one proof, each small, in that order and inside
 * a deadline; a viewer sends small records only; a session has a longest life;
 * one device opens a bounded number of sessions; a slow reader costs a bounded
 * amount of memory; and when either end goes the other hears of it at once.
 */
import {
  decodeScreenShareHostFrame,
  encodeScreenShareHostFrame,
  SCREEN_SHARE_CLOSE_ENDED,
  SCREEN_SHARE_CLOSE_REFUSED,
  SCREEN_SHARE_COOLDOWN_WINDOW_MS,
  SCREEN_SHARE_HANDSHAKE_MS,
  SCREEN_SHARE_MAX_BUFFER_BYTES,
  SCREEN_SHARE_MAX_CONTROL_BYTES,
  SCREEN_SHARE_MAX_MESSAGE_BYTES,
  SCREEN_SHARE_MAX_VIEWER_RECORD_BYTES,
  SCREEN_SHARE_PROMPT_MS,
  SCREEN_SHARE_RELAY_OPENS,
  SCREEN_SHARE_RELAY_SLACK_MS,
  SCREEN_SHARE_SESSION_MAX_MS,
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

/** The hello, the challenge and the proof must all have gone by inside this. */
export const RELAY_HANDSHAKE_MS = SCREEN_SHARE_HANDSHAKE_MS + SCREEN_SHARE_RELAY_SLACK_MS;
/** After the proof, the app must say something sealed (asking, or live) inside this. */
export const RELAY_FIRST_WORD_MS = SCREEN_SHARE_RELAY_SLACK_MS;
/** The longest a session lives here: the asking, the code, the session's own limit. */
export const RELAY_SESSION_MS =
  RELAY_HANDSHAKE_MS +
  2 * SCREEN_SHARE_PROMPT_MS +
  SCREEN_SHARE_SESSION_MAX_MS +
  SCREEN_SHARE_RELAY_SLACK_MS;

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
  /** The app sent a sealed record since the proof. */
  hostSpoke: boolean;
  /** Cancels the deadline of the stage the session is in, and its longest life. */
  cancelStage: () => void;
  cancelLife: () => void;
}

interface Host<Standing> {
  readonly peer: ScreenSharePeer;
  /** What the routes kept of the app's latest proof, to check again when a viewer opens. Never the proof. */
  standing: Standing;
  /** Null until the app said where it stands: an app that just attached is not yet "off". */
  status: ScreenShareHostStatus | null;
}

export interface ScreenShareRelayOptions {
  readonly newSessionId?: () => string;
  readonly maxBufferBytes?: number;
  /** Runs `run` once after `ms`; the result cancels it. */
  readonly after?: (ms: number, run: () => void) => () => void;
  readonly now?: () => number;
}

export class ScreenShareRelay<Standing = unknown> {
  private host: Host<Standing> | null = null;
  private readonly sessions = new Map<string, Session>();
  private readonly newSessionId: () => string;
  private readonly maxBufferBytes: number;
  private readonly after: (ms: number, run: () => void) => () => void;
  private readonly now: () => number;
  /** Per device thumbprint: when it opened sessions lately. */
  private readonly opens = new Map<string, Array<number>>();

  constructor(options: ScreenShareRelayOptions = {}) {
    this.newSessionId = options.newSessionId ?? (() => NodeCrypto.randomUUID());
    this.maxBufferBytes = options.maxBufferBytes ?? SCREEN_SHARE_MAX_BUFFER_BYTES;
    this.after =
      options.after ??
      ((ms, run) => {
        // @effect-diagnostics-next-line globalTimers:off - a plain class; the timer is cancelled when the session ends.
        const timer = setTimeout(run, ms);
        // A waiting deadline is no reason to keep the server from stopping.
        timer.unref();
        return () => clearTimeout(timer);
      });
    // @effect-diagnostics-next-line globalDate:off - a plain class outside any Effect fiber.
    this.now = options.now ?? (() => Date.now());
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

  /** What the routes kept of the attached app's latest proof, for them to check again. */
  hostStanding(): Standing | undefined {
    return this.host?.standing;
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
    standing: Standing,
  ): {
    /** A newer proof from the same app, already checked by the routes. */
    readonly reprove: (standing: Standing) => void;
    /** Drops this app, if it is still the one attached: its newer proof did not hold. */
    readonly drop: (reason: string) => void;
    readonly text: (message: string) => void;
    readonly binary: (message: Uint8Array) => void;
    readonly closed: () => void;
  } {
    const previous = this.host;
    if (previous !== null) {
      this.endAll("no_host");
      previous.peer.close(1012, "replaced");
    }
    const host: Host<Standing> = { peer, standing, status: null };
    this.host = host;
    const attached: ScreenShareHostInbound = { t: "attached" };
    peer.sendText(JSON.stringify(attached));
    const current = () => this.host === host;
    return {
      reprove: (next) => {
        if (current()) host.standing = next;
      },
      drop: (reason) => {
        if (current()) this.dropHost(reason);
        else peer.close(SCREEN_SHARE_CLOSE_REFUSED, reason);
      },
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
          if (!envelope.status.enabled) this.endAll("turned_off");
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
        if (frame.payload[0] === SCREEN_SHARE_WIRE.sealed && !session.hostSpoke) {
          session.hostSpoke = true;
          session.cancelStage();
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
        /** A viewer has nothing to say in text: any text ends its session. */
        readonly text: () => void;
        readonly closed: () => void;
      } {
    const host = this.host;
    // An app that attached a moment ago and has not said where it stands is not there yet.
    if (host === null || host.status === null) return { refused: "no_host" };
    if (!host.status.supported) return { refused: "unsupported" };
    if (!host.status.enabled) return { refused: "off" };
    if (host.status.busy || this.sessions.size > 0) return { refused: "busy" };
    if (!this.mayOpen(device.thumbprint)) return { refused: "cooldown" };
    const sid = this.newSessionId();
    const session: Session = {
      sid,
      viewer: peer,
      viewerStep: 0,
      challenged: false,
      hostSpoke: false,
      cancelStage: this.after(RELAY_HANDSHAKE_MS, () => this.end(sid, "handshake_failed", true)),
      cancelLife: this.after(RELAY_SESSION_MS, () => this.end(sid, "time_limit", true)),
    };
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
        const step = session.viewerStep;
        if (!this.fromViewer(session, message)) {
          this.end(sid, "protocol_error", true);
          return;
        }
        if (step < VIEWER_ORDER.length && session.viewerStep === VIEWER_ORDER.length) {
          // The proof went by: the app now has a moment to say it is asking, or live.
          session.cancelStage();
          session.cancelStage = this.after(RELAY_FIRST_WORD_MS, () =>
            this.end(sid, "handshake_failed", true),
          );
        }
        if (!this.forward(live.peer, encodeScreenShareHostFrame(sid, message)))
          this.end(sid, "protocol_error", true);
      },
      text: () => {
        if (this.sessions.get(sid) === session) this.end(sid, "protocol_error", true);
      },
      closed: () => {
        if (this.sessions.get(sid) !== session) return;
        this.forget(session);
        this.tellHostClosed(sid);
      },
    };
  }

  /** Counts an open for this device; false once it opened too many lately. */
  private mayOpen(thumbprint: string): boolean {
    const now = this.now();
    for (const [key, times] of this.opens) {
      const recent = times.filter((at) => now - at < SCREEN_SHARE_COOLDOWN_WINDOW_MS);
      if (recent.length === 0) this.opens.delete(key);
      else this.opens.set(key, recent);
    }
    const mine = this.opens.get(thumbprint) ?? [];
    if (mine.length >= SCREEN_SHARE_RELAY_OPENS) return false;
    this.opens.set(thumbprint, [...mine, now]);
    return true;
  }

  private forget(session: Session): void {
    session.cancelStage();
    session.cancelLife();
    this.sessions.delete(session.sid);
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
    // Sealed records from a viewer are words (seen this frame, show that display): small.
    return (
      type === SCREEN_SHARE_WIRE.sealed &&
      message.length > 1 &&
      message.length <= SCREEN_SHARE_MAX_VIEWER_RECORD_BYTES
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
    this.forget(session);
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
