import {
  CommandId,
  MessageId,
  type ProviderInstanceId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type ServerProvider,
  ThreadId,
} from "@specweave-studio/contracts";
import {
  isContextHandoffBudgetMessage,
  latestRootProviderFailure,
} from "@specweave-studio/shared/orchestrationV2ThreadError";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { CONTEXT_HANDOFF_BUDGET_FAILURE_CODE } from "./ContextHandoffDelivery.ts";
import {
  CONTEXT_COMPACT_MESSAGE_PREFIX,
  CONTEXT_RETRY_MESSAGE_PREFIX,
} from "./contextRecoveryIds.ts";
import {
  isBlockingRuntimeRequest,
  pendingRequestDetailMemo,
  withPendingRequestDetail,
} from "./blockingRuntimeRequest.ts";
import { MachineLimitHandoff } from "./MachineLimitHandoff.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { fallbackMove, isOpenFailure } from "./providerOpenFailure.ts";
import { SWEEP_SHELL_SNAPSHOT_MAX_AGE_MS } from "./ShellSnapshotCache.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import {
  PROVIDER_FALLBACK_CONTINUE_TEXT,
  PROVIDER_RETRY_MESSAGE_PREFIX,
} from "./unopenableFallback.ts";

/**
 * A turn that failed because the conversation no longer fits the model
 * (Claude's `prompt_too_long`, a refill right after compaction, or a
 * provider handoff that does not fit, `ContextHandoffBudgetError`) is
 * recovered the way a person would with the "Resume with less context"
 * banner: the thread is compacted, then the request that got no answer is
 * sent again. Each step is one run whose message id names the failed run:
 *
 * 1. `context-compact:<thread>:<failed run>` sends `/compact`.
 * 2. Once that run ends, `context-retry:<thread>:<failed run>` resends the
 *    failed run's request.
 * 3. A retry or compaction that overflows again is left failed and visible.
 *
 * A provider without native compaction (no `compact` slash command) gets no
 * `/compact` and no resend: the same request into the same context would
 * overflow again. The ids live in the runs themselves, so a restart neither
 * repeats a step nor loses its place, and a failed recovery run never starts
 * another. A person's own message in between ends the recovery; automatic
 * deliveries (wakes, delegated results) that ran in between do not, so the
 * request is still resent after them. A compaction that fails because its
 * provider could not open or ran into a usage limit is left to the provider
 * fallback and limit recovery; once their continuation of it ends, the
 * request is resent as after the compaction itself.
 *
 * A handoff that does not fit (`ContextHandoffBudgetError`) is not compacted:
 * the turn start already replaces a native session too full for the handoff,
 * so what is left does not fit even a fresh session of that model, and
 * compaction cannot shrink the request. That stop, and step 3, belong to the
 * provider fallback, which moves the thread to a model whose window holds it
 * (see `contextOverflowStop`).
 */

export {
  CONTEXT_COMPACT_MESSAGE_PREFIX,
  CONTEXT_RETRY_MESSAGE_PREFIX,
} from "./contextRecoveryIds.ts";

/** The scheduler ticks every five seconds; the shell snapshot is shared at this age. */
export const CONTEXT_RECOVERY_SWEEP_INTERVAL_MS = 30_000;
/** A failure older than this is left alone: a resend after a long outage surprises more than it helps. */
export const CONTEXT_RECOVERY_MAX_AGE_MS = 60 * 60_000;
/** Recoveries one thread may start within `CONTEXT_RECOVERY_CAP_WINDOW_MS`. */
export const CONTEXT_RECOVERY_MAX_PER_THREAD = 3;
export const CONTEXT_RECOVERY_CAP_WINDOW_MS = 6 * 60 * 60_000;
/** Runs looked back over, past automatic deliveries, for the request a recovery answers. */
const LOOK_BACK_RUNS = 20;
/** Tries of one step whose dispatch fails, each under its own command id, further apart each time. */
const DISPATCH_ATTEMPTS = 3;
const DISPATCH_BACKOFF_MS = 60_000;

