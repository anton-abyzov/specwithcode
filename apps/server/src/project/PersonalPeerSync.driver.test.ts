/**
 * `LinkedPeerSync` passes for a linked personal assistant (1448 C1, C4): both
 * seats read each other's settings and removals, the driver alone merges
 * memory, each side needs its own grant for the other, a fenced answer is
 * acted on, and a seat whose link changed stops for the rest of the pass.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  type LogicalProjectMember,
  type Project,
  ProjectId,
  ProjectPlanError,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

import { HandoffPeerError } from "../handoff/handoffPeers.ts";
import {
  LINKED_SYNC_PROTOCOL_VERSION,
  type LinkedDigestResponse,
} from "../handoff/linkedSyncWire.ts";
import { PERSONAL_SEAT_LEFT_MESSAGE } from "./LinkedPeerRoute.ts";
import { type LinkedPeerSyncDeps, makeLinkedPeerSync } from "./LinkedPeerSync.ts";
import * as LinkedPeerSyncState from "./LinkedPeerSyncState.ts";

const member = (name: string): LogicalProjectMember => ({
  environmentId: EnvironmentId.make(`env-${name}`),
  projectId: ProjectId.make(`percy-${name}`),
  coordinatorThreadId: ThreadId.make(`coordinator:${name}`),
});
const [a, b, c] = [member("a"), member("b"), member("c")];

const personalOn = (self: LogicalProjectMember, listed: ReadonlyArray<LogicalProjectMember>) =>
  ({
    id: self.projectId,
    title: "Percy",
    deletedAt: null,
    workspaceSettings: {
      kind: "personal",
      logicalProject: { id: "logical:percy", title: "Percy", members: listed },
    },
  }) as unknown as Project;

const described = (self: LogicalProjectMember, memoryDigest: string): LinkedDigestResponse => ({
  protocolVersion: LINKED_SYNC_PROTOCOL_VERSION,
  member: self,
  binding: null,
  coordinatorDigest: "",
  replica: null,
  memoryDigest,
  planDigest: null,
  personalSettings: {
    updatedAt: "2026-11-22T11:00:00.000Z",
    title: "Percy",
    instructions: "",
    icon: null,
    repositoryUrls: [],
  },
});

const harness = (input: {
  readonly self: LogicalProjectMember;
  readonly listed: ReadonlyArray<LogicalProjectMember>;
  readonly peer?: (
    environmentId: EnvironmentId,
  ) => Effect.Effect<LinkedDigestResponse, HandoffPeerError>;
  readonly allowed?: (environmentId: EnvironmentId) => boolean;
  readonly fenced?: "unlinked" | "dropped" | null;
  readonly removalChanged?: boolean;
}) =>
  Effect.gen(function* () {
    const state = yield* LinkedPeerSyncState.make;
    const log: string[] = [];
    const personalFlags: Array<boolean | undefined> = [];
    const peers = {
      linkedDigest: (
        environmentId: EnvironmentId,
        _request: unknown,
        options?: { readonly personal?: boolean },
      ) =>
        Effect.sync(() => {
          log.push(`digest ${environmentId}`);
          personalFlags.push(options?.personal);
        }).pipe(
          Effect.andThen(
            input.peer?.(environmentId) ??
              Effect.succeed(
                described(
                  [a, b, c].find((m) => m.environmentId === environmentId)!,
                  "p".repeat(64),
                ),
              ),
          ),
        ),
      memoryExport: (environmentId: EnvironmentId) =>
        Effect.sync(() => {
          log.push(`memory-export ${environmentId}`);
          return { digest: "p".repeat(64) } as never;
        }),
      memoryMerge: (environmentId: EnvironmentId) =>
        Effect.sync(() => log.push(`memory-merge ${environmentId}`) as never),
      reachable: () => Effect.succeed(true),
    } as unknown as LinkedPeerSyncDeps["peers"];
    const deps: LinkedPeerSyncDeps = {
      selfEnvironmentId: input.self.environmentId,
      selfLabel: Effect.succeed("Here"),
      listProjects: Effect.sync(() => [personalOn(input.self, input.listed)]),
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
      isHeld: Effect.succeed(false),
      describe: (_project, self) => Effect.succeed(described(self, "m".repeat(64))),
      content: () => Effect.die("no content for a personal seat"),
      replicate: () => Effect.die("no replica for a personal seat"),
      giveWay: () => Effect.die("no give way for a personal seat"),
      adoptMembers: () => Effect.die("no member lists for a personal seat"),
      addPredecessorMembers: () => Effect.die("no member lists for a personal seat"),
      syncPersonalSettings: ({ peerSettings }) =>
        Effect.sync(() => log.push(`settings ${peerSettings.updatedAt}`)),
      syncPersonalRemovals: () =>
        Effect.sync(() => {
          log.push("removals");
          return { unlinkedSelf: false, changed: input.removalChanged === true };
        }),
      personalPeerFenced: (_project, peer, message) =>
        Effect.sync(() => {
          log.push(`fenced ${peer.environmentId} ${message}`);
          return input.fenced ?? null;
        }),
      personalPeerAllowed: (environmentId) =>
        Effect.succeed(input.allowed?.(environmentId) ?? true),
      memory: {
        memoryExport: () => Effect.succeed({ digest: "m".repeat(64) } as never),
        memoryMerge: () => Effect.succeed({} as never),
      },
      plans: {
        exportLinked: ({ projectId }) =>
          Effect.fail(new ProjectPlanError({ projectId, code: "read_only" })),
        mergeLinked: () => Effect.succeed({} as never),
      },
      peers,
    };
    const sync = yield* makeLinkedPeerSync(deps);
    return { sync, log, personalFlags };
  });

describe("LinkedPeerSync: linked personal assistant", () => {
  it.effect(
    "the higher seat reads settings and removals too, but leaves memory to the driver",
    () =>
      Effect.gen(function* () {
        const { sync, log, personalFlags } = yield* harness({ self: b, listed: [a, b] });
        yield* sync.tick;
        assert.deepStrictEqual(log, [
          `digest ${a.environmentId}`,
          "removals",
          "settings 2026-11-22T11:00:00.000Z",
        ]);
        assert.deepStrictEqual(personalFlags, [true]);
      }),
  );

  it.effect("the driver reads settings and removals and merges memory", () =>
    Effect.gen(function* () {
      const { sync, log, personalFlags } = yield* harness({ self: a, listed: [a, b] });
      yield* sync.tick;
      assert.includeMembers(log, [
        `digest ${b.environmentId}`,
        "removals",
        "settings 2026-11-22T11:00:00.000Z",
      ]);
      assert.isTrue(log.some((line) => line.startsWith("memory-")));
      assert.isTrue(personalFlags.every((flag) => flag === true));
    }),
  );

  it.effect("skips a peer this machine holds no own grant for, on either side", () =>
    Effect.gen(function* () {
      for (const self of [a, b]) {
        const { sync, log } = yield* harness({ self, listed: [a, b], allowed: () => false });
        yield* sync.tick;
        // The call itself goes (it records this machine's grant there); nothing is taken.
        assert.deepStrictEqual(log, [`digest ${self === a ? b.environmentId : a.environmentId}`]);
      }
    }),
  );

  it.effect("acts on a fenced answer and leaves the seat's other pairs for the next pass", () =>
    Effect.gen(function* () {
      const { sync, log } = yield* harness({
        self: a,
        listed: [a, b, c],
        fenced: "dropped",
        peer: () =>
          Effect.fail(
            new HandoffPeerError({
              code: "fenced",
              message: PERSONAL_SEAT_LEFT_MESSAGE,
              check: "project-link",
              uncertain: false,
            }),
          ),
      });
      yield* sync.tick;
      assert.deepStrictEqual(log, [
        `digest ${b.environmentId}`,
        `fenced ${b.environmentId} ${PERSONAL_SEAT_LEFT_MESSAGE}`,
      ]);
    }),
  );

  it.effect("stops the seat for the pass once a peer's removal changed its link", () =>
    Effect.gen(function* () {
      const { sync, log } = yield* harness({ self: a, listed: [a, b, c], removalChanged: true });
      yield* sync.tick;
      // No settings from the stale copy, no memory, and no pair with c this pass.
      assert.deepStrictEqual(log, [`digest ${b.environmentId}`, "removals"]);
    }),
  );

  it.effect("keeps going when the fenced answer changes nothing here", () =>
    Effect.gen(function* () {
      const { sync, log } = yield* harness({
        self: a,
        listed: [a, b, c],
        fenced: null,
        peer: (environmentId) =>
          environmentId === b.environmentId
            ? Effect.fail(
                new HandoffPeerError({
                  code: "fenced",
                  message: "Some other fence.",
                  check: "project-link",
                  uncertain: false,
                }),
              )
            : Effect.succeed(described(c, "p".repeat(64))),
      });
      yield* sync.tick;
      assert.include(log, `digest ${c.environmentId}`);
    }),
  );
});
