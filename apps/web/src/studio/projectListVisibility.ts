/**
 * Which projects a project list shows. A machine's scratch project ("No project")
 * holds chats started without a project; those chats are listed under Chats, so the
 * project itself is never a row. An archived project keeps its threads, memory and
 * folder but leaves the main list; it is listed again under "Archived".
 */
import { isScratchProject } from "@specweave-studio/client-runtime/state/projects";
import type { EnvironmentId, ProjectId, ProjectWorkspacePatch } from "@specweave-studio/contracts";

export interface ProjectListMember {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
  readonly workspaceRoot?: string | undefined;
  readonly workspaceSettings?:
    | { readonly archived?: boolean | undefined; readonly revision?: number | undefined }
    | null
    | undefined;
}

export interface ProjectListGroup {
  readonly projectKey: string;
  readonly memberProjects: ReadonlyArray<ProjectListMember>;
}

/** The scratch folder each machine reports in its server config, if it reports one. */
export type ScratchRootLookup = (environmentId: EnvironmentId) => string | null | undefined;

export function isScratchMember(member: ProjectListMember, scratchRootFor: ScratchRootLookup) {
  return (
    member.workspaceRoot !== undefined &&
    isScratchProject({ workspaceRoot: member.workspaceRoot }, scratchRootFor(member.environmentId))
  );
}

export function isArchivedMember(member: ProjectListMember): boolean {
  return member.workspaceSettings?.archived === true;
}

/** Recheck the live catalog before a draft changes its destination. */
export function projectDestinationUnavailableReason(
  target: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId | null },
  projects: ReadonlyArray<ProjectListMember>,
  resolved?: ProjectListMember | null,
): string | null {
  if (target.projectId === null && !resolved) return null;
  const projectId = target.projectId ?? resolved?.id;
  const project = projects.find(
    (member) => member.environmentId === target.environmentId && member.id === projectId,
  );
  // A freshly created Scratch may precede its catalog render; an observed archive always wins.
  if (!project && !(target.projectId === null && resolved))
    return "The destination project is no longer available. Choose it again.";
  return (project && isArchivedMember(project)) || (resolved && isArchivedMember(resolved))
    ? "This project is archived. Restore it before starting new work."
    : null;
}

/** True when every member of the group is that machine's scratch project. */
export function isScratchGroup(group: ProjectListGroup, scratchRootFor: ScratchRootLookup) {
  return (
    group.memberProjects.length > 0 &&
    group.memberProjects.every((member) => isScratchMember(member, scratchRootFor))
  );
}

/** True when every real (non-scratch) member is archived, so no machine offers it for work. */
export function isArchivedGroup(group: ProjectListGroup, scratchRootFor: ScratchRootLookup) {
  const real = group.memberProjects.filter((member) => !isScratchMember(member, scratchRootFor));
  return real.length > 0 && real.every(isArchivedMember);
}

export interface ProjectListPartition<G extends ProjectListGroup> {
  /** The main list, in input order. */
  readonly listed: G[];
  /** Archived projects, in input order. */
  readonly archived: G[];
}

/**
 * Splits groups into the main list and the archived list; scratch groups are in
 * neither. An archived project stays in the main list while the person has it open
 * or while it has threads waiting on them, so neither loses its visible row.
 */
export function partitionProjectGroups<G extends ProjectListGroup>(
  groups: ReadonlyArray<G>,
  scratchRootFor: ScratchRootLookup,
  activeProjectKey: string | null = null,
  hasWaiting: (projectKey: string) => boolean = () => false,
): ProjectListPartition<G> {
  const listed: G[] = [];
  const archived: G[] = [];
  for (const group of groups) {
    if (isScratchGroup(group, scratchRootFor)) continue;
    if (
      isArchivedGroup(group, scratchRootFor) &&
      group.projectKey !== activeProjectKey &&
      !hasWaiting(group.projectKey)
    ) {
      archived.push(group);
    } else {
      listed.push(group);
    }
  }
  return { listed, archived };
}

/** The workspace-settings patch that archives or restores one project. */
export function archiveWorkspacePatch(
  member: ProjectListMember,
  archived: boolean,
): Pick<ProjectWorkspacePatch, "expectedRevision" | "archived"> {
  return { expectedRevision: member.workspaceSettings?.revision ?? 0, archived };
}

/** The members an archive or restore of the whole group has to change. */
export function membersToToggle<M extends ProjectListMember>(
  group: { readonly memberProjects: ReadonlyArray<M> },
  archived: boolean,
  scratchRootFor: ScratchRootLookup,
): M[] {
  return group.memberProjects.filter(
    (member) => !isScratchMember(member, scratchRootFor) && isArchivedMember(member) !== archived,
  );
}
