/**
 * The one notice above the coordinator's composer (1396 AC-18). Two can apply:
 * the Full access recommendation and the SpecWeave line for a project whose
 * folder is not set up. One function chooses, and Full access wins when both
 * apply, so the composer never shows two.
 */
import type { ProjectWorkspaceReadResult } from "@specweave-studio/contracts";

import { specweaveAnswersSupported, specweaveStateOf } from "../studio/specweaveSetup.logic";

export type ComposerNotice = "access" | "specweave" | null;

export function composerNotice(input: {
  /** The Full access recommendation applies to this composer. */
  readonly accessRecommended: boolean;
  /** The SpecWeave line is offered here (see `specweaveOfferApplies`). */
  readonly specweaveOffered: boolean;
}): ComposerNotice {
  if (input.accessRecommended) return "access";
  if (input.specweaveOffered) return "specweave";
  return null;
}

/**
 * The SpecWeave line applies: the project's coordinator, a code project the
 * person keeps (not one a check made for itself), SpecWeave off, never acted
 * on and never declined, on a server that can store the answer.
 */
export function specweaveOfferApplies(input: {
  readonly snapshot:
    | (Pick<
        ProjectWorkspaceReadResult,
        "specweave" | "specweaveState" | "specweaveDeclined" | "specweaveAdviceSeen"
      > & {
        readonly settings: { readonly kind: string; readonly origin?: string | undefined };
      })
    | null
    | undefined;
  readonly coordinator: boolean;
  readonly canAnswer: boolean;
}): boolean {
  const { snapshot } = input;
  if (!input.coordinator || !input.canAnswer || !snapshot) return false;
  if (snapshot.settings.kind !== "code" || snapshot.settings.origin === "automated") return false;
  if (!specweaveAnswersSupported(snapshot)) return false;
  return (
    specweaveStateOf(snapshot) === "off" &&
    snapshot.specweaveDeclined !== true &&
    snapshot.specweaveAdviceSeen !== true
  );
}
