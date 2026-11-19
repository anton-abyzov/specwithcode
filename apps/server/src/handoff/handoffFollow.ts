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
 *
 * A thread no agent's thread waits for is "not eligible" and moves as before.
 * For one that is waited for, the row must be on disk before the takeover is
 * sent: a launcher that could not be looked up, or a row that could not be
 * written, fails the registration and the move is not made.
 */
import type {
  EnvironmentId,
  OrchestrationV2ThreadShell,
  ProjectId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as RemoteWorkerFollower from "../fleet/RemoteWorkerFollower.ts";
import * as RemoteWorkerStore from "../fleet/RemoteWorkerStore.ts";
import type * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { firstMessageSender, launchedByAgent } from "../project/LaunchedWorkerWake.ts";
import type { HandoffPeerError, HandoffPeers } from "./handoffPeers.ts";
import { continuationThreadId } from "./HandoffReceiver.ts";

/** Why a retired row stopped: the takeover it was written for never happened. */
export const HANDOFF_NOT_TAKEN = "The other machine did not take this thread.";

/** What the user reads when a move is not made because its follow could not be recorded. */
export const FOLLOW_NOT_RECORDED =
  "Not moved: this machine could not record which thread waits for this worker's result. Try again.";

/** What the user reads when an unanswered handoff is not sent again for the same reason. */
export const FOLLOW_NOT_RECORDED_PAUSED =
  "This machine could not record which thread waits for this worker's result, so the unanswered handoff was not sent again.";

/** The follow of a waited-for worker could not be made durable. */
export class HandoffFollowError extends Data.TaggedError("HandoffFollowError")<{
  readonly threadId: string;
  readonly cause: unknown;
}> {}

/** "following": a row is on disk. "not-eligible": no thread here waits for this worker. */
export type HandoffFollowOutcome = "following" | "not-eligible";

export interface HandoffFollowInput {
  readonly shell: Pick<
    OrchestrationV2ThreadShell,
    | "id"
    | "projectId"
    | "title"
    | "lineage"
    | "createdBy"
    | "creationSource"
    | "origin"
    | "deletedAt"
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
  readonly register: (
    input: HandoffFollowInput,
  ) => Effect.Effect<HandoffFollowOutcome, HandoffFollowError>;
  /** The destination continued the thread: follows what it answered. Safe to repeat. */
  readonly confirm: (
    input: HandoffFollowInput & {
      readonly continuation: {
        readonly threadId: ThreadId;
        readonly projectId?: ProjectId | undefined;
      };
    },
  ) => Effect.Effect<HandoffFollowOutcome, HandoffFollowError>;
  /** The destination definitely did not take the thread: nothing to follow. */
  readonly retire: (input: {
    readonly threadId: ThreadId;
    readonly epoch: number;
  }) => Effect.Effect<void>;
}

/** Where remote workers are not followed (no fleet): a handoff follows nothing. */
export const none: HandoffFollowShape = {
  register: () => Effect.succeed("not-eligible"),
  confirm: () => Effect.succeed("not-eligible"),
  retire: () => Effect.void,
};

export interface HandoffFollowDependencies {
  readonly self: EnvironmentId;
  readonly store: RemoteWorkerStore.RemoteWorkerStore["Service"];
  readonly follower: Pick<RemoteWorkerFollower.RemoteWorkerFollower["Service"], "follow">;
  readonly projections: Pick<
    ProjectionStore.ProjectionStoreV2Shape,
    "getThreadRecords" | "getThreadShell"
  >;
  /** This machine's name for `environmentId` in its fleet; fails when it has none. */
  readonly machineIdOf: (environmentId: EnvironmentId) => Effect.Effect<string, HandoffPeerError>;
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

  /**
   * The thread waiting for this worker: the one whose agent sent its first
   * message. A delegated child is not woken, here as on this machine. Undefined
   * when no thread waits; a lookup that fails is an error, never "nobody".
   */
  const launcherOf = (shell: HandoffFollowInput["shell"]) =>
    Effect.gen(function* () {
      if (!launchedByAgent(shell)) return undefined;
      const { messages } = yield* projections.getThreadRecords(shell.id, ["messages"], {
        messageRoles: ["user"],
      });
      const sender = firstMessageSender(messages, shell.id);
      if (sender === undefined) return undefined;
      const launcher = yield* projections.getThreadShell(sender);
      return launcher === null ||
        launcher.deletedAt !== null ||
        launcher.lineage.relationshipToParent === "subagent"
        ? undefined
        : sender;
    });

  const ensure = (
    input: HandoffFollowInput,
    continuation: { readonly threadId: string; readonly projectId: string | null },
  ): Effect.Effect<HandoffFollowOutcome, HandoffFollowError> =>
    Effect.gen(function* () {
      // A continuation on this machine is not another machine's to report.
      if (input.destination === self) return "not-eligible" as const;
      const rowId = handoffFollowRowId(self, input.shell.id, input.epoch);
      const launcher = yield* launcherOf(input.shell);
      if (launcher === undefined) return "not-eligible" as const;
      const machineId = yield* dependencies.machineIdOf(input.destination);
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* store.modify(rowId, (current) => {
        if (current === undefined || revivable(current)) {
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
        // What the destination answered wins over what was worked out here, while nothing
        // was seen: its own id, or another machine that continued the thread instead.
        const movedTo = current.environmentId === input.destination ? undefined : machineId;
        if (
          current.handoff?.awaiting === "continuation" &&
          (current.handoff.hops ?? 0) === 0 &&
          current.state === "following" &&
          nothingDelivered(current) &&
          (movedTo !== undefined ||
            current.remoteThreadId !== continuation.threadId ||
            (continuation.projectId !== null && current.remoteProjectId !== continuation.projectId))
        ) {
          return {
            ...current,
            ...(movedTo === undefined
              ? {}
              : { machineId: movedTo, environmentId: input.destination }),
            remoteThreadId: continuation.threadId,
            remoteProjectId: continuation.projectId ?? current.remoteProjectId,
            updatedAt: now,
          };
        }
        return undefined;
      });
      // What is on disk now, whoever wrote it: the takeover is sent only over a row.
      const row = (yield* store.list).find((candidate) => candidate.id === rowId);
      if (row === undefined)
        return yield* new HandoffFollowError({
          threadId: input.shell.id,
          cause: "The follow row was not kept.",
        });
      // Idempotent: one follow per row runs, whoever asks again.
      if (row.state === "following") yield* follower.follow(rowId);
      return "following" as const;
    }).pipe(
      // Failures only: an interrupted move stays interrupted.
      Effect.tapError((cause) =>
        Effect.logWarning("Handoff could not record the thread's launcher follow.", {
          threadId: input.shell.id,
          cause,
        }),
      ),
      Effect.mapError((cause) => new HandoffFollowError({ threadId: input.shell.id, cause })),
    );

  return {
    register: (input) =>
      ensure(input, {
        threadId: continuationThreadId(self, input.shell.id, input.epoch),
        projectId: null,
      }),
    confirm: (input) =>
      ensure(input, {
        threadId: input.continuation.threadId,
        projectId: input.continuation.projectId ?? null,
      }),
    retire: ({ threadId, epoch }) =>
      Effect.gen(function* () {
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* store.modify(handoffFollowRowId(self, threadId, epoch), (current) =>
          current === undefined || current.state !== "following" || !nothingDelivered(current)
            ? undefined
            : { ...current, state: "disposed", lastError: HANDOFF_NOT_TAKEN, updatedAt: now },
        );
      }).pipe(
        // The takeover was refused, so nothing is owed: a row left behind only keeps asking.
        Effect.catchCause((cause) =>
          Effect.logWarning("Handoff could not end the thread's launcher follow.", {
            threadId,
            cause,
          }),
        ),
      ),
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
        dependencies.peers.target(environmentId).pipe(Effect.map((target) => target.machineId)),
    });
  });

/** What the fleet layer must provide, so the server cannot build the moves without the follow. */
export const required = Effect.all([
  RemoteWorkerStore.RemoteWorkerStore,
  RemoteWorkerFollower.RemoteWorkerFollower,
]);
