// @effect-diagnostics globalDate:off nodeBuiltinImport:off globalTimers:off - a TLS listener for one generation of one copy, with its own deadlines.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeTls from "node:tls";

import type { LanCertificate } from "./lanCertificate.ts";
import type { LanInterface } from "./lanInterfaces.ts";
import {
  insidePrefix,
  LAN_ALPN,
  LAN_SOURCE_LIMITS,
  lanTokenMatches,
  sameSha256,
  sha256Of,
  type LanDenial,
  type LanEndCause,
  type LanSourceLimits,
} from "./lanWire.ts";
import { bearerToken } from "./transferGrant.ts";
import { FOLDER_TRANSFER_PREFIX, MAX_BATCH_CHUNKS_LARGE, SHA256 } from "./wire.ts";

/**
 * The source's listener for one generation of one copy (1334 S-2, S-5, S-8, S-9).
 *
 * It is not the app's HTTP router and mounts none of it. It serves three read
 * routes of its own operation and answers nothing else. Order for every
 * accepted socket:
 *
 *  1. Accept: the remote address must be inside the listening interface's own
 *     on-link prefix and the connection budgets must allow it.
 *  2. TLS 1.3 with the recipient's one-time certificate, compared by the
 *     SHA-256 of its DER bytes in constant time. No HTTP parser exists for the
 *     socket until this passes, so a peer without the key gets a failed
 *     handshake and no HTTP response.
 *  3. Request line and headers, within the header size and deadline.
 *  4. Authorization from headers only: route, then token, then a recorded denial.
 *  5. Only then a body reader, capped while streaming.
 *
 * Nothing before step 4 passes counts as use, so an unauthenticated peer never
 * moves the idle timer. Ending the generation destroys every accepted socket,
 * not just the listening ones.
 */
export interface LanServed {
  /** Environment id, operation id, generation, binding and batch limit; nothing else. */
  readonly hello: () => Record<string, unknown>;
  /** The one manifest the control path built for this operation, or its progress. */
  readonly manifest: () => Promise<
    | { readonly ready: true; readonly bytes: Uint8Array }
    | { readonly ready: false; readonly body: unknown }
  >;
  /** Frames for hashes that manifest names; any other hash gets the "unknown" frame, no bytes. */
  readonly chunks: (hashes: ReadonlyArray<string>, zstd: boolean) => Promise<Uint8Array>;
  /** The denial recorded on the operation, if any. Connect reads the same record. */
  readonly denial: () => Promise<LanDenial | null>;
  /** The update hold: the source is about to restart. */
  readonly updating?: () => boolean;
}

/** Budgets shared by every generation on one source, counted per remote address. */
export class LanSourceBudgets {
  readonly limits: LanSourceLimits;
  private readonly now: () => number;
  private readonly handshaking = new Map<string, Set<NodeNet.Socket>>();
  private readonly order: Array<NodeNet.Socket> = [];
  private readonly failures = new Map<string, Array<number>>();
  private readonly blockedUntil = new Map<string, number>();
  chunkReads = 0;

  constructor(limits: LanSourceLimits = LAN_SOURCE_LIMITS, now: () => number = Date.now) {
    this.limits = limits;
    this.now = now;
  }

  blocked(remote: string): boolean {
    const until = this.blockedUntil.get(remote);
    if (until === undefined) return false;
    if (this.now() < until) return true;
    this.blockedUntil.delete(remote);
    return false;
  }

  /** Counts a handshake in progress; false when this address already has its share. */
  begin(remote: string, socket: NodeNet.Socket): boolean {
    const mine = this.handshaking.get(remote) ?? new Set();
    if (mine.size >= this.limits.handshakesPerAddress) return false;
    // When the whole table is full the oldest unfinished handshake gives way.
    if (this.order.length >= this.limits.handshakesTotal) this.order[0]?.destroy();
    mine.add(socket);
    this.handshaking.set(remote, mine);
    this.order.push(socket);
    socket.once("close", () => this.finish(remote, socket));
    return true;
  }

  finish(remote: string, socket: NodeNet.Socket) {
    const mine = this.handshaking.get(remote);
    if (mine?.delete(socket) && mine.size === 0) this.handshaking.delete(remote);
    const at = this.order.indexOf(socket);
    if (at >= 0) this.order.splice(at, 1);
  }

