/**
 * The app's side of the screen sharing socket to its own server (1490): the
 * one link through which viewers' sealed bytes reach `ScreenShareSessions`.
 *
 * The first thing sent on every connection is the app's proof. Nothing from
 * the server is acted on before it answers `attached`. When the server refuses
 * the proof, or another program takes the link over, that is shown at this
 * machine (`onLink`) and tried again later, never in a tight loop.
 */
import {
  decodeScreenShareHostFrame,
  encodeScreenShareHostFrame,
  isScreenShareSessionId,
  SCREEN_SHARE_CLOSE_REFUSED,
  type ScreenShareEndReason,
  type ScreenShareHostLink,
  type ScreenShareHostOutbound,
  type ScreenShareHostStatus,
  type ScreenShareViewerDevice,
} from "@specweave-studio/contracts";

/** A WebSocket, as little of one as the link needs. */
export interface HostSocket {
  readonly send: (data: string | Uint8Array) => void;
  readonly close: () => void;
  onOpen: (() => void) | null;
  onMessage: ((data: string | Uint8Array) => void) | null;
  onClose: ((code: number, reason: string) => void) | null;
}

export interface ScreenShareHostDeps {
  /** Where the server's host socket is right now and the proof to open it with; null when there is no server yet. */
  readonly target: () => Promise<{ readonly url: string; readonly proof: string } | null>;
  readonly open: (url: string) => HostSocket;
  readonly after: (ms: number, run: () => void) => () => void;
  readonly sessions: {
    readonly status: () => ScreenShareHostStatus;
    readonly opened: (sid: string, environmentId: string, device: ScreenShareViewerDevice) => void;
    readonly received: (sid: string, payload: Uint8Array) => void;
    readonly closed: (sid: string) => void;
    readonly disconnected: () => void;
  };
  readonly onLink: (link: ScreenShareHostLink) => void;
}

/** Waits between tries after an ordinary drop. */
export const HOST_RETRY_MS = [2_000, 4_000, 8_000, 15_000, 30_000] as const;
/** After the server refused the proof, or another program took the link. */
export const HOST_REFUSED_RETRY_MS = 60_000;

const isDevice = (value: unknown): value is ScreenShareViewerDevice => {
  if (typeof value !== "object" || value === null) return false;
  const device = value as Record<string, unknown>;
  return (
    typeof device.thumbprint === "string" &&
    typeof device.label === "string" &&
    typeof device.shortId === "string" &&
    (device.kind === "connect" || device.kind === "phone") &&
    (device.claimedLabel === undefined || typeof device.claimedLabel === "string")
  );
};

export class ScreenShareHost {
  private socket: HostSocket | null = null;
  private attached = false;
  private stopped = true;
  private tries = 0;
  private cancelRetry: (() => void) | null = null;
  private link: ScreenShareHostLink = "connecting";
  private readonly deps: ScreenShareHostDeps;

  constructor(deps: ScreenShareHostDeps) {
    this.deps = deps;
  }

  get state(): ScreenShareHostLink {
    return this.link;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.cancelRetry?.();
    this.cancelRetry = null;
    const socket = this.socket;
    this.socket = null;
    this.attached = false;
    socket?.close();
  }

  /** Bytes for the viewer of `sid`. Dropped when the link is down: the session ends with it. */
  send(sid: string, payload: Uint8Array): void {
    if (this.attached) this.socket?.send(encodeScreenShareHostFrame(sid, payload));
  }

  close(sid: string, reason: ScreenShareEndReason): void {
    this.tell({ t: "close", sid, reason });
  }

  /** Tells the server whether sharing is on, possible and busy. Call whenever one of them changes. */
  publishStatus(): void {
    this.tell({ t: "status", status: this.deps.sessions.status() });
  }

  private tell(message: ScreenShareHostOutbound): void {
    if (this.attached) this.socket?.send(JSON.stringify(message));
  }

  private setLink(link: ScreenShareHostLink): void {
    if (this.link === link) return;
    this.link = link;
    this.deps.onLink(link);
  }

  private retry(ms: number): void {
    if (this.stopped) return;
    this.cancelRetry?.();
    this.cancelRetry = this.deps.after(ms, () => {
      this.cancelRetry = null;
      void this.connect();
    });
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.socket !== null) return;
    let target: Awaited<ReturnType<ScreenShareHostDeps["target"]>> = null;
    try {
      target = await this.deps.target();
    } catch {
      target = null;
    }
    if (this.stopped || this.socket !== null) return;
    if (target === null) {
      this.tries += 1;
      return this.retry(HOST_RETRY_MS[Math.min(this.tries, HOST_RETRY_MS.length) - 1]!);
    }
    const { proof } = target;
    const socket = this.deps.open(target.url);
    this.socket = socket;
    this.attached = false;
    const mine = () => this.socket === socket;
    socket.onOpen = () => {
      if (mine())
        socket.send(JSON.stringify({ t: "hello", proof } satisfies ScreenShareHostOutbound));
    };
    socket.onMessage = (data) => {
      if (mine()) this.heard(data);
    };
    socket.onClose = (code, reason) => {
      if (!mine()) return;
      this.socket = null;
      const wasAttached = this.attached;
      this.attached = false;
      if (wasAttached) this.deps.sessions.disconnected();
      if (this.stopped) return;
      if (code === SCREEN_SHARE_CLOSE_REFUSED) {
        this.setLink("refused");
        return this.retry(HOST_REFUSED_RETRY_MS);
      }
      if (code === 1012 && reason === "replaced") {
        this.setLink("replaced");
        return this.retry(HOST_REFUSED_RETRY_MS);
      }
      // A link that was up and dropped starts over quickly; one that never came up backs off.
      this.tries = wasAttached ? 1 : this.tries + 1;
      if (this.link === "attached") this.setLink("connecting");
      this.retry(HOST_RETRY_MS[Math.min(this.tries, HOST_RETRY_MS.length) - 1]!);
    };
  }

  private heard(data: string | Uint8Array): void {
    const { sessions } = this.deps;
    if (typeof data !== "string") {
      if (!this.attached) return;
      const frame = decodeScreenShareHostFrame(data);
      if (frame !== null) sessions.received(frame.sid, frame.payload);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const message = parsed as Record<string, unknown>;
    if (message.t === "attached") {
      if (this.attached) return;
      this.attached = true;
      this.tries = 0;
      this.setLink("attached");
      return this.publishStatus();
    }
    // Before the server said `attached` it has not accepted this app: nothing else counts.
    if (!this.attached || typeof message.sid !== "string" || !isScreenShareSessionId(message.sid))
      return;
    if (message.t === "closed") return sessions.closed(message.sid);
    if (
      message.t === "open" &&
      typeof message.environmentId === "string" &&
      isDevice(message.device)
    )
      sessions.opened(message.sid, message.environmentId, message.device);
  }
}
