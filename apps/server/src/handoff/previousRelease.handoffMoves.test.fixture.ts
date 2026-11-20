// @effect-diagnostics nodeBuiltinImport:off - the bundle file is read once to send it.
/**
 * The source half of a handoff in the previous release, v1.0.378: how a
 * machine that has not updated yet sends a takeover, sleep included, and
 * what it does with each answer. Copied verbatim with
 * `git show v1.0.378:apps/server/src/handoff/HandoffMoves.ts`, cut to the
 * functions a move runs, so the compatibility tests run it against today's
 * destination.
 *
 * Kept from the tag, bodies unchanged: lines 108-109 and 180-183, and from
 * `make` lines 198-201, 203-215, 225-719 (from the replication backoff to
 * `resendPending`), 725-760 (`keepChangesAfterFence`), 762-1031
 * (`handOffLocked` to `handOffMachine`) and, as the body of `heard`, 1359-1379:
 * what the lease tick does with each continuation a heartbeat answer names.
 * Left out: Continue here and the rest of the lease tick (sending heartbeats,
 * replication, automatic continuation), with the state only they use. `handOff`
 * with a takeover still unanswered runs `resendPending`, the function the tag's
 * heartbeat runs for it too.
 * The pure helpers it calls (`preflightError`, the queue carry, the
 * replication backoff, the worktree-set message) and everything else it
 * imports are today's; each symbol it uses is unchanged since the tag. Never
 * edit a body here: replace it from the tag of the release a later test pins.
 */
import { teamRulesOutgoingCarried } from "@specweave-studio/shared/teamRules";
import { teamRulesForFolder } from "../teamRules/TeamRules.ts";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { worktreeSetManifestPath } from "../worktreeSet.ts";

