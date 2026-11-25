import {
  SCREEN_SHARE_MAX_VIEWER_RECORD_BYTES,
  SCREEN_SHARE_RECORD,
  SCREEN_SHARE_WIRE,
  encodeScreenShareFrame,
  type ScreenShareSessionState,
} from "@specweave-studio/contracts";
import { computeDpopJwkThumbprint, type DpopPublicJwk } from "@specweave-studio/shared/dpop";
import {
  acceptScreenShareProof,
  makeScreenShareOpener,
  makeScreenShareSealer,
  newScreenShareMachineKey,
  startScreenShareTarget,
} from "@specweave-studio/shared/screenShareChannel";
import { describe, expect, it } from "vite-plus/test";

import {
  ScreenViewerSession,
  type ScreenViewerDeviceKey,
  type ScreenViewerSocket,
} from "./screenShareClient";
import type { ScreenViewerModel } from "./screenViewer.logic";

const ENV = "environment-1";
const SID = "0f1e2d3c-4b5a-4978-8695-a4b3c2d1e0f9";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const DISPLAYS = [{ id: "1", label: "Built-in display", primary: true }];

async function makeDeviceKey(): Promise<ScreenViewerDeviceKey & { thumbprint: string }> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const publicJwk = { kty: "EC", crv: "P-256", x: exported.x!, y: exported.y! } as DpopPublicJwk;
  return {
    publicJwk,
    thumbprint: computeDpopJwkThumbprint(publicJwk),
    sign: async (data) =>
      new Uint8Array(
        await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, data),
      ),
  };
}

