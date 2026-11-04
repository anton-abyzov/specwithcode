import type {
  EnvironmentId,
  ProviderInstanceId,
  ServerProvider,
  ServerSettings,
} from "@specweave-studio/contracts";
import { coordinatorSelectionProblem } from "@specweave-studio/shared/coordinatorDefault";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

import { useProviderQuickSetup } from "../../hooks/useProviderQuickSetup";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
} from "../../providerInstances";
import { oneClickInstallAgentId } from "../../providerQuickSetup";
import { coordinatorFixAction } from "../../studio/coordinatorFailure";
import type { CoordinatorFix } from "./CoordinatorFailureCard";

const NO_PROVIDERS: ReadonlyArray<ServerProvider> = [];
const NO_SETTINGS: Pick<ServerSettings, "providerInstances" | "providers"> = {
  providerInstances: {},
  providers: {} as ServerSettings["providers"],
};

/**
 * The one-click fix for the coordinator's provider on its machine: install a
 * registry agent there (prepare, then a fresh provider read), or open that
 * provider's setup to sign in. Null while the provider can run, so a usage
 * limit or any other failure shows no fix.
 */
export function useCoordinatorProviderFix(input: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: string | null | undefined;
  readonly model: string | null | undefined;
  readonly providers: ReadonlyArray<ServerProvider> | undefined;
  readonly settings: Pick<ServerSettings, "providerInstances" | "providers"> | undefined;
  /** The machine's name, or null when only its ID is known. */
  readonly machineLabel: string | null;
  /**
   * The failure the card shows: the failed run's ID, or a refused send's text.
   * "Installed" belongs to the failure it fixed and goes once another one shows.
   */
  readonly failureKey: string | null;
}): CoordinatorFix | null {
  const providers = input.providers ?? NO_PROVIDERS;
  const settings = input.settings ?? NO_SETTINGS;
  // Without the machine's settings yet, the snapshots alone say what is set up.
  const entries = useMemo(
    () =>
      input.settings
        ? applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), input.settings)
        : deriveProviderInstanceEntries(providers),
    [providers, input.settings],
  );
  const quickSetup = useProviderQuickSetup({
    environmentId: input.environmentId,
    entries,
    settings,
  });
  const navigate = useNavigate();
  const instanceId = input.instanceId ?? null;
  const entry = instanceId ? entries.find((item) => item.instanceId === instanceId) : undefined;
  const pending = instanceId !== null && quickSetup.pending.has(instanceId);
  const error = instanceId ? (quickSetup.errors.get(instanceId) ?? null) : null;
  const failureKey = input.failureKey;
  // "Installed" is tied to the failure the install fixed; a new failure shows its own state.
  const [installed, setInstalled] = useState<{
    readonly instanceId: string;
    readonly failureKey: string | null;
  } | null>(null);
  const wasPending = useRef(false);
  useEffect(() => {
    if (wasPending.current && !pending && error === null && instanceId !== null)
      setInstalled({ instanceId, failureKey });
    wasPending.current = pending;
  }, [pending, error, instanceId, failureKey]);
  const problem =
    instanceId === null || providers.length === 0
      ? null
      : coordinatorSelectionProblem(
            { instanceId: instanceId as ProviderInstanceId, model: input.model ?? "" },
            providers,
          ) === "provider_unavailable"
        ? "setup"
        : null;
  if (instanceId === null) return null;
  if (
    installed !== null &&
    installed.instanceId === instanceId &&
    installed.failureKey === failureKey &&
    !pending
  )
    return {
      action: { kind: "install", label: "Installed" },
      run: () => {},
      pending: false,
      error: null,
      done: true,
      allowed: quickSetup.canManage,
    };
  if (problem === null && !pending) return null;
  const action = coordinatorFixAction({
    provider: entry
      ? {
          displayName: entry.displayName,
          enabled: entry.enabled,
          installed: entry.installed,
          authStatus: entry.snapshot.auth.status,
          status: entry.status,
          oneClickInstall: oneClickInstallAgentId(entry) !== null,
        }
      : null,
    machineLabel: input.machineLabel,
  });
  if (action === null) return null;
  const openSetup = () =>
    void navigate({
      to: "/settings/providers",
      search: { environmentId: input.environmentId, instanceId: instanceId as ProviderInstanceId },
    });
  return {
    action,
    run:
      action.kind === "install"
        ? () => {
            setInstalled(null);
            quickSetup.install(instanceId as ProviderInstanceId);
          }
        : openSetup,
    pending,
    error,
    done: false,
    allowed: action.kind === "install" ? quickSetup.canManage : true,
  };
}
