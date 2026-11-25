import {
  encodeScreenShareHostFrame,
  SCREEN_SHARE_CLOSE_REFUSED,
  type ScreenShareViewerDevice,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  HOST_REFUSED_RETRY_MS,
  HOST_RETRY_MS,
  ScreenShareHost,
  type HostSocket,
} from "./ScreenShareHost.ts";

const SID = "0f1e2d3c-4b5a-4978-8695-a4b3c2d1e0f9";
const DEVICE: ScreenShareViewerDevice = {
  thumbprint: "thumb",
  label: "Work laptop",
  shortId: "7F3A",
  kind: "connect",
};

function rig(
  target: { url: string; proof: string } | null = { url: "ws://h/host?wsTicket=t", proof: "p1" },
) {
  const sockets: Array<
    HostSocket & { sent: Array<string | Uint8Array>; closed: boolean; url: string }
  > = [];
  const timers: Array<{ ms: number; run: () => void; live: boolean }> = [];
  const calls: Array<string> = [];
  const links: Array<string> = [];
  const state = { target, status: { enabled: true, supported: true, busy: false } };
  const host = new ScreenShareHost({
    target: () => Promise.resolve(state.target),
    open: (url) => {
      const socket = {
        url,
        sent: [] as Array<string | Uint8Array>,
        closed: false,
        send: (data: string | Uint8Array) => void socket.sent.push(data),
        close: () => {
          socket.closed = true;
        },
        onOpen: null,
        onMessage: null,
        onClose: null,
      } as HostSocket & { sent: Array<string | Uint8Array>; closed: boolean; url: string };
      sockets.push(socket);
      return socket;
    },
    after: (ms, run) => {
      const timer = { ms, run, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
    sessions: {
      status: () => state.status,
      opened: (sid, environmentId, device) =>
        void calls.push(`opened:${sid}:${environmentId}:${device.label}`),
      received: (sid, payload) => void calls.push(`received:${sid}:${[...payload].join(",")}`),
      closed: (sid) => void calls.push(`closed:${sid}`),
      disconnected: () => void calls.push("disconnected"),
    },
    onLink: (link) => void links.push(link),
  });
  const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
  /** Runs the one retry timer that is waiting. */
  const fire = async () => {
    const timer = timers.find((candidate) => candidate.live);
    if (timer === undefined) throw new Error("No retry is waiting.");
    timer.live = false;
    timer.run();
    await turn();
    return timer.ms;
  };
  const texts = (index = 0) =>
    sockets[index]!.sent.filter((item): item is string => typeof item === "string").map(
      (item) => JSON.parse(item) as Record<string, unknown>,
    );
  /** A started link whose server accepted the proof. */
  const attached = async () => {
    host.start();
    await turn();
    sockets[0]!.onOpen?.();
    sockets[0]!.onMessage?.(JSON.stringify({ t: "attached" }));
  };
  return { host, sockets, timers, calls, links, state, turn, fire, texts, attached };
}

describe("ScreenShareHost", () => {
  it("sends its proof first and publishes its status only once the server accepted it", async () => {
    const r = rig();
    r.host.start();
    await r.turn();
    expect(r.sockets[0]!.url).toBe("ws://h/host?wsTicket=t");
    r.host.publishStatus();
    r.host.send(SID, new Uint8Array([1]));
    expect(r.sockets[0]!.sent).toEqual([]);
    r.sockets[0]!.onOpen?.();
    expect(r.texts()).toEqual([{ t: "hello", proof: "p1" }]);
    r.sockets[0]!.onMessage?.(JSON.stringify({ t: "attached" }));
    expect(r.texts()).toEqual([
      { t: "hello", proof: "p1" },
      { t: "status", status: { enabled: true, supported: true, busy: false } },
    ]);
    expect(r.links).toEqual(["attached"]);
    expect(r.host.state).toBe("attached");
  });

  it("acts on nothing the server says before it said attached", async () => {
    const r = rig();
    r.host.start();
    await r.turn();
    r.sockets[0]!.onOpen?.();
    r.sockets[0]!.onMessage?.(
      JSON.stringify({ t: "open", sid: SID, environmentId: "env", device: DEVICE }),
    );
    r.sockets[0]!.onMessage?.(encodeScreenShareHostFrame(SID, new Uint8Array([1, 2])));
    expect(r.calls).toEqual([]);
  });

  it("passes a viewer's opening, its bytes and its leaving to the sessions", async () => {
    const r = rig();
    await r.attached();
    const socket = r.sockets[0]!;
    socket.onMessage?.(
      JSON.stringify({ t: "open", sid: SID, environmentId: "env", device: DEVICE }),
    );
    socket.onMessage?.(encodeScreenShareHostFrame(SID, new Uint8Array([1, 2])));
    socket.onMessage?.(JSON.stringify({ t: "closed", sid: SID }));
    expect(r.calls).toEqual([
      `opened:${SID}:env:Work laptop`,
      `received:${SID}:1,2`,
      `closed:${SID}`,
    ]);
    r.host.send(SID, new Uint8Array([9]));
    r.host.close(SID, "denied");
    expect(socket.sent.at(-2)).toEqual(encodeScreenShareHostFrame(SID, new Uint8Array([9])));
    expect(r.texts().at(-1)).toEqual({ t: "close", sid: SID, reason: "denied" });
  });

  it("drops what is not a message it knows", async () => {
    const r = rig();
    await r.attached();
    const socket = r.sockets[0]!;
    for (const bad of [
      "not json",
      JSON.stringify({ t: "open", sid: "nope", environmentId: "env", device: DEVICE }),
      JSON.stringify({ t: "open", sid: SID, environmentId: "env", device: { label: "x" } }),
      JSON.stringify({ t: "open", sid: SID, device: DEVICE }),
      JSON.stringify({ t: "run", sid: SID }),
      JSON.stringify([1]),
    ])
      socket.onMessage?.(bad);
    socket.onMessage?.(new Uint8Array([1, 2, 3]));
    expect(r.calls).toEqual([]);
  });

  it("when the server refuses the proof: says so and waits a minute before trying again", async () => {
    const r = rig();
    r.host.start();
    await r.turn();
    r.sockets[0]!.onOpen?.();
    r.sockets[0]!.onClose?.(SCREEN_SHARE_CLOSE_REFUSED, "not_this_machines_app");
    expect(r.links).toEqual(["refused"]);
    expect(r.calls).toEqual([]);
    expect(await r.fire()).toBe(HOST_REFUSED_RETRY_MS);
    expect(r.sockets).toHaveLength(2);
  });

  it("when another program takes the link: ends the sessions, says so and waits a minute", async () => {
    const r = rig();
    await r.attached();
    r.sockets[0]!.onClose?.(1012, "replaced");
    expect(r.calls).toEqual(["disconnected"]);
    expect(r.links).toEqual(["attached", "replaced"]);
    expect(await r.fire()).toBe(HOST_REFUSED_RETRY_MS);
    r.sockets[1]!.onOpen?.();
    r.sockets[1]!.onMessage?.(JSON.stringify({ t: "attached" }));
    expect(r.links.at(-1)).toBe("attached");
  });

  it("reconnects after an ordinary drop, backing off while the server stays away", async () => {
    const r = rig();
    await r.attached();
    r.sockets[0]!.onClose?.(1006, "");
    expect(r.calls).toEqual(["disconnected"]);
    expect(r.links).toEqual(["attached", "connecting"]);
    expect(await r.fire()).toBe(HOST_RETRY_MS[0]);
    r.sockets[1]!.onClose?.(1006, "");
    expect(await r.fire()).toBe(HOST_RETRY_MS[1]);
    r.state.target = null;
    r.sockets[2]!.onClose?.(1006, "");
    expect(await r.fire()).toBe(HOST_RETRY_MS[2]);
    // No server to dial: no socket, another wait.
    expect(r.sockets).toHaveLength(3);
    expect(await r.fire()).toBe(HOST_RETRY_MS[3]);
  });

  it("stops: closes the socket, forgets the retry and ignores what arrives late", async () => {
    const r = rig();
    await r.attached();
    const socket = r.sockets[0]!;
    r.host.stop();
    expect(socket.closed).toBe(true);
    socket.onMessage?.(
      JSON.stringify({ t: "open", sid: SID, environmentId: "env", device: DEVICE }),
    );
    socket.onClose?.(1000, "");
    expect(r.calls).toEqual([]);
    expect(r.timers.filter((timer) => timer.live)).toEqual([]);
  });
});
