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
import type { HandoffPeerError, HandoffPeers, HandoffPeerTarget } from "./handoffPeers.ts";
import { continuationThreadId } from "./HandoffReceiver.ts";
import type { HandoffLauncher } from "./handoffWire.ts";

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

/**
 * Why a continuation that arrived here may not be handed to `destination`,
 * or null when it may. The machine where a thread waits for the result pulls
 * it, so the work stays where that machine can ask: declined here, before
 * anything about the thread changes, rather than moved out of its reach.
 * Continuing it here under another model is declined too: that makes a new
 * thread, and the machine waiting follows this one.
 */
export const onwardDeclined = (
  launcher: HandoffLauncher | null | undefined,
  destination: string,
  self: string,
): string | null =>
  launcher == null || launcher.environmentId === self
    ? null
    : destination === self
      ? `Not moved: a thread on ${launcher.label} waits for this work's result and follows this thread; continued here under another model it would be a new thread. Change the model after the result is in, or hand the work back to ${launcher.label}.`
      : destination === launcher.environmentId ||
          launcher.reachable.includes(destination as EnvironmentId)
        ? null
        : `Not moved: a thread on ${launcher.label} waits for this work's result, and ${launcher.label} cannot ask that machine for it. Hand it to a machine ${launcher.label} can reach, or back to ${launcher.label}.`;

type Reach = Pick<HandoffPeers["Service"], "targets" | "preflight">;

/**
 * The machines this one can ask about `shell`'s project: those that answer
 * a preflight under this machine's work grant there without refusing the
 * grant or the project. A machine that is only listed, or that does not
 * answer, is not one of them: nothing is assumed about a grant not shown.
 */
export const granted = (
  peers: Reach,
  self: EnvironmentId,
  shell: Pick<HandoffFollowInput["shell"], "id" | "projectId">,
): Effect.Effect<ReadonlyArray<EnvironmentId>> =>
  Effect.flatMap(peers.targets, (targets: ReadonlyArray<HandoffPeerTarget>) =>
    Effect.forEach(
      targets.filter((target) => target.environmentId !== self),
      (target) =>
        peers
          .preflight(target.environmentId, {
            sourceEnvironmentId: self,
            threads: [
              {
                sourceThreadId: shell.id,
                sourceProjectId: shell.projectId,
                sequence: 0,
                modelSelection: null,
              },
            ],
          })
          .pipe(
            Effect.map((answer) =>
              answer.results.some((result) =>
                result.failures.some(
                  (failure) => failure.check === "grant" || failure.check === "project-link",
                ),
              )
                ? []
                : [target.environmentId],
            ),
            Effect.orElseSucceed((): ReadonlyArray<EnvironmentId> => []),
          ),
      { concurrency: "unbounded" },
    ).pipe(Effect.map((found) => found.flat())),
  );

/**
 * What a takeover says about who waits for the result: what this machine was
 * told when the work arrived, or this machine and its own fleet when the
 * thread waiting is here. Undefined when nobody waits.
 *
 * Fails when the machines this one can ask do not include the one the work
 * is going to: the fleet could not be read then, or the grant not shown, and
 * a list sent as it is would have the other machine decline every later move.
 */
export const launcherFor = (
  followed: HandoffFollowOutcome,
  input: Pick<HandoffFollowInput, "shell" | "destination">,
  here: {
    readonly told: HandoffLauncher | null | undefined;
    readonly self: EnvironmentId;
    readonly selfLabel: string;
    readonly peers: Reach;
  },
): Effect.Effect<HandoffLauncher | undefined, HandoffFollowError> => {
  if (here.told != null && here.told.environmentId !== here.self) return Effect.succeed(here.told);
  if (followed !== "following" && here.told == null) return Effect.succeed(undefined);
  return Effect.flatMap(granted(here.peers, here.self, input.shell), (reachable) =>
    input.destination === here.self || reachable.includes(input.destination)
      ? Effect.succeed({
          environmentId: here.self,
          label: here.selfLabel.slice(0, 120),
          reachable,
        })
      : Effect.fail(
          new HandoffFollowError({
            threadId: input.shell.id,
            cause: "This machine could not show that it may ask the other machine.",
          }),
        ),
  );
};

/**
 * Follows the continuation a takeover will create and says what the takeover
 * tells the destination about who waits. A follow that cannot be named is
 * ended again: the move is declined, so nothing is left asking for a thread
 * that will not exist.
 */
export const named = (
  follow: HandoffFollowShape,
  input: HandoffFollowInput,
  here: Parameters<typeof launcherFor>[2],
) =>
  follow.register(input).pipe(
    Effect.flatMap((followed) => launcherFor(followed, input, here)),
    Effect.tapError(() => follow.retire({ threadId: input.shell.id, epoch: input.epoch })),
  );

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
