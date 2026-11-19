/**
 * Keeps the thread that launched a worker waiting for it after the worker is
 * handed off to another machine.
 *
 * On this machine the handed-off run ends interrupted, which reports nothing,
 * and the continuation runs where no launcher of it exists. So before the
 * takeover is sent the source writes a remote worker row for the continuation
 * (its id is known up front, see `continuationThreadId`) with the launcher as
 * caller, and RemoteWorkerFollower delivers the continuation's result once.
 * The other machine needs nothing new: its wait is open to any thread of a
 * project the work grant covers, the grant a handoff already requires.
 *
 * The row starts "awaiting": the continuation may not exist yet, and one that
 * arrives idle has no run to report. A definite refusal retires the row; the
 * same handoff sent again, or its receipt arriving late, brings it back.
 */
import type {
  EnvironmentId,
  OrchestrationV2ThreadShell,
  ProjectId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as RemoteWorkerFollower from "../fleet/RemoteWorkerFollower.ts";
import * as RemoteWorkerStore from "../fleet/RemoteWorkerStore.ts";
import type * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { firstMessageSender, launchedByAgent } from "../project/LaunchedWorkerWake.ts";
import type { HandoffPeers } from "./handoffPeers.ts";
import { continuationThreadId } from "./HandoffReceiver.ts";

/** Why a retired row stopped: the takeover it was written for never happened. */
export const HANDOFF_NOT_TAKEN = "The other machine did not take this thread.";

export interface HandoffFollowInput {
  readonly shell: Pick<
    OrchestrationV2ThreadShell,
    "id" | "projectId" | "title" | "lineage" | "createdBy" | "creationSource" | "origin" | "deletedAt"
  >;
  readonly destination: EnvironmentId;
  /** The epoch the destination takes over at. */
  readonly epoch: number;
}

export interface HandoffFollowShape {
  /**
   * Before the takeover is sent, and again before it is re-sent after a restart
   * or a lost answer: follows the continuation it will create.
   */
  readonly register: (input: HandoffFollowInput) => Effect.Effect<void>;
  /** The destination continued the thread: follows what it answered. Safe to repeat. */
  readonly confirm: (
    input: HandoffFollowInput & {
      readonly continuation: {
        readonly threadId: ThreadId;
        readonly projectId?: ProjectId | undefined;
      };
    },
  ) => Effect.Effect<void>;
  /** The destination definitely did not take the thread: nothing to follow. */
  readonly retire: (input: {
    readonly threadId: ThreadId;
    readonly epoch: number;
  }) => Effect.Effect<void>;
}

/** Where remote workers are not followed (no fleet): a handoff follows nothing. */
export const none: HandoffFollowShape = {
  register: () => Effect.void,
  confirm: () => Effect.void,
  retire: () => Effect.void,
};

export interface HandoffFollowDependencies {
  readonly self: EnvironmentId;
  readonly store: RemoteWorkerStore.RemoteWorkerStore["Service"];
  readonly follower: Pick<RemoteWorkerFollower.RemoteWorkerFollower["Service"], "follow">;
  readonly projections: Pick<ProjectionStore.ProjectionStoreV2Shape, "getThreadRecords">;
  /** This machine's name for `environmentId` in its fleet, when it has one. */
  readonly machineIdOf: (environmentId: EnvironmentId) => Effect.Effect<string | undefined>;
}

/** One row per takeover: a retry at the same epoch finds the row of the first try. */
export const handoffFollowRowId = (self: string, threadId: string, epoch: number) =>
  `handoff-follow:${continuationThreadId(self, threadId, epoch).slice("handoff:".length)}`;

const nothingDelivered = (row: RemoteWorkerStore.RemoteWorkerRecord) =>
  row.deliveredRunIds.length === 0 && (row.lastWakeRunId ?? null) === null;

/** A row whose following ended before any result, in a way a new receipt overturns. */
const revivable = (row: RemoteWorkerStore.RemoteWorkerRecord) =>
  nothingDelivered(row) &&
  (row.state === "stopped" || (row.state === "disposed" && row.lastError === HANDOFF_NOT_TAKEN));

export const make = (dependencies: HandoffFollowDependencies): HandoffFollowShape => {
  const { self, store, follower, projections } = dependencies;

  /** The thread waiting for this worker: the one whose agent sent its first message. */
  const launcherOf = (shell: HandoffFollowInput["shell"]) =>
    launchedByAgent(shell)
      ? projections.getThreadRecords(shell.id, ["messages"], { messageRoles: ["user"] }).pipe(
          Effect.map(({ messages }) => firstMessageSender(messages, shell.id)),
          Effect.orElseSucceed(() => undefined),
        )
      : Effect.succeed(undefined);

  const quiet = (what: string, threadId: string) => (effect: Effect.Effect<void, unknown>) =>
    effect.pipe(
      // Following is best effort: it never fails or delays the handoff itself.
      Effect.catchCause((cause) =>
        Effect.logWarning(`Handoff could not ${what} the thread's launcher follow.`, {
          threadId,
          cause,
        }),
      ),
    );

  const ensure = (
    input: HandoffFollowInput,
    continuation: { readonly threadId: string; readonly projectId: string | null },
  ) =>
    Effect.gen(function* () {
      // A continuation on this machine is not another machine's to report.
      if (input.destination === self) return;
      const rowId = handoffFollowRowId(self, input.shell.id, input.epoch);
      const launcher = yield* launcherOf(input.shell);
      const machineId = yield* dependencies.machineIdOf(input.destination);
      const now = DateTime.formatIso(yield* DateTime.now);
      const row = yield* store.modify(rowId, (current) => {
        if (current === undefined || revivable(current)) {
          if (launcher === undefined || machineId === undefined) return undefined;
          return {
            id: rowId,
            callerThreadId: launcher,
            launchedBy: { kind: "thread", threadId: launcher },
            projectId: input.shell.projectId,
            machineId,
            environmentId: input.destination,
            remoteProjectId: continuation.projectId,
            remoteThreadId: continuation.threadId,
            title: input.shell.title,
            launchStartedAt: current?.launchStartedAt ?? now,
            followedRunId: null,
            reportBack: true,
            state: "following",
            lastStatus: null,
            deliveredRunIds: [],
            lostContactNotified: false,
            lastError: null,
            updatedAt: now,
            handoff: {
              sourceThreadId: input.shell.id,
              epoch: input.epoch,
              awaiting: "continuation",
            },
          };
        }
        // The destination's own answer wins over the id worked out here, while nothing was seen.
        if (
          current.handoff?.awaiting === "continuation" &&
          current.state === "following" &&
          (current.remoteThreadId !== continuation.threadId ||
            (continuation.projectId !== null && current.remoteProjectId !== continuation.projectId))
        ) {
          return {
            ...current,
            remoteThreadId: continuation.threadId,
            remoteProjectId: continuation.projectId ?? current.remoteProjectId,
            updatedAt: now,
          };
        }
        return undefined;
      });
      // Idempotent: one follow per row runs, whoever asks again.
      if (row?.state === "following") yield* follower.follow(rowId);
    });

  return {
    register: (input) =>
      ensure(input, {
        threadId: continuationThreadId(self, input.shell.id, input.epoch),
        projectId: null,
      }).pipe(quiet("start", input.shell.id)),
    confirm: (input) =>
      ensure(input, {
        threadId: input.continuation.threadId,
        projectId: input.continuation.projectId ?? null,
      }).pipe(quiet("confirm", input.shell.id)),
    retire: ({ threadId, epoch }) =>
      Effect.gen(function* () {
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* store.modify(handoffFollowRowId(self, threadId, epoch), (current) =>
          current === undefined || current.state !== "following" || !nothingDelivered(current)
            ? undefined
            : { ...current, state: "disposed", lastError: HANDOFF_NOT_TAKEN, updatedAt: now },
        );
      }).pipe(quiet("end", threadId)),
  };
};

/**
 * The follow for this server's moves, built once with them: from the remote
 * worker services when they exist, as the fleet layer requires, and following
 * nothing where a caller builds the moves without them.
 */
export const fromContext = (dependencies: {
  readonly self: EnvironmentId;
  readonly projections: HandoffFollowDependencies["projections"];
  readonly peers: Pick<HandoffPeers["Service"], "target">;
}): Effect.Effect<HandoffFollowShape> =>
  Effect.gen(function* () {
    const store = yield* Effect.serviceOption(RemoteWorkerStore.RemoteWorkerStore);
    const follower = yield* Effect.serviceOption(RemoteWorkerFollower.RemoteWorkerFollower);
    if (Option.isNone(store) || Option.isNone(follower)) return none;
    return make({
      self: dependencies.self,
      projections: dependencies.projections,
      store: store.value,
      follower: follower.value,
      machineIdOf: (environmentId) =>
        dependencies.peers.target(environmentId).pipe(
          Effect.map((target): string | undefined => target.machineId),
          Effect.orElseSucceed(() => undefined),
        ),
    });
  });

/** What the fleet layer must provide, so the server cannot build the moves without the follow. */
export const required = Effect.all([
  RemoteWorkerStore.RemoteWorkerStore,
  RemoteWorkerFollower.RemoteWorkerFollower,
]);
