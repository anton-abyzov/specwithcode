// @effect-diagnostics-next-line nodeBuiltinImport:off -- a real fleet key file for the link.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import { verifyDpopProof } from "@specweave-studio/shared/dpop";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import { CONNECT_ORIGIN, ORIGIN, studioToken, target } from "../fleet/fleetMachine.testkit.ts";
import { loadOrCreateFleetProofKey } from "../fleet/fleetProofKey.ts";
import * as FleetTargets from "../fleet/FleetTargets.ts";
import { makeFleetLink } from "../fleet/fleetTransport.ts";
import * as FleetWorkerGrants from "../fleet/FleetWorkerGrants.ts";
import { nodePath as NodePath } from "../nodePath.ts";
import * as PreviousRelease from "./handoffReviewLock.previousRelease.test.fixture.ts";
import { HANDOFF_PEER_PREFIX, type ReplicateMeta } from "./handoffWire.ts";
import { HandoffPeers, layer as handoffPeersLayer } from "./handoffPeers.ts";

const machine = { ...target, connectUrl: CONNECT_ORIGIN };
const heartbeat = {
  sourceEnvironmentId: EnvironmentId.make("env-m4"),
  sourceLabel: "M4",
  leases: [],
};

interface Sent {
  readonly url: string;
  readonly authorization: string | null;
  readonly dpop: string | null;
}

/** The worker on both addresses, the tailnet one down; peer calls need a valid proof. */
function worker(
  grant: string,
  options: {
    readonly offline: Set<string>;
    readonly refuse?: boolean | undefined;
    /** What the machine answers its identity check with; a bare older one by default. */
    readonly descriptor?: unknown;
  },
) {
  const sent: Sent[] = [];
  const fetcher = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    sent.push({
      url: url.toString(),
      authorization: headers.get("authorization"),
      dpop: headers.get("dpop"),
    });
    if (options.offline.has(url.origin)) throw new TypeError("fetch failed");
    if (url.pathname === "/.well-known/studio/environment")
      return Response.json(
        options.descriptor ?? {
          environmentId: "env-m1",
          label: "M1",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "0.2.11",
          capabilities: { repositoryIdentity: true },
        },
      );
    const proven =
      options.refuse !== true &&
      headers.get("authorization") === `DPoP ${grant}` &&
      verifyDpopProof({
        proof: headers.get("dpop"),
        method: init?.method ?? "GET",
        url: url.toString(),
        // @effect-diagnostics-next-line globalDate:off -- DPoP proofs carry wall-clock seconds.
        nowEpochSeconds: Math.floor(Date.now() / 1000),
        expectedAccessToken: grant,
      }).ok;
    if (!proven) return Response.json({ error: "unauthorized" }, { status: 401 });
    // This worker is from before Sync extras: it has no such path.
    if (url.pathname.includes("/extras-"))
      return Response.json({ error: "not_found", code: "not_found" }, { status: 404 });
    if (url.pathname.endsWith("/replicate")) return Response.json({ sequence: 1 });
    return Response.json({ machineLabel: "M1", continued: [] });
  }) as typeof fetch;
  return { fetcher, sent };
}

const withPeers = <A, E>(
  input: {
    readonly grant: (thumbprint: string) => string;
    readonly offline: Set<string>;
    readonly refuse?: boolean;
    readonly descriptor?: unknown;
  },
  body: (
    peers: HandoffPeers["Service"],
    context: { readonly sent: ReadonlyArray<Sent>; readonly rejected: ReadonlyArray<string> },
  ) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-peers-connect-"));
    const key = yield* Effect.promise(() => loadOrCreateFleetProofKey(baseDir));
    const grant = input.grant(key.thumbprint);
    const remote = worker(grant, {
      offline: input.offline,
      refuse: input.refuse,
      descriptor: input.descriptor,
    });
    const rejected: string[] = [];
    const layer = handoffPeersLayer.pipe(
      Layer.provide(
        Layer.mock(FleetWorkerGrants.FleetWorkerGrants)({
          credential: () =>
            Effect.succeed({
              target: machine,
              accessToken: grant,
              access: "auto" as const,
              expiresAt: "2070-01-01T00:00:00.000Z",
            }),
          reportRejected: (_machineId, accessToken) =>
            Effect.sync(() => {
              rejected.push(accessToken);
            }),
        }),
      ),
      Layer.provide(
        Layer.succeed(FleetTargets.FleetTargets, {
          load: Effect.succeed({ version: 1 as const, machines: [machine] }),
          fetch: remote.fetcher,
          link: makeFleetLink({ fetch: remote.fetcher, baseDir }),
        }),
      ),
    );
    return yield* Effect.gen(function* () {
      return yield* body(yield* HandoffPeers, { sent: remote.sent, rejected });
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true }))),
    );
  });