  /** A failed handshake counts against its own address only. */
  failed(remote: string) {
    const now = this.now();
    const recent = (this.failures.get(remote) ?? []).filter((at) => now - at < 60_000);
    recent.push(now);
    this.failures.set(remote, recent);
    if (recent.length >= this.limits.failedHandshakesPerMinute) {
      this.blockedUntil.set(remote, now + this.limits.failedHandshakeBlockMs);
      this.failures.delete(remote);
    }
  }
}

export interface LanListenerStats {
  accepted: number;
  refusedAtAccept: number;
  handshakeFailures: number;
  authenticatedSockets: number;
  /** Requests that reached the route table: only sockets that proved the recipient key. */
  routed: number;
  responses: number;
  bodiesOpened: number;
}

const ROUTE = /^\/([a-f0-9-]{36})\/(hello|manifest|chunks)$/;
const ALLOWED: ReadonlySet<string> = new Set(["GET hello", "GET manifest", "POST chunks"]);

interface Tracked {
  readonly raw: NodeNet.Socket;
  headerTimer: ReturnType<typeof setTimeout> | null;
  busy: boolean;
}

export class LanGenerationListener {
  readonly operationId: string;
  readonly generation: number;
  readonly destinationEnvironmentId: string;
  readonly boundAt: number;
  readonly stats: LanListenerStats = {
    accepted: 0,
    refusedAtAccept: 0,
    handshakeFailures: 0,
    authenticatedSockets: 0,
    routed: 0,
    responses: 0,
    bodiesOpened: 0,
  };

  private readonly limits: LanSourceLimits;
  private readonly budgets: LanSourceBudgets;
  private readonly now: () => number;
  private readonly served: LanServed;
  private readonly recipientCertificateSha256: string;
  private tokenSha256: string;
  private readonly listeners: Array<{ server: NodeNet.Server; host: string; port: number }> = [];
  private readonly sockets = new Map<NodeNet.Socket, Tracked>();
  private readonly authenticated = new Set<NodeTls.TLSSocket>();
  private tls: NodeTls.Server | null;
  private readonly http: NodeHttp.Server;
  private readonly watchdog: ReturnType<typeof setInterval>;
  private lastUsedAt: number;
  private chunkReads = 0;
  private endedFor: LanEndCause | null = null;
  private readonly onEnd: (cause: LanEndCause) => void;

  private constructor(input: {
    readonly operationId: string;
    readonly generation: number;
    readonly destinationEnvironmentId: string;
    readonly certificate: LanCertificate;
    readonly recipientCertificateSha256: string;
    readonly tokenSha256: string;
    readonly served: LanServed;
    readonly budgets: LanSourceBudgets;
    readonly now: () => number;
    readonly onEnd: (cause: LanEndCause) => void;
  }) {
    this.operationId = input.operationId;
    this.generation = input.generation;
    this.destinationEnvironmentId = input.destinationEnvironmentId;
    this.budgets = input.budgets;
    this.limits = input.budgets.limits;
    this.now = input.now;
    this.served = input.served;
    this.recipientCertificateSha256 = input.recipientCertificateSha256;
    this.tokenSha256 = input.tokenSha256;
    this.onEnd = input.onEnd;
    this.boundAt = this.now();
    this.lastUsedAt = this.boundAt;
    this.tls = NodeTls.createServer({
      key: input.certificate.keyPem,
      cert: input.certificate.certificatePem,
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
      ALPNProtocols: [LAN_ALPN],
      // The exact hash is the trust: the certificate is asked for, and compared below.
      requestCert: true,
      rejectUnauthorized: false,
      handshakeTimeout: this.limits.handshakeMs,
      // No stateless tickets; a resumed session is refused in `secured` as well.
      secureOptions: NodeCrypto.constants.SSL_OP_NO_TICKET,
      sessionIdContext: NodeCrypto.randomBytes(16).toString("hex"),
    });
    this.tls.on("secureConnection", (socket) => this.secured(socket));
    this.tls.on("tlsClientError", (_error, socket) => {
      this.handshakeFailed(socket as NodeTls.TLSSocket);
    });
    this.http = NodeHttp.createServer(
      {
        maxHeaderSize: this.limits.headerBytes,
        headersTimeout: this.limits.headerMs,
        requestTimeout: this.limits.headerMs + this.limits.bodyMs,
        keepAliveTimeout: this.limits.idleSocketMs,
      },
      (request, response) => void this.route(request, response),
    );
    // A malformed or oversized request closes the socket; nothing is written back.
    this.http.on("clientError", (_error, socket) => socket.destroy());
    this.watchdog = setInterval(() => this.tick(), 250);
    this.watchdog.unref();
  }

