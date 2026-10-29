import { reportWaitReason } from "@specweave-studio/shared/reportDocument";
import * as DateTime from "effect/DateTime";
import {
  attentionIdentity,
  classifyProjectActions,
  type AttentionFreshness,
  type AttentionObservation,
  type ProjectAction,
} from "@specweave-studio/shared/projectAttention";
import {
  threadAwaitingPerson,
  subagentExecutionStatus,
  threadRuntimeIsActive,
  type EnvironmentThreadShell,
} from "./models.js";

/** Request ids of the cards an update records to ask a closed question again. */
const REOPENED_REQUEST_PREFIX = "update-reopen";
const millis = (value: string | null | undefined): number | null => {
  const n = value ? Date.parse(value) : NaN;
  return Number.isFinite(n) ? n : null;
};
/** How the host names a project's coordinator thread (see projectCoordinatorThreads). */
const COORDINATOR_THREAD_PREFIX = "project-coordinator:";
/**
 * Whether a thread's final report is read by an agent rather than the person:
 * a provider-native subagent (Claude's Agent tool, Codex or Cursor subagents),
 * whose report is its parent's tool result, or a delegate_task child of a
 * worker, whose report is delivered to that worker. A coordinator's workers
 * report to the person (the coordinator never repeats their results), so their
 * blockers still count.
 */
export const reportsToParentAgent = (
  thread: Pick<EnvironmentThreadShell, "lineage"> & {
    readonly source?: Pick<EnvironmentThreadShell["source"], "creationSource"> | undefined;
  },
): boolean => {
  if (thread.lineage?.relationshipToParent !== "subagent") return false;
  if (thread.source?.creationSource === "provider") return true;
  const parent = thread.lineage.parentThreadId;
  return typeof parent === "string" && !parent.startsWith(COORDINATOR_THREAD_PREFIX);
};
/** A dependency is separate from an actual pending request or held queue. */
export function threadDependencyWait(thread: EnvironmentThreadShell): string | null {
  if (thread.archivedAt != null || thread.deletedAt != null || thread.settledOverride === "settled")
    return null;
  if (
    thread.lineage?.relationshipToParent === "subagent" &&
    ["completed", "cancelled", "failed", "interrupted"].includes(
      subagentExecutionStatus({ thread }),
    )
  )
    return null;
  if (thread.runtime?.status === "waiting") {
    return thread.source?.activeWork?.waitThreadId
      ? "Waiting for subagents"
      : (reportWaitReason(thread.source?.activeWork?.label ?? "") ?? "Waiting for background work");
  }
  if (threadRuntimeIsActive(thread.runtime) || reportsToParentAgent(thread)) return null;
  if (thread.reportedBlocker && !reportWaitReason(thread.reportedBlocker)) return null;
  return thread.reportedWait ?? reportWaitReason(thread.reportedBlocker ?? "");
}

