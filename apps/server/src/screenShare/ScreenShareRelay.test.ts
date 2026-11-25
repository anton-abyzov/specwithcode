import {
  encodeScreenShareHostFrame,
  SCREEN_SHARE_CLOSE_ENDED,
  SCREEN_SHARE_CLOSE_REFUSED,
  SCREEN_SHARE_COOLDOWN_WINDOW_MS,
  SCREEN_SHARE_MAX_CONTROL_BYTES,
  SCREEN_SHARE_MAX_VIEWER_RECORD_BYTES,
  SCREEN_SHARE_RELAY_OPENS,
  SCREEN_SHARE_WIRE,
  type ScreenShareViewerDevice,
} from "@specweave-studio/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off - the test reads the relay's own source.
import { readFileSync } from "node:fs";

import { makeScreenShareSealer } from "@specweave-studio/shared/screenShareChannel";
import { describe, expect, it } from "vite-plus/test";

import {
  RELAY_FIRST_WORD_MS,
  RELAY_HANDSHAKE_MS,
  RELAY_SESSION_MS,
  ScreenShareRelay,
  type ScreenSharePeer,
} from "./ScreenShareRelay.ts";

const SID = "0f1e2d3c-4b5a-4978-8695-a4b3c2d1e0f9";
const SID2 = "1f1e2d3c-4b5a-4978-8695-a4b3c2d1e0f9";
const DEVICE: ScreenShareViewerDevice = {
  thumbprint: "thumb",
  label: "Work laptop",
  shortId: "7F3A",
  kind: "connect",
};

function peer() {
  const texts: Array<string> = [];
  const binaries: Array<Uint8Array> = [];
  const closes: Array<{ code: number; reason: string }> = [];
  let buffered = 0;
  const end: ScreenSharePeer = {
    sendText: (text) => void texts.push(text),
    sendBinary: (bytes) => void binaries.push(bytes),
    close: (code, reason) => void closes.push({ code, reason }),
    bufferedBytes: () => buffered,
  };
  return {
    end,
    texts,
    binaries,
    closes,
    json: () => texts.map((text) => JSON.parse(text) as Record<string, unknown>),
    setBuffered: (bytes: number) => {
      buffered = bytes;
    },
  };
}

/** A clock and timers the test moves by hand. */
function clock() {
  let now = 1_000_000;
  let timers: Array<{ at: number; run: () => void }> = [];
  return {
    now: () => now,
    after: (ms: number, run: () => void) => {
      const timer = { at: now + ms, run };
      timers.push(timer);
      return () => {
        timers = timers.filter((other) => other !== timer);
      };
    },
    advance: (ms: number) => {
      now += ms;
      for (const timer of timers.filter((candidate) => candidate.at <= now)) {
        timers = timers.filter((other) => other !== timer);
        timer.run();
      }
    },
    pending: () => timers.length,
  };
}

const on = { enabled: true, supported: true, busy: false };
const status = (value: object) => JSON.stringify({ t: "status", status: value });
const bytes = (type: number, ...rest: ReadonlyArray<number>) => new Uint8Array([type, ...rest]);

function ready(options?: ConstructorParameters<typeof ScreenShareRelay>[0]) {
  const ids = [SID, SID2];
  const relay = new ScreenShareRelay({ newSessionId: () => ids.shift()!, ...options });
  const host = peer();
  const hostIn = relay.attachHost(host.end, "proof-1");
  hostIn.text(status(on));
  return { relay, host, hostIn };
}

/** Opens a session and passes one hello, challenge and proof through it. */
function handshaken(options?: ConstructorParameters<typeof ScreenShareRelay>[0]) {
  const made = ready(options);
  const viewer = peer();
  const opened = made.relay.openViewer(viewer.end, DEVICE, "env");
  if ("refused" in opened) throw new Error("refused");
  opened.binary(bytes(SCREEN_SHARE_WIRE.hello, 1));
  made.hostIn.binary(encodeScreenShareHostFrame(SID, bytes(SCREEN_SHARE_WIRE.challenge, 2)));
  opened.binary(bytes(SCREEN_SHARE_WIRE.proof, 3));
  viewer.binaries.length = 0;
  made.host.binaries.length = 0;
  return { ...made, viewer, opened };
}

