/**
 * Which missing machine basic to install, and where: set by a toast or a
 * settings row, read by the install dialog. Kept free of the RPC runtime so
 * those callers stay light.
 */
import type { EnvironmentId, MachineReadinessToolId } from "@specweave-studio/contracts";
import { create } from "zustand";

export interface MachineToolInstallRequest {
  readonly environmentId: EnvironmentId;
  readonly tool: MachineReadinessToolId;
  /** The machine's name, when it is not this device. */
  readonly machineLabel: string | null;
  /** What needs it, for the dialog's line; SpecWeave setup when absent. */
  readonly neededBy?: "specweave" | "project" | "copilot" | undefined;
}

export const useMachineToolInstallRequest = create<{
  request: MachineToolInstallRequest | null;
}>(() => ({ request: null }));

/** Opens the install dialog for one tool on one machine, from a toast or a settings row. */
export function requestMachineToolInstall(request: MachineToolInstallRequest) {
  useMachineToolInstallRequest.setState({ request });
}

export function closeMachineToolInstall() {
  useMachineToolInstallRequest.setState({ request: null });
}

/** The open request outside React, for tests. */
export function readMachineToolInstallRequest(): MachineToolInstallRequest | null {
  return useMachineToolInstallRequest.getState().request;
}
