// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off globalDate:off - two real copy services over loopback: Connect by HTTP, the local network by TLS.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  FOLDER_COPY_LAN_GATE,
  FolderCopyCapabilities,
  folderCopyAllConflictsKey,
  folderCopyLanGateOpen,
  FolderCopyOffer,
  FolderCopyOfferInput,
  FolderCopyStartInput,
  type FolderCopyLanCheck,
  type FolderCopyLanCheckAnswer,
  type FolderCopyLanOffer,
} from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { AgentCopyReceiveInput, AgentCopyReceiveResult } from "./agentCopy.ts";
import { DestinationCopies } from "./destinationService.ts";
import { git } from "./folderFixture.testkit.ts";
import * as Previous from "./lan.previousRelease.test.fixture.ts";
import {
  certificate,
  fakeLanServer,
  loopbackPolicy,
  quickClientLimits,
  quickSourceLimits,
  rawClient,
  within,
  type FakeLanServer,
} from "./lan.testkit.ts";
import { LanDestination, lanPathOf } from "./lanDestination.ts";
import { systemLanPolicy } from "./lanInterfaces.ts";
import { lanSettingInEffect } from "./lanRuntime.ts";
import { LanSource, type LanSourceAccess } from "./lanSource.ts";
import { LAN_SOURCE_LIMITS, mintLanToken } from "./lanWire.ts";
import { handleSourceRequest } from "./sourceRoutes.ts";
import { SourceTransfers } from "./sourceService.ts";
import { CHUNK_UNKNOWN, FOLDER_TRANSFER_PREFIX, sha256Hex } from "./wire.ts";

let base: string;
let folder: string;
let target: string;
let sourceState: string;
let destinationState: string;
let id: string;
let sources: SourceTransfers;
let copies: DestinationCopies;
let connect: NodeHttp.Server;
let connectUrl: string;
let policy: ReturnType<typeof loopbackPolicy>;
let on: { source: boolean; destination: boolean };
/** Requests that reached the source over Connect, as `METHOD action`. */
let connectRequests: Array<string>;
let beforeConnect: ((method: string, action: string) => Promise<void> | void) | null;
let onLanChunks: (() => Promise<void> | void) | null;
let lanServed: Array<string>;
let control: {
  checks: Array<FolderCopyLanCheck>;
  answers: Array<FolderCopyLanCheckAnswer>;
  offers: Array<{ operationId: string; lan: FolderCopyLanOffer }>;
  check: ((body: FolderCopyLanCheck) => Promise<FolderCopyLanCheckAnswer>) | null;
  offer: ((body: { operationId: string; lan: FolderCopyLanOffer }) => Promise<boolean>) | null;
};
let impostors: Array<FakeLanServer>;
let clock: { now: number | null };

const now = () => clock.now ?? Date.now();

function makeSources(state = sourceState) {
  return new SourceTransfers(state, {
    lan: (access) =>
      new LanSource({
        access: {
          ...access,
          lanManifest: (operationId) => {
            lanServed.push("manifest");
            return access.lanManifest(operationId);
          },
          lanChunks: async (operationId, hashes, zstd) => {
            lanServed.push("chunks");
            await onLanChunks?.();
            return access.lanChunks(operationId, hashes, zstd);
          },
        } satisfies LanSourceAccess,
        environmentId: () => "source-env",
        enabled: () => on.source,
        policy,
        limits: quickSourceLimits,
        now,
        watchMs: 40,
        peer: {
          check: async (_destination, body) => {
            control.checks.push(body);
            const answer = await (control.check
              ? control.check(body)
              : copies.lan!.check("source-env", body));
            control.answers.push(answer);
            return answer;
          },
          offer: async (_destination, body) => {
            control.offers.push(body);
            return control.offer ? control.offer(body) : copies.lan!.offer("source-env", body);
          },
        },
      }),
  });
}

function makeCopies() {
  return new DestinationCopies(destinationState, {
    allowLoopback: true,
    pollMs: 1,
    sleep: async () => {},
    lan: (access) =>
      new LanDestination({
        access,
        environmentId: () => "destination-env",
        enabled: () => on.destination,
        policy,
        limits: quickClientLimits,
        now,
        watchMs: 40,
      }),
    fetch: async (input, init) => {
      const action = String(input).split("/").at(-1) ?? "";
      const method = init?.method ?? "GET";
      // Test shim on the Connect path only: wait for the offer exchange the selection
      // request prompted, and let the client ask again once a LAN route exists.
      if (method === "GET" && action === "manifest") {
        await sources.lan?.settled(id);
        if ((await copies.lan?.connector(id)) != null)
          return new Response(JSON.stringify({ progress: null }), { status: 202 });
      }
      await beforeConnect?.(method, action);
      connectRequests.push(`${method} ${action}`);
      return fetch(input, init);
    },
  });
}

