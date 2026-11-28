/**
 * The viewing device's end of a screen sharing session (1490): opens the view
 * socket on the machine's own server, runs the handshake with this device's
 * key, and passes what arrives through the rules in `screenViewer.logic.ts`.
 *
 * Nothing of the browser is in here (`screenShareBrowser.ts` has that), so a
 * test runs it against the machine's half of the real handshake.
 *
 * The server in between sees only sealed bytes. Nothing is sent as text: the
 * server ends a session on any text from a viewer. Everything this device
 * says after the handshake is a small sealed record.
 */
import {
  SCREEN_SHARE_MAX_VIEWER_RECORD_BYTES,
  SCREEN_SHARE_WIRE,
  isScreenShareSessionId,
  type ScreenShareFrameHeader,
} from "@specweave-studio/contracts";
import type { DpopPublicJwk } from "@specweave-studio/shared/dpop";
import {
  ScreenShareHandshakeError,
  answerScreenShareChallenge,
  makeScreenShareKnock,
  makeScreenShareOpener,
  makeScreenShareSealer,
  startScreenShareViewer,
  type ScreenShareOpener,
  type ScreenShareSealer,
  type ScreenShareViewerStart,
} from "@specweave-studio/shared/screenShareChannel";

import {
  initialScreenViewer,
  reduceScreenViewer,
  type ScreenViewerEffect,
  type ScreenViewerEvent,
  type ScreenViewerModel,
  type ScreenViewerViewport,
} from "./screenViewer.logic";

/** A WebSocket, as little of one as a view needs. Binary only on the way out. */
export interface ScreenViewerSocket {
  readonly send: (bytes: Uint8Array<ArrayBuffer>) => void;
  readonly close: () => void;
  onText: ((text: string) => void) | null;
  onBinary: ((bytes: Uint8Array) => void) | null;
  onClose: ((code: number, reason: string) => void) | null;
}

export interface ScreenViewerDeviceKey {
  readonly publicJwk: DpopPublicJwk;
  /** ES256 over `data`, as the 64 bytes r then s. */
  readonly sign: (data: Uint8Array<ArrayBuffer>) => Promise<Uint8Array>;
}

export interface ScreenViewerDeps {
  readonly environmentId: string;
  /** Opens the view socket; null when no way to the machine could be found. */
  readonly open: () => Promise<ScreenViewerSocket | null>;
  /** This device's approved key; null when it has none. */
  readonly deviceKey: () => Promise<ScreenViewerDeviceKey | null>;
  /** The machine keys this device saved, by environment. They are public keys. */
  readonly pins: {
    readonly read: (environmentId: string) => string | undefined;
    readonly write: (environmentId: string, machineKey: string) => void;
  };
  readonly now: () => number;
  /** Runs `run` every `ms`; the result stops it. */
  readonly every: (ms: number, run: () => void) => () => void;
  readonly onModel: (model: ScreenViewerModel) => void;
  /** Puts a frame on screen. The frame is confirmed to the machine once this resolves. */
  readonly draw: (header: ScreenShareFrameHeader, jpeg: Uint8Array) => Promise<void>;
  readonly clear: () => void;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

const wire = (type: number, body: Uint8Array): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(1 + body.length);
  out[0] = type;
  out.set(body, 1);
  return out;
};

/** One view of one machine's screen, from opening the socket to its end. */
export class ScreenViewerSession {
  private current: ScreenViewerModel;
  private socket: ScreenViewerSocket | null = null;
  private opened = false;
  private sid: string | null = null;
  private start_: ScreenShareViewerStart | null = null;
  private key: ScreenViewerDeviceKey | null = null;
  private pin: string | undefined;
  private sealer: ScreenShareSealer | null = null;
  private opener: ScreenShareOpener | null = null;
  private stopTicks: (() => void) | null = null;
  private disposed = false;
  /** The server's nonce was answered with this device's key. Once. */
  private knocked = false;
  /** The surface is gone: nothing is drawn or reported any more. */
  private quiet = false;
  /** Everything happens one after another, in the order it came. */
  private queue: Promise<void> = Promise.resolve();
  private readonly deps: ScreenViewerDeps;

  constructor(deps: ScreenViewerDeps) {
    this.deps = deps;
    this.current = initialScreenViewer(deps.now());
  }

  get model(): ScreenViewerModel {
    return this.current;
  }

  /** Resolves once everything already under way has finished. */
  idle(): Promise<void> {
    return this.queue;
  }

  start(): void {
    this.enqueue(async () => {
      this.key = await this.deps.deviceKey().catch(() => null);
      if (this.key === null) return this.apply({ t: "no_device_key" });
      this.pin = this.deps.pins.read(this.deps.environmentId);
      const socket = await this.deps.open().catch(() => null);
      if (this.disposed) return socket?.close();
      if (socket === null)
        return this.apply({ t: "closed", code: 1006, reason: "", opened: false });
      this.socket = socket;
      socket.onText = (text) => this.enqueue(() => this.heardText(text));
      socket.onBinary = (bytes) => this.enqueue(() => this.heardBinary(bytes));
      socket.onClose = (code, reason) =>
        this.enqueue(() => this.apply({ t: "closed", code, reason, opened: this.opened }));
      this.stopTicks = this.deps.every(1000, () =>
        this.enqueue(() => this.apply({ t: "tick", now: this.deps.now() })),
      );
    });
  }

  typedCode(text: string): void {
    this.enqueue(() => this.apply({ t: "typed_code", text }));
  }

  chooseDisplay(displayId: string): void {
    this.enqueue(() => this.apply({ t: "choose_display", displayId }));
  }

  /** The picture area's size in device pixels and the picture choice; sent once the machine reads it. */
  setViewport(viewport: ScreenViewerViewport): void {
    this.enqueue(() => this.apply({ t: "viewport", viewport }));
  }

