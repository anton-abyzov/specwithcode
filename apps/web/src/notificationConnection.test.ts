import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";
import {
  connectNotifications,
  disconnectNotifications,
  notificationAvailability,
  notificationsConnected,
  sendNotificationTest,
  setNotificationsConnected,
} from "./notificationConnection";

let storage: Map<string, string>;
beforeEach(() => {
  storage = new Map();
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), {
      isSecureContext: true,
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    }),
  );
  disconnectNotifications();
});
afterEach(() => vi.unstubAllGlobals());

it("starts opted out and never requests permission while reading status", () => {
  const requestPermission = vi.fn();
  vi.stubGlobal("Notification", { permission: "default", requestPermission });
  expect(notificationsConnected()).toBe(false);
  expect(notificationAvailability()).toBe("default");
  expect(requestPermission).not.toHaveBeenCalled();
});
it("connects only after permission is granted and disconnect persists", async () => {
  vi.stubGlobal("Notification", {
    permission: "default",
    requestPermission: vi.fn().mockResolvedValue("granted"),
  });
  expect(await connectNotifications()).toBe("granted");
  expect(notificationsConnected()).toBe(true);
  disconnectNotifications();
  expect(notificationsConnected()).toBe(false);
  expect(await sendNotificationTest()).toBe(false);
});
it.each(["denied", "default"] as const)("does not connect after %s", async (permission) => {
  vi.stubGlobal("Notification", {
    permission: "default",
    requestPermission: vi.fn().mockResolvedValue(permission),
  });
  expect(await connectNotifications()).toBe(permission);
  expect(notificationsConnected()).toBe(false);
});
it("observes revoked browser permission without prompting again", async () => {
  setNotificationsConnected(true);
  vi.stubGlobal("Notification", { permission: "denied", requestPermission: vi.fn() });
  expect(notificationAvailability()).toBe("denied");
  expect(await sendNotificationTest()).toBe(false);
  expect(Notification.requestPermission).not.toHaveBeenCalled();
});
it("native transport does not request Chromium permission and reports refusal", async () => {
  const showThreadNotification = vi.fn().mockResolvedValue(false);
  Object.assign(window, { desktopBridge: { showThreadNotification } });
  vi.stubGlobal("Notification", { permission: "denied", requestPermission: vi.fn() });
  expect(await connectNotifications()).toBe("native");
  expect(await sendNotificationTest()).toBe(false);
  expect(showThreadNotification).toHaveBeenCalledTimes(1);
  expect(Notification.requestPermission).not.toHaveBeenCalled();
});
it("rejects insecure/unsupported browsers", async () => {
  Object.assign(window, { isSecureContext: false });
  vi.stubGlobal("Notification", { permission: "granted" });
  expect(await connectNotifications()).toBe("unsupported");
  expect(notificationsConnected()).toBe(false);
});

it("disconnect takes effect even when storage reads succeed but writes fail", () => {
  setNotificationsConnected(true);
  vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
    throw new Error("quota exceeded");
  });
  disconnectNotifications();
  expect(notificationsConnected()).toBe(false);
});
