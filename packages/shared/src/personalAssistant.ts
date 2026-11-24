/**
 * The personal assistant (Percy) belongs to its owner's SpecWithCode Connect
 * account (1448): it is the same assistant on each machine where the owner
 * turned "Use my Percy on this machine" on, and those machines keep its memory
 * and settings in step. A chat stays on the machine it was started on, and no
 * other project, person or work grant reaches the assistant. Projects of every
 * other kind may be linked, handed off and copied as before.
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

/**
 * The words every refusal uses, so the user hears one rule: whose Percy it is,
 * and that a Percy chat stays where it started (Away, hand off, thread move,
 * limit handoff and remote launch all refuse with it).
 */
export const PERSONAL_ASSISTANT_PRIVATE_MESSAGE =
  "Percy belongs to your SpecWithCode Connect account and is the same on each machine where you turned it on. A Percy chat stays on the machine it was started on: it is not handed off, moved or started from another machine, and other projects' work cannot reach it.";