describe("handoff peers over SpecWithCode Connect", () => {
  it.effect("posts to the Connect address with a fresh proof when the tailnet is down", () =>
    withPeers(
      {
        grant: (jkt) => studioToken({ sid: "grant", jkt }),
        offline: new Set([ORIGIN]),
      },
      (peers, { sent }) =>
        Effect.gen(function* () {
          expect(yield* peers.heartbeat(machine.environmentId, heartbeat)).toEqual({
            machineLabel: "M1",
            continued: [],
          });
          yield* peers.heartbeat(machine.environmentId, heartbeat);
          const posts = sent.filter((call) => call.url.includes(HANDOFF_PEER_PREFIX));
          expect(posts.map((call) => call.url)).toEqual([
            `${CONNECT_ORIGIN}${HANDOFF_PEER_PREFIX}/heartbeat`,
            `${CONNECT_ORIGIN}${HANDOFF_PEER_PREFIX}/heartbeat`,
          ]);
          expect(posts[0]!.dpop).not.toBe(posts[1]!.dpop);
          expect(sent.some((call) => call.authorization?.startsWith("Bearer ") === true)).toBe(
            false,
          );
          // Identity was checked once per address within the cache window.
          expect(
            sent.filter((call) => call.url === `${CONNECT_ORIGIN}/.well-known/studio/environment`),
          ).toHaveLength(1);
        }),
    ),
  );

  it.effect("reads a machine without the Sync extras paths as needing an update", () =>
    withPeers(
      { grant: (jkt) => studioToken({ sid: "grant", jkt }), offline: new Set([ORIGIN]) },
      (peers, { sent }) =>
        Effect.gen(function* () {
          const request = {
            sourceEnvironmentId: EnvironmentId.make("env-m4"),
            sourceProjectId: ProjectId.make("project-m4"),
            repositoryPath: "",
          };
          const negotiated = yield* Effect.result(
            peers.extrasNegotiate(machine.environmentId, { ...request, candidates: [] }),
          );
          const replicated = yield* Effect.result(
            peers.extrasReplicate(
              machine.environmentId,
              {
                ...request,
                sourceLabel: "M4",
                operationId: "0a1b2c3d-1111-4222-8333-444455556666",
                leaf: "main",
                commit: "a".repeat(40),
              },
              new Uint8Array([1, 2, 3]),
            ),
          );
          const failures = [
            Result.isFailure(negotiated) ? negotiated.failure : null,
            Result.isFailure(replicated) ? replicated.failure : null,
          ];
          for (const failure of failures) {
            expect(failure).toMatchObject({ needsUpdate: true, uncertain: false });
            expect(failure?.message).toContain("Update SpecWithCode");
          }
          expect(
            sent.filter((call) => call.url.includes("/extras-")).map((call) => call.url),
          ).toEqual([
            `${CONNECT_ORIGIN}${HANDOFF_PEER_PREFIX}/extras-negotiate`,
            `${CONNECT_ORIGIN}${HANDOFF_PEER_PREFIX}/extras-replicate`,
          ]);
        }),
    ),
  );

  it.effect("keeps a bearer grant off the Connect address", () =>
    withPeers(
      { grant: () => studioToken({ sid: "bearer" }), offline: new Set([ORIGIN]) },
      (peers, { sent }) =>
        Effect.gen(function* () {
          const result = yield* Effect.result(peers.heartbeat(machine.environmentId, heartbeat));
          expect(Result.isFailure(result) && result.failure.code).toBe("needs_grant");
          // Connect is only asked who it is, with no credential.
          expect(
            sent
              .filter((call) => call.url.startsWith(CONNECT_ORIGIN))
              .map((call) => [call.url, call.authorization ?? null]),
          ).toEqual([[`${CONNECT_ORIGIN}/.well-known/studio/environment`, null]]);
        }),
    ),
  );

  it.effect("reads no answer from any address as unreachable, not as a local failure", () =>
    withPeers(
      {
        grant: (jkt) => studioToken({ sid: "grant", jkt }),
        offline: new Set([ORIGIN, CONNECT_ORIGIN]),
      },
      (peers) =>
        Effect.gen(function* () {
          const result = yield* Effect.result(peers.heartbeat(machine.environmentId, heartbeat));
          expect(Result.isFailure(result) && result.failure.code).toBe("unreachable");
          // Continue here reads a local failure as "could not ask", never as silence.
          expect(Result.isFailure(result) && result.failure.local).toBeUndefined();
        }),
    ),
  );

  it.effect("still reports a refused grant over Connect", () =>
    withPeers(
      {
        grant: (jkt) => studioToken({ sid: "revoked", jkt }),
        offline: new Set([ORIGIN]),
        refuse: true,
      },
      (peers, { rejected }) =>
        Effect.gen(function* () {
          const result = yield* Effect.result(peers.heartbeat(machine.environmentId, heartbeat));
          expect(Result.isFailure(result) && result.failure.code).toBe("needs_grant");
          expect(rejected).toHaveLength(1);
        }),
    ),
  );
});