  /** Binds one socket per address, each on a port the operating system assigns. Never a wildcard. */
  static async open(input: {
    readonly operationId: string;
    readonly generation: number;
    readonly destinationEnvironmentId: string;
    readonly interfaces: ReadonlyArray<LanInterface>;
    readonly certificate: LanCertificate;
    readonly recipientCertificateSha256: string;
    readonly tokenSha256: string;
    readonly served: LanServed;
    readonly budgets: LanSourceBudgets;
    readonly now?: () => number;
    readonly onEnd?: (cause: LanEndCause) => void;
  }): Promise<LanGenerationListener> {
    const listener = new LanGenerationListener({
      ...input,
      now: input.now ?? Date.now,
      onEnd: input.onEnd ?? (() => undefined),
    });
    try {
      if (
        input.interfaces.length === 0 ||
        input.interfaces.length > listener.limits.addressesPerOffer
      )
        throw new Error("unbindable");
      for (const entry of input.interfaces) await listener.bind(entry);
    } catch {
      listener.end("shutdown");
      throw new Error("unbindable");
    }
    return listener;
  }

  get addresses(): ReadonlyArray<{ readonly host: string; readonly port: number }> {
    return this.listeners.map(({ host, port }) => ({ host, port }));
  }

  get ended(): LanEndCause | null {
    return this.endedFor;
  }

  /** At most two hours after the bind, whatever the transfer grant allows. */
  get expiresAt(): number {
    return this.boundAt + this.limits.absoluteMs;
  }

  private bind(entry: LanInterface): Promise<void> {
    return new Promise((resolve, reject) => {
      const host = entry.address;
      if (host === "0.0.0.0" || host === "::" || host === "") return reject(new Error("wildcard"));
      const server = NodeNet.createServer({ pauseOnConnect: false }, (socket) =>
        this.accept(entry, socket),
      );
      server.once("error", reject);
      server.listen({ host, port: 0, exclusive: true, ipv6Only: host.includes(":") }, () => {
        server.removeListener("error", reject);
        server.on("error", () => this.end("network_changed"));
        this.listeners.push({ server, host, port: (server.address() as NodeNet.AddressInfo).port });
        resolve();
      });
    });
  }

  private accept(entry: LanInterface, socket: NodeNet.Socket) {
    this.stats.accepted += 1;
    const remote = socket.remoteAddress ?? "";
    socket.on("error", () => undefined);
    if (
      this.endedFor !== null ||
      this.tls === null ||
      !insidePrefix(entry.address, entry.prefix, remote) ||
      this.budgets.blocked(remote) ||
      !this.budgets.begin(remote, socket)
    ) {
      this.stats.refusedAtAccept += 1;
      socket.destroy();
      return;
    }
    this.sockets.set(socket, { raw: socket, headerTimer: null, busy: false });
    socket.once("close", () => {
      const tracked = this.sockets.get(socket);
      if (tracked?.headerTimer) clearTimeout(tracked.headerTimer);
      this.sockets.delete(socket);
    });
    // The TLS server never listens: it only wraps sockets this listener accepted.
    this.tls.emit("connection", socket);
  }

  private rawOf(socket: NodeTls.TLSSocket): NodeNet.Socket | null {
    for (const raw of this.sockets.keys())
      if (
        raw.remotePort === socket.remotePort &&
        raw.remoteAddress === socket.remoteAddress &&
        raw.localPort === socket.localPort
      )
        return raw;
    return null;
  }

  private handshakeFailed(socket: NodeTls.TLSSocket | undefined) {
    this.stats.handshakeFailures += 1;
    const remote = socket?.remoteAddress;
    if (remote) this.budgets.failed(remote);
    socket?.destroy();
  }