describe("ScreenShareRelay", () => {
  it("refuses a viewer while no app is attached", () => {
    const relay = new ScreenShareRelay();
    expect(relay.openViewer(peer().end, DEVICE, "env")).toEqual({ refused: "no_host" });
    expect(relay.status()).toEqual({ host: false, enabled: false, supported: false, busy: false });
  });

  it("refuses a viewer until the app says sharing is on", () => {
    const relay = new ScreenShareRelay();
    const host = peer();
    const hostIn = relay.attachHost(host.end, "proof-1");
    // An app that has said nothing counts as unsupported and off.
    expect(relay.openViewer(peer().end, DEVICE, "env")).toEqual({ refused: "unsupported" });
    hostIn.text(status({ enabled: false, supported: true, busy: false }));
    expect(relay.openViewer(peer().end, DEVICE, "env")).toEqual({ refused: "off" });
    // The app heard that it is attached, and of no viewer.
    expect(host.json()).toEqual([{ t: "attached" }]);
  });

  it("opens a session, names the device to the app and passes bytes both ways", () => {
    const { relay, host, hostIn } = ready();
    const viewer = peer();
    const opened = relay.openViewer(viewer.end, DEVICE, "env");
    if ("refused" in opened) throw new Error("refused");
    expect(viewer.json()).toEqual([{ t: "open", sid: SID, environmentId: "env" }]);
    expect(host.json()).toEqual([
      { t: "attached" },
      { t: "open", sid: SID, environmentId: "env", device: DEVICE },
    ]);

    opened.binary(bytes(SCREEN_SHARE_WIRE.hello, 7));
    expect(host.binaries).toEqual([
      encodeScreenShareHostFrame(SID, bytes(SCREEN_SHARE_WIRE.hello, 7)),
    ]);
    hostIn.binary(encodeScreenShareHostFrame(SID, bytes(SCREEN_SHARE_WIRE.challenge, 8)));
    expect(viewer.binaries).toEqual([bytes(SCREEN_SHARE_WIRE.challenge, 8)]);
    expect(relay.status().busy).toBe(true);
  });

  it("allows one session at a time", () => {
    const { relay } = ready();
    expect("sid" in relay.openViewer(peer().end, DEVICE, "env")).toBe(true);
    expect(relay.openViewer(peer().end, DEVICE, "env")).toEqual({ refused: "busy" });
  });

  it("ends the session when a viewer sends what only the machine may send", () => {
    const { relay, host } = ready();
    const viewer = peer();
    const opened = relay.openViewer(viewer.end, DEVICE, "env");
    if ("refused" in opened) throw new Error("refused");
    opened.binary(bytes(SCREEN_SHARE_WIRE.challenge, 1));
    expect(host.binaries).toEqual([]);
    expect(viewer.closes).toEqual([{ code: SCREEN_SHARE_CLOSE_ENDED, reason: "protocol_error" }]);
    expect(host.json().at(-1)).toEqual({ t: "closed", sid: SID });
  });

  it("ends the session on an empty or unknown message from either end", () => {
    for (const bad of [new Uint8Array(0), bytes(99)]) {
      const { relay } = ready();
      const viewer = peer();
      const opened = relay.openViewer(viewer.end, DEVICE, "env");
      if ("refused" in opened) throw new Error("refused");
      opened.binary(bad);
      expect(viewer.closes[0]?.reason).toBe("protocol_error");
    }
    const { relay, hostIn } = ready();
    const viewer = peer();
    relay.openViewer(viewer.end, DEVICE, "env");
    hostIn.binary(encodeScreenShareHostFrame(SID, bytes(SCREEN_SHARE_WIRE.hello)));
    expect(viewer.closes[0]?.reason).toBe("protocol_error");
  });

  it("passes one hello, one challenge and one proof, in that order, then sealed records only", () => {
    const viewerFirst: ReadonlyArray<readonly [string, (made: ReturnType<typeof ready>) => void]> =
      [
        ["a proof before any hello", ({ relay }) => send(relay, bytes(SCREEN_SHARE_WIRE.proof))],
        ["a sealed record before the handshake", ({ relay }) => send(relay, bytes(16, 1))],
        [
          "a second hello",
          ({ relay }) =>
            send(relay, bytes(SCREEN_SHARE_WIRE.hello), bytes(SCREEN_SHARE_WIRE.hello)),
        ],
        [
          "a proof before the machine's challenge",
          ({ relay }) =>
            send(relay, bytes(SCREEN_SHARE_WIRE.hello), bytes(SCREEN_SHARE_WIRE.proof)),
        ],
      ];
    function send(relay: ScreenShareRelay, ...messages: ReadonlyArray<Uint8Array>) {
      const viewer = peer();
      const opened = relay.openViewer(viewer.end, DEVICE, "env");
      if ("refused" in opened) throw new Error("refused");
      for (const message of messages) opened.binary(message);
      expect(viewer.closes.at(-1)?.reason).toBe("protocol_error");
    }
    for (const [, run] of viewerFirst) run(ready());

    // The machine: no challenge before the hello, no second one, nothing sealed before the proof.
    const early = ready();
    const earlyViewer = peer();
    early.relay.openViewer(earlyViewer.end, DEVICE, "env");
    early.hostIn.binary(encodeScreenShareHostFrame(SID, bytes(SCREEN_SHARE_WIRE.challenge)));
    expect(earlyViewer.closes[0]?.reason).toBe("protocol_error");

    const twice = ready();
    const twiceViewer = peer();
    const twiceOpened = twice.relay.openViewer(twiceViewer.end, DEVICE, "env");
    if ("refused" in twiceOpened) throw new Error("refused");
    twiceOpened.binary(bytes(SCREEN_SHARE_WIRE.hello));
    twice.hostIn.binary(encodeScreenShareHostFrame(SID, bytes(SCREEN_SHARE_WIRE.challenge)));
    twice.hostIn.binary(encodeScreenShareHostFrame(SID, bytes(SCREEN_SHARE_WIRE.sealed, 1)));
    expect(twiceViewer.closes[0]?.reason).toBe("protocol_error");

    const done = handshaken();
    done.opened.binary(bytes(SCREEN_SHARE_WIRE.sealed, 9));
    done.hostIn.binary(encodeScreenShareHostFrame(SID, bytes(SCREEN_SHARE_WIRE.sealed, 8)));
    expect(done.host.binaries).toEqual([
      encodeScreenShareHostFrame(SID, bytes(SCREEN_SHARE_WIRE.sealed, 9)),
    ]);
    expect(done.viewer.binaries).toEqual([bytes(SCREEN_SHARE_WIRE.sealed, 8)]);
    done.opened.binary(bytes(SCREEN_SHARE_WIRE.hello));
    expect(done.viewer.closes.at(-1)?.reason).toBe("protocol_error");
  });

  it("drops a hello, challenge or proof over 64 KB", () => {
    const big = (type: number) => {
      const message = new Uint8Array(SCREEN_SHARE_MAX_CONTROL_BYTES + 1);
      message[0] = type;
      return message;
    };
    const { relay, host } = ready();
    const viewer = peer();
    const opened = relay.openViewer(viewer.end, DEVICE, "env");
    if ("refused" in opened) throw new Error("refused");
    opened.binary(big(SCREEN_SHARE_WIRE.hello));
    expect(host.binaries).toEqual([]);
    expect(viewer.closes[0]?.reason).toBe("protocol_error");

    const second = ready();
    const other = peer();
    const otherOpened = second.relay.openViewer(other.end, DEVICE, "env");
    if ("refused" in otherOpened) throw new Error("refused");
    otherOpened.binary(bytes(SCREEN_SHARE_WIRE.hello));
    second.hostIn.binary(encodeScreenShareHostFrame(SID, big(SCREEN_SHARE_WIRE.challenge)));
    expect(other.binaries).toEqual([]);
    expect(other.closes[0]?.reason).toBe("protocol_error");
  });

  it("holds only sealed bytes: a real record passes unchanged and the relay has no way to open it", async () => {
    const { opened, hostIn, viewer, host } = handshaken();
    const key = crypto.getRandomValues(new Uint8Array(32));
    const secret = new TextEncoder().encode("a frame of the screen");
    const sealed = await makeScreenShareSealer(key, SID).seal(2, secret);
    const record = new Uint8Array([SCREEN_SHARE_WIRE.sealed, ...sealed]);
    hostIn.binary(encodeScreenShareHostFrame(SID, record));
    opened.binary(record);
    expect(viewer.binaries).toEqual([record]);
    expect(host.binaries).toEqual([encodeScreenShareHostFrame(SID, record)]);
    expect(Buffer.from(record).includes(Buffer.from(secret))).toBe(false);
    // The relay is never given a key, and its source uses nothing that could open a record.
    const source = readFileSync(new URL("./ScreenShareRelay.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/screenShareChannel|decodeScreenShareFrame|subtle|createDecipher/);
  });

  it("remembers what the app proved itself with, and drops an app whose proof went stale", () => {
    const { relay, host } = ready();
    expect(relay.hostCredential()).toBe("proof-1");
    const viewer = peer();
    relay.openViewer(viewer.end, DEVICE, "env");
    relay.dropHost("proof_stale");
    expect(host.closes).toEqual([{ code: SCREEN_SHARE_CLOSE_REFUSED, reason: "proof_stale" }]);
    expect(viewer.closes).toEqual([{ code: SCREEN_SHARE_CLOSE_REFUSED, reason: "no_host" }]);
    expect(relay.hostCredential()).toBeUndefined();
    expect(relay.openViewer(peer().end, DEVICE, "env")).toEqual({ refused: "no_host" });
  });

  it("drops what the app sends for a session that does not exist", () => {
    const { relay, hostIn } = ready();
    const viewer = peer();
    relay.openViewer(viewer.end, DEVICE, "env");
    hostIn.binary(encodeScreenShareHostFrame(SID2, bytes(SCREEN_SHARE_WIRE.sealed, 1)));
    hostIn.binary(new Uint8Array([1, 2, 3]));
    expect(viewer.binaries).toEqual([]);
    expect(viewer.closes).toEqual([]);
  });

  it("drops a viewer that does not read, instead of holding its frames", () => {
    const { host, hostIn, viewer } = handshaken({ maxBufferBytes: 100 });
    viewer.setBuffered(90);
    hostIn.binary(
      encodeScreenShareHostFrame(SID, new Uint8Array(20).fill(SCREEN_SHARE_WIRE.sealed)),
    );
    expect(viewer.binaries).toEqual([]);
    expect(viewer.closes).toEqual([{ code: SCREEN_SHARE_CLOSE_ENDED, reason: "viewer_silent" }]);
    expect(host.json().at(-1)).toEqual({ t: "closed", sid: SID });
  });

  it("closes the viewer with the app's reason: refused before a session, ended after", () => {
    for (const [reason, code] of [
      ["denied", SCREEN_SHARE_CLOSE_REFUSED],
      ["cooldown", SCREEN_SHARE_CLOSE_REFUSED],
      ["stopped_at_machine", SCREEN_SHARE_CLOSE_ENDED],
      ["time_limit", SCREEN_SHARE_CLOSE_ENDED],
    ] as const) {
      const { relay, host, hostIn } = ready();
      const viewer = peer();
      relay.openViewer(viewer.end, DEVICE, "env");
      hostIn.text(JSON.stringify({ t: "close", sid: SID, reason }));
      expect(viewer.closes).toEqual([{ code, reason }]);
      // The app asked, so it is not told again.
      expect(host.json().filter((message) => message.t === "closed")).toEqual([]);
      expect(relay.status().busy).toBe(false);
    }
  });

  it("ignores a close whose reason is not plain words", () => {
    const { relay, hostIn } = ready();
    const viewer = peer();
    relay.openViewer(viewer.end, DEVICE, "env");
    hostIn.text(JSON.stringify({ t: "close", sid: SID, reason: "<b>look here</b>" }));
    hostIn.text("not json");
    hostIn.text(JSON.stringify({ t: "status", status: { enabled: "yes" } }));
    expect(viewer.closes).toEqual([]);
  });

  it("tells the app when the viewer leaves, once", () => {
    const { relay, host } = ready();
    const opened = relay.openViewer(peer().end, DEVICE, "env");
    if ("refused" in opened) throw new Error("refused");
    opened.closed();
    opened.closed();
    expect(host.json().filter((message) => message.t === "closed")).toEqual([
      { t: "closed", sid: SID },
    ]);
    expect(relay.status().busy).toBe(false);
  });

  it("ends every session when the app goes away or sharing is turned off", () => {
    const first = ready();
    const viewer = peer();
    first.relay.openViewer(viewer.end, DEVICE, "env");
    first.hostIn.closed();
    expect(viewer.closes).toEqual([{ code: SCREEN_SHARE_CLOSE_REFUSED, reason: "no_host" }]);
    expect(first.relay.status().host).toBe(false);

    const second = ready();
    const other = peer();
    second.relay.openViewer(other.end, DEVICE, "env");
    second.hostIn.text(status({ enabled: false, supported: true, busy: false }));
    expect(other.closes).toEqual([{ code: SCREEN_SHARE_CLOSE_ENDED, reason: "turned_off" }]);
  });

  it("a new app socket replaces the old one, whose messages then do nothing", () => {
    const { relay, host, hostIn } = ready();
    const viewer = peer();
    relay.openViewer(viewer.end, DEVICE, "env");
    const next = peer();
    const nextIn = relay.attachHost(next.end, "proof-2");
    expect(host.closes).toEqual([{ code: 1012, reason: "replaced" }]);
    expect(viewer.closes).toEqual([{ code: SCREEN_SHARE_CLOSE_REFUSED, reason: "no_host" }]);
    hostIn.text(status(on));
    expect(relay.status().enabled).toBe(false);
    hostIn.closed();
    expect(relay.status().host).toBe(true);
    nextIn.text(status(on));
    expect(relay.status().enabled).toBe(true);
  });

  it("ends a handshake that does not finish in time, whatever the app does", () => {
    const time = clock();
    const { relay, host } = ready({ after: time.after, now: time.now });
    const viewer = peer();
    const opened = relay.openViewer(viewer.end, DEVICE, "env");
    if ("refused" in opened) throw new Error("refused");
    opened.binary(bytes(SCREEN_SHARE_WIRE.hello, 1));
    // The app never answers with a challenge.
    time.advance(RELAY_HANDSHAKE_MS - 1);
    expect(viewer.closes).toEqual([]);
    time.advance(1);
    expect(viewer.closes).toEqual([{ code: SCREEN_SHARE_CLOSE_ENDED, reason: "handshake_failed" }]);
    expect(host.json().at(-1)).toEqual({ t: "closed", sid: SID });
    expect(relay.status().busy).toBe(false);
    expect(time.pending()).toBe(0);
  });

  it("ends a session whose app says nothing sealed after the proof", () => {
    const time = clock();
    const { viewer, relay } = handshaken({ after: time.after, now: time.now });
    time.advance(RELAY_FIRST_WORD_MS);
    expect(viewer.closes).toEqual([{ code: SCREEN_SHARE_CLOSE_ENDED, reason: "handshake_failed" }]);
    expect(relay.status().busy).toBe(false);
  });

  it("ends a session at its longest life even when the app never ends it", () => {
    const time = clock();
    const { viewer, hostIn } = handshaken({ after: time.after, now: time.now });
    hostIn.binary(encodeScreenShareHostFrame(SID, bytes(SCREEN_SHARE_WIRE.sealed, 9)));
    time.advance(RELAY_SESSION_MS - RELAY_HANDSHAKE_MS);
    expect(viewer.closes).toEqual([]);
    time.advance(RELAY_HANDSHAKE_MS);
    expect(viewer.closes).toEqual([{ code: SCREEN_SHARE_CLOSE_ENDED, reason: "time_limit" }]);
    expect(time.pending()).toBe(0);
  });

  it("refuses a device that opened too many sessions lately, and lets it back after the window", () => {
    const time = clock();
    let made = 0;
    const { relay } = ready({
      after: time.after,
      now: time.now,
      newSessionId: () => `${String((made += 1)).padStart(8, "0")}-4b5a-4978-8695-a4b3c2d1e0f9`,
    });
    for (let index = 0; index < SCREEN_SHARE_RELAY_OPENS; index += 1) {
      const opened = relay.openViewer(peer().end, DEVICE, "env");
      if ("refused" in opened) throw new Error(`refused at ${index}`);
      opened.closed();
    }
    expect(relay.openViewer(peer().end, DEVICE, "env")).toEqual({ refused: "cooldown" });
    // Another device is not held back by this one.
    const other = relay.openViewer(peer().end, { ...DEVICE, thumbprint: "other" }, "env");
    if ("refused" in other) throw new Error("refused");
    other.closed();
    time.advance(SCREEN_SHARE_COOLDOWN_WINDOW_MS);
    expect("sid" in relay.openViewer(peer().end, DEVICE, "env")).toBe(true);
  });

  it("passes only small sealed records from a viewer, and ends on any text from one", () => {
    const first = handshaken();
    first.hostIn.binary(encodeScreenShareHostFrame(SID, bytes(SCREEN_SHARE_WIRE.sealed, 9)));
    const big = new Uint8Array(SCREEN_SHARE_MAX_VIEWER_RECORD_BYTES + 1);
    big[0] = SCREEN_SHARE_WIRE.sealed;
    first.opened.binary(big.subarray(0, SCREEN_SHARE_MAX_VIEWER_RECORD_BYTES));
    expect(first.host.binaries).toHaveLength(1);
    first.opened.binary(big);
    expect(first.host.binaries).toHaveLength(1);
    expect(first.viewer.closes).toEqual([
      { code: SCREEN_SHARE_CLOSE_ENDED, reason: "protocol_error" },
    ]);

    const second = handshaken();
    second.opened.text();
    expect(second.viewer.closes).toEqual([
      { code: SCREEN_SHARE_CLOSE_ENDED, reason: "protocol_error" },
    ]);
    expect(second.host.json().at(-1)).toEqual({ t: "closed", sid: SID });
  });

  it("keeps the app's latest proof for the routes to check again", () => {
    const { relay, hostIn } = ready();
    expect(relay.hostCredential()).toBe("proof-1");
    hostIn.reprove("proof-2");
    expect(relay.hostCredential()).toBe("proof-2");
    const next = peer();
    relay.attachHost(next.end, "proof-3");
    // The replaced socket can no longer change what is checked.
    hostIn.reprove("proof-4");
    expect(relay.hostCredential()).toBe("proof-3");
    // Nor can its failed proof drop the app that replaced it.
    hostIn.drop("proof_stale");
    expect(relay.status().host).toBe(true);
    expect(next.closes).toEqual([]);
  });
});
