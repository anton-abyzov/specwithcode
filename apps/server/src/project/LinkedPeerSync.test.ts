import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  type LinkedServerSyncPair,
  type LogicalProjectMember,
  type Project,
  type ProjectCoordinatorBinding,
  ProjectId,
  ProjectPlanError,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { HandoffPeerError } from "../handoff/handoffPeers.ts";
import type { HandoffRefusal } from "../handoff/HandoffReceiver.ts";
import {
  LINKED_SYNC_PROTOCOL_VERSION,
  type LinkedDigestResponse,
} from "../handoff/linkedSyncWire.ts";
import * as LinkedMemoryPeers from "./LinkedMemoryPeers.ts";
import { LinkedMemorySync } from "./LinkedMemorySync.ts";
import { alpha, beta, machine, members } from "./LinkedMemorySync.testkit.ts";
import { type LinkedPeerSyncDeps, makeLinkedPeerSync, syncErrorOf } from "./LinkedPeerSync.ts";
import * as LinkedPeerSyncState from "./LinkedPeerSyncState.ts";
import { coordinatorContentDigest } from "./ProjectLink.ts";

const member = (name: string): LogicalProjectMember => ({
  environmentId: EnvironmentId.make(`env-${name}`),
  projectId: ProjectId.make(`project-${name}`),
  coordinatorThreadId: ThreadId.make(`coordinator:${name}`),
});
const [a, b] = [member("a"), member("b")];

const projectOn = (self: LogicalProjectMember, binding?: ProjectCoordinatorBinding) =>
  ({
    id: self.projectId,
    deletedAt: null,
    workspaceSettings: {
      kind: "code",
      ...(binding ? { coordinatorBinding: binding } : {}),
      logicalProject: { id: "logical:1", title: "Shared", members: [a, b] },
    },
  }) as unknown as Project;

const described = (
  self: LogicalProjectMember,
  patch: Partial<LinkedDigestResponse> = {},
): LinkedDigestResponse => ({
  protocolVersion: LINKED_SYNC_PROTOCOL_VERSION,
  member: self,
  binding: null,
  coordinatorDigest: `notes-${self.environmentId}`,
  replica: null,
  memoryDigest: "m".repeat(64),
  planDigest: null,
  ...patch,
});

const content = { goal: "Ship", instructions: "Carefully", notes: [], notesTruncated: false };

/**
 * A driver on `self`'s machine whose peer answers from `peer`; every peer
 * call is recorded by path.
 */
