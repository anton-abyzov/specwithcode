/**
 * One system notification per quota alert and period. The banner already
 * says it inside the window, so this only speaks when the window is not in
 * front, and never twice for the same period on this device.
 */
import { coversQuotaAlertPeriod } from "@specweave-studio/shared/quotaAlerts";

import { notificationAvailability, notificationsConnected } from "../../../notificationConnection";

const NOTIFIED_KEY = "specwithcode:quota-alerts-notified";

/** Per alert key, the period end that was notified. */
function readNotified(): Record<string, number> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(NOTIFIED_KEY) ?? "{}");
    if (saved === null || typeof saved !== "object" || Array.isArray(saved)) return {};
    return Object.fromEntries(
      Object.entries(saved).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
    );
  } catch {
    return {};
  }
}

/** Whether the period ending at `periodEnd` was already notified for alert `key` on this device. */
export function quotaAlertNotified(key: string, periodEnd: number): boolean {
  return coversQuotaAlertPeriod(readNotified()[key], periodEnd);
}

/** Records the notification; false when storage refuses, so the caller can hold back. */
export function recordQuotaAlertNotification(key: string, periodEnd: number): boolean {
  try {
    localStorage.setItem(NOTIFIED_KEY, JSON.stringify({ ...readNotified(), [key]: periodEnd }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Raises the notification for one alert period once. Does nothing while the
 * window has focus (the banner is in view) or notifications are not
 * connected; the period stays unrecorded then, so a later call still
 * notifies. It is recorded only once the notification exists.
 */
export function notifyQuotaAlert(input: {
  readonly key: string;
  readonly periodEnd: number;
  readonly title: string;
  readonly body: string;
  readonly onOpen: () => void;
}): void {
  if (quotaAlertNotified(input.key, input.periodEnd)) {
    // The same period, re-read with a later end: follow it, so small drifts cannot add up.
    // Done before the focus and permission checks, which would otherwise skip it and let
    // one period notify twice.
    if ((readNotified()[input.key] ?? 0) < input.periodEnd) {
      recordQuotaAlertNotification(input.key, input.periodEnd);
    }
    return;
  }
  if (!notificationsConnected() || document.hasFocus()) return;
  // The desktop's own notification call opens a thread, and an alert has none, so both the
  // desktop app and a browser use the web notification here.
  const availability = notificationAvailability();
  if (typeof Notification === "undefined") return;
  if (availability !== "native" && availability !== "granted") return;
  // Without storage it would notify on every pass; the banner is enough then.
  if (!recordQuotaAlertNotification(input.key, input.periodEnd)) return;
  try {
    const notification = new Notification(input.title, {
      body: input.body,
      tag: `specwithcode:quota-alert:${input.key}`,
      silent: true,
    });
    notification.addEventListener("click", () => {
      notification.close();
      window.focus();
      input.onOpen();
    });
  } catch {
    // It never showed: forget it, so the next pass tries again.
    try {
      const { [input.key]: _dropped, ...rest } = readNotified();
      localStorage.setItem(NOTIFIED_KEY, JSON.stringify(rest));
    } catch {
      /* The banner in the window still says it. */
    }
  }
}
