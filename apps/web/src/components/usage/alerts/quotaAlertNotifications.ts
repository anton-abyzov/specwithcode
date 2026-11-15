/**
 * One system notification per quota alert and period. The banner already
 * says it inside the window, so this only speaks when the window is not in
 * front, and never twice for the same period on this device.
 */
import { notificationAvailability, notificationsConnected } from "../../../notificationConnection";

const NOTIFIED_KEY = "specwithcode:quota-alerts-notified";
/** Old ids are dropped past this many, newest kept. */
const MAX_NOTIFIED = 200;

function readNotified(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(NOTIFIED_KEY) ?? "[]");
    return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/** Whether `id` was not notified yet; records it when it was not. */
export function claimQuotaAlertNotification(id: string): boolean {
  const notified = readNotified();
  if (notified.includes(id)) return false;
  try {
    localStorage.setItem(NOTIFIED_KEY, JSON.stringify([...notified, id].slice(-MAX_NOTIFIED)));
  } catch {
    // Without storage the alert would notify on every load; the banner is enough.
    return false;
  }
  return true;
}

/**
 * Raises the notification for alert `id` once. Does nothing while the window
 * has focus (the banner is in view) or notifications are not connected; in
 * both cases the id stays unclaimed, so it can still notify later.
 */
export function notifyQuotaAlert(input: {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly onOpen: () => void;
}): void {
  if (!notificationsConnected() || document.hasFocus()) return;
  // The desktop's own notification call opens a thread, and an alert has none, so both the
  // desktop app and a browser use the web notification here.
  const availability = notificationAvailability();
  if (typeof Notification === "undefined") return;
  if (availability !== "native" && availability !== "granted") return;
  if (!claimQuotaAlertNotification(input.id)) return;
  const tag = `specwithcode:quota-alert:${input.id}`;
  try {
    const notification = new Notification(input.title, { body: input.body, tag, silent: true });
    notification.addEventListener("click", () => {
      notification.close();
      window.focus();
      input.onOpen();
    });
  } catch {
    /* The banner in the window still says it. */
  }
}
