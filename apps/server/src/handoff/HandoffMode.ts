import {
  childHandoffDisposition,
  localChildOwnership,
} from "../orchestration-v2/ChildMachineHandoff.ts";
/**
 * Handoff mode (0967): checkpoints a thread's work after every turn and on an
 * interval, keeps one lease per thread with a growing epoch, and fences a
 * copy that another machine continued so no turn or external side effect
 * runs twice. The moves themselves (HandoffMoves) need the fleet, which is
 * built after this service, so they attach late through `attachMoves`.
 */
import {
  HANDOFF_NOTE_MAX_WORDS,
  type HandOffInput,
  type HandOffMachineInput,
  type HandOffResult,
  type HandoffCheckpoint,
  type HandoffChildDisposition,
  type HandoffCheckpointReason,
  type HandoffConfigPatch,
  type HandoffContinueHereInput,
  type HandoffMachineRun,
  HandoffModeError,
  type HandoffModeSnapshot,
  type HandoffPreflightInput,
  type HandoffPreflightResult,
  type EnvironmentId,
  type ModelSelection,
  type HandoffNote,
  type HandoffThreadState,
  type OrchestrationV2Run,
  type OrchestrationV2RunInterruptCause,
  type ProjectId,
  type ThreadId,
  type ThreadSideEffectKind,
  WS_METHODS,
  WsHandoffModeRpcGroup,
  handoffRunEnding,
  threadTurnKey,
} from "@specweave-studio/contracts";
import * as KeyedLock from "@specweave-studio/shared/KeyedLock";
import {
  isPersonalAssistantProject,
  PERSONAL_ASSISTANT_PRIVATE_MESSAGE,
} from "@specweave-studio/shared/personalAssistant";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { RpcInstrumentation } from "../observability/RpcInstrumentation.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { CheckpointError, pushCheckpointRef, writeCheckpoint } from "./checkpointGit.ts";
import {
  capHandoffNote,
  fallbackHandoffNote,
  handoffTranscript,
  type NoteMessage,
} from "./handoffNote.ts";
import * as HandoffModeStore from "./HandoffModeStore.ts";
import {
  acquireLease,
  applyConfigPatch,
  checkEpoch,
  deriveHandoffBadge,
  effectiveHandoffMode,
  emptyThreadRecord,
  type EpochVerdict,
  guardSideEffect,
  type HandoffDocument,
  type HandoffThreadRecord,
  noteRunEpoch,
  recordSideEffect,
  renewLease,
  type SideEffectVerdict,
} from "./handoffState.ts";

const NOTE_TIMEOUT = "45 seconds";
const ACTIVE_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

export interface SideEffectInput {
  readonly threadId: ThreadId;
  readonly runId: string;
  readonly kind: ThreadSideEffectKind;
  readonly target: string;
}

/** The moves between machines and models, provided by HandoffMoves once the fleet exists. */
export interface HandoffMovesPort {
  readonly handOff: (input: HandOffInput) => Effect.Effect<HandOffResult, HandoffModeError>;
  readonly handOffMachine: (
    input: HandOffMachineInput,
  ) => Effect.Effect<HandoffMachineRun, HandoffModeError>;
  readonly continueHere: (
    input: HandoffContinueHereInput,
  ) => Effect.Effect<HandOffResult, HandoffModeError>;
  readonly resumeFenced: Effect.Effect<HandoffModeSnapshot, HandoffModeError>;
  readonly preflight: (
    input: HandoffPreflightInput,
  ) => Effect.Effect<ReadonlyArray<HandoffPreflightResult>, HandoffModeError>;
  /** Heartbeats leases to the machines that hold replicas; marks silent sources unknown. */
  readonly heartbeat: Effect.Effect<void>;
  /** Ships checkpoints the replica machines lack, backing off a failing destination. */
  readonly replicate: Effect.Effect<void>;
  /** Both of the above, in order. */
  readonly tick: Effect.Effect<void>;
}

