// @effect-diagnostics globalDate:off nodeBuiltinImport:off globalTimers:off - the one place a copy opens a socket to a private address.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeTls from "node:tls";
import * as NodeZlib from "node:zlib";

import type { LanCertificate } from "./lanCertificate.ts";
import { directlyAttached, type LanPolicy } from "./lanInterfaces.ts";
import {
  LAN_ALPN,
  LAN_CLIENT_LIMITS,
  LanFailure,
  lanFailureForStatus,
  sameSha256,
  sha256Of,
  type LanClientLimits,
} from "./lanWire.ts";
import type { ManifestEntry, ManifestHeader } from "./manifest.ts";
import { decodeFrames, FOLDER_TRANSFER_PREFIX, sha256Hex, type ChunkFrame } from "./wire.ts";

/**
 * The destination's one connector to a source on the local network (1334 S-3).
 * Every byte a copy sends to a private address goes through it: the first
 * request, retries and keepalive reconnects. Order, for every new connection:
 *
 *  1. The address comes from the accepted `lan` block only and must be
 *     admitted and directly attached.
 *  2. TCP connect, 1.5 s per address, in the offered order.
 *  3. TLS 1.3 presenting the recipient's one-time certificate.
 *  4. The server certificate's DER hash is compared with the pin in constant
 *     time. On a mismatch the socket is destroyed; no HTTP byte was written.
 *  5. Only then does an HTTP client get the socket.
 *  6. The first request on the connection is `GET hello`, and its answer must
 *     name the same environment, operation, generation and binding.
 *
 * No plaintext, no redirect, no proxy, no environment probe, no base URL. One
 * pool of at most four connections per generation, never shared.
 */
export interface LanRoute {
  readonly operationId: string;
  readonly generation: number;
  readonly addresses: ReadonlyArray<{ readonly host: string; readonly port: number }>;
  readonly sourceCertificateSha256: string;
  readonly lanToken: string;
  readonly recipient: LanCertificate;
  readonly expected: {
    readonly environmentId: string;
    readonly operationId: string;
    readonly generation: number;
    readonly bindingSha256: string;
  };
}

export interface LanConnectorStats {
  /** TLS handshakes that completed, whatever the pin check said next. */
  handshakes: number;
  pinFailures: number;
  /** HTTP requests written; zero for a connection whose pin did not match. */
  requests: number;
  connections: number;
}

interface Connection {
  readonly socket: NodeTls.TLSSocket;
  readonly agent: NodeHttp.Agent;
  busy: boolean;
}

interface Answer {
  readonly status: number;
  readonly body: Buffer;
}

const unreachable = () => new LanFailure("unreachable");

export class LanConnector {
  readonly stats: LanConnectorStats = {
    handshakes: 0,
    pinFailures: 0,
    requests: 0,
    connections: 0,
  };
  /** Wire bytes of manifests and chunk batches received on this path. */
  wireBytes = 0;
  /** The batch limit the source named in its hello, when it did. */
  maxBatchChunks: number | null = null;

  private readonly route: LanRoute;
  private readonly policy: LanPolicy;
  private readonly limits: LanClientLimits;
  private readonly connections = new Set<Connection>();
  private opening = 0;
  private readonly waiting: Array<() => void> = [];
  private destroyed = false;

  constructor(route: LanRoute, policy: LanPolicy, limits: LanClientLimits = LAN_CLIENT_LIMITS) {
    this.route = route;
    this.policy = policy;
    this.limits = limits;
  }

  get generation() {
    return this.route.generation;
  }

  /** Destroys the pool: on a latch, a newer generation or a terminal state. */
  destroy() {
    this.destroyed = true;
    for (const connection of this.connections) {
      connection.socket.destroy();
      connection.agent.destroy();
    }
    this.connections.clear();
    for (const wake of this.waiting.splice(0)) wake();
  }