const harness = (input: {
  readonly self: LogicalProjectMember;
  readonly binding?: ProjectCoordinatorBinding;
  readonly own?: () => LinkedDigestResponse;
  readonly peer: () => Effect.Effect<LinkedDigestResponse, HandoffPeerError>;
  /** The whole-memory digest the peer's memory export sends. */
  readonly peerMemoryDigest?: string;
  /** Both plans export, so a plan pass runs. */
  readonly plans?: boolean;
  readonly reachable?: () => boolean;
  readonly isHeld?: () => boolean;
}) =>
  Effect.gen(function* () {
    const state = yield* LinkedPeerSyncState.make;
    const calls: string[] = [];
    const record =
      <A>(path: string, answer: A) =>
      () =>
        Effect.sync(() => {
          calls.push(path);
          return answer;
        });
    const peers = {
      linkedDigest: () =>
        Effect.sync(() => calls.push("linked-digest")).pipe(Effect.andThen(input.peer())),
      linkedContent: record("linked-content", {
        ...content,
        member: b,
        epoch: 2,
        digest: coordinatorContentDigest(content),
      }),
      linkedReplica: record("linked-replica", { replicatedAt: "now", replayed: false }),
      linkedSupersede: record("linked-supersede", {}),
      planExport: record("plan-export", {}),
      planMerge: record("plan-merge", { changed: false, revision: 0 }),
      memoryExport: record("memory-export", { digest: input.peerMemoryDigest ?? "p".repeat(64) }),
      memoryMerge: record("memory-merge", {}),
      reachable: () => Effect.sync(() => input.reachable?.() ?? false),
    } as unknown as LinkedPeerSyncDeps["peers"];
    const local: string[] = [];
    const deps: LinkedPeerSyncDeps = {
      selfEnvironmentId: input.self.environmentId,
      selfLabel: Effect.succeed("Here"),
      listProjects: Effect.succeed([projectOn(input.self, input.binding)]),
      targets: Effect.succeed(
        [a, b]
          .filter((other) => other.environmentId !== input.self.environmentId)
          .map((other) => ({
            machineId: other.environmentId,
            environmentId: other.environmentId,
            label: "There",
          })),
      ),
      state,
      isHeld: Effect.sync(() => input.isHeld?.() ?? false),
      describe: (_project, self) =>
        Effect.sync(() => input.own?.() ?? described(self, { binding: input.binding ?? null })),
      content: () =>
        Effect.sync(() => {
          local.push("content");
          return {
            ...content,
            member: input.self,
            epoch: 3,
            digest: coordinatorContentDigest(content),
          };
        }),
      replicate: (request) =>
        Effect.sync(() =>
          local.push(`replicate from ${request.from.environmentId} at ${request.fromEpoch}`),
        ),
      memory: {
        memoryExport: () =>
          Effect.sync(() => {
            local.push("memory-export");
            return { digest: "m".repeat(64) } as never;
          }),
        memoryMerge: () => Effect.sync(() => local.push("memory-merge") as never),
      },
      plans: {
        exportLinked: ({ projectId }) =>
          input.plans === true
            ? Effect.sync(() => {
                local.push("plan-export");
                return {} as never;
              })
            : Effect.fail(new ProjectPlanError({ projectId, code: "read_only" })),
        mergeLinked: () => Effect.sync(() => local.push("plan-merge") as never),
      },
      peers,
    };
    const sync = yield* makeLinkedPeerSync(deps);
    const status = state.status(input.self.projectId);
    return { sync, state, calls, local, status };
  });

const errors = (pairs: ReadonlyArray<LinkedServerSyncPair>) =>
  Object.fromEntries(pairs.map((pair) => [pair.kind, pair.lastError]));