export class HandoffMode extends Context.Service<
  HandoffMode,
  {
    readonly environmentId: EnvironmentId;
    readonly machineLabel: string;
    /** The handoff document, shared with the turn gate (one cached file). */
    readonly document: Effect.Effect<HandoffDocument, HandoffModeError>;
    readonly updateDocument: <A>(
      change: (document: HandoffDocument) => readonly [A, HandoffDocument],
    ) => Effect.Effect<A, HandoffModeError>;
    readonly attachMoves: (port: HandoffMovesPort) => Effect.Effect<void>;
    readonly snapshot: Effect.Effect<HandoffModeSnapshot, HandoffModeError>;
    readonly updateConfig: (
      patch: HandoffConfigPatch,
    ) => Effect.Effect<HandoffModeSnapshot, HandoffModeError>;
    readonly setThreadMode: (input: {
      readonly threadId: ThreadId;
      readonly mode: HandoffThreadRecord["mode"];
    }) => Effect.Effect<HandoffModeSnapshot, HandoffModeError>;
    readonly setProjectMode: (input: {
      readonly projectId: ProjectId;
      readonly mode: HandoffDocument["config"]["defaultMode"] | null;
    }) => Effect.Effect<HandoffModeSnapshot, HandoffModeError>;
    readonly checkpointNow: (input: {
      readonly threadId: ThreadId;
    }) => Effect.Effect<HandoffModeSnapshot, HandoffModeError>;
    /** Writes a checkpoint; null when the thread is not in handoff mode or nothing changed. */
    readonly checkpoint: (
      threadId: ThreadId,
      reason: HandoffCheckpointReason,
    ) => Effect.Effect<HandoffCheckpoint | null, HandoffModeError>;
    readonly handOff: (input: HandOffInput) => Effect.Effect<HandOffResult, HandoffModeError>;
    readonly handOffMachine: (
      input: HandOffMachineInput,
    ) => Effect.Effect<HandoffMachineRun, HandoffModeError>;
    readonly continueHere: (
      input: HandoffContinueHereInput,
    ) => Effect.Effect<HandOffResult, HandoffModeError>;
    readonly resumeFenced: Effect.Effect<HandoffModeSnapshot, HandoffModeError>;
    readonly preflight: (
      input: HandoffPreflightInput,
    ) => Effect.Effect<ReadonlyArray<HandoffPreflightResult>, HandoffModeError>;
    /**
     * May this machine act for the thread now? `runId` checks the epoch the
     * run started under. Never fails: a store it cannot read counts as unleased.
     */
    readonly fence: (threadId: ThreadId, runId?: string | null) => Effect.Effect<EpochVerdict>;
    /** Before an external side effect: proceed, reuse the journaled result, or refuse. */
    readonly guardSideEffect: (input: SideEffectInput) => Effect.Effect<SideEffectVerdict>;
    /** Journals a side effect a turn performed, so a continuation never repeats it. */
    readonly recordSideEffect: (
      input: SideEffectInput & { readonly result: string | null },
    ) => Effect.Effect<void>;
    /** Takes or renews the lease when a run starts; checkpoints when it ends. */
    readonly observeRun: (run: OrchestrationV2Run) => Effect.Effect<void>;
    /** Renews leases held here and checkpoints threads still running (interval reason). */
    readonly tick: (input: { readonly checkpointRunning: boolean }) => Effect.Effect<void>;
    /**
     * The lease half of `tick`: renews leases and heartbeats peers. Never waits on
     * a checkpoint or a replication, so a slow one cannot delay a renewal.
     */
    readonly heartbeat: Effect.Effect<void>;
    /** The checkpoint half of `tick`: interval checkpoints, then replication. */
    readonly replicate: (input: { readonly checkpointRunning: boolean }) => Effect.Effect<void>;
  }
>()("specweave-studio/handoff/HandoffMode") {}

const notStarted = new HandoffModeError({ code: "busy", message: "Handoff is still starting." });

const describe = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message.slice(0, 500);
  return String(cause).slice(0, 500);
};

