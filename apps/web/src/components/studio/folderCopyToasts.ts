import { countsText } from "../../studio/copyProgress";
import {
  copyActivityText,
  copyOpener,
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

export function copyToastOptions(activity: CopyActivity, onDetails: (() => void) | null, onClose: () => void) {
  const progress = activity.progress;
  const counts = progress ? countsText(progress) : null;
  const fraction = overallFraction(activity);
  const numbers = [counts?.bytes, counts?.files].filter(Boolean).join(", ");
  return stackedThreadToast({
    type: "info",
    title: copyActivityText(activity),
    description: numbers
      ? `${numbers}. You can keep working; it runs on the machines.`
      : "You can keep working; it runs on the machines.",
    timeout: 0,
    priority: "low",
    actionProps: onDetails ? { children: "Details", onClick: onDetails } : hiddenToastActionProps,
    data: {
      hideCopyButton: true,
      onClose,
      ...(fraction === null ? {} : { progress: fraction }),
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
    const details = () => {
      const show = copyOpener(key);
      if (show) show();
      else requestCopyReview(key);
    };
    const close = () => {
      dismissed.add(key);
      open.delete(key);
    };
    const options = copyToastOptions(activity, details, close);
    const id = open.get(key);
    if (id === undefined) open.set(key, toastManager.add(options));
    else toastManager.update(id, options);
  }
}

/** Test helper. */
export function resetCopyToastsForTests(): void {
  open.clear();
  dismissed.clear();
}