export function observeProjectThread(
  thread: EnvironmentThreadShell,
  freshness: AttentionFreshness = "live",
): AttentionObservation {
  const pending = thread.source?.pendingRuntimeRequest;
  const person = pending === null ? null : threadAwaitingPerson(thread);
  const generation = thread.runtime?.activeRunId ?? thread.latestRun?.runId ?? "legacy";
  const requests: AttentionObservation["requests"][number][] = [];
  if (person)
    requests.push({
      reason:
        person.kind === "answer" ? "input" : person.kind === "sign-in" ? "signin" : "approval",
      id: pending?.id ?? `legacy:${person.kind}`,
      // Reopening is not a fresh ask. New cards retain original chronology;
      // legacy reopened cards with no provenance remain conservatively unknown.
      createdAt: pending?.id.startsWith(REOPENED_REQUEST_PREFIX)
        ? millis(pending.reopenedFromAskedAt)
        : pending && DateTime.isDateTime(pending.createdAt)
          ? DateTime.toEpochMillis(pending.createdAt)
          : null,
    });
  if (thread.hasActionableProposedPlan)
    requests.push({ reason: "plan", id: `plan:${thread.updatedAt}`, createdAt: null });
  // Final reports can ask for a decision after the native request has closed.
  // Use the same quiet-thread blocker that rows display, so those rows, project
  // counts and descendant attention all agree. A resumed turn supersedes it.
  // A child's report that an agent reads is not a message to the person: the
  // parent decides, and relays a real decision in its own report. The child
  // never gets a user message, so its blocker would never clear.
  if (
    thread.reportedBlocker?.trim() &&
    !reportsToParentAgent(thread) &&
    reportWaitReason(thread.reportedBlocker) === null &&
    !threadRuntimeIsActive(thread.runtime) &&
    !person
  )
    requests.push({
      reason: "input",
      id: `blocker:${thread.reportedBlocker}`,
      createdAt: null,
    });
  if ((thread.heldQueuedCount ?? 0) > 0)
    requests.push({ reason: "held", id: `held:${thread.updatedAt}`, createdAt: null });
  return {
    environmentId: thread.environmentId,
    projectId: thread.projectId,
    threadId: thread.id,
    generation,
    revision: thread.updatedAt,
    title: thread.title,
    freshness,
    excluded: thread.archivedAt != null || thread.deletedAt != null,
    settled: thread.settledOverride === "settled",
    settledAt: millis(thread.settledAt),
    active: threadRuntimeIsActive(thread.runtime),
    requests,
  };
}
/**
 * Resolving a conversation settles the asks of the subagents folded into it:
 * only a request made after the root was resolved can reopen it.
 */
