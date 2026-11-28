// @effect-diagnostics globalDate:off -- Test fixtures format a fixed clock.
import {
  SCREEN_SHARE_COOLDOWN_WINDOW_MS,
  SCREEN_SHARE_FRAME_MIN_MS,
  SCREEN_SHARE_HANDSHAKE_MS,
  SCREEN_SHARE_PROMPT_MS,
  SCREEN_SHARE_RECORD,
  SCREEN_SHARE_SESSION_MAX_MS,
  SCREEN_SHARE_SILENCE_MS,
  SCREEN_SHARE_WIRE,
} from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  AUTHENTICATE_PAUSE_MS,
  AUTHENTICATE_TRIES,
  type ScreenShareGrab,
} from "./screenShareSession.logic.ts";
import {
  connect,
  decoder,
  encoder,
  ENV,
  frame,
  live,
  makeDevice,
  rig,
  settle,
  SID,
  SID2,
  START,
  type Rig,
} from "./screenShareSession.testkit.ts";

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

  it("refuses a hello for another device key than the server named", async () => {
    const r = rig();
    const mine = await makeDevice();
    const thief = await makeDevice();
    const viewer = await connect(r, { ...thief, device: mine.device });
    expect(viewer).toBeNull();
    expect(r.closes).toEqual([{ sid: SID, reason: "handshake_failed" }]);
    expect(r.prompts).toEqual([]);
    expect(r.store.audit.at(-1)).toMatchObject({ outcome: "refused", reason: "handshake_failed" });
  });

  it("gives a handshake 15 seconds, then gives up", async () => {
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

  it("does not hold failures before a proof against the device: a copied ticket cannot keep it away", async () => {
    const r = rig();
    const mine = await makeDevice();
    const thief = await makeDevice();
    // Whoever replays the device's ticket has no key of its: it can only fail, any way it likes.
    for (let round = 0; round < 4; round += 1) {
      expect(await connect(r, { ...thief, device: mine.device }, { onRecord: false })).toBeNull();
      r.sessions.opened(SID2, ENV, mine.device);
      await r.advance(SCREEN_SHARE_HANDSHAKE_MS + 1);
      r.sessions.opened(SID, ENV, mine.device);
      r.sessions.received(SID, new Uint8Array([SCREEN_SHARE_WIRE.proof, 1, 2, 3]));
      await settle(r);
      r.sessions.opened(SID2, ENV, mine.device);
      r.sessions.closed(SID2);
      await settle(r);
    }
    expect(r.closes.filter((close) => close.reason === "handshake_failed")).toHaveLength(12);
    expect(r.prompts).toEqual([]);
    expect(r.store.inCooldown(mine.device.thumbprint)).toBe(false);
    // The device itself is still asked about.
    expect(await connect(r, mine)).not.toBeNull();
    expect(r.prompts).toHaveLength(1);
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
    await r.advance(AUTHENTICATE_PAUSE_MS);
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

describe("what was sealed as the session ended", () => {
  it("a frame still being sealed when Stop is pressed is not sent after the banner is down", async () => {
    const r = rig();
    const viewer = await live(r, await makeDevice());
    await r.advance(SCREEN_SHARE_FRAME_MIN_MS);
    await viewer.drain();
    const before = r.sent.length;
    // The next look at the screen comes back, and Stop lands while its frame is being sealed.
    let release: (grab: ScreenShareGrab) => void = () => {};
    r.state.heldGrab = new Promise((resolve) => {
      release = resolve;
    });
    const timers = r.advance(SCREEN_SHARE_FRAME_MIN_MS);
    release(frame("late"));
    // Promise turns only: the frame is handed to the sealer, and sealing takes longer than these.
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    r.sessions.stop();
    expect(r.state.bannerVisible).toBe(false);
    await timers;
    await settle(r);
    // It was captured and counted, and never left this machine.
    expect(r.store.audit.at(-1)).toMatchObject({ reason: "stopped_at_machine", frames: 1 });
    expect(r.sent.length).toBe(before);
    expect(r.closes.at(-1)).toEqual({ sid: SID, reason: "stopped_at_machine" });
  });

  it("with nothing held back, the last word is sealed and says why", async () => {
    const r = rig();
    const viewer = await live(r, await makeDevice());
    r.sessions.stop();
    await viewer.drain();
    expect(viewer.states.at(-1)).toEqual({ phase: "ended", reason: "stopped_at_machine" });
  });
});

describe("the list of sessions", () => {
  it("Always allow that cannot be saved is an allow for this once, and the list says so", async () => {
    const r = rig();
    const device = await makeDevice();
    const viewer = (await connect(r, device))!;
    r.file.failWhen = (stored) => stored.grants.length > 0;
    await r.sessions.answerPrompt(SID, "always");
    await viewer.drain();
    expect(viewer.states.at(-1)?.phase).toBe("live");
    expect(r.store.hasGrant(device.device.thumbprint)).toBe(false);
    expect(r.store.audit.at(-1)).toMatchObject({ id: SID, outcome: "allowed_once" });
  });

  it("a session that cannot be written to the list does not start", async () => {
    const r = rig();
    const device = await makeDevice();
    const viewer = (await connect(r, device))!;
    r.state.grabs.push(frame("a"));
    r.file.failWrites = true;
    await r.sessions.answerPrompt(SID, "once");
    await r.advance(SCREEN_SHARE_FRAME_MIN_MS * 3);
    await viewer.drain();
    expect(r.closes).toEqual([{ sid: SID, reason: "unsupported" }]);
    expect(r.state.bannerVisible).toBe(false);
    expect(r.state.grabbed).toEqual([]);
    expect(viewer.frames).toEqual([]);
  });

  it("a viewer that leaves while a person is being asked counts toward its quiet time", async () => {
    const r = rig();
    const device = await makeDevice();
    for (const sid of [SID, SID2, "2f1e2d3c-4b5a-4978-8695-a4b3c2d1e0f9"]) {
      await connect(r, device, { sid });
      r.sessions.closed(sid);
      await settle(r);
    }
    expect(r.store.inCooldown(device.device.thumbprint)).toBe(true);
    // Nor is sending nonsense a way round it, once a person was made to look.
    const noisy = rig();
    for (const sid of [SID, SID2, "2f1e2d3c-4b5a-4978-8695-a4b3c2d1e0f9"]) {
      const viewer = (await connect(noisy, device, { sid }))!;
      await viewer.tell(SCREEN_SHARE_RECORD.showDisplay, { displayId: "1" });
      expect(noisy.closes.at(-1)).toEqual({ sid, reason: "protocol_error" });
    }
    expect(noisy.store.inCooldown(device.device.thumbprint)).toBe(true);
    // Leaving before anyone was asked does not.
    const quiet = rig();
    for (const sid of [SID, SID2, "2f1e2d3c-4b5a-4978-8695-a4b3c2d1e0f9"]) {
      quiet.sessions.opened(sid, ENV, device.device);
      quiet.sessions.closed(sid);
      await settle(quiet);
    }
    expect(quiet.store.inCooldown(device.device.thumbprint)).toBe(false);
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

  it("after three dialogs that came to nothing the prompt is a refusal, and a dialog is not put straight back up", async () => {
    const r = rig();
    const device = await makeDevice();
    r.state.auth = () => Promise.resolve(false);
    await connect(r, device);
    await r.sessions.answerPrompt(SID, "once");
    // Pressed again at once: no second dialog yet.
    await r.sessions.answerPrompt(SID, "once");
    expect(r.authReasons).toHaveLength(1);
    await r.advance(AUTHENTICATE_PAUSE_MS);
    await r.sessions.answerPrompt(SID, "once");
    await r.advance(AUTHENTICATE_PAUSE_MS);
    expect(r.closes).toEqual([]);
    await r.sessions.answerPrompt(SID, "always");
    await settle(r);
    expect(r.authReasons).toHaveLength(AUTHENTICATE_TRIES);
    expect(r.closes).toEqual([{ sid: SID, reason: "denied" }]);
    expect(r.banners).toEqual([]);
    expect(r.store.grants).toEqual([]);
  });

  it("changes nothing on disk when the person is not there", async () => {
    const r = rig({ enabled: false });
    const before = r.file.bytes;
    r.state.auth = () => Promise.resolve(false);
    expect(await r.sessions.setEnabled(true)).toBe(false);
    r.state.auth = () => Promise.reject(new Error("cancelled"));
    await r.advance(AUTHENTICATE_PAUSE_MS);
    expect(await r.sessions.setEnabled(true)).toBe(false);
    expect(r.file.bytes).toBe(before);
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
    await r.advance(AUTHENTICATE_PAUSE_MS);
    expect(await r.sessions.setEnabled(true)).toBe(false);
    r.state.auth = () => Promise.resolve(true);
    await r.advance(AUTHENTICATE_PAUSE_MS);
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

/**
 * What a 1.0.443 viewer reads (1490 slice 1), frozen here so a change to the
 * shared schemas cannot hide a break. Copied from `packages/contracts` at that tag.
 */
const Slice1Display = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  primary: Schema.Boolean,
});
const Slice1State = Schema.Union([
  Schema.Struct({ phase: Schema.Literal("waiting_for_approval") }),
  Schema.Struct({ phase: Schema.Literal("needs_code"), triesLeft: Schema.Int }),
  Schema.Struct({
    phase: Schema.Literal("live"),
    displays: Schema.Array(Slice1Display),
    displayId: Schema.String,
    endsAt: Schema.Number,
  }),
  Schema.Struct({ phase: Schema.Literal("locked") }),
  Schema.Struct({ phase: Schema.Literal("ended"), reason: Schema.String }),
]);
const Slice1FrameHeader = Schema.Struct({
  seq: Schema.Int,
  displayId: Schema.String,
  width: Schema.Int,
  height: Schema.Int,
  pointer: Schema.optionalKey(Schema.Struct({ x: Schema.Number, y: Schema.Number })),
});

describe("version skew with slice 1 (1519)", () => {
  it("a new machine runs a whole session with a slice-1 viewer: nothing it would reject", async () => {
    const r = rig();
    const device = await makeDevice();
    r.state.grabs.push(frame("a"), frame("b"));
    const viewer = await live(r, device);
    await r.advance(SCREEN_SHARE_FRAME_MIN_MS + 1);
    await viewer.drain();
    await viewer.tell(SCREEN_SHARE_RECORD.frameReceived, { seq: 1 });
    await r.advance(SCREEN_SHARE_FRAME_MIN_MS + 1);
    await viewer.drain();
    const decodeState = Schema.decodeUnknownSync(Slice1State);
    const decodeHeader = Schema.decodeUnknownSync(Slice1FrameHeader);
    for (const state of viewer.states) expect(() => decodeState(state)).not.toThrow();
    expect(viewer.frames).toHaveLength(2);
    for (const sent of viewer.frames) {
      expect(() => decodeHeader(sent.header)).not.toThrow();
      // Nothing new reaches a viewer that never said it knows it.
      expect("stats" in sent.header).toBe(false);
    }
    // Slice 1's picture and pace for a viewer that sent no viewport.
    expect(r.state.looks.every((look) => look?.viewport === null)).toBe(true);
    expect(r.closes).toEqual([]);
  });

  it("announces its features in the sealed live state", async () => {
    const r = rig();
    const viewer = await live(r, await makeDevice());
    const liveState = viewer.states.find((state) => state.phase === "live");
    expect(liveState).toMatchObject({ features: ["viewport"] });
  });

  it("a viewport changes the picture and the pace, and frames then carry stats", async () => {
    const r = rig();
    const device = await makeDevice();
    r.state.grabs.push(frame("a"), frame("b"), frame("c"));
    const viewer = await live(r, device);
    // The first frame left before the viewer said anything: slice 1's, with nothing new.
    expect(viewer.frames).toHaveLength(1);
    expect("stats" in viewer.frames[0]!.header).toBe(false);
    await viewer.tell(SCREEN_SHARE_RECORD.viewport, { width: 2560, height: 1680, picture: "auto" });
    await r.advance(10);
    await viewer.tell(SCREEN_SHARE_RECORD.frameReceived, { seq: 1 });
    await r.advance(SCREEN_SHARE_FRAME_MIN_MS);
    await viewer.drain();
    expect(viewer.frames).toHaveLength(2);
    expect(viewer.frames[1]!.header.stats).toMatchObject({ confirmMs: 10, grabMs: 0 });
    expect(r.state.looks.at(-1)).toEqual({
      viewport: { width: 2560, height: 1680, picture: "auto" },
      // The first viewport may change the picture: the one sent last is not compared against.
      previousDigest: null,
    });
    await viewer.tell(SCREEN_SHARE_RECORD.frameReceived, { seq: 2 });
    // After a change the next look comes at the fast pace, well before another 330 ms.
    await r.advance(101);
    await viewer.drain();
    expect(viewer.frames).toHaveLength(3);
    expect(r.closes).toEqual([]);
  });

  it("a new size keeps the last digest; a new picture choice drops it", async () => {
    const r = rig();
    r.state.grabs.push(frame("a"), frame("b"));
    const viewer = await live(r, await makeDevice());
    await viewer.tell(SCREEN_SHARE_RECORD.viewport, { width: 1200, height: 800, picture: "auto" });
    await viewer.tell(SCREEN_SHARE_RECORD.frameReceived, { seq: 1 });
    await r.advance(SCREEN_SHARE_FRAME_MIN_MS);
    await viewer.drain();
    expect(viewer.frames).toHaveLength(2);
    await viewer.tell(SCREEN_SHARE_RECORD.frameReceived, { seq: 2 });
    await viewer.tell(SCREEN_SHARE_RECORD.viewport, { width: 1300, height: 800, picture: "auto" });
    await r.advance(400);
    expect(r.state.looks.at(-1)?.previousDigest).not.toBeNull();
    await viewer.tell(SCREEN_SHARE_RECORD.viewport, { width: 1300, height: 800, picture: "low" });
    await r.advance(400);
    expect(r.state.looks.at(-1)?.previousDigest).toBeNull();
  });

  it("applies the newest viewport over the rate once the rate allows", async () => {
    const r = rig();
    const viewer = await live(r, await makeDevice());
    for (let index = 0; index < 8; index += 1)
      await viewer.tell(SCREEN_SHARE_RECORD.viewport, {
        width: 1000 + index,
        height: 800,
        picture: "auto",
      });
    // Nothing to send, so the loop keeps looking; the rate frees a second later
    // and the next slow look uses the newest size.
    await r.advance(1_500);
    expect(r.state.looks.at(-1)?.viewport).toEqual({ width: 1007, height: 800, picture: "auto" });
    expect(r.closes).toEqual([]);
  });

  it("ignores viewports past the rate and ends on a malformed one", async () => {
    const r = rig();
    const viewer = await live(r, await makeDevice());
    for (let index = 0; index < 8; index += 1)
      await viewer.tell(SCREEN_SHARE_RECORD.viewport, {
        width: 1000 + index,
        height: 800,
        picture: "auto",
      });
    expect(r.closes).toEqual([]);
    await viewer.tell(SCREEN_SHARE_RECORD.viewport, { width: 1.5, height: 800, picture: "auto" });
    expect(r.closes).toEqual([{ sid: SID, reason: "protocol_error" }]);
  });
});
