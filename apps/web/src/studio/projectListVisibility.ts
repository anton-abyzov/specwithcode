/**
 * Which projects a project list shows. A machine's scratch project ("No project")
 * holds chats started without a project; those chats are listed under Chats, so the
 * project itself is never a row. An archived project keeps its threads, memory and
 * folder but leaves the main list; it is listed again under "Archived". A project a
 * check or agent made for itself (see projectOrigin) is listed under "Automated", so
 * the main list holds only the person's own projects.
 */
import { isScratchProject } from "@specweave-studio/client-runtime/state/projects";
import type {
  EnvironmentId,
  ProjectId,
  ProjectOrigin,
  ProjectWorkspacePatch,
} from "@specweave-studio/contracts";
import { projectOrigin } from "@specweave-studio/shared/projectOrigin";

export interface ProjectListMember {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
  readonly workspaceRoot?: string | undefined;
  readonly workspaceSettings?:
    | {
        readonly archived?: boolean | undefined;
        readonly revision?: number | undefined;
        readonly origin?: string | undefined;
        readonly temporarySessionId?: string | undefined;
        readonly kind?: string | undefined;
      }
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

/** True when a check or agent made this checkout for itself; see projectOrigin. */
export function isAutomatedMember(member: ProjectListMember): boolean {
  return (
    member.workspaceRoot !== undefined &&
    projectOrigin({
      workspaceRoot: member.workspaceRoot,
      workspaceSettings: member.workspaceSettings,
    }) === "automated"
  );
}

/** True when every real (non-scratch) member is automated: no machine holds it as the person's. */
export function isAutomatedGroup(group: ProjectListGroup, scratchRootFor: ScratchRootLookup) {
  const real = group.memberProjects.filter((member) => !isScratchMember(member, scratchRootFor));
  return real.length > 0 && real.every(isAutomatedMember);
}

/**
 * `environmentId:projectId` of every checkout of an archived project. Overview
 * leaves their threads out, as the sidebar leaves the projects out of its list.
 */
export function archivedMemberKeys(
  groups: ReadonlyArray<ProjectListGroup>,
  scratchRootFor: ScratchRootLookup,
): Set<string> {
  const keys = new Set<string>();
  for (const group of groups) {
    if (!isArchivedGroup(group, scratchRootFor)) continue;
    for (const member of group.memberProjects) keys.add(`${member.environmentId}:${member.id}`);
  }
  return keys;
}

/**
 * `environmentId:projectId` of every checkout of a project listed under Automated.
 * Overview leaves their threads out, as it leaves the projects out of its cards.
 */
export function automatedMemberKeys(
  groups: ReadonlyArray<ProjectListGroup>,
  scratchRootFor: ScratchRootLookup,
): Set<string> {
  const keys = new Set<string>();
  for (const group of groups) {
    if (isArchivedGroup(group, scratchRootFor) || !isAutomatedGroup(group, scratchRootFor))
      continue;
    for (const member of group.memberProjects) keys.add(`${member.environmentId}:${member.id}`);
  }
  return keys;
}

export interface ProjectListPartition<G extends ProjectListGroup> {
  /** The main list: the person's own projects, in input order. */
  readonly listed: G[];
  /** Projects checks and agents made for themselves, in input order. */
  readonly automated: G[];
  /** Archived projects, in input order. */
  readonly archived: G[];
}

/**
 * Splits groups into the main list, the automated list and the archived list;
 * scratch groups are in none. An archived project stays in the main list while the
 * person has it open or while it has threads waiting on them, so neither loses its
 * visible row. An automated project is archived like any other once the person
 * archives it; otherwise it stays in the automated list, which opens to show it.
 */
export function partitionProjectGroups<G extends ProjectListGroup>(
  groups: ReadonlyArray<G>,
  scratchRootFor: ScratchRootLookup,
  activeProjectKey: string | null = null,
  hasWaiting: (projectKey: string) => boolean = () => false,
): ProjectListPartition<G> {
  const listed: G[] = [];
  const automated: G[] = [];
  const archived: G[] = [];
  for (const group of groups) {
    if (isScratchGroup(group, scratchRootFor)) continue;
    if (
      isArchivedGroup(group, scratchRootFor) &&
      group.projectKey !== activeProjectKey &&
      !hasWaiting(group.projectKey)
    ) {
      archived.push(group);
    } else if (isAutomatedGroup(group, scratchRootFor)) {
      automated.push(group);
    } else {
      listed.push(group);
    }
  }
  return { listed, automated, archived };
}

/**
 * What a picker chooses a project for. "work" (the default) and "design" offer every
 * project of the person's own, personal assistants included; "code" offers only code
 * projects, for flows that read a codebase (Design from code, Scan from code).
 */
export type ProjectPickerPurpose = "work" | "design" | "code";

export interface ProjectPickerOptions {
  readonly purpose?: ProjectPickerPurpose | undefined;
  /**
   * Management lists only: automated projects follow the person's own. An ordinary
   * picker never sets it.
   */
  readonly includeAutomated?: boolean | undefined;
}

/** Why a project is not an ordinary choice in a picker. */
export type IneligibleProjectReason = "scratch" | "archived" | "automated" | "not-code";

/** A project without a kind is a code project, as the workspace settings decode it. */
function fitsPurpose(member: ProjectListMember, purpose: ProjectPickerPurpose) {
  return purpose !== "code" || (member.workspaceSettings?.kind ?? "code") === "code";
}

/**
 * Why one machine's project is not an ordinary choice, or null when it is: a machine's
 * "No project" folder, an archived project, a project a check or agent made for itself,
 * or, for a code picker, a project that is not a code project.
 */
export function projectChoiceIneligibleReason(
  member: ProjectListMember,
  scratchRootFor: ScratchRootLookup,
  purpose: ProjectPickerPurpose = "work",
): IneligibleProjectReason | null {
  if (isScratchMember(member, scratchRootFor)) return "scratch";
  if (isArchivedMember(member)) return "archived";
  if (isAutomatedMember(member)) return "automated";
  return fitsPurpose(member, purpose) ? null : "not-code";
}

/** True when a picker offers this project: one of the person's own, fit for the purpose. */
export function isOrdinaryProjectChoice(
  member: ProjectListMember,
  scratchRootFor: ScratchRootLookup,
  purpose: ProjectPickerPurpose = "work",
): boolean {
  return projectChoiceIneligibleReason(member, scratchRootFor, purpose) === null;
}

/** {@link projectChoiceIneligibleReason} for a project listed once across machines. */
export function projectGroupIneligibleReason(
  group: ProjectListGroup,
  scratchRootFor: ScratchRootLookup,
  purpose: ProjectPickerPurpose = "work",
): IneligibleProjectReason | null {
  if (isScratchGroup(group, scratchRootFor)) return "scratch";
  if (isArchivedGroup(group, scratchRootFor)) return "archived";
  if (isAutomatedGroup(group, scratchRootFor)) return "automated";
  return groupFitsPurpose(group, scratchRootFor, purpose) ? null : "not-code";
}

function groupFitsPurpose(
  group: ProjectListGroup,
  scratchRootFor: ScratchRootLookup,
  purpose: ProjectPickerPurpose,
) {
  return (
    purpose !== "code" ||
    group.memberProjects.some(
      (member) => !isScratchMember(member, scratchRootFor) && fitsPurpose(member, purpose),
    )
  );
}

/**
 * The projects a project picker offers: only the person's own, so neither a machine's
 * "No project" folder, an archived project nor a project a check or agent made for itself
 * is a choice, not even the one already selected. A picker whose current selection is
 * one of those shows it apart, as a row that cannot be chosen; see
 * {@link ineligibleSelectedGroup}.
 */
export function projectPickerGroups<G extends ProjectListGroup>(
  groups: ReadonlyArray<G>,
  scratchRootFor: ScratchRootLookup,
  options: ProjectPickerOptions = {},
): G[] {
  const purpose = options.purpose ?? "work";
  const reasons = groups.map((group) =>
    projectGroupIneligibleReason(group, scratchRootFor, purpose),
  );
  const own = groups.filter((_, index) => reasons[index] === null);
  if (!options.includeAutomated) return own;
  const automated = groups.filter(
    (group, index) =>
      reasons[index] === "automated" && groupFitsPurpose(group, scratchRootFor, purpose),
  );
  return [...own, ...automated];
}

/** {@link projectPickerGroups} for a picker that lists one row per machine's project. */
export function projectPickerMembers<M extends ProjectListMember>(
  projects: ReadonlyArray<M>,
  scratchRootFor: ScratchRootLookup,
  options: ProjectPickerOptions = {},
): M[] {
  const purpose = options.purpose ?? "work";
  const own = projects.filter((project) =>
    isOrdinaryProjectChoice(project, scratchRootFor, purpose),
  );
  if (!options.includeAutomated) return own;
  // The person's own projects lead; automated ones follow, in their own order.
  const automated = projects.filter(
    (project) =>
      projectChoiceIneligibleReason(project, scratchRootFor, purpose) === "automated" &&
      fitsPurpose(project, purpose),
  );
  return [...own, ...automated];
}

/** A picker's current selection that is not an ordinary choice, and why. */
export interface IneligibleProjectSelection<P> {
  readonly project: P;
  readonly reason: IneligibleProjectReason;
}

/**
 * The selected project when the picker does not offer it, so the picker can show it as
 * its current context, in a row that cannot be chosen. Null when nothing is selected,
 * the selection is an ordinary choice, or no listed project matches it.
 */
export function ineligibleSelectedMember<M extends ProjectListMember>(
  projects: ReadonlyArray<M>,
  selected: Pick<ProjectListMember, "environmentId" | "id"> | null | undefined,
  scratchRootFor: ScratchRootLookup,
  purpose: ProjectPickerPurpose = "work",
): IneligibleProjectSelection<M> | null {
  if (!selected) return null;
  const project = projects.find(
    (entry) => entry.environmentId === selected.environmentId && entry.id === selected.id,
  );
  const reason = project && projectChoiceIneligibleReason(project, scratchRootFor, purpose);
  return project && reason ? { project, reason } : null;
}

/** {@link ineligibleSelectedMember} for a picker that lists each project once across machines. */
export function ineligibleSelectedGroup<G extends ProjectListGroup>(
  groups: ReadonlyArray<G>,
  selectedProjectKey: string | null | undefined,
  scratchRootFor: ScratchRootLookup,
  purpose: ProjectPickerPurpose = "work",
): IneligibleProjectSelection<G> | null {
  if (!selectedProjectKey) return null;
  const project = groups.find((group) => group.projectKey === selectedProjectKey);
  const reason = project && projectGroupIneligibleReason(project, scratchRootFor, purpose);
  return project && reason ? { project, reason } : null;
}

const INELIGIBLE_PROJECT_LABELS: Record<IneligibleProjectReason, string> = {
  scratch: "No project, not available here",
  archived: "Archived project, not available here",
  automated: "Automated project, not available here",
  "not-code": "Not a code project, not available here",
};

/** What a picker says beside a current selection it does not offer. */
export function ineligibleProjectLabel(reason: IneligibleProjectReason): string {
  return INELIGIBLE_PROJECT_LABELS[reason];
}

/** The workspace-settings patch that moves one project to or from the automated list. */
export function originWorkspacePatch(
  member: ProjectListMember,
  origin: ProjectOrigin,
): Pick<ProjectWorkspacePatch, "expectedRevision" | "origin"> {
  return { expectedRevision: member.workspaceSettings?.revision ?? 0, origin };
}

/** The members a move of the whole group to or from the automated list has to change. */
export function membersToMark<M extends ProjectListMember>(
  group: { readonly memberProjects: ReadonlyArray<M> },
  origin: ProjectOrigin,
  scratchRootFor: ScratchRootLookup,
): M[] {
  return group.memberProjects.filter(
    (member) =>
      !isScratchMember(member, scratchRootFor) && member.workspaceSettings?.origin !== origin,
  );
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

export interface NamedProjectGroup {
  readonly projectKey: string;
  readonly workspaceRoot?: string | undefined;
  readonly environmentPresence?: "local-only" | "remote-only" | "mixed" | undefined;
  readonly remoteEnvironmentLabels?: ReadonlyArray<string> | undefined;
}

/**
 * Tells apart projects listed under the same name. They are separate projects,
 * often one repository registered on two machines or in two folders, so each
 * gets its other machine's name, or else its folder's name.
 */
export function sameNameHints<G extends NamedProjectGroup>(
  groups: ReadonlyArray<G>,
  nameOf: (group: G) => string,
): Map<string, string> {
  const byName = new Map<string, G[]>();
  for (const group of groups) {
    const name = nameOf(group).toLocaleLowerCase();
    byName.set(name, [...(byName.get(name) ?? []), group]);
  }
  const hints = new Map<string, string>();
  for (const same of byName.values()) {
    if (same.length < 2) continue;
    for (const group of same) {
      const machines = group.remoteEnvironmentLabels ?? [];
      const folder = group.workspaceRoot?.split(/[\\/]/).findLast(Boolean);
      const hint =
        group.environmentPresence === "remote-only" && machines.length > 0
          ? machines.join(", ")
          : folder;
      // A folder named like the project tells nothing apart.
      if (hint && hint.toLocaleLowerCase() !== nameOf(group).toLocaleLowerCase())
        hints.set(group.projectKey, hint);
    }
  }
  return hints;
}
