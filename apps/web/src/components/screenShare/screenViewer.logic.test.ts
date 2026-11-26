import {
  SCREEN_SHARE_CLOSE_ENDED,
  SCREEN_SHARE_CLOSE_REFUSED,
  SCREEN_SHARE_NO_PICTURE_MS,
  SCREEN_SHARE_RECORD,
  ScreenShareEndReason,
  encodeScreenShareFrame,
  type ScreenShareSessionState,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  SCREEN_VIEWER_HEARTBEAT_MS,
  formatScreenShareCode,
  initialScreenViewer,
  reduceScreenViewer,
  screenShareCodeDigits,
  screenShareMachineKeyStorageKey,
  screenViewerCanRetry,
  screenViewerEndOfClose,
  screenViewerEndWords,
  screenViewerPhaseWords,
  screenViewerTimeLeft,
  type ScreenViewerEffect,
  type ScreenViewerEvent,
  type ScreenViewerModel,
} from "./screenViewer.logic";

const T0 = 1_000_000;
const CODE = "482913";
const KEY = "machine-key-1";
const encoder = new TextEncoder();
const DISPLAYS = [
  { id: "1", label: "Built-in display", primary: true },
  { id: "2", label: "Studio Display", primary: false },
];
const LIVE: ScreenShareSessionState = {
  phase: "live",
  displays: DISPLAYS,
  displayId: "1",
  endsAt: T0 + 7_200_000,
};

/** Runs events through the rules, keeping everything they asked to be done. */
function run(events: ReadonlyArray<ScreenViewerEvent>, from = initialScreenViewer(T0)) {
  let model: ScreenViewerModel = from;
  const effects: Array<ScreenViewerEffect> = [];
  for (const event of events) {
    const step = reduceScreenViewer(model, event);
    model = step.model;
    effects.push(...step.effects);
  }
  return { model, effects };
}

const state = (value: ScreenShareSessionState, now = T0): ScreenViewerEvent => ({
  t: "record",
  type: SCREEN_SHARE_RECORD.state,
  data: encoder.encode(JSON.stringify(value)),
  now,
});
const frame = (seq: number, displayId = "1", now = T0): ScreenViewerEvent => ({
  t: "record",
  type: SCREEN_SHARE_RECORD.frame,
  data: encodeScreenShareFrame(
    { seq, displayId, width: 1920, height: 1080, pointer: { x: 10, y: 20 } },
    new Uint8Array([0xff, 0xd8, seq]),
  ),
  now,
});
const handshake = (pinned: boolean): ScreenViewerEvent => ({
  t: "handshake",
  code: CODE,
  machineKey: KEY,
  pinned,
});
const sent = (effects: ReadonlyArray<ScreenViewerEffect>) =>
  effects.flatMap((effect) => (effect.t === "send" ? [{ type: effect.type, ...effect.body }] : []));
const kinds = (effects: ReadonlyArray<ScreenViewerEffect>) => effects.map((effect) => effect.t);

describe("a device that already holds the machine's key", () => {
  it("goes from asking to live, and saves nothing new", () => {
    const { model, effects } = run([
      handshake(true),
      state({ phase: "waiting_for_approval" }),
      state(LIVE),
    ]);
    expect(model.phase).toMatchObject({ kind: "live", displayId: "1", locked: false });
    expect(kinds(effects)).toEqual(["clear_picture"]);
  });

  it("goes straight to live where it is always allowed", () => {
    expect(run([handshake(true), state(LIVE)]).model.phase.kind).toBe("live");
  });

  it("still types the code when the machine asks for it: the machine decides what a first time is", () => {
    const asked = run([
      handshake(true),
      state({ phase: "waiting_for_approval" }),
      state({ phase: "needs_code", triesLeft: 3 }),
    ]);
    expect(asked.model.phase).toMatchObject({ kind: "needs_code", triesLeft: 3, sent: false });
    const done = run([{ t: "typed_code", text: "482 913" }, state(LIVE)], asked.model);
    expect(sent(done.effects)).toEqual([{ type: SCREEN_SHARE_RECORD.confirmCode, code: CODE }]);
    expect(done.model.phase.kind).toBe("live");
    // The key was already saved here; it is not saved again.
    expect(kinds(done.effects)).not.toContain("save_machine_key");
  });
});

