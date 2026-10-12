/**
 * Which machine runs a project's coordinator. A project added on several
 * machines is one logical project with a checkout per machine, and each
 * checkout's own server runs its coordinator with that machine's providers,
 * sign-ins and subscriptions. The person picks the checkout; the choice is
 * saved per logical project so it survives a reload and every window agrees.
 *
 * @module projectCoordinatorMachine
 */

export interface CoordinatorMachineMember {
  readonly environmentId: string;
  readonly id: string;
}

/** The saved form of a checkout: `environmentId:projectId`. */
export function coordinatorMachineKey(member: CoordinatorMachineMember): string {
  return `${member.environmentId}:${member.id}`;
}

export interface CoordinatorMachineChoice<T extends CoordinatorMachineMember> {
  readonly member: T | undefined;
  /** A machine was saved for this project but none of its checkouts is listed now. */
  readonly savedMachineMissing: boolean;
}

/**
 * The saved checkout, then another checkout on the saved machine (the project
 * was re-added there), then this computer's checkout, then the first listed.
 * A saved machine that is not listed now never moves the saved choice; it is
 * reported so the page can say whose coordinator it is showing instead.
 */
export function resolveCoordinatorMachine<T extends CoordinatorMachineMember>(input: {
  readonly members: readonly T[];
  readonly saved: string | undefined;
  readonly primaryEnvironmentId: string | null;
}): CoordinatorMachineChoice<T> {
  const { members, saved, primaryEnvironmentId } = input;
  if (saved) {
    const exact = members.find((member) => coordinatorMachineKey(member) === saved);
    if (exact) return { member: exact, savedMachineMissing: false };
    const separator = saved.indexOf(":");
    const savedEnvironmentId = separator > 0 ? saved.slice(0, separator) : saved;
    const sameMachine = members.find((member) => member.environmentId === savedEnvironmentId);
    if (sameMachine) return { member: sameMachine, savedMachineMissing: false };
  }
  const fallback =
    (primaryEnvironmentId !== null
      ? members.find((member) => member.environmentId === primaryEnvironmentId)
      : undefined) ?? members[0];
  return { member: fallback, savedMachineMissing: Boolean(saved) && members.length > 0 };
}