beforeEach(async () => {
  base = await NodeFSP.realpath(await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "swc-lan-")));
  folder = NodePath.join(base, "source");
  target = NodePath.join(base, "destination");
  sourceState = NodePath.join(base, "source-state");
  destinationState = NodePath.join(base, "destination-state");
  await NodeFSP.mkdir(folder);
  await NodeFSP.mkdir(target);
  await NodeFSP.writeFile(NodePath.join(folder, "README.md"), "reviewed source\n");
  await NodeFSP.writeFile(NodePath.join(folder, "data.bin"), NodeCrypto.randomBytes(300_000));
  await NodeFSP.writeFile(NodePath.join(folder, ".env"), "EXAMPLE_PRIVATE=never-on-the-lan\n");
  git(folder, "init", "-q");
  git(folder, "add", "README.md");
  git(folder, "commit", "-qm", "initial");
  id = NodeCrypto.randomUUID();
  policy = loopbackPolicy();
  on = { source: true, destination: true };
  connectRequests = [];
  lanServed = [];
  beforeConnect = null;
  onLanChunks = null;
  impostors = [];
  clock = { now: null };
  control = { checks: [], answers: [], offers: [], check: null, offer: null };
  sources = makeSources();
  copies = makeCopies();
  // Connect: a plain HTTP server at one address that survives a restart of the source service.
  connect = NodeHttp.createServer(async (request, response) => {
    const parts: Array<Buffer> = [];
    for await (const part of request) parts.push(part as Buffer);
    const body = Buffer.concat(parts);
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const result = await handleSourceRequest(sources, "source-env", {
      method: request.method ?? "GET",
      path: pathname.slice(FOLDER_TRANSFER_PREFIX.length),
      authorization: request.headers.authorization ?? null,
      body: async () => body,
    });
    response
      .writeHead(result.status, { "content-type": result.contentType })
      .end(Buffer.from(result.body));
  });
  await new Promise<void>((resolve) => connect.listen(0, "127.0.0.1", resolve));
  connectUrl = `http://127.0.0.1:${(connect.address() as NodeNet.AddressInfo).port}`;
});

afterEach(async () => {
  await copies?.close();
  await sources?.close();
  for (const impostor of impostors) await impostor.close();
  await new Promise<void>((resolve) => {
    connect.closeAllConnections();
    connect.close(() => resolve());
  });
  await NodeFSP.rm(base, { recursive: true, force: true });
});

