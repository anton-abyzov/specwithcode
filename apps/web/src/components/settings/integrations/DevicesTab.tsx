import { useTx } from "../../../i18n";
import { DeviceHostUpdates } from "../../device/DeviceHostUpdates";
import { DeviceToolVersions } from "../../device/DeviceToolVersions";
import { useScopedSettings, useUpdateScopedSettings } from "../useScopedSettings";
import { ScopedSwitch } from "../ScopedSwitch";
import { DeviceHostsSettings } from "../DeviceHostsSettings";
import { AccessGrantsList } from "../AccessGrantsList";
import { AuthSettingsWriteScope, type EnvironmentId } from "@specweave-studio/contracts";
import { useState } from "react";
import { AnimatedHeight } from "~/components/AnimatedHeight";
import { deviceEnvironment, useDeviceState } from "~/state/device";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatEnvironmentQueryError } from "~/state/query";
import {
  AgentDeviceSetupStatus,
  DeviceHubSetupStatus,
  deviceHubReadiness,
  PlatformStatus,
  platformSetupStatus,
  deviceHubDescription,
  agentDeviceDescription,
  DeviceHostDiagnostics,
} from "~/components/device/DeviceSetup";
import { toastManager } from "../../ui/toast";
import { Button } from "../../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { SettingResetButton, SettingsRow, SettingsSection } from "../settingsLayout";
import { searchableSetting } from "../settingsSearch";
import { useSettingsScope } from "../SettingsScopeContext";
import { IntegrationsMachineState, IntegrationsTabPanel } from "./IntegrationsTabStrip";

function DeviceIntegrationSettings() {
  const { search, environment: selected } = useSettingsScope();
  const settings = useScopedSettings();
  const connected = selected?.connection.phase === "connected" && selected.serverConfig !== null;
  const environmentId = connected ? selected.environmentId : null;

  return (
    <SettingsSection id="devices" title="Devices">
      <DeviceIntegrationControls
        key={`${environmentId}:${JSON.stringify(search)}`}
        environmentId={environmentId}
        enabled={settings.enableDeviceSupport}
        agentAccessEnabled={settings.enableAgentDeviceAccess}
      />
    </SettingsSection>
  );
}

