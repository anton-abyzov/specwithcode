import { scopedProjectKey, scopeProjectRef } from "../environment/scoped.ts";
import {
  repositoryGroupingDisplayNameOf,
  repositoryGroupingKeyOf,
  type EnvironmentId,
  type ScopedProjectRef,
  type SidebarProjectGroupingMode,
} from "@specweave-studio/contracts";
import type { ClientSettings } from "@specweave-studio/contracts/settings";
import { isWindowsAbsolutePath } from "@specweave-studio/shared/path";

import type { EnvironmentProject } from "./models.ts";
import { inferProjectTitleFromPath, normalizeProjectPathForComparison } from "./projects.ts";

export interface ProjectGroupingSettings {
  readonly sidebarProjectGroupingMode: SidebarProjectGroupingMode;
  readonly sidebarProjectGroupingOverrides: Record<string, SidebarProjectGroupingMode>;
}

export type ProjectGroupingMode = SidebarProjectGroupingMode;

export function selectProjectGroupingSettings(settings: ClientSettings): ProjectGroupingSettings {
  return {
    sidebarProjectGroupingMode: settings.sidebarProjectGroupingMode,
    sidebarProjectGroupingOverrides: settings.sidebarProjectGroupingOverrides,
  };
}

function uniqueNonEmptyValues(values: ReadonlyArray<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    unique.push(trimmed);
  }
  return unique;
}

function deriveRepositoryRelativeProjectPath(
  project: Pick<EnvironmentProject, "workspaceRoot" | "repositoryIdentity">,
): string | null {
  const rootPath = project.repositoryIdentity?.rootPath?.trim();
  if (!rootPath) {
    return null;
  }

  const normalizedProjectPath = normalizeProjectPathForComparison(project.workspaceRoot);
  const normalizedRootPath = normalizeProjectPathForComparison(rootPath);
  if (normalizedProjectPath.length === 0 || normalizedRootPath.length === 0) {
    return null;
  }

  if (normalizedProjectPath === normalizedRootPath) {
    return "";
  }

  const separator = normalizedRootPath.includes("\\") ? "\\" : "/";
  const rootPrefix = `${normalizedRootPath}${separator}`;
  if (!normalizedProjectPath.startsWith(rootPrefix)) {
    return null;
  }

  return normalizedProjectPath.slice(rootPrefix.length).replaceAll("\\", "/");
}

export function derivePhysicalProjectKeyFromPath(environmentId: string, cwd: string): string {
  return `${environmentId}:${normalizeProjectPathForComparison(cwd)}`;
}

export function derivePhysicalProjectKey(
  project: Pick<EnvironmentProject, "environmentId" | "workspaceRoot">,
): string {
  return derivePhysicalProjectKeyFromPath(project.environmentId, project.workspaceRoot);
}

export function deriveProjectGroupingOverrideKey(
  project: Pick<EnvironmentProject, "environmentId" | "workspaceRoot">,
): string {
  return derivePhysicalProjectKey(project);
}

export function getProjectOrderKey(
  project: Pick<EnvironmentProject, "environmentId" | "workspaceRoot">,
): string {
  return derivePhysicalProjectKey(project);
}

export function resolveProjectGroupingMode(
  project: Pick<EnvironmentProject, "environmentId" | "workspaceRoot">,
  settings: ProjectGroupingSettings,
): SidebarProjectGroupingMode {
  return (
    settings.sidebarProjectGroupingOverrides?.[deriveProjectGroupingOverrideKey(project)] ??
    settings.sidebarProjectGroupingMode
  );
}

