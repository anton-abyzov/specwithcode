import { ManagedUpdatesSection } from "./ManagedUpdatesSection";
import { usePrimaryEnvironment } from "../../state/environments";
import type {
  DesktopUpdatePreferences,
  DesktopUpdatePreferencesPatch,
  StudioServiceUpdateState,
} from "@specweave-studio/contracts";
import { useCallback, useEffect, useState } from "react";

import { startServiceUpdateNow, useServiceUpdateFlow } from "../serviceUpdateFlow";
import { canRetryServiceUpdate } from "../sidebar/SidebarRestartToUpdate.logic";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  describeServiceUpdate,
  resolveServiceUpdateAction,
} from "./UpdatePreferencesSection.logic";
import {
  FORCE_INSTALL_AFTER_OPTIONS,
  forceInstallAfterLabel,
  forceInstallAfterMinutes,
} from "../sidebar/restartHoldWindow";

const errorText = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

/**
 * Desktop-only update controls: when Studio checks, downloads and installs
 * updates for this app and for the Studio service on this computer.
 */
export function UpdatePreferencesSection() {
  const localEnvironment = usePrimaryEnvironment();
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  const supported =
    typeof bridge?.getUpdatePreferences === "function" &&
    typeof bridge.setUpdatePreferences === "function";
  const [preferences, setPreferences] = useState<DesktopUpdatePreferences | null>(null);
  const [serviceState, setServiceState] = useState<StudioServiceUpdateState | null>(null);
  const [servicePending, setServicePending] = useState(false);
  const serviceUpdate = useServiceUpdateFlow(serviceState);

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
  // An install already under way is followed in its toast; it is not started twice.
  const serviceUpdateBusy =
    serviceUpdate.starting ||
    (serviceUpdate.progress !== null && !canRetryServiceUpdate(serviceUpdate.progress));
  const runServiceAction = useCallback(() => {
    if (!bridge || serviceAction === "none") return;
    if (serviceAction === "install") {
      // The same "Update now" as the sidebar: stop and hold the work, then install.
      if (typeof bridge.installServiceUpdate !== "function") return;
      setServicePending(true);
      void startServiceUpdateNow(serviceState)
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not start the service update",
              description: errorText(error, "The update agent did not answer."),
            }),
          );
        })
        .finally(() => setServicePending(false));
      return;
    }
    const request = bridge.checkServiceUpdate;
    if (typeof request !== "function") return;
    setServicePending(true);
    void request()
      .then(setServiceState)
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not check for service updates",
            description: errorText(error, "The update agent did not answer."),
          }),
        );
      })
      .finally(() => setServicePending(false));
  }, [bridge, serviceAction, serviceState]);

  if (!supported || preferences === null) return null;
  // The build keeps self-update off: the switches report what runs (nothing)
  // and cannot be turned on from here.
  const locked = preferences.automaticUpdatesAllowed === false;

  return (
    <>
      {localEnvironment && (
        <ManagedUpdatesSection
          environmentId={localEnvironment.environmentId}
          label={localEnvironment.label}
          reachable={localEnvironment.connection.phase === "connected"}
          local
        />
      )}
      <SettingsRow
        {...searchableSetting("app-updates")}
        description={
          locked
            ? "Automatic updates are off in this build, for this app and the SpecWithCode service on this computer. Check now still works."
            : "Look for new SpecWithCode releases in the background, for this app (every 10 minutes, with a notification when one is found or downloaded) and the SpecWithCode service on this computer."
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
      <SettingsRow
        title="Restart when idle waits up to"
        description="Then running work is stopped for the update, the app restarts, and running and queued threads continue after it."
        control={
          <Select
            value={String(forceInstallAfterMinutes(preferences))}
            onValueChange={(value) => {
              if (value === null) return;
              change({ forceInstallAfterMinutes: Number(value) });
            }}
          >
            <SelectTrigger aria-label="Restart when idle waits up to" className="w-32" size="sm">
              <SelectValue>
                {forceInstallAfterLabel(forceInstallAfterMinutes(preferences))}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {FORCE_INSTALL_AFTER_OPTIONS.map((minutes) => (
                <SelectItem key={minutes} value={String(minutes)}>
                  {forceInstallAfterLabel(minutes)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
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
                disabled={servicePending || (serviceAction === "install" && serviceUpdateBusy)}
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
