import { AuthSettingsWriteScope, type EnvironmentId } from "@specweave-studio/contracts";
import { useCallback, useMemo } from "react";

import { useEnvironments } from "../state/environments";
import { serverEnvironment } from "../state/server";
import { useEnvironmentsWithScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import {
  machineNicknamePatch,
  type RenameMachineLock,
  useMachineNameSources,
} from "./machineNickname";

/**
 * Renames a machine on every connected server that keeps nicknames and lets
 * this device change settings. Each server then passes the name on to its
 * paired machines, including ones this device can't reach.
 */
export function useRenameMachine(): {
  readonly lock: RenameMachineLock;
  readonly rename: (environmentId: EnvironmentId, name: string) => boolean;
} {
  const { environments } = useEnvironments();
  const persist = useAtomCommand(serverEnvironment.updateSettings, "machine rename");
  const { nicknames } = useMachineNameSources();
  const supporting = useMemo(
    () =>
      environments.filter(
        (environment) =>
          environment.connection.phase === "connected" &&
          environment.serverConfig?.environment.capabilities.machineNicknames === true,
      ),
    [environments],
  );
  const permitted = useEnvironmentsWithScope(supporting, AuthSettingsWriteScope);
  const lock: RenameMachineLock =
    supporting.length === 0 ? "unsupported" : permitted.size === 0 ? "no-access" : null;
  const rename = useCallback(
    (environmentId: EnvironmentId, name: string) => {
      if (permitted.size === 0) return false;
      const patch = machineNicknamePatch(nicknames, environmentId, name);
      for (const target of permitted) {
        void persist({ environmentId: target, input: { patch } });
      }
      return true;
    },
    [nicknames, permitted, persist],
  );
  return { lock, rename };
}
