import {
  isProjectCoordinatorThreadId,
  projectExecutionIsFenced,
  isProviderNativeSubagentThread,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
} from "@specweave-studio/contracts";
import { isPersonalAssistantProject } from "@specweave-studio/shared/personalAssistant";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import { acquireDraftLease, hasProtectedDraft } from "../composerDrafts/draftFiles.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";

export const DAY_MS = 86_400_000;
/** Overflow candidates must have been idle this long, so a just-finished worker stays in view. */
export const OVERFLOW_IDLE_MS = 3_600_000;
type ArchiveCommand = Extract<OrchestrationV2ServerCommand, { type: "thread.archive" }>;

export class InactiveArchiveError extends Schema.TaggedError<InactiveArchiveError>()(
  "InactiveArchiveError",
  { cause: Schema.Defect() },
) {}

/** A cap outside the setting's range is no limit; it never archives more. */
export function isValidActiveThreadCap(cap: number | null): cap is number {
  return cap !== null && Number.isInteger(cap) && cap >= 20 && cap <= 5000;
}

/**
 * A provider-native subagent never gets app runs: its parent's native record says when it
 * finished. Only a completed record counts, like a completed latest run for other threads.
 */
function isFinishedRunlessSubagent(thread: OrchestrationV2ThreadShell): boolean {
  return (
    isProviderNativeSubagentThread(thread) &&
    thread.latestRunId === null &&
    thread.activeRunId === null &&
    thread.activityRunStatus == null &&
    thread.nativeSubagentStatus === "completed" &&
    thread.nativeSubagentCompletedAt != null
  );
}

/**
 * Protections every sweep archive keeps. Unknown/missing protection data is never consent to
 * archive. `allowAgent` admits agent-created and child threads, which only the cap sweeps.
 */
export function isSweepArchiveProtected(
  thread: OrchestrationV2ThreadShell,
  { allowAgent }: { readonly allowAgent: boolean },
): boolean {
  if (
    !allowAgent &&
    (thread.createdBy !== "user" ||
      !["web", "mobile"].includes(thread.creationSource) ||
      thread.lineage.parentThreadId !== null)
  )
    return true;
  // Only the cap reaches provider-native subagents, which finish without a run.
  const runless = allowAgent && isFinishedRunlessSubagent(thread);
  return (
    thread.historyOrigin !== undefined ||
    (!runless &&
      (thread.status !== "completed" ||
        thread.latestRunId === null ||
        thread.latestRunCompletedAt == null)) ||
    thread.activeRunId !== null ||
    thread.pendingRuntimeRequest !== null ||
    thread.archivedAt !== null ||
    thread.deletedAt !== null ||
    thread.pinnedAt !== null ||
    (thread.heldQueuedCount ?? 0) > 0 ||
    thread.pendingBackgroundTasks === undefined ||
    thread.pendingBackgroundTasks.length > 0 ||
    thread.hasActionableProposedPlan !== false ||
    thread.reportedBlocker != null ||
    // A report that ends on a dependency ("Waiting for CI") shows the thread as waiting.
    thread.reportedWait != null ||
    thread.snoozedUntil != null ||
    thread.limitRecovery != null ||
    thread.titleRegeneration != null ||
    thread.movedTo != null ||
    thread.goal != null ||
    thread.activeWork != null ||
    thread.ownerMachineId !== undefined ||
    thread.executionMachineId !== undefined ||
    thread.executionState !== undefined ||
    (thread.planProgress != null && thread.planProgress.completed < thread.planProgress.total) ||
    thread.pullRequests?.some((link) => link.watch != null) === true
  );
}

/** The newest activity on the thread, or null when any timestamp is unusable. */
function latestActivityAt(thread: OrchestrationV2ThreadShell): number | null {
  const activity = [
    thread.createdAt,
    thread.updatedAt,
    thread.latestRunRequestedAt,
    thread.latestRunStartedAt,
    thread.latestRunCompletedAt,
    thread.latestUserMessageAt,
    thread.latestUserAuthoredMessageAt,
    thread.settledAt,
    thread.unsettledAt,
    thread.lastVisitedAt,
    thread.nativeSubagentCompletedAt,
  ]
    .filter((at) => at != null)
    .map((at) => DateTime.toEpochMillis(at));
  return activity.length > 0 && activity.every(Number.isFinite) ? Math.max(...activity) : null;
}

export function isInactiveArchiveCandidate(
  thread: OrchestrationV2ThreadShell,
  now: number,
  days: number | null,
): boolean {
  if (days === null || !Number.isInteger(days) || days < 1 || days > 3650) return false;
  if (isSweepArchiveProtected(thread, { allowAgent: false })) return false;
  const latest = latestActivityAt(thread);
  return latest !== null && latest <= now - days * DAY_MS;
}