describe("LinkedPeerSync", () => {
  it.effect("drives a pair only from the lower environment ID; the other side only answers", () =>
    Effect.gen(function* () {
      const higher = yield* harness({ self: b, peer: () => Effect.succeed(described(a)) });
      yield* higher.sync.tick;
      assert.deepStrictEqual(higher.calls, []);
      assert.deepStrictEqual(yield* higher.status, []);

      const lower = yield* harness({ self: a, peer: () => Effect.succeed(described(b)) });
      yield* lower.sync.tick;
      // An idle pass exchanges digests and nothing else.
      assert.deepStrictEqual(lower.calls, ["linked-digest"]);
      assert.deepStrictEqual(errors(yield* lower.status), {
        replica: null,
        memory: null,
        plan: null,
      });
    }),
  );

  it.effect("backs a failing pair off, and retries at once when the peer shows it is back", () =>
    Effect.gen(function* () {
      const run = yield* harness({
        self: a,
        peer: () =>
          Effect.fail(
            new HandoffPeerError({ code: "unreachable", message: "No answer.", uncertain: false }),
          ),
      });
      yield* run.sync.tick;
      assert.deepStrictEqual(errors(yield* run.status), {
        replica: "unreachable",
        memory: "unreachable",
        plan: "unreachable",
      });
      yield* run.sync.tick;
      assert.strictEqual(run.calls.length, 1);
      // Two failures in a row: the second waits two minutes.
      yield* TestClock.adjust("61 seconds");
      yield* run.sync.tick;
      assert.strictEqual(run.calls.length, 2);
      yield* TestClock.adjust("61 seconds");
      yield* run.sync.tick;
      assert.strictEqual(run.calls.length, 2);
      yield* run.state.peerSeen(b.environmentId);
      yield* run.sync.tick;
      assert.strictEqual(run.calls.length, 3);
    }),
  );

  it.effect("retries a pair within a pass once a machine it could not reach answers again", () =>
    Effect.gen(function* () {
      let up = false;
      const run = yield* harness({
        self: a,
        peer: () =>
          up
            ? Effect.succeed(described(b))
            : Effect.fail(
                new HandoffPeerError({
                  code: "unreachable",
                  message: "No answer.",
                  uncertain: false,
                }),
              ),
        reachable: () => up,
      });
      yield* run.sync.tick;
      yield* TestClock.adjust("61 seconds");
      yield* run.sync.tick;
      assert.strictEqual(run.calls.length, 2);
      // Backing off for two minutes; still down, so nothing is tried.
      yield* TestClock.adjust("10 seconds");
      yield* run.sync.tick;
      assert.strictEqual(run.calls.length, 2);
      // It answers a probe again: the pair runs now, not after its backoff.
      up = true;
      yield* TestClock.adjust("10 seconds");
      yield* run.sync.tick;
      assert.strictEqual(run.calls.length, 3);
      assert.strictEqual(errors(yield* run.status).memory, null);
    }),
  );

  it.effect("marks memory failed when it still differs after a retry, and keeps trying", () =>
    Effect.gen(function* () {
      const run = yield* harness({
        self: a,
        peer: () => Effect.succeed(described(b, { memoryDigest: "p".repeat(64) })),
      });
      yield* run.sync.tick;
      assert.strictEqual(errors(yield* run.status).memory, "failed");
      const before = run.calls.length;
      yield* TestClock.adjust("61 seconds");
      yield* run.sync.tick;
      // Not memoized as in step: the next pass syncs memory again.
      assert.isAbove(run.calls.slice(before).filter((path) => path === "memory-export").length, 0);
    }),
  );

  it.effect("never takes a kind it skipped as in step from digests read after the pass", () =>
    Effect.gen(function* () {
      let pass = 0;
      /** What this machine's own services were asked, once the harness exists. */
      let asked: ReadonlyArray<string> = [];
      const run = yield* harness({
        self: a,
        plans: true,
        // The plan here changes while the second pass merges memory.
        own: () =>
          described(a, {
            planDigest: pass >= 2 && asked.includes("memory-export") ? "plan-a2" : "plan-a1",
          }),
        peer: () =>
          Effect.succeed(
            described(b, {
              memoryDigest: pass >= 2 ? "p".repeat(64) : "m".repeat(64),
              planDigest: "plan-b1",
            }),
          ),
      });
      asked = run.local;
      pass = 1;
      yield* run.sync.tick;
      assert.isTrue(run.calls.includes("plan-export"));
      // The plans are in step at plan-a1/plan-b1; memory now differs, the plan does not.
      pass = 2;
      run.calls.length = 0;
      run.local.length = 0;
      yield* TestClock.adjust("61 seconds");
      yield* run.sync.tick;
      assert.isFalse(run.calls.includes("plan-export"));
      assert.isTrue(run.local.includes("memory-export"));
      // plan-a2 was never exchanged, so the next pass moves it.
      pass = 3;
      run.calls.length = 0;
      yield* TestClock.adjust("121 seconds");
      yield* run.sync.tick;
      assert.isTrue(run.calls.includes("plan-export"));
    }),
  );

  it.effect("syncs a kind again once its memo is a few minutes old", () =>
    Effect.gen(function* () {
      const run = yield* harness({
        self: a,
        plans: true,
        own: () => described(a, { planDigest: "plan-a" }),
        peer: () => Effect.succeed(described(b, { planDigest: "plan-b" })),
      });
      yield* run.sync.tick;
      assert.isTrue(run.calls.includes("plan-export"));
      run.calls.length = 0;
      yield* TestClock.adjust("61 seconds");
      yield* run.sync.tick;
      assert.isFalse(run.calls.includes("plan-export"));
      yield* TestClock.adjust("5 minutes");
      yield* run.sync.tick;
      assert.isTrue(run.calls.includes("plan-export"));
    }),
  );

  it.effect("stops a memory pass when the service is held for an update", () =>
    Effect.gen(function* () {
      let asked: ReadonlyArray<string> = [];
      const run = yield* harness({
        self: a,
        peer: () => Effect.succeed(described(b, { memoryDigest: "p".repeat(64) })),
        isHeld: () => asked.includes("memory-export"),
      });
      asked = run.local;
      yield* run.sync.tick;
      assert.deepStrictEqual(run.local, ["memory-export"]);
      assert.isFalse(run.calls.includes("memory-export"));
      assert.strictEqual(errors(yield* run.status).memory, "failed");
    }),
  );

  it.effect("from the coordinator, still syncs memory toward an older copy it does not drive", () =>
    Effect.gen(function* () {
      const older = yield* harness({
        self: b,
        binding: { epoch: 1, state: "active" },
        peer: () =>
          Effect.fail(
            new HandoffPeerError({ code: "not_found", message: "not_found", uncertain: false }),
          ),
        peerMemoryDigest: "m".repeat(64),
      });
      yield* older.sync.tick;
      assert.deepStrictEqual(older.calls, ["linked-digest", "memory-export"]);
      assert.deepStrictEqual(errors(yield* older.status), { memory: null });

      // A current copy drives its own pairs: once it answers, nothing more is sent to it.
      const current = yield* harness({
        self: b,
        binding: { epoch: 1, state: "active" },
        peer: () => Effect.succeed(described(a)),
      });
      yield* current.sync.tick;
      assert.deepStrictEqual(current.calls, ["linked-digest"]);
      yield* TestClock.adjust("61 seconds");
      yield* current.sync.tick;
      assert.deepStrictEqual(current.calls, ["linked-digest"]);
    }),
  );

  it.effect("tells an older peer, a missing grant and a refusal apart", () =>
    Effect.gen(function* () {
      const older = yield* harness({
        self: a,
        peer: () =>
          Effect.fail(
            new HandoffPeerError({ code: "not_found", message: "not_found", uncertain: false }),
          ),
        peerMemoryDigest: "m".repeat(64),
      });
      yield* older.sync.tick;
      // Memory still moves over the older memory paths; the rest is left to the app.
      assert.deepStrictEqual(errors(yield* older.status), {
        replica: "outdated",
        memory: null,
        plan: "outdated",
      });
      assert.deepStrictEqual(older.calls, ["linked-digest", "memory-export"]);
      assert.strictEqual(
        syncErrorOf(
          new HandoffPeerError({
            code: "needs_grant",
            message: "No grant.",
            uncertain: false,
            local: true,
          }),
        ),
        "needs_grant",
      );
      assert.strictEqual(
        syncErrorOf(new HandoffPeerError({ code: "invalid", message: "No.", uncertain: false })),
        "refused",
      );
    }),
  );

  it.effect("pushes the coordinator's notes to a member and pulls them into a member", () =>
    Effect.gen(function* () {
      const push = yield* harness({
        self: a,
        binding: { epoch: 3, state: "active" },
        peer: () => Effect.succeed(described(b, { binding: { epoch: 3, state: "transferred" } })),
      });
      yield* push.sync.tick;
      assert.deepStrictEqual(push.local.slice(0, 1), ["content"]);
      assert.isTrue(push.calls.includes("linked-replica"));

      const pull = yield* harness({
        self: a,
        binding: { epoch: 2, state: "transferred" },
        peer: () => Effect.succeed(described(b, { binding: { epoch: 2, state: "active" } })),
      });
      yield* pull.sync.tick;
      assert.isTrue(pull.calls.includes("linked-content"));
      assert.include(pull.local, `replicate from ${b.environmentId} at 2`);
    }),
  );

  it.effect("lets the copy that took over drive giving way, even from the higher ID", () =>
    Effect.gen(function* () {
      const run = yield* harness({
        self: b,
        binding: {
          epoch: 1,
          state: "active",
          operationId: "takeover:1",
          predecessor: a,
          takenOverAt: "2026-11-03T00:00:00.000Z",
        },
        peer: () => Effect.succeed(described(a, { binding: { epoch: 0, state: "active" } })),
      });
      yield* run.sync.tick;
      assert.deepStrictEqual(run.calls, ["linked-digest", "linked-supersede"]);
      assert.deepStrictEqual(errors(yield* run.status), { supersede: null });
    }),
  );
});

