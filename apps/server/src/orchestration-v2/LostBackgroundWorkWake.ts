import {
  CommandId,
  isOrchestrationV2WorkActive,
  isProviderNativeSubagentThread,
  MessageId,
  projectExecutionIsFenced,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RestartCancelledBackgroundWork,
  type OrchestrationV2Run,
  type ThreadId,
} from "@specweave-studio/contracts";
import {
  latestRootProviderFailure,
  runRanAfter,
} from "@specweave-studio/shared/orchestrationV2ThreadError";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServiceUpdateHold from "../serviceUpdate/ServiceUpdateHold.ts";
import { localChildOwnership } from "./ChildMachineHandoff.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import { cancelledRosterTaskWork, isRestartNoteSource } from "./RestartBackgroundNote.ts";
import {
  cancelledForUpdate,
  RESTART_CONTINUATION_MESSAGE_PREFIX,
  UPDATE_CONTINUATION_MESSAGE_PREFIX,
} from "./RestartQueueHold.ts";
import { lostWorkNoteEvents } from "./SubagentSettlement.ts";
import { isPersonStopRequest } from "./systemInterruptReasons.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

/**
 * Starts a turn on a thread that is waiting for background work that will
 * never report back.
 *
 * A thread can end its turn while a background shell, subagent or Workflow
 * still runs, and go on when the provider's own process delivers the
 * completion notice. When that process is gone (a restart, an update, a
 * crash, an idle release, a usage limit) the notice never comes. Recovery
 * records the lost work on the thread's latest run for "the next turn", and
 * on an idle thread nobody starts one. This sweep does: once per source run
 * it sends the thread a message, and the turn start prepends the recorded
 * note to it, which also marks the note delivered.
 *
 * It also clears a roster whose process ended while the server kept running,
 * which nothing else notices for shells and Workflows.
 */

type Work = OrchestrationV2RestartCancelledBackgroundWork;

/** How often the sweep reads; the scheduler ticks more often than this needs. */
export const LOST_WORK_SWEEP_INTERVAL_MS = 60_000;

/** Startup continuations of turns cut mid-way go first. */
export const LOST_WORK_FIRST_SWEEP_DELAY_MS = 30_000;

/** Older losses wait for a person, like turns an update cut off. */
export const LOST_WORK_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Automatic turns in a row, without a person's message, for work the agent awaits. */
export const LOST_WORK_AWAITED_CHAIN_LIMIT = 3;

/** A lost shell or monitor (often a dev server) wakes a person-started turn once. */
export const LOST_WORK_SHELL_CHAIN_LIMIT = 1;

/** Dispatch attempts per source run in one process, so a refused wake cannot spin. */
const MAX_DISPATCH_ATTEMPTS = 3;

/** Turns started per sweep, so a restart that cut many threads does not start them all at once. */
export const LOST_WORK_WAKES_PER_SWEEP = 3;

/**
 * A wake the provider failed before taking its prompt is sent once more after
 * this long. The provider fallback and limit recovery act well inside it, and
 * their run then carries the note.
 */
export const LOST_WORK_RETRY_DELAY_MS = 3 * 60 * 1000;

/** Failures that repeat however often the turn starts, or that another recovery owns. */
const UNRETRYABLE_FAILURE_CLASSES: ReadonlySet<string> = new Set([
  "usage_limit",
  "permission_error",
  "validation_error",
]);

const BLOCKING_RUN_STATUSES: ReadonlySet<string> = new Set([
  "preparing",
  "starting",
  "running",
  "waiting",
]);

export const LOST_WORK_WAKE_PROMPT =
  "Background work this thread was waiting on was cut off before it reported back, so no completion notice is coming. Check what it finished (output files, commits, the working tree) before repeating anything with side effects. Then rerun or continue what is still needed and carry on with the task.";

/** Claude Code keeps what the native routes need on disk. */
export const LOST_WORK_CLAUDE_ROUTES =
  "A stopped subagent continues from its saved transcript when you SendMessage its agent id. A Workflow run continues with resumeFromRunId. A background shell does not restart: read its output file first.";

export function lostWorkWakeText(driver: string | null | undefined): string {
  return driver === "claudeAgent"
    ? `${LOST_WORK_WAKE_PROMPT}\n\n${LOST_WORK_CLAUDE_ROUTES}`
    : LOST_WORK_WAKE_PROMPT;
}

export const lostWorkWakeMessageId = (runId: OrchestrationV2Run["id"]) =>
  MessageId.make(`${RESTART_CONTINUATION_MESSAGE_PREFIX}${runId}`);