export function DeviceIntegrationControls({
  environmentId,
  enabled,
  agentAccessEnabled,
}: {
  environmentId: EnvironmentId | null;
  enabled: boolean;
  agentAccessEnabled: boolean;
}) {
  const tx = useTx();
  const canConfigure = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const { state, loaded } = useDeviceState(environmentId);
  const { scope, environments, connectedEnvironments } = useSettingsScope();
  const updateSettings = useUpdateScopedSettings();
  const projectScope = scope.kind === "project" || scope.kind === "checkout";
  const anyHubEnabled = connectedEnvironments.some(
    (environment) => environment.serverConfig?.settings.enableDeviceSupport,
  );
  const configure = useAtomCommand(deviceEnvironment.configure, { reportFailure: false });
  const list = useAtomCommand(deviceEnvironment.list, { reportFailure: false });
  const [pending, setPending] = useState<
    "hub" | "check" | "agent" | "update-hub" | "update-agent" | null
  >(null);
  const { ready: hubReady, busy } = deviceHubReadiness(state);
  const localPlatformsUnavailable = state.hosts.some(
    (host) => host.kind === "local" && !host.platforms.some((platform) => platform.available),
  );
  const [platformsRevealed, setPlatformsRevealed] = useState(false);
  // Keep diagnostics visible through subsequent agent setup and refresh phases.
  if (platformsRevealed && !enabled) setPlatformsRevealed(false);
  if (
    enabled &&
    !platformsRevealed &&
    (hubReady || localPlatformsUnavailable) &&
    pending !== "hub"
  ) {
    setPlatformsRevealed(true);
  }

  const update = async (
    kind: NonNullable<typeof pending>,
    input: { enabled?: boolean; agentAccessEnabled?: boolean },
  ) => {
    if (!environmentId || !readEnvironmentScope(environmentId, AuthSettingsWriteScope)) return;
    setPending(kind);
    try {
      const results = await Promise.allSettled(
        environments.map(async (environment) => {
          if (environment.connection.phase !== "connected" || !environment.serverConfig) {
            throw new Error("Environment disconnected");
          }
          if (!readEnvironmentScope(environment.environmentId, AuthSettingsWriteScope)) {
            throw new Error("This connection cannot change device settings.");
          }
          return configure({
            environmentId: environment.environmentId,
            input: { ...input, ...(input.enabled ? { onboardingCompleted: true } : {}) },
          });
        }),
      );
      const failed = environments.filter((_, index) => {
        const result = results[index];
        return result?.status !== "fulfilled" || result.value._tag === "Failure";
      });
      if (failed.length > 0) {
        toastManager.add({
          type: "error",
          title: "Device settings not saved on all environments",
          description: `Could not update ${failed.map((environment) => environment.label).join(", ")}.`,
        });
      }
    } finally {
      setPending(null);
    }
  };

  const [updateError, setUpdateError] = useState<{ tool: "hub" | "agent"; message: string } | null>(
    null,
  );
  const localTools = state.hosts.find((host) => host.kind === "local")?.tools;
  const versionActions = (tool: "hub" | "agent") => {
    const version = localTools?.[tool];
    const needsUpdate = version && !version.installedVersions.includes(version.requiredVersion);
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap gap-2">
          {state.supportsToolUpdate && needsUpdate ? (
            <Button
              size="sm"
              disabled={!environmentId || pending !== null || busy}
              onClick={() => {
                if (!environmentId) return;
                setUpdateError(null);
                setPending(`update-${tool}`);
                void list({ environmentId, input: { updateTool: tool } })
                  .then((result) => {
                    if (result._tag === "Failure")
                      setUpdateError({
                        tool,
                        message:
                          formatEnvironmentQueryError(result.cause) ??
                          "Update failed. Check this host's network connection and try again.",
                      });
                  })
                  .finally(() => setPending(null));
              }}
            >
              {pending === `update-${tool}`
                ? tx("Updating…")
                : `Update to v${version.requiredVersion}`}
            </Button>
          ) : null}
          {state.supportsToolInspection ? (
            <Button
              size="sm"
              variant="outline"
              disabled={!environmentId || pending !== null || busy}
              onClick={() => {
                if (!environmentId) return;
                setPending("check");
                void list({ environmentId, input: { inspectOnly: true } }).finally(() =>
                  setPending(null),
                );
              }}
            >
              {pending === "check" ? tx("Checking…") : tx("Check versions")}
            </Button>
          ) : null}
        </div>
        {updateError?.tool === tool ? (
          <p role="alert" className="text-xs text-destructive-foreground">
            {updateError.message}
          </p>
        ) : null}
      </div>
    );
  };

  return (
    <>
      <SettingsRow
        {...searchableSetting("device-hub")}
        serverScoped
        settingKeys={["enableDeviceSupport"]}
        description={deviceHubDescription}
        control={
          <>
            <DeviceToolVersions
              action={versionActions("hub")}
              kind="hub"
              tools={state.hosts.find((host) => host.kind === "local")?.tools}
            />
            {pending === "hub" ? <DeviceHubSetupStatus state={state} pending compact /> : null}
            <ScopedSwitch
              settingKeys={["enableDeviceSupport"]}
              checked={enabled}
              disabled={
                !canConfigure ||
                projectScope ||
                !loaded ||
                !environmentId ||
                busy ||
                pending !== null
              }
              aria-label={tx("Device hub")}
              onCheckedChange={(checked) =>
                void update("hub", {
                  enabled: Boolean(checked),
                  ...(checked ? {} : { agentAccessEnabled: false }),
                })
              }
            />
          </>
        }
      />
      <AnimatedHeight>
        {platformsRevealed ? (
          <SettingsRow
            {...searchableSetting("device-platform-support")}
            description={
              connectedEnvironments.length > 1
                ? `Status for ${connectedEnvironments.find((environment) => environment.environmentId === environmentId)?.label}. Select an environment to inspect its simulator support.`
                : undefined
            }
            status={
              <div className="space-y-2">
                <div className="flex flex-wrap gap-x-5 gap-y-2">
                  <PlatformStatus
                    compact
                    platform="iOS"
                    status={platformSetupStatus(state, "ios")}
                  />
                  <PlatformStatus
                    compact
                    platform="Android"
                    status={platformSetupStatus(state, "android")}
                  />
                </div>
                {/* Remote hosts report their own warnings in the device host list below. */}
                <DeviceHostDiagnostics
                  hosts={state.hosts.filter((host) => host.kind === "local")}
                  hostStatuses={state.hostStatuses}
                />
              </div>
            }
            control={
              <Button
                size="sm"
                variant="outline"
                disabled={!environmentId || !enabled || busy || pending !== null}
                onClick={() => {
                  if (!environmentId) return;
                  setPending("check");
                  void list({ environmentId, input: {} }).finally(() => setPending(null));
                }}
              >
                {pending === "check" ? tx("Checking…") : tx("Refresh")}
              </Button>
            }
          />
        ) : null}
      </AnimatedHeight>
      <SettingsRow
        {...searchableSetting("agent-device-access")}
        serverScoped
        settingKeys={["enableAgentDeviceAccess"]}
        description={agentDeviceDescription}
        control={
          <>
            <DeviceToolVersions
              action={versionActions("agent")}
              kind="agent"
              tools={state.hosts.find((host) => host.kind === "local")?.tools}
            />
            {pending === "agent" ? <AgentDeviceSetupStatus state={state} pending compact /> : null}
            <ScopedSwitch
              settingKeys={["enableAgentDeviceAccess"]}
              checked={agentAccessEnabled}
              disabled={
                !canConfigure ||
                connectedEnvironments.length === 0 ||
                (!projectScope && (!loaded || !anyHubEnabled || busy)) ||
                pending !== null
              }
              aria-label={tx("Agent device access")}
              onCheckedChange={(checked) =>
                projectScope
                  ? updateSettings({ enableAgentDeviceAccess: Boolean(checked) })
                  : void update("agent", { agentAccessEnabled: Boolean(checked) })
              }
            />
          </>
        }
      >
        {environmentId && !projectScope ? (
          <AccessGrantsList kind="device" environmentId={environmentId} />
        ) : null}
      </SettingsRow>
      <MaxBootedDevicesSetting disabled={!canConfigure || projectScope || !environmentId} />
      {environmentId ? (
        <DeviceHostUpdates
          state={{ ...state, hosts: state.hosts.filter((host) => host.kind === "local") }}
          environmentId={environmentId}
        />
      ) : null}
      <DeviceHostsSettings environmentId={environmentId} />
    </>
  );
}