/** A view wired to a socket the test holds, with the machine's half of the real handshake. */
async function rig(options?: {
  /** A machine key saved on this device before: this machine's own, or some other. */
  readonly pin?: "own" | "another";
  readonly deviceKey?: boolean;
}) {
  const device = await makeDeviceKey();
  const machineKey = newScreenShareMachineKey();
  let now = Date.parse("2026-11-25T12:00:00Z");
  const sent: Array<Uint8Array> = [];
  const models: Array<ScreenViewerModel> = [];
  const drawn: Array<number> = [];
  const order: Array<string> = [];
  const pins = new Map<string, string>(
    options?.pin === undefined
      ? []
      : [
          [
            ENV,
            options.pin === "own" ? machineKey.publicKey : newScreenShareMachineKey().publicKey,
          ],
        ],
  );
  const state = { closed: false, ticks: null as (() => void) | null };
  const socket: ScreenViewerSocket = {
    send: (bytes) => {
      order.push(`send:${bytes[0]}`);
      sent.push(bytes);
    },
    close: () => {
      state.closed = true;
    },
    onText: null,
    onBinary: null,
    onClose: null,
  };
  const session = new ScreenViewerSession({
    environmentId: ENV,
    open: () => Promise.resolve(socket),
    deviceKey: () => Promise.resolve(options?.deviceKey === false ? null : device),
    pins: { read: (id) => pins.get(id), write: (id, key) => void pins.set(id, key) },
    now: () => now,
    every: (_ms, run) => {
      state.ticks = run;
      return () => {
        state.ticks = null;
      };
    },
    onModel: (model) => void models.push(model),
    draw: async (header) => {
      // Drawing takes a moment; the confirmation must wait for it.
      await Promise.resolve();
      order.push(`draw:${header.seq}`);
      drawn.push(header.seq);
    },
    clear: () => void order.push("clear"),
  });
  session.start();
  await session.idle();

  /** The machine's half: answers the hello, takes the proof, then speaks sealed. */
  const machine = async () => {
    socket.onText?.(JSON.stringify({ t: "open", sid: SID, environmentId: ENV }));
    await session.idle();
    const hello = sent[0]!;
    expect(hello[0]).toBe(SCREEN_SHARE_WIRE.hello);
    const start = startScreenShareTarget({
      hello: JSON.parse(decoder.decode(hello.subarray(1))),
      environmentId: ENV,
      sessionId: SID,
      attestedThumbprint: device.thumbprint,
      machineKey,
    });
    socket.onBinary?.(
      new Uint8Array([
        SCREEN_SHARE_WIRE.challenge,
        ...encoder.encode(JSON.stringify(start.challenge)),
      ]),
    );
    await session.idle();
    const proof = sent[1];
    if (proof === undefined) return null;
    expect(proof[0]).toBe(SCREEN_SHARE_WIRE.proof);
    const accepted = acceptScreenShareProof({
      start,
      proof: JSON.parse(decoder.decode(proof.subarray(1))),
      environmentId: ENV,
      sessionId: SID,
      nowEpochSeconds: Math.floor(now / 1000),
    });
    const sealer = makeScreenShareSealer(accepted.keys.toViewer, SID);
    const opener = makeScreenShareOpener(accepted.keys.toTarget, SID);
    let read = 2;
    const say = async (type: number, data: Uint8Array) => {
      const record = await sealer.seal(type, data);
      socket.onBinary?.(new Uint8Array([SCREEN_SHARE_WIRE.sealed, ...record]));
      await session.idle();
    };
    return {
      code: accepted.code,
      knowsMachine: start.hello.knowsMachine,
      state: (value: ScreenShareSessionState) =>
        say(SCREEN_SHARE_RECORD.state, encoder.encode(JSON.stringify(value))),
      frame: (seq: number) =>
        say(
          SCREEN_SHARE_RECORD.frame,
          encodeScreenShareFrame(
            { seq, displayId: "1", width: 640, height: 400 },
            new Uint8Array([0xff, 0xd8, seq]),
          ),
        ),
      /** Opens what the viewer sent since the last call. */
      heard: async () => {
        const records: Array<{ type: number; body: Record<string, unknown> }> = [];
        for (; read < sent.length; read += 1) {
          expect(sent[read]![0]).toBe(SCREEN_SHARE_WIRE.sealed);
          expect(sent[read]!.length).toBeLessThanOrEqual(SCREEN_SHARE_MAX_VIEWER_RECORD_BYTES);
          const record = await opener.open(sent[read]!.subarray(1));
          records.push({ type: record.type, body: JSON.parse(decoder.decode(record.data)) });
        }
        return records;
      },
    };
  };
  const live: ScreenShareSessionState = {
    phase: "live",
    displays: DISPLAYS,
    displayId: "1",
    endsAt: now + 7_200_000,
  };
  return {
    session,
    socket,
    sent,
    models,
    drawn,
    order,
    pins,
    state,
    machine,
    machineKey,
    live,
    advance: async (ms: number) => {
      now += ms;
      state.ticks?.();
      await session.idle();
    },
  };
}

