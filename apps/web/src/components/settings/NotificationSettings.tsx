import { useEffect, useState } from "react";

import {
  hasNotificationSound,
  NOTIFICATION_MODE_LABELS,
  unlockNotificationAudio,
} from "../../threadNotifications";
import {
  connectNotifications,
  disconnectNotifications,
  notificationAvailability,
  sendNotificationTest,
  useNotificationsConnected,
} from "../../notificationConnection";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function NotificationSettings() {
  const mode = useScopedSettings((settings) => settings.notificationMode);
  const updateSettings = useUpdateScopedSettings();
  const connected = useNotificationsConnected();
  const [availability, setAvailability] = useState(notificationAvailability);
  const [message, setMessage] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const native = availability === "native";

  useEffect(() => {
    const refresh = () => {
      setAvailability(notificationAvailability());
      setMessage(null);
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    let permission: PermissionStatus | undefined;
    let disposed = false;
    if (!native && navigator.permissions) {
      void navigator.permissions
        .query({ name: "notifications" })
        .then((status) => {
          if (disposed) return;
          permission = status;
          permission.addEventListener("change", refresh);
        })
        .catch(() => undefined);
    }
    return () => {
      disposed = true;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      permission?.removeEventListener("change", refresh);
    };
  }, [native]);

  const test = async () => {
    setRequesting(true);
    try {
      const posted = await sendNotificationTest();
      setMessage(
        posted
          ? native
            ? "Test sent to the system. Check Notification Center; Focus or system settings may hide banners."
            : "Test sent. Your browser and system settings control whether a banner appears."
          : "The notification was not accepted. Allow SpecWithCode in system notification settings, or this site in your browser, then retry.",
      );
      setAvailability(notificationAvailability());
    } catch {
      setMessage("The notification could not be sent. Check notification permissions and retry.");
    } finally {
      setRequesting(false);
    }
  };
  const status =
    availability === "unsupported"
      ? "Unavailable in this browser"
      : availability === "denied"
        ? "Permission blocked"
        : !connected
          ? "Not connected"
          : availability === "default"
            ? "Permission needed"
            : native
              ? "Connected to this desktop. System permission is managed by your OS."
              : "Connected to this browser";

  return (
    <div className="space-y-3">
      <SettingsRow
        {...searchableSetting("thread-notifications")}
        description={
          native
            ? "Alerts on this device from connected machines while a SpecWithCode window is open or minimized. No mobile app needed."
            : "Alerts on this device from connected machines while this browser page is open. Closing it stops delivery."
        }
        control={
          <div className="flex flex-wrap justify-end gap-2">
            {connected ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={
                    requesting || availability === "unsupported" || availability === "denied"
                  }
                  onClick={() => void test()}
                >
                  Send test
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    disconnectNotifications();
                    setMessage(
                      "Disconnected. System alerts, including input-needed alerts, are off on this device.",
                    );
                  }}
                >
                  Disconnect
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                disabled={requesting || availability === "unsupported"}
                onClick={async () => {
                  setRequesting(true);
                  setMessage(null);
                  try {
                    const permission = await connectNotifications();
                    setAvailability(permission);
                    if (permission === "native" || permission === "granted") {
                      updateSettings({ inputNeededAlertsEnabled: true });
                      await test();
                    } else {
                      setMessage(
                        "Allow notifications for this site in your browser settings, then connect again.",
                      );
                    }
                  } catch {
                    setMessage(
                      "Notification permission could not be requested. Check your browser settings.",
                    );
                  } finally {
                    setRequesting(false);
                  }
                }}
              >
                Connect notifications
              </Button>
            )}
          </div>
        }
      />
      <p className="text-sm text-muted-foreground" role="status" aria-live="polite">
        {status}
      </p>
      {message ? (
        <p className="text-sm text-muted-foreground" role="status">
          {message}
        </p>
      ) : null}
      <SettingsRow
        title="Other thread alerts"
        description="Choose alerts for completions, failures and stalls. Input-needed alerts have their own switch below. Disconnect turns off all system alerts."
        control={
          <Select
            value={mode}
            onValueChange={(value) => {
              if (
                value !== "off" &&
                value !== "notifications" &&
                value !== "sound" &&
                value !== "notifications-and-sound"
              )
                return;
              if (hasNotificationSound(value)) unlockNotificationAudio();
              updateSettings({ notificationMode: value });
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Other thread alerts">
              <SelectValue>{NOTIFICATION_MODE_LABELS[mode]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {Object.entries(NOTIFICATION_MODE_LABELS).map(([value, label]) => (
                <SelectItem key={value} hideIndicator value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
    </div>
  );
}