const OVERFLOW_CODES: ReadonlySet<string> = new Set([
  "prompt_too_long",
  "rapid_refill_breaker",
  "context_length_exceeded",
  CONTEXT_HANDOFF_BUDGET_FAILURE_CODE,
]);

/**
 * Claude's result error keeps the subtype or HTTP status as its code and the
 * reason in its message (ClaudeAdapterV2 `terminalResultError`), and a
 * wrapped turn-start failure keeps only the message.
 */
const OVERFLOW_MESSAGES: ReadonlyArray<RegExp> = [
  /exceeds the model's context window/i,
  /context refilled too quickly/i,
  /\bprompt is too long\b/i,
  /\bmaximum context length\b/i,
  /\bcontext[_ ]length[_ ]exceeded\b/i,
];

type FailureFacts = Pick<OrchestrationV2ProviderFailure, "class" | "code" | "message">;

/** A failure the provider fallback or usage-limit recovery owns, never this recovery. */
const isOwnedElsewhere = (failure: FailureFacts): boolean =>
  failure.class === "usage_limit" || isOpenFailure({ retryable: null, ...failure });

/** Whether a run failed because its handoff to the provider did not fit, in either wording. */
function isContextHandoffBudgetFailure(failure: FailureFacts | null | undefined): boolean {
  if (failure == null || isOwnedElsewhere(failure)) return false;
  return (
    failure.code === CONTEXT_HANDOFF_BUDGET_FAILURE_CODE ||
    isContextHandoffBudgetMessage(failure.message)
  );
}

/** Whether a run failed because its conversation does not fit the model. */
export function isContextOverflowFailure(failure: FailureFacts | null | undefined): boolean {
  if (failure == null || isOwnedElsewhere(failure)) return false;
  if (failure.code != null && OVERFLOW_CODES.has(failure.code)) return true;
  return (
    isContextHandoffBudgetMessage(failure.message) ||
    OVERFLOW_MESSAGES.some((pattern) => pattern.test(failure.message))
  );
}

const epochMs = (at: DateTime.Utc | null | undefined): number =>
  at == null ? Number.NaN : DateTime.toEpochMillis(at);

type RecoveryThread = Pick<
  OrchestrationV2ThreadShell,
  | "id"
  | "status"
  | "lastErrorClass"
  | "latestRunId"
  | "latestRunCompletedAt"
  | "activeRunId"
  | "pendingRuntimeRequest"
  | "settledOverride"
  | "lineage"
> &
  Partial<
    Pick<
      OrchestrationV2ThreadShell,
      "archivedAt" | "activityRunStatus" | "heldQueuedCount" | "pendingBackgroundTasks"
    >
  >;

/**
 * Whether the shell alone allows a recovery step: the latest run ended
 * recently and nothing else is going on. Busy threads, questions that hold
 * the thread (an approval or live question, see isBlockingRuntimeRequest; a
 * shell summary without the request's detail counts as one) and settled
 * threads are left alone. A delegated subagent is recovered too: someone is
 * waiting for its answer, and the per-thread cap keeps it from repeating.
 * A held queue is read from the runs
 * (`queueAllowsRecovery`): the failure itself holds it.
 */
export function isContextRecoveryCandidate(thread: RecoveryThread, nowMs: number): boolean {
  if (
    (thread.archivedAt ?? null) !== null ||
    thread.latestRunId === null ||
    thread.activeRunId !== null ||
    isBlockingRuntimeRequest(thread, thread.latestRunId) ||
    (thread.activityRunStatus ?? null) !== null ||
    thread.settledOverride === "settled" ||
    (thread.status !== "failed" && thread.status !== "completed") ||
    (thread.status === "failed" && thread.lastErrorClass === "usage_limit")
  )
    return false;
  const endedMs = epochMs(thread.latestRunCompletedAt);
  return Number.isFinite(endedMs) && nowMs - endedMs < CONTEXT_RECOVERY_MAX_AGE_MS;
}

