// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - real loopback sockets for the local-network tests.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeTls from "node:tls";

import { createLanCertificate, type LanCertificate } from "./lanCertificate.ts";
import type { LanPolicy } from "./lanInterfaces.ts";
import { LAN_ALPN, LAN_CLIENT_LIMITS, LAN_SOURCE_LIMITS } from "./lanWire.ts";
import { FOLDER_TRANSFER_PREFIX } from "./wire.ts";

/**
 * A policy for tests only: 127.0.0.1 stands for one directly attached private
 * address. The app's own policy (`systemLanPolicy`) never admits loopback, and
 * there is no environment switch that makes it.
 */
export function loopbackPolicy(): LanPolicy & {
  network: string;
  attached: boolean;
  /** Where the route to a peer leaves; changing only this is a route-only change. */
  route: string;
  /** Private literals this policy admits besides loopback. They are never dialled. */
  alsoAdmitted: Array<string>;
  /** How many times the interfaces were listed (a child process in the app's policy). */
  listed: number;
} {
  const policy = {
    network: "test0|127.0.0.1/8",
    attached: true,
    route: "test0",
    alsoAdmitted: [] as Array<string>,
    listed: 0,
    admit: (host: string) => host === "127.0.0.1" || policy.alsoAdmitted.includes(host),
    eligible: async () => {
      policy.listed += 1;
      return policy.attached ? [{ name: "test0", address: "127.0.0.1", prefix: 8 }] : [];
    },
    routeInterface: async () => (policy.attached ? policy.route : null),
    signature: () => policy.network,
  };
  return policy;
}

export const certificate = (role: "source" | "recipient"): LanCertificate =>
  createLanCertificate({
    role,
    ...(role === "source" ? { addresses: ["127.0.0.1"] } : {}),
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 60 * 60_000),
  });

/** Short deadlines for tests; every size and count is the production one. */
export const quickSourceLimits = {
  ...LAN_SOURCE_LIMITS,
  handshakeMs: 400,
  headerMs: 300,
  bodyMs: 400,
  stallMs: 300,
};
export const quickClientLimits = {
  ...LAN_CLIENT_LIMITS,
  connectMs: 400,
  setupMs: 1_000,
  headersMs: 800,
  progressMs: 300,
  manifestMs: 4_000,
  chunksMs: 4_000,
};

export interface RawClient {
  readonly socket: NodeTls.TLSSocket;
  /** True once the TLS handshake finished from this client's side. */
  readonly secure: boolean;
  /** Every decrypted byte the server sent. */
  readonly received: () => Buffer;
  readonly closed: Promise<void>;
  readonly session: () => Buffer | null;
  /** The code of the error that ended the socket, a TLS alert included; null when none. */
  readonly failure: () => string | null;
}

/** A TLS client outside the connector, for peers that must be refused. */
export function rawClient(input: {
  readonly port: number;
  readonly certificate?: LanCertificate | undefined;
  readonly key?: string;
  readonly alpn?: ReadonlyArray<string>;
  readonly session?: Buffer;
  readonly maxVersion?: NodeTls.SecureVersion;
}): Promise<RawClient> {
  return new Promise((resolve) => {
    const parts: Array<Buffer> = [];
    let session: Buffer | null = null;
    let secure = false;
    let socket: NodeTls.TLSSocket;
    const tcp = NodeNet.connect({ host: "127.0.0.1", port: input.port });
    tcp.on("error", () => undefined);
    try {
      socket = NodeTls.connect({
        socket: tcp,
        minVersion: input.maxVersion ?? "TLSv1.3",
        maxVersion: input.maxVersion ?? "TLSv1.3",
        ALPNProtocols: [...(input.alpn ?? [LAN_ALPN])],
        rejectUnauthorized: false,
        ...(input.certificate
          ? { cert: input.certificate.certificatePem, key: input.key ?? input.certificate.keyPem }
          : {}),
        ...(input.session ? { session: input.session } : {}),
      });
    } catch {
      // A certificate that does not belong to the key is refused before a byte is sent.
      tcp.destroy();
      const dead = new NodeTls.TLSSocket(new NodeNet.Socket());
      return resolve({
        socket: dead,
        secure: false,
        received: () => Buffer.alloc(0),
        closed: Promise.resolve(),
        session: () => null,
        failure: () => "ERR_LOCAL_KEY_MISMATCH",
      });
    }
    const closed = new Promise<void>((done) => socket.once("close", () => done()));
    let failure: string | null = null;
    socket.on("error", (cause: NodeJS.ErrnoException) => {
      failure ??= cause.code ?? cause.message;
    });
    socket.on("data", (part: Buffer) => parts.push(part));
    socket.on("session", (value) => {
      session = value;
    });
    const settle = () =>
      resolve({
        socket,
        get secure() {
          return secure;
        },
        received: () => Buffer.concat(parts),
        closed,
        session: () => session,
        failure: () => failure,
      });
    socket.once("secureConnect", () => {
      secure = true;
      settle();
    });
    socket.once("close", settle);
  });
}

