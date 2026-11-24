import { formatBytes } from "../../studio/folderCopy";
import { formatRate, timeLeftText, type CopyProgressView } from "../../studio/copyProgress";
import {
  copyActivityText,
  copyDetailsOpener,
  openCopyReview,
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

/** "Sending files to m5. 5.4 GB and 2,810 files left, 48 MB/s, about 4 min left." */
export function copyToastDescription(activity: CopyActivity, rate: number | null): string {
  const progress = activity.progress;
  if (!progress) return "It runs on the machines; you can keep working.";
  const left = leftText(progress);
  const time = timeLeftText(progress, rate);
  const speed = rate ? formatRate(rate) : null;
  const rest = [left, speed, time ? time.charAt(0).toLowerCase() + time.slice(1) : null].filter(
    Boolean,
  );
  return rest.length > 0 ? `${progress.step}. ${rest.join(", ")}.` : `${progress.step}.`;
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
): void {
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
    // The speed the sidebar row shows: measured once, where the activity is recorded.
    const options = copyToastOptions(activity, details, close, activity.rate ?? null);
    const id = open.get(key);
    if (id === undefined) open.set(key, toastManager.add(options));
    else toastManager.update(id, options);
  }
}

/** Review toasts of copies closed at their review, one per copy, by its activity key. */
const reviewToasts = new Map<string, string>();

/**
 * Offers Review once for a copy closed at its review. It stays until the person uses or
 * closes it, or the copy's dialog opens again (closeCopyReviewToast).
 */
export function offerCopyReview(key: string, activity: CopyActivity): void {
  if (reviewToasts.has(key)) return;
  const id: string = toastManager.add({
    type: "success",
    title: `${copyActivityText(activity)}. Nothing is copied until you approve it.`,
    timeout: 0,
    actionProps: {
      children: "Review",
      onClick: () => {
        closeCopyReviewToast(key);
        openCopyReview(key);
      },
    },
    data: { onClose: () => reviewToasts.delete(key) },
  });
  reviewToasts.set(key, id);
}

/** The copy's dialog is open again: its review toast has nothing left to offer. */
export function closeCopyReviewToast(key: string): void {
  const id = reviewToasts.get(key);
  if (id === undefined) return;
  reviewToasts.delete(key);
  toastManager.close(id);
}

/** Test helper. */
export function resetCopyToastsForTests(): void {
  open.clear();
  dismissed.clear();
  reviewToasts.clear();
}
