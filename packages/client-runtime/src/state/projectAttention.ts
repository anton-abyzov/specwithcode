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
  threadRuntimeIsActive,
  type EnvironmentThreadShell,
} from "./models.js";

const millis = (value: string | null | undefined): number | null => {
  const n = value ? Date.parse(value) : NaN;
  return Number.isFinite(n) ? n : null;
};
/**
 * A provider-native subagent (Claude's Agent tool, Codex or Cursor subagents):
 * its final report is its parent agent's tool result, not a message to the person.
 */
export const reportsToParentAgent = (
  thread: Pick<EnvironmentThreadShell, "lineage"> & {
    readonly source?: Pick<EnvironmentThreadShell["source"], "creationSource"> | undefined;
  },
): boolean =>
  thread.lineage?.relationshipToParent === "subagent" &&
  thread.source?.creationSource === "provider";
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
      createdAt:
        pending && DateTime.isDateTime(pending.createdAt)
          ? DateTime.toEpochMillis(pending.createdAt)
          : null,
    });
  if (thread.hasActionableProposedPlan)
    requests.push({ reason: "plan", id: `plan:${thread.updatedAt}`, createdAt: null });
  // Final reports can ask for a decision after the native request has closed.
  // Use the same quiet-thread blocker that rows display, so those rows, project
  // counts and descendant attention all agree. A resumed turn supersedes it.
  // A provider-native subagent's report is its parent agent's tool result, not
  // a message to the person: the parent decides, and relays a real decision in
  // its own report. It never gets a user message, so it would never clear.
  if (
    thread.reportedBlocker?.trim() &&
    !reportsToParentAgent(thread) &&
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
      root.working ||= observation.active;
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
