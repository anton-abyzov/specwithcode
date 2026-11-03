import type { EnvironmentId } from "@specweave-studio/contracts";
import { useCallback } from "react";

import { useEnvironments } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { projectLink } from "../../studio/projectLink";
import {
  type ServerCoverage,
  type ServerSyncPair,
  serverCoverage,
} from "../../studio/serverLinkedSync";

/**
 * For one sync pass: which of `pairs` the machines' servers keep in step, so
 * the app leaves them alone (`serverLinkedSync.ts`).
 */
export function useServerSyncCoverage(): (
  pairs: ReadonlyArray<ServerSyncPair>,
) => Promise<ServerCoverage> {
  const { environments } = useEnvironments();
  const syncStatus = useAtomCommand(projectLink.syncStatus, { reportFailure: false });
  return useCallback(
    (pairs: ReadonlyArray<ServerSyncPair>) => {
      const byId = new Map(environments.map((item) => [item.environmentId, item]));
      const capable = (environmentId: EnvironmentId) => {
        const environment = byId.get(environmentId);
        return (
          environment?.connection.phase === "connected" &&
          environment.serverConfig?.environment.capabilities.serverLinkedSync === true
        );
      };
      return serverCoverage(pairs, {
        capable,
        now: Date.now(),
        fetchStatus: async (copy) => {
          const result = await syncStatus({
            environmentId: copy.environmentId,
            input: { projectId: copy.projectId },
          });
          return result._tag === "Success" ? result.value.pairs : null;
        },
      });
    },
    [environments, syncStatus],
  );
}