export const make = Effect.gen(function* () {
  const store = yield* HandoffModeStore.HandoffModeStore;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectService.ProjectService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const locks = yield* KeyedLock.make<string>();

  const environmentId = yield* environment.getEnvironmentId;
  const machineLabel = (yield* environment.getDescriptor).label;
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  let moves: HandoffMovesPort | null = null;

  const shellOf = (threadId: ThreadId) =>
    projections.getThreadShell(threadId).pipe(
      Effect.mapError(
        () => new HandoffModeError({ code: "failed", message: "Could not read the thread." }),
      ),
      Effect.flatMap((shell) =>
        shell === null
          ? Effect.fail(new HandoffModeError({ code: "not_found", message: "No such thread." }))
          : Effect.succeed(shell),
      ),
    );

  const threadState = (
    document: HandoffDocument,
    threadId: string,
    record: HandoffThreadRecord,
  ): HandoffThreadState => {
    const effectiveMode = effectiveHandoffMode(document, record.projectId, record.mode);
    return {
      threadId: threadId as ThreadId,
      projectId: record.projectId,
      mode: record.mode,
      effectiveMode,
      badge: deriveHandoffBadge({
        record,
        effectiveMode,
        paused: document.pausedSince !== null,
      }),
      checkpoint: record.checkpoint,
      replicas: record.replicas,
      lease: record.lease,
      continuedOn: record.continuedOn,
      fencedBranch: record.fencedBranch,
      lastError: record.lastError,
    };
  };

  const toSnapshot = (document: HandoffDocument): HandoffModeSnapshot => ({
    environmentId,
    machineLabel,
    config: document.config,
    projectModes: document.projectModes,
    threads: Object.entries(document.threads).map(([threadId, record]) =>
      threadState(document, threadId, record),
    ),
    incoming: document.incoming,
    pausedSince: document.pausedSince,
    machineRun: document.machineRun,
  });

  const snapshot = Effect.map(store.read, toSnapshot);

  const updateThread = (
    threadId: ThreadId,
    projectId: ProjectId,
    change: (record: HandoffThreadRecord, document: HandoffDocument) => HandoffThreadRecord,
  ) =>
    store.update((document) => {
      const current = document.threads[threadId] ?? emptyThreadRecord(projectId);
      const next = change(current, document);
      return [next, { ...document, threads: { ...document.threads, [threadId]: next } }] as const;
    });

  const updateConfig = (patch: HandoffConfigPatch) =>
    store
      .update((document) => {
        const next = { ...document, config: applyConfigPatch(document.config, patch) };
        return [next, next] as const;
      })
      .pipe(Effect.map(toSnapshot));

  /**
   * A personal assistant's threads never get handoff mode: they stay on their machine.
   * A project that is not on this machine has nothing to set (its id belongs to another one).
   */
  const refuseMachinePrivate = (projectId: ProjectId, mustExist = false) =>
    projects.getById(projectId).pipe(
      Effect.orElseSucceed(() => Option.none()),
      Effect.flatMap((project) =>
        Option.isNone(project)
          ? mustExist
            ? Effect.fail(
                new HandoffModeError({
                  code: "invalid",
                  message: "That project is not on this machine.",
                }),
              )
            : Effect.void
          : isPersonalAssistantProject(project.value.workspaceSettings)
            ? Effect.fail(
                new HandoffModeError({
                  code: "invalid",
                  message: PERSONAL_ASSISTANT_PRIVATE_MESSAGE,
                }),
              )
            : Effect.void,
      ),
    );

  const setThreadMode = (input: {
    readonly threadId: ThreadId;
    readonly mode: HandoffThreadRecord["mode"];
  }) =>
    Effect.gen(function* () {
      const shell = yield* shellOf(input.threadId);
      if (input.mode === "on") yield* refuseMachinePrivate(shell.projectId);
      yield* updateThread(input.threadId, shell.projectId, (record) => ({
        ...record,
        mode: input.mode,
      }));
      return yield* snapshot;
    });

  const setProjectMode = (input: {
    readonly projectId: ProjectId;
    readonly mode: HandoffDocument["config"]["defaultMode"] | null;
  }) =>
    (input.mode === null ? Effect.void : refuseMachinePrivate(input.projectId, true)).pipe(
      Effect.andThen(
        store.update((document) => {
          const projectModes = { ...document.projectModes };
          if (input.mode === null) delete projectModes[input.projectId];
          else projectModes[input.projectId] = input.mode;
          const next = { ...document, projectModes };
          return [next, next] as const;
        }),
      ),
      Effect.map(toSnapshot),
    );

  const conversation = (threadId: ThreadId) =>
    projections
      .getThreadRecords(threadId, ["messages"], { messageRoles: ["user", "assistant"] })
      .pipe(
        Effect.map((records) =>
          records.messages
            .filter((message) => !message.streaming && message.text.trim().length > 0)
            .map((message): NoteMessage => ({
              role: message.role === "user" ? "user" : "assistant",
              text: message.text,
            })),
        ),
        Effect.orElseSucceed((): Array<NoteMessage> => []),
      );

  const latestRun = (threadId: ThreadId, runId: OrchestrationV2Run["id"] | null) =>
    Effect.gen(function* () {
      if (runId === null) return { status: null, interruptCause: null } as const;
      const records = yield* projections.getThreadRecords(threadId, ["runs", "turnItems"], {
        runIds: [runId],
        turnItemRunIds: [runId],
        turnItemTypes: ["run_interrupt_request"],
      });
      const run = records.runs.find((candidate) => candidate.id === runId);
      let interruptCause: OrchestrationV2RunInterruptCause | null = null;
      for (const item of records.turnItems) {
        if (item.type === "run_interrupt_request" && item.cause !== undefined) {
          interruptCause = item.cause;
        }
      }
      return { status: run?.status ?? null, interruptCause } as const;
    }).pipe(Effect.orElseSucceed(() => ({ status: null, interruptCause: null }) as const));

  const writeNote = (input: {
    readonly document: HandoffDocument;
    readonly projectId: ProjectId;
    readonly cwd: string;
    readonly messages: ReadonlyArray<NoteMessage>;
    readonly createdAt: string;
    readonly modelSelection: ModelSelection;
  }): Effect.Effect<HandoffNote | null> => {
    const noteModel = input.document.config.noteModel;
    if (noteModel === "off") return Effect.succeed(null);
    const fallback = fallbackHandoffNote(input.messages, input.createdAt);
    const generate = textGeneration.generateHandoffNote;
    if (generate === undefined || input.messages.length === 0) return Effect.succeed(fallback);
    return Effect.gen(function* () {
      const modelSelection =
        noteModel === "thread"
          ? input.modelSelection
          : resolveProjectSettings(yield* serverSettings.getSettings, input.projectId).settings
              .textGenerationModelSelection;
      const generated = yield* generate({
        cwd: input.cwd,
        transcript: handoffTranscript(input.messages),
        maxWords: HANDOFF_NOTE_MAX_WORDS,
        modelSelection,
      });
      const capped = capHandoffNote(generated);
      if (capped.next.length === 0 && capped.done.length === 0) return fallback;
      return { ...capped, createdAt: input.createdAt } satisfies HandoffNote;
    }).pipe(
      Effect.timeoutOption(NOTE_TIMEOUT),
      Effect.map(Option.getOrElse(() => fallback)),
      Effect.catchCause((cause) =>
        Effect.logDebug("Handoff note generation failed; using the plain note", { cause }).pipe(
          Effect.as(fallback),
        ),
      ),
    );
  };

  const recordError = (threadId: ThreadId, projectId: ProjectId, message: string | null) =>
    updateThread(threadId, projectId, (record) => ({ ...record, lastError: message })).pipe(
      Effect.ignore,
    );

  const checkpointLocked = (threadId: ThreadId, reason: HandoffCheckpointReason) =>
    Effect.gen(function* () {
      const document = yield* store.read;
      const shell = yield* shellOf(threadId);
      const record = document.threads[threadId] ?? emptyThreadRecord(shell.projectId);
      const effectiveMode = effectiveHandoffMode(document, shell.projectId, record.mode);
      if (effectiveMode === "off" && reason !== "manual" && reason !== "handoff") return null;
      if (record.continuedOn !== null) {
        if (reason !== "manual") return null;
        return yield* new HandoffModeError({
          code: "fenced",
          message: `This thread continues on ${record.continuedOn.machineLabel}.`,
        });
      }
      const project = yield* projects
        .getById(shell.projectId)
        .pipe(
          Effect.mapError(
            () => new HandoffModeError({ code: "failed", message: "Could not read the project." }),
          ),
        );
      if (Option.isNone(project)) {
        return yield* new HandoffModeError({ code: "not_found", message: "No such project." });
      }
      // A personal assistant's conversation is never checkpointed for another machine.
      if (isPersonalAssistantProject(project.value.workspaceSettings)) {
        if (reason !== "manual" && reason !== "handoff") return null;
        return yield* new HandoffModeError({
          code: "invalid",
          message: PERSONAL_ASSISTANT_PRIVATE_MESSAGE,
        });
      }
      const cwd = shell.worktreePath ?? project.value.workspaceRoot;
      const written = yield* Effect.tryPromise({
        try: () => writeCheckpoint({ cwd, threadId }),
        catch: (cause) =>
          cause instanceof CheckpointError && cause.code === "not_a_repository"
            ? new HandoffModeError({
                code: "not_a_repository",
                message: "Handoff mode needs the thread's folder to be a Git repository.",
              })
            : new HandoffModeError({ code: "failed", message: describe(cause) }),
      });
      const createdAt = yield* nowIso;
      const messages = yield* conversation(threadId);
      const run = yield* latestRun(threadId, shell.latestRunId);
      const runEnding = handoffRunEnding({
        status: run.status,
        interruptCause: run.interruptCause,
        failureClass: run.status === "failed" ? (shell.lastErrorClass ?? null) : null,
        fencedBy: record.fencedBy,
      });
      const previous = record.checkpoint;
      const unchanged =
        previous !== null &&
        previous.commit === written.commit &&
        previous.transcriptMessageCount === messages.length &&
        previous.runEnding === runEnding &&
        previous.latestRunId === shell.latestRunId;
      if (unchanged && reason !== "manual" && reason !== "handoff") return null;
      const note =
        previous !== null && previous.transcriptMessageCount === messages.length
          ? previous.note
          : yield* writeNote({
              document,
              projectId: shell.projectId,
              cwd,
              messages,
              createdAt,
              modelSelection: shell.modelSelection,
            });
      const children: Array<HandoffChildDisposition> = [];
      const seen = new Set<ThreadId>();
      const visit = (id: ThreadId, depth: number): Effect.Effect<void, HandoffModeError> =>
        Effect.gen(function* () {
          if (seen.has(id) || depth > 16)
            return yield* new HandoffModeError({
              code: "invalid",
              message:
                "Child ownership contains a cycle or exceeds 16 levels. Reconcile it before handing off.",
            });
          seen.add(id);
          const state = yield* projections.getThreadRecords(id, ["subagents"]).pipe(
            Effect.mapError(
              () =>
                new HandoffModeError({
                  code: "failed",
                  message: "Could not read child ownership for the handoff checkpoint.",
                }),
            ),
          );
          for (const child of state.subagents) {
            if (children.length >= 200)
              return yield* new HandoffModeError({
                code: "invalid",
                message: "The child roster exceeds 200 entries. Reconcile it before handing off.",
              });
            const childState =
              child.childThreadId === null
                ? null
                : yield* projections
                    .getThreadRecords(child.childThreadId, ["subagents"])
                    .pipe(Effect.orElseSucceed(() => null));
            let childRecord =
              child.childThreadId === null ? undefined : document.threads[child.childThreadId];
            const remote =
              childState === null ||
              !localChildOwnership(childState.thread, environmentId) ||
              (childRecord?.lease != null &&
                childRecord.lease.holderEnvironmentId !== environmentId);
            // An app-owned child stays on its existing source executor. The receiver
            // gets this lease reference and must never re-launch its original brief.
            if (
              !remote &&
              child.origin === "app_owned" &&
              child.childThreadId !== null &&
              childRecord?.lease == null
            ) {
              const childId = child.childThreadId;
              childRecord = yield* updateThread(childId, shell.projectId, (current) => ({
                ...current,
                lease:
                  current.lease ??
                  acquireLease(
                    null,
                    { environmentId, label: machineLabel, threadId: childId },
                    createdAt,
                  ),
              }));
            }
            const owner =
              childRecord?.lease?.holderEnvironmentId ??
              childState?.thread.execution?.executionMachineId ??
              environmentId;
            const effects = [...record.sideEffects, ...(childRecord?.sideEffects ?? [])].map(
              (effect) => ({
                id: `${effect.turnKey}:${effect.kind}:${effect.epoch}`,
                target: effect.target,
                outcome: `committed; ${effect.result ?? "consult its receipt"}`,
              }),
            );
            children.push(
              childHandoffDisposition({
                child,
                sourceEnvironmentId: owner,
                ownerEpoch: childRecord?.lease?.epoch ?? 0,
                parentInstructions:
                  messages.findLast((message) => message.role === "user")?.text ??
                  "Preserve the original scope and current thread instructions.",
                remote,
                effects,
              }),
            );
            if (!remote && child.childThreadId !== null && childState!.subagents.length > 0)
              yield* visit(child.childThreadId, depth + 1);
          }
        });
      yield* visit(threadId, 0);
      const checkpoint: HandoffCheckpoint = {
        sequence: (previous?.sequence ?? 0) + 1,
        commit: written.commit,
        baseCommit: written.baseCommit,
        branch: written.branch,
        ref: written.ref,
        createdAt,
        reason,
        skipped: [...written.skipped],
        excludedSecretCount: written.excludedSecretCount,
        requiredSecretPaths: [...written.requiredSecretPaths],
        transcriptMessageCount: messages.length,
        note,
        // Set once the background push below lands; moves never wait for it.
        pushedToOrigin: false,
        epoch: record.lease?.epoch ?? 0,
        latestRunId: shell.latestRunId,
        turnKey: shell.latestRunId === null ? null : threadTurnKey(threadId, shell.latestRunId),
        runEnding,
        sideEffects: record.sideEffects,
        children,
        sourceRoot: {
          environmentId,
          machineLabel,
          projectId: shell.projectId,
          threadId,
          workspaceRoot: written.root,
          branch: written.branch,
        },
      };
      yield* updateThread(threadId, shell.projectId, (current) => ({
        ...current,
        checkpoint,
        lastError: null,
      }));
      // The origin backup is never read by a move, so it runs outside the thread
      // lock, and a move or sleep (reason "handoff") skips it.
      if (document.config.pushToOrigin && reason !== "handoff")
        yield* Effect.promise(() =>
          pushCheckpointRef(written.root, written.ref).catch(() => false),
        ).pipe(
          Effect.flatMap((pushed) =>
            pushed
              ? updateThread(threadId, shell.projectId, (current) =>
                  current.checkpoint?.sequence === checkpoint.sequence
                    ? { ...current, checkpoint: { ...current.checkpoint, pushedToOrigin: true } }
                    : current,
                )
              : Effect.void,
          ),
          Effect.ignore,
          Effect.forkDetach,
        );
      return checkpoint;
    });

  const checkpoint = (threadId: ThreadId, reason: HandoffCheckpointReason) =>
    locks.withLock(
      threadId,
      checkpointLocked(threadId, reason).pipe(
        Effect.tapError((error) =>
          shellOf(threadId).pipe(
            Effect.flatMap((shell) => recordError(threadId, shell.projectId, error.message)),
            Effect.ignore,
          ),
        ),
      ),
    );

  const checkpointNow = (input: { readonly threadId: ThreadId }) =>
    checkpoint(input.threadId, "manual").pipe(Effect.andThen(snapshot));

  const fence = (threadId: ThreadId, runId?: string | null) =>
    store.read.pipe(
      Effect.map((document) => {
        const record = document.threads[threadId];
        const epoch = runId == null ? undefined : record?.runEpochs[runId];
        return checkEpoch(record, environmentId, epoch);
      }),
      Effect.catchCause((cause) =>
        Effect.logWarning("Handoff mode could not read its lease state", { cause }).pipe(
          Effect.as<EpochVerdict>({ kind: "unleased" }),
        ),
      ),
    );

  const guard = (input: SideEffectInput) =>
    store.read.pipe(
      Effect.map((document): SideEffectVerdict => {
        const record = document.threads[input.threadId];
        return guardSideEffect({
          record,
          environmentId,
          turnKey: threadTurnKey(input.threadId, input.runId),
          kind: input.kind,
          target: input.target,
          ...(record?.runEpochs[input.runId] === undefined
            ? {}
            : { epoch: record.runEpochs[input.runId] }),
        });
      }),
      Effect.catchCause((cause) =>
        Effect.logWarning("Handoff mode could not read its side-effect journal", { cause }).pipe(
          Effect.as<SideEffectVerdict>({
            kind: "proceed",
            epoch: 0,
            turnKey: threadTurnKey(input.threadId, input.runId),
          }),
        ),
      ),
    );

  const record = (input: SideEffectInput & { readonly result: string | null }) =>
    Effect.gen(function* () {
      const document = yield* store.read;
      const existing = document.threads[input.threadId];
      const projectId = existing?.projectId ?? (yield* shellOf(input.threadId)).projectId;
      const mode = effectiveHandoffMode(document, projectId, existing?.mode ?? "inherit");
      if (existing === undefined && mode === "off") return;
      const at = yield* nowIso;
      yield* updateThread(input.threadId, projectId, (current) =>
        recordSideEffect(current, {
          turnKey: threadTurnKey(input.threadId, input.runId),
          kind: input.kind,
          target: input.target,
          epoch: current.runEpochs[input.runId] ?? current.lease?.epoch ?? 0,
          environmentId,
          at,
          result: input.result,
        }),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Handoff mode could not journal a side effect", { cause }),
      ),
    );

  const startRun = (run: OrchestrationV2Run) =>
    Effect.gen(function* () {
      const document = yield* store.read;
      const existing = document.threads[run.threadId];
      const projectId = existing?.projectId ?? (yield* shellOf(run.threadId)).projectId;
      const mode = effectiveHandoffMode(document, projectId, existing?.mode ?? "inherit");
      if (mode === "off" && existing?.lease == null) return;
      if (existing?.continuedOn != null) return;
      const now = yield* nowIso;
      yield* updateThread(run.threadId, projectId, (current) => {
        const lease =
          current.lease === null
            ? acquireLease(
                null,
                { environmentId, label: machineLabel, threadId: run.threadId },
                now,
              )
            : renewLease(current.lease, environmentId, now);
        if (lease === null || lease.holderEnvironmentId !== environmentId) return current;
        return {
          ...current,
          lease,
          runEpochs: noteRunEpoch(current.runEpochs, run.id, lease.epoch),
          // The first run carried the idle continuation's seed; later turns do not repeat it.
          pendingSeed: null,
          // A run that starts after a handoff gave the thread back is not the one the
          // handoff interrupted, so its ending is its own.
          fencedBy:
            current.runEpochs[run.id] === undefined && current.lease?.state === "active"
              ? null
              : current.fencedBy,
        };
      });
    });

  const observeRun = (run: OrchestrationV2Run) =>
    locks
      .withLock(run.threadId, ACTIVE_RUN_STATUSES.has(run.status) ? startRun(run) : Effect.void)
      .pipe(
        Effect.andThen(
          ACTIVE_RUN_STATUSES.has(run.status)
            ? Effect.void
            : checkpoint(run.threadId, "turn-end").pipe(Effect.asVoid),
        ),
        Effect.catchCause((cause) =>
          Effect.logDebug("Handoff mode skipped a run update", { cause, threadId: run.threadId }),
        ),
      );

  /** Threads this machine holds the lease of whose turn is still running. */
  const runningHeld = Effect.gen(function* () {
    const document = yield* store.read;
    const out: Array<{ readonly threadId: ThreadId; readonly projectId: ProjectId }> = [];
    for (const [id, current] of Object.entries(document.threads)) {
      const threadId = id as ThreadId;
      if (current.continuedOn !== null || current.lease === null) continue;
      if (current.lease.holderEnvironmentId !== environmentId) continue;
      const shell = yield* projections
        .getThreadShell(threadId)
        .pipe(Effect.orElseSucceed(() => null));
      if (shell === null || shell.activeRunId === null) continue;
      out.push({ threadId, projectId: current.projectId });
    }
    return out;
  });

  const renewLeases = Effect.gen(function* () {
    const now = yield* nowIso;
    const held = yield* runningHeld;
    if (held.length === 0) return;
    // One store write for every thread; it skips the per-thread lock, so a checkpoint
    // holding that lock (Git, a note) never delays a renewal.
    yield* store.update((document) => {
      const threads = { ...document.threads };
      for (const { threadId } of held) {
        const latest = threads[threadId];
        if (latest === undefined) continue;
        threads[threadId] = { ...latest, lease: renewLease(latest.lease, environmentId, now) };
      }
      return [undefined, { ...document, threads }] as const;
    });
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("Handoff mode tick failed", { cause })));

  const checkpointRunning = Effect.gen(function* () {
    for (const { threadId } of yield* runningHeld) {
      yield* checkpoint(threadId, "interval").pipe(Effect.ignore);
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Handoff mode interval checkpoint failed", { cause }),
    ),
  );

  const heartbeat = renewLeases.pipe(
    Effect.andThen(Effect.suspend(() => moves?.heartbeat ?? Effect.void)),
  );

  const replicate = (input: { readonly checkpointRunning: boolean }) =>
    (input.checkpointRunning ? checkpointRunning : Effect.void).pipe(
      Effect.andThen(Effect.suspend(() => moves?.replicate ?? Effect.void)),
    );

  const tick = (input: { readonly checkpointRunning: boolean }) =>
    heartbeat.pipe(Effect.andThen(replicate(input)));

  const viaMoves = <A>(use: (port: HandoffMovesPort) => Effect.Effect<A, HandoffModeError>) =>
    Effect.suspend(() => (moves === null ? Effect.fail(notStarted) : use(moves)));

  return HandoffMode.of({
    environmentId,
    machineLabel,
    document: store.read,
    updateDocument: store.update,
    attachMoves: (port) =>
      Effect.sync(() => {
        moves = port;
      }),
    snapshot,
    updateConfig,
    setThreadMode,
    setProjectMode,
    checkpointNow,
    checkpoint,
    handOff: (input) => viaMoves((port) => port.handOff(input)),
    handOffMachine: (input) => viaMoves((port) => port.handOffMachine(input)),
    continueHere: (input) => viaMoves((port) => port.continueHere(input)),
    resumeFenced: viaMoves((port) => port.resumeFenced),
    preflight: (input) => viaMoves((port) => port.preflight(input)),
    fence,
    guardSideEffect: guard,
    recordSideEffect: record,
    observeRun,
    tick,
    heartbeat,
    replicate,
  });
});

export const layer = Layer.effect(HandoffMode, make).pipe(Layer.provide(HandoffModeStore.layer));

export const layerRpcHandlers = WsHandoffModeRpcGroup.middleware(RpcInstrumentation).toLayer(
  Effect.gen(function* () {
    const handoff = yield* HandoffMode;
    return {
      [WS_METHODS.handoffModeSnapshot]: () => handoff.snapshot,
      [WS_METHODS.handoffModeUpdateConfig]: handoff.updateConfig,
      [WS_METHODS.handoffModeSetThreadMode]: handoff.setThreadMode,
      [WS_METHODS.handoffModeSetProjectMode]: handoff.setProjectMode,
      [WS_METHODS.handoffModeCheckpointNow]: handoff.checkpointNow,
      [WS_METHODS.handoffModeHandOff]: handoff.handOff,
      [WS_METHODS.handoffModeHandOffMachine]: handoff.handOffMachine,
      [WS_METHODS.handoffModeContinueHere]: handoff.continueHere,
      [WS_METHODS.handoffModeResumeFenced]: () => handoff.resumeFenced,
      [WS_METHODS.handoffModePreflight]: handoff.preflight,
    };
  }),
);
