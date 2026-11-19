/**
 * Why linking a copy to this project last failed, kept for the life of the window. Adding
 * a project to another machine ends by linking the copy; when that is refused, the done
 * screen says why, and so does the machine menu after the dialog is closed.
 *
 * @module linkRefusals
 */
import { useSyncExternalStore } from "react";

/** A sentence and its values, for `tx()`. Without `values`, text a machine sent: said as sent. */
export interface LinkReason {
  readonly text: string;
  readonly values?: Readonly<Record<string, string>>;
  /** The machine wrote the text: it is never translated here. */
  readonly verbatim?: boolean;
}

const refusals = new Map<string, LinkReason>();
const listeners = new Set<() => void>();
let version = 0;

const changed = () => {
  version += 1;
  for (const listener of listeners) listener();
};

/** `kept` and `joining` are `environmentId:projectId` of the two projects, in that order. */
const pairKey = (kept: string, joining: string) => `${kept}\n${joining}`;

export function rememberLinkRefusal(kept: string, joining: string, reason: LinkReason): void {
  refusals.set(pairKey(kept, joining), reason);
  changed();
}

/** Linked, in either direction: there is nothing left to explain. */
export function forgetLinkRefusal(a: string, b: string): void {
  const dropped = [refusals.delete(pairKey(a, b)), refusals.delete(pairKey(b, a))];
  if (dropped.some(Boolean)) changed();
}

export const linkRefusal = (kept: string, joining: string): LinkReason | undefined =>
  refusals.get(pairKey(kept, joining));

/** For tests: every reason kept, whichever pair it is for. */
export const linkRefusalsForTest = (): LinkReason[] => [...refusals.values()];

/** For tests: the memory is module state. */
export function resetLinkRefusalsForTest(): void {
  refusals.clear();
  changed();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Re-renders when a refusal is kept or forgotten; returns the reader. */
export function useLinkRefusals(): typeof linkRefusal {
  useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  );
  return linkRefusal;
}
