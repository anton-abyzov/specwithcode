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

/** A project on a machine, as the two sides of a link are named here. */
export const linkSide = (side: { readonly environmentId: string; readonly projectId: string }) =>
  `${side.environmentId}:${side.projectId}`;

/**
 * Where every try to link a copy ends: linked forgets the pair's reason, anything else keeps
 * the newest one. Returns the reason kept, or null once linked.
 */
export function recordLinkOutcome(
  kept: string,
  joining: string,
  outcome:
    | { readonly status: "linked" }
    | { readonly status: "review"; readonly reason: string; readonly words?: LinkReason },
): LinkReason | null {
  if (outcome.status === "linked") {
    forgetLinkRefusal(kept, joining);
    return null;
  }
  // Without a sentence of this window's own, the reason is what a machine said, as said.
  const reason = outcome.words ?? { text: outcome.reason, verbatim: true };
  rememberLinkRefusal(kept, joining, reason);
  return reason;
}

/** The same for a try that threw: what the failure said is kept as said. */
export const recordLinkFailure = (kept: string, joining: string, said: string): LinkReason =>
  recordLinkOutcome(kept, joining, { status: "review", reason: said })!;

/** A reason in the reader's language; text a machine sent stays as sent. */
export const sayLinkReason = (
  reason: LinkReason,
  tx: (text: string, values?: Readonly<Record<string, string>>) => string,
): string => (reason.verbatim ? reason.text : tx(reason.text, reason.values));

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