describe("first use", () => {
  const asked = () =>
    run([
      handshake(false),
      state({ phase: "waiting_for_approval" }),
      state({ phase: "needs_code", triesLeft: 3 }),
    ]);

  it("sends the code only once what was typed matches this device's own", () => {
    const wrong = run([{ t: "typed_code", text: "000000" }], asked().model);
    expect(wrong.effects).toEqual([]);
    expect(wrong.model.phase).toMatchObject({ kind: "needs_code", wrong: true, triesHere: 2 });
    expect(wrong.model.codeMatched).toBe(false);

    const right = run([{ t: "typed_code", text: CODE }], wrong.model);
    expect(sent(right.effects)).toEqual([{ type: SCREEN_SHARE_RECORD.confirmCode, code: CODE }]);
    expect(right.model.phase).toMatchObject({ kind: "needs_code", wrong: false, sent: true });
    // Typing again while the machine checks does nothing.
    expect(run([{ t: "typed_code", text: CODE }], right.model).effects).toEqual([]);
  });

  it("saves the machine's key only after the code matched here and the machine went live", () => {
    const typed = run([{ t: "typed_code", text: CODE }], asked().model);
    expect(kinds(typed.effects)).not.toContain("save_machine_key");
    const live = run([state(LIVE)], typed.model);
    expect(live.effects).toContainEqual({ t: "save_machine_key", machineKey: KEY });
    // Once: a later live (another display, an unlock) does not save again.
    const later = run([state({ ...LIVE, displayId: "2" })], live.model);
    expect(kinds(later.effects)).not.toContain("save_machine_key");
  });

  it("gives up after three codes that do not match here, sends none of them and saves no key", () => {
    const { model, effects } = run(
      [
        { t: "typed_code", text: "000000" },
        { t: "typed_code", text: "111111" },
        { t: "typed_code", text: "222222" },
      ],
      asked().model,
    );
    expect(model.phase).toEqual({ kind: "ended", end: { kind: "code_mismatch" } });
    expect(sent(effects)).toEqual([{ type: SCREEN_SHARE_RECORD.end }]);
    expect(kinds(effects)).not.toContain("save_machine_key");
    expect(kinds(effects).at(-1)).toBe("close");
  });

  it("saves no key when the session ends before live, right code or not", () => {
    const typed = run([{ t: "typed_code", text: CODE }], asked().model);
    for (const last of [
      state({ phase: "ended", reason: "wrong_code" }),
      state({ phase: "ended", reason: "prompt_timeout" }),
      { t: "closed", code: 1006, reason: "", opened: true } as const,
      // Asked again after the right code went out: the two ends disagree about the code.
      state({ phase: "needs_code", triesLeft: 2 }),
    ]) {
      const over = run([last, state(LIVE)], typed.model);
      expect(over.model.phase.kind).toBe("ended");
      expect(kinds(over.effects)).not.toContain("save_machine_key");
    }
  });

  it("does not believe live from a machine it has no key for and no code from", () => {
    // No saved key, and the machine skips the code: a stand-in would do exactly this.
    for (const before of [
      [handshake(false)],
      [handshake(false), state({ phase: "waiting_for_approval" })],
      [handshake(false), state({ phase: "needs_code", triesLeft: 3 })],
    ]) {
      const { model, effects } = run([...before, state(LIVE), frame(1)]);
      expect(model.phase).toEqual({ kind: "ended", end: { kind: "handshake" } });
      expect(kinds(effects)).not.toContain("draw");
      expect(kinds(effects)).not.toContain("save_machine_key");
    }
  });
});

