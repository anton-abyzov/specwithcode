/**
 * Reads, for any thread a project pane lists, whether its Resolve or Reopen can run from
 * this app. Each thread is checked against the machine that runs it, so a project that
 * lists threads from several machines gates every row on its own machine.
 *
 * @module useThreadResolveAccess
 */
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { AuthOrchestrationOperateScope } from "@specweave-studio/contracts";
import { useCallback, useMemo } from "react";

import { useServerConfigs } from "../state/entities";
import { useEnvironments } from "../state/environments";
import { useEnvironmentsScopeAccess } from "../state/session";
import { threadResolveAction, threadResolveBlockedReason } from "./threadResolveAccess";

export type ThreadResolveTarget = Pick<
  EnvironmentThreadShell,
  "environmentId" | "archivedAt" | "settledOverride"
>;

/**
 * Why each thread cannot be resolved or reopened from here, or null when it can.
 * `machineLabels` names the project's machines; a machine this app reaches names itself.
 */
export function useThreadResolveBlockedReason(
  machineLabels?: ReadonlyMap<string, string>,
): (thread: ThreadResolveTarget) => string | null {
  const { environments } = useEnvironments();
  const environmentIds = useMemo(
    () => environments.map((environment) => environment.environmentId),
    [environments],
  );
  // Every row of every machine reads the same grants, which the sidebar's rows already hold.
  const access = useEnvironmentsScopeAccess(environmentIds, AuthOrchestrationOperateScope);
  const configs = useServerConfigs();
  return useCallback(
    (thread) => {
      const environment = environments.find(
        (candidate) => candidate.environmentId === thread.environmentId,
      );
      const config = configs.get(thread.environmentId);
      // The member map falls back to the ID; the machine's own label is better.
      const memberLabel = machineLabels?.get(thread.environmentId);
      return threadResolveBlockedReason({
        access: access.get(thread.environmentId) ?? "unknown",
        connection: environment?.connection,
        supportsSettlement:
          config === undefined
            ? undefined
            : config.environment.capabilities.threadSettlement === true,
        environmentId: thread.environmentId,
        machineLabel:
          memberLabel === undefined || memberLabel === thread.environmentId
            ? (environment?.label ?? memberLabel)
            : memberLabel,
        ...threadResolveAction(thread),
      });
    },
    [environments, access, configs, machineLabels],
  );
}