async function settle(states: ReadonlyArray<string>) {
  for (let turn = 0; turn < 600; turn += 1) {
    await copies.waitFor(id);
    const record = await copies.read(id);
    if (record && states.includes(record.state)) return record;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Copy did not settle: ${JSON.stringify(await copies.read(id))}`);
}

async function offerAndStart(
  options: {
    lanPurpose?: "sync-measured" | "add-whole-folder" | undefined;
    purpose?: "review" | "add-to-machine" | undefined;
  } = { lanPurpose: "sync-measured", purpose: "review" },
) {
  const offer = await sources.offer({
    operationId: id,
    projectId: "source-project",
    folder,
    mode: "copy-only",
    destinationEnvironmentId: "destination-env",
    ...(options.lanPurpose ? { lanPurpose: options.lanPurpose } : {}),
  });
  await copies.start({
    operationId: id,
    sourceUrl: connectUrl,
    token: offer.token,
    sourceEnvironmentId: "source-env",
    sourceProjectId: "source-project",
    sourceMachine: "Source",
    mode: "copy-only",
    targetFolder: target,
    title: "Local network copy",
    ...(options.purpose ? { purpose: options.purpose } : {}),
  });
  return offer;
}

/** Offer, start, and review the comparison: the copy stands at "previewed". */
async function prepare(options?: Parameters<typeof offerAndStart>[0]) {
  const offer = await offerAndStart(options);
  const initial = await settle(["previewed", "failed"]);
  expect(initial.state, JSON.stringify(initial.error)).toBe("previewed");
  const plan = (await copies.readPlan(id))!;
  await copies.decide(id, {
    decisions: Object.fromEntries(
      plan.rows.flatMap((row) => [
        [row.id, "take-theirs"],
        [folderCopyAllConflictsKey(row.id), "take-theirs"],
      ]),
    ),
  });
  expect((await settle(["previewed", "failed"])).state).toBe("previewed");
  return offer;
}

async function finish() {
  await copies.approve(id);
  return settle(["applied", "failed"]);
}

const copied = async () =>
  (await NodeFSP.readFile(NodePath.join(target, "data.bin"))).equals(
    await NodeFSP.readFile(NodePath.join(folder, "data.bin")),
  );
const destinationRecordText = () =>
  NodeFSP.readFile(NodePath.join(destinationState, "folder-copies", id, "operation.json"), "utf8");
const sourceRecordText = () =>
  NodeFSP.readFile(NodePath.join(sourceState, "folder-sources", id, "operation.json"), "utf8");
const restartDestination = async () => {
  await copies.close();
  copies = makeCopies();
};
const restartSource = async () => {
  await sources.close();
  sources = makeSources();
};
const dataRequests = () =>
  connectRequests.filter((line) => line === "GET manifest" || line === "POST chunks");

async function impostorAt(port: number) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const impostor = await fakeLanServer({
        certificate: certificate("source"),
        port,
        // It knows the right environment id and would say so, if anyone ever asked.
        handle: (_request, response) =>
          void response
            .writeHead(200)
            .end(JSON.stringify({ environmentId: "source-env", operationId: id, generation: 1 })),
      });
      impostors.push(impostor);
      return impostor;
    } catch (cause) {
      if (attempt > 50) throw cause;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

describe("the measured Sync copy over the local network (AC-01)", () => {
  it("pulls the manifest and the chunks from the LAN address and everything else over Connect", async () => {
    await prepare();
    const done = await finish();
    expect(done.state, JSON.stringify(done.error)).toBe("applied");
    expect(await copied()).toBe(true);
    expect(await NodeFSP.readFile(NodePath.join(target, "README.md"), "utf8")).toBe(
      "reviewed source\n",
    );
    // No file byte crossed Connect.
    expect(dataRequests()).toEqual([]);
    expect(lanServed).toContain("manifest");
    expect(lanServed).toContain("chunks");
    expect(lanPathOf(done.lan)).toMatchObject({ path: "lan", bytesConnect: 0 });
    expect(done.lan!.bytesLan).toBeGreaterThan(300_000);
    expect(done.lan).toMatchObject({ generation: 1, latch: null });
    // Selection, validation, the final stat pass and the commit stayed on Connect (S-5).
    for (const step of ["POST manifest", "POST stat", "POST commit"])
      expect(connectRequests).toContain(step);
    // The secret-like file never travelled; the LAN served only the two data routes.
    await expect(NodeFSP.stat(NodePath.join(target, ".env"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(new Set(lanServed)).toEqual(new Set(["manifest", "chunks"]));
    // The copy ended, so its listener and sockets are gone.
    expect(sources.lan!.liveGenerations()).toBe(0);
    expect(copies.lan!.liveGenerations()).toBe(0);
  }, 30_000);

  it("runs Add's whole-folder copy the same way, and no other copy at all", async () => {
    await prepare({ lanPurpose: "add-whole-folder", purpose: "add-to-machine" });
    expect((await finish()).state).toBe("applied");
    expect(dataRequests()).toEqual([]);
    expect(control.checks[0]!.purpose).toBe("add-whole-folder");
  }, 30_000);

  it.each([
    ["the source names no purpose", {}],
    ["the destination has no purpose", { lanPurpose: "sync-measured" as const }],
    [
      "the two disagree",
      { lanPurpose: "sync-measured" as const, purpose: "add-to-machine" as const },
    ],
  ])(
    "stays on Connect when %s",
    async (_name, options) => {
      await prepare(options);
      const done = await finish();
      expect(done.state).toBe("applied");
      expect(lanServed).toEqual([]);
      expect(control.offers).toEqual([]);
      expect(sources.lan!.liveGenerations()).toBe(0);
      expect(lanPathOf(done.lan)?.path ?? "connect").toBe("connect");
    },
    30_000,
  );
});

describe("an impostor at the offered address (AC-07, AC-22)", () => {
  it("gets no HTTP byte and no token, and the copy completes over Connect", async () => {
    let impostor!: FakeLanServer;
    control.offer = async (body) => {
      // The real listener goes away and an impostor with another certificate takes its port.
      const port = body.lan.addresses[0]!.port;
      sources.lan!.ended(id, "shutdown");
      impostor = await impostorAt(port);
      return copies.lan!.offer("source-env", body);
    };
    let latchedBeforeConnect: unknown = "no Connect data request seen";
    beforeConnect = async (method, action) => {
      if (`${method} ${action}` === "GET manifest" && typeof latchedBeforeConnect === "string")
        latchedBeforeConnect = JSON.parse(await destinationRecordText()).lan;
    };
    await prepare();
    const done = await finish();
    expect(done.state, JSON.stringify(done.error)).toBe("applied");
    expect(await copied()).toBe(true);
    expect(impostor.connections()).toBe(1);
    expect(impostor.applicationBytes()).toBe(0);
    expect(impostor.requests).toEqual([]);
    // The switch was on disk before the first Connect request for data (AC-22).
    expect(latchedBeforeConnect).toMatchObject({ latch: "wrong_pin", accepted: null });
    expect(done.lan).toMatchObject({ latch: "wrong_pin", bytesLan: 0 });
    expect(lanPathOf(done.lan)!.path).toBe("connect");
    expect(dataRequests()).toContain("POST chunks");
    // It switched once: the impostor was never dialled again.
    expect(impostor.connections()).toBe(1);
  }, 30_000);
});

describe("offers and generations (AC-15, AC-16, AC-19)", () => {
  it("refuses an old offer, a replayed check and a block it cannot recompute, also after a restart", async () => {
    await prepare();
    const first = { check: control.checks[0]!, offer: control.offers[0]! };
    const firstListener = sources.lan!.listenerOf(id)!;
    const firstPort = firstListener.addresses[0]!.port;
    expect(await sources.lan!.exchange(id)).toBe(true);
    expect(control.checks.map((body) => body.generation)).toEqual([1, 2]);
    // The superseded generation is gone on the source: listener, sockets, token.
    expect(firstListener.ended).toBe("rotated");
    expect((await rawClient({ port: firstPort })).secure).toBe(false);
    // A delayed, once-valid offer is dead for good.
    expect(await copies.lan!.offer("source-env", first.offer)).toBe(false);
    expect(await copies.lan!.check("source-env", first.check)).toEqual({ lan: null });
    expect(await copies.lan!.check("source-env", control.checks[1]!)).toEqual({ lan: null });
    // The current offer cannot be taken twice, or from another machine.
    expect(await copies.lan!.offer("source-env", control.offers[1]!)).toBe(false);
    expect(await copies.lan!.offer("other-env", control.offers[1]!)).toBe(false);
    expect(await copies.lan!.check("other-env", { ...first.check, generation: 9 })).toEqual({
      lan: null,
    });

    // A third generation, answered but not yet offered: every bound field is checked.
    const live = sources.lan!.listenerOf(id)!;
    const accepted = live.stats.accepted;
    const answer = await copies.lan!.check("source-env", { ...first.check, generation: 3 });
    expect(answer.lan).not.toBeNull();
    const good: FolderCopyLanOffer = {
      ...control.offers[1]!.lan,
      generation: 3,
      recipientCertificateSha256: answer.lan!.recipientCertificateSha256,
    };
    for (const tampered of [
      { scopeSha256: "1".repeat(64) },
      { targetSha256: "2".repeat(64) },
      { bindingSha256: "3".repeat(64) },
      { purpose: "add-whole-folder" as const },
      { generation: 2 },
      { recipientCertificateSha256: "4".repeat(64) },
      { expiresAt: Date.now() + 3 * 60 * 60_000 },
      { expiresAt: Date.now() - 1 },
      { addresses: [{ host: "203.0.113.9", port: 443 }] },
      {},
    ])
      expect([
        tampered,
        await copies.lan!.offer("source-env", { operationId: id, lan: { ...good, ...tampered } }),
      ]).toEqual([tampered, false]);
    // Nothing was dialled for any of them.
    expect(live.stats.accepted).toBe(accepted);
    expect(await copies.lan!.connector(id)).toBeNull();

    // After a restart of each machine the numbers still only go up.
    await restartDestination();
    for (const generation of [1, 2, 3])
      expect(await copies.lan!.check("source-env", { ...first.check, generation })).toEqual({
        lan: null,
      });
    await restartSource();
    control.checks.length = 0;
    await sources.lan!.exchange(id);
    // The source's own saved counter stood at 2; it goes up from there, never back.
    expect(control.checks.map((body) => body.generation)).toEqual([3]);
    expect(JSON.parse(await sourceRecordText()).lan.generation).toBe(3);
    // The destination has already answered for 3, so that number is spent there too.
    expect(control.answers.at(-1)).toEqual({ lan: null });
    expect(sources.lan!.liveGenerations()).toBe(0);
  }, 30_000);

  it("never gives a terminal copy a listener again", async () => {
    await prepare();
    await finish();
    expect(await sources.lan!.exchange(id)).toBe(false);
    expect(sources.lan!.liveGenerations()).toBe(0);
    expect(
      await copies.lan!.check("source-env", { ...control.checks[0]!, generation: 50 }),
    ).toEqual({ lan: null });
  }, 30_000);

  it("keeps the lan block out of the offer a window relays and out of the copy's status", async () => {
    expect(Object.keys(FolderCopyOffer.fields)).not.toContain("lan");
    expect(Object.keys(FolderCopyStartInput.fields)).not.toContain("lan");
    expect(Object.keys(FolderCopyOfferInput.fields)).toContain("lanPurpose");
    await prepare();
    const done = await finish();
    expect(lanPathOf(done.lan)).toEqual({
      path: "lan",
      bytesLan: done.lan!.bytesLan,
      bytesConnect: 0,
    });
  }, 30_000);

  it("holds one copy to six generations an hour", async () => {
    await prepare();
    const results: Array<boolean> = [];
    for (let turn = 0; turn < LAN_SOURCE_LIMITS.generationsPerOperationPerHour; turn += 1)
      results.push(await sources.lan!.exchange(id));
    // The first generation came with the copy; the seventh in the hour is refused.
    expect(results).toEqual([true, true, true, true, true, false]);
    expect(control.checks).toHaveLength(6);
  }, 30_000);
});

describe("a denial stops the copy on both paths (AC-02, AC-21)", () => {
  it.each(["revoked", "refused", "scope_changed"] as const)(
    "a %s denial that reaches the destination only as a reset is answered by Connect",
    async (denial) => {
      await prepare();
      let denied = false;
      onLanChunks = async () => {
        if (denied) return;
        denied = true;
        // Saved on the operation first; only then do the generation's sockets close.
        await sources.lan!.deny(id, denial);
      };
      const done = await finish();
      expect(done.state).toBe("failed");
      expect(done.error?.code).toBe("unauthorized");
      await expect(NodeFSP.stat(NodePath.join(target, "data.bin"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      const source = JSON.parse(await sourceRecordText());
      expect(source.state).toBe("cancelled");
      expect(source.grant.revokedReason).toBe(denial);
      // It switched once, Connect refused it, and it did not go on.
      expect(done.lan!.latch).not.toBeNull();
      expect(dataRequests().filter((line) => line === "POST chunks").length).toBeGreaterThan(0);
      expect(sources.lan!.liveGenerations()).toBe(0);
      // A denied copy cannot be offered again under the same id.
      await expect(
        sources.offer({
          operationId: id,
          projectId: "source-project",
          folder,
          mode: "copy-only",
          destinationEnvironmentId: "destination-env",
          lanPurpose: "sync-measured",
        }),
      ).rejects.toMatchObject({ status: 409 });
    },
    30_000,
  );

  it("does not resume a refused copy after the refusal is lost and both machines restart", async () => {
    await prepare();
    expect(JSON.parse(await destinationRecordText()).lan).toMatchObject({ accepted: 1 });
    // The source refuses while the destination hears nothing, then both restart.
    await sources.lan!.deny(id, "refused");
    const servedBefore = lanServed.length;
    await restartSource();
    await restartDestination();
    expect(sources.lan!.liveGenerations()).toBe(0);
    // Connect answers for the source: the copy is refused before any byte moves.
    await expect(copies.approve(id)).rejects.toMatchObject({ code: "unauthorized" });
    // The accepted block's key was lost with the restart: no dial, one saved switch.
    expect(await copies.lan!.connector(id)).toBeNull();
    expect(JSON.parse(await destinationRecordText()).lan).toMatchObject({
      latch: "unreachable",
      accepted: null,
    });
    expect(lanServed.length).toBe(servedBefore);
    await expect(NodeFSP.stat(NodePath.join(target, "data.bin"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    // Nothing brings the local network back for it, on either machine.
    expect(await sources.lan!.exchange(id)).toBe(false);
    expect(
      await copies.lan!.check("source-env", { ...control.checks[0]!, generation: 40 }),
    ).toEqual({ lan: null });
  }, 30_000);

  it("stops a selection outside the frozen ceiling as a changed scope", async () => {
    const offer = await sources.offer({
      operationId: id,
      projectId: "source-project",
      folder,
      mode: "copy-only",
      destinationEnvironmentId: "destination-env",
      lanPurpose: "sync-measured",
    });
    const loaded = await sources.authorize(id, offer.token);
    await expect(sources.requestManifest(loaded, ["tracked", "secret"])).rejects.toMatchObject({
      status: 401,
    });
    const record = (await sources.read(id))!;
    expect([record.state, record.grant.revokedReason]).toEqual(["cancelled", "scope_changed"]);
    await expect(sources.authorize(id, offer.token)).rejects.toMatchObject({ status: 401 });
  });
});

describe("a failing local network switches once to Connect (AC-02, AC-11)", () => {
  it("finishes a copy whose LAN path dies mid-chunk, reports a mixed path, and stays switched after a restart", async () => {
    await prepare();
    let killed = false;
    onLanChunks = () => {
      if (killed) return;
      killed = true;
      sources.lan!.ended(id, "network_changed");
    };
    const done = await finish();
    expect(done.state, JSON.stringify(done.error)).toBe("applied");
    expect(await copied()).toBe(true);
    expect(done.lan!.latch).toBe("unreachable");
    // The manifest came over the LAN and the chunks over Connect.
    expect(lanPathOf(done.lan)).toMatchObject({ path: "mixed" });
    expect(done.lan!.bytesLan).toBeGreaterThan(0);
    expect(done.lan!.bytesConnect).toBeGreaterThan(300_000);
    await restartDestination();
    expect(await copies.lan!.connector(id)).toBeNull();
    expect(JSON.parse(await destinationRecordText()).lan.latch).toBe("unreachable");
  }, 30_000);

  it("stays on Connect when there is no control route or the destination is older (AC-05)", async () => {
    control.check = async () => {
      throw new Error("no_route");
    };
    await prepare();
    const done = await finish();
    expect(done.state).toBe("applied");
    expect(await copied()).toBe(true);
    // The source asked once, bound nothing and did not ask again.
    expect(control.checks).toHaveLength(1);
    expect(control.offers).toEqual([]);
    expect(lanServed).toEqual([]);
    expect(sources.lan!.liveGenerations()).toBe(0);
  }, 30_000);
});

describe("out-of-scope reads return no bytes (AC-13, AC-24)", () => {
  it("answers a hash outside the copy's manifest with the unknown frame", async () => {
    await prepare();
    const connector = (await copies.lan!.connector(id))!;
    const secret = sha256Hex(await NodeFSP.readFile(NodePath.join(folder, ".env")));
    const outside = [secret, sha256Hex(Buffer.from("not in this copy")), "f".repeat(64)];
    const frames = await connector.chunks(outside);
    expect(frames.map((frame) => [frame.status, frame.data.length])).toEqual(
      outside.map(() => [CHUNK_UNKNOWN, 0]),
    );
    // A hash the manifest does name is served, so the refusal above is about scope.
    const inside = sha256Hex(await NodeFSP.readFile(NodePath.join(folder, "README.md")));
    expect((await connector.chunks([inside]))[0]!.data.toString()).toBe("reviewed source\n");
  }, 30_000);
});

describe("both machines opt in (AC-30, AC-31)", () => {
  it("is closed for every operating system until its gate is recorded", () => {
    for (const platform of ["darwin", "win32", "linux"]) {
      expect(folderCopyLanGateOpen(platform), platform).toBe(false);
      expect(lanSettingInEffect({ folderCopyOverLan: true }, platform), platform).toBe(false);
    }
    expect(FOLDER_COPY_LAN_GATE.implementationReview).toBe(false);
    expect(FOLDER_COPY_LAN_GATE.osEvidence).toEqual({ darwin: false, win32: false, linux: false });
    const open = {
      designReview: true,
      implementationReview: true,
      relayRecords: true,
      risksAccepted: true,
      osEvidence: { darwin: true },
    };
    expect(folderCopyLanGateOpen("darwin", open)).toBe(true);
    // One operating system's evidence opens nothing for another.
    expect(folderCopyLanGateOpen("linux", open)).toBe(false);
    for (const key of ["designReview", "implementationReview", "relayRecords", "risksAccepted"])
      expect(folderCopyLanGateOpen("darwin", { ...open, [key]: false }), key).toBe(false);
  });

  it("never admits loopback or a public address in the app's own policy", async () => {
    const system = systemLanPolicy();
    for (const host of ["127.0.0.1", "::1", "8.8.8.8", "100.64.0.1", "169.254.1.1", "localhost"])
      expect(system.admit(host), host).toBe(false);
    for (const entry of await system.eligible()) expect(system.admit(entry.address)).toBe(true);
  });

  it.each(["source", "destination"] as const)(
    "makes no key, socket or block with the setting off on the %s",
    async (side) => {
      on[side] = false;
      await prepare();
      const done = await finish();
      expect(done.state).toBe("applied");
      expect(await copied()).toBe(true);
      expect(control.offers).toEqual([]);
      expect(lanServed).toEqual([]);
      expect(sources.lan!.liveGenerations()).toBe(0);
      expect(copies.lan!.liveGenerations()).toBe(0);
      if (side === "source") expect(control.checks).toEqual([]);
      else expect(control.answers.every((answer) => answer.lan === null)).toBe(true);
    },
    30_000,
  );

  it.each([
    ["the source turns the setting off", () => void (on.source = false)],
    ["the destination turns the setting off", () => void (on.destination = false)],
    ["the network changes", () => void (policy.network = "test0|10.9.9.9/8")],
  ])(
    "ends live generations within a second when %s, and rebinds nothing",
    async (_name, change) => {
      await prepare();
      const listener = sources.lan!.listenerOf(id)!;
      const port = listener.addresses[0]!.port;
      expect(sources.lan!.liveGenerations() + copies.lan!.liveGenerations()).toBe(2);
      change();
      await new Promise((resolve) => setTimeout(resolve, 600));
      if (on.destination) expect(sources.lan!.liveGenerations()).toBe(0);
      if (on.source) expect(copies.lan!.liveGenerations()).toBe(0);
      if (on.source && on.destination) {
        expect(listener.ended).toBe("network_changed");
        expect((await rawClient({ port })).secure).toBe(false);
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(control.checks).toHaveLength(1);
      // The copy still completes; whatever is left of it runs on Connect.
      const done = await finish();
      expect(done.state, JSON.stringify(done.error)).toBe("applied");
      expect(await copied()).toBe(true);
    },
    30_000,
  );

  it("offers nothing when no interface is eligible", async () => {
    policy.attached = false;
    await prepare();
    expect((await finish()).state).toBe("applied");
    expect(control.checks).toEqual([]);
    expect(sources.lan!.liveGenerations()).toBe(0);
  }, 30_000);
});

describe("closing on a terminal event (AC-32)", () => {
  it("destroys the listener and its accepted sockets when the source cancels", async () => {
    await prepare();
    const listener = sources.lan!.listenerOf(id)!;
    const port = listener.addresses[0]!.port;
    const connector = (await copies.lan!.connector(id))!;
    await connector.manifest();
    const started = Date.now();
    await sources.cancel(id, "The person cancelled.");
    expect(listener.ended).toBe("terminal");
    expect(Date.now() - started).toBeLessThan(1_000);
    expect((await rawClient({ port })).secure).toBe(false);
    await expect(connector.manifest()).rejects.toMatchObject({ kind: "unreachable" });
    expect(JSON.parse(await sourceRecordText()).grant.revokedReason).toBe("cancelled");
  }, 30_000);
});

describe("nothing about the lan block is kept or said (AC-14)", () => {
  it("leaves no address, port, hash or token in records, statuses or errors", async () => {
    await prepare();
    let killed = false;
    onLanChunks = () => {
      if (killed) return;
      killed = true;
      sources.lan!.ended(id, "network_changed");
    };
    const done = await finish();
    expect(done.state).toBe("applied");
    const offer = control.offers[0]!.lan;
    const answer = control.answers[0]!.lan!;
    const texts = [
      await destinationRecordText(),
      await sourceRecordText(),
      JSON.stringify(done),
      JSON.stringify(await sources.read(id)),
    ].join("\n");
    for (const secret of [
      offer.lanToken,
      mintLanToken().token.slice(0, 7),
      offer.sourceCertificateSha256,
      offer.recipientCertificateSha256,
      offer.scopeSha256,
      offer.targetSha256,
      offer.bindingSha256,
      answer.recipientCertificateSha256,
      `:${offer.addresses[0]!.port}`,
      `"port"`,
      `"addresses"`,
      "BEGIN",
    ])
      expect(texts).not.toContain(secret);
    // What is kept: the generation, the latch and bytes per path.
    expect(Object.keys(JSON.parse(await destinationRecordText()).lan).sort()).toEqual([
      "accepted",
      "bytesConnect",
      "bytesLan",
      "generation",
      "latch",
    ]);
    expect(Object.keys(JSON.parse(await sourceRecordText()).lan).sort()).toEqual([
      "generation",
      "issued",
    ]);
  }, 30_000);
});

describe(`both directions against ${Previous.PREVIOUS_RELEASE} (EC2-04, EC2-09)`, () => {
  const encode = Schema.encodeSync(AgentCopyReceiveInput);
  const decodePrevious = Schema.decodeUnknownSync(Previous.AgentCopyReceiveInput, {
    onExcessProperty: "error",
  });

  it("is pinned to the release it copies", () => {
    expect(Previous.PREVIOUS_RELEASE).toBe("v1.0.386");
  });

  it("this source to that destination: lanCheck is refused there and the copy runs on Connect", async () => {
    // The previous release decodes the tool's input with its own schema, which has no lanCheck.
    control.check = async (body) => {
      const sent = encode({ action: "lanCheck", lanCheck: body });
      decodePrevious(sent);
      throw new Error("unreachable in this test: the previous release refuses the action");
    };
    await prepare();
    const done = await finish();
    expect(done.state).toBe("applied");
    expect(await copied()).toBe(true);
    expect(control.checks).toHaveLength(1);
    expect(control.offers).toEqual([]);
    expect(sources.lan!.liveGenerations()).toBe(0);
    expect(() =>
      decodePrevious(encode({ action: "lanCheck", lanCheck: control.checks[0]! })),
    ).toThrow();
    // Its capabilities name no local-network path, and this version reads them as such.
    const theirs = Schema.decodeUnknownSync(FolderCopyCapabilities)(
      Schema.encodeSync(Previous.FolderCopyCapabilities)({
        scopeVersion: 1,
        existingCopyUpdate: 1,
      }),
    );
    expect(theirs.lanTransport).toBeUndefined();
  }, 30_000);

  it("that source to this destination: it never asks, and its start and status shapes still read", async () => {
    // A v1.0.386 source: the same routes, no lanPurpose in its offer, no control call ever.
    await sources.close();
    sources = new SourceTransfers(sourceState);
    const offer = await sources.offer({
      operationId: id,
      projectId: "source-project",
      folder,
      mode: "copy-only",
      destinationEnvironmentId: "destination-env",
    });
    const start = Schema.encodeSync(Previous.FolderCopyStartInput)(
      Schema.decodeUnknownSync(Previous.FolderCopyStartInput)({
        operationId: id,
        sourceUrl: connectUrl,
        token: offer.token,
        sourceEnvironmentId: "source-env",
        sourceProjectId: "source-project",
        sourceMachine: "Source",
        mode: "copy-only",
        targetFolder: target,
        title: "From the previous release",
        purpose: "review",
      }),
    );
    // This version's tool input takes exactly what that release sends.
    const received = Schema.decodeUnknownSync(AgentCopyReceiveInput)({ action: "start", start });
    await copies.start({ ...received.start!, purpose: "review" } as Parameters<
      typeof copies.start
    >[0]);
    await settle(["previewed", "failed"]);
    const done = await finish();
    expect(done.state, JSON.stringify(done.error)).toBe("applied");
    expect(await copied()).toBe(true);
    expect(control.checks).toEqual([]);
    expect(copies.lan!.liveGenerations()).toBe(0);
    expect(done.lan?.latch ?? null).toBeNull();
    // Every route it calls is still served over Connect, and it reads this version's answers.
    for (const route of connectRequests) expect(Previous.SOURCE_ROUTES).toContain(route);
    const answered = Schema.encodeSync(AgentCopyReceiveResult)({
      state: "applied",
      folderCopyLan: 1,
      lanAccepted: false,
      lan: null,
    });
    expect(Schema.decodeUnknownSync(Previous.AgentCopyReceiveResult)(answered).state).toBe(
      "applied",
    );
    expect(
      Schema.decodeUnknownSync(FolderCopyOfferInput)(
        Schema.encodeSync(Previous.FolderCopyOfferInput)(
          Schema.decodeUnknownSync(Previous.FolderCopyOfferInput)({
            projectId: "source-project",
            operationId: id,
            mode: "copy-only",
            destinationEnvironmentId: "destination-env",
          }),
        ),
      ).lanPurpose,
    ).toBeUndefined();
  }, 30_000);
});

describe("generation budgets across copies (AC-28)", () => {
  it("holds a source to four live generations, two per destination", async () => {
    const recipient = certificate("recipient");
    const state = (operationId: string, destination: string) => ({
      operationId,
      projectId: "p",
      folder,
      projectRelativePath: ".",
      mode: "copy-only",
      destinationEnvironmentId: destination,
      purpose: "sync-measured" as const,
      terminal: false,
      denial: null,
      generation: 0,
      issued: [] as ReadonlyArray<number>,
    });
    const destinations = new Map<string, string>();
    const source = new LanSource({
      access: {
        lanState: async (operationId) => state(operationId, destinations.get(operationId)!),
        lanSaveGeneration: async () => undefined,
        lanManifest: async () => ({ ready: false, body: {} }),
        lanChunks: async () => new Uint8Array(),
        lanDeny: async () => undefined,
      },
      environmentId: () => "source-env",
      enabled: () => true,
      policy,
      limits: quickSourceLimits,
      peer: {
        check: async (_destination, body) => ({
          lan: {
            version: 1,
            generation: body.generation,
            recipientCertificateSha256: recipient.sha256,
            targetSha256: "a".repeat(64),
            usable: [0],
          },
        }),
        offer: async () => true,
      },
    });
    try {
      const run = (destination: string) => {
        const operationId = NodeCrypto.randomUUID();
        destinations.set(operationId, destination);
        return source.exchange(operationId);
      };
      expect(await run("m5")).toBe(true);
      expect(await run("m5")).toBe(true);
      // A third live copy to one destination is one past its two.
      expect(await run("m5")).toBe(false);
      expect(await run("mini")).toBe(true);
      expect(await run("mini")).toBe(true);
      // A fifth live generation on the source is one past its four.
      expect(await run("studio")).toBe(false);
      expect(source.liveGenerations()).toBe(4);
    } finally {
      source.close();
    }
    expect(source.liveGenerations()).toBe(0);
  });
});

describe("the idle limit belongs to the generation (AC-09, AC-33)", () => {
  it("ends an unused generation on both machines and does not latch the copy", async () => {
    await prepare();
    const listener = sources.lan!.listenerOf(id)!;
    clock.now = Date.now() + LAN_SOURCE_LIMITS.idleGenerationMs + 1_000;
    listener.tick();
    expect(listener.ended).toBe("idle");
    // The destination's own, slightly shorter limit ended its side: no dial, no latch.
    expect(await copies.lan!.connector(id)).toBeNull();
    expect(JSON.parse(await destinationRecordText()).lan).toMatchObject({
      latch: null,
      accepted: null,
    });
    expect(await within(Promise.resolve(sources.lan!.liveGenerations()), 100)).toBe(0);
  }, 30_000);
});
