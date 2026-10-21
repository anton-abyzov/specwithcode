import type {
  EnvironmentId,
  HandoffMachineRun,
  HandoffModeSnapshot,
} from "@specweave-studio/contracts";

import type { HandoffModeOutcome } from "./handoffMode";

export interface HandoffSleepDeps {
  readonly snapshot: (
    environmentId: EnvironmentId,
  ) => Promise<HandoffModeOutcome<HandoffModeSnapshot>>;
  readonly handOffMachine: (
    environmentId: EnvironmentId,
    destinationEnvironmentId: EnvironmentId,
  ) => Promise<HandoffModeOutcome<HandoffMachineRun>>;
}

export type HandoffSleepOutcome =
  | { readonly kind: "off" }
  | { readonly kind: "failed"; readonly error: string }
  | { readonly kind: "handed-off"; readonly run: HandoffMachineRun };

/**
 * The desktop's 'suspend' notice: when "When this Mac sleeps, hand off running
 * threads to <machine>" is set, move this machine's running handoff-mode
 * threads there with reason "sleep". Best effort; the Mac may sleep first.
 */
export async function handleHandoffSleep(
  environmentId: EnvironmentId,
  deps: HandoffSleepDeps,
): Promise<HandoffSleepOutcome> {
  const snapshot = await deps.snapshot(environmentId);
  if (!snapshot.ok) return { kind: "failed", error: snapshot.error };
  const target = snapshot.value.config.sleepTarget;
  if (target === null || target === environmentId) return { kind: "off" };
  const run = await deps.handOffMachine(environmentId, target);
  return run.ok ? { kind: "handed-off", run: run.value } : { kind: "failed", error: run.error };
}
