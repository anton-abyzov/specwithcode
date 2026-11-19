// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - the LAN listener on real loopback sockets.
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import * as NodeTls from "node:tls";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  certificate,
  lanPath,
  quickSourceLimits,
  rawClient,
  rawRequest,
  within,
} from "./lan.testkit.ts";
import type { LanCertificate } from "./lanCertificate.ts";
import { LanGenerationListener, LanSourceBudgets, type LanServed } from "./lanListener.ts";
import {
  admitLanHost,
  insidePrefix,
  LAN_ALPN,
  LAN_CLIENT_LIMITS,
  LAN_SOURCE_LIMITS,
  lanBindingSha256,
  lanScopeSha256,
  lanTargetSha256,
  mintLanToken,
  type LanDenial,
  type LanSourceLimits,
} from "./lanWire.ts";
import { FOLDER_TRANSFER_PREFIX } from "./wire.ts";

const LOOPBACK = { name: "test0", address: "127.0.0.1", prefix: 8 };

interface Rig {
  readonly operationId: string;
  readonly listener: LanGenerationListener;
  readonly source: LanCertificate;
  readonly recipient: LanCertificate;
  readonly token: string;
  readonly port: number;
  readonly calls: Array<string>;
  readonly budgets: LanSourceBudgets;
  clock: number;
  denial: LanDenial | null;
  manifest: () => Promise<{ ready: true; bytes: Uint8Array } | { ready: false; body: unknown }>;
  chunks: (hashes: ReadonlyArray<string>) => Promise<Uint8Array>;
}

const rigs: Array<Rig> = [];
afterEach(() => {
  for (const rig of rigs.splice(0)) rig.listener.end("shutdown");
});

async function rig(
  options: { limits?: LanSourceLimits; budgets?: LanSourceBudgets } = {},
): Promise<Rig> {
  const source = certificate("source");
  const recipient = certificate("recipient");
  const minted = mintLanToken();
  const operationId = NodeCrypto.randomUUID();
  const state = {
    clock: 1_000_000,
    denial: null as LanDenial | null,
    manifest: async () => ({ ready: true as const, bytes: new TextEncoder().encode("manifest") }),
    chunks: async (_hashes: ReadonlyArray<string>) => new TextEncoder().encode("frames"),
  };
  const calls: Array<string> = [];
  const budgets =
    options.budgets ?? new LanSourceBudgets(options.limits ?? quickSourceLimits, () => state.clock);
  const served: LanServed = {
    hello: () => {
      calls.push("hello");
      return { environmentId: "source-env", operationId, generation: 1, bindingSha256: "b" };
    },
    manifest: () => {
      calls.push("manifest");
      return state.manifest();
    },
    chunks: (hashes) => {
      calls.push(`chunks:${hashes.length}`);
      return state.chunks(hashes);
    },
    denial: async () => state.denial,
  };
  const listener = await LanGenerationListener.open({
    operationId,
    generation: 1,
    destinationEnvironmentId: "destination-env",
    interfaces: [LOOPBACK],
    certificate: source,
    recipientCertificateSha256: recipient.sha256,
    recipientCertificatePem: recipient.certificatePem,
    tokenSha256: minted.sha256,
    served,
    budgets,
    now: () => state.clock,
  } as never);
  const built: Rig = Object.assign(state, {
    operationId,
    listener,
    source,
    recipient,
    token: minted.token,
    port: listener.addresses[0]!.port,
    calls,
    budgets,
  });
  rigs.push(built);
  return built;
}

const proven = (r: Rig) => rawClient({ port: r.port, certificate: r.recipient });

