import {
  isProjectCoordinatorThreadId,
  type EnvironmentId,
  type HandoffModeSnapshot,
  type ProjectId,
  type ThreadId,
} from "@specweave-studio/contracts";
import {
  threadRuntimeIsActive,
  type EnvironmentThreadShell,
} from "@specweave-studio/client-runtime/state/shell";
import { isPersonalAssistantProject } from "@specweave-studio/shared/personalAssistant";

/**
 * The dialog's groups, in AC-17's order. Queued is not one yet: a hand off by
 * hand leaves held messages behind, so an idle thread with some stays.
 */
export type HandoffMachineGroup = "running" | "waiting" | "stays";

export interface HandoffMachineThreadRow {
  readonly threadId: ThreadId;
  readonly title: string;
  /** Absent reads as Running, as older fixtures write rows. */
  readonly group?: HandoffMachineGroup;
  /** Why a row in Stays cannot go. */
  readonly reason?: string | null;
}

export interface HandoffMachineProject {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly kind?: string | undefined;
  readonly workspaceSettings?:
    | { readonly kind?: string | undefined; readonly coordinatorThreadId?: string | null }
    | null
    | undefined;
}

export interface HandoffMachineRowFacts {
  readonly environmentId: EnvironmentId;
  readonly shells: ReadonlyArray<EnvironmentThreadShell>;
  readonly snapshot: HandoffModeSnapshot | null;
  readonly projects: ReadonlyArray<HandoffMachineProject>;
  /** The project scope; null lists every project on the machine. */
  readonly projectId: ProjectId | null;
}

/** Why a thread with a question, sign-in or approval pending stays (AC-17). */
export const ANSWER_IT_FIRST = "Answer it first";
export const ASSISTANT_STAYS = "The personal assistant stays on this machine.";
/** A hand off by hand moves the thread, not the messages held behind it. */
export const QUEUE_STAYS = "Its queued messages do not travel in a hand off by hand yet.";

const ORDER: Record<HandoffMachineGroup, number> = { running: 0, waiting: 1, stays: 2 };

/**
 * What the thread is doing, as the server's `handoffActivity` reads it: null
 * for a settled one, which a window cannot tell holds unsaved work.
 */
function activityOf(shell: EnvironmentThreadShell): "running" | "queued" | "waiting" | null {
  if (threadRuntimeIsActive(shell.runtime)) return "running";
  if ((shell.heldQueuedCount ?? 0) > 0) return "queued";
  if (shell.settledOverride === "active") return "waiting";
  return shell.settledOverride === "settled" || shell.settledAt !== null ? null : "waiting";
}

function isCoordinator(shell: EnvironmentThreadShell, project: HandoffMachineProject | undefined) {
  const coordinatorThreadId = project?.workspaceSettings?.coordinatorThreadId;
  return isProjectCoordinatorThreadId(shell.id, {
    id: project?.id ?? shell.projectId,
    ...(coordinatorThreadId == null ? {} : { workspaceSettings: { coordinatorThreadId } }),
  });
}

/**
 * The dialog's rows (AC-17): every thread on this machine that a hand off can
 * take, running or waiting for its next message, and under Stays the ones that
 * cannot go, with why. Coordinators, subagents, archived and settled threads
 * and a thread another machine runs or continues are not listed.
 */
