// @effect-diagnostics globalDate:off -- Test fixtures format a fixed clock.
/**
 * A machine's session rules with everything around them faked (1490, 1519):
 * the store in memory, a clock that moves only when told, windows that record
 * what they were asked to show, and a viewer that runs the real handshake.
 */
import {
  decodeScreenShareFrame,
  SCREEN_SHARE_RECORD,
  SCREEN_SHARE_WIRE,
  type ScreenShareControlState,
  type ScreenShareSessionState,
  type ScreenShareTypingBlock,
  type ScreenShareViewerDevice,
} from "@specweave-studio/contracts";
import { computeDpopJwkThumbprint, type DpopPublicJwk } from "@specweave-studio/shared/dpop";
import {
  answerScreenShareChallenge,
  makeScreenShareOpener,
  makeScreenShareSealer,
  startScreenShareViewer,
} from "@specweave-studio/shared/screenShareChannel";

import type { HelperEvent, ScreenControlStart } from "./screenControl.logic.ts";
import {
  ScreenShareSessions,
  type ScreenShareBannerView,
  type ScreenShareGrab,
  type ScreenShareLook,
  type ScreenSharePromptView,
} from "./screenShareSession.logic.ts";
import { ScreenShareStore, type ScreenShareStoreIo } from "./ScreenShareStore.ts";

export const ENV = "env-target";
export const SID = "0f1e2d3c-4b5a-4978-8695-a4b3c2d1e0f9";
export const SID2 = "1f1e2d3c-4b5a-4978-8695-a4b3c2d1e0f9";
export const START = Date.parse("2026-11-25T12:00:00Z");
export const encoder = new TextEncoder();
export const decoder = new TextDecoder();

export async function makeDevice(label = "Work laptop") {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const jwk = { kty: "EC", crv: "P-256", x: exported.x!, y: exported.y! } as DpopPublicJwk;
  const thumbprint = computeDpopJwkThumbprint(jwk);
  const device: ScreenShareViewerDevice = { thumbprint, label, shortId: "7F3A", kind: "connect" };
  const sign = async (data: Uint8Array<ArrayBuffer>) =>
    new Uint8Array(
      await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, data),
    );
  return { jwk, device, sign };
}

export const frame = (digest: string): ScreenShareGrab => ({
  kind: "frame",
  jpeg: encoder.encode(`jpeg:${digest}`),
  width: 1920,
  height: 1200,
  pointer: { x: 10, y: 20 },
  digest,
});

