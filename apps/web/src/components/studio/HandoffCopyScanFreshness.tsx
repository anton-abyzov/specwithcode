import type { FolderCopySourceStatus } from "@specweave-studio/contracts";
import { Button } from "../ui/button";

const UNITS: ReadonlyArray<readonly [Intl.RelativeTimeFormatUnit, number]> = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

/** "2 days ago", "5 minutes ago", or "just now". */
export function measuredAgo(at: number, now = Date.now()): string {
  const elapsed = Math.max(0, now - at);
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, size] of UNITS)
    if (elapsed >= size) return format.format(-Math.floor(elapsed / size), unit);
  return "just now";
}

/**
 * One muted line under What and Review: when the folder was measured, and Measure again.
 * Measuring again is read-only: the current copy, file types and conflict choices stay.
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
  const captured = status?.capturedAt ?? capturedAt;
  const changed = sourceChanged || status?.freshness?.current === false;
  const at = status?.scanCompletedAt;
  return (
    <div className="space-y-1 text-xs text-muted-foreground" data-slot="copy-scan-freshness">
      <p className="flex flex-wrap items-center gap-x-1.5">
        <span data-slot="copy-scan-age">
          {at === undefined ? "Measured earlier" : `Measured ${measuredAgo(at)}`}
        </span>
        <span aria-hidden>·</span>
        <Button variant="link" size="xs" disabled={busy} onClick={onRefresh}>
          Measure again
        </Button>
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
              ? "The source changed. You can still copy the captured files, or measure and compare again for newer work."
              : "The folder changed since it was measured. Compare again before copying."
            : "Nothing changed since then, so your choices stay."}
        </p>
      )}
      {(changed || captured !== undefined) && (
        <div className="space-y-1">
          <Button variant="outline" size="sm" disabled={busy} onClick={onCompareAgain}>
            Measure and compare again
          </Button>
          <p>
            It keeps the machine, folder and file types. You review the choices again, and secret
            files stay out until you tick them.
          </p>
        </div>
      )}
    </div>
  );
}