/** A checkpoint message for one thread, with or without a reviewer lock. */
const checkpointMessage = (reviewLock: ReplicateMeta["reviewLock"]): ReplicateMeta =>
  ({
    sourceEnvironmentId: EnvironmentId.make("env-m4"),
    sourceLabel: "M4",
    sourceProjectId: ProjectId.make("project-m4"),
    sourceThreadId: "thread-1",
    repositoryPath: "",
    title: "Review the fix",
    modelSelection: { instanceId: "codex", model: "gpt-5.5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    checkpoint: {
      sequence: 1,
      commit: "a".repeat(40),
      baseCommit: "b".repeat(40),
      branch: "feat/x",
      ref: "refs/specwithcode/handoff/thread-1",
      createdAt: "2026-10-20T14:00:00.000Z",
      reason: "turn-end",
      skipped: [],
      excludedSecretCount: 0,
      transcriptMessageCount: 0,
      note: null,
      pushedToOrigin: false,
      epoch: 1,
      latestRunId: null,
      turnKey: "thread-1/run-1",
      runEnding: "usage-limit",
      sideEffects: [],
      sourceRoot: {
        environmentId: EnvironmentId.make("env-m4"),
        projectId: ProjectId.make("project-m4"),
        threadId: "thread-1",
        workspaceRoot: "/repo",
        branch: "feat/x",
      },
    },
    lease: null,
    transcript: [],
    execution: null,
    reviewLock,
  }) as unknown as ReplicateMeta;

const openaiLock = {
  marker: "routing" as const,
  families: ["openai" as const],
  policy: {},
};

describe("a reviewer lock and the machine it is sent to (1390 AC-40)", () => {
  const replicatePosts = (sent: ReadonlyArray<Sent>) =>
    sent.filter((call) => call.url.endsWith(`${HANDOFF_PEER_PREFIX}/replicate`));

  it.effect(
    `a machine on the previous release (${PreviousRelease.PREVIOUS_RELEASE}) is never sent a review: nothing is posted`,
    () =>
      withPeers(
        {
          grant: (jkt) => studioToken({ sid: "grant", jkt }),
          offline: new Set([ORIGIN]),
          descriptor: PreviousRelease.descriptor("env-m1", "M1"),
        },
        (peers, { sent }) =>
          Effect.gen(function* () {
            const refused = yield* Effect.flip(
              peers.replicate(machine.environmentId, checkpointMessage(openaiLock), null),
            );
            expect(refused).toMatchObject({ code: "invalid", uncertain: false, local: true });
            expect(refused.message).toBe("Review stays here: update SpecWithCode on M1.");
            expect(replicatePosts(sent)).toHaveLength(0);
            // A thread that is no review still goes to that machine.
            yield* peers.replicate(machine.environmentId, checkpointMessage(null), null);
            expect(replicatePosts(sent)).toHaveLength(1);
          }),
      ),
  );

  it.effect("a machine that says it keeps the lock is sent the review", () =>
    withPeers(
      {
        grant: (jkt) => studioToken({ sid: "grant", jkt }),
        offline: new Set([ORIGIN]),
        descriptor: {
          ...PreviousRelease.descriptor("env-m1", "M1"),
          capabilities: { ...PreviousRelease.descriptorCapabilities, handoffReviewLock: true },
        },
      },
      (peers, { sent }) =>
        Effect.gen(function* () {
          yield* peers.replicate(machine.environmentId, checkpointMessage(openaiLock), null);
          expect(replicatePosts(sent)).toHaveLength(1);
        }),
    ),
  );
});