  /** The handshake finished. Nothing has parsed a byte of HTTP for this socket yet. */
  private secured(socket: NodeTls.TLSSocket) {
    socket.on("error", () => undefined);
    const raw = this.rawOf(socket);
    const remote = socket.remoteAddress ?? "";
    if (raw) this.budgets.finish(remote, raw);
    const presented = socket.getPeerX509Certificate()?.raw;
    const proven =
      this.endedFor === null &&
      raw !== null &&
      socket.getProtocol() === "TLSv1.3" &&
      socket.alpnProtocol === LAN_ALPN &&
      // A resumed session would skip the proof of the key: every connection is a full handshake.
      !socket.isSessionReused() &&
      presented !== undefined &&
      sameSha256(sha256Of(presented), this.recipientCertificateSha256);
    if (!proven) {
      this.handshakeFailed(socket);
      raw?.destroy();
      return;
    }
    if (this.authenticated.size >= this.limits.authenticatedSockets) {
      socket.destroy();
      raw.destroy();
      return;
    }
    this.authenticated.add(socket);
    this.stats.authenticatedSockets += 1;
    socket.once("close", () => {
      this.authenticated.delete(socket);
      raw.destroy();
    });
    const tracked = this.sockets.get(raw)!;
    const armHeaders = () => {
      if (tracked.busy || tracked.headerTimer) return;
      tracked.headerTimer = setTimeout(() => socket.destroy(), this.limits.headerMs);
    };
    // The first request is due at once; later ones are timed from their first byte.
    armHeaders();
    socket.prependListener("data", armHeaders);
    socket.setTimeout(this.limits.idleSocketMs, () => socket.destroy());
    this.http.emit("connection", socket);
  }

  private answer(
    response: NodeHttp.ServerResponse,
    status: number,
    contentType: string,
    body: Uint8Array,
    close: boolean,
  ) {
    this.stats.responses += 1;
    response.sendDate = false;
    response.writeHead(status, {
      "content-type": contentType,
      "content-length": String(body.byteLength),
      "cache-control": "no-store",
      ...(close ? { connection: "close" } : {}),
    });
    response.end(body);
    const socket = response.socket;
    if (close) response.once("finish", () => socket?.destroy());
    else if (socket) this.watchStall(response, socket);
  }

  /** Closes a response whose peer takes too little for too long. */
  private watchStall(response: NodeHttp.ServerResponse, socket: NodeNet.Socket) {
    let last = socket.bytesWritten;
    const timer = setInterval(() => {
      const written = socket.bytesWritten;
      if (written - last < this.limits.stallBytes) socket.destroy();
      last = written;
    }, this.limits.stallMs);
    timer.unref();
    response.once("close", () => clearInterval(timer));
  }

  private refuse(response: NodeHttp.ServerResponse, status: number, error: string) {
    this.answer(
      response,
      status,
      "application/json",
      new TextEncoder().encode(JSON.stringify({ error })),
      true,
    );
  }

