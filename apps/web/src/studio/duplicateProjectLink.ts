import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import {
  repositoryGroupingDisplayNameOf,
  repositoryGroupingKeyOf,
  repositoryRelativePathOf,
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
  /** The copies sit on this one row, so its text names the candidate's machine. */
  readonly sameRow?: true;
  /**
   * More unlinked copies of the same repository that wait behind `candidate`: the row
   * names them too, and offers the next one once this one is linked.
   */
  readonly more?: ReadonlyArray<EnvironmentProject>;
}

export interface SuggestionGroup {
  readonly projectKey: string;
  readonly displayName: string;
  readonly memberProjects: ReadonlyArray<EnvironmentProject>;
}

const refKey = (project: Pick<EnvironmentProject, "environmentId" | "id">) =>
  `${project.environmentId}:${project.id}`;

/**
 * Where a project sits inside its repository: "" at the root, null when unknown. Two
 * projects in one monorepo (apps/web and apps/api) are different work, so the place
 * inside the repository is part of the match. Mirrors the server's worker matching.
 */
export function repositoryRelativePath(
  project: Pick<EnvironmentProject, "repositoryIdentity" | "workspaceRoot">,
): string | null {
  if (typeof project.workspaceRoot !== "string") return null;
  return repositoryRelativePathOf(project.workspaceRoot, project.repositoryIdentity?.rootPath);
}

/** The one repository, and place in it, that every copy is; null otherwise. */
function soleRepositoryKey(members: ReadonlyArray<EnvironmentProject>): string | null {
  let key: string | null = null;
  for (const member of members) {
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
 * - no two of the rows share a machine (two folders on one machine are not copies to link);
 * - every copy the established row names is listed, so no offline copy hides a link;
 * - one row is the established one, so the suggestion never has to guess which: the only
 *   row that is already a linked project, or, when every row is a single unlinked copy,
 *   this machine's;
 * - the person has not said they are different projects.
 * Any number of rows may match (a repository added on three machines offers two links,
 * one per unlinked row). A row that merged two or more copies on different machines is
 * suggested the same way: unlinked copies join this machine's copy, or the row's linked
 * project when some of its copies are linked already. One link is offered at a time.
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
  const plain = (member: EnvironmentProject) =>
    typeof member.workspaceRoot === "string" &&
    isProjectFolder(member.workspaceRoot, member.id) &&
    options.eligible(member);
  const byRepository = new Map<string, SuggestionGroup[]>();
  for (const group of groups) {
    if (group.memberProjects.length === 0) continue;
    const key = soleRepositoryKey(group.memberProjects);
    if (key === null) continue;
    if (!group.memberProjects.every(plain)) continue;
    byRepository.set(key, [...(byRepository.get(key) ?? []), group]);
  }
  const suggestions = new Map<string, DuplicateLinkSuggestion>();
  const repositoryOf = (candidate: EnvironmentProject) =>
    candidate.repositoryIdentity
      ? (repositoryGroupingDisplayNameOf(candidate.repositoryIdentity) ?? null)
      : null;
  const machinesOf = (group: SuggestionGroup) =>
    new Set(group.memberProjects.map((member) => member.environmentId));
  for (const same of byRepository.values()) {
    if (same.length < 2) continue;
    // Two rows on one machine are two folders there, not copies to link.
    const machines = same.flatMap((group) => [...machinesOf(group)]);
    if (new Set(machines).size !== machines.length) continue;
    const here = (group: SuggestionGroup) =>
      group.memberProjects.some((member) => member.environmentId === options.primaryEnvironmentId);
    // A joining row is a single copy that lists no other. Every project lists itself as a
    // member; one that lists another copy is linked, even when that copy's machine is not
    // listed here.
    const unlinked = (group: SuggestionGroup) =>
      group.memberProjects.length === 1 && !isLinked(group.memberProjects[0]!);
    const settled = same.filter((group) => !unlinked(group));
    // The established row: the one that is a project already, or this machine's when every
    // row is a single unlinked copy. With two projects already there is nothing to pick.
    const established =
      settled.length === 1
        ? settled[0]!
        : settled.length === 0
          ? (same.filter(here)[0] ?? null)
          : null;
    if (!established || !listsEveryCopy(established)) continue;
    const anchor = anchorOf(established, options.primaryEnvironmentId);
    if (!anchor) continue;
    for (const joining of same) {
      if (joining === established || !unlinked(joining)) continue;
      const candidate = joining.memberProjects[0]!;
      if (refKey(anchor) === refKey(candidate)) continue;
      if (options.dismissed?.(candidate)) continue;
      suggestions.set(joining.projectKey, {
        anchor,
        candidate,
        anchorTitle: established.displayName,
        repository: repositoryOf(candidate),
      });
    }
  }
  // Grouped by repository, unlinked copies on different machines share one row: the
  // copies elsewhere join this machine's, or the project some of the row's copies already
  // are. Staging copies in the row are not projects.
  const plainByRepository = new Map<string, SuggestionGroup[]>();
  for (const group of groups) {
    const key = soleRepositoryKey(group.memberProjects.filter(plain));
    if (key !== null) plainByRepository.set(key, [...(plainByRepository.get(key) ?? []), group]);
  }
  for (const same of plainByRepository.values()) {
    if (same.length !== 1) continue;
    const group = same[0]!;
    if (suggestions.has(group.projectKey)) continue;
    const copies = group.memberProjects.filter(plain);
    if (copies.length < 2) continue;
    // One copy per machine: two folders on one machine are not copies to link.
    if (new Set(copies.map((copy) => copy.environmentId)).size !== copies.length) continue;
    const linked = copies.filter(isLinked);
    const waiting = copies.filter((copy) => !isLinked(copy));
    let anchor: EnvironmentProject | undefined;
    if (linked.length === 0) {
      anchor = copies.find((copy) => copy.environmentId === options.primaryEnvironmentId);
    } else {
      // One project, every copy it names in this row: nothing offline hides another link.
      const projectIds = new Set(
        linked.map((copy) => copy.workspaceSettings?.logicalProject?.id ?? ""),
      );
      const listed = new Set(copies.map(refKey));
      const complete = linked.every((copy) =>
        (copy.workspaceSettings?.logicalProject?.members ?? []).every((member) =>
          listed.has(`${member.environmentId}:${member.projectId}`),
        ),
      );
      if (projectIds.size !== 1 || !complete) continue;
      anchor =
        logicalCoordinator(linked)?.member ??
        linked.find((copy) => copy.environmentId === options.primaryEnvironmentId) ??
        linked[0];
    }
    if (!anchor) continue;
    const candidates = waiting.filter(
      (copy) => refKey(copy) !== refKey(anchor) && !options.dismissed?.(copy),
    );
    const [candidate, ...more] = candidates;
    if (!candidate) continue;
    suggestions.set(group.projectKey, {
      anchor,
      candidate,
      anchorTitle: anchor.title,
      repository: repositoryOf(candidate),
      sameRow: true,
      ...(more.length > 0 ? { more } : {}),
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