function deriveRepositoryScopedKey(
  project: Pick<EnvironmentProject, "workspaceRoot" | "repositoryIdentity">,
  groupingMode: SidebarProjectGroupingMode,
): string | null {
  const canonicalKey = project.repositoryIdentity
    ? repositoryGroupingKeyOf(project.repositoryIdentity)
    : null;
  if (!canonicalKey) {
    return null;
  }

  if (groupingMode === "repository") {
    return canonicalKey;
  }

  const relativeProjectPath = deriveRepositoryRelativeProjectPath(project);
  if (relativeProjectPath === null) {
    return canonicalKey;
  }

  return relativeProjectPath.length === 0
    ? canonicalKey
    : `${canonicalKey}::${relativeProjectPath}`;
}

export function deriveLogicalProjectKey(
  project: Pick<
    EnvironmentProject,
    "environmentId" | "id" | "workspaceRoot" | "repositoryIdentity" | "workspaceSettings"
  >,
  options?: {
    readonly groupingMode?: SidebarProjectGroupingMode;
  },
): string {
  const identity = project.workspaceSettings?.logicalProject;
  if (identity) return `logical-project:${identity.id}`;
  const groupingMode = options?.groupingMode ?? "repository";
  if (groupingMode === "separate") {
    return derivePhysicalProjectKey(project);
  }

  return (
    deriveRepositoryScopedKey(project, groupingMode) ??
    derivePhysicalProjectKey(project) ??
    scopedProjectKey(scopeProjectRef(project.environmentId, project.id))
  );
}

export function deriveLogicalProjectKeyFromSettings(
  project: Pick<
    EnvironmentProject,
    "environmentId" | "id" | "workspaceRoot" | "repositoryIdentity" | "workspaceSettings"
  >,
  settings: ProjectGroupingSettings,
): string {
  return deriveLogicalProjectKey(project, {
    groupingMode: resolveProjectGroupingMode(project, settings),
  });
}

export function deriveProjectGroupLabel(input: {
  readonly representative: Pick<EnvironmentProject, "title" | "repositoryIdentity">;
  readonly members: ReadonlyArray<
    Pick<EnvironmentProject, "title" | "repositoryIdentity" | "workspaceRoot">
  >;
}): string {
  const sharedTitles = uniqueNonEmptyValues(input.members.map((member) => member.title));
  const sharedDisplayNames = uniqueNonEmptyValues(
    input.members.map((member) =>
      member.repositoryIdentity ? repositoryGroupingDisplayNameOf(member.repositoryIdentity) : null,
    ),
  );
  const sharedRepositoryNames = uniqueNonEmptyValues(
    input.members.map((member) => member.repositoryIdentity?.name),
  );
  const sharedTitle = sharedTitles[0];
  if (
    sharedTitles.length === 1 &&
    sharedTitle !== undefined &&
    !sharedDisplayNames.includes(sharedTitle) &&
    !sharedRepositoryNames.includes(sharedTitle)
  ) {
    return sharedTitle;
  }

  // Renaming one checkout must survive siblings that still have their automatic
  // folder or repository name. Distinct custom names keep the repository fallback.
  const customTitles = uniqueNonEmptyValues(
    input.members.map((member) => {
      const title = member.title.trim();
      if (sharedDisplayNames.includes(title) || sharedRepositoryNames.includes(title)) return null;
      const path = normalizeProjectPathForComparison(member.workspaceRoot);
      const windowsPath = isWindowsAbsolutePath(path);
      const folderName = path.slice(path.lastIndexOf(windowsPath ? "\\" : "/") + 1);
      const inferredTitle = inferProjectTitleFromPath(path);
      const comparableTitle = windowsPath ? title.toLowerCase() : title;
      return comparableTitle === inferredTitle || comparableTitle === (folderName || "project")
        ? null
        : title;
    }),
  );
  if (customTitles.length === 1) return customTitles[0]!;

  if (sharedDisplayNames.length === 1) {
    return sharedDisplayNames[0]!;
  }

  if (sharedRepositoryNames.length === 1) {
    return sharedRepositoryNames[0]!;
  }

  return input.representative.title;
}

export interface ProjectGroupMember<TProject extends EnvironmentProject = EnvironmentProject> {
  readonly physicalProjectKey: string;
  readonly project: TProject;
}

