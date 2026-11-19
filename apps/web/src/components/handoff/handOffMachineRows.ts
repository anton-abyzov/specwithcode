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

/** The dialog's groups, in the order AC-17 lists them. */
export type HandoffMachineGroup = "running" | "queued" | "waiting" | "stays";

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

const ORDER: Record<HandoffMachineGroup, number> = { running: 0, queued: 1, waiting: 2, stays: 3 };

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
        ? { ...base, group: activity, updatedAt: shell.updatedAt }
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