/**
 * Whether the thread's queue lets a recovery step start. After a failure the
 * orchestrator holds every run queued on the instance (background-task
 * notifications, delegated results) until someone continues the thread. Runs
 * held since before the latest run ended are that hold: `/compact` leaves it
 * in place, and the resend, a send like a person's, releases it, so the held
 * deliveries follow the answered request. A run that is not held, or was
 * queued after, means someone is about to start a turn. Before the resend
 * (`heldAnyTime`) every held run is the hold: the orchestrator holds the
 * queue when the server's /compact ends, and only automatic deliveries join
 * a hold, since a send releases it.
 */
export function queueAllowsRecovery(
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "status" | "queueHeld" | "requestedAt">>,
  latestRunEndedMs: number,
  heldAnyTime = false,
): boolean {
  return runs.every(
    (run) =>
      run.status !== "queued" ||
      (run.queueHeld === true && (heldAnyTime || epochMs(run.requestedAt) <= latestRunEndedMs)),
  );
}

/**
 * Whether a provider can compact natively, read like the web's manual
 * compaction gate: its snapshot lists a `compact` slash command. Null when the
 * instance is not in the snapshot (yet), so nothing is decided on it.
 */
export function providerSupportsCompaction(
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "slashCommands">>,
  instanceId: ProviderInstanceId,
): boolean | null {
  const provider = providers.find((entry) => entry.instanceId === instanceId);
  return provider === undefined
    ? null
    : provider.slashCommands.some((command) => command.name === "compact");
}

/** The failed run a recovery message id names, or null. Run ids hold colons, so it comes last. */
function recoveredRunId(
  messageId: string,
  prefix: string,
  threadId: string,
): OrchestrationV2Run["id"] | null {
  const head = `${prefix}${threadId}:`;
  return messageId.startsWith(head) && messageId.length > head.length
    ? (messageId.slice(head.length) as OrchestrationV2Run["id"])
    : null;
}

export type ContextRecoveryStep =
  | { readonly type: "compact"; readonly failedRunId: OrchestrationV2Run["id"] }
  | { readonly type: "retry"; readonly failedRunId: OrchestrationV2Run["id"] }
  | {
      readonly type: "stop";
      readonly failedRunId: OrchestrationV2Run["id"];
      readonly reason:
        | "compact-overflowed"
        | "retry-overflowed"
        | "no-compaction"
        | "handoff-too-large";
    };

/**
 * What the thread's latest run asks of the recovery, read from the run's own
 * message id and failure. A run the recovery sent never starts a new one:
 * its overflow ends the recovery instead.
 */
export function contextRecoveryStep(
  threadId: string,
  run: Pick<OrchestrationV2Run, "id" | "status" | "userMessageId">,
  failure: FailureFacts | null,
): ContextRecoveryStep | null {
  const overflowed = run.status === "failed" && isContextOverflowFailure(failure);
  const compacted = recoveredRunId(run.userMessageId, CONTEXT_COMPACT_MESSAGE_PREFIX, threadId);
  if (compacted !== null) {
    // A compaction that ran into the same wall leaves nothing smaller to resend into.
    if (overflowed) return { type: "stop", failedRunId: compacted, reason: "compact-overflowed" };
    // A provider that could not open, or a usage limit, would fail the resend
    // too; the provider fallback and limit recovery take the thread from here.
    if (run.status === "failed" && failure !== null && isOwnedElsewhere(failure)) return null;
    // Any other end of the compaction still resends: a failed /compact must
    // not keep the request from its one retry. A cancelled or interrupted one
    // was stopped on purpose.
    return run.status === "completed" || run.status === "failed"
      ? { type: "retry", failedRunId: compacted }
      : null;
  }
  const retried = recoveredRunId(run.userMessageId, CONTEXT_RETRY_MESSAGE_PREFIX, threadId);
  if (retried !== null)
    return overflowed ? { type: "stop", failedRunId: retried, reason: "retry-overflowed" } : null;
  if (overflowed && isContextHandoffBudgetFailure(failure))
    return { type: "stop", failedRunId: run.id, reason: "handoff-too-large" };
  return overflowed ? { type: "compact", failedRunId: run.id } : null;
}