  end(): void {
    this.enqueue(() => this.apply({ t: "end_here" }));
  }

  /** The surface is gone: end it, stop everything, say nothing more to anyone. */
  dispose(): void {
    this.quiet = true;
    this.end();
    this.enqueue(async () => {
      this.disposed = true;
      this.stopTicks?.();
      this.stopTicks = null;
      this.socket?.close();
    });
  }

  private enqueue(work: () => Promise<void> | void): void {
    this.queue = this.queue.then(work).catch(() => this.fail("unexpected"));
  }

  private fail(failure: string): Promise<void> {
    return this.apply({ t: "handshake_failed", failure }).catch(() => undefined);
  }

  private async apply(event: ScreenViewerEvent): Promise<void> {
    if (this.disposed) return;
    const step = reduceScreenViewer(this.current, event);
    const changed = step.model !== this.current;
    this.current = step.model;
    if (changed && !this.quiet) this.deps.onModel(step.model);
    for (const effect of step.effects) await this.run(effect);
  }

  private async run(effect: ScreenViewerEffect): Promise<void> {
    switch (effect.t) {
      case "draw":
        // A picture that cannot be drawn is not confirmed as seen.
        return this.quiet ? undefined : this.deps.draw(effect.header, effect.jpeg);
      case "clear_picture":
        return this.quiet ? undefined : this.deps.clear();
      case "save_machine_key":
        return this.deps.pins.write(this.deps.environmentId, effect.machineKey);
      case "close":
        this.stopTicks?.();
        this.stopTicks = null;
        return this.socket?.close();
      case "send": {
        if (this.sealer === null || this.socket === null) return;
        const record = await this.sealer.seal(
          effect.type,
          encoder.encode(JSON.stringify(effect.body)),
        );
        const message = wire(SCREEN_SHARE_WIRE.sealed, record);
        // The server ends a session on a larger one; nothing this device says is that long.
        if (message.length <= SCREEN_SHARE_MAX_VIEWER_RECORD_BYTES) this.socket.send(message);
      }
    }
  }

  private async heardText(text: string): Promise<void> {
    // The server says two things in text, once each and in this order: sign this
    // nonce with the device's key, then which session this is.
    if (this.sid !== null || this.key === null || this.socket === null) return;
    let opened: Record<string, unknown>;
    try {
      opened = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return this.fail("malformed");
    }
    const { sid, environmentId } = opened;
    if (opened.t === "prove" && !this.knocked) {
      this.knocked = true;
      // Signed for the machine that was asked for, and no other.
      if (typeof opened.nonce !== "string" || environmentId !== this.deps.environmentId)
        return this.fail("malformed");
      try {
        const knock = await makeScreenShareKnock({
          deviceJwk: this.key.publicJwk,
          environmentId: this.deps.environmentId,
          nonce: opened.nonce,
          nowEpochSeconds: Math.floor(this.deps.now() / 1000),
          sign: this.key.sign,
        });
        this.socket?.send(wire(SCREEN_SHARE_WIRE.knock, encoder.encode(knock)));
      } catch {
        return this.fail("malformed");
      }
      return;
    }
    if (
      opened.t !== "open" ||
      // A session nobody knocked for is not this device's.
      !this.knocked ||
      typeof sid !== "string" ||
      !isScreenShareSessionId(sid) ||
      // The session is signed for the machine that was asked for, and no other.
      environmentId !== this.deps.environmentId
    )
      return this.fail("malformed");
    this.sid = sid;
    this.opened = true;
    this.start_ = startScreenShareViewer({
      mode: "view",
      deviceJwk: this.key.publicJwk,
      knowsMachine: this.pin !== undefined,
    });
    this.socket.send(
      wire(SCREEN_SHARE_WIRE.hello, encoder.encode(JSON.stringify(this.start_.hello))),
    );
  }

  private async heardBinary(bytes: Uint8Array): Promise<void> {
    const type = bytes[0];
    const body = bytes.subarray(1);
    if (this.sid === null || this.start_ === null || this.key === null || this.socket === null)
      return this.fail("malformed");
    if (type === SCREEN_SHARE_WIRE.challenge && this.opener === null) {
      let challenge: unknown;
      try {
        challenge = JSON.parse(decoder.decode(body));
      } catch {
        return this.fail("malformed");
      }
      try {
        const answer = await answerScreenShareChallenge({
          start: this.start_,
          challenge,
          environmentId: this.deps.environmentId,
          sessionId: this.sid,
          pinnedMachineKey: this.pin,
          nowEpochSeconds: Math.floor(this.deps.now() / 1000),
          sign: this.key.sign,
        });
        this.sealer = makeScreenShareSealer(answer.keys.toTarget, this.sid);
        this.opener = makeScreenShareOpener(answer.keys.toViewer, this.sid);
        this.socket.send(
          wire(SCREEN_SHARE_WIRE.proof, encoder.encode(JSON.stringify(answer.proof))),
        );
        return await this.apply({
          t: "handshake",
          code: answer.code,
          machineKey: answer.machineKey,
          pinned: this.pin !== undefined,
        });
      } catch (error) {
        return this.fail(error instanceof ScreenShareHandshakeError ? error.reason : "malformed");
      }
    }
    if (type === SCREEN_SHARE_WIRE.sealed && this.opener !== null) {
      let record: Awaited<ReturnType<ScreenShareOpener["open"]>>;
      try {
        record = await this.opener.open(body);
      } catch {
        // Changed on the way, replayed or out of order: the session is not trusted further.
        return this.fail("malformed");
      }
      return this.apply({
        t: "record",
        type: record.type,
        data: record.data,
        now: this.deps.now(),
      });
    }
    return this.fail("malformed");
  }
}
