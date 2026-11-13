/**
 * Machines of this SpecWithCode Connect account that this app has not saved.
 * The move dialog lists saved machines only, so a machine that joined the
 * account later and holds no copy of any project here would never appear in
 * it. These are offered under the list with one click to connect.
 *
 * @module handoffAccountMachines
 */

export interface HandoffAccountMachine {
  readonly environmentId: string;
  readonly label: string;
  /** False when SpecWithCode Connect says the machine is not answering now. */
  readonly answering: boolean;
}

export function handoffAccountMachines(input: {
  readonly discovered: Iterable<{
    readonly environment: { readonly environmentId: string; readonly label: string };
    readonly availability: string;
  }>;
  /** Every machine this app saved, connected or not. */
  readonly savedEnvironmentIds: ReadonlySet<string>;
  /** The machine the project is on. */
  readonly sourceEnvironmentId: string;
  readonly name?: (environmentId: string, label: string) => string;
}): HandoffAccountMachine[] {
  const machines: HandoffAccountMachine[] = [];
  for (const { environment, availability } of input.discovered) {
    const id = environment.environmentId;
    if (id === input.sourceEnvironmentId || input.savedEnvironmentIds.has(id)) continue;
    machines.push({
      environmentId: id,
      label: input.name?.(id, environment.label) ?? environment.label,
      answering: availability !== "offline" && availability !== "error",
    });
  }
  return machines.toSorted((a, b) => a.label.localeCompare(b.label));
}

/**
 * Machines a server's fleet lists that this app neither saved nor can offer
 * through the account: named with what is missing, so the list never looks
 * complete while one of the user's machines is absent from it.
 */
export function handoffFleetOnlyMachines(input: {
  readonly fleet: ReadonlyArray<{ readonly environmentId: string; readonly label: string }>;
  readonly savedEnvironmentIds: ReadonlySet<string>;
  readonly sourceEnvironmentId: string;
  /** Account machines already offered with a Connect button. */
  readonly offeredEnvironmentIds: ReadonlySet<string>;
  readonly name?: (environmentId: string, label: string) => string;
}): Array<{ readonly environmentId: string; readonly label: string }> {
  const seen = new Set<string>();
  return input.fleet
    .filter((machine) => {
      const id = machine.environmentId;
      if (
        id === input.sourceEnvironmentId ||
        input.savedEnvironmentIds.has(id) ||
        input.offeredEnvironmentIds.has(id) ||
        seen.has(id)
      )
        return false;
      seen.add(id);
      return true;
    })
    .map((machine) => ({
      environmentId: machine.environmentId,
      label: input.name?.(machine.environmentId, machine.label) ?? machine.label,
    }));
}
