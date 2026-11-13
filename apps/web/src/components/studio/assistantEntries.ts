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

function assistantOf(group: AssistantGroup) {
  return group.memberProjects.find((member) => member.workspaceSettings?.kind === "personal");
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
  return [...partition.listed, ...partition.automated, ...partition.archived].filter(
    (group) => assistantOf(group) !== undefined,
  );
}

/** This machine's assistant leads, then other machines' own, then duplicates from before one per machine. */
export function sortAssistantGroups<G extends AssistantGroup>(
  groups: readonly G[],
  members: readonly AssistantMember[],
  primaryEnvironmentId: string | null,
): G[] {
  const rank = (group: G) => {
    const member = assistantOf(group);
    if (member === undefined) return 3;
    const here = member.environmentId === primaryEnvironmentId ? 0 : 1;
    return isExtraAssistant(member, members) ? here + 2 : here;
  };
  return groups.toSorted((left, right) => rank(left) - rank(right));
}

/** The machine an assistant lives on, once there is more than one, and "extra" for a duplicate. */
export function assistantGroupHint(
  group: AssistantGroup,
  members: readonly AssistantMember[],
  machineLabel: (environmentId: string) => string | null | undefined,
  machineCount: number,
): string | undefined {
  const member = assistantOf(group);
  if (member === undefined) return undefined;
  const machine = machineCount > 1 ? (machineLabel(member.environmentId) ?? null) : null;
  const extra = isExtraAssistant(member, members) ? "extra" : null;
  return [machine, extra].filter(Boolean).join(" · ") || undefined;
}
