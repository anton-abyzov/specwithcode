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
 * a stale lease fences itself, so a partition never runs a thread twice.
 */
import * as NodeFSP from "node:fs/promises";

import {
  CommandId,
  type EnvironmentId,
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
import { HandoffMode } from "./HandoffMode.ts";
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
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectService.ProjectService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const locks = yield* KeyedLock.make<string>();
  const self = handoff.environmentId;
  const selfLabel = handoff.machineLabel;
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const selfCaller: ReceiverCaller = { sourceEnvironmentId: self, grant: null };
  /** When each replica machine last answered this machine, for self-fencing. */
  const lastAnswer = new Map<string, number>();

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
      return yield* shipped.pipe(
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

  /** Waits (bounded) for the interrupted run to end, so the next checkpoint holds its last work. */
  const waitForRunToEnd = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const attempts = Math.ceil(
        Duration.toMillis(SETTLE_TIMEOUT) / Duration.toMillis(SETTLE_POLL),
      );
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const shell = yield* projections
          .getThreadShell(threadId)
          .pipe(Effect.orElseSucceed(() => null));
        if (shell === null || shell.activeRunId === null) return;
        yield* Effect.sleep(SETTLE_POLL);
      }
    });

  const interruptRun = (shell: OrchestrationV2ThreadShell, reason: string) =>
    shell.activeRunId === null
      ? Effect.void
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
   * Re-sends a takeover that got no answer, at the same epoch: the destination
   * either continued already (and repeats its answer) or continues now. A
   * definite refusal gives the thread back; an in-doubt one keeps it paused.
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
          error._tag === "HandoffPeerError" && error.uncertain
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
            : releaseHold(input.threadId, null),
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
            detail: moved.failure.message.slice(0, 500),
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
   * Continues a replica here after its source went silent. Allowed only once
   * the source's lease is stale, the same wait the source uses to fence itself.
   */
  const continueHere = (input: HandoffContinueHereInput) =>
    Effect.gen(function* () {
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
      const response = yield* receiver
        .takeover(
          { sourceEnvironmentId: input.sourceEnvironmentId, grant: null },
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
   * which threads they continued, which fences the copy here), replicate a
   * checkpoint a replica lacks, and fence this machine's running copies when
   * no replica machine has answered for longer than a stale lease.
   */
  const tick = Effect.gen(function* () {
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
    for (const [peer, leases] of byPeer) {
      const answer = yield* peers
        .heartbeat(peer, {
          sourceEnvironmentId: self,
          sourceLabel: selfLabel.slice(0, 120),
          leases: leases.slice(0, 500),
        })
        .pipe(Effect.option);
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
    if (byPeer.size > 0 && document.pausedSince !== null) {
      const anyAnswered = [...byPeer.keys()].some(
        (peer) => now - (lastAnswer.get(peer) ?? 0) <= HANDOFF_LEASE_STALE_MS,
      );
      if (anyAnswered) {
        yield* handoff.updateDocument(
          (current) => [undefined, { ...current, pausedSince: null }] as const,
        );
      }
    }
    // Self-fence: a running copy whose replica machines all went silent stops.
    for (const [id, record] of Object.entries(document.threads)) {
      if (record.continuedOn !== null || record.lease?.holderEnvironmentId !== self) continue;
      const remote = record.replicas.filter((replica) => replica.environmentId !== self);
      if (remote.length === 0) continue;
      // Only a partition counts: every replica machine answered here before and then went
      // silent for longer than a stale lease. A machine never heard from since this server
      // started (asleep all along) does not stop work here.
      const silent = remote.every((replica) => {
        const seen = lastAnswer.get(replica.environmentId);
        return seen !== undefined && now - seen > HANDOFF_LEASE_STALE_MS;
      });
      if (!silent) continue;
      const shell = yield* projections
        .getThreadShell(id as ThreadId)
        .pipe(Effect.orElseSucceed(() => null));
      if (shell === null || shell.activeRunId === null) continue;
      yield* Effect.logWarning("Handoff mode fenced a thread whose replicas stopped answering", {
        threadId: id,
      });
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
        "No other machine answered for this thread's lease; it paused here.",
      );
    }
    // Each checkpoint goes to every paired machine in the thread's logical project.
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
        if (replica === undefined) return true;
        if ((replica.sequence ?? -1) >= checkpoint.sequence) return false;
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
    // Replicas whose source went silent read "unknown" here.
    yield* handoff.updateDocument((current) => {
      const next = markUnreachable(current, now);
      return [undefined, next] as const;
    });
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("Handoff moves tick failed", { cause })));

  return {
    handOff: (input: HandOffInput) => handOffAs(input, "handoff"),
    handOffMachine,
    continueHere,
    resumeFenced,
    preflight,
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
).pipe(Layer.provide(HandoffPeersLayer));
