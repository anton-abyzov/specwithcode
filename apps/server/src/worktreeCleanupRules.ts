/**
 * Which chats count as finished and which rules a chat folder falls under,
 * for the chat worktree sweep (worktreeCleanupSweep.ts) and its triggers.
 *
 * @module worktreeCleanupRules
 */
import type {
  OrchestrationV2ThreadShell,
  ProjectId,
  ServerSettings,
  WorktreeCleanupRules,
} from "@specweave-studio/contracts";
import {
  resolveProjectSettings,
  resolveWorktreeCleanup,
} from "@specweave-studio/shared/projectSettings";

import * as DateTime from "effect/DateTime";

import { newestFinite } from "./failClosedAge.ts";
import type { FinishedWorktreeRules } from "./finishedWorktrees.ts";
import { threadHasQueuedTurnStart } from "./orchestration-v2/ThreadSettlementService.ts";

/**
 * Finished and waiting for nothing: no run in progress, no background task,
 * no question or approval pending, no turn queued to start or held. A run that
 * completed, was cancelled, interrupted or rolled back counts; `waiting` does
 * not, and neither does a runless native sub-chat still at work.
 */
export function storageCleanupThreadIdle(thread: OrchestrationV2ThreadShell, now: number): boolean {
  return (
    thread.worktreePath !== null &&
    thread.activeRunId === null &&
    thread.activityRunStatus == null &&
    (thread.status === "idle" ||
      thread.status === "failed" ||
      thread.status === "completed" ||
      thread.status === "cancelled" ||
      thread.status === "interrupted" ||
      thread.status === "rolled_back") &&
    (thread.pendingBackgroundTasks?.length ?? 0) === 0 &&
    thread.pendingRuntimeRequest === null &&
    // A held queue is messages waiting to run.
    (thread.heldQueuedCount ?? 0) === 0 &&
    !threadHasQueuedTurnStart(thread, now)
  );
}

/**
 * Its work is done though nobody resolved it: idle as above, and its last run
 * completed. A run that failed, was cancelled, interrupted or rolled back is
 * one a person may still retry, and a chat that never ran has not started.
 */
export function storageCleanupThreadFinished(
  thread: OrchestrationV2ThreadShell,
  now: number,
): boolean {
  return (
    storageCleanupThreadIdle(thread, now) &&
    thread.status === "completed" &&
    thread.latestRunId !== null
  );
}

/**
 * PR metadata refreshes must not reset the inactivity clock. Null when no
 * reading is known, which never counts as inactive.
 */
export function storageCleanupActivityAt(thread: OrchestrationV2ThreadShell): number | null {
  return newestFinite(
    [
      thread.createdAt,
      thread.latestUserMessageAt,
      thread.latestRunRequestedAt,
      thread.latestRunStartedAt,
      thread.latestRunCompletedAt,
    ].map((value) => (value == null ? null : DateTime.toEpochMillis(value))),
  );
}

/** Whether the global rules or any project's own rules satisfy `predicate`. */
export function anyWorktreePolicy(
  settings: ServerSettings,
  predicate: (rules: WorktreeCleanupRules) => boolean,
): boolean {
  return (
    predicate(resolveWorktreeCleanup(settings, null)) ||
    Object.keys(settings.projectSettingsOverrides).some((projectId) =>
      predicate(resolveWorktreeCleanup(settings, projectId as ProjectId)),
    )
  );
}

/** The rules of one project, the resolved-chats switch included. */
function projectRules(settings: ServerSettings, projectId: ProjectId): FinishedWorktreeRules {
  const rules = resolveWorktreeCleanup(settings, projectId);
  // A project whose worktree cleanup is Off keeps its folders under every rule.
  const off = resolveProjectSettings(settings, projectId).settings.worktreeCleanup?.mode === "off";
  return {
    ...rules,
    removeResolvedWorktrees: settings.storageCleanup.removeResolvedWorktrees && !off,
  };
}

/** Every project's rules must allow it: the strictest of them. */
export function folderRules(settings: ServerSettings, projectIds: ReadonlySet<ProjectId>) {
  const all = [...projectIds].map((projectId) => projectRules(settings, projectId));
  const days = all.map((rules) => rules.worktreeAfterDays);
  return {
    worktreeAfterDays: days.includes(null) ? null : Math.max(...(days as Array<number>)),
    worktreeOnMerge: all.every((rules) => rules.worktreeOnMerge),
    worktreeOnDelete: all.every((rules) => rules.worktreeOnDelete),
    worktreeUnchanged: all.every((rules) => rules.worktreeUnchanged),
    removeResolvedWorktrees: all.every((rules) => rules.removeResolvedWorktrees),
  } satisfies FinishedWorktreeRules;
}
