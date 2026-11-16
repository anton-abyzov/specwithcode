/**
 * Whether a thread's options menu can carry the Advisor row. Kept apart from
 * the row itself so the composer can ask without loading the menu, which is
 * lazy for the reason TraitsPicker gives.
 */
import type { ScopedThreadRef } from "@specweave-studio/contracts";

import { useThreadShell } from "../../state/entities";
import { useEnvironment } from "../../state/environments";

/** The row shows only where the server understands it, and never on an advisor itself. */
export function threadAdvisorMenuVisible(input: {
  readonly capability: boolean;
  readonly purpose: string | null | undefined;
}): boolean {
  return input.capability && input.purpose !== "advisor";
}

/**
 * True for a saved thread on a machine that advertises "advisor", unless the
 * thread is an advisor child. A draft has no thread yet, so it passes null.
 */
export function useThreadAdvisorRowAvailable(threadRef: ScopedThreadRef | null): boolean {
  const shell = useThreadShell(threadRef);
  const environment = useEnvironment(threadRef?.environmentId ?? null);
  const config = environment?.serverConfig;
  if (threadRef === null || shell === null || config?.settings == null) return false;
  return threadAdvisorMenuVisible({
    capability: config.environment?.capabilities.advisor === true,
    purpose: shell.source.purpose,
  });
}
