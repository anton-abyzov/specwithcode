import {
  AuthFilesystemReadScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  type EnvironmentId,
} from "@specweave-studio/contracts";
import { useMemo } from "react";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentsWithScope } from "../../state/session";
import { useMachineNicknames } from "../../studio/machineNickname";
import {
  linkMachineProblem,
  linkMachineState,
  type LinkMachineState,
} from "../../studio/projectLink";

export interface LinkMachines {
  readonly label: (environmentId: EnvironmentId) => string;
  readonly state: (environmentId: EnvironmentId) => LinkMachineState;
  /** Why this machine cannot take part in a link now, or null when it can. */
  readonly problem: (environmentId: EnvironmentId) => string | null;
  readonly connected: (environmentId: EnvironmentId) => boolean;
  /** Ready to link, and new enough to take over, give way and keep note replicas. */
  readonly takeoverReady: (environmentId: EnvironmentId) => boolean;
  /** Ready to link, and new enough to run a coordinator next to the others' (0969). */
  readonly startReady: (environmentId: EnvironmentId) => boolean;
}

/** Readiness of every connected machine for linking and unlinking projects. */
export function useLinkMachines(): LinkMachines {
  const { environments } = useEnvironments();
  const settings = useEnvironmentsWithScope(environments, AuthSettingsWriteScope);
  const operate = useEnvironmentsWithScope(environments, AuthOrchestrationOperateScope);
  const read = useEnvironmentsWithScope(environments, AuthOrchestrationReadScope);
  const files = useEnvironmentsWithScope(environments, AuthFilesystemReadScope);
  const nickname = useMachineNicknames();
  return useMemo(() => {
    const byId = new Map(environments.map((item) => [item.environmentId, item]));
    const label = (environmentId: EnvironmentId) =>
      nickname(environmentId, byId.get(environmentId)?.label ?? "Machine");
    const state = (environmentId: EnvironmentId) => {
      const environment = byId.get(environmentId);
      return linkMachineState({
        connected: environment?.connection.phase === "connected",
        supportsLink: environment?.serverConfig?.environment.capabilities.projectLink,
        canWrite:
          settings.has(environmentId) &&
          operate.has(environmentId) &&
          read.has(environmentId) &&
          files.has(environmentId),
      });
    };
    return {
      label,
      state,
      problem: (environmentId) => linkMachineProblem(state(environmentId), label(environmentId)),
      connected: (environmentId) => byId.get(environmentId)?.connection.phase === "connected",
      takeoverReady: (environmentId) =>
        state(environmentId) === "ready" &&
        byId.get(environmentId)?.serverConfig?.environment.capabilities.coordinatorTakeover ===
          true,
      startReady: (environmentId) =>
        state(environmentId) === "ready" &&
        byId.get(environmentId)?.serverConfig?.environment.capabilities.coordinatorPerMachine ===
          true,
    };
  }, [environments, settings, operate, read, files, nickname]);
}
