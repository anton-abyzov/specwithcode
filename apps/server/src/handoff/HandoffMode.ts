/**
 * Handoff mode (0967): checkpoints a thread's work after every turn and on an
 * interval, keeps one lease per thread with a growing epoch, and fences a
 * copy that another machine continued so no turn or external side effect
 * runs twice. Moving threads between machines lands in a later update; this
 * service already owns the state those moves read and write.
 */
import {
  HANDOFF_NOTE_MAX_WORDS,
  type HandOffInput,
  type HandOffMachineInput,
  type HandOffResult,
  type HandoffCheckpoint,
  type HandoffCheckpointReason,
  type HandoffConfigPatch,
  type HandoffContinueHereInput,
  type HandoffMachineRun,
  HandoffModeError,
  type HandoffModeSnapshot,
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

export class HandoffMode extends Context.Service<
  HandoffMode,
  {
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
  }
>()("specweave-studio/handoff/HandoffMode") {}

const later = (what: string) =>
  new HandoffModeError({
    code: "failed",
    message: `${what} arrives in a later SpecWithCode update.`,
  });

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

  const setThreadMode = (input: {
    readonly threadId: ThreadId;
    readonly mode: HandoffThreadRecord["mode"];
  }) =>
    Effect.gen(function* () {
      const shell = yield* shellOf(input.threadId);
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
    store
      .update((document) => {
        const projectModes = { ...document.projectModes };
        if (input.mode === null) delete projectModes[input.projectId];
        else projectModes[input.projectId] = input.mode;
        const next = { ...document, projectModes };
        return [next, next] as const;
      })
      .pipe(Effect.map(toSnapshot));

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
      if (effectiveMode === "off" && reason !== "manual") return null;
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
      const pushedToOrigin = document.config.pushToOrigin
        ? yield* Effect.promise(() =>
            pushCheckpointRef(written.root, written.ref).catch(() => false),
          )
        : false;
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
        transcriptMessageCount: messages.length,
        note,
        pushedToOrigin,
        epoch: record.lease?.epoch ?? 0,
        latestRunId: shell.latestRunId,
        turnKey: shell.latestRunId === null ? null : threadTurnKey(threadId, shell.latestRunId),
        runEnding,
        sideEffects: record.sideEffects,
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

  const tick = (input: { readonly checkpointRunning: boolean }) =>
    Effect.gen(function* () {
      const document = yield* store.read;
      const now = yield* nowIso;
      for (const [id, current] of Object.entries(document.threads)) {
        const threadId = id as ThreadId;
        if (current.continuedOn !== null || current.lease === null) continue;
        if (current.lease.holderEnvironmentId !== environmentId) continue;
        const shell = yield* projections
          .getThreadShell(threadId)
          .pipe(Effect.orElseSucceed(() => null));
        if (shell === null || shell.activeRunId === null) continue;
        yield* locks.withLock(
          threadId,
          updateThread(threadId, current.projectId, (latest) => ({
            ...latest,
            lease: renewLease(latest.lease, environmentId, now),
          })).pipe(Effect.ignore),
        );
        if (input.checkpointRunning) {
          yield* checkpoint(threadId, "interval").pipe(Effect.ignore);
        }
      }
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("Handoff mode tick failed", { cause })));

  return HandoffMode.of({
    snapshot,
    updateConfig,
    setThreadMode,
    setProjectMode,
    checkpointNow,
    checkpoint,
    handOff: () => Effect.fail(later("Handing a thread off")),
    handOffMachine: () => Effect.fail(later("Handing a machine off")),
    continueHere: () => Effect.fail(later("Continuing a thread here")),
    resumeFenced: Effect.fail(later("Resuming a fenced thread")),
    fence,
    guardSideEffect: guard,
    recordSideEffect: record,
    observeRun,
    tick,
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
    };
  }),
);
