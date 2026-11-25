// @effect-diagnostics globalDate:off -- Test fixtures format a fixed clock.
import {
  decodeScreenShareFrame,
  SCREEN_SHARE_COOLDOWN_WINDOW_MS,
  SCREEN_SHARE_FRAME_MIN_MS,
  SCREEN_SHARE_HANDSHAKE_MS,
  SCREEN_SHARE_PROMPT_MS,
  SCREEN_SHARE_RECORD,
  SCREEN_SHARE_SESSION_MAX_MS,
  SCREEN_SHARE_SILENCE_MS,
  SCREEN_SHARE_WIRE,
  type ScreenShareSessionState,
  type ScreenShareViewerDevice,
} from "@specweave-studio/contracts";
import { computeDpopJwkThumbprint, type DpopPublicJwk } from "@specweave-studio/shared/dpop";
import {
  answerScreenShareChallenge,
  makeScreenShareOpener,
  makeScreenShareSealer,
  startScreenShareViewer,
} from "@specweave-studio/shared/screenShareChannel";
import { describe, expect, it } from "vite-plus/test";

import {
  ScreenShareSessions,
  type ScreenShareBannerView,
  type ScreenShareGrab,
  type ScreenSharePromptView,
} from "./screenShareSession.logic.ts";
import { ScreenShareStore, type ScreenShareStoreIo } from "./ScreenShareStore.ts";

