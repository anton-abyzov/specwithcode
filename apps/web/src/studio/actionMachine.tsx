import { createContext, use, useMemo, type ReactNode } from "react";

import { renderRich } from "../i18n/rich";
import { useTx } from "../i18n";
import type { EnvironmentId } from "@specweave-studio/contracts";

import { useEnvironment, usePrimaryEnvironmentId } from "../state/environments";
import { machineColorProps, useMachineIdentities, type MachineIdentity } from "./machineIdentity";

/**
 * The machine a card, button or alert acts on, when it is not the window's own
 * machine (1427 AC-07). Null on the window's own machine, where nothing names it.
 */
export type ActionMachine = Pick<MachineIdentity, "name" | "color">;

/**
 * The machine a thread runs on: where it was handed off to, else where it lives.
 * Alerts name it; a control names its dispatch environment instead (actionMachineAt).
 */
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

/**
 * The machine a control names: the environment its callback dispatches to (an
 * answer's RPC destination, the provider setup it opens), never the thread's
 * execution machine, which can differ after a hand off. The name falls back
 * only to that environment's own label. Null on the window's own machine.
 */
export function actionMachineAt(input: {
  readonly dispatchEnvironmentId: string | null | undefined;
  readonly windowEnvironmentId: string | null | undefined;
  readonly identityOf: (
    environmentId: string,
    fallbackLabel?: string | null,
  ) => ActionMachine & { readonly environmentId: string };
  readonly labelOf: (environmentId: string) => string | null | undefined;
}): ActionMachine | null {
  const id = input.dispatchEnvironmentId;
  if (!id) return null;
  return actionMachineFor(input.identityOf(id, input.labelOf(id)), input.windowEnvironmentId);
}

/** {@link actionMachineAt} for one dispatch environment, as a hook. */
export function useActionMachineFor(
  dispatchEnvironmentId: EnvironmentId | null | undefined,
): ActionMachine | null {
  const environment = useEnvironment(dispatchEnvironmentId ?? null);
  const identityOf = useMachineIdentities();
  const windowEnvironmentId = usePrimaryEnvironmentId();
  const label = environment?.label;
  return useMemo(
    () =>
      actionMachineAt({
        dispatchEnvironmentId,
        windowEnvironmentId,
        identityOf,
        // The environment looked up is the dispatched one, so its label is that machine's.
        labelOf: (id) => (id === dispatchEnvironmentId ? label : undefined),
      }),
    [dispatchEnvironmentId, windowEnvironmentId, identityOf, label],
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
