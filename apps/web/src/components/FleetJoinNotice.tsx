import type { EnvironmentId } from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";
import { useEffect } from "react";

import { getLocalStorageItem, setLocalStorageItem } from "../hooks/useLocalStorage";
import { useTx } from "../i18n";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useStudioFleet } from "../studio/fleet";
import { accountJoinsToAnnounce } from "../studio/fleetJoinNotice";
import { toastManager } from "./ui/toast";

// Joins already announced in this launch, so a remount or a blocked store does not repeat one.
const announced = new Set<string>();

/**
 * Tells the owner that another of their machines joined this one through
 * their SpecWithCode Connect account. Nothing to accept: the join is done.
 */
export function FleetJoinNotice() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  if (primaryEnvironmentId === null) return null;
  return <PrimaryFleetJoinNotice environmentId={primaryEnvironmentId} />;
}

function PrimaryFleetJoinNotice({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const { snapshot } = useStudioFleet(environmentId);
  const tx = useTx();
  useEffect(() => {
    const key = `studio:fleet-account-joins-seen:v1:${environmentId}`;
    let seenUntil: string | null = null;
    try {
      seenUntil = getLocalStorageItem(key, Schema.String);
    } catch {
      // An unavailable store must not prevent the notice.
    }
    const fresh = accountJoinsToAnnounce(snapshot, seenUntil, Date.now()).filter(
      (entry) => !announced.has(`${environmentId}:${entry.id}:${entry.joinedAt}`),
    );
    if (fresh.length === 0) return;
    for (const entry of fresh) {
      announced.add(`${environmentId}:${entry.id}:${entry.joinedAt}`);
      toastManager.add({
        type: "info",
        title: tx("{label} joined", { label: entry.label }),
        description: tx(
          "It was added through your SpecWithCode Connect account, and agents on this machine can now run work on it. Nothing to accept. You can change or remove it in Settings > Machines.",
        ),
        timeout: 0,
      });
    }
    try {
      setLocalStorageItem(key, fresh[fresh.length - 1]!.joinedAt, Schema.String);
    } catch {
      // The in-memory marker still prevents repeats during this launch.
    }
  }, [environmentId, snapshot, tx]);
  return null;
}
