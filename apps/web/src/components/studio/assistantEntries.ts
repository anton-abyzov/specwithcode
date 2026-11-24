import { isExtraAssistant } from "../../studio/personalAssistant";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";

type AssistantGroup = Pick<SidebarProjectSnapshot, "memberProjects">;
type AssistantMember = AssistantGroup["memberProjects"][number];

/** Every personal assistant the groups hold, archived ones too: an earlier one is still its machine's own. */
export function assistantMembersOf(groups: readonly AssistantGroup[]): AssistantMember[] {
  return groups.flatMap((group) =>
    group.memberProjects.filter((member) => member.workspaceSettings?.kind === "personal"),
  );
}

function personalMembersOf(group: AssistantGroup): AssistantMember[] {
  return group.memberProjects.filter((member) => member.workspaceSettings?.kind === "personal");
}

function assistantOf(group: AssistantGroup) {
  return personalMembersOf(group)[0];
}

/** Whether a personal assistant member belongs to a multi-machine linked personal assistant. */
export function isLinkedAssistantMember(member: AssistantMember): boolean {
  return linkedIdOf(member) !== null;
}

/** The id of the multi-machine link this seat belongs to; a one-member identity is not a link. */
function linkedIdOf(member: AssistantMember): string | null {
  const logical = member.workspaceSettings?.logicalProject;
  return logical != null && logical.members.length > 1 ? logical.id : null;
}

/** Whether a sidebar group represents linked personal assistant seats across machines. */
export function isLinkedAssistantGroup(group: AssistantGroup): boolean {
  const members = personalMembersOf(group);
  return members.length > 1 || members.some(isLinkedAssistantMember);
}

/**
 * Unlinked personal assistants keep distinct icons so each machine's assistant
 * stays visually distinguishable; linked seats share one icon.
 */
export function unlinkedAssistantMembers(members: readonly AssistantMember[]): AssistantMember[] {
  return members.filter((member) => !isLinkedAssistantMember(member));
}

/**
 * Collapse personal assistant groups that share a logicalProject.id into one
 * sidebar row while leaving unlinked assistants as separate rows.
 */
export function collapseLinkedAssistantGroups<G extends AssistantGroup>(groups: readonly G[]): G[] {
  const byLogicalId = new Map<string, G>();
  const result: G[] = [];
  for (const group of groups) {
    const personal = personalMembersOf(group);
    const logicalId = personal.map(linkedIdOf).find((id): id is string => id !== null);
    if (logicalId === undefined) {
      result.push(group);
      continue;
    }
    const existing = byLogicalId.get(logicalId);
    if (existing === undefined) {
      const cloned = { ...group, memberProjects: [...group.memberProjects] };
      byLogicalId.set(logicalId, cloned);
      result.push(cloned);
      continue;
    }
    const existingKeys = new Set(
      existing.memberProjects.map((member) => `${member.environmentId}:${member.id}`),
    );
    for (const member of group.memberProjects) {
      const key = `${member.environmentId}:${member.id}`;
      if (!existingKeys.has(key)) {
        existingKeys.add(key);
        (existing.memberProjects as AssistantMember[]).push(member);
      }
    }
  }
  return result;
}

/**
 * The assistants the sidebar's Percy block lists: in use, automated and archived ones
 * alike, since an assistant is never listed under Automated or Archived.
 */
export function assistantGroupsOf<G extends AssistantGroup>(partition: {
  readonly listed: readonly G[];
  readonly automated: readonly G[];
  readonly archived: readonly G[];
}): G[] {
  return collapseLinkedAssistantGroups(
    [...partition.listed, ...partition.automated, ...partition.archived].filter(
      (group) => assistantOf(group) !== undefined,
    ),
  );
}

/** This machine's assistant leads, then other machines' own, then duplicates from before one per machine. */
export function sortAssistantGroups<G extends AssistantGroup>(
  groups: readonly G[],
  members: readonly AssistantMember[],
  primaryEnvironmentId: string | null,
): G[] {
  const rank = (group: G) => {
    const personal = personalMembersOf(group);
    if (personal.length === 0) return 3;
    const here = personal.some((member) => member.environmentId === primaryEnvironmentId) ? 0 : 1;
    const extra = personal.every((member) => isExtraAssistant(member, members));
    return extra ? here + 2 : here;
  };
  return groups.toSorted((left, right) => rank(left) - rank(right));
}

/** Ordered machine badge labels for every personal seat in a group. */
export function assistantMachineBadges(
  group: AssistantGroup,
  machineLabel: (environmentId: string) => string | null | undefined,
): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const member of personalMembersOf(group)) {
    if (seen.has(member.environmentId)) continue;
    seen.add(member.environmentId);
    const label = machineLabel(member.environmentId);
    if (label) labels.push(label);
  }
  return labels;
}

/** The machine(s) an assistant lives on, once there is more than one, and "extra" for a duplicate. */
export function assistantGroupHint(
  group: AssistantGroup,
  members: readonly AssistantMember[],
  machineLabel: (environmentId: string) => string | null | undefined,
  machineCount: number,
): string | undefined {
  const personal = personalMembersOf(group);
  if (personal.length === 0) return undefined;
  if (isLinkedAssistantGroup(group)) {
    const badges = assistantMachineBadges(group, machineLabel);
    return badges.length > 0 ? badges.join(" · ") : undefined;
  }
  const member = personal[0]!;
  const machine = machineCount > 1 ? (machineLabel(member.environmentId) ?? null) : null;
  const extra = isExtraAssistant(member, members) ? "extra" : null;
  return [machine, extra].filter(Boolean).join(" · ") || undefined;
}
