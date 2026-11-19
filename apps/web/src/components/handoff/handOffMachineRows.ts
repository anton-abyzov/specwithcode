import type { EnvironmentId, HandoffModeSnapshot, ProjectId, ThreadId } from "@specweave-studio/contracts";
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

/** The dialog's rows: today, running handoff-mode threads only. */
export function handoffMachineRows(facts: HandoffMachineRowFacts): HandoffMachineThreadRow[] {
  const shells = new Map(
    facts.shells
      .filter((shell) => shell.environmentId === facts.environmentId)
      .map((shell) => [shell.id, shell] as const),
  );
  return (facts.snapshot?.threads ?? [])
    .filter((thread) => {
      if (thread.effectiveMode !== "on" || thread.continuedOn !== null) return false;
      if (thread.lease?.state === "fenced") return false;
      const shell = shells.get(thread.threadId);
      if (shell === undefined || !threadRuntimeIsActive(shell.runtime)) return false;
      const owner = facts.projects.find(
        (project) =>
          project.environmentId === facts.environmentId && project.id === shell.projectId,
      );
      return !isPersonalAssistantProject(owner);
    })
    .filter((thread) => facts.projectId === null || thread.projectId === facts.projectId)
    .map((thread) => ({
      threadId: thread.threadId,
      title: shells.get(thread.threadId)?.title || "Untitled thread",
    }));
}

/** The ids ticked when the dialog opens: today, every row. */
export function tickableHandoffRows(rows: ReadonlyArray<HandoffMachineThreadRow>): Set<ThreadId> {
  return new Set(rows.map((row) => row.threadId));
}
