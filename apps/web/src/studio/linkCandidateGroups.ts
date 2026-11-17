import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import { copyRoles } from "./projectDomain";
import { sameRepositoryPlaceKey, type LinkCandidate } from "./projectLink";

const keyOf = (project: Pick<EnvironmentProject, "environmentId" | "id">) =>
  `${project.environmentId}:${project.id}`;

export interface LinkCandidateGroups {
  /** Copies of this project, the rows the link dialog lists. */
  readonly copies: LinkCandidate[];
  /** Every other project on another machine, folded under "Other projects". */
  readonly others: LinkCandidate[];
}

/**
 * Splits the dialog's ranked candidates, keeping their order. A copy is a candidate whose
 * folder was read and shares this project's root repository; one that was not read (its
 * machine is not connected, or the read failed) and tracks the same repository at the
 * same place; and the copy the caller named. A folder that was read and does not match is
 * never a copy, whatever its remote says.
 */
export function linkCandidateGroups(input: {
  readonly ranked: ReadonlyArray<LinkCandidate>;
  readonly project: Pick<EnvironmentProject, "repositoryIdentity" | "workspaceRoot">;
  /** `environmentId:projectId` of the copy the caller named, always listed. */
  readonly namedKey: string | null;
}): LinkCandidateGroups {
  const own = sameRepositoryPlaceKey(input.project);
  const copies: LinkCandidate[] = [];
  const others: LinkCandidate[] = [];
  for (const candidate of input.ranked) {
    const copy =
      keyOf(candidate.project) === input.namedKey ||
      candidate.rootMatches === true ||
      (candidate.rootMatches === null &&
        own !== null &&
        sameRepositoryPlaceKey(candidate.project) === own);
    (copy ? copies : others).push(candidate);
  }
  return { copies, others };
}

/**
 * The copy the dialog selects on its own: the most matching repositories among compared
 * same-root copies on machines that can link now. A tie keeps the given order, so the
 * list's first such row wins. Null when no copy qualifies; a copy on a machine that
 * cannot link, or one without a root match, is never chosen.
 */
export function bestLinkCopy(
  copies: ReadonlyArray<LinkCandidate>,
  canLink: (environmentId: EnvironmentProject["environmentId"]) => boolean,
): LinkCandidate | null {
  let best: LinkCandidate | null = null;
  for (const candidate of copies) {
    if (candidate.rootMatches !== true || !canLink(candidate.project.environmentId)) continue;
    if (best === null || (candidate.shared ?? 0) > (best.shared ?? 0)) best = candidate;
  }
  return best;
}

/**
 * The machine Main is on for a project already linked with another copy, from the role
 * derivation the menus, Settings and the copy dialog share. Null for a project that is
 * not linked yet (the link review decides which side keeps the coordinator) and when no
 * copy in sight names Main.
 */
export function linkedMainEnvironmentId<
  T extends Pick<EnvironmentProject, "environmentId" | "id" | "workspaceSettings">,
>(
  project: T,
  projects: ReadonlyArray<T>,
  retired?: { has(environmentId: string): boolean },
): string | null {
  const logical = project.workspaceSettings?.logicalProject;
  if (
    !logical?.members.some(
      (member) =>
        member.environmentId !== project.environmentId || member.projectId !== project.id,
    )
  )
    return null;
  const members = projects.filter(
    (item) => item.workspaceSettings?.logicalProject?.id === logical.id,
  );
  const all = members.some((item) => keyOf(item) === keyOf(project))
    ? members
    : [project, ...members];
  return copyRoles(all, retired).get(keyOf(project))?.mainEnvironmentId ?? null;
}
