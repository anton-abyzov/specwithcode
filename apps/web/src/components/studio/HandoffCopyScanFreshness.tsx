import type { FolderCopySourceStatus } from "@specweave-studio/contracts";
import { Button } from "../ui/button";

/** Refresh is read-only: the current job, class selections and conflict choices stay intact. */
export function HandoffCopyScanFreshness({
  status,
  busy,
  onRefresh,
  onCompareAgain,
}: {
  readonly status: FolderCopySourceStatus | null;
  readonly busy: boolean;
  readonly onRefresh: () => void;
  readonly onCompareAgain: () => void;
}) {
  const changed = status?.freshness?.current === false;
  const time = (value: number) =>
    new Date(value).toLocaleString(undefined, {
      month: "long",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  return (
    <div className="rounded-lg border p-3 text-sm" data-slot="copy-scan-freshness">
      <p>
        {status?.scanCompletedAt !== undefined
          ? `Saved scan from ${time(status.scanCompletedAt)}.`
          : "Saved scan. Its measurement time is unknown."}{" "}
        Closing and reopening resumes this scan.
      </p>
      <p className="text-muted-foreground">
        {status?.freshness?.summary
          ? "The counts and worktree names below show the refreshed source. The saved comparison is kept until you explicitly replace it."
          : "The folder counts and worktree names below describe that saved scan."}
      </p>
      {status?.freshness && (
        <p role="status">
          Checked {time(status.freshness.checkedAt)}.{" "}
          {changed
            ? "The source changed, or this older scan cannot be validated. Review a new comparison before copying."
            : "The source still matches this scan. Your copy choices are unchanged."}
        </p>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={busy} onClick={onRefresh}>
          Refresh scan
        </Button>
        {changed && (
          <Button variant="outline" size="sm" disabled={busy} onClick={onCompareAgain}>
            Measure and compare again
          </Button>
        )}
      </div>
      {changed && (
        <p className="mt-2 text-muted-foreground">
          A new comparison keeps the machine, folder and file classes. Review conflict choices
          again; secret files remain excluded until confirmed.
        </p>
      )}
    </div>
  );
}
