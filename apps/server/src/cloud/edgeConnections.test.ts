import { describe, expect, it } from "vite-plus/test";

import {
  EDGE_LOSS_RESTART_AFTER_MS,
  EdgeConnections,
  edgeConnectionEvent,
} from "./edgeConnections.ts";

const registered = (index: number) =>
  `2026-11-28T07:12:40Z INF Registered tunnel connection connIndex=${index} connection=4b1c event=0 ip=198.41.200.13 location=bos01 protocol=quic`;
const terminated = (index: number) =>
  `2026-11-28T07:30:02Z WRN Connection terminated error="timeout: no recent network activity" connIndex=${index}`;

describe("edgeConnectionEvent", () => {
  it("reads registrations and the ways cloudflared says a connection went away", () => {
    expect(edgeConnectionEvent(registered(2))).toEqual({ kind: "up", index: 2 });
    expect(edgeConnectionEvent(terminated(1))).toEqual({ kind: "down", index: 1 });
    expect(
      edgeConnectionEvent(
        'ERR Serve tunnel error error="failed to dial to edge with quic: timeout" connIndex=0 event=0 ip=198.41.192.7',
      ),
    ).toEqual({ kind: "down", index: 0 });
    expect(
      edgeConnectionEvent(
        "INF Retrying connection in up to 4s connIndex=3 event=0 ip=198.41.200.33",
      ),
    ).toEqual({ kind: "down", index: 3 });
    expect(
      edgeConnectionEvent(
        "INF Unregistered tunnel connection connIndex=0 event=0 ip=198.41.200.13",
      ),
    ).toEqual({ kind: "down", index: 0 });
    expect(edgeConnectionEvent("INF Lost connection with the edge connIndex=2")).toEqual({
      kind: "down",
      index: 2,
    });
  });

  it("ignores lines without a connection number and unrelated lines", () => {
    expect(edgeConnectionEvent("INF Registered tunnel connection")).toBeNull();
    expect(
      edgeConnectionEvent("INF Starting metrics server on 127.0.0.1:20241/metrics"),
    ).toBeNull();
    expect(
      edgeConnectionEvent("INF Updated to new configuration connIndex=0 version=3"),
    ).toBeNull();
  });
});

describe("EdgeConnections", () => {
  it("counts live connections and says lost only after every one has been gone long enough", () => {
    const edge = new EdgeConnections();
    expect(edge.apply(edgeConnectionEvent(registered(0))!, 0)).toBe(1);
    expect(edge.apply(edgeConnectionEvent(registered(1))!, 0)).toBe(2);
    expect(edge.apply(edgeConnectionEvent(terminated(0))!, 1_000)).toBe(1);
    expect(edge.lostFor(10 * EDGE_LOSS_RESTART_AFTER_MS)).toBe(false);
    expect(edge.apply(edgeConnectionEvent(terminated(1))!, 2_000)).toBe(0);
    expect(edge.lostFor(2_000 + EDGE_LOSS_RESTART_AFTER_MS - 1)).toBe(false);
    expect(edge.lostFor(2_000 + EDGE_LOSS_RESTART_AFTER_MS)).toBe(true);
  });

  it("clears the loss when any connection registers again", () => {
    const edge = new EdgeConnections();
    edge.apply({ kind: "up", index: 0 }, 0);
    edge.apply({ kind: "down", index: 0 }, 0);
    edge.apply({ kind: "up", index: 3 }, 60_000);
    expect(edge.lostFor(10 * EDGE_LOSS_RESTART_AFTER_MS)).toBe(false);
  });

  it("leaves a connector that never registered to the registration watchdog", () => {
    const edge = new EdgeConnections();
    edge.apply({ kind: "down", index: 0 }, 0);
    expect(edge.lostFor(10 * EDGE_LOSS_RESTART_AFTER_MS)).toBe(false);
  });

  it("does not count a repeated loss of one connection twice", () => {
    const edge = new EdgeConnections();
    edge.apply({ kind: "up", index: 0 }, 0);
    edge.apply({ kind: "up", index: 1 }, 0);
    edge.apply({ kind: "down", index: 0 }, 0);
    edge.apply({ kind: "down", index: 0 }, 0);
    expect(edge.count).toBe(1);
  });
});
