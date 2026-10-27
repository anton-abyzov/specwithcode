import type { ModelSelection } from "@specweave-studio/contracts";

type Selection = Pick<ModelSelection, "instanceId" | "model">;

/**
 * The selection the model chip names as the thread's own. A saved thread shows
 * its persisted model, and a different pick reads "next:". A draft has run
 * nothing: its thread selection is only a seed, or the "Choose a model"
 * placeholder when no project default exists, so the chip names the model its
 * first message goes to.
 */
export function composerDisplayedThreadSelection(input: {
  readonly isServerThread: boolean;
  readonly threadSelection: Selection | null | undefined;
  readonly sendTarget: Selection;
}): Selection {
  return input.isServerThread && input.threadSelection ? input.threadSelection : input.sendTarget;
}
