export function projectGroupTitleNeedsUpdate(
  memberTitles: ReadonlyArray<string>,
  nextTitle: string,
  wasEdited: boolean,
): boolean {
  return wasEdited && memberTitles.some((title) => title !== nextTitle);
}

interface MissingCheckoutMember {
  readonly environmentId: string;
  readonly environmentLabel: string | null;
  readonly physicalProjectKey: string;
}

interface MissingCheckoutEnvironment {
  readonly environmentId: string;
  readonly label: string;
  readonly connected: boolean;
}

export interface MissingCheckoutChoice {
  readonly key: string;
  readonly label: string;
  readonly search: { project: string; machine?: string };
}

/**
 * What the Project page says when the picked environment (or checkout) has no
 * member of the project: why, and where its settings can be changed instead.
 */
export function describeMissingCheckout(input: {
  readonly projectKey: string;
  readonly projectName: string;
  readonly members: readonly MissingCheckoutMember[];
  readonly environmentId: string | null;
  readonly checkoutKey: string | null;
  readonly environments: readonly MissingCheckoutEnvironment[];
}): { title: string; detail: string; choices: MissingCheckoutChoice[] } {
  const { projectKey, projectName, members, environmentId, checkoutKey, environments } = input;
  const environment = environments.find((entry) => entry.environmentId === environmentId);
  const environmentLabel = environment?.label ?? "this environment";
  const memberEnvironmentIds = [...new Set(members.map((member) => member.environmentId))];
  const choices: MissingCheckoutChoice[] = memberEnvironmentIds.map((id) => {
    const label =
      environments.find((entry) => entry.environmentId === id)?.label ??
      members.find((member) => member.environmentId === id)?.environmentLabel ??
      "Environment";
    return { key: id, label: `Open on ${label}`, search: { project: projectKey, machine: id } };
  });
  if (memberEnvironmentIds.length > 1) {
    choices.unshift({ key: "all", label: "All environments", search: { project: projectKey } });
  }
  const elsewhere =
    memberEnvironmentIds.length === 0
      ? "It has no checkout on any connected environment."
      : `Its settings are saved with each checkout, so change them on ${
          memberEnvironmentIds.length === 1 ? "the machine" : "a machine"
        } that has it.`;

  if (checkoutKey !== null && members.some((member) => member.environmentId === environmentId)) {
    return {
      title: `That checkout of ${projectName} is no longer listed`,
      detail: `It may have been removed or re-added. ${elsewhere}`,
      choices,
    };
  }
  if (environment && !environment.connected) {
    return {
      title: `${environmentLabel} is offline`,
      detail: `${projectName}'s checkout there can't be read until it reconnects. ${elsewhere}`,
      choices,
    };
  }
  return {
    title: `${projectName} isn't checked out on ${environmentLabel}`,
    detail: `Add the project on ${environmentLabel} to give it settings there. ${elsewhere}`,
    choices,
  };
}