  private async route(request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) {
    const tracked = [...this.sockets.values()].find(
      (entry) =>
        entry.raw.remotePort === request.socket.remotePort &&
        entry.raw.remoteAddress === request.socket.remoteAddress,
    );
    if (tracked) {
      tracked.busy = true;
      if (tracked.headerTimer) clearTimeout(tracked.headerTimer);
      tracked.headerTimer = null;
      response.once("close", () => {
        tracked.busy = false;
      });
    }
    this.stats.routed += 1;
    try {
      if (this.endedFor !== null) return request.socket.destroy();
      // Step 4, from the request line and headers only. No body reader exists yet.
      const path = (request.url ?? "").split("?")[0] ?? "";
      const match = path.startsWith(`${FOLDER_TRANSFER_PREFIX}/`)
        ? ROUTE.exec(path.slice(FOLDER_TRANSFER_PREFIX.length))
        : null;
      const action = match?.[2];
      if (
        !match ||
        (request.url ?? "").includes("?") ||
        match[1] !== this.operationId ||
        !ALLOWED.has(`${request.method} ${action}`)
      )
        return this.refuse(response, 404, "not_found");
      if (!lanTokenMatches(bearerToken(request.headers.authorization), this.tokenSha256))
        return this.refuse(response, 401, "unauthorized");
      const denial = await this.served.denial();
      if (denial !== null) return this.refuse(response, 403, denial);
      if (this.endedFor !== null) return request.socket.destroy();
      // Authenticated use: only now does the idle timer move.
      this.lastUsedAt = this.now();
      if (this.served.updating?.()) return this.refuse(response, 503, "service_updating");
      if (action === "hello")
        return this.answer(
          response,
          200,
          "application/json",
          new TextEncoder().encode(JSON.stringify(this.served.hello())),
          false,
        );
      if (action === "manifest") {
        const result = await this.served.manifest();
        if (this.endedFor !== null) return request.socket.destroy();
        return result.ready
          ? this.answer(response, 200, "application/gzip", result.bytes, false)
          : this.answer(
              response,
              202,
              "application/json",
              new TextEncoder().encode(JSON.stringify(result.body)),
              false,
            );
      }
      const declared = Number(request.headers["content-length"] ?? "0");
      if (!Number.isFinite(declared) || declared > this.limits.bodyBytes)
        return this.refuse(response, 413, "too_large");
      if (
        this.chunkReads >= this.limits.chunkReadsPerOperation ||
        this.budgets.chunkReads >= this.limits.chunkReadsTotal
      )
        return this.refuse(response, 429, "busy");
      this.chunkReads += 1;
      this.budgets.chunkReads += 1;
      try {
        const body = await this.readBody(request);
        if (body === null) return this.refuse(response, 413, "too_large");
        let input: { chunks?: unknown; encodings?: unknown };
        try {
          input = JSON.parse(new TextDecoder().decode(body)) as typeof input;
        } catch {
          return this.refuse(response, 400, "invalid_request");
        }
        const hashes = input?.chunks;
        if (
          !Array.isArray(hashes) ||
          hashes.length > MAX_BATCH_CHUNKS_LARGE ||
          hashes.some((hash) => typeof hash !== "string" || !SHA256.test(hash)) ||
          new Set(hashes).size !== hashes.length
        )
          return this.refuse(response, 400, "invalid_request");
        const zstd = Array.isArray(input.encodings) && input.encodings.includes("zstd");
        const frames = await this.served.chunks(hashes as Array<string>, zstd);
        if (this.endedFor !== null) return request.socket.destroy();
        this.lastUsedAt = this.now();
        return this.answer(response, 200, "application/x-swc-chunks", frames, false);
      } finally {
        this.chunkReads -= 1;
        this.budgets.chunkReads -= 1;
      }
    } catch (cause) {
      const status = (cause as { status?: unknown } | null)?.status;
      if (response.headersSent || this.endedFor !== null) return request.socket.destroy();
      return typeof status === "number" && status >= 400 && status < 500
        ? this.refuse(response, status === 401 || status === 403 ? 409 : status, "refused")
        : this.refuse(response, 500, "internal");
    }
  }

  /** Step 5: a streamed, counted read; null when it passes the cap or the deadline. */
  private readBody(request: NodeHttp.IncomingMessage): Promise<Uint8Array | null> {
    this.stats.bodiesOpened += 1;
    return new Promise((resolve) => {
      const parts: Array<Buffer> = [];
      let size = 0;
      const finish = (value: Uint8Array | null) => {
        clearTimeout(deadline);
        request.removeAllListeners("data");
        resolve(value);
      };
      const deadline = setTimeout(() => finish(null), this.limits.bodyMs);
      request.on("data", (part: Buffer) => {
        size += part.length;
        if (size > this.limits.bodyBytes) return finish(null);
        parts.push(part);
      });
      request.once("end", () => finish(Buffer.concat(parts)));
      request.once("error", () => finish(null));
      request.once("aborted", () => finish(null));
    });
  }

  /** The 15 minute authenticated-idle limit and the 2 hour absolute limit. */
  tick() {
    if (this.endedFor !== null) return;
    const now = this.now();
    if (now - this.boundAt >= this.limits.absoluteMs) this.end("expired");
    else if (now - this.lastUsedAt >= this.limits.idleGenerationMs) this.end("idle");
  }

  /**
   * Ends the generation at once: stops listening, destroys every accepted socket
   * (a response in flight is cut), and drops the key and the token.
   */
  end(cause: LanEndCause) {
    if (this.endedFor !== null) return;
    this.endedFor = cause;
    clearInterval(this.watchdog);
    for (const { server } of this.listeners) server.close();
    for (const socket of this.authenticated) socket.destroy();
    for (const tracked of this.sockets.values()) {
      if (tracked.headerTimer) clearTimeout(tracked.headerTimer);
      tracked.raw.destroy();
    }
    this.authenticated.clear();
    this.sockets.clear();
    this.tls?.removeAllListeners();
    this.tls = null;
    this.tokenSha256 = "";
    this.http.closeAllConnections();
    this.onEnd(cause);
  }
}