/** Usage-limit recovery's resume names the stopped run inside: `limit-resume:<thread>:<run>:...`. */
const LIMIT_RESUME_MESSAGE_PREFIX = "limit-resume:";

/** The run a server continuation (provider retry, fallback move, limit resume) carries on. */
function continuedRunId(
  threadId: string,
  messageId: string,
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "id">>,
): string | null {
  const retried = recoveredRunId(messageId, PROVIDER_RETRY_MESSAGE_PREFIX, threadId);
  if (retried !== null) return retried;
  const moved = fallbackMove(threadId, messageId);
  if (moved !== null) return moved.runId;
  const resume = `${LIMIT_RESUME_MESSAGE_PREFIX}${threadId}:`;
  if (!messageId.startsWith(resume)) return null;
  // Run ids hold colons: the longest that fits is the one named.
  return (
    runs
      .filter((candidate) => messageId.startsWith(`${resume}${candidate.id}:`))
      .toSorted((left, right) => right.id.length - left.id.length)[0]?.id ?? null
  );
}

/**
 * The server `/compact` that `run` carries on through server continuations
 * (a provider-ready retry, a fallback move, a usage-limit resume, or a chain
 * of them), or null when it continues nothing of the kind. Such a
 * continuation is the compaction step for the overflow the `/compact` answers.
 */
export function continuedCompaction<R extends Pick<OrchestrationV2Run, "id" | "userMessageId">>(
  threadId: string,
  run: R,
  runs: ReadonlyArray<R>,
): R | null {
  const seen = new Set<string>([run.id]);
  let current = run;
  for (;;) {
    const continued = continuedRunId(threadId, current.userMessageId, runs);
    const next = runs.find((candidate) => candidate.id === continued);
    if (next === undefined || seen.has(next.id)) return null;
    if (recoveredRunId(next.userMessageId, CONTEXT_COMPACT_MESSAGE_PREFIX, threadId) !== null)
      return next;
    seen.add(next.id);
    current = next;
  }
}

/**
 * A run no one sent: a background-task notification, a delegated result, or
 * another message the system queued (never the recovery's own `/compact`).
 * Such a run does not end a recovery the way a person's message does.
 */
export function isAutomaticDelivery(
  threadId: string,
  run: Pick<OrchestrationV2Run, "userMessageId" | "delegatedCompletion">,
  message:
    | Pick<OrchestrationV2ConversationMessage, "createdBy" | "notification" | "delegatedCompletion">
    | undefined,
): boolean {
  if (run.userMessageId.startsWith(`${CONTEXT_COMPACT_MESSAGE_PREFIX}${threadId}:`)) return false;
  return (
    run.delegatedCompletion !== undefined ||
    (message !== undefined &&
      (message.notification !== undefined ||
        message.delegatedCompletion !== undefined ||
        message.createdBy === "system"))
  );
}

const isCompactText = (text: string | undefined) => text?.trim().toLowerCase() === "/compact";