describe("ScreenViewerSession", () => {
  it("first use: the code from the machine's screen, then live, the key saved, frames drawn before they are confirmed", async () => {
    const r = await rig();
    const machine = (await r.machine())!;
    expect(machine.knowsMachine).toBe(false);
    await machine.state({ phase: "waiting_for_approval" });
    await machine.state({ phase: "needs_code", triesLeft: 3 });
    expect(r.session.model.phase).toMatchObject({ kind: "needs_code" });

    // A wrong code is not sent anywhere.
    r.session.typedCode(machine.code === "000000" ? "111111" : "000000");
    await r.session.idle();
    expect(await machine.heard()).toEqual([]);
    expect(r.pins.size).toBe(0);

    r.session.typedCode(machine.code);
    await r.session.idle();
    expect(await machine.heard()).toEqual([
      { type: SCREEN_SHARE_RECORD.confirmCode, body: { code: machine.code } },
    ]);
    expect(r.pins.size).toBe(0);

    await machine.state(r.live);
    expect(r.session.model.phase).toMatchObject({ kind: "live" });
    expect(r.pins.get(ENV)).toBe(r.machineKey.publicKey);

    await machine.frame(1);
    expect(r.drawn).toEqual([1]);
    expect(r.order.slice(-2)).toEqual(["draw:1", `send:${SCREEN_SHARE_WIRE.sealed}`]);
    expect(await machine.heard()).toEqual([
      { type: SCREEN_SHARE_RECORD.frameReceived, body: { seq: 1 } },
    ]);

    await r.advance(20_000);
    expect(await machine.heard()).toEqual([
      { type: SCREEN_SHARE_RECORD.frameReceived, body: { seq: 1 } },
    ]);

    r.session.end();
    await r.session.idle();
    expect(await machine.heard()).toEqual([{ type: SCREEN_SHARE_RECORD.end, body: {} }]);
    expect(r.state.closed).toBe(true);
    expect(r.state.ticks).toBeNull();
  });

  it("with another key saved for this machine: refuses before any proof is sent, and shows nothing", async () => {
    const r = await rig({ pin: "another" });
    expect(await r.machine()).toBeNull();
    expect(r.session.model.phase).toEqual({ kind: "ended", end: { kind: "machine_key_changed" } });
    // Only the hello went out.
    expect(r.sent).toHaveLength(1);
    expect(r.state.closed).toBe(true);
    expect(r.drawn).toEqual([]);
  });

  it("with the machine's key saved: says so in the hello, needs no code and saves nothing again", async () => {
    const r = await rig({ pin: "own" });
    const machine = (await r.machine())!;
    expect(machine.knowsMachine).toBe(true);
    await machine.state(r.live);
    expect(r.session.model.phase).toMatchObject({ kind: "live" });
    await machine.frame(1);
    expect(r.drawn).toEqual([1]);
    expect(r.pins.get(ENV)).toBe(r.machineKey.publicKey);
  });

  it("ends when the server names another machine than the one asked for, and sends nothing", async () => {
    const r = await rig();
    r.socket.onText?.(JSON.stringify({ t: "open", sid: SID, environmentId: "another" }));
    await r.session.idle();
    expect(r.sent).toEqual([]);
    expect(r.session.model.phase).toEqual({ kind: "ended", end: { kind: "handshake" } });
    expect(r.state.closed).toBe(true);
  });

  it("ends on a sealed record that was changed on the way, and draws nothing from it", async () => {
    const again = await rig();
    const machine = (await again.machine())!;
    await machine.state({ phase: "needs_code", triesLeft: 3 });
    const sealed = new Uint8Array([SCREEN_SHARE_WIRE.sealed, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    again.socket.onBinary?.(sealed);
    await again.session.idle();
    expect(again.session.model.phase).toEqual({ kind: "ended", end: { kind: "handshake" } });
    expect(again.drawn).toEqual([]);
    expect(again.pins.size).toBe(0);
  });

  it("says why when this device has no key, and when the socket never opened", async () => {
    const keyless = await rig({ deviceKey: false });
    expect(keyless.session.model.phase).toEqual({ kind: "ended", end: { kind: "no_device_key" } });

    const r = await rig();
    r.socket.onClose?.(1006, "");
    await r.session.idle();
    expect(r.session.model.phase).toEqual({ kind: "ended", end: { kind: "not_let_in" } });

    const refused = await rig();
    refused.socket.onText?.(JSON.stringify({ t: "open", sid: SID, environmentId: ENV }));
    refused.socket.onClose?.(4460, "off");
    await refused.session.idle();
    expect(refused.session.model.phase).toEqual({
      kind: "ended",
      end: { kind: "reason", reason: "off" },
    });
  });

  it("after the surface is gone: ends the session and reports nothing more", async () => {
    const r = await rig();
    const machine = (await r.machine())!;
    await machine.state({ phase: "waiting_for_approval" });
    const seen = r.models.length;
    r.session.dispose();
    await r.session.idle();
    expect(r.models).toHaveLength(seen);
    expect(await machine.heard()).toEqual([{ type: SCREEN_SHARE_RECORD.end, body: {} }]);
    expect(r.state.closed).toBe(true);
  });
});