describe("address admission (AC-12)", () => {
  it("admits RFC 1918 and unique local literals only", () => {
    for (const host of [
      "10.0.0.1",
      "172.16.0.1",
      "172.31.255.254",
      "192.168.1.20",
      "fd00::1",
      "fc00::5",
    ])
      expect(admitLanHost(host), host).toBe(true);
    for (const host of [
      "172.15.0.1",
      "172.32.0.1",
      "100.64.0.1",
      "169.254.1.1",
      "fe80::1%en0",
      "fe80::1",
      "::ffff:192.168.0.1",
      "2001:db8::1",
      "127.0.0.1",
      "0.0.0.0",
      "::",
      "::1",
      "192.168.001.1",
      "192.168.1",
      "localhost",
      "printer.local",
      "192.168.1.1.example.com",
      "[fd00::1]",
      "",
    ])
      expect(admitLanHost(host), host).toBe(false);
  });

  it("knows which addresses are inside an interface's own prefix", () => {
    expect(insidePrefix("192.168.1.10", 24, "192.168.1.77")).toBe(true);
    expect(insidePrefix("192.168.1.10", 24, "192.168.2.77")).toBe(false);
    expect(insidePrefix("10.1.2.3", 8, "10.200.0.1")).toBe(true);
    expect(insidePrefix("fd00:1::5", 64, "fd00:1::9")).toBe(true);
    expect(insidePrefix("fd00:1::5", 64, "fd00:2::9")).toBe(false);
    expect(insidePrefix("192.168.1.10", 24, "fd00::1")).toBe(false);
  });

  it("binds each address on its own socket with an assigned port, never a wildcard", async () => {
    const r = await rig();
    expect(r.listener.addresses).toEqual([{ host: "127.0.0.1", port: r.port }]);
    expect(r.port).toBeGreaterThan(1023);
    for (const address of ["0.0.0.0", "::"])
      await expect(
        LanGenerationListener.open({
          operationId: r.operationId,
          generation: 2,
          destinationEnvironmentId: "destination-env",
          interfaces: [{ name: "any", address, prefix: 0 }],
          certificate: r.source,
          recipientCertificateSha256: r.recipient.sha256,
          recipientCertificatePem: r.recipient.certificatePem,
          tokenSha256: "0".repeat(64),
          served: {} as LanServed,
          budgets: r.budgets,
        } as never),
      ).rejects.toThrow("unbindable");
  });
});

describe("the numeric budgets are the design's (S-8)", () => {
  it("keeps the source and client limits at their written values", () => {
    expect(LAN_SOURCE_LIMITS).toEqual({
      liveGenerations: 4,
      liveGenerationsPerDestination: 2,
      generationsPerOperationPerHour: 6,
      addressesPerOffer: 4,
      handshakesPerAddress: 2,
      handshakesTotal: 16,
      failedHandshakesPerMinute: 10,
      failedHandshakeBlockMs: 60_000,
      authenticatedSockets: 4,
      chunkReadsPerOperation: 4,
      chunkReadsTotal: 8,
      handshakeMs: 5_000,
      headerBytes: 8_192,
      headerMs: 2_000,
      bodyBytes: 131_072,
      bodyMs: 10_000,
      stallBytes: 65_536,
      stallMs: 30_000,
      idleSocketMs: 60_000,
      idleGenerationMs: 900_000,
      absoluteMs: 7_200_000,
    });
    expect(LAN_CLIENT_LIMITS).toMatchObject({
      connectMs: 1_500,
      setupMs: 5_000,
      headersMs: 10_000,
      progressBytes: 262_144,
      progressMs: 15_000,
      manifestMs: 600_000,
      chunksMs: 300_000,
      connections: 4,
      chunkWireBytes: 65 * 1024 * 1024,
      chunkExpandedBytes: 65 * 1024 * 1024,
      manifestWireBytes: 256 * 1024 * 1024,
      manifestExpandedBytes: 2 * 1024 * 1024 * 1024,
      manifestEntries: 2_000_000,
      manifestLineBytes: 65_536,
      smallAnswerBytes: 16_384,
    });
    expect(LAN_CLIENT_LIMITS.idleGenerationMs).toBeLessThan(LAN_SOURCE_LIMITS.idleGenerationMs);
  });
});

