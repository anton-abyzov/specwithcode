import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  type LinkedServerSyncPair,
  ProjectLinkError,
  type ProjectSupersedeInput,
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
const [a, b, c] = [member("a"), member("b"), member("c")];

const projectOn = (
  self: LogicalProjectMember,
  binding?: ProjectCoordinatorBinding,
  listed: ReadonlyArray<LogicalProjectMember> = [a, b],
) =>
  ({
    id: self.projectId,
    deletedAt: null,
    workspaceSettings: {
      kind: "code",
      ...(binding ? { coordinatorBinding: binding } : {}),
      logicalProject: { id: "logical:1", title: "Shared", members: listed },
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
  /** How this copy giving way goes; it succeeds by default. */
  readonly giveWay?: (input: ProjectSupersedeInput) => Effect.Effect<unknown, ProjectLinkError>;
  /** The members this copy lists; read on every pass. */
  readonly listed?: () => ReadonlyArray<LogicalProjectMember>;
  /** What the peer's `linked-members` does. */
  readonly linkedMembers?: () => Effect.Effect<unknown, HandoffPeerError>;
  /** What the peer answers to `linked-supersede`. */
  readonly supersedeAnswer?: unknown;
  /** Runs when this copy adopts a list. */
  readonly onAdopt?: (members: ReadonlyArray<LogicalProjectMember>) => void;
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
      linkedSupersede: record("linked-supersede", input.supersedeAnswer ?? {}),
      linkedMembers: (
        _environmentId: EnvironmentId,
        request: { members: ReadonlyArray<unknown> },
      ) =>
        Effect.sync(() => calls.push(`linked-members ${request.members.length}`)).pipe(
          Effect.andThen(
            input.linkedMembers?.() ?? Effect.succeed({ replayed: false, changed: true }),
          ),
        ),
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
      listProjects: Effect.sync(() => [
        projectOn(input.self, input.binding, input.listed?.() ?? [a, b]),
      ]),
      targets: Effect.succeed(
        [a, b, c]
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
      giveWay: (request) =>
        Effect.sync(() =>
          local.push(
            `give way to ${request.successor.environmentId} at ${request.coordinatorBinding.epoch}`,
          ),
        ).pipe(Effect.andThen(input.giveWay?.(request) ?? Effect.void)),
      adoptMembers: (request) =>
        Effect.sync(() => {
          local.push(
            `adopt ${request.members.length} from ${request.from.environmentId} at ${request.fromEpoch}`,
          );
          input.onAdopt?.(request.members);
          return { changed: true };
        }),
      addPredecessorMembers: (request) =>
        Effect.sync(() => {
          local.push(
            `add ${request.members.length} from predecessor ${request.predecessor.environmentId}`,
          );
          return { changed: true };
        }),
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
      // Too old to read a takeover from: watching it is left to the app.
      assert.deepStrictEqual(errors(yield* older.status), { supersede: "outdated", memory: null });
      // "outdated" never backs the pair off: memory still moves in the very next pass.
      yield* TestClock.adjust("61 seconds");
      yield* older.sync.tick;
      assert.deepStrictEqual(older.calls, [
        "linked-digest",
        "memory-export",
        "linked-digest",
        "memory-export",
      ]);
      assert.deepStrictEqual(errors(yield* older.status), { supersede: "outdated", memory: null });

      // A current copy drives its own pairs: once it answers, only its digest is read each pass,
      // to see whether it took over from this copy.
      const current = yield* harness({
        self: b,
        binding: { epoch: 1, state: "active" },
        peer: () => Effect.succeed(described(a)),
      });
      yield* current.sync.tick;
      assert.deepStrictEqual(current.calls, ["linked-digest"]);
      yield* TestClock.adjust("61 seconds");
      yield* current.sync.tick;
      assert.deepStrictEqual(current.calls, ["linked-digest", "linked-digest"]);
      assert.deepStrictEqual(current.local, []);
      assert.deepStrictEqual(errors(yield* current.status), { supersede: null });
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

  // The copy that took over (a, the lower ID) cannot reach this one (no grant here), and
  // there is no standby lease: before, this copy read a's digest once and never again, and
  // kept coordinating at epoch 0 beside a at epoch 1.
  const takenOverBy = (successor: LogicalProjectMember, previous: LogicalProjectMember) =>
    described(successor, {
      binding: {
        epoch: 1,
        state: "active",
        operationId: "takeover:1",
        predecessor: previous,
        takenOverAt: "2026-11-03T00:00:00.000Z",
        takenOverBy: "person",
      },
    });

  it.effect("gives way itself, in its next pass, when a copy it does not drive took over", () =>
    Effect.gen(function* () {
      let tookOver = false;
      const run = yield* harness({
        self: b,
        binding: { epoch: 0, state: "active" },
        peer: () => Effect.succeed(tookOver ? takenOverBy(a, b) : described(a)),
      });
      yield* run.sync.tick;
      assert.deepStrictEqual(run.local, []);
      // a takes over while b is away; b's next pass, a minute on, reads it.
      tookOver = true;
      yield* TestClock.adjust("61 seconds");
      yield* run.sync.tick;
      assert.deepStrictEqual(run.calls, ["linked-digest", "linked-digest"]);
      assert.deepStrictEqual(run.local, [`give way to ${a.environmentId} at 1`]);
      assert.deepStrictEqual(errors(yield* run.status), { supersede: null });
      // Given way: no coordinator turn is held back any more by the sighting.
      assert.isUndefined(yield* run.state.supersededFor(`project-coordinator:${b.projectId}`));
    }),
  );

  it.effect("gives way itself while driving the pair, from the lower ID", () =>
    Effect.gen(function* () {
      const run = yield* harness({
        self: a,
        binding: { epoch: 0, state: "active" },
        peer: () => Effect.succeed(takenOverBy(b, a)),
      });
      yield* run.sync.tick;
      assert.deepStrictEqual(run.local.slice(0, 1), [`give way to ${b.environmentId} at 1`]);
      assert.isFalse(run.calls.includes("linked-supersede"));
    }),
  );

  it.effect("holds coordinator turns back while it cannot give way yet, and retries", () =>
    Effect.gen(function* () {
      let refuse = true;
      const run = yield* harness({
        self: b,
        binding: { epoch: 0, state: "active" },
        peer: () => Effect.succeed(takenOverBy(a, b)),
        giveWay: () =>
          refuse ? Effect.fail(new ProjectLinkError({ code: "standby_unreachable" })) : Effect.void,
      });
      yield* run.sync.tick;
      assert.deepStrictEqual(errors(yield* run.status), { supersede: "failed" });
      const seen = yield* run.state.supersededFor(b.coordinatorThreadId);
      assert.strictEqual(seen?.epoch, 1);
      assert.strictEqual(seen?.successorEnvironmentId, a.environmentId);
      assert.isDefined(yield* run.state.supersededFor(`project-coordinator:${b.projectId}`));
      assert.isUndefined(yield* run.state.supersededFor("some-other-thread"));
      refuse = false;
      yield* TestClock.adjust("61 seconds");
      yield* run.sync.tick;
      assert.deepStrictEqual(errors(yield* run.status), { supersede: null });
      assert.isUndefined(yield* run.state.supersededFor(b.coordinatorThreadId));
    }),
  );

  it.effect("never gives way when the digest answers as another copy than the one called", () =>
    Effect.gen(function* () {
      // Called as a, the answer names c: no takeover is read from it, and no turn is held.
      const c = member("c");
      const run = yield* harness({
        self: b,
        binding: { epoch: 0, state: "active" },
        peer: () => Effect.succeed(takenOverBy(c, b)),
      });
      yield* run.sync.tick;
      assert.deepStrictEqual(run.local, []);
      assert.isUndefined(yield* run.state.supersededFor(b.coordinatorThreadId));
      // Nor when only the project differs.
      const otherProject = yield* harness({
        self: b,
        binding: { epoch: 0, state: "active" },
        peer: () =>
          Effect.succeed(takenOverBy({ ...a, projectId: ProjectId.make("project-x") }, b)),
      });
      yield* otherProject.sync.tick;
      assert.deepStrictEqual(otherProject.local, []);
      assert.isUndefined(yield* otherProject.state.supersededFor(b.coordinatorThreadId));
    }),
  );

  it.effect("lifts the hold on turns when its own supersede refuses the takeover for good", () =>
    Effect.gen(function* () {
      const run = yield* harness({
        self: b,
        binding: { epoch: 0, state: "active" },
        peer: () => Effect.succeed(takenOverBy(a, b)),
        giveWay: () => Effect.fail(new ProjectLinkError({ code: "superseded_conflict" })),
      });
      yield* run.sync.tick;
      assert.deepStrictEqual(run.local, [`give way to ${a.environmentId} at 1`]);
      assert.deepStrictEqual(errors(yield* run.status), { supersede: "failed" });
      // A refusal that can never change does not stop this coordinator for good.
      assert.isUndefined(yield* run.state.supersededFor(b.coordinatorThreadId));
      // It is still tried again each pass, in case the copies change.
      yield* TestClock.adjust("61 seconds");
      yield* run.sync.tick;
      assert.strictEqual(run.local.length, 2);
    }),
  );

  it.effect("never gives way to a copy that took over from another one, or at a lower epoch", () =>
    Effect.gen(function* () {
      const elsewhere = yield* harness({
        self: b,
        binding: { epoch: 0, state: "active" },
        peer: () => Effect.succeed(takenOverBy(a, member("c"))),
      });
      yield* elsewhere.sync.tick;
      assert.deepStrictEqual(elsewhere.local, []);

      const newer = yield* harness({
        self: b,
        binding: { epoch: 2, state: "active" },
        peer: () => Effect.succeed(takenOverBy(a, b)),
      });
      yield* newer.sync.tick;
      assert.deepStrictEqual(newer.local, []);
      assert.isUndefined(yield* newer.state.supersededFor(b.coordinatorThreadId));
    }),
  );

  describe("member lists", () => {
    const active = { epoch: 3, state: "active" as const };
    const transferred = { epoch: 3, state: "transferred" as const, successor: a };

    it.effect("the coordinator pushes linked-members when the member lists fewer machines", () =>
      Effect.gen(function* () {
        const run = yield* harness({
          self: a,
          binding: active,
          listed: () => [a, b, c],
          peer: () => Effect.succeed(described(b, { binding: transferred, members: [a, b] })),
        });
        yield* run.sync.tick;
        assert.include(run.calls, "linked-members 3");
        // Member sync stays outside what the app reads.
        assert.deepStrictEqual(Object.keys(errors(yield* run.status)).toSorted(), [
          "memory",
          "plan",
          "replica",
        ]);
      }),
    );

    it.effect("sends nothing when the sets match, whatever their order or folders", () =>
      Effect.gen(function* () {
        const run = yield* harness({
          self: a,
          binding: active,
          listed: () => [a, b, c],
          peer: () =>
            Effect.succeed(
              described(b, {
                binding: transferred,
                members: [c, { ...b, workspaceRoot: "/elsewhere" }, a],
              }),
            ),
        });
        yield* run.sync.tick;
        assert.isFalse(run.calls.some((call) => call.startsWith("linked-members")));
      }),
    );

    it.effect("a member that drives pulls the coordinator's list and starts the new pairs", () =>
      Effect.gen(function* () {
        let listed: ReadonlyArray<LogicalProjectMember> = [a, b];
        const run = yield* harness({
          self: a,
          binding: { epoch: 2, state: "transferred", successor: b },
          listed: () => listed,
          onAdopt: (members) => {
            listed = members;
          },
          peer: () =>
            Effect.succeed(
              described(b, { binding: { epoch: 2, state: "active" }, members: [a, b, c] }),
            ),
        });
        const before = yield* run.sync.signature;
        yield* run.sync.tick;
        assert.include(run.local, `adopt 3 from ${b.environmentId} at 2`);
        const after = yield* run.sync.signature;
        assert.notStrictEqual(after, before);
        assert.include(after, c.environmentId);
      }),
    );

    it.effect("never pulls from a copy that is not its successor or answers for another copy", () =>
      Effect.gen(function* () {
        for (const answer of [
          // C claims to coordinate one takeover later; only the app may vouch for that.
          described(c, { binding: { epoch: 3, state: "active" }, members: [a, b, c] }),
          // B answers, but for another copy than the one listed.
          described(
            { ...b, projectId: ProjectId.make("project-other") },
            {
              binding: { epoch: 2, state: "active" },
              members: [a, b, c],
            },
          ),
        ]) {
          const run = yield* harness({
            self: a,
            binding: { epoch: 2, state: "transferred", successor: b },
            listed: () => [a, b, c],
            peer: () => Effect.succeed(answer),
          });
          yield* run.sync.tick;
          assert.isFalse(run.local.some((call) => call.startsWith("adopt")));
          assert.isFalse(run.calls.some((call) => call.startsWith("linked-members")));
        }
      }),
    );

    it.effect("a successor that gave way in turn relays its own successor's list", () =>
      Effect.gen(function* () {
        // A gave way to B, B gave way to C: A takes what B learned from C.
        const run = yield* harness({
          self: a,
          binding: { epoch: 2, state: "transferred", successor: b },
          peer: () =>
            Effect.succeed(
              described(b, {
                binding: { epoch: 4, state: "transferred", successor: c },
                members: [a, b, c],
              }),
            ),
        });
        yield* run.sync.tick;
        assert.isTrue(run.local.some((call) => call.startsWith("adopt")));
      }),
    );

    it.effect("an older peer without members gets nothing and keeps its outcomes", () =>
      Effect.gen(function* () {
        const run = yield* harness({
          self: a,
          binding: active,
          listed: () => [a, b, c],
          peer: () => Effect.succeed(described(b, { binding: transferred })),
        });
        yield* run.sync.tick;
        assert.isFalse(run.calls.some((call) => call.startsWith("linked-members")));
        assert.deepStrictEqual(errors(yield* run.status), {
          replica: null,
          memory: null,
          plan: null,
        });
      }),
    );

    it.effect("a failed linked-members leaves the outcomes and the backoff as they were", () =>
      Effect.gen(function* () {
        const run = yield* harness({
          self: a,
          binding: active,
          listed: () => [a, b, c],
          peer: () => Effect.succeed(described(b, { binding: transferred, members: [a, b] })),
          linkedMembers: () =>
            Effect.fail(
              new HandoffPeerError({ code: "invalid", message: "Refused.", uncertain: false }),
            ),
        });
        yield* run.sync.tick;
        assert.deepStrictEqual(errors(yield* run.status), {
          replica: null,
          memory: null,
          plan: null,
        });
        const sent = () => run.calls.filter((call) => call.startsWith("linked-members")).length;
        assert.strictEqual(sent(), 1);
        // A refused list is not sent again every pass while both lists stay as they were.
        for (let pass = 0; pass < 5; pass++) {
          yield* TestClock.adjust("61 seconds");
          yield* run.sync.tick;
        }
        assert.strictEqual(sent(), 1);
        assert.deepStrictEqual(errors(yield* run.status), {
          replica: null,
          memory: null,
          plan: null,
        });
        // Once the hold runs out it is tried again.
        yield* TestClock.adjust("10 minutes");
        yield* run.sync.tick;
        assert.strictEqual(sent(), 2);
      }),
    );

    it.effect("the copy that took over adds the members its predecessor answers with", () =>
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
          supersedeAnswer: {
            coordinatorBinding: { epoch: 1, state: "transferred" },
            replayed: false,
            members: [a, b, c],
          },
          peer: () => Effect.succeed(described(a, { binding: { epoch: 0, state: "active" } })),
        });
        yield* run.sync.tick;
        assert.include(run.local, `add 3 from predecessor ${a.environmentId}`);
        assert.deepStrictEqual(errors(yield* run.status), { supersede: null });
      }),
    );
  });
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
        giveWay: () => Effect.die("unused"),
        adoptMembers: () => Effect.die("unused"),
        addPredecessorMembers: () => Effect.die("unused"),
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