export function contextCompactCommand(
  threadId: ThreadId,
  failedRunId: OrchestrationV2Run["id"],
): Extract<OrchestrationV2ServerCommand, { type: "message.dispatch" }> {
  const id = `${CONTEXT_COMPACT_MESSAGE_PREFIX}${threadId}:${failedRunId}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(id),
    messageId: MessageId.make(id),
    threadId,
    text: "/compact",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "system",
    creationSource: "server",
  };
}

/**
 * The failed run's request, sent again as its own turn. The orchestrator
 * continues only an interrupted or usage-limited run, so this carries the
 * request itself; without one it asks the agent to continue.
 */
export function contextRetryCommand(
  threadId: ThreadId,
  failedRunId: OrchestrationV2Run["id"],
  request: Pick<OrchestrationV2ConversationMessage, "text" | "attachments" | "context"> | null,
): Extract<OrchestrationV2ServerCommand, { type: "message.dispatch" }> {
  const id = `${CONTEXT_RETRY_MESSAGE_PREFIX}${threadId}:${failedRunId}`;
  const resend =
    request !== null && (request.text.trim().length > 0 || request.attachments.length > 0);
  return {
    type: "message.dispatch",
    commandId: CommandId.make(id),
    messageId: MessageId.make(id),
    threadId,
    text: resend ? request.text : PROVIDER_FALLBACK_CONTINUE_TEXT,
    attachments: resend ? request.attachments : [],
    ...(resend && request.context !== undefined ? { context: request.context } : {}),
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "server",
  };
}

/**
 * Starts at most `CONTEXT_RECOVERY_MAX_PER_THREAD` recoveries in the window:
 * a thread that overflows on every request stops being retried.
 */
export function recoveryCapReached(
  starts: ReadonlyArray<number> | undefined,
  nowMs: number,
): boolean {
  return (
    (starts ?? []).filter((at) => nowMs - at < CONTEXT_RECOVERY_CAP_WINDOW_MS).length >=
    CONTEXT_RECOVERY_MAX_PER_THREAD
  );
}

export const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const machineHandoff = yield* MachineLimitHandoff;
  // Optional, so a sweep built without the registry assumes compaction works.
  const registry = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
  const lastRunAt = yield* Ref.make(Number.NEGATIVE_INFINITY);
  // The step for a thread's latest run, and when the run it answers ended.
  type Found = { readonly step: ContextRecoveryStep | null; readonly answeredAtMs: number };
  // A run's message id and final failure never change: each ended run is read once.
  const reads = yield* Ref.make(new Map<string, Found>());
  // Command ids sent (or given up on), and the attempts of those whose dispatch failed.
  const sent = yield* Ref.make(new Set<string>());
  const attempts = yield* Ref.make(
    new Map<string, { readonly failures: number; readonly lastFailureAt: number }>(),
  );
  // When each thread's recoveries started, for the per-thread cap.
  const starts = yield* Ref.make(new Map<string, ReadonlyArray<number>>());
  const started = yield* Ref.make(new Set<string>());

  // Only an approval or a live question holds the thread (isBlockingRuntimeRequest).
  // The shell names its newest request alone, so a thread with one is read for
  // the rest, once per thread state.
  const requestDetails =
    pendingRequestDetailMemo<OrchestrationV2ThreadShell["pendingRuntimeRequest"]>();
  const withRequestDetail = (thread: OrchestrationV2ThreadShell) =>
    Effect.gen(function* () {
      const pending = thread.pendingRuntimeRequest;
      if (pending === null) return thread;
      let detailed = requestDetails.get(thread);
      if (detailed === undefined) {
        const records = yield* projections
          .getThreadRecords(thread.id, ["runtimeRequests", "nodes"])
          .pipe(Effect.orElseSucceed(() => null));
        if (records === null) return thread;
        detailed = isBlockingRuntimeRequest(records, thread.latestRunId)
          ? pending
          : withPendingRequestDetail(thread, records).pendingRuntimeRequest;
        requestDetails.set(thread, detailed);
      }
      return { ...thread, pendingRuntimeRequest: detailed };
    });

  const errorsOf = (threadId: ThreadId, runId: OrchestrationV2Run["id"]) =>
    projections
      .getThreadRecords(threadId, ["turnItems"], {
        turnItemRunIds: [runId],
        turnItemTypes: ["error"],
      })
      .pipe(Effect.map((records) => records.turnItems));
  const messagesOf = (
    threadId: ThreadId,
    messageIds: ReadonlyArray<OrchestrationV2Run["userMessageId"]>,
  ) =>
    projections
      .getThreadRecords(threadId, ["messages"], { messageIds: [...messageIds] })
      .pipe(Effect.map((records) => records.messages));

  /**
   * The step for the run a recovery answers: from the `/compact` it carries
   * on when it is a server continuation of one, else from its own message id
   * and failure. Never a step that already has its run.
   */
  const answeredStep = (
    threadId: ThreadId,
    answered: OrchestrationV2Run,
    failure: FailureFacts | null,
    runs: ReadonlyArray<OrchestrationV2Run>,
  ): ContextRecoveryStep | null => {
    const compaction = continuedCompaction(threadId, answered, runs);
    const step = contextRecoveryStep(
      threadId,
      compaction === null ? answered : { ...answered, userMessageId: compaction.userMessageId },
      failure,
    );
    const ran =
      step?.type === "compact"
        ? contextCompactCommand(threadId, step.failedRunId).messageId
        : step?.type === "retry"
          ? contextRetryCommand(threadId, step.failedRunId, null).messageId
          : null;
    return ran !== null && runs.some((run) => run.userMessageId === ran) ? null : step;
  };

  const stepOf = Effect.fn("ContextOverflowRecoveryWorker.stepOf")(function* (
    thread: OrchestrationV2ThreadShell,
  ) {
    const runId = thread.latestRunId!;
    const key = `${thread.id}:${runId}:${thread.status}`;
    const cached = (yield* Ref.get(reads)).get(key);
    if (cached !== undefined) return { key, found: cached };
    const endedMs = epochMs(thread.latestRunCompletedAt);
    const none: Found = { step: null, answeredAtMs: endedMs };
    const found = yield* Effect.gen(function* () {
      const records = yield* projections.getThreadRecords(thread.id, ["runs", "turnItems"], {
        runIds: [runId],
        turnItemRunIds: [runId],
        turnItemTypes: ["error"],
      });
      const latest = records.runs.find((candidate) => candidate.id === runId);
      if (latest === undefined) return none;
      const failure = latestRootProviderFailure(latest, records.turnItems);
      // A server continuation may carry on a `/compact` that could not run.
      const continues =
        continuedRunId(thread.id, latest.userMessageId, [latest]) !== null ||
        latest.userMessageId.startsWith(`${LIMIT_RESUME_MESSAGE_PREFIX}${thread.id}:`);
      const own = continues ? null : contextRecoveryStep(thread.id, latest, failure);
      if (own !== null && own.type !== "compact") return { step: own, answeredAtMs: endedMs };
      // A wake that ran, or overflowed, before the recovery of the request
      // ahead of it went on, leaves that recovery to go on.
      const automatic =
        !continues &&
        isAutomaticDelivery(
          thread.id,
          latest,
          (yield* messagesOf(thread.id, [latest.userMessageId]))[0],
        );
      if (!continues && !automatic) return { step: own, answeredAtMs: endedMs };
      const runs = (yield* projections.getThreadRecords(thread.id, ["runs"])).runs;
      if (continues)
        return { step: answeredStep(thread.id, latest, failure, runs), answeredAtMs: endedMs };
      const earlier = runs
        .filter((candidate) => candidate.ordinal < latest.ordinal && candidate.status !== "queued")
        .toSorted((left, right) => right.ordinal - left.ordinal)
        .slice(0, LOOK_BACK_RUNS);
      const messages = yield* messagesOf(
        thread.id,
        earlier.map((candidate) => candidate.userMessageId),
      );
      const answered = earlier.find(
        (candidate) =>
          !isAutomaticDelivery(
            thread.id,
            candidate,
            messages.find((message) => message.id === candidate.userMessageId),
          ),
      );
      if (answered === undefined) return { step: own, answeredAtMs: endedMs };
      const step = answeredStep(
        thread.id,
        answered,
        latestRootProviderFailure(answered, yield* errorsOf(thread.id, answered.id)),
        runs,
      );
      return step === null
        ? { step: own, answeredAtMs: endedMs }
        : { step, answeredAtMs: epochMs(answered.completedAt) };
    }).pipe(Effect.orElseSucceed(() => none));
    return { key, found };
  });

  const requestOf = (threadId: ThreadId, runId: OrchestrationV2Run["id"]) =>
    Effect.gen(function* () {
      const runs = yield* projections.getThreadRecords(threadId, ["runs"], { runIds: [runId] });
      const run = runs.runs.find((candidate) => candidate.id === runId);
      if (run === undefined) return null;
      const messages = yield* projections.getThreadRecords(threadId, ["messages"], {
        messageIds: [run.userMessageId],
      });
      return messages.messages.find((message) => message.id === run.userMessageId) ?? null;
    }).pipe(Effect.orElseSucceed(() => null));

  /** The thread is still where the snapshot found it, with nothing queued but the failure's hold. */
  const stillIdle = (thread: OrchestrationV2ThreadShell, nowMs: number, heldAnyTime: boolean) =>
    Effect.gen(function* () {
      const shell = yield* projections
        .getThreadShell(thread.id)
        .pipe(Effect.orElseSucceed(() => null));
      if (shell === null || shell.latestRunId !== thread.latestRunId) return false;
      const current = yield* withRequestDetail(shell);
      if (!isContextRecoveryCandidate(current, nowMs)) return false;
      if (yield* machineHandoff.localTurnBlocked(thread.id)) return false;
      return yield* projections.getThreadRecords(thread.id, ["runs"]).pipe(
        Effect.map((records) =>
          queueAllowsRecovery(records.runs, epochMs(current.latestRunCompletedAt), heldAnyTime),
        ),
        Effect.orElseSucceed(() => false),
      );
    });

  /** Whether the instance the `/compact` would run on compacts natively; null while unknown. */
  const compactionSupported = (instanceId: ProviderInstanceId) =>
    Option.isNone(registry)
      ? Effect.succeed<boolean | null>(true)
      : registry.value.getProviders.pipe(
          Effect.map((providers) => providerSupportsCompaction(providers, instanceId)),
        );

  const dispatch = (
    thread: OrchestrationV2ThreadShell,
    step: ContextRecoveryStep,
    base: Extract<OrchestrationV2ServerCommand, { type: "message.dispatch" }>,
    nowMs: number,
  ) =>
    Effect.gen(function* () {
      const baseId = base.commandId as string;
      const tries = (yield* Ref.get(attempts)).get(baseId);
      if (tries !== undefined && nowMs - tries.lastFailureAt < DISPATCH_BACKOFF_MS * tries.failures)
        return;
      // The orchestrator refuses a rejected id for good, so a later try gets its own.
      const command =
        tries === undefined
          ? base
          : { ...base, commandId: CommandId.make(`${baseId}:retry-${tries.failures}`) };
      yield* Ref.update(sent, (current) => new Set(current).add(baseId));
      yield* threads.dispatch(command).pipe(
        Effect.tap(() =>
          Effect.logInfo("orchestration-v2.context-recovery.dispatched", {
            threadId: thread.id,
            step: step.type,
            failedRunId: step.failedRunId,
          }),
        ),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.gen(function* () {
                const failures = (tries?.failures ?? 0) + 1;
                yield* Ref.update(attempts, (current) =>
                  new Map(current).set(baseId, { failures, lastFailureAt: nowMs }),
                );
                // Freed for the next sweep until the tries run out; then it rests.
                if (failures < DISPATCH_ATTEMPTS)
                  yield* Ref.update(sent, (current) => {
                    const next = new Set(current);
                    next.delete(baseId);
                    return next;
                  });
                yield* Effect.logWarning("orchestration-v2.context-recovery.dispatch-failed", {
                  threadId: thread.id,
                  step: step.type,
                  failures,
                  cause,
                });
              }),
        ),
      );
    });

  return Effect.fn("ContextOverflowRecoveryWorker.sweep")(function* () {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    if (now - (yield* Ref.get(lastRunAt)) < CONTEXT_RECOVERY_SWEEP_INTERVAL_MS) return;
    yield* Ref.set(lastRunAt, now);
    const snapshot = yield* projections.getShellSnapshot({
      location: "active",
      unsettledOnly: true,
      maxAgeMs: SWEEP_SHELL_SNAPSHOT_MAX_AGE_MS,
    });
    requestDetails.retain(snapshot.threads.map((thread) => thread.id));
    const nextReads = new Map<string, Found>();
    for (const listed of snapshot.threads) {
      // A pending request is read for its detail only on an otherwise eligible thread.
      if (!isContextRecoveryCandidate({ ...listed, pendingRuntimeRequest: null }, now)) continue;
      const thread = yield* withRequestDetail(listed);
      if (!isContextRecoveryCandidate(thread, now)) continue;
      const { key, found } = yield* stepOf(thread);
      nextReads.set(key, found);
      const step = found.step;
      // A request answered by a run before a wake is recovered within the same age.
      if (step === null || !(now - found.answeredAtMs < CONTEXT_RECOVERY_MAX_AGE_MS)) continue;
      const base =
        step.type === "compact"
          ? contextCompactCommand(thread.id, step.failedRunId)
          : step.type === "retry"
            ? contextRetryCommand(thread.id, step.failedRunId, null)
            : null;
      const doneKey = base?.commandId ?? `context-stop:${thread.id}:${step.failedRunId}`;
      if ((yield* Ref.get(sent)).has(doneKey)) continue;
      if (step.type === "stop") {
        yield* Ref.update(sent, (current) => new Set(current).add(doneKey));
        yield* Effect.logWarning("orchestration-v2.context-recovery.stopped", {
          threadId: thread.id,
          failedRunId: step.failedRunId,
          reason: step.reason,
        });
        continue;
      }
      if (!(yield* stillIdle(thread, now, step.type === "retry"))) continue;
      if (step.type === "compact") {
        const request = yield* requestOf(thread.id, step.failedRunId);
        // A /compact that overflowed has no request to resend and nothing smaller to compact into.
        if (isCompactText(request?.text)) {
          yield* Ref.update(sent, (current) => new Set(current).add(doneKey));
          continue;
        }
        const compacts = yield* compactionSupported(thread.modelSelection.instanceId);
        if (compacts === null) continue;
        if (!compacts) {
          // The provider would get "/compact" as a prompt, or refuse it, and
          // the resend would hit the same wall: the failure stays visible.
          yield* Ref.update(sent, (current) => new Set(current).add(doneKey));
          yield* Effect.logWarning("orchestration-v2.context-recovery.stopped", {
            threadId: thread.id,
            failedRunId: step.failedRunId,
            reason: "no-compaction",
            providerInstanceId: thread.modelSelection.instanceId,
          });
          continue;
        }
        if (recoveryCapReached((yield* Ref.get(starts)).get(thread.id), now)) {
          yield* Ref.update(sent, (current) => new Set(current).add(doneKey));
          yield* Effect.logWarning("orchestration-v2.context-recovery.capped", {
            threadId: thread.id,
            failedRunId: step.failedRunId,
          });
          continue;
        }
        // A dispatch tried again still answers the same failure: counted once.
        const startKey = `${thread.id}:${step.failedRunId}`;
        if (!(yield* Ref.get(started)).has(startKey)) {
          yield* Ref.update(started, (current) => new Set(current).add(startKey));
          yield* Ref.update(starts, (current) =>
            new Map(current).set(thread.id, [
              ...(current.get(thread.id) ?? []).filter(
                (at) => now - at < CONTEXT_RECOVERY_CAP_WINDOW_MS,
              ),
              now,
            ]),
          );
        }
        yield* dispatch(thread, step, base!, now);
        continue;
      }
      const request = yield* requestOf(thread.id, step.failedRunId);
      yield* dispatch(thread, step, contextRetryCommand(thread.id, step.failedRunId, request), now);
    }
    yield* Ref.set(reads, nextReads);
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* ProviderRegistry.ProviderRegistry;
    const sweep = yield* makeSweep.pipe(
      Effect.provideService(ProviderRegistry.ProviderRegistry, registry),
    );
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register(
      "context-overflow-recovery",
      sweep().pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("context overflow recovery sweep failed", { cause }),
        ),
      ),
    );
  }),
);
