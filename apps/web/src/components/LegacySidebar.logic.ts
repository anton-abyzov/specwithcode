import { isAppScratchFolder } from "@specweave-studio/shared/projectOrigin";
import {
  isAssistantGroup,
  partitionProjectGroups,
  type ProjectListGroup,
  type ScratchRootLookup,
} from "../studio/projectListVisibility";
import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping";
import { resolveThreadStatusPill } from "./Sidebar.logic";
import {
  assistantGroupHint,
  assistantMembersOf,
  sortAssistantGroups,
} from "./studio/assistantEntries";

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
 * opens while its project is open. Percy is not a project: it is in no section, even
 * automated or archived, and has its own link above the list.
 */
export function legacySidebarProjectSections<G extends ProjectListGroup>(
  allGroups: ReadonlyArray<G>,
  scratchRootFor: ScratchRootLookup,
  activeProjectKey: string | null,
  folds: { readonly automated: boolean | null; readonly archived: boolean | null },
): LegacySidebarProjectSections<G> {
  const groups = withoutAssistants(allGroups);
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
const WAITING_PILLS = new Set([
  "Pending Approval",
  "Pending Access",
  "Awaiting Input",
  "Plan Ready",
]);

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

/** The groups a sidebar's project list shows: every one but a personal assistant. */
export function withoutAssistants<G extends ProjectListGroup>(groups: ReadonlyArray<G>): G[] {
  return groups.filter((group) => !isAssistantGroup(group));
}

/** One link above the Projects list that opens an assistant, as the studio sidebar's Percy row does. */
export interface LegacySidebarAssistantLink {
  readonly projectKey: string;
  readonly title: string;
  /** The machine it lives on once there is more than one, and "extra" for a duplicate. */
  readonly hint: string | undefined;
}

/**
 * The assistants the legacy sidebars link to, archived and automated ones included as in
 * the studio sidebar's Percy block: this machine's first. Empty while Percy is off, since
 * the sidebars leave a hidden assistant out of their groups.
 */
export function legacySidebarAssistantLinks(
  groups: ReadonlyArray<SidebarProjectSnapshot>,
  primaryEnvironmentId: string | null,
): LegacySidebarAssistantLink[] {
  const assistants = groups.filter(isAssistantGroup);
  const members = assistantMembersOf(assistants);
  const labels = new Map(
    groups.flatMap((group) =>
      group.memberProjects.map((member) => [member.environmentId, member.environmentLabel]),
    ),
  );
  return sortAssistantGroups(assistants, members, primaryEnvironmentId).map((group) => ({
    projectKey: group.projectKey,
    title: group.displayName,
    hint: assistantGroupHint(group, members, (id) => labels.get(id as never), labels.size),
  }));
}
