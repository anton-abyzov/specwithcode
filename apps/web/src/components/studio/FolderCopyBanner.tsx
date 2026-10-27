import {
  copyActivityKey,
  copyActivityText,
  copyOpener,
  useCopyActivity,
} from "../../studio/folderCopyActivity";
import { Button } from "../ui/button";

/**
 * A strip under the project's top bar while its folder is copied to another machine in
 * the background. The project stays usable; the strip only says how far the copy is,
 * and that changes made now may need a second copy.
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
  const percent = activity.fraction === null ? null : Math.round(activity.fraction * 100);
  return (
    <div
      role="status"
      data-slot="folder-copy-banner"
      className="flex shrink-0 flex-col gap-1.5 border-b border-border bg-muted/40 px-4 py-2 text-sm"
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className="min-w-0 flex-1 truncate">
          {copyActivityText(activity)}
          {activity.waiting ? null : (
            <span className="text-muted-foreground">
              {" "}
              · You can keep working; changes made now may need another copy.
            </span>
          )}
        </span>
        {open ? (
          <Button size="compact" variant="outline" onClick={open}>
            {activity.waiting ? "Review" : "Details"}
          </Button>
        ) : null}
      </div>
      {activity.waiting ? null : (
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
      )}
    </div>
  );
}
