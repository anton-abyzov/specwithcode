import { raisesAttention } from "@specweave-studio/client-runtime/state/projectAttention";
import type { EnvironmentId } from "@specweave-studio/contracts";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import { backgroundActivityClientId } from "../lib/backgroundActivityReporter";
import {
  cachedNotificationTarget,
  isNotificationTarget,
  notificationTargetsVersion,
  ownerMachineReachable,
  readNotificationTarget,
  subscribeNotificationTargets,
} from "../notificationTarget";
import {
  useEnvironmentIds,
  usePrimaryEnvironmentId,
  useUnreachableEnvironmentIds,
} from "../state/environments";

/** As often as every app reports its activity, so a device switch shows up in counts too. */
export const TARGET_REFRESH_MS = 25_000;

/**
 * One poller for every counting surface, however many mount: each holds
 * the machines it reads, and the poller reads their union. It reads only while
 * this window is visible, since nobody sees the counts otherwise, and once more
 * when it shows again. With fewer than two machines it reads nothing.
 */
const pollHolders = new Map<symbol, readonly EnvironmentId[]>();
let pollTimer: ReturnType<typeof setInterval> | undefined;

function pageVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

function polledEnvironmentIds(): EnvironmentId[] {
  const ids = new Set<EnvironmentId>();
  for (const held of pollHolders.values()) for (const id of held) ids.add(id);
  return ids.size < 2 ? [] : [...ids];
}

function refreshTargets() {
  for (const environmentId of polledEnvironmentIds()) void readNotificationTarget(environmentId);
}

function syncPoller() {
  const wanted = pageVisible() && polledEnvironmentIds().length > 0;
  if (wanted && pollTimer === undefined) {
    refreshTargets();
    pollTimer = globalThis.setInterval(refreshTargets, TARGET_REFRESH_MS);
  } else if (!wanted && pollTimer !== undefined) {
    globalThis.clearInterval(pollTimer);
    pollTimer = undefined;
  }
}

function holdTargetPolling(environmentIds: readonly EnvironmentId[]): () => void {
  const key = Symbol("attention-raise");
  if (pollHolders.size === 0 && typeof document !== "undefined")
    document.addEventListener("visibilitychange", syncPoller);
  const before = new Set(polledEnvironmentIds());
  pollHolders.set(key, environmentIds);
  if (pollTimer !== undefined) {
    // A machine new to the poller is read now, not at the next tick.
    for (const environmentId of polledEnvironmentIds())
      if (!before.has(environmentId)) void readNotificationTarget(environmentId);
  }
  syncPoller();
  return () => {
    pollHolders.delete(key);
    syncPoller();
    if (pollHolders.size === 0 && typeof document !== "undefined")
      document.removeEventListener("visibilitychange", syncPoller);
  };
}

/** Whether the shared poller is running; for tests. */
export function __targetPollingActiveForTests(): boolean {
  return pollTimer !== undefined;
}

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
  const knownEnvironmentIds = useEnvironmentIds();
  const unreachableEnvironmentIds = useUnreachableEnvironmentIds();
  // Machine ids joined, so a new array with the same machines changes nothing.
  const environmentKey = knownEnvironmentIds.join("\n");
  const environmentIds = useMemo(
    () => (environmentKey === "" ? [] : (environmentKey.split("\n") as EnvironmentId[])),
    [environmentKey],
  );
  const version = useSyncExternalStore(
    subscribeNotificationTargets,
    notificationTargetsVersion,
    notificationTargetsVersion,
  );

  // With one machine there is nobody else to defer to, so nothing is read.
  useEffect(() => holdTargetPolling(environmentIds), [environmentIds]);

  return useCallback<AttentionRaise>(
    (thread, ownerMachineId) =>
      raisesAttention({
        ownEnvironmentId,
        ownerMachineId,
        isTarget: isNotificationTarget(
          cachedNotificationTarget(thread.environmentId as EnvironmentId),
          backgroundActivityClientId(),
        ),
        ownerReachable: ownerMachineReachable(
          ownerMachineId,
          environmentIds,
          unreachableEnvironmentIds,
        ),
      }),
    // oxlint-disable-next-line react/memo-dependencies -- `version` changes whenever a machine's elected device does
    [ownEnvironmentId, environmentIds, unreachableEnvironmentIds, version],
  );
}