export const within = <T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> =>
  Promise.race([
    promise,
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms).unref()),
  ]);

/** One HTTP request written on an open TLS socket, and whatever came back before it closed. */
export async function rawRequest(
  client: RawClient,
  input: {
    readonly method: string;
    readonly path: string;
    readonly token?: string | null;
    readonly body?: string | Buffer;
    readonly headers?: Record<string, string>;
    readonly waitMs?: number;
  },
): Promise<{ readonly status: number | null; readonly text: string }> {
  const body = input.body === undefined ? null : Buffer.from(input.body);
  const before = client.received().length;
  const head =
    `${input.method} ${input.path} HTTP/1.1\r\nhost: lan\r\n` +
    (input.token ? `authorization: Bearer ${input.token}\r\n` : "") +
    Object.entries(input.headers ?? {})
      .map(([name, value]) => `${name}: ${value}\r\n`)
      .join("") +
    (body ? `content-length: ${body.length}\r\n` : "") +
    "\r\n";
  client.socket.write(head);
  if (body) client.socket.write(body);
  const deadline = Date.now() + (input.waitMs ?? 1_500);
  for (;;) {
    const text = client.received().subarray(before).toString("latin1");
    const match = /^HTTP\/1\.1 (\d{3})/.exec(text);
    const split = text.indexOf("\r\n\r\n");
    if (match && split >= 0) {
      const length = Number(/content-length: (\d+)/i.exec(text)?.[1] ?? "0");
      if (text.length - split - 4 >= length)
        return { status: Number(match[1]), text: text.slice(split + 4, split + 4 + length) };
    }
    if (client.socket.destroyed || Date.now() > deadline)
      return { status: match ? Number(match[1]) : null, text };
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export const lanPath = (operationId: string, action: string) =>
  `${FOLDER_TRANSFER_PREFIX}/${operationId}/${action}`;

export interface FakeLanServer {
  readonly port: number;
  /** Decrypted application bytes the server read: zero means no HTTP byte arrived. */
  readonly applicationBytes: () => number;
  readonly handshakes: () => number;
  readonly sockets: () => number;
  /** TCP connections accepted, whether or not a handshake finished. */
  readonly connections: () => number;
  /** `METHOD action` per request, in the order received on each socket. */
  readonly requests: Array<{ socket: number; line: string; authorization: string | null }>;
  readonly close: () => Promise<void>;
}

/**
 * A TLS server on 127.0.0.1 that is not the app's listener: an impostor, or a
 * source that answers what a test tells it to. It counts every decrypted byte.
 */
export async function fakeLanServer(input: {
  readonly certificate: LanCertificate;
  readonly port?: number;
  readonly alpn?: ReadonlyArray<string>;
  readonly handle?: (
    request: NodeHttp.IncomingMessage,
    response: NodeHttp.ServerResponse,
    body: Buffer,
  ) => void | Promise<void>;
  /** Accept TCP and never answer the handshake. */
  readonly silent?: boolean;
}): Promise<FakeLanServer> {
  let bytes = 0;
  let handshakes = 0;
  let seen = 0;
  const open = new Set<NodeNet.Socket>();
  const requests: FakeLanServer["requests"] = [];
  const ids = new WeakMap<object, number>();
  const http = NodeHttp.createServer(async (request, response) => {
    const parts: Array<Buffer> = [];
    for await (const part of request) parts.push(part as Buffer);
    requests.push({
      socket: ids.get(request.socket) ?? -1,
      line: `${request.method} ${(request.url ?? "").split("/").at(-1)}`,
      authorization: request.headers.authorization ?? null,
    });
    if (input.handle) await input.handle(request, response, Buffer.concat(parts));
    else response.writeHead(404).end();
  });
  const server: NodeNet.Server = input.silent
    ? NodeNet.createServer((socket) => {
        open.add(socket);
        socket.on("error", () => undefined);
        socket.on("data", () => undefined);
      })
    : NodeTls.createServer(
        {
          key: input.certificate.keyPem,
          cert: input.certificate.certificatePem,
          minVersion: "TLSv1.3",
          ALPNProtocols: [...(input.alpn ?? [LAN_ALPN])],
          requestCert: true,
          rejectUnauthorized: false,
        },
        (socket) => {
          handshakes += 1;
          seen += 1;
          ids.set(socket, seen);
          socket.on("error", () => undefined);
          socket.prependListener("data", (part: Buffer) => {
            bytes += part.length;
          });
          http.emit("connection", socket);
        },
      );
  let connections = 0;
  server.on("connection", (socket: NodeNet.Socket) => {
    connections += 1;
    open.add(socket);
    socket.on("error", () => undefined);
    socket.once("close", () => open.delete(socket));
  });
  server.on("tlsClientError", () => undefined);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(input.port ?? 0, "127.0.0.1", () => resolve());
  });
  return {
    port: (server.address() as NodeNet.AddressInfo).port,
    applicationBytes: () => bytes,
    handshakes: () => handshakes,
    sockets: () => seen,
    connections: () => connections,
    requests,
    close: () =>
      new Promise((resolve) => {
        for (const socket of open) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