export function rig(options?: {
  readonly enabled?: boolean;
  readonly supported?: boolean;
  /** 1519: the machine can be controlled (helper here, Accessibility on). */
  readonly control?: boolean;
}) {
  let now = START;
  const timers: Array<{ at: number; run: () => void; live: boolean }> = [];
  const file: {
    bytes: Uint8Array | null;
    failWrites: boolean;
    /** Fails only the writes whose content this says yes to. */
    failWhen: ((stored: { readonly grants: ReadonlyArray<unknown> }) => boolean) | null;
  } = {
    bytes: null,
    failWrites: false,
    failWhen: null,
  };
  const io: ScreenShareStoreIo = {
    read: () => file.bytes,
    write: (bytes) => {
      if (file.failWrites) throw new Error("disk full");
      if (file.failWhen?.(JSON.parse(decoder.decode(bytes))) === true) throw new Error("disk full");
      file.bytes = bytes;
    },
    canSeal: () => true,
    seal: (text) => encoder.encode(text),
    unseal: (bytes) => decoder.decode(bytes),
    now: () => now,
  };
  const store = new ScreenShareStore(io);
  if (options?.enabled !== false) store.setEnabled(true);

  const events: Array<string> = [];
  const sent: Array<Uint8Array> = [];
  const closes: Array<{ sid: string; reason: string }> = [];
  const prompts: Array<ScreenSharePromptView> = [];
  const banners: Array<ScreenShareBannerView> = [];
  const authReasons: Array<string> = [];
  const state = {
    screenRecording: true,
    bannerShows: true,
    auth: (() => Promise.resolve(true)) as () => Promise<boolean>,
    grabs: [] as Array<ScreenShareGrab>,
    /** When set, the next look at the screen waits on this. */
    heldGrab: null as Promise<ScreenShareGrab> | null,
    grabbed: [] as Array<string>,
    looks: [] as Array<ScreenShareLook | undefined>,
    awake: false,
    promptVisible: false,
    bannerVisible: false,
  };
  const control = {
    available: options?.control === true,
    startResult: "ok" as ScreenControlStart["kind"],
    /** When set, the helper's start waits on this. */
    heldStart: null as Promise<void> | null,
    controlled: false,
    starts: 0,
    posted: [] as Array<ReadonlyArray<HelperEvent>>,
    releases: [] as Array<{
      readonly keys: ReadonlyArray<string>;
      readonly buttons: ReadonlyArray<string>;
    }>,
    orphaned: [] as Array<{
      readonly keys: ReadonlyArray<string>;
      readonly buttons: ReadonlyArray<string>;
    }>,
    stops: 0,
    onBlocked: null as ((blocked: ScreenShareTypingBlock | null) => void) | null,
    onExit: null as (() => void) | null,
  };
  const sessions = new ScreenShareSessions({
    store,
    platformSupported: options?.supported !== false,
    screenRecording: () => state.screenRecording,
    now: () => now,
    after: (ms, run) => {
      const timer = { at: now + ms, run, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
    send: (_sid, payload) => {
      events.push(payload[0] === SCREEN_SHARE_WIRE.sealed ? "sealed" : "handshake");
      sent.push(payload);
    },
    close: (sid, reason) => {
      events.push(`close:${reason}`);
      closes.push({ sid, reason });
    },
    authenticate: (reason) => {
      authReasons.push(reason);
      return state.auth();
    },
    prompt: {
      show: (view) => {
        prompts.push(view);
        state.promptVisible = true;
      },
      hide: () => {
        state.promptVisible = false;
      },
    },
    banner: {
      show: (view) => {
        if (!state.bannerShows) return false;
        events.push("banner");
        banners.push(view);
        state.bannerVisible = true;
        return true;
      },
      hide: () => {
        state.bannerVisible = false;
      },
    },
    capture: {
      displays: () => [
        { id: "1", label: "Built-in display", primary: true },
        { id: "2", label: "Studio Display", primary: false },
      ],
      grab: (displayId, look) => {
        state.grabbed.push(displayId);
        state.looks.push(look);
        const held = state.heldGrab;
        state.heldGrab = null;
        return held ?? Promise.resolve(state.grabs.shift() ?? { kind: "none" });
      },
      keepAwake: (on) => {
        state.awake = on;
      },
    },
    changed: () => {},
    ...(options?.control === undefined
      ? {}
      : {
          control: {
            available: () => Promise.resolve(control.available),
            start: async (events) => {
              control.starts += 1;
              control.onBlocked = events.onBlocked;
              control.onExit = events.onExit;
              if (control.heldStart !== null) await control.heldStart;
              if (control.startResult !== "ok")
                return { kind: control.startResult } as ScreenControlStart;
              return {
                kind: "ok",
                link: {
                  post: (posted) => {
                    control.posted.push([...posted]);
                  },
                  release: (held) => {
                    control.releases.push(held);
                    return Promise.resolve();
                  },
                  stop: () => {
                    control.stops += 1;
                  },
                },
              };
            },
            bounds: (displayId) =>
              displayId === "1"
                ? { x: 0, y: 0, width: 1512, height: 982 }
                : displayId === "2"
                  ? { x: 1512, y: 0, width: 2560, height: 1440 }
                  : null,
            releaseOrphaned: (held) => {
              control.orphaned.push(held);
            },
            controlled: (on) => {
              control.controlled = on;
            },
          },
        }),
  });
  /** Moves the clock, running each timer that comes due, in order. */
  const advance = async (ms: number) => {
    const target = now + ms;
    for (;;) {
      const due = timers
        .filter((timer) => timer.live && timer.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      due.live = false;
      now = Math.max(now, due.at);
      due.run();
      await sessions.idle();
    }
    now = target;
  };
  return {
    sessions,
    store,
    file,
    state,
    control,
    sent,
    closes,
    prompts,
    banners,
    events,
    authReasons,
    advance,
    now: () => now,
  };
}

/** Waits for the real cryptography under way to finish; nothing here waits on a clock. */
export const settle = (r: { readonly sessions: ScreenShareSessions }) => r.sessions.idle();

export type Rig = ReturnType<typeof rig>;
export type Device = Awaited<ReturnType<typeof makeDevice>>;

/** A viewer that runs the real handshake against the rig and reads what comes back. */
export async function connect(
  r: Rig,
  device: Device,
  options?: {
    readonly knowsMachine?: boolean;
    readonly sid?: string;
    /** Whether the machine has this device on record as having typed its code. Default: as `knowsMachine`. */
    readonly onRecord?: boolean;
  },
) {
  const sid = options?.sid ?? SID;
  const knowsMachine = options?.knowsMachine ?? true;
  if (options?.onRecord ?? knowsMachine) r.store.rememberDevice(device.device.thumbprint);
  const from = r.sent.length;
  r.sessions.opened(sid, ENV, device.device);
  const start = startScreenShareViewer({ mode: "view", deviceJwk: device.jwk, knowsMachine });
  const wire = (type: number, body: Uint8Array) => new Uint8Array([type, ...body]);
  r.sessions.received(
    sid,
    wire(SCREEN_SHARE_WIRE.hello, encoder.encode(JSON.stringify(start.hello))),
  );
  await settle(r);
  const challenge = r.sent[from];
  if (challenge === undefined) return null;
  const answer = await answerScreenShareChallenge({
    start,
    challenge: JSON.parse(decoder.decode(challenge.subarray(1))),
    environmentId: ENV,
    sessionId: sid,
    pinnedMachineKey: knowsMachine ? r.store.machineKey.publicKey : undefined,
    nowEpochSeconds: Math.floor(r.now() / 1000),
    sign: device.sign,
  });
  r.sessions.received(
    sid,
    wire(SCREEN_SHARE_WIRE.proof, encoder.encode(JSON.stringify(answer.proof))),
  );
  await settle(r);
  const opener = makeScreenShareOpener(answer.keys.toViewer, sid);
  const sealer = makeScreenShareSealer(answer.keys.toTarget, sid);
  let read = from + 1;
  const states: Array<ScreenShareSessionState> = [];
  const controls: Array<ScreenShareControlState> = [];
  const frames: Array<ReturnType<typeof decodeScreenShareFrame>> = [];
  /** Opens everything the machine sent since the last call. */
  const drain = async () => {
    await settle(r);
    for (; read < r.sent.length; read += 1) {
      const record = await opener.open(r.sent[read]!.subarray(1));
      if (record.type === SCREEN_SHARE_RECORD.state)
        states.push(JSON.parse(decoder.decode(record.data)) as ScreenShareSessionState);
      else if (record.type === SCREEN_SHARE_RECORD.frame)
        frames.push(decodeScreenShareFrame(record.data));
      else if (record.type === SCREEN_SHARE_RECORD.control)
        controls.push(JSON.parse(decoder.decode(record.data)) as ScreenShareControlState);
      else throw new Error(`record ${record.type} a viewer does not read`);
    }
  };
  const tell = async (type: number, body: unknown) => {
    const record = await sealer.seal(type, encoder.encode(JSON.stringify(body)));
    r.sessions.received(sid, wire(SCREEN_SHARE_WIRE.sealed, record));
    await drain();
  };
  await drain();
  return { code: answer.code, states, frames, controls, drain, tell, sealer, sid };
}

/** A viewer that already knows the machine, allowed once by a person who authenticated. */
export async function live(r: Rig, device: Device) {
  const viewer = (await connect(r, device))!;
  await r.sessions.answerPrompt(SID, "once");
  await viewer.drain();
  return viewer;
}
