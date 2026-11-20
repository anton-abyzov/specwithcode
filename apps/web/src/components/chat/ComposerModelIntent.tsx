import type { ModelSelection } from "@specweave-studio/contracts";
import { modelSelectionsEqual } from "@specweave-studio/shared/model";

/** A composer pick is local intent until a send makes it the thread selection. */
export function ComposerModelIntent({
  threadSelection,
  draftSelection,
  explicit,
}: {
  threadSelection: ModelSelection | null;
  draftSelection: ModelSelection | null;
  explicit: boolean;
}) {
  if (!explicit || !threadSelection || !draftSelection ||
      modelSelectionsEqual(threadSelection, draftSelection)) return null;
  return (
    <p role="status" data-composer-model-intent="pending"
      className="px-3 pt-2 text-xs text-muted-foreground">
      Next message: your selected model applies when you send.
    </p>
  );
}
