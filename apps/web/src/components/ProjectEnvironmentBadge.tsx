import type { EnvironmentId, EnvironmentMachineKind } from "@specweave-studio/contracts";

import type { SidebarProjectSnapshot } from "~/sidebarProjectGrouping";
import { MachineNameTag } from "./MachineNameTag";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/**
 * The machine a project picker row's group also lives on, by name, for a group with a
 * member on another environment; every name is in the tooltip. Projects that only
 * live on this device render nothing, the rule thread rows use for their
 * machine icon. Callers
 * render it only while the catalog spans environments (see
 * projectGroupsSpanEnvironments), so single-machine users see no change.
 */
export function ProjectEnvironmentBadge(props: {
  readonly group: Pick<SidebarProjectSnapshot, "memberProjects">;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly machineByEnvironmentId: ReadonlyMap<EnvironmentId, EnvironmentMachineKind>;
}) {
  // Member order follows registration order and can differ between sessions,
  // so sort by label to keep the icon and tooltip stable.
  const remoteMembers = props.group.memberProjects
    .filter((member) => member.environmentId !== props.primaryEnvironmentId)
    .map((member) => ({ ...member, environmentLabel: member.environmentLabel ?? "Remote" }))
    .sort((a, b) => a.environmentLabel.localeCompare(b.environmentLabel));
  const first = remoteMembers[0];
  if (!first) return null;
  const labels = remoteMembers
    .map((member) => member.environmentLabel)
    .filter((label, index, all) => all.indexOf(label) === index)
    .join(", ");
  const alsoHere = remoteMembers.length < props.group.memberProjects.length;
  const description = `${alsoHere ? "Also on" : "On"} ${labels}`;
  // The first machine's name shows; the rest are in the tooltip as "+1".
  const more = labels.split(", ").length - 1;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={description}
            className="ml-auto inline-flex min-w-0 shrink-0 items-center gap-1 text-xs text-muted-foreground"
          />
        }
      >
        <MachineNameTag
          label={first.environmentLabel}
          kind={props.machineByEnvironmentId.get(first.environmentId) ?? "server"}
          withIcon
        />
        {more > 0 ? <span className="shrink-0">+{more}</span> : null}
      </TooltipTrigger>
      <TooltipPopup side="top">{description}</TooltipPopup>
    </Tooltip>
  );
}
