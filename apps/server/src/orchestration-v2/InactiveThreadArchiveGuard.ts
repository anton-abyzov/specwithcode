import {
  isProjectCoordinatorThreadId,
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
type ArchiveCommand = Extract<OrchestrationV2ServerCommand, { type: "thread.archive" }>;

export class InactiveArchiveError extends Schema.TaggedError<InactiveArchiveError>()(
  "InactiveArchiveError",
  { cause: Schema.Defect() },
) {}

/** Unknown/missing protection data is never consent to archive. */
export function isInactiveArchiveCandidate(
  thread: OrchestrationV2ThreadShell,
  now: number,
  days: number | null,
): boolean {
  if (days === null || !Number.isInteger(days) || days < 1 || days > 3650) return false;
  if (
    thread.historyOrigin !== undefined ||
    thread.createdBy !== "user" ||
    !["web", "mobile"].includes(thread.creationSource) ||
    thread.status !== "completed" ||
    thread.latestRunId === null ||
    thread.latestRunCompletedAt == null ||
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
    thread.snoozedUntil != null ||
    thread.limitRecovery != null ||
    thread.titleRegeneration != null ||
    thread.movedTo != null ||
    thread.lineage.parentThreadId !== null ||
    thread.goal != null ||
    thread.activeWork != null ||
    thread.ownerMachineId !== undefined ||
    thread.executionMachineId !== undefined ||
    thread.executionState !== undefined ||
    (thread.planProgress != null && thread.planProgress.completed < thread.planProgress.total) ||
    thread.pullRequests?.some((link) => link.watch != null)
  )
    return false;
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
  ]
    .filter((at) => at != null)
    .map((at) => DateTime.toEpochMillis(at));
  return (
    activity.length > 0 &&
    activity.every(Number.isFinite) &&
    Math.max(...activity) <= now - days * DAY_MS
  );
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
      if (
        Option.isNone(project) ||
        isPersonalAssistantProject(project.value) ||
        isProjectCoordinatorThreadId(thread.id, {
          id: project.value.projectId,
          workspaceSettings: project.value.workspaceSettings ?? undefined,
        }) ||
        project.value.workspaceSettings?.paused ||
        project.value.workspaceSettings?.archived
      )
        return yield* refuse("Project is protected");
      const preferences = resolveProjectSettings(
        yield* settings.getSettings,
        thread.projectId,
        project.value,
      ).settings;
      if (
        !isInactiveArchiveCandidate(
          thread,
          yield* Clock.currentTimeMillis,
          preferences.archiveInactiveThreadsAfterDays,
        )
      )
        return yield* refuse("Thread is active or protected");
      // Any routine in this project may target its chat or own a continuation. Retain disabled routines too.
      const schedules =
        yield* sql`SELECT task_id FROM scheduled_tasks WHERE project_id = ${thread.projectId} LIMIT 1`;
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
        latest?.status !== "completed" ||
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