const MAX_BOOTED_DEVICE_CHOICES = [1, 2, 3, 4, 6, 8] as const;

function MaxBootedDevicesSetting({ disabled }: { readonly disabled: boolean }) {
  const tx = useTx();
  const limit = useScopedSettings().maxBootedDevices;
  const updateSettings = useUpdateScopedSettings();
  const label = (value: number | null) => (value === null ? "No limit" : `${value} at once`);

  return (
    <SettingsRow
      {...searchableSetting("max-booted-devices")}
      serverScoped
      settingKeys={["maxBootedDevices"]}
      description="Most simulators and emulators that may run at once on each device host. Starting another fails until one is shut down. Physical devices do not count."
      resetAction={
        !disabled && limit !== null ? (
          <SettingResetButton
            label={tx("simulator limit")}
            onClick={() => updateSettings({ maxBootedDevices: null })}
          />
        ) : null
      }
      control={
        <Select
          disabled={disabled}
          value={limit === null ? "none" : String(limit)}
          onValueChange={(value) => {
            const next = MAX_BOOTED_DEVICE_CHOICES.find((choice) => String(choice) === value);
            updateSettings({ maxBootedDevices: next ?? null });
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-40" aria-label={tx("Simulator limit")}>
            <SelectValue>{label(limit)}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem hideIndicator value="none">
              {label(null)}
            </SelectItem>
            {MAX_BOOTED_DEVICE_CHOICES.map((choice) => (
              <SelectItem hideIndicator key={choice} value={String(choice)}>
                {label(choice)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

/** Simulators and emulators on the selected machine, and what agents may do with them. */
export function DevicesTab() {
  return (
    <IntegrationsTabPanel tab="devices">
      <IntegrationsMachineState>
        <DeviceIntegrationSettings />
      </IntegrationsMachineState>
    </IntegrationsTabPanel>
  );
}
