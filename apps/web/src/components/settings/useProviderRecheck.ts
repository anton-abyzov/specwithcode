import type {
  EnvironmentId,
  ProviderInstanceId,
  ServerProvider,
} from "@specweave-studio/contracts";
import { useEffect, useRef } from "react";

import { LIVE_REFRESH_MIN_INTERVAL_MS, useLiveRefresh } from "../../hooks/useLiveRefresh";
import { getOnboardingProviderState } from "../../onboarding/providerReadiness.logic";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * The agents worth reading again when someone opens Settings > Providers or
 * comes back to it: each one that is on and not ready for want of an install,
 * a sign-in or something else. One that is ready, off or has no driver here is
 * left alone.
 */
export function providerInstancesToRecheck(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ProviderInstanceId> {
  return providers
    .filter((provider) => {
      if (!provider.enabled || provider.availability === "unavailable") return false;
      const state = getOnboardingProviderState(provider);
      return state === "install" || state === "signIn" || state === "attention";
    })
    .map((provider) => provider.instanceId);
}

/** When each machine's agents were last read this way, so arrivals together cost one read. */
const lastRecheckedAt = new Map<string, number>();

/** Whether a machine's agents may be read again now: at most once every 10 seconds. */
export function shouldRecheckProviders(now: number, last: number | undefined): boolean {
  return last === undefined || now - last >= LIVE_REFRESH_MIN_INTERVAL_MS;
}

/**
 * Reads the agents that are not ready again when the page opens and when its
 * window comes back, so an agent installed or signed in elsewhere shows at once.
 * Failures stay quiet: the rows keep what they last said.
 */
export function useProviderRecheck(
  environmentId: EnvironmentId,
  providers: ReadonlyArray<ServerProvider>,
  enabled: boolean,
): void {
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const targets = providerInstancesToRecheck(providers);
  const targetsKey = targets.join("\n");
  const recheck = useRef<() => void>(() => {});
  recheck.current = () => {
    if (!enabled || targets.length === 0) return;
    const now = Date.now();
    if (!shouldRecheckProviders(now, lastRecheckedAt.get(environmentId))) return;
    lastRecheckedAt.set(environmentId, now);
    for (const instanceId of targets) {
      void refreshProviders({ environmentId, input: { instanceId } });
    }
  };

  // Opening the page: once, when the first rows that need it are known.
  const openedFor = useRef<string | null>(null);
  useEffect(() => {
    if (openedFor.current === environmentId || !enabled || targetsKey === "") return;
    openedFor.current = environmentId;
    recheck.current();
  }, [enabled, environmentId, targetsKey]);

  // Coming back to the window.
  useLiveRefresh(() => recheck.current(), {
    enabled: enabled && targetsKey !== "",
    key: `provider-recheck:${environmentId}`,
  });
}
