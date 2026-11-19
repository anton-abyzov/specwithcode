// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - the LAN connector against real loopback TLS servers.
import * as NodeCrypto from "node:crypto";
import * as NodeZlib from "node:zlib";
import type * as NodeHttp from "node:http";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  certificate,
  fakeLanServer,
  loopbackPolicy,
  quickClientLimits,
  type FakeLanServer,
} from "./lan.testkit.ts";
import type { LanCertificate } from "./lanCertificate.ts";
import { LanConnector, type LanRoute } from "./lanConnector.ts";
import { LanFailure, mintLanToken, type LanClientLimits } from "./lanWire.ts";
import { CHUNK_OK, encodeFrames, sha256Hex } from "./wire.ts";

const servers: Array<FakeLanServer> = [];
const connectors: Array<LanConnector> = [];
afterEach(async () => {
  for (const connector of connectors.splice(0)) connector.destroy();
  for (const server of servers.splice(0)) await server.close();
});

const operationId = NodeCrypto.randomUUID();
const expected = {
  environmentId: "source-env",
  operationId,
  generation: 7,
  bindingSha256: "b".repeat(64),
};
const token = mintLanToken().token;
const recipient = certificate("recipient");
const manifestLines = [
  { version: 1, operationId, chunkSize: 8, selection: [], repositories: [], entryCount: 1 },
  { path: "README.md", type: "file", size: 5, sha256: "c".repeat(64) },
];
const gzipLines = (lines: ReadonlyArray<unknown>) =>
  NodeZlib.gzipSync(lines.map((line) => JSON.stringify(line)).join("\n") + "\n");

type Handle = (
  request: NodeHttp.IncomingMessage,
  response: NodeHttp.ServerResponse,
  body: Buffer,
) => void;

/** A source that answers hello correctly, then whatever the test gives it. */
const honest =
  (after?: Handle): Handle =>
  (request, response, body) => {
    if (request.url?.endsWith("/hello"))
      return void response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ ...expected, maxBatchChunks: 1024 }));
    if (after) return after(request, response, body);
    if (request.url?.endsWith("/manifest"))
      return void response.writeHead(200).end(gzipLines(manifestLines));
    response.writeHead(404).end();
  };

async function serve(source: LanCertificate, handle: Handle | undefined, port?: number) {
  const server = await fakeLanServer({
    certificate: source,
    ...(handle ? { handle } : {}),
    ...(port === undefined ? {} : { port }),
  });
  servers.push(server);
  return server;
}

function connect(input: {
  readonly ports: ReadonlyArray<number>;
  readonly pin: string;
  readonly limits?: LanClientLimits;
  readonly policy?: ReturnType<typeof loopbackPolicy>;
  readonly host?: string;
}): LanConnector {
  const route: LanRoute = {
    operationId,
    generation: 7,
    addresses: input.ports.map((port) => ({ host: input.host ?? "127.0.0.1", port })),
    sourceCertificateSha256: input.pin,
    lanToken: token,
    recipient,
    expected,
  };
  const connector = new LanConnector(
    route,
    input.policy ?? loopbackPolicy(),
    input.limits ?? quickClientLimits,
  );
  connectors.push(connector);
  return connector;
}

const failure = async (work: Promise<unknown>): Promise<LanFailure> => {
  const cause = await work.then(
    () => null,
    (error: unknown) => error,
  );
  expect(cause).toBeInstanceOf(LanFailure);
  return cause as LanFailure;
};

