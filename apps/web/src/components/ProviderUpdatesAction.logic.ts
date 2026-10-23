import type {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
} from "@specweave-studio/contracts";
import {
  isProviderSettingsUpdateCandidate,
  isProviderUpdateActive,
} from "./ProviderUpdateLaunchNotification.logic";

export interface ProviderUpdateSelection {
  environmentId: EnvironmentId;
  instanceId: ProviderInstanceId;
  driver: ProviderDriverKind;
}
export interface ProviderUpdatePlanRow extends ProviderUpdateSelection {
  key: string;
  machineLabel: string;
  provider: ServerProvider;
  reason: string | null;
}
export function providerUpdateSkipReason(
  provider: ServerProvider,
  connected: boolean,
  allowed: boolean,
): string | null {
  if (!connected) return "Offline. Connect this machine and retry.";
  if (!allowed) return "Requires existing provider-management permission on this machine.";
  if (isProviderUpdateActive(provider)) return "An update is already running.";
  if (!provider.enabled || !provider.installed) return "Provider is disabled or not installed.";
  if (
    provider.compatibilityAdvisory?.latestVersionStatus === "broken" ||
    provider.compatibilityAdvisory?.latestVersionStatus === "unsupported"
  )
    return "Latest version is incompatible with this app release.";
  if (!provider.versionAdvisory?.canUpdate)
    return (
      provider.versionAdvisory?.message ??
      "Installer ownership is unknown. Update with the owning installer, then refresh Providers."
    );
  if (provider.versionAdvisory.status === "current") return "Already current.";
  if (!isProviderSettingsUpdateCandidate(provider))
    return "Latest version is unknown. Refresh Providers and retry.";
  return null;
}

/** Two independent workers, each updating one item at a time. Never recurse to peers. */
export async function runProviderUpdateBatch<T>(
  items: readonly T[],
  run: (item: T) => Promise<void>,
  cancelled: () => boolean,
) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(2, items.length) }, async () => {
      while (!cancelled()) {
        const index = next++;
        if (index >= items.length) return;
        await run(items[index]!);
      }
    }),
  );
}