export interface ProjectGroup<TProject extends EnvironmentProject = EnvironmentProject> {
  readonly key: string;
  readonly label: string;
  readonly representative: TProject;
  readonly members: ReadonlyArray<ProjectGroupMember<TProject>>;
  readonly memberProjectRefs: ReadonlyArray<ScopedProjectRef>;
}

function projectFreshnessTime(project: EnvironmentProject): number {
  const updatedAtTime = Date.parse(project.updatedAt);
  if (Number.isFinite(updatedAtTime)) {
    return updatedAtTime;
  }
  const createdAtTime = Date.parse(project.createdAt);
  return Number.isFinite(createdAtTime) ? createdAtTime : 0;
}

function shouldReplacePhysicalProjectWinner<TProject extends EnvironmentProject>(
  existing: TProject,
  candidate: TProject,
): boolean {
  const freshnessDelta = projectFreshnessTime(candidate) - projectFreshnessTime(existing);
  return freshnessDelta > 0 || (freshnessDelta === 0 && candidate.id > existing.id);
}

function selectProjectIdentitySource<TProject extends EnvironmentProject>(
  projects: ReadonlyArray<TProject>,
  winner: TProject,
): TProject {
  if (winner.repositoryIdentity !== null) {
    return winner;
  }

  let freshestIdentifiedProject: TProject | null = null;
  for (const project of projects) {
    if (project.repositoryIdentity === null) {
      continue;
    }
    if (
      freshestIdentifiedProject === null ||
      shouldReplacePhysicalProjectWinner(freshestIdentifiedProject, project)
    ) {
      freshestIdentifiedProject = project;
    }
  }
  return freshestIdentifiedProject ?? winner;
}

/**
 * Builds logical project groups without losing the physical projects that
 * remain the actual navigation and task-creation targets.
 *
 * Presentation-specific metadata, filtering, and activity sorting stay in
 * each client. Grouping modes, overrides, physical deduplication, labels, and
 * member preservation live here so web and mobile cannot drift.
 */
