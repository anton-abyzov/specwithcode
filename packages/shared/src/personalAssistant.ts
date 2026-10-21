/**
 * A machine has one personal assistant, private to it: its context, history,
 * memory and routines never leave the machine, and no other machine's work
 * reaches them. Projects of every other kind may be linked, handed off and
 * copied as before.
 */
export interface PersonalAssistantCandidate {
  readonly id?: string | undefined;
  readonly projectId?: string | undefined;
  readonly createdAt: string;
  readonly deletedAt?: string | null | undefined;
  readonly workspaceSettings?: { readonly kind?: string | undefined } | null | undefined;
  readonly kind?: string | undefined;
}

/** Whether `project` is a personal assistant (settings kind "personal"). */
export function isPersonalAssistantProject(
  project:
    | {
        readonly kind?: string | undefined;
        readonly workspaceSettings?: { readonly kind?: string | undefined } | null | undefined;
      }
    | null
    | undefined,
): boolean {
  return (project?.workspaceSettings?.kind ?? project?.kind) === "personal";
}

const idOf = (project: PersonalAssistantCandidate) => project.projectId ?? project.id ?? "";

/**
 * The machine's assistant among one machine's projects: the earliest-created
 * personal project that is not deleted, archived or not. A later duplicate
 * from before the one-per-machine rule keeps its data and is an earlier
 * assistant's sibling, never merged into it.
 */
export function machineAssistantOf<P extends PersonalAssistantCandidate>(
  projects: ReadonlyArray<P>,
): P | undefined {
  let chosen: P | undefined;
  for (const project of projects) {
    if (project.deletedAt || !isPersonalAssistantProject(project)) continue;
    if (
      chosen === undefined ||
      project.createdAt < chosen.createdAt ||
      (project.createdAt === chosen.createdAt && idOf(project) < idOf(chosen))
    )
      chosen = project;
  }
  return chosen;
}

/** The words every refusal uses, so the user hears one rule. */
export const PERSONAL_ASSISTANT_PRIVATE_MESSAGE =
  "A personal assistant is private to its machine: its threads, memory and routines never move, copy or sync to another machine, and other machines' work cannot reach them.";
