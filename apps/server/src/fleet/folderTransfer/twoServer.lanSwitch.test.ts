// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off globalDate:off - two real copy services over loopback: Connect by HTTP, the local network by TLS.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { folderCopyAllConflictsKey, type FolderCopyLanOffer } from "@specweave-studio/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { DestinationCopies } from "./destinationService.ts";
import { git } from "./folderFixture.testkit.ts";
import { loopbackPolicy, quickClientLimits, quickSourceLimits } from "./lan.testkit.ts";
import { LanDestination } from "./lanDestination.ts";
import { LanSource } from "./lanSource.ts";
import { SourceTransfers } from "./sourceService.ts";
import { serveWithAuthority } from "./transferAuthority.ts";
import { FOLDER_TRANSFER_PREFIX } from "./wire.ts";

/**
 * The grant and the one switch, under the orders that go wrong: a token minted
 * again while a local-network read is deciding, a Connect read between a higher
 * check and its offer, and a retire that must change nothing but a generation.
 */
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
let serviceClock: { now: number | null };
/** Holds the next authority decision open until the test lets it go. */
let gate: { entered: () => void; open: Promise<void> } | null;
let offerHook:
  | ((body: { operationId: string; lan: FolderCopyLanOffer }) => Promise<boolean>)
  | null;
let lanChunks: number;

const sourceRecord = async () =>
  JSON.parse(
    await NodeFSP.readFile(
      NodePath.join(sourceState, "folder-sources", id, "operation.json"),
      "utf8",
    ),
  );