type WakeThread = Pick<
  OrchestrationV2AppThread,
  | "id"
  | "archivedAt"
  | "deletedAt"
  | "settledOverride"
  | "settledAt"
  | "providerInstanceId"
  | "lineage"
  | "creationSource"
>;

type WakeRun = Pick<
  OrchestrationV2Run,
  | "id"
  | "ordinal"
  | "status"
  | "completedAt"
  | "userMessageId"
  | "providerThreadId"
  | "providerInstanceId"
  | "activeAttemptId"
  | "restartCancelledBackgroundWork"
  | "cancelledForUpdate"
  | "modelSelection"
>;

/** The run an automatic message continues, when its id names one. */
function automaticSourceRunId(messageId: string): string | undefined {
  for (const prefix of [RESTART_CONTINUATION_MESSAGE_PREFIX, UPDATE_CONTINUATION_MESSAGE_PREFIX]) {
    if (messageId.startsWith(prefix)) return messageId.slice(prefix.length);
  }
  return undefined;
}

/** How many automatic turns in a row end at `run`, with no person's message between them. */
export function automaticChainLength(run: WakeRun, runs: ReadonlyArray<WakeRun>): number {
  let length = 0;
  const seen = new Set<string>();
  for (let current: WakeRun | undefined = run; current !== undefined && !seen.has(current.id);) {
    seen.add(current.id);
    const sourceId = automaticSourceRunId(current.userMessageId);
    if (sourceId === undefined) break;
    length += 1;
    current = runs.find((candidate) => candidate.id === sourceId);
  }
  return length;
}

const awaited = (work: ReadonlyArray<Work>) =>
  work.some((entry) => entry.kind === "subagent" || entry.kind === "task");

/**
 * The run whose lost background work owes the thread a turn, or undefined.
 * Pure: the sweep supplies the records and the gates that need services.
 */
export function lostWorkWake(input: {
  readonly thread: WakeThread;
  readonly runs: ReadonlyArray<WakeRun>;
  readonly providerTurns: ReadonlyArray<
    Pick<OrchestrationV2ProviderTurn, "runAttemptId" | "status">
  >;
  /** `run_interrupt_request` items of the thread's latest started run. */
  readonly interrupts: ReadonlyArray<{
    readonly runId: string | null;
    readonly cause?: string | undefined;
    readonly message: string;
  }>;
  /** Ids of messages already sent, among the ones this could send. */
  readonly sentMessageIds: ReadonlySet<string>;
  /** The failure class of the latest started run, when it failed. */
  readonly latestFailureClass?: string | null | undefined;
  readonly nowMs: number;
}):
  | {
      /** The settled run that lost the work. */
      readonly run: WakeRun;
      /** The run the message is named after: `run`, or its wake that failed to start. */
      readonly messageRun: WakeRun;
      readonly work: ReadonlyArray<Work>;
    }
  | undefined {
  const { thread, runs } = input;
  if (thread.archivedAt !== null || thread.deletedAt !== null) return;
  // A thread a person closed stays closed.
  if (thread.settledOverride === "settled" || (thread.settledAt ?? null) !== null) return;
  // A provider's own subagent takes no messages; its parent is told instead.
  if (isProviderNativeSubagentThread(thread)) return;
  // A turn in progress, or a message waiting its turn, carries the note itself.
  if (runs.some((run) => BLOCKING_RUN_STATUSES.has(run.status) || run.status === "queued")) return;
  const latest = runs.reduce<WakeRun | undefined>(
    (found, run) =>
      run.status !== "rolled_back" &&
      !cancelledForUpdate(run) &&
      (found === undefined || runRanAfter(run, found))
        ? run
        : found,
    undefined,
  );
  if (latest === undefined) return;
  // Messages an update cancelled are queued again, and their turn carries the note.
  if (runs.some((run) => cancelledForUpdate(run) && runRanAfter(run, latest))) return;
  // Someone asked the latest run to stop: final, whoever's turn it was. An
  // update's own stop and the server's watchdogs are no such request.
  if (
    input.interrupts.some(
      (item) => item.runId === latest.id && (isPersonStopRequest(item) || item.cause === "agent"),
    )
  )
    return;
  if (latest.completedAt == null) return;
  const sinceEnd = input.nowMs - DateTime.toEpochMillis(latest.completedAt);
  // A wake the provider failed before taking its prompt delivered nothing: the
  // run it was sent for is still owed its turn, once more.
  const failedWakeSourceId =
    latest.status === "failed" &&
    !UNRETRYABLE_FAILURE_CLASSES.has(input.latestFailureClass ?? "") &&
    !input.providerTurns.some((turn) => turn.runAttemptId === latest.activeAttemptId) &&
    sinceEnd >= LOST_WORK_RETRY_DELAY_MS
      ? automaticSourceRunId(latest.userMessageId)
      : undefined;
  const source =
    failedWakeSourceId === undefined
      ? latest
      : runs.find((candidate) => candidate.id === failedWakeSourceId);
  if (source === undefined) return;
  // One retry: a wake of a wake that failed is left to a person.
  if (source !== latest && automaticSourceRunId(source.userMessageId) !== undefined) return;
  // Only a turn that had settled. One cut mid-way has its own continuation.
  if (source.status !== "completed" && source.status !== "cancelled") return;
  if (!isRestartNoteSource(source, input.providerTurns)) return;
  const work = source.restartCancelledBackgroundWork ?? [];
  if (work.length === 0) return;
  if (source.providerThreadId === null || source.completedAt == null) return;
  // A person moved the thread to another provider since: their next message decides.
  if (thread.providerInstanceId !== source.providerInstanceId) return;
  const age = input.nowMs - DateTime.toEpochMillis(source.completedAt);
  if (!(age >= 0 && age <= LOST_WORK_MAX_AGE_MS)) return;
  if (input.sentMessageIds.has(lostWorkWakeMessageId(latest.id))) return;
  const limit = awaited(work) ? LOST_WORK_AWAITED_CHAIN_LIMIT : LOST_WORK_SHELL_CHAIN_LIMIT;
  if (automaticChainLength(source, runs) >= limit) return;
  return { run: source, messageRun: latest, work };
}

