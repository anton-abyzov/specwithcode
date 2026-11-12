import type { ModelSelection } from "@specweave-studio/contracts";

type Selection = Pick<ModelSelection, "instanceId" | "model">;

/**
 * The selection the model chip names as the thread's own. A saved thread shows
 * its persisted model (see `composerChipModel` for a pending pick). A draft has run
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

/**
 * What the model chip of the composer names, and whether a pick waits beside it.
 * - `thread`: the thread's own model (or the running turn's); nothing is pending.
 * - `next`: a turn is in flight (running, queued or starting), so the chip keeps
 *   its model and the pick reads "next:".
 * - `pick`: nothing runs, so the chip names the pick itself. It is the model the
 *   next message goes to, whether the turn was stopped, the pick is still being
 *   saved on the thread, or the thread could not take it before the next message.
 * Only a pick made in the picker counts; a seeded draft copy is no pick.
 */
export function composerChipModel<T extends Selection>(input: {
  /** The thread's own model, or the model of the turn in progress. */
  readonly current: T;
  /** The model the next message goes to. */
  readonly pick: T;
  readonly pickExplicit: boolean;
  readonly turnRunning: boolean;
}): { readonly shown: T; readonly state: "thread" | "next" | "pick" } {
  const pending =
    input.pickExplicit &&
    (input.pick.instanceId !== input.current.instanceId ||
      input.pick.model !== input.current.model);
  if (!pending) return { shown: input.current, state: "thread" };
  return input.turnRunning
    ? { shown: input.current, state: "next" }
    : { shown: input.pick, state: "pick" };
}
