import { Button } from "../../../ui/button";
import { CONFLICT_TEXT } from "./useSystemEdits";

/**
 * In an add dialog's header after a revision conflict, so it never scrolls out of view.
 * The dialog stays open with what was typed; after Reload the same Add saves it on the
 * latest version. `refused` says whether this dialog's own Add was the change turned away.
 */
export function DialogConflictNotice({
  refused,
  onReload,
}: {
  refused: boolean;
  onReload: () => void;
}) {
  return (
    <div
      role="alert"
      className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-warning/30 bg-warning/8 px-3 py-2 text-sm text-warning-foreground"
      data-testid="dialog-conflict"
    >
      <span className="min-w-0 flex-1">
        {CONFLICT_TEXT}{" "}
        {refused
          ? "This was not added. Reload, then press Add again; what you typed stays here."
          : "Reload before you add; what you typed stays here."}
      </span>
      <Button size="xs" variant="outline" onClick={onReload}>
        Reload
      </Button>
    </div>
  );
}
