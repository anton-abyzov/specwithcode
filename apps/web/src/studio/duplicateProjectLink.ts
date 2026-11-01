import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import {
  repositoryGroupingDisplayNameOf,
  repositoryGroupingKeyOf,
  type EnvironmentId,
  type ProjectId,
} from "@specweave-studio/contracts";
import { logicalCoordinator } from "./projectDomain";
import { isProjectFolder } from "./projectMachineFolders";

/**
 * "Same repository as specweave on M4. Link them?": a project listed twice because the
 * same repository was added on two machines separately. Each machine minted its own
 * project, so the sidebar cannot merge them; linking them makes them one project.
 *
 * Only a certain match is suggested. The link dialog still compares both folders'
 * repositories before anything is linked, and the person confirms it there.
 */
export interface DuplicateLinkSuggestion {
  /** The copy that is already established: the link dialog opens on it. */
  readonly anchor: EnvironmentProject;
  /** This row's single copy, the one that joins. */
  readonly candidate: EnvironmentProject;
  /** The established row's name, for "Same repository as {title} on {machine}". */
  readonly anchorTitle: string;
  /** "anton-abyzov/specweave", when the repository names itself. */
  readonly repository: string | null;
}

export interface SuggestionGroup {
  readonly projectKey: string;
  readonly displayName: string;
  readonly memberProjects: ReadonlyArray<EnvironmentProject>;
}

const refKey = (project: Pick<EnvironmentProject, "environmentId" | "id">) =>
  `${project.environmentId}:${project.id}`;

const normalizePath = (path: string) => path.trim().replaceAll("\\", "/").replace(/\/+$/u, "");

/**
 * Where a project sits inside its repository: "" at the root, null when unknown. Two
 * projects in one monorepo (apps/web and apps/api) are different work, so the place
 * inside the repository is part of the match. Mirrors the server's worker matching.
 */
export function repositoryRelativePath(
  project: Pick<EnvironmentProject, "repositoryIdentity" | "workspaceRoot">,
): string | null {
  const rootPath = project.repositoryIdentity?.rootPath;
  if (!rootPath || typeof project.workspaceRoot !== "string") return null;
  const root = normalizePath(rootPath);
  const workspace = normalizePath(project.workspaceRoot);
  if (root.length === 0 || workspace.length === 0) return null;
  if (workspace === root) return "";
  return workspace.startsWith(`${root}/`) ? workspace.slice(root.length + 1) : null;
}

/** The one repository, and place in it, that every copy in the group is; null otherwise. */
function soleRepositoryKey(group: SuggestionGroup): string | null {
  let key: string | null = null;
  for (const member of group.memberProjects) {
    if (!member.repositoryIdentity) return null;
    const inside = repositoryRelativePath(member);
    if (inside === null) return null;
    const own = `${repositoryGroupingKeyOf(member.repositoryIdentity)}\u0000${inside}`;
    if (key !== null && key !== own) return null;
    key = own;
  }
  return key;
}

/** True when the project's identity names a copy other than itself. */
function isLinked(project: EnvironmentProject): boolean {
  return (project.workspaceSettings?.logicalProject?.members ?? []).some(
    (member) => member.environmentId !== project.environmentId || member.projectId !== project.id,
  );
}

/** True when every copy the group's projects name is listed here, so its shape is known. */
function listsEveryCopy(group: SuggestionGroup): boolean {
  const listed = new Set(group.memberProjects.map(refKey));
  return group.memberProjects.every((project) =>
    (project.workspaceSettings?.logicalProject?.members ?? []).every((member) =>
      listed.has(`${member.environmentId}:${member.projectId}`),
    ),
  );
}

/** The copy the dialog opens on: the group's coordinator, else this machine's, else the first. */
function anchorOf(
  group: SuggestionGroup,
  primaryEnvironmentId: EnvironmentId | null,
): EnvironmentProject | undefined {
  const shared = group.memberProjects.filter((member) => member.workspaceSettings?.logicalProject);
  return (
    (shared.length > 0 ? logicalCoordinator(shared)?.member : undefined) ??
    group.memberProjects.find((member) => member.environmentId === primaryEnvironmentId) ??
    group.memberProjects[0]
  );
}