describe("recipient proof of possession (AC-03, AC-17)", () => {
  it("serves the three routes to the recipient certificate with the LAN token", async () => {
    const r = await rig();
    const client = await proven(r);
    const hello = await rawRequest(client, {
      method: "GET",
      path: lanPath(r.operationId, "hello"),
      token: r.token,
    });
    expect(hello.status).toBe(200);
    expect(Object.keys(JSON.parse(hello.text)).sort()).toEqual([
      "bindingSha256",
      "environmentId",
      "generation",
      "operationId",
    ]);
    const manifest = await rawRequest(client, {
      method: "GET",
      path: lanPath(r.operationId, "manifest"),
      token: r.token,
    });
    expect([manifest.status, manifest.text]).toEqual([200, "manifest"]);
    const chunks = await rawRequest(client, {
      method: "POST",
      path: lanPath(r.operationId, "chunks"),
      token: r.token,
      body: JSON.stringify({ chunks: ["a".repeat(64)] }),
    });
    expect([chunks.status, chunks.text]).toEqual([200, "frames"]);
    expect(r.calls).toEqual(["hello", "manifest", "chunks:1"]);
    // No header names the machine or the server software.
    const raw = client.received().toString("latin1").toLowerCase();
    for (const header of ["server:", "access-control", "x-powered-by", "date:"])
      expect(raw).not.toContain(header);
    client.socket.destroy();
  });

  it.each([
    ["no certificate", (_: Rig) => undefined],
    ["another certificate", (_: Rig) => certificate("recipient")],
    ["the source's own certificate", (r: Rig) => r.source],
  ])("gives %s no HTTP response, with the right token", async (_name, pick) => {
    const r = await rig();
    const client = await rawClient({ port: r.port, certificate: pick(r) });
    const answer = await rawRequest(client, {
      method: "GET",
      path: lanPath(r.operationId, "hello"),
      token: r.token,
      waitMs: 700,
    });
    await within(client.closed, 1_000);
    expect(answer.status).toBeNull();
    expect(client.received().length).toBe(0);
    expect(client.socket.destroyed).toBe(true);
    // The route table never ran and nothing was read as a request.
    expect(r.listener.stats).toMatchObject({ routed: 0, responses: 0, bodiesOpened: 0 });
    expect(r.calls).toEqual([]);
  });

  it("refuses the right certificate without its key before a byte is sent", async () => {
    const r = await rig();
    const client = await rawClient({
      port: r.port,
      certificate: r.recipient,
      key: certificate("recipient").keyPem,
    });
    const answer = await rawRequest(client, {
      method: "GET",
      path: lanPath(r.operationId, "hello"),
      token: r.token,
      waitMs: 500,
    });
    expect(client.secure).toBe(false);
    expect(answer.status).toBeNull();
    expect(r.listener.stats).toMatchObject({ routed: 0, responses: 0, authenticatedSockets: 0 });
  });

  it("refuses another protocol name and TLS 1.2", async () => {
    const r = await rig();
    for (const client of [
      await rawClient({ port: r.port, certificate: r.recipient, alpn: ["http/1.1"] }),
      await rawClient({ port: r.port, certificate: r.recipient, maxVersion: "TLSv1.2" }),
    ]) {
      const answer = await rawRequest(client, {
        method: "GET",
        path: lanPath(r.operationId, "hello"),
        token: r.token,
        waitMs: 500,
      });
      expect(answer.status).toBeNull();
    }
    expect(r.listener.stats).toMatchObject({ routed: 0, responses: 0 });
  });

  it("refuses a client with no certificate inside the handshake", async () => {
    const r = await rig();
    const client = await rawClient({ port: r.port });
    client.socket.write(`GET ${lanPath(r.operationId, "hello")} HTTP/1.1\r\nhost: lan\r\n\r\n`);
    await within(client.closed, 2_000);
    // The TLS layer says why: the alert, not a socket that was closed after the fact.
    expect(client.failure()).toBe("ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED");
    expect(client.received()).toHaveLength(0);
    expect(r.listener.stats).toMatchObject({
      secureConnections: 0,
      authenticatedSockets: 0,
      parserSockets: 0,
      routed: 0,
      responses: 0,
    });
  });

  it("never lets another certificate reach the secure connection, the parser or a byte", async () => {
    const r = await rig();
    // A well-formed recipient certificate of another generation, with its own key.
    const client = await rawClient({ port: r.port, certificate: certificate("recipient") });
    const answer = await rawRequest(client, {
      method: "GET",
      path: lanPath(r.operationId, "hello"),
      token: r.token,
      waitMs: 500,
    });
    await within(client.closed, 2_000);
    expect(answer.status).toBeNull();
    expect(client.received()).toHaveLength(0);
    // Server side: the handshake was rejected by the TLS layer, before any of this code ran.
    expect(r.listener.stats).toMatchObject({
      handshakeFailures: 1,
      secureConnections: 0,
      authenticatedSockets: 0,
      // No socket of this peer was ever given to the HTTP parser, the only reader there is.
      parserSockets: 0,
      routed: 0,
      responses: 0,
      bodiesOpened: 0,
    });
    expect(r.calls).toEqual([]);
  });

  it("opens only with the certificate whose hash is pinned as its one trust anchor", async () => {
    const r = await rig();
    await expect(
      LanGenerationListener.open({
        operationId: r.operationId,
        generation: 2,
        destinationEnvironmentId: "destination-env",
        interfaces: [LOOPBACK],
        certificate: r.source,
        recipientCertificateSha256: r.recipient.sha256,
        recipientCertificatePem: certificate("recipient").certificatePem,
        tokenSha256: "0".repeat(64),
        served: {} as LanServed,
        budgets: r.budgets,
      } as never).then((listener) => {
        listener.end("shutdown");
        return "opened";
      }),
    ).rejects.toThrow();
  });

  it("issues tickets and never honours one: a resumed client gets a full handshake", async () => {
    const r = await rig();
    const first = await proven(r);
    await rawRequest(first, {
      method: "GET",
      path: lanPath(r.operationId, "hello"),
      token: r.token,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const session = first.session();
    // TLS 1.3 under Node always sends a ticket; this is a real one from this listener.
    expect(session).not.toBeNull();
    first.socket.destroy();
    const again = await rawClient({ port: r.port, certificate: r.recipient, session: session! });
    const answer = await rawRequest(again, {
      method: "GET",
      path: lanPath(r.operationId, "hello"),
      token: r.token,
      waitMs: 700,
    });
    // Both ends ran the whole handshake again, certificate and key proof included.
    expect(again.socket.isSessionReused()).toBe(false);
    expect(answer.status).toBe(200);
    expect(r.listener.stats).toMatchObject({ secureConnections: 2, authenticatedSockets: 2 });
    again.socket.destroy();
  });

  it("answers a wrong or missing token 401 and closes, without moving the idle timer (AC-27)", async () => {
    const r = await rig();
    r.clock += LAN_SOURCE_LIMITS.idleGenerationMs - 1_000;
    for (const token of [null, mintLanToken().token, "swcft_transfer-token"]) {
      const client = await proven(r);
      const answer = await rawRequest(client, {
        method: "POST",
        path: lanPath(r.operationId, "chunks"),
        token,
        body: JSON.stringify({ chunks: [] }),
      });
      expect(answer.status).toBe(401);
      await within(client.closed, 1_000);
      expect(client.socket.destroyed).toBe(true);
    }
    expect(r.listener.stats.bodiesOpened).toBe(0);
    expect(r.calls).toEqual([]);
    // The refused requests were not use: the generation still ends on its idle limit.
    r.clock += 1_000;
    r.listener.tick();
    expect(r.listener.ended).toBe("idle");
  });
});

describe("three read routes and nothing else (AC-10, AC-13, AC-23)", () => {
  it("answers every other method and route 404 before reading a body", async () => {
    const r = await rig();
    const refused: Array<[string, string]> = [
      ["POST", "manifest"],
      ["POST", "validate"],
      ["POST", "stat"],
      ["POST", "refresh"],
      ["POST", "ancestry"],
      ["GET", "secrets"],
      ["POST", "secret"],
      ["POST", "release"],
      ["POST", "commit"],
      ["POST", "hello"],
      ["GET", "chunks"],
      ["PUT", "manifest"],
      ["DELETE", "hello"],
    ];
    for (const [method, action] of refused) {
      const client = await proven(r);
      const answer = await rawRequest(client, {
        method,
        path: lanPath(r.operationId, action),
        token: r.token,
        ...(method === "GET"
          ? {}
          : { body: JSON.stringify({ path: "/etc/passwd", paths: ["x"] }) }),
      });
      expect([method, action, answer.status, answer.text]).toEqual([
        method,
        action,
        404,
        '{"error":"not_found"}',
      ]);
      await within(client.closed, 1_000);
    }
    for (const path of [
      "/.well-known/studio/environment",
      "/",
      `${FOLDER_TRANSFER_PREFIX}/${NodeCrypto.randomUUID()}/hello`,
      `${lanPath(r.operationId, "hello")}?next=1`,
      `/api/folder-transfer/v2/${r.operationId}/hello`,
    ]) {
      const client = await proven(r);
      const answer = await rawRequest(client, { method: "GET", path, token: r.token });
      expect([path, answer.status]).toEqual([path, 404]);
    }
    expect(r.listener.stats.bodiesOpened).toBe(0);
    expect(r.calls).toEqual([]);
  });

  it("takes only hashes: a request can name no path", async () => {
    const r = await rig();
    const seen: Array<ReadonlyArray<string>> = [];
    r.chunks = async (hashes) => {
      seen.push(hashes);
      return new Uint8Array();
    };
    for (const body of [
      { chunks: ["../../etc/passwd"] },
      { chunks: ["a".repeat(64)], path: "/etc/passwd" },
      { chunks: ["a".repeat(64), "a".repeat(64)] },
      { paths: ["README.md"] },
      { chunks: "a".repeat(64) },
    ]) {
      const client = await proven(r);
      const answer = await rawRequest(client, {
        method: "POST",
        path: lanPath(r.operationId, "chunks"),
        token: r.token,
        body: JSON.stringify(body),
      });
      if ("path" in body) expect(answer.status).toBe(200);
      else expect(answer.status).toBe(400);
      client.socket.destroy();
    }
    // The one accepted request reached the service as hashes alone.
    expect(seen).toEqual([["a".repeat(64)]]);
  });

  it("answers a recorded denial 403 with its reason and closes", async () => {
    const r = await rig();
    for (const denial of ["revoked", "refused", "scope_changed"] as const) {
      r.denial = denial;
      const client = await proven(r);
      const answer = await rawRequest(client, {
        method: "GET",
        path: lanPath(r.operationId, "manifest"),
        token: r.token,
      });
      expect([answer.status, answer.text]).toEqual([403, JSON.stringify({ error: denial })]);
      await within(client.closed, 1_000);
    }
    expect(r.calls).toEqual([]);
  });
});

describe("one listener per copy (AC-18)", () => {
  it("reads nothing with another copy's certificate or token", async () => {
    const a = await rig();
    const b = await rig();
    // A's certificate and token against B's listener: no handshake that serves.
    const crossed = await rawClient({ port: b.port, certificate: a.recipient });
    const first = await rawRequest(crossed, {
      method: "GET",
      path: lanPath(b.operationId, "manifest"),
      token: a.token,
      waitMs: 600,
    });
    expect(first.status).toBeNull();
    // B's certificate with A's token: authenticated, and refused.
    const mixed = await proven(b);
    const second = await rawRequest(mixed, {
      method: "GET",
      path: lanPath(b.operationId, "manifest"),
      token: a.token,
    });
    expect(second.status).toBe(401);
    // B's certificate and token asking for A's operation on B's listener.
    const other = await proven(b);
    const third = await rawRequest(other, {
      method: "GET",
      path: lanPath(a.operationId, "manifest"),
      token: b.token,
    });
    expect(third.status).toBe(404);
    expect([...a.calls, ...b.calls]).toEqual([]);
  });
});

describe("budgets at one past their value (AC-10, AC-28)", () => {
  it("refuses a declared or streamed body over 128 KiB", async () => {
    const r = await rig();
    const declared = await proven(r);
    const tooBig = "x".repeat(LAN_SOURCE_LIMITS.bodyBytes + 1);
    const first = await rawRequest(declared, {
      method: "POST",
      path: lanPath(r.operationId, "chunks"),
      token: r.token,
      body: tooBig,
    });
    expect(first.status).toBe(413);
    const streamed = await proven(r);
    streamed.socket.write(
      `POST ${lanPath(r.operationId, "chunks")} HTTP/1.1\r\nhost: lan\r\nauthorization: Bearer ${r.token}\r\ntransfer-encoding: chunked\r\n\r\n`,
    );
    const piece = "y".repeat(32 * 1024);
    for (let sent = 0; sent <= LAN_SOURCE_LIMITS.bodyBytes; sent += piece.length)
      streamed.socket.write(`${piece.length.toString(16)}\r\n${piece}\r\n`);
    await within(streamed.closed, 2_000);
    expect(streamed.received().toString("latin1")).toMatch(/^HTTP\/1\.1 413/);
    const exact = await proven(r);
    const ok = await rawRequest(exact, {
      method: "POST",
      path: lanPath(r.operationId, "chunks"),
      token: r.token,
      body: JSON.stringify({ chunks: [], pad: "z".repeat(LAN_SOURCE_LIMITS.bodyBytes - 30) }),
    });
    expect(ok.status).toBe(200);
    expect(r.calls).toEqual(["chunks:0"]);
  });

  it("closes a request whose headers pass 8 KiB, without an answer", async () => {
    const r = await rig();
    const client = await proven(r);
    const answer = await rawRequest(client, {
      method: "GET",
      path: lanPath(r.operationId, "hello"),
      token: r.token,
      headers: { "x-pad": "p".repeat(LAN_SOURCE_LIMITS.headerBytes + 1) },
      waitMs: 1_000,
    });
    await within(client.closed, 1_000);
    expect(answer.status).toBeNull();
    expect(client.socket.destroyed).toBe(true);
  });

  it("closes a socket that misses the handshake, header or body deadline", async () => {
    const r = await rig();
    const silent = NodeNet.connect({ host: "127.0.0.1", port: r.port });
    silent.on("error", () => undefined);
    const closedSilent = new Promise<void>((resolve) => silent.once("close", () => resolve()));
    expect(await within(closedSilent, quickSourceLimits.handshakeMs + 1_000)).not.toBe("timeout");
    const quiet = await proven(r);
    expect(await within(quiet.closed, quickSourceLimits.headerMs + 1_000)).not.toBe("timeout");
    const slow = await proven(r);
    slow.socket.write(
      `POST ${lanPath(r.operationId, "chunks")} HTTP/1.1\r\nhost: lan\r\nauthorization: Bearer ${r.token}\r\ncontent-length: 100\r\n\r\n{`,
    );
    expect(await within(slow.closed, quickSourceLimits.bodyMs + 1_500)).not.toBe("timeout");
    expect(r.calls).toEqual([]);
  });

  it("holds five authenticated sockets to four", async () => {
    const r = await rig();
    const clients = [];
    for (let index = 0; index < LAN_SOURCE_LIMITS.authenticatedSockets; index += 1) {
      const client = await proven(r);
      const answer = await rawRequest(client, {
        method: "GET",
        path: lanPath(r.operationId, "hello"),
        token: r.token,
      });
      expect(answer.status).toBe(200);
      clients.push(client);
    }
    const fifth = await proven(r);
    const answer = await rawRequest(fifth, {
      method: "GET",
      path: lanPath(r.operationId, "hello"),
      token: r.token,
      waitMs: 600,
    });
    expect(answer.status).toBeNull();
    for (const client of clients) client.socket.destroy();
  });

  it("answers a fifth chunk read at once 429, on a fifth socket that did reach the route", async () => {
    // The socket limit is raised for this test only, so the read limit is what refuses.
    const r = await rig({ limits: { ...quickSourceLimits, authenticatedSockets: 8 } });
    r.chunks = () => new Promise(() => undefined);
    const post = `POST ${lanPath(r.operationId, "chunks")} HTTP/1.1\r\nhost: lan\r\nauthorization: Bearer ${r.token}\r\ncontent-length: 13\r\n\r\n{"chunks":[]}`;
    const clients = [];
    for (let index = 0; index < LAN_SOURCE_LIMITS.chunkReadsPerOperation; index += 1) {
      const client = await proven(r);
      client.socket.write(post);
      clients.push(client);
    }
    for (let waited = 0; r.calls.length < 4 && waited < 100; waited += 1)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(r.calls).toHaveLength(4);
    const fifth = await proven(r);
    clients.push(fifth);
    const answer = await rawRequest(fifth, {
      method: "POST",
      path: lanPath(r.operationId, "chunks"),
      token: r.token,
      body: '{"chunks":[]}',
    });
    expect(answer.status).toBe(429);
    // It was refused at the route: the copy's chunks were not read a fifth time.
    expect(r.calls).toHaveLength(4);
    expect(r.budgets.chunkReads).toBe(4);
    for (const client of clients) client.socket.destroy();
  });

  it("forgets failed addresses after a minute and never tracks more than its cap", () => {
    let clock = 1_000_000;
    const budgets = new LanSourceBudgets(quickSourceLimits, () => clock);
    const tracked = () => (budgets as unknown as { tracked?: number }).tracked;
    for (let index = 0; index < 5_000; index += 1)
      budgets.failed(`10.${(index >> 16) & 255}.${(index >> 8) & 255}.${index & 255}`);
    expect(typeof tracked()).toBe("number");
    expect(tracked()).toBeLessThanOrEqual(1024);
    clock += 61_000;
    budgets.failed("10.9.9.9");
    expect(tracked()).toBe(1);
  });

  it("counts failed handshakes per address and drops the eleventh at accept for 60 s", async () => {
    const r = await rig();
    for (let index = 0; index < LAN_SOURCE_LIMITS.failedHandshakesPerMinute; index += 1) {
      const client = await rawClient({ port: r.port });
      await within(client.closed, 1_000);
    }
    expect(r.listener.stats.handshakeFailures).toBe(10);
    const before = r.listener.stats.refusedAtAccept;
    const blocked = await rawClient({ port: r.port, certificate: r.recipient });
    await within(blocked.closed, 1_000);
    expect(blocked.secure).toBe(false);
    expect(r.listener.stats.refusedAtAccept).toBe(before + 1);
    // Another address keeps its own allowance; the block ends after its 60 seconds.
    expect(r.budgets.blocked("192.168.1.9")).toBe(false);
    r.clock += LAN_SOURCE_LIMITS.failedHandshakeBlockMs;
    const later = await proven(r);
    const answer = await rawRequest(later, {
      method: "GET",
      path: lanPath(r.operationId, "hello"),
      token: r.token,
    });
    expect(answer.status).toBe(200);
    later.socket.destroy();
  });

  it("holds handshakes in progress to two per address, sixteen in all", async () => {
    const budgets = new LanSourceBudgets(LAN_SOURCE_LIMITS);
    const socket = () => new NodeNet.Socket();
    expect(budgets.begin("192.168.1.2", socket())).toBe(true);
    expect(budgets.begin("192.168.1.2", socket())).toBe(true);
    expect(budgets.begin("192.168.1.2", socket())).toBe(false);
    expect(budgets.begin("192.168.1.3", socket())).toBe(true);
    const many = new LanSourceBudgets(LAN_SOURCE_LIMITS);
    const first = socket();
    let dropped = false;
    first.destroy = () => {
      dropped = true;
      return first;
    };
    many.begin("10.0.0.0", first);
    for (let index = 1; index < 16; index += 1) many.begin(`10.0.0.${index}`, socket());
    expect(dropped).toBe(false);
    // The seventeenth makes the oldest unfinished handshake give way.
    many.begin("10.0.1.1", socket());
    expect(dropped).toBe(true);

    const r = await rig();
    const idle = [1, 2, 3].map(() => {
      const raw = NodeNet.connect({ host: "127.0.0.1", port: r.port });
      raw.on("error", () => undefined);
      return raw;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(r.listener.stats.refusedAtAccept).toBe(1);
    for (const raw of idle) raw.destroy();
  });

  it("refuses a fifth address in one offer", async () => {
    const r = await rig();
    await expect(
      LanGenerationListener.open({
        operationId: r.operationId,
        generation: 2,
        destinationEnvironmentId: "destination-env",
        interfaces: [1, 2, 3, 4, 5].map(() => LOOPBACK),
        certificate: r.source,
        recipientCertificateSha256: r.recipient.sha256,
        recipientCertificatePem: r.recipient.certificatePem,
        tokenSha256: "0".repeat(64),
        served: {} as LanServed,
        budgets: r.budgets,
      } as never),
    ).rejects.toThrow("unbindable");
  });
});

describe("lifetime and closing (AC-09, AC-32, AC-33)", () => {
  it("ends after 15 minutes without an authenticated request and after 2 hours at most", async () => {
    const idle = await rig();
    idle.clock += LAN_SOURCE_LIMITS.idleGenerationMs - 1;
    idle.listener.tick();
    expect(idle.listener.ended).toBeNull();
    idle.clock += 1;
    idle.listener.tick();
    expect(idle.listener.ended).toBe("idle");

    const busy = await rig();
    expect(busy.listener.expiresAt).toBe(busy.clock + LAN_SOURCE_LIMITS.absoluteMs);
    const client = await proven(busy);
    // Kept in use every ten minutes: the absolute limit ends it all the same.
    for (let minute = 10; minute < 120; minute += 10) {
      busy.clock += 10 * 60_000;
      const answer = await rawRequest(client, {
        method: "GET",
        path: lanPath(busy.operationId, "manifest"),
        token: busy.token,
      });
      expect(answer.status).toBe(200);
      busy.listener.tick();
      expect(busy.listener.ended).toBeNull();
    }
    busy.clock += 10 * 60_000;
    busy.listener.tick();
    expect(busy.listener.ended).toBe("expired");
    expect(await within(client.closed, 1_000)).not.toBe("timeout");
  });

  it("closes the listening socket and every accepted socket within a second, mid-response too", async () => {
    const r = await rig();
    const keepalive = await proven(r);
    await rawRequest(keepalive, {
      method: "GET",
      path: lanPath(r.operationId, "hello"),
      token: r.token,
    });
    r.manifest = () => new Promise(() => undefined);
    const inFlight = await proven(r);
    inFlight.socket.write(
      `GET ${lanPath(r.operationId, "manifest")} HTTP/1.1\r\nhost: lan\r\nauthorization: Bearer ${r.token}\r\n\r\n`,
    );
    const handshaking = NodeNet.connect({ host: "127.0.0.1", port: r.port });
    handshaking.on("error", () => undefined);
    const rawClosed = new Promise<void>((resolve) => handshaking.once("close", () => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const started = Date.now();
    r.listener.end("denied");
    expect(await within(keepalive.closed, 1_000)).not.toBe("timeout");
    expect(await within(inFlight.closed, 1_000)).not.toBe("timeout");
    expect(await within(rawClosed, 1_000)).not.toBe("timeout");
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(inFlight.received().length).toBe(0);
    // Nothing listens there any more, and the old token and certificate read nothing.
    const after = await rawClient({ port: r.port, certificate: r.recipient });
    expect(after.secure).toBe(false);
    expect(r.listener.ended).toBe("denied");
  });
});

describe("a response is timed by what the peer takes (S-8)", () => {
  const BODY = 12 * 1024 * 1024;

  /** A proven client that reads the answer only as fast as the test lets it. */
  async function paced(r: Rig) {
    const tcp = NodeNet.connect({ host: "127.0.0.1", port: r.port });
    tcp.on("error", () => undefined);
    const socket = NodeTls.connect({
      socket: tcp,
      minVersion: "TLSv1.3",
      ALPNProtocols: [LAN_ALPN],
      rejectUnauthorized: false,
      cert: r.recipient.certificatePem,
      key: r.recipient.keyPem,
    });
    socket.on("error", () => undefined);
    socket.pause();
    await new Promise<void>((resolve) => socket.once("secureConnect", () => resolve()));
    // The TCP socket: a paused TLS stream does not report the close by itself.
    const closed = new Promise<void>((resolve) => tcp.once("close", () => resolve()));
    socket.write(
      `GET ${lanPath(r.operationId, "manifest")} HTTP/1.1\r\nhost: lan\r\nauthorization: Bearer ${r.token}\r\n\r\n`,
    );
    return { socket, closed };
  }

  it("does not cut a slow reader that keeps taking bytes", async () => {
    const r = await rig();
    r.manifest = async () => ({ ready: true as const, bytes: NodeCrypto.randomBytes(BODY) });
    const { socket, closed } = await paced(r);
    let taken = 0;
    const started = Date.now();
    // 256 KiB every 20 ms: far slower than the link, and never idle for the stall limit.
    const reader = setInterval(() => {
      const part = socket.read(256 * 1024) as Buffer | null;
      taken += (part ?? (socket.read() as Buffer | null))?.length ?? 0;
    }, 20);
    await within(
      (async () => {
        while (taken < BODY && !socket.destroyed)
          await new Promise((resolve) => setTimeout(resolve, 20));
      })(),
      15_000,
    );
    clearInterval(reader);
    // The whole answer arrived, over a time several stall limits long.
    expect(taken).toBeGreaterThanOrEqual(BODY);
    expect(Date.now() - started).toBeGreaterThan(quickSourceLimits.stallMs * 2);
    socket.destroy();
    await closed;
  }, 30_000);

  it("cuts a peer that stops taking bytes, within the stall limit", async () => {
    const r = await rig();
    // More than any socket buffer between the two ends can hold for it.
    r.manifest = async () => ({ ready: true as const, bytes: Buffer.alloc(8 * BODY, 7) });
    const { socket, closed } = await paced(r);
    const started = Date.now();
    // It reads nothing for three stall limits. The source gave up on it meanwhile.
    await new Promise((resolve) => setTimeout(resolve, quickSourceLimits.stallMs * 3));
    let taken = 0;
    socket.on("data", (part: Buffer) => {
      taken += part.length;
    });
    socket.resume();
    // What it finds when it looks again: a closed connection and a fraction of the answer.
    expect(await within(closed, 2_000)).not.toBe("timeout");
    expect(taken).toBeLessThan(BODY);
    expect(Date.now() - started).toBeLessThan(quickSourceLimits.stallMs * 3 + 2_000);
    socket.destroy();
  }, 15_000);
});

describe("the bound hashes (S-1)", () => {
  it("changes with every bound field and cannot run fields together", () => {
    const scope = {
      sourceProjectId: "p",
      copyRoot: "/a/b",
      projectRelativePath: ".",
      mode: "copy-only",
      ceiling: ["tracked"],
    };
    const scopeOf = (input: object) => lanScopeSha256(input as never);
    expect(scopeOf(scope)).toMatch(/^[a-f0-9]{64}$/);
    expect(scopeOf({ ...scope, copyRoot: "/a", projectRelativePath: "/b." })).not.toBe(
      scopeOf(scope),
    );
    // The approved classes are part of the scope: a wider or other set is another hash.
    expect(scopeOf({ ...scope, ceiling: ["tracked", "untracked"] })).not.toBe(scopeOf(scope));
    expect(scopeOf({ ...scope, ceiling: ["untracked"] })).not.toBe(scopeOf(scope));
    expect(lanTargetSha256({ targetPath: "/t", kind: "empty" })).not.toBe(
      lanTargetSha256({ targetPath: "/t", kind: "reviewed" }),
    );
    const binding = {
      sourceEnvironmentId: "s",
      destinationEnvironmentId: "d",
      operationId: "o",
      purpose: "sync-measured",
      scopeSha256: "1".repeat(64),
      targetSha256: "2".repeat(64),
      generation: 3,
      expiresAt: 4,
      sourceCertificateSha256: "5".repeat(64),
      recipientCertificateSha256: "6".repeat(64),
    };
    const base = lanBindingSha256(binding);
    for (const [key, value] of Object.entries({
      sourceEnvironmentId: "x",
      destinationEnvironmentId: "x",
      operationId: "x",
      purpose: "add-whole-folder",
      scopeSha256: "9".repeat(64),
      targetSha256: "9".repeat(64),
      generation: 9,
      expiresAt: 9,
      sourceCertificateSha256: "9".repeat(64),
      recipientCertificateSha256: "9".repeat(64),
    }))
      expect(lanBindingSha256({ ...binding, [key]: value }), key).not.toBe(base);
    expect(LAN_ALPN).toBe("swc-folder-lan/1");
  });
});
