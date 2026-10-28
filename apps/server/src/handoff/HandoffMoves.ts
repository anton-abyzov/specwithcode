// @effect-diagnostics nodeBuiltinImport:off - the bundle file is read once to send it.
/**
 * The source half of a handoff (0967): replicates checkpoints to the
 * machines that may continue a thread, preflights a move, and hands a thread
 * (or every running one) to another machine or model. It is attached to
 * HandoffMode once the fleet exists.
 *
 * A move never half-happens. The checkpoint is replicated and preflighted
 * first; a failing check leaves the source untouched. Only then is the lease
 * marked handing-off (no new turn starts), a running turn interrupted, and
 * the destination asked to take over at the next epoch. A destination that
 * refused definitely changed nothing, so the source takes its lease back; one
 * that never answered may have continued, so the source stays paused until a
 * heartbeat settles it. A copy that cannot reach any replica for longer than
 * a stale lease fences itself only when it also cannot reach SpecWithCode
 * Connect (its own network is down): a sleeping replica machine is silent
 * too, and must not stop the work here (1128).
 */
import * as NodeFSP from "node:fs/promises";

import {
  CommandId,
  type EnvironmentId,
  HANDOFF_LEASE_RENEW_MS,
  HANDOFF_LEASE_STALE_MS,
  type HandOffInput,
  type HandOffMachineInput,
  type HandOffResult,
  type HandoffCheckpoint,
  type HandoffContinueHereInput,
  type HandoffMachineRun,
  type HandoffMachineThreadResult,
  HandoffModeError,
  type HandoffModeErrorCode,
  type HandoffPreflightFailure,
  type HandoffPreflightInput,
  type HandoffPreflightResult,
  type HandoffReplicaStatus,
  type ModelSelection,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type ThreadId,
  appendThreadExecutionHistory,
} from "@specweave-studio/contracts";
import * as KeyedLock from "@specweave-studio/shared/KeyedLock";
import {
  isPersonalAssistantProject,
  PERSONAL_ASSISTANT_PRIVATE_MESSAGE,
} from "@specweave-studio/shared/personalAssistant";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { createBundle, negotiationCandidates, repositoryPathFor } from "./bundleGit.ts";
import { keepFencedChanges } from "./checkpointGit.ts";
import { HandoffConnectivity, layer as HandoffConnectivityLayer } from "./handoffConnectivity.ts";
import { type HandoffContinueHereOptions, HandoffMode } from "./HandoffMode.ts";
import { HandoffPeerError, HandoffPeers, layer as HandoffPeersLayer } from "./handoffPeers.ts";
import { shouldResume } from "./handoffPreflight.ts";
import { HandoffReceiver, type HandoffRefusal, type ReceiverCaller } from "./HandoffReceiver.ts";
import {
  effectiveHandoffMode,
  fenceRecord,
  findIncoming,
  incomingKey,
  type HandoffDocument,
  type HandoffThreadRecord,
  isLeaseStale,
  markUnreachable,
} from "./handoffState.ts";
import {
  type PeerPreflightResponse,
  type PeerTranscriptMessage,
  type ReplicateMeta,
  type ReplicateResponse,
  type TakeoverReason,
  type TakeoverRequest,
  type TakeoverResponse,
  transcriptTail,
} from "./handoffWire.ts";
import { HANDOFF_APP_VERSION, HANDOFF_PROTOCOL_VERSION, versionFailure } from "./handoffWire.ts";

const SETTLE_TIMEOUT = Duration.seconds(45);
const SETTLE_POLL = Duration.millis(500);
const REFUSED_RETRY_MS = 10 * 60_000;
/** After a start or a wake, Continue here waits this long: the network may not be back yet. */
export const WAKE_GRACE_MS = 2 * HANDOFF_LEASE_RENEW_MS;
/**
 * Idle time this long between one lease tick's end and the next one's start means
 * the machine slept (or its clock jumped). Ticks are spaced from the previous end,
 * so a slow tick never reads as a sleep.
 */
const WAKE_GAP_MS = 2 * HANDOFF_LEASE_RENEW_MS;
/** How long Continue here waits for the source to answer a direct probe. */
const SOURCE_PROBE_TIMEOUT = Duration.seconds(5);
/** A failing replication waits 30s, then twice as long each time, up to 10 minutes. */
export const REPLICATE_RETRY_BASE_MS = 30_000;
export const REPLICATE_RETRY_MAX_MS = 10 * 60_000;

export function replicateRetryDelay(failures: number): number {
  const doublings = Math.max(0, Math.min(failures - 1, 20));
  return Math.min(REPLICATE_RETRY_BASE_MS * 2 ** doublings, REPLICATE_RETRY_MAX_MS);
}

const failed = (code: HandoffModeErrorCode, message: string) =>
  new HandoffModeError({ code, message: message.slice(0, 1000) });

const fromPeer = (error: HandoffPeerError | HandoffRefusal) => failed(error.code, error.message);

/** One line the user reads for every failing check. */
export function preflightMessage(failures: ReadonlyArray<HandoffPreflightFailure>): string {
  return failures.map((failure) => failure.message).join("; ");
}

/** The error a failed preflight returns: a missing grant reads as such, everything else is invalid. */
export function preflightError(failures: ReadonlyArray<HandoffPreflightFailure>): HandoffModeError {
  return failed(
    failures.some((failure) => failure.check === "grant") ? "needs_grant" : "invalid",
    preflightMessage(failures),
  );
}

