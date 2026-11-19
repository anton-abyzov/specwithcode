/**
 * The machines this device waits on for a typed code (1327), and which of those
 * codes the owner closed the floating card over. Closing only hides the card:
 * the join stays pending, Settings > Machines still shows the code, and the
 * sidebar's "Show code" brings the card back. A new code shows the card again.
 */
import type { EnvironmentId } from "@specweave-studio/contracts";
import { useSyncExternalStore } from "react";

import { useEnvironments } from "../../state/environments";

/** One machine this device waits on, and the code to type there. */
export interface WaitingCode {
  readonly id: EnvironmentId;
  readonly machine: string;
  readonly code: string;
}

// Replaced, never changed in place, so a render that reads it sees each change.
let hidden: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
const keyOf = (entry: Pick<WaitingCode, "id" | "code">) => `${entry.id}\u0000${entry.code}`;
const replace = (next: ReadonlySet<string>) => {
  hidden = next;
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Close the floating card over these codes; the join itself stays pending. */
export function hideWaitingCodes(entries: ReadonlyArray<Pick<WaitingCode, "id" | "code">>) {
  if (entries.length === 0) return;
  replace(new Set([...hidden, ...entries.map(keyOf)]));
}

/** Bring the floating card back for every waiting code. */
export function showWaitingCodes() {
  if (hidden.size === 0) return;
  replace(new Set());
}

/** Whether the owner closed the card over a code; re-renders when that changes. */
export function useWaitingCodeHidden(): (entry: Pick<WaitingCode, "id" | "code">) => boolean {
  const current = useSyncExternalStore(subscribe, () => hidden);
  return (entry) => current.has(keyOf(entry));
}

/** Every machine this device waits on, whether or not its card is hidden. */
export function useWaitingCodes(): ReadonlyArray<WaitingCode> {
  const { environments } = useEnvironments();
  return environments.flatMap((environment) =>
    environment.connection.deviceApprovalCode !== undefined
      ? [
          {
            id: environment.environmentId,
            machine: environment.label,
            code: environment.connection.deviceApprovalCode,
          },
        ]
      : [],
  );
}

/** Test hook: forget every hidden code. */
export function resetWaitingCodesForTest() {
  hidden = new Set();
}