export function handoffMachineRows(facts: HandoffMachineRowFacts): HandoffMachineThreadRow[] {
  const states = new Map((facts.snapshot?.threads ?? []).map((state) => [state.threadId, state]));
  const rows: Array<HandoffMachineThreadRow & { readonly updatedAt: string }> = [];
  for (const shell of facts.shells) {
    if (shell.environmentId !== facts.environmentId) continue;
    if (facts.projectId !== null && shell.projectId !== facts.projectId) continue;
    if (shell.archivedAt !== null || shell.lineage.relationshipToParent === "subagent") continue;
    if (shell.executionMachineId != null && shell.executionMachineId !== facts.environmentId)
      continue;
    const state = states.get(shell.id);
    if (state?.continuedOn != null || state?.lease?.state === "fenced") continue;
    const project = facts.projects.find(
      (candidate) =>
        candidate.environmentId === facts.environmentId && candidate.id === shell.projectId,
    );
    if (isCoordinator(shell, project)) continue;
    const activity = activityOf(shell);
    if (activity === null) continue;
    const base = { threadId: shell.id, title: shell.title || "Untitled thread" };
    const reason = isPersonalAssistantProject(project)
      ? ASSISTANT_STAYS
      : shell.hasPendingApprovals || shell.hasPendingUserInput
        ? ANSWER_IT_FIRST
        : activity === "queued"
          ? QUEUE_STAYS
          : null;
    rows.push(
      reason === null
        ? {
            ...base,
            group: activity === "running" ? "running" : "waiting",
            updatedAt: shell.updatedAt,
          }
        : { ...base, group: "stays", reason, updatedAt: shell.updatedAt },
    );
  }
  return rows
    .map((row, index) => ({ row, index }))
    .toSorted(
      (a, b) =>
        ORDER[a.row.group ?? "running"] - ORDER[b.row.group ?? "running"] ||
        (a.row.group === "stays" ? 0 : b.row.updatedAt.localeCompare(a.row.updatedAt)) ||
        a.index - b.index,
    )
    .map(({ row: { updatedAt: _updatedAt, ...row } }) => row);
}

/** The ids ticked when the dialog opens: every row that can go. */
export function tickableHandoffRows(rows: ReadonlyArray<HandoffMachineThreadRow>): Set<ThreadId> {
  return new Set(rows.filter((row) => row.group !== "stays").map((row) => row.threadId));
}

/** The most thread ids one check or one hand off takes (the server's schema). */
export const HANDOFF_BATCH_LIMIT = 100;

/**
 * The ticks the dialog opens with: the first `HANDOFF_BATCH_LIMIT` rows that
 * can go (running first, then the newest waiting). They are decided once;
 * after that only the person's own ticks change the set.
 */
export function initialHandoffTicks(rows: ReadonlyArray<HandoffMachineThreadRow>): {
  readonly ticks: ReadonlySet<ThreadId>;
  readonly overLimit: boolean;
} {
  const can = [...tickableHandoffRows(rows)];
  return {
    ticks: new Set(can.slice(0, HANDOFF_BATCH_LIMIT)),
    overLimit: can.length > HANDOFF_BATCH_LIMIT,
  };
}

/** The person ticks or unticks one row; a tick past the limit is refused. */
export function toggleHandoffTick(
  ticks: ReadonlySet<ThreadId>,
  threadId: ThreadId,
  on: boolean,
): { readonly ticks: ReadonlySet<ThreadId>; readonly refused: boolean } {
  if (on === ticks.has(threadId)) return { ticks, refused: false };
  if (on && ticks.size >= HANDOFF_BATCH_LIMIT) return { ticks, refused: true };
  const next = new Set(ticks);
  if (on) next.add(threadId);
  else next.delete(threadId);
  return { ticks: next, refused: false };
}

/** The ticked ids that still name a row that can go, in row order. */
export function sentHandoffRows(
  rows: ReadonlyArray<HandoffMachineThreadRow>,
  ticks: ReadonlySet<ThreadId>,
): Set<ThreadId> {
  return new Set([...tickableHandoffRows(rows)].filter((id) => ticks.has(id)));
}

/** The check's ids as an array, and a key that changes only when the set does. */
export function handoffCheckRequest(ids: ReadonlySet<ThreadId>): {
  readonly key: string;
  readonly threadIds: ThreadId[];
} {
  const threadIds = [...ids].toSorted();
  return { key: JSON.stringify(threadIds), threadIds };
}
