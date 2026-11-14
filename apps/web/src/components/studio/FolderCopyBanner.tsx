import { countsText, formatRate, timeLeftText } from "../../studio/copyProgress";
import {
  copyActivityKey,
  copyActivityText,
  copyOpener,
  useCopyActivity,
  type CopyActivity,
} from "../../studio/folderCopyActivity";
import { Button } from "../ui/button";
import { CopyPhaseTrack, useCopyRate } from "./CopyProgressPanel";

/**
 * A strip under the project's top bar while its folder is copied to another machine in
 * the background. The project stays usable; the strip shows the same phases, counts, speed
 * and time left as the copy's dialog, and that changes made now may need a second copy.
 */
export function FolderCopyBanner({
  environmentId,
  projectId,
}: {
  readonly environmentId: string;
  readonly projectId: string;
}) {
  const activity = useCopyActivity([{ environmentId, id: projectId }]);
  if (!activity) return null;
  const open = copyOpener(copyActivityKey(environmentId, projectId));
  return (
    <div
      role="status"
      data-slot="folder-copy-banner"
      className="flex shrink-0 flex-col gap-1.5 border-b border-border bg-muted/40 px-4 py-2 text-sm"
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className="min-w-0 flex-1 truncate">
          <LiveTitle activity={activity} />
          {activity.waiting ? (
            <span className="text-muted-foreground">
              {" "}
              · Nothing is copied until you approve it. Review it to approve or cancel.
            </span>
          ) : activity.progress ? null : (
            <span className="text-muted-foreground">
              {" "}
              · You can keep working; changes made now may need another copy.
            </span>
          )}
        </span>
        {open ? (
          <Button size="compact" variant={activity.waiting ? "default" : "outline"} onClick={open}>
            {activity.waiting ? "Review" : "Details"}
          </Button>
        ) : null}
      </div>
      {activity.waiting ? null : <BannerProgress activity={activity} />}
    </div>
  );
}

/** The phase track and the numbers under it; a copy from an older machine keeps one bar. */
/**
 * The banner's line without its percent in the live region: the percent changes on every
 * poll, so a screen reader would hear the whole line again every 2 s. The track's
 * progressbar carries the value for anyone who asks.
 */
function LiveTitle({ activity }: { readonly activity: CopyActivity }) {
  const full = copyActivityText(activity);
  const still = copyActivityText({
    ...activity,
    fraction: null,
    ...(activity.progress ? { progress: { ...activity.progress, fraction: null } } : {}),
  });
  return (
    <>
      {still}
      {full.startsWith(still) && full.length > still.length ? (
        <span aria-hidden="true">{full.slice(still.length)}</span>
      ) : null}
    </>
  );
}

function BannerProgress({ activity }: { readonly activity: CopyActivity }) {
  const view = activity.progress ?? null;
  const rate = useCopyRate(view);
  if (!view) {
    const percent = activity.fraction === null ? null : Math.round(activity.fraction * 100);
    return (
      <div
        className="sws-copy-progress"
        data-inline
        data-indeterminate={percent === null || undefined}
        role="progressbar"
        aria-label="Copy progress"
        {...(percent === null
          ? {}
          : { "aria-valuenow": percent, "aria-valuemin": 0, "aria-valuemax": 100 })}
      >
        <span
          className="sws-copy-progress-fill"
          style={percent === null ? undefined : { width: `${percent}%` }}
        />
      </div>
    );
  }
  const counts = countsText(view);
  const left = timeLeftText(view, rate);
  return (
    <>
      <CopyPhaseTrack
        view={view}
        sourceLabel={activity.source ?? "this machine"}
        targetLabel={activity.machine}
        compact
        live={rate !== null}
      />
      <p
        className="flex flex-wrap gap-x-4 text-xs text-muted-foreground tabular-nums"
        data-slot="folder-copy-banner-numbers"
        aria-live="off"
      >
        {counts.bytes && <span className="text-foreground">{counts.bytes}</span>}
        {counts.files && <span>{counts.files}</span>}
        {rate && <span>{formatRate(rate)}</span>}
        {left && <span>{left}</span>}
        <span>You can keep working; changes made now may need another copy.</span>
      </p>
    </>
  );
}