const destinationRecord = async () =>
  JSON.parse(
    await NodeFSP.readFile(
      NodePath.join(destinationState, "folder-copies", id, "operation.json"),
      "utf8",
    ),
  );

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
  git(folder, "init", "-q");
  git(folder, "add", "README.md");
  git(folder, "commit", "-qm", "initial");
  id = NodeCrypto.randomUUID();
  policy = loopbackPolicy();
  serviceClock = { now: null };
  gate = null;
  offerHook = null;
  lanChunks = 0;
  const authority = async () => {
    const held = gate;
    if (held) {
      gate = null;
      held.entered();
      await held.open;
    }
    return null;
  };
  sources = new SourceTransfers(sourceState, {
    now: () => serviceClock.now ?? Date.now(),
    authority,
    lan: (access) =>
      new LanSource({
        access: {
          ...access,
          lanChunks: (operationId, hashes, zstd) => {
            lanChunks += 1;
            return access.lanChunks(operationId, hashes, zstd);
          },
        },
        environmentId: () => "source-env",
        enabled: () => true,
        policy,
        limits: quickSourceLimits,
        // No tick in these tests: every authority decision here belongs to a read.
        watchMs: 600_000,
        peer: {
          probe: (_destination, body) => copies.lan!.probe("source-env", body),
          retire: (_destination, body) => copies.lan!.retired("source-env", body),
          check: (_destination, body) => copies.lan!.check("source-env", body),
          offer: (_destination, body) =>
            offerHook ? offerHook(body) : copies.lan!.offer("source-env", body),
        },
      }),
  });
  copies = new DestinationCopies(destinationState, {
    allowLoopback: true,
    pollMs: 1,
    sleep: async () => {},
    lan: (access) =>
      new LanDestination({
        access,
        environmentId: () => "destination-env",
        enabled: () => true,
        policy,
        limits: quickClientLimits,
        watchMs: 40,
      }),
    fetch: async (input, init) => {
      // Test shim on the Connect path only: let the offer the selection prompted land first.
      if ((init?.method ?? "GET") === "GET" && String(input).endsWith("/manifest")) {
        await sources.lan?.settled(id);
        if ((await copies.lan?.connector(id)) != null)
          return new Response(JSON.stringify({ progress: null }), { status: 202 });
      }
      return fetch(input, init);
    },
  });
  connect = NodeHttp.createServer(async (request, response) => {
    const parts: Array<Buffer> = [];
    for await (const part of request) parts.push(part as Buffer);
    const body = Buffer.concat(parts);
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const result = await serveWithAuthority(async () => null, sources, "source-env", {
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

const offerInput = () => ({
  operationId: id,
  projectId: "source-project",
  folder,
  mode: "copy-only" as const,
  destinationEnvironmentId: "destination-env",
  lanPurpose: "sync-measured" as const,
});

/** Offer, start and review: the copy stands at "previewed" with a live generation. */
async function prepare() {
  const offer = await sources.offer(offerInput());
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
    purpose: "review",
  });
  expect((await settle(["previewed", "failed"])).state).toBe("previewed");
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
  expect(sources.lan!.liveGenerations()).toBe(1);
  return offer;
}

const hello = (token: string) =>
  fetch(`${connectUrl}${FOLDER_TRANSFER_PREFIX}/${id}/hello`, {
    headers: { authorization: `Bearer ${token}` },
  }).then((answer) => answer.status);

describe("the grant is never written back from an earlier read (S-12)", () => {
  it("keeps a replaced token dead when a local-network read was deciding meanwhile", async () => {
    const first = await prepare();
    const connector = (await copies.lan!.connector(id))!;
    // Long enough since the last use that a read refreshes the grant's idle time.
    serviceClock.now = Date.now() + 5 * 60_000;
    let entered!: () => void;
    let release!: () => void;
    const deciding = new Promise<void>((resolve) => {
      entered = resolve;
    });
    gate = {
      entered,
      open: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    // A real read on the generation's TLS socket, held at its authority decision.
    const reading = connector.manifest().catch(() => null);
    await deciding;
    // The offer is retried: the token is minted again and the first one stops working.
    const second = await sources.offer(offerInput());
    expect(second.token).not.toBe(first.token);
    release();
    await reading;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await hello(first.token)).toBe(401);
    expect(await hello(second.token)).toBe(200);
    // On disk too: the saved grant is the new one.
    const saved = (await sourceRecord()).grant;
    expect(saved.tokenSha256).toBe(
      NodeCrypto.createHash("sha256").update(second.token).digest("hex"),
    );
  }, 30_000);

  it("refuses a read whose decision started before the grant ran out and ended after", async () => {
    const offer = await prepare();
    const connector = (await copies.lan!.connector(id))!;
    let entered!: () => void;
    let release!: () => void;
    const deciding = new Promise<void>((resolve) => {
      entered = resolve;
    });
    gate = {
      entered,
      open: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    // A real read on the generation's TLS socket, held at its authority decision.
    const reading = connector.manifest().then(
      () => "served",
      () => "refused",
    );
    await deciding;
    // The grant's deadline passes while the decision is still open.
    serviceClock.now = Date.now() + 8 * 24 * 60 * 60_000;
    release();
    expect(await reading).toBe("refused");
    const record = await sourceRecord();
    expect([record.state, record.grant.revokedReason]).toEqual(["cancelled", "revoked"]);
    expect(await hello(offer.token)).toBe(401);
  }, 30_000);

  it("ends a generation by the retire route without touching the grant", async () => {
    const offer = await prepare();
    const before = (await sourceRecord()).grant;
    serviceClock.now = Date.now() + 5 * 60_000;
    for (const generation of [99, 1]) {
      const answer = await fetch(`${connectUrl}${FOLDER_TRANSFER_PREFIX}/${id}/lan-retire`, {
        method: "POST",
        headers: { authorization: `Bearer ${offer.token}` },
        body: JSON.stringify({ generation }),
      });
      expect(answer.status).toBe(200);
    }
    expect(sources.lan!.liveGenerations()).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Not the idle time, not any other field: a retire is not a use of the grant.
    expect((await sourceRecord()).grant).toEqual(before);
    expect((await sources.read(id))!.grant).toEqual(before);
  }, 30_000);
});

describe("one switch, across a change of generation (S-12)", () => {
  it("stays on Connect when a read falls between a higher check and its offer", async () => {
    await prepare();
    expect((await destinationRecord()).lan).toMatchObject({ generation: 1, accepted: 1 });
    let between: unknown = null;
    offerHook = async (body) => {
      // The higher check has won. Before its block arrives the copy reads: the
      // client asks for the path, gets none, and goes to Connect.
      const path = await copies.lan!.connector(id);
      between = { path, lan: (await destinationRecord()).lan };
      return copies.lan!.offer("source-env", body);
    };
    // The block for the new generation is refused: the copy has switched.
    expect(await sources.lan!.exchange(id)).toBe(false);
    expect(between).toMatchObject({ path: null, lan: { generation: 2, latch: "unreachable" } });
    expect(await copies.lan!.connector(id)).toBeNull();
    expect(copies.lan!.liveGenerations()).toBe(0);
    const served = lanChunks;
    await copies.approve(id);
    const done = await settle(["applied", "failed"]);
    expect(done.state, JSON.stringify(done.error)).toBe("applied");
    expect(done.lan).toMatchObject({ latch: "unreachable" });
    // Every chunk came over Connect; the local network was not used again.
    expect(lanChunks).toBe(served);
    expect(
      (await NodeFSP.readFile(NodePath.join(target, "data.bin"))).equals(
        await NodeFSP.readFile(NodePath.join(folder, "data.bin")),
      ),
    ).toBe(true);
  }, 30_000);
});