describe("frames", () => {
  const live = () => run([handshake(true), state(LIVE)]).model;

  it("accepts no frame before live", () => {
    for (const before of [
      [handshake(true)],
      [handshake(true), state({ phase: "waiting_for_approval" })],
      [handshake(false), state({ phase: "needs_code", triesLeft: 3 })],
    ]) {
      const { model, effects } = run([...before, frame(1)]);
      expect(model.phase).toEqual({ kind: "ended", end: { kind: "handshake" } });
      expect(kinds(effects)).not.toContain("draw");
    }
    // Nor before the handshake finished at all.
    const early = run([frame(1)]);
    expect(early.model.phase.kind).toBe("ended");
    expect(kinds(early.effects)).not.toContain("draw");
  });

  it("draws a frame, then says it was seen", () => {
    const { model, effects } = run([frame(1)], live());
    expect(kinds(effects)).toEqual(["draw", "send"]);
    expect(effects[0]).toMatchObject({ t: "draw", header: { seq: 1, pointer: { x: 10, y: 20 } } });
    expect(sent(effects)).toEqual([{ type: SCREEN_SHARE_RECORD.frameReceived, seq: 1 }]);
    expect(model).toMatchObject({ lastSeq: 1, hasPicture: true });
  });

  it("ends on a frame that is out of order or not a frame", () => {
    const one = run([frame(2)], live()).model;
    expect(run([frame(2)], one).model.phase.kind).toBe("ended");
    expect(run([frame(1)], one).model.phase.kind).toBe("ended");
    const junk: ScreenViewerEvent = {
      t: "record",
      type: SCREEN_SHARE_RECORD.frame,
      data: new Uint8Array([1, 2]),
      now: T0,
    };
    expect(run([junk], live()).model.phase.kind).toBe("ended");
  });

  it("ends on any record that is neither a state nor a frame, and on a state it cannot read", () => {
    for (const type of [SCREEN_SHARE_RECORD.frameReceived, SCREEN_SHARE_RECORD.confirmCode, 99]) {
      const { model, effects } = run(
        [{ t: "record", type, data: encoder.encode("{}"), now: T0 }],
        live(),
      );
      expect(model.phase).toEqual({ kind: "ended", end: { kind: "handshake" } });
      expect(kinds(effects)).toEqual(["clear_picture", "close"]);
    }
    const odd: ScreenViewerEvent = {
      t: "record",
      type: SCREEN_SHARE_RECORD.state,
      data: encoder.encode(JSON.stringify({ phase: "live", code: CODE })),
      now: T0,
    };
    expect(run([odd], live()).model.phase.kind).toBe("ended");
  });

  it("takes the picture down while the machine is locked, and draws nothing until it says live again", () => {
    const locked = run([frame(1), state({ phase: "locked" })], live());
    expect(locked.model.phase).toMatchObject({ kind: "live", locked: true });
    expect(kinds(locked.effects)).toContain("clear_picture");
    expect(locked.model.hasPicture).toBe(false);
    expect(run([frame(2)], locked.model).model.phase.kind).toBe("ended");
    const back = run([state(LIVE), frame(2)], locked.model);
    expect(back.model.phase).toMatchObject({ kind: "live", locked: false });
    expect(kinds(back.effects)).toContain("draw");
  });

  it("asks for another display and clears the picture once the machine switched", () => {
    const asked = run([frame(1), { t: "choose_display", displayId: "2" }], live());
    expect(sent(asked.effects).at(-1)).toEqual({
      type: SCREEN_SHARE_RECORD.showDisplay,
      displayId: "2",
    });
    // A display the machine never listed, or the one already shown, asks for nothing.
    expect(run([{ t: "choose_display", displayId: "9" }], live()).effects).toEqual([]);
    expect(run([{ t: "choose_display", displayId: "1" }], live()).effects).toEqual([]);

    const switched = run([state({ ...LIVE, displayId: "2" })], asked.model);
    expect(switched.model.hasPicture).toBe(false);
    expect(kinds(switched.effects)).toEqual(["clear_picture"]);
    // A late frame of the display just left is confirmed, never drawn.
    const late = run([frame(2, "1")], switched.model);
    expect(kinds(late.effects)).toEqual(["send"]);
    expect(run([frame(2, "2")], switched.model).model.hasPicture).toBe(true);
  });

  it("repeats the last seen frame about every 20 seconds, also before any frame came", () => {
    const quiet = run([{ t: "tick", now: T0 + SCREEN_VIEWER_HEARTBEAT_MS - 1 }], live());
    expect(quiet.effects).toEqual([]);
    const beat = run([{ t: "tick", now: T0 + SCREEN_VIEWER_HEARTBEAT_MS }], live());
    expect(sent(beat.effects)).toEqual([{ type: SCREEN_SHARE_RECORD.frameReceived, seq: 0 }]);

    const seen = run([frame(3, "1", T0 + 1000)], live()).model;
    const again = run(
      [
        { t: "tick", now: T0 + SCREEN_VIEWER_HEARTBEAT_MS },
        { t: "tick", now: T0 + 1000 + SCREEN_VIEWER_HEARTBEAT_MS },
        { t: "tick", now: T0 + 2000 + SCREEN_VIEWER_HEARTBEAT_MS },
      ],
      seen,
    );
    expect(sent(again.effects)).toEqual([{ type: SCREEN_SHARE_RECORD.frameReceived, seq: 3 }]);
  });

  it("says the display may be asleep after 10 seconds live with nothing to show, not for a still screen", () => {
    const waiting = run([{ t: "tick", now: T0 + SCREEN_SHARE_NO_PICTURE_MS }], live());
    expect(waiting.model.phase).toMatchObject({ kind: "live", noPicture: true });
    expect(screenViewerPhaseWords(waiting.model.phase)).toContain("may be asleep");
    expect(run([frame(1)], waiting.model).model.phase).toMatchObject({ noPicture: false });

    // A frame is on screen and nothing changes for a long time: that is a still screen.
    const still = run([frame(1), { t: "tick", now: T0 + 6 * SCREEN_SHARE_NO_PICTURE_MS }], live());
    expect(still.model.phase).toMatchObject({ kind: "live", noPicture: false });
  });
});