const ENV = "env-target";
const SID = "0f1e2d3c-4b5a-4978-8695-a4b3c2d1e0f9";
const SID2 = "1f1e2d3c-4b5a-4978-8695-a4b3c2d1e0f9";
const START = Date.parse("2026-11-25T12:00:00Z");
const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function makeDevice(label = "Work laptop") {
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

const frame = (digest: string): ScreenShareGrab => ({
  kind: "frame",
  jpeg: encoder.encode(`jpeg:${digest}`),
  width: 1920,
  height: 1200,
  pointer: { x: 10, y: 20 },
  digest,
});

function rig(options?: { readonly enabled?: boolean; readonly supported?: boolean }) {
  let now = START;
  const timers: Array<{ at: number; run: () => void; live: boolean }> = [];
  const file: { bytes: Uint8Array | null } = { bytes: null };
  const io: ScreenShareStoreIo = {
    read: () => file.bytes,
    write: (bytes) => {
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
    grabbed: [] as Array<string>,
    awake: false,
    promptVisible: false,
    bannerVisible: false,
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
      grab: (displayId) => {
        state.grabbed.push(displayId);
        return Promise.resolve(state.grabs.shift() ?? { kind: "none" });
      },
      keepAwake: (on) => {
        state.awake = on;
      },
    },
    changed: () => {},
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
    state,
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
const settle = (r: { readonly sessions: ScreenShareSessions }) => r.sessions.idle();

type Rig = ReturnType<typeof rig>;
type Device = Awaited<ReturnType<typeof makeDevice>>;

/** A viewer that runs the real handshake against the rig and reads what comes back. */
async function connect(
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
    }
  };
  const tell = async (type: number, body: unknown) => {
    const record = await sealer.seal(type, encoder.encode(JSON.stringify(body)));
    r.sessions.received(sid, wire(SCREEN_SHARE_WIRE.sealed, record));
    await drain();
  };
  await drain();
  return { code: answer.code, states, frames, drain, tell, sealer, sid };
}

/** A viewer that already knows the machine, allowed once by a person who authenticated. */
async function live(r: Rig, device: Device) {
  const viewer = (await connect(r, device))!;
  await r.sessions.answerPrompt(SID, "once");
  await viewer.drain();
  return viewer;
}

describe("starting a session", () => {
  it("while sharing is off: refused at once, no prompt, no capture, no banner", async () => {
    const r = rig({ enabled: false });
    const device = await makeDevice();
    r.sessions.opened(SID, ENV, device.device);
    expect(r.closes).toEqual([{ sid: SID, reason: "off" }]);
    expect(r.prompts).toEqual([]);
    expect(r.banners).toEqual([]);
    expect(r.state.grabbed).toEqual([]);
    expect(r.sessions.status()).toEqual({ enabled: false, supported: true, busy: false });
  });

  it("refuses on a system that cannot share, without the screen grant, and a second viewer", async () => {
    const device = await makeDevice();
    const other = rig({ supported: false });
    other.sessions.opened(SID, ENV, device.device);
    expect(other.closes[0]?.reason).toBe("unsupported");

    const blind = rig();
    blind.state.screenRecording = false;
    blind.sessions.opened(SID, ENV, device.device);
    expect(blind.closes[0]?.reason).toBe("no_permission");

    const r = rig();
    await connect(r, device);
    r.sessions.opened(SID2, ENV, (await makeDevice()).device);
    expect(r.closes).toEqual([{ sid: SID2, reason: "busy" }]);
    expect(r.prompts).toHaveLength(1);
  });

  it("refuses a hello for another device key than the server named, and counts it", async () => {
    const r = rig();
    const mine = await makeDevice();
    const thief = await makeDevice();
    const viewer = await connect(r, { ...thief, device: mine.device });
    expect(viewer).toBeNull();
    expect(r.closes).toEqual([{ sid: SID, reason: "handshake_failed" }]);
    expect(r.prompts).toEqual([]);
    expect(r.store.audit.at(-1)).toMatchObject({ outcome: "refused", reason: "handshake_failed" });
  });

  it("gives a handshake 15 seconds, then gives up and counts it", async () => {
    const r = rig();
    const device = await makeDevice();
    r.sessions.opened(SID, ENV, device.device);
    await r.advance(SCREEN_SHARE_HANDSHAKE_MS - 1);
    expect(r.closes).toEqual([]);
    await r.advance(2);
    expect(r.closes).toEqual([{ sid: SID, reason: "handshake_failed" }]);
    expect(r.sessions.status().busy).toBe(false);
  });

  it("ends on anything that is not the next handshake message", async () => {
    const r = rig();
    const device = await makeDevice();
    r.sessions.opened(SID, ENV, device.device);
    r.sessions.received(SID, new Uint8Array([SCREEN_SHARE_WIRE.proof, 1, 2, 3]));
    await settle(r);
    expect(r.closes[0]?.reason).toBe("handshake_failed");
  });
});

describe("the prompt", () => {
  it("asks with the approved name, the short ID and, for a known viewer, no code", async () => {
    const r = rig();
    const device = await makeDevice();
    const viewer = (await connect(r, {
      ...device,
      device: { ...device.device, claimedLabel: "Anton's MacBook Pro" },
    }))!;
    expect(r.prompts).toEqual([
      {
        sid: SID,
        label: "Work laptop",
        claimedLabel: "Anton's MacBook Pro",
        shortId: "7F3A",
        stage: "ask",
        expiresAt: START + SCREEN_SHARE_PROMPT_MS,
      },
    ]);
    expect(viewer.states).toEqual([{ phase: "waiting_for_approval" }]);
    expect(r.banners).toEqual([]);
    expect(r.state.grabbed).toEqual([]);
  });

  it("a click on Allow is not enough: without the system's authentication nothing is shown", async () => {
    const r = rig();
    const device = await makeDevice();
    const viewer = (await connect(r, device))!;
    r.state.auth = () => Promise.resolve(false);
    await r.sessions.answerPrompt(SID, "once");
    await r.sessions.answerPrompt(SID, "always");
    await viewer.drain();
    expect(r.authReasons).toHaveLength(2);
    expect(r.banners).toEqual([]);
    expect(viewer.frames).toEqual([]);
    expect(viewer.states).toEqual([{ phase: "waiting_for_approval" }]);
    expect(r.store.grants).toEqual([]);
    // The prompt is still up, and its time still runs out as a refusal.
    expect(r.state.promptVisible).toBe(true);
    await r.advance(SCREEN_SHARE_PROMPT_MS + 1);
    expect(r.closes).toEqual([{ sid: SID, reason: "prompt_timeout" }]);
  });

  it("an authentication that throws, or that returns after the prompt timed out, allows nothing", async () => {
    const r = rig();
    const device = await makeDevice();
    await connect(r, device);
    r.state.auth = () => Promise.reject(new Error("cancelled"));
    await r.sessions.answerPrompt(SID, "once");
    expect(r.banners).toEqual([]);

    let finish: (present: boolean) => void = () => {};
    r.state.auth = () => new Promise<boolean>((resolve) => (finish = resolve));
    const answering = r.sessions.answerPrompt(SID, "once");
    await r.advance(SCREEN_SHARE_PROMPT_MS + 1);
    expect(r.closes.at(-1)?.reason).toBe("prompt_timeout");
    finish(true);
    await answering;
    await settle(r);
    expect(r.banners).toEqual([]);
    expect(r.state.grabbed).toEqual([]);
  });

  it("Allow once with authentication goes live and leaves no grant", async () => {
    const r = rig();
    const device = await makeDevice();
    const viewer = await live(r, device);
    expect(r.authReasons).toEqual([
      `allow "Work laptop" (7F3A) to view this Mac's screen this once`,
    ]);
    expect(viewer.states.at(-1)).toMatchObject({ phase: "live", displayId: "1" });
    expect(r.store.grants).toEqual([]);
    expect(r.state.promptVisible).toBe(false);
    expect(r.store.audit.at(-1)).toMatchObject({ outcome: "allowed_once" });
  });

  it("Always allow saves a grant, and the next session needs no prompt", async () => {
    const r = rig();
    const device = await makeDevice();
    const first = (await connect(r, device))!;
    await r.sessions.answerPrompt(SID, "always");
    await first.drain();
    expect(r.store.hasGrant(device.device.thumbprint)).toBe(true);
    r.sessions.stop();
    await settle(r);

    const second = (await connect(r, device, { sid: SID2 }))!;
    expect(r.prompts).toHaveLength(1);
    expect(r.authReasons).toHaveLength(1);
    expect(second.states.at(-1)).toMatchObject({ phase: "live" });
    expect(r.store.audit.at(-1)).toMatchObject({ id: SID2, outcome: "allowed_by_grant" });
  });

  it("Deny ends it, and no answer in 60 seconds is Deny", async () => {
    const r = rig();
    const device = await makeDevice();
    await connect(r, device);
    await r.sessions.answerPrompt(SID, "deny");
    await settle(r);
    expect(r.closes).toEqual([{ sid: SID, reason: "denied" }]);
    expect(r.authReasons).toEqual([]);

    await connect(r, device, { sid: SID2 });
    await r.advance(SCREEN_SHARE_PROMPT_MS + 1);
    expect(r.closes.at(-1)).toEqual({ sid: SID2, reason: "prompt_timeout" });
    expect(r.state.promptVisible).toBe(false);
  });

  it("ignores an answer for another session or after the prompt is gone", async () => {
    const r = rig();
    const device = await makeDevice();
    await connect(r, device);
    await r.sessions.answerPrompt(SID2, "once");
    expect(r.authReasons).toEqual([]);
    await r.sessions.answerPrompt(SID, "deny");
    await r.sessions.answerPrompt(SID, "once");
    expect(r.authReasons).toEqual([]);
    expect(r.banners).toEqual([]);
  });

  it("stops asking about a device after three refusals in ten minutes", async () => {
    const r = rig();
    const device = await makeDevice();
    for (const sid of [SID, SID2, SID]) {
      await connect(r, device, { sid });
      await r.sessions.answerPrompt(sid, "deny");
      await settle(r);
    }
    const prompts = r.prompts.length;
    r.sessions.opened(SID2, ENV, device.device);
    expect(r.closes.at(-1)).toEqual({ sid: SID2, reason: "cooldown" });
    expect(r.prompts).toHaveLength(prompts);
    // Another device is still asked about.
    await connect(r, await makeDevice("Phone"), { sid: SID });
    expect(r.prompts).toHaveLength(prompts + 1);
    await r.sessions.answerPrompt(SID, "deny");
    await settle(r);
    await r.advance(SCREEN_SHARE_COOLDOWN_WINDOW_MS + 1000);
    await connect(r, device, { sid: SID2 });
    expect(r.prompts).toHaveLength(prompts + 2);
  });
});

describe("first use", () => {
  it("asks even where a grant exists, and shows the code only on this machine", async () => {
    const r = rig();
    const device = await makeDevice();
    r.store.addGrant(device.device);
    const viewer = (await connect(r, device, { knowsMachine: false }))!;
    expect(r.prompts).toHaveLength(1);
    expect(r.prompts[0]).toMatchObject({ stage: "ask", code: viewer.code });
    expect(viewer.code).toMatch(/^\d{6}$/);
    // What the viewer was sent does not hold the code.
    expect(JSON.stringify(viewer.states)).not.toContain(viewer.code);
  });

  it("sends no frame until the viewer returns the code, then goes live", async () => {
    const r = rig();
    const device = await makeDevice();
    const viewer = (await connect(r, device, { knowsMachine: false }))!;
    r.state.grabs.push(frame("a"));
    await r.sessions.answerPrompt(SID, "once");
    await viewer.drain();
    expect(viewer.states.at(-1)).toEqual({ phase: "needs_code", triesLeft: 3 });
    expect(r.prompts.at(-1)).toMatchObject({ stage: "code", code: viewer.code });
    await r.advance(SCREEN_SHARE_FRAME_MIN_MS * 4);
    await viewer.drain();
    expect(r.banners).toEqual([]);
    expect(r.state.grabbed).toEqual([]);
    expect(viewer.frames).toEqual([]);

    await viewer.tell(SCREEN_SHARE_RECORD.confirmCode, { code: viewer.code });
    expect(viewer.states.at(-1)).toMatchObject({ phase: "live" });
    expect(r.banners).toHaveLength(1);
    expect(viewer.frames).toHaveLength(1);
  });

  it("with the wrong code Allow never reaches live: three tries, then it ends and counts", async () => {
    const r = rig();
    const device = await makeDevice();
    const viewer = (await connect(r, device, { knowsMachine: false }))!;
    await r.sessions.answerPrompt(SID, "always");
    const wrong = viewer.code === "000000" ? "111111" : "000000";
    await viewer.tell(SCREEN_SHARE_RECORD.confirmCode, { code: wrong });
    await viewer.tell(SCREEN_SHARE_RECORD.confirmCode, { code: wrong });
    expect(viewer.states.at(-1)).toEqual({ phase: "needs_code", triesLeft: 1 });
    await viewer.tell(SCREEN_SHARE_RECORD.confirmCode, { code: wrong });
    expect(r.closes).toEqual([{ sid: SID, reason: "wrong_code" }]);
    expect(r.banners).toEqual([]);
    expect(r.state.grabbed).toEqual([]);
    // "Always allow" was pressed, but nothing was granted.
    expect(r.store.grants).toEqual([]);
    expect(r.store.audit.at(-1)).toMatchObject({ outcome: "refused", reason: "wrong_code" });
  });

  it("is decided by this machine's record, not by what the viewer says about itself", async () => {
    const r = rig();
    const device = await makeDevice();
    r.store.addGrant(device.device);
    // The viewer says it knows this machine. The machine has no record of it.
    const viewer = (await connect(r, device, { knowsMachine: true, onRecord: false }))!;
    expect(r.prompts).toHaveLength(1);
    expect(r.prompts[0]).toMatchObject({ stage: "ask", code: viewer.code });
    expect(r.banners).toEqual([]);
    await r.sessions.answerPrompt(SID, "once");
    await viewer.drain();
    expect(viewer.states.at(-1)).toEqual({ phase: "needs_code", triesLeft: 3 });
    expect(r.banners).toEqual([]);
    expect(r.store.knowsDevice(device.device.thumbprint)).toBe(false);

    await viewer.tell(SCREEN_SHARE_RECORD.confirmCode, { code: viewer.code });
    expect(viewer.states.at(-1)).toMatchObject({ phase: "live" });
    expect(r.store.knowsDevice(device.device.thumbprint)).toBe(true);
    r.sessions.stop();
    await settle(r);

    // Now it is on record: the grant lets it in with no prompt.
    const again = (await connect(r, device, { sid: SID2, onRecord: false }))!;
    expect(r.prompts).toHaveLength(2);
    expect(again.states.at(-1)).toMatchObject({ phase: "live" });
    expect(r.store.audit.at(-1)).toMatchObject({ outcome: "allowed_by_grant" });
  });

  it("starts over for a device that was removed", async () => {
    const r = rig();
    const device = await makeDevice();
    r.store.rememberDevice(device.device.thumbprint);
    r.store.addGrant(device.device);
    r.sessions.removeGrant(device.device.thumbprint);
    expect(r.store.knowsDevice(device.device.thumbprint)).toBe(false);
    const viewer = (await connect(r, device, { onRecord: false }))!;
    expect(r.prompts).toHaveLength(1);
    expect(r.prompts[0]).toMatchObject({ stage: "ask", code: viewer.code });
  });

  it("the code cannot be sent before a person allowed, and runs out after a minute", async () => {
    const early = rig();
    const device = await makeDevice();
    const impatient = (await connect(early, device, { knowsMachine: false }))!;
    await impatient.tell(SCREEN_SHARE_RECORD.confirmCode, { code: impatient.code });
    expect(early.closes).toEqual([{ sid: SID, reason: "protocol_error" }]);
    expect(early.banners).toEqual([]);

    const r = rig();
    const viewer = (await connect(r, device, { knowsMachine: false }))!;
    await r.sessions.answerPrompt(SID, "once");
    await r.advance(SCREEN_SHARE_PROMPT_MS + 1);
    expect(r.closes).toEqual([{ sid: SID, reason: "prompt_timeout" }]);
    await viewer.drain();
    expect(viewer.frames).toEqual([]);
  });
});

describe("a live session", () => {
  it("puts the banner up before the first frame, and shows nothing without it", async () => {
    const r = rig();
    const device = await makeDevice();
    r.state.grabs.push(frame("a"));
    const viewer = await live(r, device);
    expect(r.banners).toEqual([{ label: "Work laptop", shortId: "7F3A", startedAt: START }]);
    const banner = r.events.indexOf("banner");
    const firstAfter = r.events.slice(banner + 1).filter((event) => event === "sealed");
    expect(banner).toBeGreaterThan(-1);
    expect(firstAfter.length).toBeGreaterThan(0);
    expect(viewer.frames).toHaveLength(1);
    expect(r.state.awake).toBe(true);

    const hidden = rig();
    hidden.state.bannerShows = false;
    hidden.state.grabs.push(frame("a"));
    const blind = (await connect(hidden, device))!;
    await hidden.sessions.answerPrompt(SID, "once");
    await blind.drain();
    expect(hidden.closes).toEqual([{ sid: SID, reason: "banner_lost" }]);
    expect(hidden.state.grabbed).toEqual([]);
    expect(blind.frames).toEqual([]);
  });

  it("sends a frame with its size and pointer, then waits for the viewer before the next", async () => {
    const r = rig();
    const device = await makeDevice();
    r.state.grabs.push(frame("a"), frame("b"), frame("c"));
    const viewer = await live(r, device);
    expect(viewer.frames[0]?.header).toEqual({
      seq: 1,
      displayId: "1",
      width: 1920,
      height: 1200,
      pointer: { x: 10, y: 20 },
    });
    expect(decoder.decode(viewer.frames[0]!.jpeg)).toBe("jpeg:a");
    await r.advance(SCREEN_SHARE_FRAME_MIN_MS * 5);
    await viewer.drain();
    // Not confirmed: no second frame, and the screen was not even looked at again.
    expect(viewer.frames).toHaveLength(1);
    expect(r.state.grabbed).toHaveLength(1);
    await viewer.tell(SCREEN_SHARE_RECORD.frameReceived, { seq: 1 });
    await r.advance(SCREEN_SHARE_FRAME_MIN_MS + 1);
    await viewer.drain();
    expect(viewer.frames.map((sent) => sent.header.seq)).toEqual([1, 2]);
  });

  it("sends nothing while the picture has not changed", async () => {
    const r = rig();
    const device = await makeDevice();
    r.state.grabs.push(frame("a"), frame("a"), frame("a"), frame("b"));
    const viewer = await live(r, device);
    await viewer.tell(SCREEN_SHARE_RECORD.frameReceived, { seq: 1 });
    await r.advance(SCREEN_SHARE_FRAME_MIN_MS * 2 + 2);
    await viewer.drain();
    expect(viewer.frames).toHaveLength(1);
    await r.advance(SCREEN_SHARE_FRAME_MIN_MS + 1);
    await viewer.drain();
    expect(viewer.frames.map((sent) => decoder.decode(sent.jpeg))).toEqual(["jpeg:a", "jpeg:b"]);
  });

  it("while the Mac is locked sends a placard state and no frame, then picks up again", async () => {
    const r = rig();
    const device = await makeDevice();
    r.state.grabs.push({ kind: "locked" }, { kind: "locked" }, frame("a"));
    const viewer = await live(r, device);
    await r.advance(SCREEN_SHARE_FRAME_MIN_MS + 1);
    await viewer.drain();
    expect(viewer.states.map((state) => state.phase)).toEqual([
      "waiting_for_approval",
      "live",
      "locked",
    ]);
    expect(viewer.frames).toEqual([]);
    await r.advance(SCREEN_SHARE_FRAME_MIN_MS + 1);
    await viewer.drain();
    expect(viewer.states.at(-1)).toMatchObject({ phase: "live" });
    expect(viewer.frames).toHaveLength(1);
  });

  it("switches display when asked for one that exists, and ends on one that does not", async () => {
    const r = rig();
    const device = await makeDevice();
    r.state.grabs.push(frame("a"), frame("a"));
    const viewer = await live(r, device);
    await viewer.tell(SCREEN_SHARE_RECORD.frameReceived, { seq: 1 });
    await viewer.tell(SCREEN_SHARE_RECORD.showDisplay, { displayId: "2" });
    expect(viewer.states.at(-1)).toMatchObject({ phase: "live", displayId: "2" });
    await r.advance(SCREEN_SHARE_FRAME_MIN_MS + 1);
    await viewer.drain();
    // The same picture is sent again: it is another display's.
    expect(viewer.frames.at(-1)?.header).toMatchObject({ seq: 2, displayId: "2" });
    expect(r.state.grabbed.at(-1)).toBe("2");
    await viewer.tell(SCREEN_SHARE_RECORD.showDisplay, { displayId: "9" });
    expect(r.closes).toEqual([{ sid: SID, reason: "protocol_error" }]);
  });

  it("is view-only: any other record, a bad body or a frame never sent ends it", async () => {
    const device = await makeDevice();
    const cases: ReadonlyArray<readonly [number, unknown]> = [
      [20, { x: 1, y: 2 }],
      [SCREEN_SHARE_RECORD.frame, {}],
      [SCREEN_SHARE_RECORD.state, { phase: "live" }],
      [SCREEN_SHARE_RECORD.frameReceived, { seq: 99 }],
      [SCREEN_SHARE_RECORD.frameReceived, { seq: "1" }],
      [SCREEN_SHARE_RECORD.confirmCode, { code: "123456" }],
      [SCREEN_SHARE_RECORD.showDisplay, []],
    ];
    for (const [type, body] of cases) {
      const r = rig();
      const viewer = await live(r, device);
      await viewer.tell(type, body);
      expect(r.closes).toEqual([{ sid: SID, reason: "protocol_error" }]);
      expect(r.state.bannerVisible).toBe(false);
    }
  });

  it("ends on a record that was changed or replayed on the way", async () => {
    const device = await makeDevice();
    const r = rig();
    const viewer = await live(r, device);
    const record = await viewer.sealer.seal(
      SCREEN_SHARE_RECORD.frameReceived,
      encoder.encode(JSON.stringify({ seq: 0 })),
    );
    const sealed = new Uint8Array([SCREEN_SHARE_WIRE.sealed, ...record]);
    r.sessions.received(SID, sealed);
    r.sessions.received(SID, sealed);
    await settle(r);
    expect(r.closes).toEqual([{ sid: SID, reason: "protocol_error" }]);

    const second = rig();
    const other = await live(second, device);
    const flipped = new Uint8Array([
      SCREEN_SHARE_WIRE.sealed,
      ...(await other.sealer.seal(SCREEN_SHARE_RECORD.end, encoder.encode("{}"))),
    ]);
    flipped[flipped.length - 1]! ^= 0x01;
    second.sessions.received(SID, flipped);
    await settle(second);
    expect(second.closes).toEqual([{ sid: SID, reason: "protocol_error" }]);
  });

  it("Stop, a lost banner, the switch, a removed grant, the viewer leaving and quitting each end it", async () => {
    const device = await makeDevice();
    const ways: ReadonlyArray<readonly [string, (r: Rig) => unknown]> = [
      ["stopped_at_machine", (r) => r.sessions.stop()],
      ["banner_lost", (r) => r.sessions.bannerLost()],
      ["turned_off", (r) => r.sessions.setEnabled(false)],
      ["grant_removed", (r) => r.sessions.removeGrant(device.device.thumbprint)],
      ["viewer_ended", (r) => r.sessions.closed(SID)],
      ["no_host", (r) => r.sessions.disconnected()],
      ["app_quit", (r) => r.sessions.shutdown()],
    ];
    for (const [reason, run] of ways) {
      const r = rig();
      const viewer = await live(r, device);
      await run(r);
      await viewer.drain();
      expect(r.closes).toEqual([{ sid: SID, reason }]);
      // The viewer hears why inside the sealed session, before the plain close.
      expect(viewer.states.at(-1)).toEqual({ phase: "ended", reason });
      expect(r.events.at(-1)).toBe(`close:${reason}`);
      expect(r.state.bannerVisible).toBe(false);
      expect(r.state.awake).toBe(false);
      expect(r.sessions.status().busy).toBe(false);
      expect(r.sessions.active()).toBeNull();
    }
  });

  it("the viewer saying it is done ends it", async () => {
    const r = rig();
    const viewer = await live(r, await makeDevice());
    await viewer.tell(SCREEN_SHARE_RECORD.end, {});
    expect(r.closes).toEqual([{ sid: SID, reason: "viewer_ended" }]);
  });

  it("ends after two minutes with nothing from the viewer, and a repeated confirmation keeps it open", async () => {
    const r = rig();
    const device = await makeDevice();
    const viewer = await live(r, device);
    await r.advance(SCREEN_SHARE_SILENCE_MS - 5_000);
    await viewer.tell(SCREEN_SHARE_RECORD.frameReceived, { seq: 0 });
    await r.advance(SCREEN_SHARE_SILENCE_MS - 5_000);
    expect(r.closes).toEqual([]);
    await r.advance(10_000);
    expect(r.closes).toEqual([{ sid: SID, reason: "viewer_silent" }]);
  });

  it("ends after two hours however lively it is", async () => {
    const r = rig();
    const device = await makeDevice();
    const viewer = await live(r, device);
    expect(viewer.states.at(-1)).toMatchObject({ endsAt: START + SCREEN_SHARE_SESSION_MAX_MS });
    for (let minute = 0; minute < 120 && r.closes.length === 0; minute += 1) {
      await r.advance(60_000);
      if (r.closes.length === 0) await viewer.tell(SCREEN_SHARE_RECORD.frameReceived, { seq: 0 });
    }
    expect(r.closes).toEqual([{ sid: SID, reason: "time_limit" }]);
  }, 60_000);

  it("records each attempt with how it was allowed, when, why it ended, and never a frame", async () => {
    const r = rig();
    const device = await makeDevice();
    r.state.grabs.push(frame("a"));
    const viewer = await live(r, device);
    expect(r.sessions.active()).toEqual({
      label: "Work laptop",
      shortId: "7F3A",
      startedAt: new Date(START).toISOString(),
    });
    await r.advance(5_000);
    r.sessions.stop();
    await viewer.drain();
    expect(r.store.audit).toEqual([
      {
        id: SID,
        at: new Date(START).toISOString(),
        label: "Work laptop",
        shortId: "7F3A",
        mode: "view",
        outcome: "allowed_once",
        startedAt: new Date(START).toISOString(),
        endedAt: new Date(START + 5_000).toISOString(),
        reason: "stopped_at_machine",
        frames: 1,
      },
    ]);
    expect(JSON.stringify(r.store.audit)).not.toContain("jpeg");
  });
});

describe("the system's authentication", () => {
  /** An authentication the test answers when it chooses. */
  const held = (r: Rig) => {
    const answers: Array<(present: boolean) => void> = [];
    r.state.auth = () => new Promise<boolean>((resolve) => void answers.push(resolve));
    return answers;
  };

  it("names the exact choice and the device in the system's dialog", async () => {
    const once = rig();
    const device = await makeDevice();
    await connect(once, device);
    await once.sessions.answerPrompt(SID, "once");
    const always = rig();
    await connect(always, device);
    await always.sessions.answerPrompt(SID, "always");
    const { label, shortId } = device.device;
    expect(once.authReasons).toEqual([
      `allow "${label}" (${shortId}) to view this Mac's screen this once`,
    ]);
    expect(always.authReasons).toEqual([
      `always allow "${label}" (${shortId}) to view this Mac's screen without asking again`,
    ]);
    expect(once.store.grants).toEqual([]);
    expect(always.store.grants).toHaveLength(1);
  });

  it("counts only for the choice it was asked for: a second press while it is up does nothing", async () => {
    const r = rig();
    const device = await makeDevice();
    const answers = held(r);
    await connect(r, device);
    const first = r.sessions.answerPrompt(SID, "once");
    // "Always allow" pressed while the dialog for "Allow once" is up.
    await r.sessions.answerPrompt(SID, "always");
    expect(r.authReasons).toHaveLength(1);
    answers[0]!(true);
    await first;
    await settle(r);
    expect(r.banners).toHaveLength(1);
    expect(r.store.grants).toEqual([]);
    expect(r.store.audit.at(-1)).toMatchObject({ outcome: "allowed_once" });
  });

  it("is dropped when the session it was for ended while the dialog was up", async () => {
    const timedOut = rig();
    const device = await makeDevice();
    let answers = held(timedOut);
    await connect(timedOut, device);
    let asked = timedOut.sessions.answerPrompt(SID, "always");
    await timedOut.advance(SCREEN_SHARE_PROMPT_MS + 1);
    expect(timedOut.closes).toEqual([{ sid: SID, reason: "prompt_timeout" }]);
    answers[0]!(true);
    await asked;
    await settle(timedOut);
    expect(timedOut.banners).toEqual([]);
    expect(timedOut.store.grants).toEqual([]);

    // Deny wins over an authentication under way.
    const denied = rig();
    answers = held(denied);
    await connect(denied, device);
    asked = denied.sessions.answerPrompt(SID, "once");
    await denied.sessions.answerPrompt(SID, "deny");
    await settle(denied);
    expect(denied.closes).toEqual([{ sid: SID, reason: "denied" }]);
    answers[0]!(true);
    await asked;
    await settle(denied);
    expect(denied.banners).toEqual([]);

    // An answer for one session never allows the next one.
    const next = rig();
    answers = held(next);
    await connect(next, device);
    asked = next.sessions.answerPrompt(SID, "once");
    next.sessions.closed(SID);
    await settle(next);
    await connect(next, device, { sid: SID2 });
    answers[0]!(true);
    await asked;
    await settle(next);
    expect(next.banners).toEqual([]);
    expect(next.prompts.at(-1)).toMatchObject({ sid: SID2, stage: "ask" });
  });

  it("puts one dialog up at a time: the switch and a prompt do not overlap", async () => {
    const r = rig();
    const device = await makeDevice();
    const answers = held(r);
    await connect(r, device);
    const asked = r.sessions.answerPrompt(SID, "once");
    // The switch is already on here; turn it off and try to turn it on under the dialog.
    await r.sessions.setEnabled(false);
    expect(await r.sessions.setEnabled(true)).toBe(false);
    expect(r.authReasons).toHaveLength(1);
    answers[0]!(true);
    await asked;
    expect(r.store.enabled).toBe(false);
    expect(r.banners).toEqual([]);
  });

  it("does not turn sharing on with an answer given before it was turned off again", async () => {
    const r = rig({ enabled: false });
    const answers = held(r);
    const turningOn = r.sessions.setEnabled(true);
    await r.sessions.setEnabled(false);
    answers[0]!(true);
    expect(await turningOn).toBe(false);
    expect(r.store.enabled).toBe(false);
  });
});

describe("the switch", () => {
  it("turns on only with the system's authentication, and off without it", async () => {
    const r = rig({ enabled: false });
    r.state.auth = () => Promise.resolve(false);
    expect(await r.sessions.setEnabled(true)).toBe(false);
    expect(r.store.enabled).toBe(false);
    r.state.auth = () => Promise.reject(new Error("no sensor"));
    expect(await r.sessions.setEnabled(true)).toBe(false);
    r.state.auth = () => Promise.resolve(true);
    expect(await r.sessions.setEnabled(true)).toBe(true);
    expect(r.store.enabled).toBe(true);
    expect(r.authReasons).toEqual(Array(3).fill("turn on screen sharing for this Mac"));
    expect(await r.sessions.setEnabled(false)).toBe(true);
    expect(r.authReasons).toHaveLength(3);
    expect(r.store.enabled).toBe(false);
  });

  it("cannot be turned on where this build cannot share the screen", async () => {
    const r = rig({ enabled: false, supported: false });
    expect(await r.sessions.setEnabled(true)).toBe(false);
    expect(r.authReasons).toEqual([]);
  });
});