/** `alpha`'s driver, reaching `beta` only through beta's memory peer route. */
it.effect("syncs memory both ways through the peer route, and skips a pass with no change", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const left = yield* machine(alpha, "Alpha");
      const right = yield* machine(beta, "Beta");
      yield* left.write("alpha.md", "from alpha");
      yield* right.write("beta.md", "from beta");
      const receiver = yield* Effect.provide(LinkedMemoryPeers.makeReceiver, right.context);
      const caller = { sourceEnvironmentId: alpha.environmentId, grant: null };
      const sent: string[] = [];
      const viaNetwork = <A>(path: string, effect: Effect.Effect<A, HandoffRefusal>) =>
        Effect.sync(() => sent.push(path)).pipe(
          Effect.andThen(effect),
          Effect.mapError(
            (refusal) =>
              new HandoffPeerError({
                code: refusal.code,
                message: refusal.message,
                uncertain: false,
              }),
          ),
        );
      const onAlpha = yield* Effect.provide(Effect.service(LinkedMemorySync), left.context);
      const onBeta = yield* Effect.provide(Effect.service(LinkedMemorySync), right.context);
      const digestOf = (service: LinkedMemorySync["Service"], projectId: ProjectId) =>
        service
          .memoryExport({ projectId, digestOnly: true })
          .pipe(Effect.map((page) => page.digest ?? null));
      const [self, other] = members;
      const state = yield* LinkedPeerSyncState.make;
      const sync = yield* makeLinkedPeerSync({
        selfEnvironmentId: alpha.environmentId,
        selfLabel: Effect.succeed("Alpha"),
        listProjects: Effect.succeed([left.project]),
        targets: Effect.succeed([
          { machineId: "beta", environmentId: beta.environmentId, label: "Beta" },
        ]),
        state,
        isHeld: Effect.succeed(false),
        describe: () =>
          digestOf(onAlpha, alpha.projectId).pipe(
            Effect.map((memoryDigest) => described(self!, { memoryDigest })),
          ),
        content: () => Effect.die("unused"),
        replicate: () => Effect.die("unused"),
        memory: onAlpha,
        plans: {
          exportLinked: ({ projectId }) =>
            Effect.fail(new ProjectPlanError({ projectId, code: "read_only" })),
          mergeLinked: () => Effect.die("unused"),
        },
        peers: {
          linkedDigest: () =>
            digestOf(onBeta, beta.projectId).pipe(
              Effect.map((memoryDigest) => described(other!, { memoryDigest })),
            ),
          memoryExport: (_environmentId: EnvironmentId, request: never) =>
            viaNetwork("memory-export", receiver.memoryExport(caller, request)),
          memoryMerge: (_environmentId: EnvironmentId, request: never) =>
            viaNetwork("memory-merge", receiver.memoryMerge(caller, request)),
        } as unknown as LinkedPeerSyncDeps["peers"],
      });
      yield* sync.tick;
      const both = { "alpha.md": "from alpha", "beta.md": "from beta" };
      assert.deepStrictEqual(yield* left.contents, both);
      assert.deepStrictEqual(yield* right.contents, both);
      assert.isAbove(sent.length, 0);
      // Nothing changed on either side: the next pass moves nothing.
      const before = sent.length;
      yield* TestClock.adjust("61 seconds");
      yield* sync.tick;
      assert.strictEqual(sent.length, before);
      // A later edit on the other copy arrives on the next pass.
      yield* right.write("beta.md", "edited on beta");
      yield* TestClock.adjust("61 seconds");
      yield* sync.tick;
      assert.strictEqual((yield* left.contents)["beta.md"], "edited on beta");
      assert.strictEqual(
        (yield* state.status(alpha.projectId)).find((pair) => pair.kind === "memory")?.lastError,
        null,
      );
    }),
  ),
);
