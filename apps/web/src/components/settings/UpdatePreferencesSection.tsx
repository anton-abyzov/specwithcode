import type {
  DesktopUpdatePreferences,
  DesktopUpdatePreferencesPatch,
  StudioServiceUpdateState,
} from "@specweave-studio/contracts";
import { useCallback, useEffect, useState } from "react";

import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  describeServiceUpdate,
  resolveServiceUpdateAction,
} from "./UpdatePreferencesSection.logic";

const errorText = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

/**
 * Desktop-only update controls: when Studio checks, downloads and installs
 * updates for this app and for the Studio service on this computer.
 */
export function UpdatePreferencesSection() {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  const supported =
    typeof bridge?.getUpdatePreferences === "function" &&
    typeof bridge.setUpdatePreferences === "function";
  const [preferences, setPreferences] = useState<DesktopUpdatePreferences | null>(null);
  const [serviceState, setServiceState] = useState<StudioServiceUpdateState | null>(null);
  const [servicePending, setServicePending] = useState(false);

  useEffect(() => {
    if (!supported || !bridge) return;
    let active = true;
    void bridge.getUpdatePreferences?.().then((value) => {
      if (active) setPreferences(value);
    });
    void bridge.getServiceUpdateState?.().then((value) => {
      if (active) setServiceState(value);
    });
    const unsubscribe = bridge.onServiceUpdateState?.((value) => setServiceState(value));
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [bridge, supported]);

  const change = useCallback(
    (patch: DesktopUpdatePreferencesPatch) => {
      if (!bridge?.setUpdatePreferences) return;
      setPreferences((current) => (current ? { ...current, ...patch } : current));
      void bridge
        .setUpdatePreferences(patch)
        .then(setPreferences)
        .catch((error: unknown) => {
          void bridge.getUpdatePreferences?.().then(setPreferences);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not save update settings",
              description: errorText(error, "Saving failed."),
            }),
          );
        });
    },
    [bridge],
  );

  const serviceAction = serviceState ? resolveServiceUpdateAction(serviceState) : "none";
  const runServiceAction = useCallback(() => {
    if (!bridge || serviceAction === "none") return;
    const request =
      serviceAction === "install" ? bridge.installServiceUpdate : bridge.checkServiceUpdate;
    if (typeof request !== "function") return;
    setServicePending(true);
    void request()
      .then(setServiceState)
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title:
              serviceAction === "install"
                ? "Could not start the service update"
                : "Could not check for service updates",
            description: errorText(error, "The update agent did not answer."),
          }),
        );
      })
      .finally(() => setServicePending(false));
  }, [bridge, serviceAction]);

  if (!supported || preferences === null) return null;
  // The build keeps self-update off: the switches report what runs (nothing)
  // and cannot be turned on from here.
  const locked = preferences.automaticUpdatesAllowed === false;

  return (
    <>
      <SettingsRow
        {...searchableSetting("app-updates")}
        description={
          locked
            ? "Automatic updates are off in this build, for this app and the SpecWithCode service on this computer. Check now still works."
            : "Look for new SpecWithCode releases every hour, for this app and the SpecWithCode service on this computer."
        }
        control={
          <Switch
            checked={preferences.checkAutomatically}
            disabled={locked}
            onCheckedChange={(checked) => change({ checkAutomatically: checked })}
            aria-label="Check for updates automatically"
          />
        }
      />
      <SettingsRow
        title="Download in the background"
        description="Fetch and verify a new release as soon as it is found."
        control={
          <Switch
            checked={preferences.downloadAutomatically}
            disabled={locked || !preferences.checkAutomatically}
            onCheckedChange={(checked) => change({ downloadAutomatically: checked })}
            aria-label="Download updates in the background"
          />
        }
      />
      <SettingsRow
        title="Install automatically"
        description="The app updates the next time you quit it. The service updates once no session has worked for 10 minutes. Off means you install from here."
        control={
          <Switch
            checked={preferences.installAutomatically}
            disabled={locked || !preferences.checkAutomatically}
            onCheckedChange={(checked) => change({ installAutomatically: checked })}
            aria-label="Install updates automatically"
          />
        }
      />
      {serviceState && serviceState.status !== "not-managed" ? (
        <SettingsRow
          title="SpecWithCode service"
          description={describeServiceUpdate(serviceState)}
          control={
            serviceAction === "none" ? null : (
              <Button
                size="sm"
                variant="outline"
                disabled={servicePending}
                onClick={runServiceAction}
              >
                {serviceAction === "install" ? "Install now" : "Check now"}
              </Button>
            )
          }
        />
      ) : null}
    </>
  );
}