describe("ending", () => {
  it("says so sealed when the person ends it, and plainly closes when there is no session yet", () => {
    const live = run([handshake(true), state(LIVE), { t: "end_here" }]);
    expect(sent(live.effects)).toEqual([{ type: SCREEN_SHARE_RECORD.end }]);
    expect(kinds(live.effects).at(-1)).toBe("close");
    expect(live.model.phase).toEqual({ kind: "ended", end: { kind: "ended_here" } });
    expect(kinds(run([{ t: "end_here" }]).effects)).toEqual(["clear_picture", "close"]);
  });

  it("stays ended: nothing that arrives late draws or brings the view back", () => {
    const over = run([handshake(true), state(LIVE), state({ phase: "ended", reason: "denied" })]);
    const late = run(
      [state(LIVE), frame(1), { t: "typed_code", text: CODE }, { t: "tick", now: T0 + 99_000 }],
      over.model,
    );
    expect(late.model).toBe(over.model);
    expect(late.effects).toEqual([]);
  });

  it("reads the refusal from the close, and tells a dropped link from never being let in", () => {
    expect(screenViewerEndOfClose(SCREEN_SHARE_CLOSE_REFUSED, "off", true)).toEqual({
      kind: "reason",
      reason: "off",
    });
    expect(screenViewerEndOfClose(SCREEN_SHARE_CLOSE_ENDED, "time_limit", true)).toEqual({
      kind: "reason",
      reason: "time_limit",
    });
    expect(screenViewerEndOfClose(4401, "", true)).toEqual({ kind: "signed_out" });
    // A reason that is no reason, or a reason on some other code, is not repeated.
    expect(screenViewerEndOfClose(SCREEN_SHARE_CLOSE_REFUSED, "<b>hi</b>", true)).toEqual({
      kind: "connection_lost",
    });
    expect(screenViewerEndOfClose(1000, "off", true)).toEqual({ kind: "connection_lost" });
    expect(screenViewerEndOfClose(1006, "", false)).toEqual({ kind: "not_let_in" });
    const closed = run([
      { t: "closed", code: SCREEN_SHARE_CLOSE_REFUSED, reason: "busy", opened: true },
    ]);
    expect(closed.model.phase).toEqual({ kind: "ended", end: { kind: "reason", reason: "busy" } });
    expect(kinds(closed.effects)).toEqual(["clear_picture"]);
  });

  it("names a changed machine key for what it is, shows nothing and offers no plain retry", () => {
    const { model, effects } = run([{ t: "handshake_failed", failure: "machine_key_changed" }]);
    expect(model.phase).toEqual({ kind: "ended", end: { kind: "machine_key_changed" } });
    expect(kinds(effects)).toEqual(["clear_picture", "close"]);
    const words = screenViewerEndWords({ kind: "machine_key_changed" });
    expect(words.title).toBe("This is not the key {machine} used before");
    expect(words.detail).toContain("different screen sharing key");
    expect(words.detail).toContain("Nothing was shown");
    expect(screenViewerCanRetry({ kind: "machine_key_changed" })).toBe(false);
    // Any other handshake failure is a plain failure.
    expect(run([{ t: "handshake_failed", failure: "machine_signature" }]).model.phase).toEqual({
      kind: "ended",
      end: { kind: "handshake" },
    });
    expect(run([{ t: "no_device_key" }]).model.phase).toEqual({
      kind: "ended",
      end: { kind: "no_device_key" },
    });
  });
});

describe("words", () => {
  it("has plain words for every reason the machine or the server can give", () => {
    for (const reason of ScreenShareEndReason.literals) {
      const { title, detail } = screenViewerEndWords({ kind: "reason", reason });
      expect(title.length).toBeGreaterThan(5);
      expect(detail.length).toBeGreaterThan(15);
      // Words, never the identifier.
      expect(`${title}${detail}`).not.toMatch(/[a-z]_[a-z]/);
      expect(`${title}${detail}`).not.toMatch(/—|Studio\b/);
    }
    expect(screenViewerEndWords({ kind: "reason", reason: "off" }).detail).toContain(
      "only be turned on at that machine",
    );
    expect(screenViewerEndWords({ kind: "signed_out" }).detail).toContain("Sign in again");
    expect(screenViewerEndWords({ kind: "not_let_in" }).detail).toContain("SpecWithCode Connect");
  });

  it("formats the code, the time left and the storage key", () => {
    expect(formatScreenShareCode("482913")).toBe("482 913");
    expect(screenShareCodeDigits(" 482-913 7")).toBe("482913");
    expect(screenViewerTimeLeft(T0 + 7_199_000, T0)).toBe("1 h 59 min");
    expect(screenViewerTimeLeft(T0 + 12 * 60_000, T0)).toBe("12 min");
    expect(screenViewerTimeLeft(T0 + 30_000, T0)).toBe("under a minute");
    expect(screenViewerTimeLeft(T0 - 1, T0)).toBe("under a minute");
    expect(screenShareMachineKeyStorageKey("env-1")).toBe(
      "specwithcode:screen-share:machine-key:env-1",
    );
  });
});
