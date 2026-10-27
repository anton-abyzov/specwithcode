import { isAppScratchFolder } from "@specweave-studio/shared/projectOrigin";
import {
  partitionProjectGroups,
  type ProjectListGroup,
  type ScratchRootLookup,
} from "../studio/projectListVisibility";
import { resolveThreadStatusPill } from "./Sidebar.logic";

/**
 * Whether a group may be a machine's "No project" folder the client cannot confirm yet
 * (its machine's config has not arrived, or the folder sits under an older home). Such
 * a group is never folded, so its chats keep their row.
 */
function mayBeScratchGroup(group: ProjectListGroup): boolean {
  return group.memberProjects.some(
    (member) => member.workspaceRoot !== undefined && isAppScratchFolder(member.workspaceRoot),
  );
}

export interface LegacySidebarProjectSections<G extends ProjectListGroup> {
  /**
   * The main list in sidebar order: the person's own projects plus each machine's
   * "No project" folder, which is where this sidebar lists chats.
   */
  readonly listed: G[];
  /** Projects checks and agents made for themselves, folded under "Automated". */
  readonly automated: G[];
  /** Archived projects, folded under "Archived". */
  readonly archived: G[];
  readonly automatedOpen: boolean;
  readonly archivedOpen: boolean;
  /** The rows on screen, in order, which thread jump hints number. */
  readonly visible: G[];
}

/**
 * The legacy sidebar's project sections: automated and archived projects sit in folded
 * sections, as in the studio sidebar. A machine's "No project" folder keeps its row,
 * because this sidebar has no Chats section. A fold the person has not toggled (null)
 * opens while its project is open.
 */
export function legacySidebarProjectSections<G extends ProjectListGroup>(
  groups: ReadonlyArray<G>,
  scratchRootFor: ScratchRootLookup,
  activeProjectKey: string | null,
  folds: { readonly automated: boolean | null; readonly archived: boolean | null },
): LegacySidebarProjectSections<G> {
  const partition = partitionProjectGroups(groups, scratchRootFor);
  const automated = partition.automated.filter((group) => !mayBeScratchGroup(group));
  const archived = partition.archived.filter((group) => !mayBeScratchGroup(group));
  const folded = new Set<G>([...automated, ...archived]);
  const listed = groups.filter((group) => !folded.has(group));
  const holdsActive = (section: G[]) =>
    activeProjectKey !== null && section.some((group) => group.projectKey === activeProjectKey);
  const automatedOpen = automated.length > 0 && (folds.automated ?? holdsActive(automated));
  const archivedOpen = archived.length > 0 && (folds.archived ?? holdsActive(archived));
  return {
    listed,
    automated,
    archived,
    automatedOpen,
    archivedOpen,
    visible: [...listed, ...(automatedOpen ? automated : []), ...(archivedOpen ? archived : [])],
  };
}

type WaitingThreadStatus = Parameters<typeof resolveThreadStatusPill>[0]["thread"];

/** What a thread needs to say whether it waits on the person. */
export type LegacySidebarWaitingThread = WaitingThreadStatus & {
  readonly archivedAt: string | null;
};

// The status pills that ask the person for something: the rows a fold hides would show them.
const WAITING_PILLS = new Set(["Pending Approval", "Awaiting Input", "Plan Ready"]);

/**
 * Threads in these projects waiting on the person (an approval, an answer or a plan to
 * review), counted on a closed fold so folding never hides blocked work, as the studio
 * sidebar's Automated does.
 */
export function legacySidebarWaitingCount(
  projects: ReadonlyArray<ProjectListGroup>,
  threadsByProjectKey: ReadonlyMap<string, ReadonlyArray<LegacySidebarWaitingThread>>,
): number {
  return projects.reduce(
    (sum, project) =>
      sum +
      (threadsByProjectKey.get(project.projectKey) ?? []).filter((thread) => {
        if (thread.archivedAt !== null) return false;
        const label = resolveThreadStatusPill({ thread })?.label;
        return label !== undefined && WAITING_PILLS.has(label);
      }).length,
    0,
  );
}
