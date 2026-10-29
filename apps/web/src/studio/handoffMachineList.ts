import { useEffect, useMemo, useState } from "react";

/** How long the move dialog waits for machines on their first connection before listing them as they are. */
export const MACHINE_SETTLE_MS = 8000;

/** A machine on its first connection attempt: its status is not known yet. */
export const machineConnecting = (phase: string | undefined): boolean => phase === "connecting";

/**
 * True while the list of other machines is still being read: the catalog has not answered,
 * or a machine is on its first connection attempt. Ready machines must not show as
 * "Connect first" during that read.
 */
export function machinesSettling(input: {
  readonly catalogReady: boolean;
  readonly phases: ReadonlyArray<string | undefined>;
}): boolean {
  return !input.catalogReady || input.phases.some(machineConnecting);
}

/** Why a machine cannot take the project now, in a few plain words; null when it can. */
export function machineUnavailable(phase: string | undefined, permitted: boolean): string | null {
  if (phase === "connected") return permitted ? null : "Permission required";
  if (phase === "connecting" || phase === "reconnecting") return "Connecting…";
  return "Connect first";
}

/**
 * Whether the dialog shows its quiet "looking for machines" row: while it is open and the
 * list is settling, for at most `ms` after it opened.
 */
export function useMachinesSettling(
  open: boolean,
  settling: boolean,
  ms = MACHINE_SETTLE_MS,
): boolean {
  // One token per opening: its deadline never carries over to the next opening.
  const opening = useMemo(() => (open ? {} : null), [open]);
  const [expired, setExpired] = useState<object | null>(null);
  useEffect(() => {
    if (!opening) return;
    const timer = setTimeout(() => setExpired(opening), ms);
    return () => clearTimeout(timer);
  }, [opening, ms]);
  return settling && opening !== null && expired !== opening;
}

/** Why "Move project" is off, said where the person can see it. */
export function moveBlockedReason(input: {
  readonly connected: boolean;
  readonly coordinator: boolean;
  readonly permitted: boolean;
}): string | null {
  if (!input.connected) return "Connect this machine to hand off this project.";
  if (!input.coordinator) return "Send this project its first message, then you can hand it off.";
  if (!input.permitted) return "This connection needs permission to hand off projects.";
  return null;
}
