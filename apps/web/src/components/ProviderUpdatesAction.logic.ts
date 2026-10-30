import type {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUpdateInput,
} from "@specweave-studio/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@specweave-studio/client-runtime/state/runtime";
import {
  isProviderSettingsUpdateCandidate,
  isProviderUpdateActive,
  isProviderUpdateBlockedInUse,
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

/**
 * The `updateProvider` input for one instance. `force` is set only for an
 * "Update anyway" retry after an in-use refusal; it skips the idle check.
 */
export function providerUpdateCommandInput(
  target: { readonly driver: ProviderDriverKind; readonly instanceId: ProviderInstanceId },
  options: { readonly targetVersion?: string | undefined; readonly force?: boolean } = {},
): ServerProviderUpdateInput {
  return {
    provider: target.driver,
    instanceId: target.instanceId,
    ...(options.targetVersion ? { targetVersion: options.targetVersion } : {}),
    ...(options.force ? { force: true } : {}),
  };
}

/** One plan row's outcome; `inUse` offers a forced retry for that row. */
export interface ProviderUpdateRowResult {
  text: string;
  inUse?: boolean;
}

export function describeProviderUpdateResult(
  result: AtomCommandResult<{ readonly providers: ReadonlyArray<ServerProvider> }, unknown>,
  instanceId: ProviderInstanceId,
): ProviderUpdateRowResult {
  if (result._tag === "Failure") {
    if (isAtomCommandInterrupted(result))
      return { text: "Interrupted. Refresh Providers to check the outcome." };
    throw squashAtomCommandFailure(result);
  }
  const provider = result.value.providers.find((provider) => provider.instanceId === instanceId);
  if (provider?.updateState?.status === "succeeded")
    return { text: `Updated and verified: ${provider.version ?? "version unavailable"}` };
  return {
    text: provider?.updateState?.message ?? "Could not verify update. Refresh Providers.",
    ...(provider && isProviderUpdateBlockedInUse(provider) ? { inUse: true } : {}),
  };
}

/**
 * Two independent workers, each updating one item at a time. Never recurse to
 * peers. A failing item never stops the batch: every selected item runs and
 * its error is returned with it.
 */
export async function runProviderUpdateBatch<T>(
  items: readonly T[],
  run: (item: T) => Promise<void>,
  cancelled: () => boolean,
) {
  let next = 0;
  const failures: Array<{ item: T; error: unknown }> = [];
  await Promise.all(
    Array.from({ length: Math.min(2, items.length) }, async () => {
      while (!cancelled()) {
        const index = next++;
        if (index >= items.length) return;
        try {
          await run(items[index]!);
        } catch (error) {
          failures.push({ item: items[index]!, error });
        }
      }
    }),
  );
  return failures;
}