/** Agent-created and child threads qualify; the coordinator and routines are checked by the guard. */
export function isOverflowArchiveCandidate(
  thread: OrchestrationV2ThreadShell,
  now: number,
): boolean {
  if (isSweepArchiveProtected(thread, { allowAgent: true })) return false;
  const latest = latestActivityAt(thread);
  return latest !== null && latest <= now - OVERFLOW_IDLE_MS;
}

/** The guard runs under the orchestrator's thread lock; default construction refuses automation. */
export class InactiveThreadArchiveGuard extends Context.Reference<{
  readonly protect: <A, E, R>(
    command: ArchiveCommand,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, InactiveArchiveError, R>;
}>("specweave-studio/orchestration-v2/InactiveThreadArchiveGuard", {
  defaultValue: () => ({
    protect: () =>
      Effect.fail(new InactiveArchiveError({ cause: "Archive protection unavailable" })),
  }),
}) {}

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const config = yield* ServerConfig.ServerConfig;
  const sql = yield* SqlClient.SqlClient;
  const terminals = yield* TerminalManager.TerminalManager;
  const openTerminals = new Map<string, Set<string>>();
  let terminalSnapshotKnown = false;
  const unsubscribe = yield* terminals.subscribeMetadata((event) =>
    Effect.sync(() => {
      if (event.type === "snapshot") {
        openTerminals.clear();
        terminalSnapshotKnown = true;
        for (const terminal of event.terminals) {
          const ids = openTerminals.get(terminal.threadId) ?? new Set<string>();
          ids.add(terminal.terminalId);
          openTerminals.set(terminal.threadId, ids);
        }
      } else if (event.type === "upsert") {
        const ids = openTerminals.get(event.terminal.threadId) ?? new Set<string>();
        ids.add(event.terminal.terminalId);
        openTerminals.set(event.terminal.threadId, ids);
      } else {
        const ids = openTerminals.get(event.threadId);
        ids?.delete(event.terminalId);
        if (ids?.size === 0) openTerminals.delete(event.threadId);
      }
    }),
  );
  yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
  const refuse = (cause: string) => Effect.fail(new InactiveArchiveError({ cause }));
  // A completed native subagent resumes in the same child thread when its parent sends to it
  // again, and its turn and session live on the parent. Keep it while any thread up its native
  // chain is the coordinator (delete-all keeps those too), unknown, or still working.
  const parentMayResume = (
    thread: OrchestrationV2ThreadShell,
    coordinatorOf: Parameters<typeof isProjectCoordinatorThreadId>[1],
  ) =>
    Effect.gen(function* () {
      const seen = new Set<string>([thread.id]);
      let child = thread;
      while (isProviderNativeSubagentThread(child)) {
        const parentId = child.lineage.parentThreadId;
        if (
          parentId === null ||
          seen.has(parentId) ||
          isProjectCoordinatorThreadId(parentId, coordinatorOf)
        )
          return true;
        seen.add(parentId);
        const parent = yield* projections.getThreadShell(parentId);
        if (parent === null) return true;
        if (parent.archivedAt === null) {
          if (parent.activeRunId !== null || parent.activityRunStatus != null) return true;
          const { providerSessions } = yield* projections.getThreadRecords(parent.id, [
            "providerSessions",
          ]);
          if (
            providerSessions.some(
              (session) => session.status !== "stopped" && session.status !== "error",
            )
          )
            return true;
        }
        child = parent;
      }
      return false;
    });
  const check = (command: ArchiveCommand) =>
    Effect.gen(function* () {
      const thread = yield* projections.getThreadShell(command.threadId);
      if (
        thread === null ||
        command.inactive === undefined ||
        DateTime.toEpochMillis(thread.updatedAt) !==
          DateTime.toEpochMillis(command.inactive.expectedUpdatedAt)
      )
        return yield* refuse("Thread changed before inactive archive");
      const project = yield* projects.get(thread.projectId);
      if (Option.isNone(project)) return yield* refuse("Project is protected");
      const coordinatorOf = {
        id: project.value.projectId,
        workspaceSettings: project.value.workspaceSettings ?? undefined,
      };
      if (
        isPersonalAssistantProject(project.value) ||
        isProjectCoordinatorThreadId(thread.id, coordinatorOf) ||
        project.value.workspaceSettings?.paused ||
        project.value.workspaceSettings?.archived ||
        projectExecutionIsFenced(
          project.value.workspaceSettings,
          project.value.projectId,
          thread.id,
        )
      )
        return yield* refuse("Project is protected");
      const preferences = resolveProjectSettings(
        yield* settings.getSettings,
        thread.projectId,
        project.value,
      ).settings;
      const now = yield* Clock.currentTimeMillis;
      const overflow = command.inactive.reason === "overflow";
      if (
        overflow
          ? !isOverflowArchiveCandidate(thread, now)
          : !isInactiveArchiveCandidate(thread, now, preferences.archiveInactiveThreadsAfterDays)
      )
        return yield* refuse("Thread is active or protected");
      if (overflow) {
        if (yield* parentMayResume(thread, coordinatorOf))
          return yield* refuse("Thread is active or protected");
        const cap = preferences.keepActiveThreadsPerProject;
        if (!isValidActiveThreadCap(cap)) return yield* refuse("Project has no thread limit");
        // Re-count inside the transaction: the sweep's count may be stale by now.
        const [count] = yield* sql<{ readonly live: number }>`
          SELECT COUNT(*) AS live FROM orchestration_v2_projection_threads
          WHERE project_id = ${thread.projectId} AND archived_at IS NULL AND deleted_at IS NULL
        `;
        if (!(Number(count?.live) > cap)) return yield* refuse("Project is within its limit");
      }
      // Any routine in this project may target its chat or own a continuation. Retain disabled routines too.
      // The cap only refuses the chat a routine targets, or one routine would pin every worker.
      const schedules = overflow
        ? yield* sql`SELECT task_id FROM scheduled_tasks WHERE thread_id = ${thread.id} LIMIT 1`
        : yield* sql`SELECT task_id FROM scheduled_tasks WHERE project_id = ${thread.projectId} LIMIT 1`;
      if (schedules.length > 0 || !terminalSnapshotKnown || openTerminals.has(thread.id))
        return yield* refuse("Routine or terminal is protected");
      const records = yield* projections.getThreadRecords(
        thread.id,
        [
          "runs",
          "attempts",
          "nodes",
          "subagents",
          "providerSessions",
          "runtimeRequests",
          "turnItems",
        ],
        { turnItemStatuses: ["idle", "pending", "running", "waiting"] },
      );
      const latest = records.runs.find((run) => run.id === thread.latestRunId);
      if (
        records.turnItems.length > 0 ||
        (overflow && isFinishedRunlessSubagent(thread)
          ? records.runs.length > 0
          : latest?.status !== "completed") ||
        records.runs.some(
          (run) =>
            ["preparing", "queued", "starting", "running", "waiting"].includes(run.status) ||
            run.queueHeld === true,
        ) ||
        records.attempts.some((attempt) => ["pending", "running"].includes(attempt.status)) ||
        records.nodes.some((node) =>
          ["idle", "pending", "running", "waiting"].includes(node.status),
        ) ||
        records.subagents.some(
          (subagent) =>
            !["completed", "failed", "interrupted", "cancelled"].includes(subagent.status),
        ) ||
        records.runtimeRequests.some((request) => request.status === "pending") ||
        records.providerSessions.some(
          (session) => session.status !== "stopped" && session.status !== "error",
        )
      )
        return yield* refuse("Unfinished work or provider session is protected");
      const controls = yield* projections.getThreadRecords(thread.id, ["turnItems"], {
        turnItemTypes: ["run_interrupt_request", "secret_request", "user_input_request"],
      });
      if (
        controls.turnItems.some(
          (item) =>
            (item.type === "run_interrupt_request" && item.runId === thread.latestRunId) ||
            (item.type === "secret_request" && item.secretStatus === "pending") ||
            (item.type === "user_input_request" &&
              !["completed", "cancelled"].includes(item.status)),
        )
      )
        return yield* refuse("A Stop or unanswered request is protected");
      if (
        yield* Effect.tryPromise(() =>
          hasProtectedDraft(config.composerDraftsDir, `thread:${thread.id}`),
        )
      )
        return yield* refuse("Saved draft is protected");
    });
  return InactiveThreadArchiveGuard.of({
    protect: (command, effect) =>
      terminals
        .withThreadLifecycleLock(
          command.threadId,
          Effect.acquireUseRelease(
            Effect.tryPromise(() =>
              acquireDraftLease(config.composerDraftsDir, `thread:${command.threadId}`),
            ),
            () => sql.withTransaction(check(command).pipe(Effect.andThen(effect))),
            (release) => Effect.sync(release),
          ),
        )
        .pipe(Effect.mapError((cause) => new InactiveArchiveError({ cause }))),
  });
});
export const layer = Layer.effect(InactiveThreadArchiveGuard, make);
