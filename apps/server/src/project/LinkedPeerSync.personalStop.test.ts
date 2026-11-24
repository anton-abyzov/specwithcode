// @effect-diagnostics anyUnknownInErrorContext:off -- the seat kit stubs services with loosely typed fakes.
/**
 * A personal memory pass already under way when the owner turns Percy off
 * (1448 D-12): no memory read or saved after that leaves this machine, and
 * nothing more is sent. The pass checks the link it began on and the switch
 * after reading each outbound page and right before each send.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  type EnvironmentId,
  type LinkedMemoryExportInput,
  type LinkedMemoryMergeInput,
  type LogicalProjectMember,
  type Project,
  ProjectPlanError,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

import { HandoffPeerError } from "../handoff/handoffPeers.ts";
import { HandoffRefusal } from "../handoff/HandoffReceiver.ts";
import type { LinkedDigestRequest } from "../handoff/linkedSyncWire.ts";
import { describeCopy, linkedCopyFor } from "./LinkedPeerRoute.ts";
import { type LinkedPeerSyncDeps, makeLinkedPeerSync } from "./LinkedPeerSync.ts";
import * as LinkedPeerSyncState from "./LinkedPeerSyncState.ts";
import { personalLinkIdForAccount } from "./personalLinkId.ts";
import { personalPeerSyncDeps } from "./PersonalPeerSync.ts";
import {
  grantOf,
  makeShareSeat,
  type Network,
  pairUp,
  reconcileRounds,
  type ShareSeat,
  USER,
} from "./personalShare.testkit.ts";

const LINK = personalLinkIdForAccount(USER);

type ExportCall = Omit<LinkedMemoryExportInput, "forProjectId"> & {
  readonly forProjectId?: string;
};

interface Hooks {
  /** Runs before the peer answers a memory export, as the owner acting meanwhile. */
  readonly beforeExport?: (request: ExportCall) => Effect.Effect<void, unknown>;
}

/**
 * One `LinkedPeerSync` pass for `seat`, as the server runs it: the real route
 * gate and digest, the pair roles from the share engine, the switch from its
 * settings, and every memory merge sent to a peer recorded.
 */
const tick = (seat: ShareSeat, all: ReadonlyArray<ShareSeat>, hooks: Hooks = {}) =>
  Effect.gen(function* () {
    const sentMerges: Array<{ to: EnvironmentId; request: LinkedMemoryMergeInput }> = [];
    const others = all.filter((other) => other !== seat);
    const byEnv = (environmentId: EnvironmentId) =>
      others.find((other) => other.environmentId === environmentId)!;
    const describeOn = (target: ShareSeat, project: Project, member: LogicalProjectMember) =>
      describeCopy(
        {
          link: { digest: () => Effect.die("no coordinator digest for a personal seat") },
          memory: target.memory,
          plans: {
            exportLinked: ({ projectId }) =>
              Effect.fail(new ProjectPlanError({ projectId, code: "read_only" })),
          },
        },
        project,
        member,
      );
    const asPeerError = (error: unknown) =>
      error instanceof HandoffRefusal
        ? new HandoffPeerError({ code: error.code, message: error.message, uncertain: false })
        : new HandoffPeerError({ code: "failed", message: String(error), uncertain: false });
    const peers = {
      linkedDigest: (environmentId: EnvironmentId, request: LinkedDigestRequest) => {
        const target = byEnv(environmentId);
        return linkedCopyFor(
          target.projects,
          target.environmentId,
          {
            sourceEnvironmentId: seat.environmentId,
            grant: grantOf(seat.environmentId, "own"),
            runtimeCeiling: "full-access",
            cloudUserId: USER,
          },
          request.projectId,
          request.logicalProjectId,
          USER,
          request.forProjectId,
        ).pipe(
          Effect.flatMap((project) => {
            const member = project.workspaceSettings!.logicalProject!.members.find(
              (entry) => entry.environmentId === target.environmentId,
            )!;
            return describeOn(target, project, member);
          }),
          Effect.mapError(asPeerError),
        );
      },
      memoryExport: (environmentId: EnvironmentId, request: ExportCall) =>
        (hooks.beforeExport?.(request) ?? Effect.void).pipe(
          Effect.andThen(() => {
            const { forProjectId: _caller, ...rest } = request;
            return byEnv(environmentId).memory.memoryExport(rest);
          }),
          Effect.mapError(asPeerError),
        ),
      memoryMerge: (environmentId: EnvironmentId, request: LinkedMemoryMergeInput) =>
        Effect.sync(() => sentMerges.push({ to: environmentId, request })).pipe(
          Effect.andThen(() => byEnv(environmentId).memory.memoryMerge(request)),
          Effect.mapError(asPeerError),
        ),
      reachable: () => Effect.succeed(true),
    } as unknown as LinkedPeerSyncDeps["peers"];
    const deps: LinkedPeerSyncDeps = {
      selfEnvironmentId: seat.environmentId,
      selfLabel: Effect.succeed(seat.label),
      listProjects: Effect.sync(() => [seat.current()]),
      targets: Effect.succeed(
        others.map((other) => ({
          machineId: other.environmentId,
          environmentId: other.environmentId,
          label: other.label,
        })),
      ),
      state: yield* LinkedPeerSyncState.make,
      isHeld: Effect.succeed(false),
      describe: (project, member) => describeOn(seat, project, member) as any,
      content: () => Effect.die("no content for a personal seat"),
      replicate: () => Effect.die("no replica for a personal seat"),
      giveWay: () => Effect.die("no give way for a personal seat"),
      adoptMembers: () => Effect.die("no member lists for a personal seat"),
      addPredecessorMembers: () => Effect.die("no member lists for a personal seat"),
      ...personalPeerSyncDeps(seat.projects, seat.environment),
      personalReach: seat.engine.reach,
      personalSwitchOn: seat.engine.switchOn,
      memory: seat.memory,
      plans: {
        exportLinked: ({ projectId }) =>
          Effect.fail(new ProjectPlanError({ projectId, code: "read_only" })),
        mergeLinked: () => Effect.succeed({} as never),
      },
      peers,
    };
    const sync = yield* makeLinkedPeerSync(deps);
    yield* sync.tick;
    return sentMerges;
  });

