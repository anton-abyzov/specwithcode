import { useSyncExternalStore } from "react";

const KEY = "specwithcode.notifications.connection.v1";
const CHANGE = "specwithcode:notification-connection";
let volatileConnection = false;
let persistenceFailed = false;

/** This browser profile/device only. Never an environment's server setting. */
export function notificationsConnected(): boolean {
  if (persistenceFailed) return volatileConnection;
  try {
    return window.localStorage.getItem(KEY) === "connected";
  } catch {
    return volatileConnection;
  }
}

export function setNotificationsConnected(connected: boolean): void {
  volatileConnection = connected;
  try {
    window.localStorage.setItem(KEY, connected ? "connected" : "disconnected");
    persistenceFailed = false;
  } catch {
    persistenceFailed = true;
    // Private browsing may refuse storage; the current page still supports opt-out.
  }
  window.dispatchEvent(new Event(CHANGE));
}

function subscribe(listener: () => void) {
  window.addEventListener(CHANGE, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(CHANGE, listener);
    window.removeEventListener("storage", listener);
  };
}

export function useNotificationsConnected() {
  return useSyncExternalStore(subscribe, notificationsConnected, () => false);
}

export type NotificationAvailability = "native" | NotificationPermission | "unsupported";
export function notificationAvailability(): NotificationAvailability {
  if (window.desktopBridge?.showThreadNotification) return "native";
  if (typeof Notification === "undefined" || !window.isSecureContext) return "unsupported";
  return Notification.permission;
}

/** Only call directly from a user gesture. Native permission belongs to the OS. */
export async function connectNotifications(): Promise<NotificationAvailability> {
  let status = notificationAvailability();
  if (status === "default") status = await Notification.requestPermission();
  if (status === "native" || status === "granted") setNotificationsConnected(true);
  return status;
}

export const NOTIFICATION_TEST_TAG = "specwithcode:notification-test";
let browserTest: Notification | undefined;
export async function sendNotificationTest(): Promise<boolean> {
  if (!notificationsConnected()) return false;
  const bridge = window.desktopBridge;
  if (bridge?.showThreadNotification) {
    // The test brings the window forward; the coordinator does not navigate this reserved target.
    return bridge.showThreadNotification({
      tag: NOTIFICATION_TEST_TAG,
      title: "SpecWithCode notifications",
      body: "Notifications are connected on this device.",
      target: { environmentId: "notification-test", threadId: "notification-test" },
    });
  }
  if (notificationAvailability() !== "granted") return false;
  browserTest?.close();
  browserTest = new Notification("SpecWithCode notifications", {
    body: "Notifications are connected in this browser.",
    tag: NOTIFICATION_TEST_TAG,
    silent: true,
  });
  browserTest.addEventListener("click", () => {
    window.focus();
    browserTest?.close();
  });
  return true;
}

export function disconnectNotifications(): void {
  setNotificationsConnected(false);
  browserTest?.close();
  browserTest = undefined;
  void window.desktopBridge
    ?.closeThreadNotification?.(NOTIFICATION_TEST_TAG)
    .catch(() => undefined);
}