describe("the pin is checked before any HTTP byte (AC-08, AC-20)", () => {
  it("sends an impostor nothing: first connection, retries, every request kind", async () => {
    const real = certificate("source");
    // The impostor answers hello with the right environment id, if anyone ever asks.
    const impostor = await serve(certificate("source"), honest());
    const connector = connect({ ports: [impostor.port], pin: real.sha256 });
    for (const attempt of [
      () => connector.manifest(),
      () => connector.chunks(["a".repeat(64)]),
      () => connector.manifest(),
    ]) {
      const refused = await failure(attempt());
      expect(refused.kind).toBe("wrong_pin");
      expect(refused.stops).toBe(false);
    }
    expect(impostor.connections()).toBe(3);
    expect(impostor.applicationBytes()).toBe(0);
    expect(impostor.requests).toEqual([]);
    expect(connector.stats).toMatchObject({ handshakes: 3, pinFailures: 3, requests: 0 });
  });

  it("checks the pin again on a keepalive reconnect", async () => {
    const real = certificate("source");
    const source = await serve(real, honest());
    const connector = connect({ ports: [source.port], pin: real.sha256 });
    expect("entries" in (await connector.manifest())).toBe(true);
    expect(source.requests.map((request) => request.line)).toEqual(["GET hello", "GET manifest"]);
    // The source goes away and an impostor takes its port; the pooled socket is dead.
    await source.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const impostor = await serve(certificate("source"), honest(), source.port);
    const refused = await failure(connector.manifest());
    expect(refused.kind).toBe("wrong_pin");
    expect(impostor.connections()).toBe(1);
    expect(connector.stats.pinFailures).toBe(1);
    expect(impostor.applicationBytes()).toBe(0);
  });

  it("puts hello first on every connection and keeps to four connections", async () => {
    const real = certificate("source");
    const data = Buffer.from("hello");
    const frames = encodeFrames([{ sha256: sha256Hex(data), status: CHUNK_OK, data }]);
    const source = await serve(
      real,
      honest(async (_request, response) => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        response.writeHead(200).end(frames);
      }),
    );
    const connector = connect({ ports: [source.port], pin: real.sha256 });
    const answers = await Promise.all(
      Array.from({ length: 10 }, () => connector.chunks([sha256Hex(data)])),
    );
    expect(answers.every((answer) => answer[0]!.data.equals(data))).toBe(true);
    expect(source.sockets()).toBe(4);
    for (const id of new Set(source.requests.map((request) => request.socket)))
      expect(source.requests.find((request) => request.socket === id)!.line).toBe("GET hello");
    expect(source.requests.filter((request) => request.line === "GET hello")).toHaveLength(4);
    expect(source.requests.every((request) => request.authorization === `Bearer ${token}`)).toBe(
      true,
    );
  });

  it("ignores proxy settings and never dials an address that is not admitted or attached", async () => {
    const real = certificate("source");
    const source = await serve(real, honest());
    const saved = { ...process.env };
    Object.assign(process.env, {
      HTTP_PROXY: "http://127.0.0.1:9",
      HTTPS_PROXY: "http://127.0.0.1:9",
      ALL_PROXY: "http://127.0.0.1:9",
      NODE_USE_ENV_PROXY: "1",
    });
    try {
      const connector = connect({ ports: [source.port], pin: real.sha256 });
      expect("entries" in (await connector.manifest())).toBe(true);
    } finally {
      for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NODE_USE_ENV_PROXY"])
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
    }
    const sockets = source.sockets();
    const detached = loopbackPolicy();
    detached.attached = false;
    expect(
      (
        await failure(
          connect({ ports: [source.port], pin: real.sha256, policy: detached }).manifest(),
        )
      ).kind,
    ).toBe("unreachable");
    expect(
      (
        await failure(
          connect({ ports: [source.port], pin: real.sha256, host: "localhost" }).manifest(),
        )
      ).kind,
    ).toBe("unreachable");
    expect(source.sockets()).toBe(sockets);
  });
});