export const make = Effect.gen(function* () {
  const handoff = yield* HandoffMode;
  const peers = yield* HandoffPeers;
  const receiver = yield* HandoffReceiver;
  const connectivity = yield* HandoffConnectivity;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectService.ProjectService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const locks = yield* KeyedLock.make<string>();
  const self = handoff.environmentId;
  const selfLabel = handoff.machineLabel;
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  // A move to this machine runs on the owner's own sign-ins: no access ceiling applies.
  const selfCaller: ReceiverCaller = {
    sourceEnvironmentId: self,
    grant: null,
    runtimeCeiling: null,
  };
  /** When each replica machine last answered this machine, for self-fencing. */
  const lastAnswer = new Map<string, number>();
  /**
   * When this server started or last woke (idle time between lease ticks), when
   * the last tick ended, and how many ticks run now.
   */
  let wokeAt = yield* Clock.currentTimeMillis;
  let lastTickEndAt: number | null = null;
  let ticksRunning = 0;
  /** Per thread and destination: failed replications in a row and when to try again. */
  const replicateBackoff = new Map<string, { failures: number; retryAt: number }>();
  const backoffKey = (threadId: ThreadId, destination: EnvironmentId) =>
    `${threadId}\u0000${destination}`;

  const shellOf = (threadId: ThreadId) =>
    projections.getThreadShell(threadId).pipe(
      Effect.mapError(() => failed("failed", "Could not read the thread.")),
      Effect.flatMap((shell) =>
        shell === null || shell.deletedAt !== null
          ? Effect.fail(failed("not_found", "No such thread."))
          : Effect.succeed(shell),
      ),
    );

  const updateRecord = (
    threadId: ThreadId,
    change: (record: HandoffThreadRecord) => HandoffThreadRecord,
  ) =>
    handoff.updateDocument((document) => {
      const record = document.threads[threadId];
      if (record === undefined) return [undefined, document] as const;
      const next = change(record);
      return [next, { ...document, threads: { ...document.threads, [threadId]: next } }] as const;
    });

  const recordOf = (threadId: ThreadId) =>
    handoff.document.pipe(Effect.map((document) => document.threads[threadId]));

  const transcriptOf = (threadId: ThreadId) =>
    projections
      .getThreadRecords(threadId, ["messages"], { messageRoles: ["user", "assistant"] })
      .pipe(
        Effect.map((records) =>
          transcriptTail(
            records.messages
              .filter((message) => !message.streaming && message.text.trim().length > 0)
              .map((message): PeerTranscriptMessage => ({
                role: message.role === "user" ? "user" : "assistant",
                text: message.text,
              })),
          ),
        ),
        Effect.orElseSucceed((): Array<PeerTranscriptMessage> => []),
      );

  const peerLabel = (environmentId: EnvironmentId) =>
    environmentId === self
      ? Effect.succeed(selfLabel)
      : peers.target(environmentId).pipe(
          Effect.map((target) => target.label),
          Effect.orElseSucceed(() => "the other machine"),
        );

  const noteReplica = (threadId: ThreadId, status: HandoffReplicaStatus) =>
    updateRecord(threadId, (record) => ({
      ...record,
      replicas: [
        ...record.replicas.filter((replica) => replica.environmentId !== status.environmentId),
        status,
      ],
    })).pipe(Effect.ignore);

  /** Ships the thread's newest checkpoint to `destination` (this machine pins it locally). */
  const replicateTo = (
    shell: OrchestrationV2ThreadShell,
    checkpoint: HandoffCheckpoint,
    destination: EnvironmentId,
  ) =>
    Effect.gen(function* () {
      const project = yield* projects.getById(shell.projectId).pipe(
        Effect.mapError(() => failed("failed", "Could not read the project.")),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(failed("not_found", "No such project.")),
            onSome: Effect.succeed,
          }),
        ),
      );
      if (isPersonalAssistantProject(project.workspaceSettings)) {
        return yield* failed("invalid", PERSONAL_ASSISTANT_PRIVATE_MESSAGE);
      }
      const cwd = shell.worktreePath ?? project.workspaceRoot;
      const repositoryPath = yield* Effect.tryPromise({
        try: () => repositoryPathFor(project.workspaceRoot, cwd),
        catch: (cause) =>
          failed("not_a_repository", cause instanceof Error ? cause.message : String(cause)),
      });
      const thread = yield* projections
        .getThread(shell.id)
        .pipe(Effect.mapError(() => failed("failed", "Could not read the thread.")));
      const record = yield* recordOf(shell.id).pipe(Effect.mapError((error) => error));
      const meta: ReplicateMeta = {
        sourceEnvironmentId: self,
        sourceLabel: selfLabel.slice(0, 120),
        sourceProjectId: shell.projectId,
        sourceThreadId: shell.id,
        repositoryPath,
        title: shell.title.slice(0, 500),
        modelSelection: shell.modelSelection,
        runtimeMode: shell.runtimeMode,
        interactionMode: shell.interactionMode,
        checkpoint,
        lease: record?.lease ?? null,
        transcript: yield* transcriptOf(shell.id),
        execution: thread.execution ?? null,
        protocolVersion: HANDOFF_PROTOCOL_VERSION,
        appVersion: HANDOFF_APP_VERSION,
      };
      const now = yield* nowIso;
      const label = yield* peerLabel(destination);
      const shipped: Effect.Effect<ReplicateResponse, HandoffPeerError | HandoffRefusal> =
        destination === self
          ? receiver.replicate(selfCaller, meta, null)
          : Effect.gen(function* () {
              const root = checkpoint.sourceRoot.workspaceRoot;
              const candidates = yield* Effect.promise(() =>
                negotiationCandidates(root, checkpoint.baseCommit),
              );
              const { known } = yield* peers.negotiate(destination, {
                sourceEnvironmentId: self,
                sourceProjectId: shell.projectId,
                sourceThreadId: shell.id,
                repositoryPath,
                candidates,
              });
              if (known.includes(checkpoint.commit)) {
                return yield* peers.replicate(destination, meta, null);
              }
              const bundle = yield* Effect.acquireUseRelease(
                Effect.tryPromise({
                  try: () =>
                    createBundle({
                      root,
                      ref: checkpoint.ref,
                      commit: checkpoint.commit,
                      exclude: known,
                    }),
                  catch: (cause) =>
                    new HandoffPeerError({
                      code:
                        cause instanceof Error && "code" in cause && cause.code === "too_large"
                          ? "too_large"
                          : "failed",
                      message: cause instanceof Error ? cause.message : String(cause),
                      uncertain: false,
                    }),
                }),
                (file) => Effect.promise(() => NodeFSP.readFile(file.path)),
                (file) => Effect.promise(() => file.dispose()),
              );
              return yield* peers.replicate(destination, meta, new Uint8Array(bundle));
            });
      const key = backoffKey(shell.id, destination);
      return yield* shipped.pipe(
        Effect.tap(() => Effect.sync(() => replicateBackoff.delete(key))),
        Effect.tapError(() =>
          Clock.currentTimeMillis.pipe(
            Effect.map((at) => {
              const failures = (replicateBackoff.get(key)?.failures ?? 0) + 1;
              replicateBackoff.set(key, { failures, retryAt: at + replicateRetryDelay(failures) });
            }),
          ),
        ),
        Effect.tap((answer) =>
          noteReplica(shell.id, {
            environmentId: destination,
            machineLabel: label.slice(0, 120),
            state: answer.sequence >= checkpoint.sequence ? "current" : "behind",
            sequence: answer.sequence,
            detail: null,
            updatedAt: now,
          }),
        ),
        Effect.tapError((error) =>
          noteReplica(shell.id, {
            environmentId: destination,
            machineLabel: label.slice(0, 120),
            state:
              error.code === "needs_grant"
                ? "needs-grant"
                : error.code === "too_large"
                  ? "too-large"
                  : "failed",
            sequence: null,
            detail: error.message.slice(0, 500),
            updatedAt: now,
          }),
        ),
        Effect.mapError(fromPeer),
      );
    });

  const peerPreflight = (
    destination: EnvironmentId,
    threads: ReadonlyArray<{
      readonly shell: OrchestrationV2ThreadShell;
      readonly sequence: number;
      readonly modelSelection: ModelSelection | null;
    }>,
  ) => {
    const request = {
      sourceEnvironmentId: self,
      protocolVersion: HANDOFF_PROTOCOL_VERSION,
      appVersion: HANDOFF_APP_VERSION,
      threads: threads.map(({ shell, sequence, modelSelection }) => ({
        sourceThreadId: shell.id,
        sourceProjectId: shell.projectId,
        sequence,
        modelSelection,
      })),
    };
    const answer: Effect.Effect<PeerPreflightResponse, HandoffPeerError | HandoffRefusal> =
      destination === self
        ? receiver.preflight(selfCaller, request)
        : peers.preflight(destination, request);
    return answer.pipe(
      // A destination at another protocol version takes no thread, whatever it answered.
      Effect.map((response) => {
        const mismatch = versionFailure({
          peerLabel: response.machineLabel,
          peerProtocolVersion: response.protocolVersion,
          peerAppVersion: response.appVersion,
          selfLabel,
        });
        if (mismatch === null) return response;
        return {
          ...response,
          results: response.results.map((result) => ({
            ...result,
            // This side words it: the destination's own copy cannot name it by its label.
            failures: [
              mismatch,
              ...result.failures.filter((failure) => failure.check !== "version"),
            ],
          })),
        };
      }),
      Effect.mapError(fromPeer),
    );
  };

  /** A fresh checkpoint of the thread, replicated to `destination`. */
  const prepare = (threadId: ThreadId, destination: EnvironmentId) =>
    Effect.gen(function* () {
      const written = yield* handoff.checkpoint(threadId, "handoff");
      const checkpoint = written ?? (yield* recordOf(threadId))?.checkpoint ?? null;
      if (checkpoint === null) {
        return yield* failed("failed", "This thread has no checkpoint to hand off.");
      }
      const shell = yield* shellOf(threadId);
      yield* replicateTo(shell, checkpoint, destination);
      return { shell, checkpoint } as const;
    });

  /**
   * Waits (bounded) for the interrupted run to end, so the next checkpoint holds
   * its last work. True when it ended; false (logged) when it still runs.
   */
  const waitForRunToEnd = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const attempts = Math.ceil(
        Duration.toMillis(SETTLE_TIMEOUT) / Duration.toMillis(SETTLE_POLL),
      );
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const shell = yield* projections
          .getThreadShell(threadId)
          .pipe(Effect.orElseSucceed(() => null));
        if (shell === null || shell.activeRunId === null) return true;
        yield* Effect.sleep(SETTLE_POLL);
      }
      yield* Effect.logWarning("Handoff interrupted a turn that did not end in time", {
        threadId,
        timeoutMs: Duration.toMillis(SETTLE_TIMEOUT),
      });
      return false;
    });

  const interruptRun = (shell: OrchestrationV2ThreadShell, reason: string) =>
    shell.activeRunId === null
      ? Effect.succeed(true)
      : orchestrator
          .dispatch({
            type: "run.interrupt",
            commandId: CommandId.make(`handoff-interrupt:${shell.activeRunId}`),
            threadId: shell.id,
            runId: shell.activeRunId,
            reason,
            cause: "agent",
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Handoff could not interrupt the running turn", { cause }),
            ),
            Effect.andThen(waitForRunToEnd(shell.id)),
          );

  /** Records on the source thread that it continues elsewhere: fenced, read-only, linked. */
  const fenceSource = (
    shell: OrchestrationV2ThreadShell,
    destination: EnvironmentId,
    response: TakeoverResponse,
    epoch: number,
    reason: TakeoverReason,
  ) =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      yield* updateRecord(shell.id, (record) => ({
        ...fenceRecord(
          record,
          {
            environmentId: destination,
            machineLabel: response.machineLabel,
            threadId: response.threadId,
            at: now,
          },
          reason === "sleep" ? "sleep" : "handoff",
        ),
        lease:
          record.lease === null
            ? null
            : { ...record.lease, epoch, state: "fenced", renewedAt: now },
        lastError: null,
        pendingTakeover: null,
      })).pipe(Effect.ignore);
      // The destination runs the thread now. A turn still running here (an interrupt
      // that did not land, or one that outlived the wait) is stopped again.
      const latest = yield* projections
        .getThreadShell(shell.id)
        .pipe(Effect.orElseSucceed(() => null));
      if (latest !== null && latest.activeRunId !== null) {
        yield* orchestrator
          .dispatch({
            type: "run.interrupt",
            commandId: CommandId.make(`handoff-fenced-interrupt:${latest.activeRunId}:${epoch}`),
            threadId: shell.id,
            runId: latest.activeRunId,
            reason: `This thread continues on ${response.machineLabel}.`,
            cause: "agent",
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Handoff could not interrupt the fenced copy's turn", { cause }),
            ),
          );
      }
      yield* orchestrator
        .dispatch({
          type: "thread.project-move.record",
          commandId: CommandId.make(`handoff-source:${shell.id}:${epoch}`),
          threadId: shell.id,
          side: "source",
          link: {
            threadId: response.threadId,
            projectId: response.projectId ?? shell.projectId,
            title: shell.title,
            movedAt: now,
            kind: "handoff",
            ...(destination === self
              ? {}
              : { environmentId: destination, machineLabel: response.machineLabel }),
          },
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Handoff could not link the source thread", { cause }),
          ),
        );
      const thread = yield* projections.getThread(shell.id).pipe(Effect.option);
      const previous = Option.isSome(thread) ? (thread.value.execution ?? null) : null;
      yield* orchestrator
        .dispatch({
          type: "thread.execution.record",
          commandId: CommandId.make(`handoff-source-execution:${shell.id}:${epoch}`),
          threadId: shell.id,
          execution: {
            ownerMachineId: previous?.ownerMachineId ?? self,
            ownerMachineLabel: previous?.ownerMachineLabel ?? selfLabel,
            executionMachineId: destination,
            executionMachineLabel: response.machineLabel,
            epoch,
            sourceRoot: previous?.sourceRoot ?? null,
            history: appendThreadExecutionHistory(previous?.history ?? [], {
              machine: destination,
              machineLabel: response.machineLabel,
              from: now,
              to: null,
              reason,
              epoch,
            }),
          },
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Handoff could not record the source's execution", { cause }),
          ),
        );
    });

  const sendTakeover = (
    destination: EnvironmentId,
    request: TakeoverRequest,
  ): Effect.Effect<TakeoverResponse, HandoffPeerError | HandoffRefusal> =>
    destination === self
      ? receiver.takeover(selfCaller, request)
      : peers.takeover(destination, request);

  /**
   * Gives the thread back to this machine after a move that definitely did not
   * happen. A turn the handoff interrupted keeps `fencedBy`, so the next
   * handoff still resumes it; the next turn started here clears it.
   */
  const releaseHold = (threadId: ThreadId, lastError: string | null) =>
    updateRecord(threadId, (record) => ({
      ...record,
      lease: record.lease === null ? null : { ...record.lease, state: "active" },
      pendingTakeover: null,
      lastError,
    })).pipe(Effect.ignore);

  const inDoubt = (threadId: ThreadId, message: string) =>
    updateRecord(threadId, (record) => ({
      ...record,
      lastError: `${message} This thread stays paused until that machine answers.`,
    })).pipe(Effect.ignore);

  /**
   * Did the destination itself refuse? A failure on this machine (no route, no
   * credential, identity check) or a lost answer says nothing about the earlier
   * takeover, which may have gone through.
   */
  const destinationRefused = (error: HandoffPeerError | HandoffRefusal) =>
    error._tag === "HandoffRefusal" ||
    (!error.uncertain && error.local !== true && error.code !== "unreachable");

  /**
   * Re-sends a takeover that got no answer, at the same epoch: the destination
   * either continued already (and repeats its answer) or continues now. Only a
   * refusal the destination sent gives the thread back; anything else keeps it
   * paused.
   */
  const resendPending = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const record = yield* recordOf(threadId);
      const pending = record?.pendingTakeover ?? null;
      if (record === undefined || pending === null || record.lease?.state !== "handing-off") {
        return yield* failed("busy", "No unanswered handoff of this thread to re-send.");
      }
      const destination = pending.destinationEnvironmentId as EnvironmentId;
      const shell = yield* shellOf(threadId);
      const response = yield* sendTakeover(destination, pending.request).pipe(
        Effect.tapError((error) =>
          !destinationRefused(error)
            ? inDoubt(threadId, error.message)
            : error.code === "fenced"
              ? // The destination saw a newer epoch; a heartbeat settles who runs it.
                inDoubt(threadId, error.message)
              : releaseHold(threadId, error.message.slice(0, 1000)),
        ),
        Effect.mapError(fromPeer),
      );
      yield* fenceSource(
        shell,
        destination,
        response,
        pending.request.epoch,
        pending.request.reason,
      );
      return {
        environmentId: destination,
        machineLabel: response.machineLabel,
        threadId: response.threadId,
        modelSelection: response.modelSelection,
        notice: response.notice,
      } satisfies HandOffResult;
    });

  /**
   * When this machine learns another one continued a thread it still held,
   * what it changed after the checkpoint the other machine got goes to
   * `swc/from-<machine>/<branch>`, never merged.
   */
  const keepChangesAfterFence = (shell: OrchestrationV2ThreadShell, peer: EnvironmentId) =>
    Effect.gen(function* () {
      const record = yield* recordOf(shell.id);
      if (record === undefined) return;
      const project = yield* projects.getById(shell.projectId).pipe(
        Effect.map(Option.getOrNull),
        Effect.orElseSucceed(() => null),
      );
      if (project === null) return;
      const replica = record.replicas.find((entry) => entry.environmentId === peer);
      const handedOverCommit =
        record.checkpoint !== null &&
        replica?.sequence != null &&
        replica.sequence >= record.checkpoint.sequence
          ? record.checkpoint.commit
          : null;
      const branch = yield* Effect.tryPromise(() =>
        keepFencedChanges({
          cwd: shell.worktreePath ?? project.workspaceRoot,
          threadId: shell.id,
          machineLabel: selfLabel,
          handedOverCommit,
        }),
      );
      if (branch === null) return;
      yield* updateRecord(shell.id, (current) => ({ ...current, fencedBranch: branch })).pipe(
        Effect.ignore,
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Handoff could not keep this machine's changes after the fence", {
          threadId: shell.id,
          cause,
        }),
      ),
    );

  const handOffLocked = (input: HandOffInput, reason: TakeoverReason) =>
    Effect.gen(function* () {
      const destination = input.destinationEnvironmentId;
      const current = yield* recordOf(input.threadId);
      if (current?.continuedOn != null) {
        if (current.continuedOn.environmentId === destination) {
          // A retry after a timeout: the first move already happened.
          return {
            environmentId: destination,
            machineLabel: current.continuedOn.machineLabel,
            threadId: current.continuedOn.threadId,
            modelSelection: null,
            notice: `Already continued on ${current.continuedOn.machineLabel}.`,
          } satisfies HandOffResult;
        }
        return yield* failed(
          "fenced",
          `This thread already continues on ${current.continuedOn.machineLabel}.`,
        );
      }
      if (current?.lease?.state === "handing-off") {
        if (current.pendingTakeover?.destinationEnvironmentId === destination) {
          return yield* resendPending(input.threadId);
        }
        return yield* failed(
          "busy",
          "A handoff of this thread did not finish; it stays paused until the other machine answers.",
        );
      }
      if (destination === self && input.modelSelection === undefined) {
        return yield* failed(
          "invalid",
          "Pick another machine, or another model to continue on this machine.",
        );
      }
      const modelSelection = input.modelSelection ?? null;

      // 1. Replicate and preflight. Nothing on the source changes until both pass.
      const first = yield* prepare(input.threadId, destination);
      const checked = yield* peerPreflight(destination, [
        { shell: first.shell, sequence: first.checkpoint.sequence, modelSelection },
      ]);
      const failures = checked.results[0]?.failures ?? [];
      if (failures.length > 0) return yield* preflightError(failures);

      // 2. Hold the thread: no new turn starts, a running one stops.
      const now = yield* nowIso;
      const held = yield* updateRecord(input.threadId, (record) => ({
        ...record,
        lease: {
          holderEnvironmentId: self,
          holderLabel: selfLabel,
          holderThreadId: input.threadId,
          epoch: record.lease?.epoch ?? 0,
          renewedAt: now,
          state: "handing-off",
        },
        pendingTakeover: null,
      })).pipe(Effect.mapError((error) => error));
      const epoch = (held?.lease?.epoch ?? 0) + 1;
      // Read the run after the hold: a turn that started before it is the one to stop.
      const heldShell = yield* shellOf(input.threadId).pipe(
        Effect.tapError(() => releaseHold(input.threadId, null)),
      );

      let checkpoint = first.checkpoint;
      if (heldShell.activeRunId !== null) {
        yield* updateRecord(input.threadId, (record) => ({
          ...record,
          fencedBy: reason === "sleep" ? "sleep" : "handoff",
        })).pipe(Effect.ignore);
        yield* interruptRun(heldShell, `Handing this thread to ${checked.machineLabel}.`);
        const again = yield* prepare(input.threadId, destination).pipe(
          Effect.tapError((error) =>
            releaseHold(
              input.threadId,
              `The handoff stopped the running turn but could not send its last checkpoint: ${error.message} Hand it off again to resume that turn.`.slice(
                0,
                1000,
              ),
            ),
          ),
        );
        checkpoint = again.checkpoint;
      }

      if (checkpoint.children?.some((child) => child.disposition === "unknown")) {
        yield* releaseHold(input.threadId, null);
        return yield* failed(
          "failed",
          "A child's owning process or machine has not settled its work. Keep it unknown and reconcile it on the owning host before handing off.",
        );
      }

      // 3. The destination takes over at the next epoch.
      const request: TakeoverRequest = {
        sourceEnvironmentId: self,
        sourceThreadId: input.threadId,
        epoch,
        sequence: checkpoint.sequence,
        reason,
        modelSelection,
      };
      const response = yield* sendTakeover(destination, request).pipe(
        Effect.tapError((error) =>
          error._tag === "HandoffPeerError" && error.uncertain
            ? updateRecord(input.threadId, (record) => ({
                ...record,
                pendingTakeover: { destinationEnvironmentId: destination, request },
                lastError: `${error.message} This thread stays paused until that machine answers.`,
              })).pipe(Effect.ignore)
            : releaseHold(
                input.threadId,
                destinationRefused(error) && error.check === "grant"
                  ? `Not moved: ${error.message}`.slice(0, 1000)
                  : null,
              ),
        ),
        Effect.mapError(fromPeer),
      );
      yield* fenceSource(first.shell, destination, response, epoch, reason);
      return {
        environmentId: destination,
        machineLabel: response.machineLabel,
        threadId: response.threadId,
        modelSelection: response.modelSelection,
        notice: response.notice,
      } satisfies HandOffResult;
    });

  const handOffAs = (input: HandOffInput, reason: TakeoverReason) =>
    locks.withLock(input.threadId, handOffLocked(input, reason));

  const runningHandoffThreads = (document: HandoffDocument) =>
    Effect.gen(function* () {
      const out: Array<ThreadId> = [];
      for (const [id, record] of Object.entries(document.threads)) {
        if (record.continuedOn !== null) continue;
        if (effectiveHandoffMode(document, record.projectId, record.mode) !== "on") continue;
        const shell = yield* projections
          .getThreadShell(id as ThreadId)
          .pipe(Effect.orElseSucceed(() => null));
        if (shell === null || shell.deletedAt !== null || shell.activeRunId === null) continue;
        // A personal assistant's threads stay on their machine.
        const project = yield* projects.getById(shell.projectId).pipe(
          Effect.map(Option.getOrNull),
          Effect.orElseSucceed(() => null),
        );
        if (!isPersonalAssistantProject(project?.workspaceSettings)) out.push(shell.id);
      }
      return out;
    });

  const handOffMachine = (input: HandOffMachineInput) =>
    Effect.gen(function* () {
      const destination = input.destinationEnvironmentId;
      if (destination === self) {
        return yield* failed("invalid", "Pick another machine to hand this machine's threads to.");
      }
      const label = yield* peerLabel(destination);
      const startedAt = yield* nowIso;
      const document = yield* handoff.document;
      const threadIds = input.threadIds ?? (yield* runningHandoffThreads(document));
      const reason: TakeoverReason = input.reason === "sleep" ? "sleep" : "machine-handoff";
      const results: Array<HandoffMachineThreadResult> = [];
      for (const threadId of threadIds) {
        const shell = yield* shellOf(threadId).pipe(Effect.option);
        const title = Option.isSome(shell) ? shell.value.title.slice(0, 500) : String(threadId);
        const moved = yield* handOffAs(
          { threadId, destinationEnvironmentId: destination },
          reason,
        ).pipe(Effect.result);
        if (moved._tag === "Success") {
          results.push({
            threadId,
            title,
            outcome: "moved",
            detail: moved.success.notice,
            continuedThreadId: moved.success.threadId,
            resumed: Option.isSome(shell) && shell.value.activeRunId !== null,
          });
        } else {
          results.push({
            threadId,
            title,
            outcome: moved.failure.code === "fenced" ? "skipped" : "stayed",
            // A destination whose work grant does not allow the thread (its sign-in, its
            // project) says so, so the user sees why it stayed on a Mac about to sleep.
            detail: (moved.failure.code === "needs_grant"
              ? `Not moved: ${moved.failure.message}`
              : moved.failure.message
            ).slice(0, 500),
            continuedThreadId: null,
            resumed: false,
          });
        }
      }
      const run: HandoffMachineRun = {
        destinationEnvironmentId: destination,
        destinationLabel: label.slice(0, 120),
        reason: input.reason,
        startedAt,
        finishedAt: yield* nowIso,
        results,
      };
      yield* handoff.updateDocument(
        (current) => [undefined, { ...current, machineRun: run }] as const,
      );
      return run;
    });

  const preflight = (input: HandoffPreflightInput) =>
    Effect.gen(function* () {
      const destination = input.destinationEnvironmentId;
      const prepared: Array<{
        shell: OrchestrationV2ThreadShell;
        checkpoint: HandoffCheckpoint | null;
        error: string | null;
      }> = [];
      for (const threadId of input.threadIds) {
        const shell = yield* shellOf(threadId);
        const done = yield* prepare(threadId, destination).pipe(Effect.result);
        prepared.push(
          done._tag === "Success"
            ? { shell, checkpoint: done.success.checkpoint, error: null }
            : { shell, checkpoint: null, error: done.failure.message },
        );
      }
      const ready = prepared.filter((entry) => entry.checkpoint !== null);
      const answer =
        ready.length === 0
          ? { machineLabel: "", results: [] }
          : yield* peerPreflight(
              destination,
              ready.map((entry) => ({
                shell: entry.shell,
                sequence: entry.checkpoint!.sequence,
                modelSelection: input.modelSelection ?? null,
              })),
            );
      return prepared.map((entry): HandoffPreflightResult => {
        const failures: Array<HandoffPreflightFailure> =
          entry.error !== null
            ? [{ check: "checkpoint", message: entry.error.slice(0, 500) }]
            : [
                ...(answer.results.find((result) => result.sourceThreadId === entry.shell.id)
                  ?.failures ?? []),
              ];
        const runEnding = entry.checkpoint?.runEnding ?? "none";
        return {
          threadId: entry.shell.id,
          title: entry.shell.title.slice(0, 500),
          ok: failures.length === 0,
          failures,
          resume: shouldResume(runEnding),
          runEnding,
        };
      });
    });

  /**
   * Is the source awake? A direct probe: any answer it sent, a refusal included,
   * says it runs. "unknown" when this machine cannot ask it (no route, no
   * credential, identity check): that says nothing about the source.
   */
  const probeSource = (
    replica: { readonly sourceEnvironmentId: EnvironmentId; readonly projectId: ProjectId | null },
    sourceThreadId: ThreadId,
    detail: { readonly sourceProjectId: ProjectId; readonly repositoryPath: string } | undefined,
  ) =>
    Effect.gen(function* () {
      const projectId = replica.projectId ?? detail?.sourceProjectId ?? null;
      if (projectId === null) return "unknown" as const;
      // Read-only on the source: it only lists which of no commits it knows.
      const answer = yield* peers
        .negotiate(replica.sourceEnvironmentId, {
          sourceEnvironmentId: self,
          sourceProjectId: projectId,
          sourceThreadId,
          repositoryPath: detail?.repositoryPath ?? ".",
          candidates: [],
        })
        .pipe(Effect.result, Effect.timeoutOption(SOURCE_PROBE_TIMEOUT));
      if (Option.isNone(answer)) return "silent" as const;
      if (answer.value._tag === "Success") return "awake" as const;
      const error = answer.value.failure;
      if (error.local === true) {
        yield* Effect.logWarning(
          "Continue here could not probe the source; only its stale lease decides",
          { sourceEnvironmentId: replica.sourceEnvironmentId, message: error.message },
        );
        return "unknown" as const;
      }
      return error.code === "unreachable" ? ("silent" as const) : ("awake" as const);
    });

  /**
   * Continues a replica here after its source went silent. Allowed only once
   * the source's lease is stale, this machine has been awake long enough for
   * its network to be back, its own network is not shown down, and the source
   * does not answer a direct probe. An agent also needs both shown: this
   * machine online and the source silent rather than unaskable.
   */
  const continueHere = (input: HandoffContinueHereInput, options?: HandoffContinueHereOptions) =>
    Effect.gen(function* () {
      const byAgent = options?.byAgent === true;
      const document = yield* handoff.document;
      const replica = findIncoming(document, input.sourceEnvironmentId, input.sourceThreadId);
      if (replica === undefined) {
        return yield* failed("not_found", "This machine holds no checkpoint of that thread.");
      }
      if (replica.continuedThreadId !== null) {
        return {
          environmentId: self,
          machineLabel: selfLabel,
          threadId: replica.continuedThreadId,
          modelSelection: null,
          notice: "Already continued here.",
        } satisfies HandOffResult;
      }
      const now = yield* Clock.currentTimeMillis;
      if (!isLeaseStale(replica.lease, now)) {
        return yield* failed(
          "busy",
          `${replica.sourceLabel} renewed this thread's lease less than ${Math.round(
            HANDOFF_LEASE_STALE_MS / 1000,
          )} seconds ago; it may still be running it.`,
        );
      }
      // Right after a wake every lease looks stale and the network may still be down,
      // so a silent source proves nothing yet. Idle time the lease tick has not seen
      // yet counts as a wake too; a tick still running is no idle time.
      const justWoke =
        now - wokeAt < WAKE_GRACE_MS ||
        (ticksRunning === 0 && lastTickEndAt !== null && now - lastTickEndAt > WAKE_GAP_MS);
      if (justWoke) {
        return yield* failed(
          "busy",
          `This machine just started or woke; try again in ${Math.round(
            WAKE_GRACE_MS / 1000,
          )} seconds, once it has checked whether ${replica.sourceLabel} still runs this thread.`,
        );
      }
      const detail = (document.incomingDetails ?? {})[
        incomingKey(input.sourceEnvironmentId, input.sourceThreadId)
      ];
      const mismatch = versionFailure({
        peerLabel: replica.sourceLabel,
        peerProtocolVersion: detail?.sourceProtocolVersion,
        peerAppVersion: detail?.sourceAppVersion,
        selfLabel,
      });
      if (mismatch !== null) return yield* failed("invalid", mismatch.message);
      // A machine that lost its own network sees every source as silent, while the
      // source, still online, keeps running the thread and never fences it.
      const network = yield* connectivity.probe;
      if (network === "offline") {
        return yield* failed(
          "busy",
          `This machine cannot reach the network, so ${replica.sourceLabel} may still be running this thread; try again once it is back online.`,
        );
      }
      if (byAgent && network !== "online") {
        return yield* failed(
          "busy",
          `This machine cannot show that its network works (no SpecWithCode Connect link), so ${replica.sourceLabel}'s silence proves nothing; ask the user whether to continue it here (Continue here in the app).`,
        );
      }
      const source = yield* probeSource(replica, input.sourceThreadId, detail);
      if (source === "awake") {
        return yield* failed(
          "busy",
          `${replica.sourceLabel} answered just now and still holds this thread; hand it off from there.`,
        );
      }
      if (source === "unknown" && byAgent) {
        return yield* failed(
          "busy",
          `This machine could not ask ${replica.sourceLabel} whether it still runs this thread; ask the user whether to continue it here (Continue here in the app).`,
        );
      }
      const response = yield* receiver
        .takeover(
          // Continuing here runs on this machine's own sign-ins: no access ceiling applies.
          { sourceEnvironmentId: input.sourceEnvironmentId, grant: null, runtimeCeiling: null },
          {
            sourceEnvironmentId: input.sourceEnvironmentId,
            sourceThreadId: input.sourceThreadId,
            epoch: replica.lease.epoch + 1,
            sequence: replica.checkpoint.sequence,
            reason: "continue-here",
            modelSelection: input.modelSelection ?? null,
          },
        )
        .pipe(Effect.mapError(fromPeer));
      return {
        environmentId: self,
        machineLabel: response.machineLabel,
        threadId: response.threadId,
        modelSelection: response.modelSelection,
        notice: response.notice,
      } satisfies HandOffResult;
    });

  const resumeFenced = Effect.gen(function* () {
    yield* handoff.updateDocument(
      (document) => [undefined, { ...document, pausedSince: null }] as const,
    );
    return yield* handoff.snapshot;
  });

  /**
   * Every lease tick: heartbeat the machines holding replicas (they answer
   * which threads they continued, which fences the copy here). A running copy
   * whose replica machines all went silent past a stale lease fences itself
   * only when this machine also cannot reach SpecWithCode Connect: silence
   * alone may be a sleeping laptop, and that must never stop the work here.
   * It never ships a checkpoint, so a slow replication cannot delay it.
   */
  const heartbeatOnce = Effect.gen(function* () {
    const document = yield* handoff.document;
    const now = yield* Clock.currentTimeMillis;
    const byPeer = new Map<EnvironmentId, Array<{ sourceThreadId: ThreadId; epoch: number }>>();
    for (const [id, record] of Object.entries(document.threads)) {
      if (record.continuedOn !== null || record.lease === null) continue;
      if (record.lease.holderEnvironmentId !== self) continue;
      for (const replica of record.replicas) {
        if (replica.environmentId === self) continue;
        const list = byPeer.get(replica.environmentId) ?? [];
        list.push({ sourceThreadId: id as ThreadId, epoch: record.lease.epoch });
        byPeer.set(replica.environmentId, list);
      }
    }
    // One silent peer must not hold up the others' heartbeats.
    const answers = yield* Effect.forEach(
      [...byPeer],
      ([peer, leases]) =>
        peers
          .heartbeat(peer, {
            sourceEnvironmentId: self,
            sourceLabel: selfLabel.slice(0, 120),
            leases: leases.slice(0, 500),
          })
          .pipe(
            Effect.option,
            Effect.map((answer) => ({ peer, leases, answer })),
          ),
      { concurrency: "unbounded" },
    );
    for (const { peer, leases, answer } of answers) {
      if (Option.isNone(answer)) continue;
      lastAnswer.set(peer, now);
      const continuedIds = new Set(answer.value.continued.map((entry) => entry.sourceThreadId));
      for (const { sourceThreadId } of leases) {
        const record = document.threads[sourceThreadId];
        if (continuedIds.has(sourceThreadId)) continue;
        if (record?.lease?.state !== "handing-off") continue;
        if (record.pendingTakeover?.destinationEnvironmentId !== peer) continue;
        // The destination answers again but never continued it: send the takeover again.
        yield* locks.withLock(sourceThreadId, resendPending(sourceThreadId)).pipe(
          Effect.catchCause((cause) =>
            Effect.logInfo("Handoff re-sent a takeover that is still open", {
              threadId: sourceThreadId,
              cause,
            }),
          ),
        );
      }
      for (const continued of answer.value.continued) {
        const shell = yield* projections
          .getThreadShell(continued.sourceThreadId)
          .pipe(Effect.orElseSucceed(() => null));
        if (shell === null) continue;
        yield* interruptRun(shell, `This thread continues on ${answer.value.machineLabel}.`);
        yield* keepChangesAfterFence(shell, peer);
        yield* fenceSource(
          shell,
          peer,
          {
            threadId: continued.threadId,
            machineLabel: answer.value.machineLabel,
            modelSelection: null,
            resumed: false,
            notice: null,
          },
          continued.epoch,
          "handoff",
        );
      }
    }
    const usableRemote = (record: (typeof document.threads)[string]) =>
      record.replicas.filter(
        (replica) => replica.environmentId !== self && replica.sequence !== null,
      );
    const answeredNow = (environmentId: EnvironmentId) =>
      now - (lastAnswer.get(environmentId) ?? Number.NEGATIVE_INFINITY) <= HANDOFF_LEASE_STALE_MS;
    // Running copies whose replica machines all went silent: only a machine that holds
    // a usable checkpoint could continue a thread. Turning handoff off later leaves
    // those copies continuable, so the mode does not matter here.
    const silentRunning: Array<OrchestrationV2ThreadShell> = [];
    for (const [id, record] of Object.entries(document.threads)) {
      if (record.continuedOn !== null || record.lease?.holderEnvironmentId !== self) continue;
      const remote = usableRemote(record);
      if (remote.length === 0) continue;
      // Every such machine answered here before and then went silent for longer than a
      // stale lease. A machine never heard from since this server started does not count.
      const silent = remote.every((replica) => {
        const seen = lastAnswer.get(replica.environmentId);
        return seen !== undefined && now - seen > HANDOFF_LEASE_STALE_MS;
      });
      if (!silent) continue;
      const shell = yield* projections
        .getThreadShell(id as ThreadId)
        .pipe(Effect.orElseSucceed(() => null));
      if (shell !== null && shell.activeRunId !== null) silentRunning.push(shell);
    }
    // Threads this machine paused when its network went down. Its network coming
    // back proves nothing about them: a replica machine may have continued one and
    // gone to sleep since. Only an answer from one of their replica machines (which
    // carries any continuation) or Resume this Mac lifts the pause.
    const waiting = Object.values(document.threads).filter(
      (record) =>
        record.fencedBy === "sleep" &&
        record.continuedOn === null &&
        record.lease?.holderEnvironmentId === self &&
        usableRemote(record).length > 0,
    );
    // Asked only when it decides something: a fence, or a pause from an older build.
    const network =
      silentRunning.length > 0 || (document.pausedSince !== null && waiting.length === 0)
        ? yield* connectivity.probe
        : "unknown";
    if (document.pausedSince !== null) {
      const settled =
        waiting.length === 0
          ? network !== "offline"
          : waiting.every((record) =>
              usableRemote(record).some((replica) => answeredNow(replica.environmentId)),
            );
      if (settled) {
        yield* handoff.updateDocument(
          (current) => [undefined, { ...current, pausedSince: null }] as const,
        );
      }
    }
    if (network === "offline") {
      for (const shell of silentRunning) {
        yield* Effect.logWarning(
          "Handoff mode fenced a thread: its replicas and SpecWithCode Connect stopped answering",
          { threadId: shell.id },
        );
        yield* updateRecord(shell.id, (current) => ({ ...current, fencedBy: "sleep" })).pipe(
          Effect.ignore,
        );
        yield* handoff.updateDocument(
          (current) =>
            [
              undefined,
              current.pausedSince === null
                ? { ...current, pausedSince: DateTime.formatIso(DateTime.makeUnsafe(now)) }
                : current,
            ] as const,
        );
        yield* interruptRun(
          shell,
          "This machine lost its network and no other machine answered for this thread's lease; it paused here.",
        );
      }
    }
    // Replicas whose source went silent read "unknown" here.
    yield* handoff.updateDocument((current) => {
      const next = markUnreachable(current, now);
      return [undefined, next] as const;
    });
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Handoff moves heartbeat failed", { cause })),
  );

  const heartbeat = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    // Ticks start 30 seconds after the previous one ended; longer idle time means
    // this machine slept. A slow tick (a re-sent takeover, a fence) is no sleep.
    if (ticksRunning === 0 && lastTickEndAt !== null && now - lastTickEndAt > WAKE_GAP_MS) {
      wokeAt = now;
    }
    ticksRunning += 1;
    yield* heartbeatOnce.pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          ticksRunning -= 1;
          lastTickEndAt = yield* Clock.currentTimeMillis;
        }),
      ),
    );
  });

  /**
   * Ships each thread's newest checkpoint to every paired machine in its
   * logical project that lacks it. A destination that keeps failing is retried
   * with a growing wait (30s up to 10 minutes), not on every tick.
   */
  const replicate = Effect.gen(function* () {
    const document = yield* handoff.document;
    const now = yield* Clock.currentTimeMillis;
    const paired = new Set((yield* peers.targets).map((target) => target.environmentId));
    for (const [id, record] of Object.entries(document.threads)) {
      const checkpoint = record.checkpoint;
      if (record.continuedOn !== null || checkpoint === null) continue;
      if (effectiveHandoffMode(document, record.projectId, record.mode) !== "on") continue;
      const project = yield* projects.getById(record.projectId).pipe(
        Effect.map(Option.getOrNull),
        Effect.orElseSucceed(() => null),
      );
      const members = new Set(
        (project?.workspaceSettings?.logicalProject?.members ?? []).map(
          (member) => member.environmentId as EnvironmentId,
        ),
      );
      for (const replica of record.replicas) members.add(replica.environmentId);
      const destinations = [...members].filter((environmentId) => {
        if (environmentId === self || !paired.has(environmentId)) return false;
        const replica = record.replicas.find((entry) => entry.environmentId === environmentId);
        if (replica !== undefined && (replica.sequence ?? -1) >= checkpoint.sequence) return false;
        const backoff = replicateBackoff.get(backoffKey(id as ThreadId, environmentId));
        if (backoff !== undefined && now < backoff.retryAt) return false;
        if (replica === undefined) return true;
        // A refusal that needs the user (a grant, the size cap) is retried every 10 minutes.
        const waiting = replica.state === "needs-grant" || replica.state === "too-large";
        return !waiting || now - Date.parse(replica.updatedAt) > REFUSED_RETRY_MS;
      });
      if (destinations.length === 0) continue;
      const shell = yield* projections
        .getThreadShell(id as ThreadId)
        .pipe(Effect.orElseSucceed(() => null));
      if (shell === null || shell.deletedAt !== null) continue;
      for (const destination of destinations) {
        yield* replicateTo(shell, checkpoint, destination).pipe(Effect.ignore);
      }
    }
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Handoff moves replication failed", { cause })),
  );

  const tick = heartbeat.pipe(Effect.andThen(replicate));

  return {
    handOff: (input: HandOffInput) => handOffAs(input, "handoff"),
    handOffMachine,
    continueHere,
    resumeFenced,
    preflight,
    heartbeat,
    replicate,
    tick,
  };
});

/** Attaches the moves to HandoffMode once the fleet exists. */
export const layerFleet = Layer.effectDiscard(
  Effect.gen(function* () {
    const handoff = yield* HandoffMode;
    const moves = yield* make;
    yield* handoff.attachMoves(moves);
  }),
).pipe(Layer.provide(Layer.merge(HandoffPeersLayer, HandoffConnectivityLayer)));
