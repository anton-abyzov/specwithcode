import {
  AuthSettingsWriteScope,
  formatStorageFreeSpace,
  type EnvironmentId,
  type ServerCleanOldAppVersionsResult,
} from "@specweave-studio/contracts";
import * as Cause from "effect/Cause";
import { useState } from "react";

import { toastManager } from "../components/ui/toast";
import { serverEnvironment } from "../state/server";
import { readEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";

/** What one cleanup did, as Storage and the low disk card say it. */
export function describeOldAppVersionsCleanup(result: ServerCleanOldAppVersionsResult): string {
  if (result.skipped === "update-pending")
    return "An update is in progress. Try again when it finishes.";
  if (result.skipped !== undefined)
    return "Nothing was removed: this machine could not tell which versions are in use.";
  if (result.removedCount === 0)
    return result.failedCount === 0
      ? "No old app versions to remove."
      : "The old app versions are still in use, so they were kept.";
  const versions =
    result.removedCount === 1 ? "1 old app version" : `${result.removedCount} old app versions`;
  const kept =
    result.failedCount === 0
      ? ""
      : ` Kept ${result.failedCount === 1 ? "1 version" : `${result.failedCount} versions`} still in use.`;
  return `Removed ${versions} and freed ${formatStorageFreeSpace(result.freedBytes)}.${kept}`;
}

/** One-click removal of a machine's old app versions; reports the outcome in a toast. */
export function useCleanOldAppVersions() {
  const command = useAtomCommand(serverEnvironment.cleanOldAppVersions, { reportFailure: false });
  const [pending, setPending] = useState<ReadonlySet<EnvironmentId>>(new Set());
  const clean = async (environmentId: EnvironmentId) => {
    if (!readEnvironmentScope(environmentId, AuthSettingsWriteScope)) {
      toastManager.add({
        type: "error",
        title: "Could not clean up",
        description: "This connection cannot change this machine's storage.",
      });
      return;
    }
    setPending((current) => new Set(current).add(environmentId));
    try {
      const result = await command({ environmentId, input: {} });
      if (result._tag === "Failure") {
        toastManager.add({
          type: "error",
          title: "Could not clean up",
          description: String(Cause.squash(result.cause)),
        });
        return;
      }
      toastManager.add({
        type: result.value.removedCount > 0 ? "success" : "info",
        title: "Old app versions",
        description: describeOldAppVersionsCleanup(result.value),
      });
    } finally {
      setPending((current) => {
        const next = new Set(current);
        next.delete(environmentId);
        return next;
      });
    }
  };
  return { clean, isPending: (environmentId: EnvironmentId) => pending.has(environmentId) };
}
