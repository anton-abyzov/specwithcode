import {
  projectChoiceIneligibleReason,
  type PickerProject,
  type ScratchRootLookup,
} from "@specweave-studio/client-runtime/state/project-picker";
import type { EnvironmentId } from "@specweave-studio/contracts";

export function toggleSettingsEnvironment(
  selected: ReadonlySet<EnvironmentId> | null,
  available: readonly { readonly environmentId: EnvironmentId }[],
  toggledId: EnvironmentId,
): ReadonlySet<EnvironmentId> | null {
  const ids = available.map((entry) => entry.environmentId);
  const next = new Set(ids.filter((id) => selected === null || selected.has(id)));
  if (ids.includes(toggledId)) {
    if (next.has(toggledId)) next.delete(toggledId);
    else next.add(toggledId);
  }
  return ids.every((id) => next.has(id)) ? null : next;
}

/** Restrict the selected environments to the selected project group, if any. */
export function settingsTargetsForProject<T extends { readonly environmentId: EnvironmentId }>(
  targets: readonly T[],
  group:
    | {
        readonly members: readonly {
          readonly project: { readonly environmentId: EnvironmentId };
        }[];
      }
    | null
    | undefined,
): readonly T[] {
  if (group === null) return targets;
  return targets.filter((target) =>
    group?.members.some((member) => member.project.environmentId === target.environmentId),
  );
}

/** Active choices on selected machines, plus an excluded current scope for context. */
export function settingsProjectChoices<
  G extends {
    readonly key: string;
    readonly members: readonly { readonly project: PickerProject }[];
  },
>(
  groups: readonly G[],
  environmentIds: ReadonlySet<EnvironmentId>,
  scratchRootFor: ScratchRootLookup,
  selectedKey: string | null,
): { choices: G[]; unavailable: ReadonlySet<string> } {
  const unavailable = new Set<string>();
  const choices = groups.filter((group) => {
    const eligible = group.members.some(
      ({ project }) =>
        environmentIds.has(project.environmentId) &&
        projectChoiceIneligibleReason(project, scratchRootFor) === null,
    );
    if (!eligible) unavailable.add(group.key);
    return eligible || group.key === selectedKey;
  });
  return { choices, unavailable };
}