import {
  CommandId,
  type EnvironmentId,
  type HandOffInput,
  type HandOffMachineInput,
  type HandOffResult,
  type HandoffCheckpoint,
  type HandoffMachineRun,
  type HandoffMachineThreadResult,
  type HandoffModeErrorCode,
  HandoffModeError,
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
import * as Option from "effect/Option";

import { RemoteStudioMcpClient } from "../fleet/RemoteStudioMcpClient.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { createBundle, negotiationCandidates, repositoryPathFor } from "./bundleGit.ts";
import { keepFencedChanges } from "./checkpointGit.ts";
import { HandoffMode } from "./HandoffMode.ts";
import {
  carryQueuedMessages,
  preflightError,
  type QueuedMessage,
  queuedCarryText,
  queuedMessagesFrom,
  replicateRetryDelay,
  WORKTREE_SET_HANDOFF_MESSAGE,
} from "./HandoffMoves.ts";
import { HandoffPeerError, HandoffPeers } from "./handoffPeers.ts";
import * as Resume from "./handoffResume.ts";
import { HandoffReceiver, type HandoffRefusal, type ReceiverCaller } from "./HandoffReceiver.ts";
import {
  effectiveHandoffMode,
  fenceRecord,
  type HandoffDocument,
  type HandoffThreadRecord,
} from "./handoffState.ts";
import {
  type HeartbeatResponse,
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

const failed = (code: HandoffModeErrorCode, message: string) =>
  new HandoffModeError({ code, message: message.slice(0, 1000) });

const fromPeer = (error: HandoffPeerError | HandoffRefusal) => failed(error.code, error.message);

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
  // A move to this machine runs on the owner's own sign-ins: no access ceiling applies.
  const selfCaller: ReceiverCaller = {
    sourceEnvironmentId: self,
    grant: null,
    runtimeCeiling: null,
  };
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
      // A checkpoint carries one repository; a set's other members would be left behind.
      if (
        shell.worktreePath !== null &&
        (yield* Effect.promise(() =>
          NodeFSP.access(worktreeSetManifestPath(shell.worktreePath!, NodePath)).then(
            () => true,
            () => false,
          ),
        ))
      ) {
        return yield* failed("invalid", WORKTREE_SET_HANDOFF_MESSAGE);
      }
      const repositoryPath = yield* Effect.tryPromise({
        try: () => repositoryPathFor(project.workspaceRoot, cwd),
        catch: (cause) =>
          failed("not_a_repository", cause instanceof Error ? cause.message : String(cause)),
      });
      const thread = yield* projections
        .getThread(shell.id)
        .pipe(Effect.mapError(() => failed("failed", "Could not read the thread.")));
      const record = yield* recordOf(shell.id).pipe(Effect.mapError((error) => error));
      const carried = teamRulesOutgoingCarried(
        yield* teamRulesForFolder(cwd),
        shell.origin?.carried,
        self,
      );
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
        ...(carried === undefined ? {} : { carried }),
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

      // 1. Replicate and preflight: every refusal comes before the hold, so no turn stops for it.
      const first = yield* prepare(input.threadId, destination);
      if (Resume.hasUnsettledChild(first.checkpoint))
        return yield* failed("failed", Resume.UNSETTLED_CHILD_REFUSAL);
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
      const resume = Resume.resumeInterruptedTurn(orchestrator, heldShell);
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
              `The handoff stopped the running turn but could not send its last checkpoint: ${error.message} The turn continues here; hand it off again to move it.`.slice(
                0,
                1000,
              ),
            ).pipe(Effect.andThen(resume)),
          ),
        );
        checkpoint = again.checkpoint;
      }

      if (Resume.hasUnsettledChild(checkpoint)) {
        yield* releaseHold(input.threadId, null).pipe(Effect.andThen(resume));
        return yield* failed("failed", Resume.UNSETTLED_CHILD_REFUSAL);
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
              ).pipe(Effect.andThen(resume)),
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

  /** The thread's queued messages, for Away mode to carry; none when they cannot be read. */
  const queuedMessagesOf = (threadId: ThreadId) =>
    projections.getThreadRecords(threadId, ["runs", "messages"]).pipe(
      Effect.map(queuedMessagesFrom),
      Effect.catchCause(() => Effect.succeed<ReadonlyArray<QueuedMessage>>([])),
    );

  /** Sends the queued messages to the continuation on `destination` (see carryQueuedMessages). */
  const carryQueue = (
    sourceThreadId: ThreadId,
    destination: EnvironmentId,
    continuedThreadId: ThreadId,
    queued: ReadonlyArray<QueuedMessage>,
  ) =>
    Effect.gen(function* () {
      const remote = yield* Effect.serviceOption(RemoteStudioMcpClient);
      const target = yield* peers.target(destination).pipe(Effect.option);
      if (Option.isNone(remote) || Option.isNone(target)) return queuedCarryText(0, queued.length);
      return yield* carryQueuedMessages({
        queued,
        send: (message) =>
          remote.value
            .call({
              machineId: target.value.machineId,
              tool: "studio_thread_send",
              arguments: {
                threadId: continuedThreadId,
                message: message.text,
                mode: "queue",
                clientRequestId: `away-queue:${message.runId}`,
              },
            })
            .pipe(
              Effect.as(true),
              Effect.catchCause(() => Effect.succeed(false)),
            ),
        cancel: (message) =>
          orchestrator
            .dispatch({
              type: "queued-run.cancel",
              commandId: CommandId.make(`away-queue-cancel:${message.runId}`),
              threadId: sourceThreadId,
              runId: message.runId,
            })
            .pipe(Effect.ignore),
      });
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
      // Away mode names its threads, whatever their handoff mode, and their queues go too.
      const carriesQueue = input.reason === "away" || input.reason === "back";
      const results: Array<HandoffMachineThreadResult> = [];
      for (const threadId of threadIds) {
        const shell = yield* shellOf(threadId).pipe(Effect.option);
        const title = Option.isSome(shell) ? shell.value.title.slice(0, 500) : String(threadId);
        const queued = carriesQueue ? yield* queuedMessagesOf(threadId) : [];
        const moved = yield* handOffAs(
          { threadId, destinationEnvironmentId: destination },
          reason,
        ).pipe(Effect.result);
        if (moved._tag === "Success") {
          const carried =
            queued.length === 0
              ? null
              : yield* carryQueue(threadId, destination, moved.success.threadId, queued);
          results.push({
            threadId,
            title,
            outcome: "moved",
            detail:
              [moved.success.notice, carried]
                .filter((part): part is string => part !== null && part !== "")
                .join(" ")
                .slice(0, 500) || null,
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
        // The saved run keeps the reasons older servers read; Away keeps its own session.
        reason: input.reason === "sleep" ? "sleep" : "manual",
        startedAt,
        finishedAt: yield* nowIso,
        results,
      };
      yield* handoff.updateDocument(
        (current) => [undefined, { ...current, machineRun: run }] as const,
      );
      return run;
    });

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

  /** What the tag's lease tick does with a heartbeat answer naming continuations. */
  const heard = (peer: EnvironmentId, response: HeartbeatResponse) =>
    Effect.gen(function* () {
      const answer = { value: response };
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
    });

  return {
    handOff: (input: HandOffInput) => handOffAs(input, "handoff"),
    handOffMachine,
    heard,
  };
});