describe("the fallback table, on real sockets (AC-02, AC-11, AC-21)", () => {
  it("calls a hello for another environment, operation, generation or binding a wrong identity", async () => {
    const real = certificate("source");
    for (const wrong of [
      { environmentId: "other-env" },
      { operationId: NodeCrypto.randomUUID() },
      { generation: 6 },
      { bindingSha256: "d".repeat(64) },
    ]) {
      const source = await serve(real, (request, response) => {
        if (request.url?.endsWith("/hello"))
          return void response.writeHead(200).end(JSON.stringify({ ...expected, ...wrong }));
        response.writeHead(200).end(gzipLines(manifestLines));
      });
      const refused = await failure(connect({ ports: [source.port], pin: real.sha256 }).manifest());
      expect([Object.keys(wrong)[0], refused.kind, refused.stops]).toEqual([
        Object.keys(wrong)[0],
        "wrong_identity",
        false,
      ]);
      // Nothing was asked of it after the hello.
      expect(source.requests.map((request) => request.line)).toEqual(["GET hello"]);
    }
  });

  it("stops on an authenticated denial and switches on every other status", async () => {
    const real = certificate("source");
    const rows: Array<[number, unknown, boolean, string | null]> = [
      [403, { error: "revoked" }, true, "revoked"],
      [403, { error: "refused" }, true, "refused"],
      [403, { error: "scope_changed" }, true, "scope_changed"],
      [403, { error: "anything" }, true, "unauthorized"],
      [401, { error: "unauthorized" }, true, "unauthorized"],
      [400, {}, false, null],
      [404, {}, false, null],
      [413, {}, false, null],
      [429, {}, false, null],
      [500, {}, false, null],
      [503, { error: "service_updating" }, false, null],
      [302, {}, false, null],
      [307, {}, false, null],
    ];
    for (const [status, body, stops, denial] of rows) {
      const elsewhere = await serve(real, honest());
      const source = await serve(
        real,
        honest(
          (_request, response) =>
            void response
              .writeHead(status, { location: `https://127.0.0.1:${elsewhere.port}/` })
              .end(JSON.stringify(body)),
        ),
      );
      const refused = await failure(connect({ ports: [source.port], pin: real.sha256 }).manifest());
      expect([status, refused.stops, refused.denial]).toEqual([status, stops, denial]);
      // A redirect is never followed: the other server saw no connection.
      expect(elsewhere.sockets()).toBe(0);
    }
  });

  it("is unreachable within its deadlines: refused, silent, wrong protocol, stalled", async () => {
    const real = certificate("source");
    const gone = await serve(real, honest());
    await gone.close();
    const started = Date.now();
    expect((await failure(connect({ ports: [gone.port], pin: real.sha256 }).manifest())).kind).toBe(
      "unreachable",
    );
    const silent = await fakeLanServer({ certificate: real, silent: true });
    servers.push(silent);
    expect(
      (await failure(connect({ ports: [silent.port], pin: real.sha256 }).manifest())).kind,
    ).toBe("unreachable");
    expect(Date.now() - started).toBeLessThan(quickClientLimits.setupMs + 1_500);

    const otherProtocol = await fakeLanServer({ certificate: real, alpn: ["http/1.1"] });
    servers.push(otherProtocol);
    expect(
      (await failure(connect({ ports: [otherProtocol.port], pin: real.sha256 }).manifest())).kind,
    ).toBe("unreachable");
    expect(otherProtocol.applicationBytes()).toBe(0);

    // Headers arrive, then the body trickles: the progress deadline ends it.
    const trickle = await serve(
      real,
      honest((_request, response) => {
        response.writeHead(200);
        response.write(gzipLines(manifestLines).subarray(0, 4));
      }),
    );
    const stalledAt = Date.now();
    expect(
      (await failure(connect({ ports: [trickle.port], pin: real.sha256 }).manifest())).kind,
    ).toBe("unreachable");
    expect(Date.now() - stalledAt).toBeLessThan(quickClientLimits.progressMs * 3 + 1_000);

    // No answer at all to a request: the header deadline.
    const mute = await serve(
      real,
      honest(() => undefined),
    );
    expect((await failure(connect({ ports: [mute.port], pin: real.sha256 }).manifest())).kind).toBe(
      "unreachable",
    );
  });

  it("tries the offered addresses in order and uses the first that is the source", async () => {
    const real = certificate("source");
    const gone = await serve(real, honest());
    await gone.close();
    const source = await serve(real, honest());
    const connector = connect({ ports: [gone.port, source.port], pin: real.sha256 });
    expect("entries" in (await connector.manifest())).toBe(true);
  });
});