/** Desktop drives memory toward Laptop (the lower id, own grants both ways), both linked. */
const linked = Effect.gen(function* () {
  const network: Network = new Map();
  const desktop = yield* makeShareSeat(network, "desktop", "Desktop");
  const laptop = yield* makeShareSeat(network, "laptop", "Laptop");
  desktop.switchOn([laptop.environmentId], { start: true });
  laptop.switchOn([desktop.environmentId]);
  pairUp(desktop, laptop);
  yield* desktop.write("MEMORY.md", "# Memory\n");
  yield* reconcileRounds([desktop, laptop], 4);
  assert.strictEqual(desktop.identity()?.id, LINK);
  assert.strictEqual(laptop.identity()?.id, LINK);
  // A pass first brings the two in step, then a note on each makes the next pass move memory.
  yield* tick(desktop, [desktop, laptop]);
  yield* desktop.write("shared.md", "Desktop shared note.\n");
  yield* laptop.write("laptop.md", "Laptop note.\n");
  return { desktop, laptop, all: [desktop, laptop] };
});

const filesSent = (merges: ReadonlyArray<{ request: LinkedMemoryMergeInput }>) =>
  merges.flatMap((merge) => merge.request.export.files.map((file) => file.name));

describe("LinkedPeerSync: a personal pass under way when Percy is turned off", () => {
  it.effect("the owner turns Percy off and saves a note while the peer's digest is read", () =>
    Effect.gen(function* () {
      const { desktop, laptop, all } = yield* linked;
      let fired = false;
      const merges = yield* tick(desktop, all, {
        beforeExport: (request) =>
          request.digestOnly === true && !fired
            ? Effect.gen(function* () {
                fired = true;
                // As `PersonalShare.setShared(false)`: the switch first, then the seat leaves.
                desktop.switchOff();
                yield* desktop.unlink;
                yield* desktop.write("private.md", "Written after Percy was turned off.\n");
              })
            : Effect.void,
      });
      assert.isTrue(fired);
      assert.notInclude(filesSent(merges), "private.md");
      assert.notInclude(Object.keys(yield* laptop.contents), "private.md");
      // Nothing of this seat's memory went out once it left.
      assert.lengthOf(merges, 0);
    }),
  );

  it.effect("the switch goes off after the pages were read: none of them is sent", () =>
    Effect.gen(function* () {
      const { desktop, laptop, all } = yield* linked;
      let fired = false;
      const merges = yield* tick(desktop, all, {
        // The peer's full page is read after this seat's own pages, just before the merges.
        beforeExport: (request) =>
          request.digestOnly !== true && !fired
            ? Effect.sync(() => {
                fired = true;
                desktop.switchOff();
              })
            : Effect.void,
      });
      assert.isTrue(fired);
      assert.strictEqual(desktop.identity()?.id, LINK);
      assert.lengthOf(merges, 0);
      assert.notInclude(Object.keys(yield* laptop.contents), "shared.md");
    }),
  );

  it.effect("with the switch on and the link unchanged, the pass moves memory both ways", () =>
    Effect.gen(function* () {
      const { desktop, laptop, all } = yield* linked;
      const merges = yield* tick(desktop, all);
      assert.include(filesSent(merges), "shared.md");
      assert.include(Object.keys(yield* laptop.contents), "shared.md");
      assert.include(Object.keys(yield* desktop.contents), "laptop.md");
    }),
  );
});
