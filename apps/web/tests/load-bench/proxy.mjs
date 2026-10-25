// A TCP proxy between the browser and the server under test. It counts the bytes on
// the wire in each direction, split into plain HTTP and upgraded WebSocket
// connections, can shape the link (one-way latency plus a shared bandwidth per
// direction, so WebSocket frames are throttled as well as HTTP), and can cut every
// open connection at once to force the client to reconnect.
import * as NodeNet from "node:net";

/** One direction of the emulated link, shared by every connection. */
class Link {
  constructor(bitsPerSecond, latencyMs) {
    this.bitsPerSecond = bitsPerSecond;
    this.latencyMs = latencyMs;
    this.freeAt = 0;
  }
  /** When a chunk handed over now arrives at the far end. */
  arrival(bytes) {
    const now = performance.now();
    if (!this.bitsPerSecond && !this.latencyMs) return now;
    const start = Math.max(now, this.freeAt);
    this.freeAt = start + (this.bitsPerSecond ? (bytes * 8 * 1000) / this.bitsPerSecond : 0);
    return this.freeAt + this.latencyMs;
  }
}

/** Delivers chunks of one socket direction in order, each at its arrival time. */
function pump(link, destination) {
  const queue = [];
  let timer = null;
  const drain = () => {
    timer = null;
    const now = performance.now();
    while (queue.length > 0 && queue[0].at <= now + 0.5) {
      const { chunk } = queue.shift();
      if (!destination.destroyed) destination.write(chunk);
    }
    if (queue.length > 0) timer = setTimeout(drain, Math.max(0, queue[0].at - now));
  };
  return (chunk) => {
    const at = link.arrival(chunk.length);
    if (at <= performance.now() && queue.length === 0) {
      if (!destination.destroyed) destination.write(chunk);
      return;
    }
    queue.push({ at, chunk });
    if (timer === null) timer = setTimeout(drain, Math.max(0, at - performance.now()));
  };
}

/**
 * @param {{ upstreamPort: number, shape?: { latencyMs: number, downKbps: number, upKbps: number } | null }} options
 */
export async function startProxy({ upstreamPort, shape = null }) {
  const oneWay = shape ? shape.latencyMs / 2 : 0;
  const down = new Link(shape ? shape.downKbps * 1000 : 0, oneWay);
  const up = new Link(shape ? shape.upKbps * 1000 : 0, oneWay);
  const totals = { httpUp: 0, httpDown: 0, wsUp: 0, wsDown: 0, connections: 0 };
  const sockets = new Set();
  let refusing = false;
  const server = NodeNet.createServer((client) => {
    if (refusing) {
      client.destroy();
      return;
    }
    totals.connections += 1;
    let websocket = false;
    const upstream = NodeNet.connect({ host: "127.0.0.1", port: upstreamPort });
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    sockets.add(client);
    sockets.add(upstream);
    const toServer = pump(up, upstream);
    const toClient = pump(down, client);
    client.on("data", (chunk) => {
      totals[websocket ? "wsUp" : "httpUp"] += chunk.length;
      toServer(chunk);
    });
    upstream.on("data", (chunk) => {
      if (!websocket && chunk.subarray(0, 12).toString("latin1") === "HTTP/1.1 101")
        websocket = true;
      totals[websocket ? "wsDown" : "httpDown"] += chunk.length;
      toClient(chunk);
    });
    const close = () => {
      sockets.delete(client);
      sockets.delete(upstream);
      client.destroy();
      upstream.destroy();
    };
    client.on("close", close);
    upstream.on("close", close);
    client.on("error", close);
    upstream.on("error", close);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return {
    port: server.address().port,
    totals: () => ({ ...totals }),
    /** Cut every open connection, refusing new ones for `offlineMs`. */
    drop(offlineMs = 0) {
      refusing = offlineMs > 0;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      if (refusing)
        setTimeout(() => {
          refusing = false;
        }, offlineMs);
    },
    close: () =>
      new Promise((done) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => done());
      }),
  };
}

/** Wire-byte difference between two `totals()` snapshots. */
export function wireDelta(after, before) {
  const http = after.httpUp + after.httpDown - before.httpUp - before.httpDown;
  const ws = after.wsUp + after.wsDown - before.wsUp - before.wsDown;
  return {
    http,
    ws,
    total: http + ws,
    down: after.httpDown + after.wsDown - before.httpDown - before.wsDown,
    up: after.httpUp + after.wsUp - before.httpUp - before.wsUp,
  };
}