export function buildProjectGroups<TProject extends EnvironmentProject>(input: {
  readonly projects: ReadonlyArray<TProject>;
  readonly settings: ProjectGroupingSettings;
  readonly preferredEnvironmentId?: EnvironmentId | null;
}): ReadonlyArray<ProjectGroup<TProject>> {
  // An explicit membership survives a source that has not streamed its new metadata yet.
  // Conflicting declarations never absorb a registration by guesswork.
  const membership = new Map<string, Set<string>>();
  const identityOwners = new Map<string, TProject>();
  const identities = new Map<
    string,
    NonNullable<TProject["workspaceSettings"]>["logicalProject"]
  >();
  for (const project of input.projects) {
    const identity = project.workspaceSettings?.logicalProject;
    if (!identity) continue;
    const previous = identities.get(identity.id);
    const owner = identityOwners.get(identity.id);
    const binding = project.workspaceSettings?.coordinatorBinding;
    const ownerBinding = owner?.workspaceSettings?.coordinatorBinding;
    const preferCurrent =
      !owner ||
      (binding?.epoch ?? 0) > (ownerBinding?.epoch ?? 0) ||
      ((binding?.epoch ?? 0) === (ownerBinding?.epoch ?? 0) && binding?.state === "active");
    if (preferCurrent) identityOwners.set(identity.id, project);
    identities.set(identity.id, {
      ...(preferCurrent ? identity : previous!),
      members: [...(previous?.members ?? []), ...identity.members].filter(
        (member, index, refs) =>
          refs.findIndex(
            (other) =>
              other.environmentId === member.environmentId && other.projectId === member.projectId,
          ) === index,
      ),
    });
    for (const member of identity.members) {
      const key = scopedProjectKey(scopeProjectRef(member.environmentId, member.projectId));
      const ids = membership.get(key) ?? new Set<string>();
      ids.add(identity.id);
      membership.set(key, ids);
    }
  }
  const logicalKeyFor = (project: TProject) => {
    const own = project.workspaceSettings?.logicalProject;
    const linked = membership.get(
      scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
    );
    const identity = own?.id ?? (linked?.size === 1 ? [...linked][0] : undefined);
    return identity
      ? `logical-project:${identity}`
      : deriveLogicalProjectKeyFromSettings(project, input.settings);
  };
  // Domain bindings can share a checkout, but each carries independent ownership metadata.
  const registrationKeyFor = (project: TProject) =>
    logicalKeyFor(project).startsWith("logical-project:")
      ? scopedProjectKey(scopeProjectRef(project.environmentId, project.id))
      : derivePhysicalProjectKey(project);
  const projectsByPhysicalKey = new Map<string, TProject[]>();
  for (const project of input.projects) {
    const physicalProjectKey = registrationKeyFor(project);
    const existing = projectsByPhysicalKey.get(physicalProjectKey);
    if (existing) {
      existing.push(project);
    } else {
      projectsByPhysicalKey.set(physicalProjectKey, [project]);
    }
  }

  const logicalKeyByPhysicalKey = new Map<string, string>();
  const groupedMembers = new Map<string, ProjectGroupMember<TProject>[]>();
  for (const [physicalProjectKey, physicalProjects] of projectsByPhysicalKey) {
    const winner = physicalProjects.reduce((current, candidate) =>
      shouldReplacePhysicalProjectWinner(current, candidate) ? candidate : current,
    );
    const identitySource = selectProjectIdentitySource(physicalProjects, winner);
    const logicalKey = logicalKeyFor(identitySource);
    logicalKeyByPhysicalKey.set(physicalProjectKey, logicalKey);
    const member = { physicalProjectKey, project: winner };
    const existing = groupedMembers.get(logicalKey);
    if (existing) {
      existing.push(member);
    } else {
      groupedMembers.set(logicalKey, [member]);
    }
  }

  const projectRefsByLogicalKey = new Map<string, ScopedProjectRef[]>();
  const seenProjectRefs = new Set<string>();
  for (const project of input.projects) {
    const physicalProjectKey = registrationKeyFor(project);
    const logicalKey = logicalKeyByPhysicalKey.get(physicalProjectKey) ?? logicalKeyFor(project);
    const projectRefKey = scopedProjectKey(scopeProjectRef(project.environmentId, project.id));
    if (seenProjectRefs.has(projectRefKey)) continue;
    seenProjectRefs.add(projectRefKey);
    const projectRef = scopeProjectRef(project.environmentId, project.id);
    const existing = projectRefsByLogicalKey.get(logicalKey);
    if (existing) {
      existing.push(projectRef);
    } else {
      projectRefsByLogicalKey.set(logicalKey, [projectRef]);
    }
  }

  const preferredEnvironmentId = input.preferredEnvironmentId ?? null;
  return Array.from(groupedMembers, ([key, members]) => {
    const representative =
      (preferredEnvironmentId
        ? members.find((member) => member.project.environmentId === preferredEnvironmentId)?.project
        : null) ?? members[0]!.project;
    return {
      key,
      label:
        identities.get(key.replace(/^logical-project:/, ""))?.title ??
        (members.length > 1
          ? deriveProjectGroupLabel({
              representative,
              members: members.map((member) => member.project),
            })
          : representative.title),
      representative,
      members,
      memberProjectRefs: [
        ...(projectRefsByLogicalKey.get(key) ?? []),
        ...(identities.get(key.replace(/^logical-project:/, ""))?.members ?? []).map((member) =>
          scopeProjectRef(member.environmentId, member.projectId),
        ),
      ].filter(
        (ref, index, refs) =>
          refs.findIndex((other) => scopedProjectKey(other) === scopedProjectKey(ref)) === index,
      ),
    };
  });
}