export const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const environment = yield* Effect.serviceOption(ServerEnvironment.ServerEnvironment);
  const environmentId = Option.isNone(environment)
    ? null
    : yield* environment.value.getEnvironmentId;
  const updateHold = yield* ServiceUpdateHold.optional;
  // Rosters the previous sweep found without a live process, by provider
  // thread. Only the same finding twice in a row clears one, so a process
  // that is just starting or reporting is never cut short.
  const suspects = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
  const attempts = yield* Ref.make<ReadonlyMap<string, number>>(new Map());

  /** As in the stranded-subagent sweep: an open session that cannot say is trusted. */
  const providerThreadLive = Effect.fn("LostBackgroundWorkWake.providerThreadLive")(function* (
    providerThread: OrchestrationV2ProviderThread,
  ) {
    if (providerThread.providerSessionId === null) return false;
    const session = yield* sessions
      .get(providerThread.providerSessionId)
      .pipe(Effect.orElseSucceed(() => Option.some(null)));
    if (Option.isNone(session)) return false;
    if (session.value === null || session.value.liveBackgroundWork === undefined) return true;
    return yield* session.value
      .liveBackgroundWork(providerThread)
      .pipe(Effect.orElseSucceed(() => true));
  });

  /** Clears rosters no process runs any more and records what they lost. */
  const clearDeadRosters = Effect.fn("LostBackgroundWorkWake.clearDeadRosters")(function* (
    threadId: ThreadId,
    previous: ReadonlyMap<string, string>,
    suspected: Map<string, string>,
  ) {
    const records = yield* projections.getThreadRecords(threadId, ["runs", "providerThreads"]);
    if (records.thread.deletedAt !== null || !localChildOwnership(records.thread, environmentId))
      return false;
    let cleared = false;
    for (const providerThread of records.providerThreads) {
      const roster = providerThread.pendingBackgroundTasks ?? [];
      // A subagent's own roster belongs to the stranded-subagent sweep.
      if (roster.length === 0 || providerThread.ownerNodeId !== null) continue;
      if (
        records.runs.some(
          (run) =>
            run.providerThreadId === providerThread.id && BLOCKING_RUN_STATUSES.has(run.status),
        )
      )
        continue;
      if (yield* providerThreadLive(providerThread)) continue;
      const verdict = roster
        .map((task) => task.taskId)
        .toSorted()
        .join(",");
      if (previous.get(providerThread.id) !== verdict) {
        suspected.set(providerThread.id, verdict);
        continue;
      }
      const latest = records.runs.reduce<OrchestrationV2Run | undefined>(
        (found, run) =>
          run.providerThreadId === providerThread.id &&
          run.status !== "queued" &&
          run.status !== "rolled_back" &&
          !cancelledForUpdate(run) &&
          (found === undefined || runRanAfter(run, found))
            ? run
            : found,
        undefined,
      );
      // Work a person stopped is not lost: the roster goes, without a note.
      const stopped =
        latest !== undefined &&
        (yield* projections.getThreadRecords(threadId, ["turnItems"], {
          turnItemRunIds: [latest.id],
          turnItemTypes: ["run_interrupt_request"],
        })).turnItems.some(
          (item) =>
            item.type === "run_interrupt_request" &&
            item.runId === latest.id &&
            isPersonStopRequest(item),
        );
      // The reads above took time. A session that opened since, or a roster
      // that changed, owns this provider thread again: leave it to the next sweep.
      const current = (yield* projections.getThreadRecords(threadId, [
        "runs",
        "providerThreads",
      ])).providerThreads.find((candidate) => candidate.id === providerThread.id);
      if (
        current === undefined ||
        current.providerSessionId !== providerThread.providerSessionId ||
        current.status !== providerThread.status ||
        DateTime.toEpochMillis(current.updatedAt) !==
          DateTime.toEpochMillis(providerThread.updatedAt) ||
        (yield* providerThreadLive(current))
      )
        continue;
      const now = yield* DateTime.now;
      // The roster's own time is in the id, so the same task ids lost again clear again.
      const commandId = CommandId.make(
        `command:lost-background-work:${providerThread.id}:${DateTime.formatIso(providerThread.updatedAt)}:${verdict}`.slice(
          0,
          480,
        ),
      );
      const allocateEventId = () => ids.allocate.event({ threadId, commandId });
      const notes = stopped
        ? []
        : yield* lostWorkNoteEvents({
            projection: { thread: records.thread, runs: records.runs },
            lostWork: new Map([[providerThread.id, roster.map(cancelledRosterTaskWork)]]),
            now,
            allocateEventId,
          });
      const result = yield* eventSink.commitCommand({
        commandId,
        threadId,
        commandType: "lost-background-work.clear-roster",
        acceptedAt: now,
        events: [
          {
            id: yield* allocateEventId(),
            type: "provider-thread.updated",
            threadId,
            driver: providerThread.driver,
            providerInstanceId: providerThread.providerInstanceId,
            occurredAt: now,
            payload: { ...providerThread, pendingBackgroundTasks: [], updatedAt: now },
          },
          ...notes,
        ],
        effects: [],
      });
      if (!result.committed) continue;
      cleared = true;
      yield* Effect.logInfo("Cleared background work no provider process runs any more", {
        threadId,
        tasks: roster.length,
        noted: !stopped,
      });
    }
    return cleared;
  });

  const wake = Effect.fn("LostBackgroundWorkWake.wake")(function* (threadId: ThreadId) {
    const preferences = yield* settings.getSettings;
    const records = yield* projections.getThreadRecords(threadId, [
      "runs",
      "providerTurns",
      "providerThreads",
    ]);
    const { thread, runs } = records;
    if (!localChildOwnership(thread, environmentId)) return false;
    const latest = runs.reduce<OrchestrationV2Run | undefined>(
      (found, run) =>
        run.status !== "queued" &&
        run.status !== "rolled_back" &&
        !cancelledForUpdate(run) &&
        (found === undefined || runRanAfter(run, found))
          ? run
          : found,
      undefined,
    );
    if (
      latest === undefined ||
      // Lost work on a settled run, or a wake for it that failed to start.
      ((latest.restartCancelledBackgroundWork?.length ?? 0) === 0 && latest.status !== "failed")
    )
      return false;
    const messageId = lostWorkWakeMessageId(latest.id);
    const updateMessageId = MessageId.make(`${UPDATE_CONTINUATION_MESSAGE_PREFIX}${latest.id}`);
    const detail = yield* projections.getThreadRecords(threadId, ["messages", "turnItems"], {
      messageIds: [messageId, updateMessageId],
      turnItemRunIds: [latest.id],
      turnItemTypes: ["run_interrupt_request", "error"],
    });
    const found = lostWorkWake({
      thread,
      runs,
      providerTurns: records.providerTurns,
      interrupts: detail.turnItems.flatMap((item) =>
        item.type === "run_interrupt_request" ? [item] : [],
      ),
      sentMessageIds: new Set(
        detail.messages.flatMap((message) =>
          message.id === messageId || message.id === updateMessageId ? [messageId] : [],
        ),
      ),
      latestFailureClass: latestRootProviderFailure(latest, detail.turnItems)?.class ?? null,
      nowMs: yield* Clock.currentTimeMillis,
    });
    if (found === undefined) return false;
    // A delegated task that is over, or that its parent was told to stop, owes
    // nothing more: its thread stays as it ended.
    const { lineage } = thread;
    if (lineage.relationshipToParent === "subagent" && lineage.parentThreadId !== null) {
      const parent = yield* projections.getThreadRecords(lineage.parentThreadId, ["subagents"]);
      const taskRunIds = parent.subagents.flatMap((task) =>
        task.childThreadId === threadId &&
        task.result === null &&
        isOrchestrationV2WorkActive(task.status) &&
        task.runId !== null
          ? [task.runId]
          : [],
      );
      if (taskRunIds.length === 0) return false;
      const stops = yield* projections.getThreadRecords(lineage.parentThreadId, ["turnItems"], {
        turnItemTypes: ["run_interrupt_request"],
        turnItemRunIds: taskRunIds,
      });
      if (
        stops.turnItems.some(
          (item) => item.type === "run_interrupt_request" && item.cause !== "service_update",
        )
      )
        return false;
    }
    if (
      !resolveProjectSettings(preferences, thread.projectId).settings
        .continueThreadsAfterServerUpdate
    )
      return false;
    const project = yield* projects.get(thread.projectId);
    if (
      Option.isNone(project) ||
      projectExecutionIsFenced(project.value.workspaceSettings, thread.projectId, thread.id) ||
      project.value.workspaceSettings?.paused ||
      project.value.workspaceSettings?.archived
    )
      return false;
    const tried = (yield* Ref.get(attempts)).get(found.messageRun.id) ?? 0;
    if (tried >= MAX_DISPATCH_ATTEMPTS) return false;
    yield* Ref.update(attempts, (current) => new Map(current).set(found.messageRun.id, tried + 1));
    const driver = records.providerThreads.find(
      (candidate) => candidate.id === found.run.providerThreadId,
    )?.driver;
    yield* threads.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`command:lost-work-wake:${found.messageRun.id}`),
      threadId,
      messageId,
      text: lostWorkWakeText(driver),
      attachments: [],
      modelSelection: found.run.modelSelection,
      dispatchMode: { type: "start_immediately" },
      createdBy: "agent",
      creationSource: "server",
    });
    yield* Effect.logInfo("Started a turn for background work that was cut off", {
      threadId,
      runId: found.run.id,
      lost: found.work.length,
    });
    return true;
  });

  const sweep = Effect.fn("LostBackgroundWorkWake.sweep")(function* () {
    // A held service is about to be updated; its restart recovery takes over.
    if (yield* updateHold.isHeld) return { cleared: 0, woken: 0 };
    const previous = yield* Ref.get(suspects);
    const suspected = new Map<string, string>();
    let cleared = 0;
    let woken = 0;
    // The app's clock, so the bound holds wherever the database's own differs.
    const since = DateTime.subtract(yield* DateTime.now, { milliseconds: LOST_WORK_MAX_AGE_MS });
    for (const threadId of yield* projections.getRecoveryThreadIds("lost-background-work", {
      since,
    })) {
      const result = yield* Effect.gen(function* () {
        const didClear = yield* clearDeadRosters(threadId, previous, suspected);
        // The rest start on later sweeps, oldest change first.
        const didWake = woken < LOST_WORK_WAKES_PER_SWEEP ? yield* wake(threadId) : false;
        return { didClear, didWake };
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Lost background work sweep skipped a thread", {
            threadId,
            cause,
          }).pipe(Effect.as({ didClear: false, didWake: false })),
        ),
      );
      if (result.didClear) cleared += 1;
      if (result.didWake) woken += 1;
    }
    yield* Ref.set(suspects, suspected);
    return { cleared, woken };
  });

  return { sweep };
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const { sweep } = yield* make;
    const scheduler = yield* Scheduler.Scheduler;
    const startedAt = yield* Clock.currentTimeMillis;
    const lastSweepAt = yield* Ref.make(
      startedAt - LOST_WORK_SWEEP_INTERVAL_MS + LOST_WORK_FIRST_SWEEP_DELAY_MS,
    );
    yield* scheduler.register(
      "lost-background-work",
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const last = yield* Ref.get(lastSweepAt);
        if (now - last >= 0 && now - last < LOST_WORK_SWEEP_INTERVAL_MS) return;
        yield* Ref.set(lastSweepAt, now);
        yield* sweep();
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Lost background work sweep failed", { cause }),
        ),
      ),
    );
  }),
);
