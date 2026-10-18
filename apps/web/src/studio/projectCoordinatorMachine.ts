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
  /** The saved checkout's machine cannot be reached, so a reachable checkout stands in. */
  readonly savedMachineOffline: boolean;
}

/**
 * The saved checkout, then another checkout on the saved machine (the project
 * was re-added there), then this computer's checkout, then the first listed.
 * A saved machine that is not listed now never moves the saved choice; it is
 * reported so the page can say whose coordinator it is showing instead.
 *
 * A saved machine that is listed but unreachable would leave the whole page
 * read-only, so a checkout on a reachable machine stands in until it returns.
 * The saved choice itself is not changed.
 */
export function resolveCoordinatorMachine<T extends CoordinatorMachineMember>(input: {
  readonly members: readonly T[];
  readonly saved: string | undefined;
  readonly primaryEnvironmentId: string | null;
  /** Machines known to be unreachable now; a machine still connecting is not one. */
  readonly unreachable?: ReadonlySet<string>;
}): CoordinatorMachineChoice<T> {
  const { members, saved, primaryEnvironmentId } = input;
  const unreachable = input.unreachable ?? new Set<string>();
  const reachable = members.filter((member) => !unreachable.has(member.environmentId));
  const preferred = (candidates: readonly T[]) =>
    (primaryEnvironmentId !== null
      ? candidates.find((member) => member.environmentId === primaryEnvironmentId)
      : undefined) ?? candidates[0];
  if (saved) {
    const separator = saved.indexOf(":");
    const savedEnvironmentId = separator > 0 ? saved.slice(0, separator) : saved;
    const choice =
      members.find((member) => coordinatorMachineKey(member) === saved) ??
      members.find((member) => member.environmentId === savedEnvironmentId);
    if (choice) {
      const standIn = unreachable.has(choice.environmentId) ? preferred(reachable) : undefined;
      return standIn
        ? { member: standIn, savedMachineMissing: false, savedMachineOffline: true }
        : { member: choice, savedMachineMissing: false, savedMachineOffline: false };
    }
  }
  return {
    member: preferred(reachable) ?? preferred(members),
    savedMachineMissing: Boolean(saved) && members.length > 0,
    savedMachineOffline: false,
  };
}