function inheritRootSettlement(
  observation: AttentionObservation,
  root: EnvironmentThreadShell,
): AttentionObservation {
  if (root.id === observation.threadId || root.settledOverride !== "settled") return observation;
  const rootSettledAt = millis(root.settledAt);
  return {
    ...observation,
    settled: true,
    settledAt:
      observation.settled && observation.settledAt !== null && rootSettledAt !== null
        ? Math.max(observation.settledAt, rootSettledAt)
        : rootSettledAt,
  };
}
export interface AttentionMember {
  readonly environmentId: string;
  readonly projectId: string;
  readonly coordinatorThreadId: string | null;
  readonly freshness: AttentionFreshness;
  readonly includeUserRoots?: boolean | undefined;
  readonly remoteWorkers?:
    | readonly { environmentId: string; remoteThreadId: string | null; state: string }[]
    | undefined;
  readonly remoteWorkersComplete?: boolean | undefined;
}
export interface AttentionRoot {
  readonly key: string;
  readonly thread: EnvironmentThreadShell;
  readonly coordinator: boolean;
  readonly freshness: AttentionFreshness;
  readonly actions: readonly ProjectAction[];
  readonly working: boolean;
  readonly waits?: readonly string[];
}
export interface ProjectAttention {
  readonly roots: readonly AttentionRoot[];
  readonly count: number;
  readonly working: number;
  readonly complete: boolean;
  readonly staleCount: number;
  readonly label: string;
}
/** Roots are the explicit visible conversations, never inferred from a title or Git remote. */
export function aggregateProjectAttention(input: {
  readonly members: readonly AttentionMember[];
  readonly roots: readonly EnvironmentThreadShell[];
  readonly threads: readonly EnvironmentThreadShell[];
}): ProjectAttention {
  const memberKey = (environmentId: string, projectId: string) =>
    JSON.stringify([environmentId, projectId]);
  const members = new Map(input.members.map((m) => [memberKey(m.environmentId, m.projectId), m]));
  const keyOf = (t: EnvironmentThreadShell) =>
    attentionIdentity({ environmentId: t.environmentId, projectId: t.projectId, threadId: t.id });
  const byKey = new Map(input.threads.map((t) => [keyOf(t), t]));
  const byEnvironmentThread = new Map<string, EnvironmentThreadShell[]>();
  for (const thread of byKey.values()) {
    const key = JSON.stringify([thread.environmentId, thread.id]);
    byEnvironmentThread.set(key, [...(byEnvironmentThread.get(key) ?? []), thread]);
  }
  const roots = new Map<
    string,
    {
      key: string;
      thread: EnvironmentThreadShell;
      coordinator: boolean;
      freshness: AttentionFreshness;
      actions: ProjectAction[];
      working: boolean;
      waits: string[];
    }
  >();
  for (const thread of input.roots) {
    const member = members.get(memberKey(thread.environmentId, thread.projectId));
    if (!member || thread.archivedAt != null || thread.deletedAt != null) continue;
    const key = keyOf(thread);
    roots.set(key, {
      key,
      thread,
      coordinator: member.coordinatorThreadId === thread.id,
      freshness: member.freshness,
      actions: [],
      working: false,
      waits: [],
    });
  }
  let complete = input.members.length > 0 && input.members.every((m) => m.freshness === "live");
  const staleRoots = new Set<string>();
  const representedThreads = new Set<string>();
  for (const thread of byKey.values()) {
    const initialMember = members.get(memberKey(thread.environmentId, thread.projectId));
    if (thread.archivedAt != null || thread.deletedAt != null) continue;
    let current = thread;
    const visited = new Set<string>();
    let root = roots.get(keyOf(current));
    while (
      !root &&
      (current.lineage?.relationshipToParent === "subagent" ||
        current.lineage?.parentThreadId ||
        current.forkedFrom?.type === "run")
    ) {
      const key = keyOf(current);
      if (visited.has(key)) {
        if (initialMember) complete = false;
        break;
      }
      visited.add(key);
      const parentId =
        current.lineage?.parentThreadId ??
        (current.forkedFrom?.type === "run" ? current.forkedFrom.threadId : null);
      const candidates = parentId
        ? (byEnvironmentThread.get(JSON.stringify([current.environmentId, parentId])) ?? [])
        : [];
      const parent = candidates.length === 1 ? candidates[0] : undefined;
      if (!parent) {
        if (initialMember) complete = false;
        break;
      }
      if (parent.archivedAt != null || parent.deletedAt != null) break;
      current = parent;
      root = roots.get(keyOf(current));
    }
    if (!root || (!roots.has(keyOf(thread)) && thread.lineage?.relationshipToParent !== "subagent"))
      continue;
    representedThreads.add(JSON.stringify([thread.environmentId, thread.id]));
    const member = members.get(memberKey(root.thread.environmentId, root.thread.projectId))!;
    const observation = inheritRootSettlement(
      observeProjectThread(thread, member.freshness),
      root.thread,
    );
    const actions = classifyProjectActions(observation);
    if (member.freshness === "live") {
      root.actions.push(...actions);
      const wait = observation.settled ? null : threadDependencyWait(thread);
      if (wait && !root.waits.includes(wait)) root.waits.push(wait);
      const executionActive =
        thread.lineage?.relationshipToParent !== "subagent" ||
        subagentExecutionStatus({ thread }) === "running";
      root.working ||=
        root.thread.settledOverride !== "settled" &&
        observation.active &&
        thread.runtime?.status !== "waiting" &&
        executionActive;
    } else if (actions.length) staleRoots.add(root.key);
  }
  for (const member of input.members) {
    if (member.remoteWorkersComplete === false) complete = false;
    for (const follower of member.remoteWorkers ?? []) {
      if (["disposed", "idle"].includes(follower.state)) continue;
      if (follower.state === "paused_auth") {
        complete = false;
        continue;
      }
      if (
        !follower.remoteThreadId ||
        !representedThreads.has(JSON.stringify([follower.environmentId, follower.remoteThreadId]))
      )
        complete = false;
    }
  }
  const result = [...roots.values()];
  const count = result.filter((root) => root.actions.length > 0).length;
  return {
    roots: result,
    count,
    complete,
    staleCount: staleRoots.size,
    working: result.filter((root) => !root.coordinator && root.working && root.actions.length === 0)
      .length,
    label: complete
      ? `${count} waiting on you`
      : count > 0
        ? `${count} waiting on you · partial`
        : "Attention unavailable",
  };
}
