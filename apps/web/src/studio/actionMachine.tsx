import { createContext, use, useMemo, type ReactNode } from "react";

import { renderRich } from "../i18n/rich";
import { useTx } from "../i18n";
import { usePrimaryEnvironmentId } from "../state/environments";
import { machineColorProps, useMachineIdentity, type MachineIdentity } from "./machineIdentity";

/**
 * The machine a card, button or alert acts on, when it is not the window's own
 * machine (1427 AC-07). Null on the window's own machine, where nothing names it.
 */
export type ActionMachine = Pick<MachineIdentity, "name" | "color">;

/** The machine a thread runs on: where it was handed off to, else where it lives. */
export function threadActionMachineId(thread: {
  readonly executionMachineId?: string | null | undefined;
  readonly environmentId: string;
}): string {
  return thread.executionMachineId ?? thread.environmentId;
}

/** Null when the machine is the window's own, or either is not known. */
export function actionMachineFor(
  identity: (ActionMachine & { readonly environmentId: string }) | null | undefined,
  windowEnvironmentId: string | null | undefined,
): ActionMachine | null {
  if (!identity || !windowEnvironmentId || identity.environmentId === windowEnvironmentId)
    return null;
  return { name: identity.name, color: identity.color };
}

/** The thread's machine for the cards inside a thread view; null on the window's own. */
export const ActionMachineContext = createContext<ActionMachine | null>(null);

export function useActionMachine(): ActionMachine | null {
  return use(ActionMachineContext);
}

/** A machine by its id, as the cards name it: null when it is the window's own. */
export function useActionMachineFor(
  machineId: string | null | undefined,
  fallbackLabel?: string | null,
): ActionMachine | null {
  const identity = useMachineIdentity(machineId, fallbackLabel);
  const windowEnvironmentId = usePrimaryEnvironmentId();
  return useMemo(
    () => actionMachineFor(identity, windowEnvironmentId),
    [identity, windowEnvironmentId],
  );
}

/** Every phrase the action surfaces add, so each catalog is checked for all of them. */
export const ACTION_MACHINE_PHRASES = [
  "on {machine}",
  "Always allow on {machine}",
  "Sign in again on {machine}",
  "Continue on {machine}",
] as const;

/** The machine's name in its colour, as a thread row shows it. */
export function ActionMachineName({
  machine,
  plain = false,
}: {
  readonly machine: ActionMachine;
  /** Inside a button already filled with the machine's colour, the name keeps the button's text colour. */
  readonly plain?: boolean;
}) {
  return (
    <span
      {...machineColorProps(machine)}
      data-action-machine
      className={plain ? "font-semibold" : "machine-mark font-semibold"}
    >
      {machine.name}
    </span>
  );
}

/** "on M5" in the machine's colour, or nothing on the window's own machine. */
export function OnActionMachine({
  machine,
}: {
  readonly machine: ActionMachine | null | undefined;
}): ReactNode {
  const tx = useTx();
  if (!machine) return null;
  return (
    <span className="shrink-0 whitespace-nowrap" data-action-machine-tag>
      {renderRich(tx("on {machine}"), { machine: <ActionMachineName machine={machine} /> })}
    </span>
  );
}

/** A suffix for alerts in plain text: "Sign in to continue on M5". */
export function onMachineText(text: string, machineName: string | null | undefined): string {
  return machineName ? `${text} on ${machineName}` : text;
}
