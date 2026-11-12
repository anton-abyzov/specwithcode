/**
 * Whether an update may pause running work on a machine.
 *
 * `pauseWorkForUpdates` is the owner's choice, off by default. A pause is only
 * safe while interrupted turns continue after the restart, so it also needs
 * `continueThreadsAfterServerUpdate`: with that off, an update waits until the
 * machine is quiet, whatever the first setting says.
 *
 * One rule for every automatic path: the update agent's own pause, a forced
 * fleet request, a rollout's drain and a Linux worker's escalation. A person's
 * own Update now is never gated by it.
 */
export interface UpdatePauseSettings {
  readonly pauseWorkForUpdates?: boolean | undefined;
  readonly continueThreadsAfterServerUpdate?: boolean | undefined;
}

export function updatesMayPauseWork(settings: UpdatePauseSettings | null | undefined): boolean {
  return (
    settings?.pauseWorkForUpdates === true && settings.continueThreadsAfterServerUpdate !== false
  );
}

/** The setting as people see it: Settings > General > Updates, and each machine's card. */
export const UPDATE_PAUSE_SETTING_NAME = "Pause running work for updates";

/** Why a busy machine was left on its version: the owner's choice, never a failure. */
export function updatePauseOffReason(machine: string): string {
  return `${machine} is busy and "${UPDATE_PAUSE_SETTING_NAME}" is off there, so it is left on its version until it is quiet. That is its owner's setting, not a failure: report its version as a fact, not a blocker.`;
}