  /** Steps 1 to 4 for one address: a socket whose pin matched, or a failure. */
  private dial(
    address: { readonly host: string; readonly port: number },
    localAddress: string,
    deadlineAt: number,
  ): Promise<NodeTls.TLSSocket> {
    return new Promise((resolve, reject) => {
      const budget = Math.min(this.limits.connectMs, deadlineAt - Date.now());
      if (budget <= 0) return reject(unreachable());
      let settled = false;
      // The TCP socket leaves from the eligible interface's own address.
      const tcp = NodeNet.connect({ host: address.host, port: address.port, localAddress });
      tcp.on("error", () => undefined);
      const options: NodeTls.ConnectionOptions = {
        socket: tcp,
        minVersion: "TLSv1.3",
        maxVersion: "TLSv1.3",
        ALPNProtocols: [LAN_ALPN],
        key: this.route.recipient.keyPem,
        cert: this.route.recipient.certificatePem,
        // Chain validation is not used: the exact pin below is the trust.
        rejectUnauthorized: false,
      };
      const socket = NodeTls.connect(options);
      const fail = (failure: LanFailure) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        tcp.destroy();
        reject(failure);
      };
      const timer = setTimeout(() => fail(unreachable()), budget);
      socket.once("error", () => fail(unreachable()));
      socket.once("close", () => fail(unreachable()));
      socket.once("secureConnect", () => {
        if (settled) return;
        this.stats.handshakes += 1;
        const presented = socket.getPeerX509Certificate()?.raw;
        if (
          presented === undefined ||
          !sameSha256(sha256Of(presented), this.route.sourceCertificateSha256)
        ) {
          // Destroyed before any HTTP client exists for this socket.
          this.stats.pinFailures += 1;
          return fail(new LanFailure("wrong_pin"));
        }
        if (
          socket.getProtocol() !== "TLSv1.3" ||
          socket.alpnProtocol !== LAN_ALPN ||
          socket.isSessionReused()
        )
          return fail(unreachable());
        settled = true;
        clearTimeout(timer);
        socket.removeAllListeners("error");
        socket.removeAllListeners("close");
        socket.on("error", () => undefined);
        resolve(socket);
      });
    });
  }

  /** A new connection, through to an authenticated hello, inside one 5 s deadline. */
  private async open(): Promise<Connection> {
    const deadlineAt = Date.now() + this.limits.setupMs;
    let socket: NodeTls.TLSSocket | null = null;
    for (const address of this.route.addresses) {
      if (this.destroyed) throw unreachable();
      const local = await directlyAttached(this.policy, address.host);
      if (local === null) continue;
      try {
        socket = await this.dial(address, local.address, deadlineAt);
        break;
      } catch (cause) {
        // A wrong pin is never tried around; an unreachable address gives way to the next.
        if (cause instanceof LanFailure && cause.kind !== "unreachable") throw cause;
      }
    }
    if (socket === null) throw unreachable();
    let taken = false;
    const pinned = socket;
    const agent = new NodeHttp.Agent({ keepAlive: true, maxSockets: 1, maxTotalSockets: 1 });
    // The agent may use this one verified socket and never opens another.
    (agent as unknown as { createConnection: () => NodeTls.TLSSocket }).createConnection = () => {
      if (taken) throw new Error("closed");
      taken = true;
      return pinned;
    };
    const connection: Connection = { socket: pinned, agent, busy: true };
    this.connections.add(connection);
    this.stats.connections += 1;
    pinned.once("close", () => {
      this.connections.delete(connection);
      agent.destroy();
    });
    try {
      const hello = await this.send(connection, "GET", "hello", undefined, {
        totalMs: Math.max(1, deadlineAt - Date.now()),
        maxBytes: this.limits.smallAnswerBytes,
        progress: false,
      });
      if (hello.status !== 200) throw this.statusFailure(hello);
      let named: Record<string, unknown>;
      try {
        named = JSON.parse(hello.body.toString("utf8")) as Record<string, unknown>;
      } catch {
        throw new LanFailure("wrong_identity");
      }
      const expected = this.route.expected;
      if (
        named.environmentId !== expected.environmentId ||
        named.operationId !== expected.operationId ||
        named.generation !== expected.generation ||
        named.bindingSha256 !== expected.bindingSha256
      )
        throw new LanFailure("wrong_identity");
      if (typeof named.maxBatchChunks === "number") this.maxBatchChunks = named.maxBatchChunks;
    } catch (cause) {
      pinned.destroy();
      throw cause;
    }
    return connection;
  }

  private statusFailure(answer: Answer): LanFailure {
    let error: unknown;
    try {
      error = (JSON.parse(answer.body.toString("utf8")) as { error?: unknown }).error;
    } catch {
      error = undefined;
    }
    return lanFailureForStatus(answer.status, error);
  }

  /** One request on a verified connection, with streamed, counted reads and deadlines. */
  private send(
    connection: Connection,
    method: "GET" | "POST",
    action: string,
    body: Uint8Array | undefined,
    options: {
      readonly totalMs: number;
      readonly maxBytes: number;
      readonly progress: boolean;
      readonly signal?: AbortSignal | undefined;
      readonly onData?: (part: Buffer) => void;
    },
  ): Promise<Answer> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timers: Array<ReturnType<typeof setTimeout>> = [];
      const finish = (failure: LanFailure | null, answer?: Answer) => {
        if (settled) return;
        settled = true;
        for (const timer of timers) clearTimeout(timer);
        clearInterval(progress);
        options.signal?.removeEventListener("abort", aborted);
        if (failure) {
          connection.socket.destroy();
          reject(failure);
        } else resolve(answer!);
      };
      const aborted = () => finish(unreachable());
      if (options.signal?.aborted) return finish(unreachable());
      options.signal?.addEventListener("abort", aborted, { once: true });
      timers.push(setTimeout(() => finish(unreachable()), options.totalMs));
      timers.push(setTimeout(() => !answered && finish(unreachable()), this.limits.headersMs));
      let answered = false;
      let received = 0;
      let lastMark = 0;
      let ending = false;
      const progress = setInterval(() => {
        if (!options.progress || !answered || ending) return;
        if (received - lastMark < this.limits.progressBytes) finish(unreachable());
        lastMark = received;
      }, this.limits.progressMs);
      this.stats.requests += 1;
      const request = NodeHttp.request({
        agent: connection.agent,
        host: "lan.invalid",
        setHost: false,
        method,
        path: `${FOLDER_TRANSFER_PREFIX}/${this.route.operationId}/${action}`,
        headers: {
          host: "lan",
          authorization: `Bearer ${this.route.lanToken}`,
          ...(body === undefined
            ? {}
            : { "content-type": "application/json", "content-length": String(body.byteLength) }),
        },
      });
      request.once("error", () => finish(unreachable()));
      request.once("response", (response) => {
        answered = true;
        const parts: Array<Buffer> = [];
        response.on("data", (part: Buffer) => {
          received += part.length;
          // Cut off at the limit; nothing past it is kept.
          if (received > options.maxBytes) return finish(new LanFailure("not_authorization"));
          if (options.onData && response.statusCode === 200) options.onData(part);
          else parts.push(part);
        });
        response.once("end", () => {
          ending = true;
          finish(null, { status: response.statusCode ?? 0, body: Buffer.concat(parts) });
        });
        response.once("error", () => finish(unreachable()));
        response.once("aborted", () => finish(unreachable()));
      });
      request.end(body);
    });
  }

  private async acquire(): Promise<Connection> {
    for (;;) {
      if (this.destroyed) throw unreachable();
      for (const connection of this.connections)
        if (!connection.busy && !connection.socket.destroyed) {
          connection.busy = true;
          return connection;
        }
      if (this.connections.size + this.opening < this.limits.connections) {
        this.opening += 1;
        try {
          return await this.open();
        } finally {
          this.opening -= 1;
        }
      }
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
  }

  private release(connection: Connection) {
    connection.busy = false;
    this.waiting.shift()?.();
  }

  private async exchange(
    method: "GET" | "POST",
    action: string,
    body: Uint8Array | undefined,
    options: Parameters<LanConnector["send"]>[4],
  ): Promise<Answer> {
    const connection = await this.acquire();
    try {
      const answer = await this.send(connection, method, action, body, options);
      // Any redirect is an error; nothing in an answer is ever used as an address.
      if (answer.status !== 200 && answer.status !== 202) throw this.statusFailure(answer);
      return answer;
    } finally {
      this.release(connection);
    }
  }

  /** The manifest, inflated and parsed line by line under the S-8 limits; or its progress. */
  async manifest(
    signal?: AbortSignal,
  ): Promise<
    | { readonly header: ManifestHeader; readonly entries: Array<ManifestEntry> }
    | { readonly progress: { files: number; bytes: number } | null }
  > {
    const lines: Array<unknown> = [];
    let expanded = 0;
    let pending = "";
    let broken: LanFailure | null = null;
    const gunzip = NodeZlib.createGunzip();
    const done = new Promise<void>((resolve) => {
      gunzip.once("end", resolve);
      gunzip.once("close", resolve);
      gunzip.once("error", () => {
        broken ??= new LanFailure("not_authorization");
        resolve();
      });
    });
    const take = (line: string) => {
      if (line.length === 0) return;
      if (lines.length > this.limits.manifestEntries) throw new Error("entries");
      lines.push(JSON.parse(line));
    };
    gunzip.on("data", (part: Buffer) => {
      if (broken) return;
      expanded += part.length;
      try {
        if (expanded > this.limits.manifestExpandedBytes) throw new Error("expanded");
        pending += part.toString("utf8");
        for (let at = pending.indexOf("\n"); at >= 0; at = pending.indexOf("\n")) {
          take(pending.slice(0, at));
          pending = pending.slice(at + 1);
        }
        if (Buffer.byteLength(pending) > this.limits.manifestLineBytes) throw new Error("line");
      } catch {
        broken = new LanFailure("not_authorization");
        gunzip.destroy();
      }
    });
    let wire = 0;
    const answer = await this.exchange("GET", "manifest", undefined, {
      totalMs: this.limits.manifestMs,
      maxBytes: this.limits.manifestWireBytes,
      progress: true,
      signal,
      onData: (part) => {
        wire += part.length;
        if (!broken && !gunzip.destroyed) gunzip.write(part);
      },
    }).catch((cause: unknown) => {
      gunzip.destroy();
      throw cause;
    });
    if (answer.status === 202) {
      gunzip.destroy();
      if (answer.body.length > this.limits.smallAnswerBytes)
        throw new LanFailure("not_authorization");
      try {
        const body = JSON.parse(answer.body.toString("utf8")) as {
          progress?: { files: number; bytes: number } | null;
        };
        return { progress: body.progress ?? null };
      } catch {
        throw new LanFailure("not_authorization");
      }
    }
    if (!gunzip.destroyed) gunzip.end();
    await done;
    if (broken) throw broken;
    try {
      take(pending);
    } catch {
      throw new LanFailure("not_authorization");
    }
    const [header, ...entries] = lines;
    if (header === undefined) throw new LanFailure("not_authorization");
    this.wireBytes += wire;
    return { header: header as ManifestHeader, entries: entries as Array<ManifestEntry> };
  }

  /** One chunk batch. A frame whose bytes do not match its hash fails the whole path. */
  async chunks(hashes: ReadonlyArray<string>, signal?: AbortSignal): Promise<Array<ChunkFrame>> {
    const body = new TextEncoder().encode(
      JSON.stringify(
        typeof NodeZlib.zstdDecompressSync === "function"
          ? { chunks: hashes, encodings: ["zstd"] }
          : { chunks: hashes },
      ),
    );
    const answer = await this.exchange("POST", "chunks", body, {
      totalMs: this.limits.chunksMs,
      maxBytes: this.limits.chunkWireBytes,
      progress: true,
      signal,
    });
    let frames: Array<ChunkFrame>;
    try {
      frames = decodeFrames(answer.body);
    } catch {
      throw new LanFailure("not_authorization");
    }
    const asked = new Set(hashes);
    for (const frame of frames)
      if (
        !asked.has(frame.sha256) ||
        (frame.data.length > 0 && sha256Hex(frame.data) !== frame.sha256)
      )
        throw new LanFailure("not_authorization");
    this.wireBytes += answer.body.length;
    return frames;
  }
}
