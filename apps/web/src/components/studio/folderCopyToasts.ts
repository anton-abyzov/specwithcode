import { formatBytes } from "../../studio/folderCopy";
import {
  addRateSample,
  rateOf,
  timeLeftText,
  type CopyProgressView,
  type RateSample,
} from "../../studio/copyProgress";
import {
  copyActivityText,
  copyDetailsOpener,
  overallFraction,
  requestCopyReview,
  type CopyActivity,
  type CopyWatch,
} from "../../studio/folderCopyActivity";
import { hiddenToastActionProps, stackedThreadToast, toastManager } from "../ui/toast";

/**
 * One progress toast per copy running in the background, the same bar the update toast
 * shows: it follows the copy after its dialog closes, from any project, until the copy
 * finishes (the watcher then announces it) or the person closes the toast.
 */
const open = new Map<string, string>();
/** Copies whose toast the person closed: it stays closed for that copy. */
const dismissed = new Set<string>();

/** Speed readings per copy, for the time left; a new step starts them again. */
const rates = new Map<
  string,
  { readonly rateKey: string; readonly samples: ReadonlyArray<RateSample> }
>();

/** "5.4 GB and 2,810 files left": what the step still has to do, once it knows its totals. */
export function leftText(view: Pick<CopyProgressView, "bytes" | "files">): string | null {
  const bytes =
    view.bytes && view.bytes.total !== null && view.bytes.total > view.bytes.done
      ? formatBytes(view.bytes.total - view.bytes.done)
      : null;
  const fileCount =
    view.files && view.files.total !== null && view.files.total > view.files.done
      ? view.files.total - view.files.done
      : null;
  const files =
    fileCount === null
      ? null
      : `${fileCount.toLocaleString()} ${fileCount === 1 ? "file" : "files"}`;
  const parts = [bytes, files].filter((part): part is string => part !== null);
  return parts.length > 0 ? `${parts.join(" and ")} left` : null;
}

/** "Copy to m5: 42% done": the whole copy, the same share the bar fills. */
export function copyToastTitle(activity: CopyActivity): string {
  const fraction = overallFraction(activity);
  if (fraction === null || !activity.progress) return copyActivityText(activity);
  const verb = activity.move ? "Hand off" : "Copy";
  return `${verb} to ${activity.machine}: ${Math.floor(fraction * 100)}% done`;
}

/** "Sending files to m5. 5.4 GB and 2,810 files left, about 4 min left." */
export function copyToastDescription(activity: CopyActivity, rate: number | null): string {
  const progress = activity.progress;
  if (!progress) return "It runs on the machines; you can keep working.";
  const left = leftText(progress);
  const time = timeLeftText(progress, rate);
  const rest = [left, time ? time.charAt(0).toLowerCase() + time.slice(1) : null].filter(Boolean);
  return rest.length > 0 ? `${progress.step}. ${rest.join(", ")}.` : `${progress.step}.`;
}

/** Records a reading of the copy's counts and returns its speed, null until it steadies. */
function rateFor(key: string, activity: CopyActivity, now: number): number | null {
  const progress = activity.progress;
  if (!progress?.bytes || progress.rateKey === null || progress.outcome !== "running") {
    rates.delete(key);
    return null;
  }
  const previous = rates.get(key);
  const sample = { at: now, bytes: progress.bytes.done - progress.bytesLocal };
  const samples =
    previous?.rateKey === progress.rateKey ? addRateSample(previous.samples, sample) : [sample];
  rates.set(key, { rateKey: progress.rateKey, samples });
  return rateOf(samples);
}

export function copyToastOptions(
  activity: CopyActivity,
  onDetails: (() => void) | null,
  onClose: () => void,
  rate: number | null = null,
) {
  const fraction = overallFraction(activity);
  return stackedThreadToast({
    type: "info",
    title: copyToastTitle(activity),
    description: copyToastDescription(activity, rate),
    timeout: 0,
    priority: "low",
    actionProps: onDetails ? { children: "Details", onClick: onDetails } : hiddenToastActionProps,
    data: {
      hideCopyButton: true,
      onClose,
      ...(fraction === null
        ? {}
        : {
            progress: fraction,
            // The dialog's three phases, with the sheen while bytes move.
            progressSegments: 3,
            progressLive: rate !== null,
            progressLabel: "Copy progress",
          }),
    },
  });
}

/** Opens, updates and closes the toasts to match the copies watched in the background. */
export function syncCopyToasts(
  activities: ReadonlyMap<string, CopyActivity>,
  watches: ReadonlyMap<string, CopyWatch>,
  now: number = Date.now(),
): void {
  for (const key of rates.keys()) if (!activities.has(key)) rates.delete(key);
  for (const [key, id] of open) {
    const activity = activities.get(key);
    if (watches.has(key) && activity && !activity.waiting) continue;
    toastManager.close(id);
    open.delete(key);
  }
  for (const key of dismissed) if (!activities.has(key)) dismissed.delete(key);
  for (const [key] of watches) {
    const activity = activities.get(key);
    // A copy waiting for review has its own Review in the sidebar and banner.
    if (!activity || activity.waiting || dismissed.has(key)) continue;
    // From another project the row's navigator opens the copy's page, then its dialog.
    const details = () => (copyDetailsOpener(key) ?? (() => requestCopyReview(key)))();
    const close = () => {
      dismissed.add(key);
      open.delete(key);
    };
    const options = copyToastOptions(activity, details, close, rateFor(key, activity, now));
    const id = open.get(key);
    if (id === undefined) open.set(key, toastManager.add(options));
    else toastManager.update(id, options);
  }
}

/** Test helper. */
export function resetCopyToastsForTests(): void {
  open.clear();
  dismissed.clear();
  rates.clear();
}
