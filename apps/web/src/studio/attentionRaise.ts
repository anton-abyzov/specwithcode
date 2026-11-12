import { raisesAttention } from "@specweave-studio/client-runtime/state/projectAttention";
import type { EnvironmentId } from "@specweave-studio/contracts";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import { backgroundActivityClientId } from "../lib/backgroundActivityReporter";
import {
  cachedNotificationTarget,
  isNotificationTarget,
  notificationTargetsVersion,
  readNotificationTarget,
  subscribeNotificationTargets,
} from "../notificationTarget";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";

/** As often as every app reports its activity, so a device switch shows up in counts too. */
const TARGET_REFRESH_MS = 25_000;

/** Whether this app counts and badges an item, given the machine that owns it. */
export type AttentionRaise = (
  thread: { readonly environmentId: string },
  ownerMachineId: string,
) => boolean;

/**
 * The raise rule for this app: it counts an item when its own machine owns
 * it, or when it is the device the serving machine elected. Until a machine's
 * choice is known, and whenever it cannot be, every item counts.
 */
export function useAttentionRaise(): AttentionRaise {
  const ownEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  // Machine ids joined, so a new environments array with the same machines changes nothing.
  const environmentKey = environments.map((environment) => environment.environmentId).join("\n");
  const reachableKey = environments
    .filter((environment) => environment.connection?.phase === "connected")
    .map((environment) => environment.environmentId)
    .join("\n");
  const environmentIds = useMemo(
    () => (environmentKey === "" ? [] : (environmentKey.split("\n") as EnvironmentId[])),
    [environmentKey],
  );
  const reachable = useMemo(
    () => new Set(reachableKey === "" ? [] : reachableKey.split("\n")),
    [reachableKey],
  );
  const version = useSyncExternalStore(
    subscribeNotificationTargets,
    notificationTargetsVersion,
    notificationTargetsVersion,
  );

  // With one machine there is nobody else to defer to, so nothing is read.
  useEffect(() => {
    if (environmentIds.length < 2) return;
    const refresh = () => {
      for (const environmentId of environmentIds) void readNotificationTarget(environmentId);
    };
    refresh();
    const timer = globalThis.setInterval(refresh, TARGET_REFRESH_MS);
    return () => globalThis.clearInterval(timer);
  }, [environmentIds]);

  return useCallback<AttentionRaise>(
    (thread, ownerMachineId) =>
      raisesAttention({
        ownEnvironmentId,
        ownerMachineId,
        isTarget: isNotificationTarget(
          cachedNotificationTarget(thread.environmentId as EnvironmentId),
          backgroundActivityClientId(),
        ),
        ownerReachable: reachable.has(ownerMachineId),
      }),
    // oxlint-disable-next-line react/memo-dependencies -- `version` changes whenever a machine's elected device does
    [ownEnvironmentId, reachable, version],
  );
}