describe("streamed, counted reads (AC-29)", () => {
  const withLimits = (limits: Partial<LanClientLimits>) => ({ ...quickClientLimits, ...limits });

  it("reads a manifest line by line and reports its progress answer", async () => {
    const real = certificate("source");
    let ready = false;
    const source = await serve(
      real,
      honest((_request, response) => {
        if (!ready) {
          ready = true;
          return void response
            .writeHead(202)
            .end(JSON.stringify({ progress: { files: 3, bytes: 9 } }));
        }
        response.writeHead(200).end(gzipLines(manifestLines));
      }),
    );
    const connector = connect({ ports: [source.port], pin: real.sha256 });
    expect(await connector.manifest()).toEqual({ progress: { files: 3, bytes: 9 } });
    const manifest = await connector.manifest();
    expect("entries" in manifest && manifest.entries).toEqual([manifestLines[1]]);
    expect(connector.wireBytes).toBe(gzipLines(manifestLines).length);
  });

  it("cuts off an oversized or highly compressed manifest at each limit", async () => {
    const real = certificate("source");
    const bomb = gzipLines([manifestLines[0], { path: "x".repeat(4_000_000), type: "file" }]);
    const many = gzipLines([
      manifestLines[0],
      ...Array.from({ length: 50 }, () => manifestLines[1]),
    ]);
    const noise = NodeCrypto.randomBytes(200_000);
    const cases: Array<[string, Buffer, Partial<LanClientLimits>]> = [
      ["wire bytes", noise, { manifestWireBytes: 100_000 }],
      ["expanded bytes", bomb, { manifestExpandedBytes: 1_000_000, manifestLineBytes: 8_000_000 }],
      ["line length", bomb, { manifestLineBytes: 64 * 1024 }],
      ["entries", many, { manifestEntries: 10 }],
      ["not gzip", noise, {}],
      ["not JSON", NodeZlib.gzipSync("{broken\n"), {}],
    ];
    for (const [name, body, limits] of cases) {
      const source = await serve(
        real,
        honest((_request, response) => void response.writeHead(200).end(body)),
      );
      const connector = connect({
        ports: [source.port],
        pin: real.sha256,
        limits: withLimits(limits),
      });
      const refused = await failure(connector.manifest());
      expect([name, refused.kind, refused.stops]).toEqual([name, "not_authorization", false]);
      expect(connector.wireBytes).toBe(0);
    }
    // The bomb is small on the wire: the limit is on what it expands to.
    expect(bomb.length).toBeLessThan(100_000);
  });

  it("refuses a chunk batch over its limit, a frame nobody asked for and a frame with wrong bytes", async () => {
    const real = certificate("source");
    const data = Buffer.from("chunk bytes");
    const sha = sha256Hex(data);
    const cases: Array<[string, Buffer, Partial<LanClientLimits>]> = [
      ["wire bytes", NodeCrypto.randomBytes(200_000), { chunkWireBytes: 100_000 }],
      [
        "wrong bytes",
        encodeFrames([{ sha256: sha, status: CHUNK_OK, data: Buffer.from("other") }]),
        {},
      ],
      [
        "unasked frame",
        encodeFrames([{ sha256: "e".repeat(64), status: CHUNK_OK, data: Buffer.alloc(0) }]),
        {},
      ],
      ["bad frame", NodeZlib.gzipSync(Buffer.from("short")), {}],
    ];
    for (const [name, body, limits] of cases) {
      const source = await serve(
        real,
        honest((_request, response) => void response.writeHead(200).end(body)),
      );
      const connector = connect({
        ports: [source.port],
        pin: real.sha256,
        limits: withLimits(limits),
      });
      const refused = await failure(connector.chunks([sha]));
      expect([name, refused.kind]).toEqual([name, "not_authorization"]);
    }
    const good = await serve(
      real,
      honest((_request, response, body) => {
        expect(JSON.parse(body.toString("utf8")).chunks).toEqual([sha]);
        response.writeHead(200).end(encodeFrames([{ sha256: sha, status: CHUNK_OK, data }]));
      }),
    );
    const frames = await connect({ ports: [good.port], pin: real.sha256 }).chunks([sha]);
    expect(frames[0]!.data.equals(data)).toBe(true);
  });

  it("names no address, hash or token in a failure", async () => {
    const real = certificate("source");
    const impostor = await serve(certificate("source"), honest());
    const refused = await failure(connect({ ports: [impostor.port], pin: real.sha256 }).manifest());
    const text = `${refused.message} ${refused.stack ?? ""} ${JSON.stringify(refused)}`;
    for (const secret of ["127.0.0.1", String(impostor.port), real.sha256, recipient.sha256, token])
      expect(text).not.toContain(secret);
    expect(refused.message).toBe("wrong_pin");
  });
});
