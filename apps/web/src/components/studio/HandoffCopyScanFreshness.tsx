import type { FolderCopySourceStatus } from "@specweave-studio/contracts";
import { relativeAge } from "../../lib/relativeAge";
import { useTx } from "../../i18n";
import { Button } from "../ui/button";

/** "2 days ago", "5 minutes ago", or "just now". */
export function measuredAgo(at: number, now = Date.now()): string {
  return relativeAge(at, now) ?? "just now";
}

/**
 * One muted line under What and Review: when the folder was measured, and Check for changes.
 * Checking is read-only: the current copy, file types and conflict choices stay.
 */
export function HandoffCopyScanFreshness({
  status,
  capturedAt,
  sourceChanged = false,
  busy,
  onRefresh,
  onCompareAgain,
}: {
  readonly status: FolderCopySourceStatus | null;
  readonly capturedAt?: number | undefined;
  readonly sourceChanged?: boolean;
  readonly busy: boolean;
  readonly onRefresh: () => void;
  readonly onCompareAgain: () => void;
}) {
  const tx = useTx();
  const captured = status?.capturedAt ?? capturedAt;
  const changed = sourceChanged || status?.freshness?.current === false;
  const at = status?.scanCompletedAt;
  // One control at a time: Check for changes (read-only) until a change is found, then
  // Compare again, which the footer holds while the source changed.
  const compareHere = changed && !sourceChanged;
  return (
    <div className="space-y-1 text-xs text-muted-foreground" data-slot="copy-scan-freshness">
      <p className="flex flex-wrap items-center gap-x-1.5">
        <span data-slot="copy-scan-age">
          {at === undefined ? "Measured earlier" : `Measured ${measuredAgo(at)}`}
        </span>
        {changed ? null : (
          <Button variant="outline" size="xs" disabled={busy} onClick={onRefresh}>
            Check for changes
          </Button>
        )}
      </p>
      {captured !== undefined && (
        <p data-slot="copy-captured-files">
          This copy uses files captured {measuredAgo(captured)}. New files and later edits stay on
          the source. The comparison shown here is for those captured files; you approve it before
          copying.
          {status?.freshness &&
            " The measurements and notices show the current source, not new copy contents."}
        </p>
      )}
      {(changed || status?.freshness) && (
        <p role="status" className={changed ? "text-warning-foreground" : undefined}>
          {changed
            ? captured !== undefined && !sourceChanged
              ? tx(
                  "The source changed. You can still copy the captured files, or compare again for newer work.",
                )
              : "The folder changed since it was measured. Compare again before copying."
            : "Nothing changed since then, so your choices stay."}
        </p>
      )}
      {compareHere && (
        <div className="space-y-1">
          <Button variant="outline" size="sm" disabled={busy} onClick={onCompareAgain}>
            {tx("Compare again")}
          </Button>
          <p>
            It keeps the machine, folder, file types and secrets choice. You review the choices
            again before anything is copied.
          </p>
        </div>
      )}
    </div>
  );
}