/**
 * The rows that hold an unlinked copy of a repository another row already lists, keyed
 * by that row's project key. A row is suggested only when every one of these holds:
 * - it is one plain code project on one machine (a linked row is already a project);
 * - every copy on both rows is a checkout of the same repository, by remote, not by name;
 * - the two rows share no machine (two folders on one machine are not copies to link);
 * - every copy the established row names is listed, so no offline copy hides a link;
 * - exactly one other row matches, so the suggestion never has to guess which;
 * - the person has not said they are different projects.
 * When both rows hold a single copy, the copy on another machine is the one offered,
 * so this machine's project stays the established one.
 */
export function duplicateLinkSuggestions(
  groups: ReadonlyArray<SuggestionGroup>,
  options: {
    readonly primaryEnvironmentId: EnvironmentId | null;
    /** One of the person's own code projects: not archived, automated or a scratch folder. */
    readonly eligible: (project: EnvironmentProject) => boolean;
    readonly dismissed?: (candidate: EnvironmentProject) => boolean;
  },
): Map<string, DuplicateLinkSuggestion> {
  const byRepository = new Map<string, SuggestionGroup[]>();
  for (const group of groups) {
    if (group.memberProjects.length === 0) continue;
    const key = soleRepositoryKey(group);
    if (key === null) continue;
    const plain = (member: EnvironmentProject) =>
      typeof member.workspaceRoot === "string" &&
      isProjectFolder(member.workspaceRoot, member.id) &&
      options.eligible(member);
    if (!group.memberProjects.every(plain)) continue;
    byRepository.set(key, [...(byRepository.get(key) ?? []), group]);
  }
  const suggestions = new Map<string, DuplicateLinkSuggestion>();
  for (const same of byRepository.values()) {
    if (same.length !== 2) continue;
    const [first, second] = same as [SuggestionGroup, SuggestionGroup];
    const machinesOf = (group: SuggestionGroup) =>
      new Set(group.memberProjects.map((member) => member.environmentId));
    const firstMachines = machinesOf(first);
    if ([...machinesOf(second)].some((id) => firstMachines.has(id))) continue;
    const single = (group: SuggestionGroup) => group.memberProjects.length === 1;
    const here = (group: SuggestionGroup) =>
      group.memberProjects.some((member) => member.environmentId === options.primaryEnvironmentId);
    // The joining row: the single copy, and of two single copies, the one elsewhere.
    // Every project lists itself as a member; one that lists another copy is linked,
    // even when that copy's machine is not listed here.
    const unlinked = (group: SuggestionGroup) =>
      single(group) && !isLinked(group.memberProjects[0]!);
    const joining =
      unlinked(first) && unlinked(second)
        ? here(first) && !here(second)
          ? second
          : here(second) && !here(first)
            ? first
            : null
        : unlinked(first)
          ? first
          : unlinked(second)
            ? second
            : null;
    if (!joining) continue;
    const established = joining === first ? second : first;
    if (!listsEveryCopy(established)) continue;
    const candidate = joining.memberProjects[0]!;
    const anchor = anchorOf(established, options.primaryEnvironmentId);
    if (!anchor || refKey(anchor) === refKey(candidate)) continue;
    if (options.dismissed?.(candidate)) continue;
    suggestions.set(joining.projectKey, {
      anchor,
      candidate,
      anchorTitle: established.displayName,
      repository: candidate.repositoryIdentity
        ? (repositoryGroupingDisplayNameOf(candidate.repositoryIdentity) ?? null)
        : null,
    });
  }
  return suggestions;
}

const DISMISS_PREFIX = "specwithcode:link-suggestion-dismissed:";

/** "Not the same project": this copy is never suggested again on this device. */
export function dismissLinkSuggestion(candidate: Pick<EnvironmentProject, "environmentId" | "id">) {
  try {
    localStorage.setItem(`${DISMISS_PREFIX}${refKey(candidate)}`, "1");
  } catch {
    /* Without storage the suggestion simply shows again next time. */
  }
}

export function isLinkSuggestionDismissed(
  candidate: Pick<EnvironmentProject, "environmentId" | "id">,
): boolean {
  try {
    return localStorage.getItem(`${DISMISS_PREFIX}${refKey(candidate)}`) === "1";
  } catch {
    return false;
  }
}

/** The dialog's two sides, as `ProjectLinkDialog` takes them. */
export function linkDialogTarget(suggestion: DuplicateLinkSuggestion): {
  readonly project: EnvironmentProject;
  readonly candidate: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId };
} {
  return {
    project: suggestion.anchor,
    candidate: {
      environmentId: suggestion.candidate.environmentId,
      projectId: suggestion.candidate.id,
    },
  };
}
