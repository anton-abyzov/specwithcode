/**
 * Whether a thread's options menu can carry the Advisor or Adversarial review
 * row. Kept apart from the rows themselves so the composer can ask without
 * loading the menu, which is lazy for the reason TraitsPicker gives.
 */
import type { ScopedThreadRef } from "@specweave-studio/contracts";
import { isAdversarialReviewThreadTitle } from "@specweave-studio/shared/adversarialReview";

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
 * The review row shows only where the server understands it, never on an
 * advisor, and never on a review thread, which does not review itself.
 */
export function threadReviewMenuVisible(input: {
  readonly capability: boolean;
  readonly purpose: string | null | undefined;
  readonly title: string;
}): boolean {
  return (
    input.capability && input.purpose !== "advisor" && !isAdversarialReviewThreadTitle(input.title)
  );
}

/**
 * True for a saved thread whose machine can show its Advisor or Adversarial
 * review row (see the two checks above). A draft has no thread yet, so it
 * passes null. The menu-only trigger keeps the name "Advisor": wherever the
 * review row shows, the Advisor row does too.
 */
export function useThreadAdvisorRowAvailable(threadRef: ScopedThreadRef | null): boolean {
  const shell = useThreadShell(threadRef);
  const environment = useEnvironment(threadRef?.environmentId ?? null);
  const config = environment?.serverConfig;
  if (threadRef === null || shell === null || config?.settings == null) return false;
  const capabilities = config.environment?.capabilities;
  return (
    threadAdvisorMenuVisible({
      capability: capabilities?.advisor === true,
      purpose: shell.source.purpose,
    }) ||
    threadReviewMenuVisible({
      capability: capabilities?.threadReviewMode === true,
      purpose: shell.source.purpose,
      title: shell.title,
    })
  );
}
