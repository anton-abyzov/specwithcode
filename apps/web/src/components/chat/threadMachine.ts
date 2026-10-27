import {
  resolveEnvironmentMachineKind,
  type EnvironmentId,
  type EnvironmentMachineKind,
  type ExecutionEnvironmentPlatformOs,
} from "@specweave-studio/contracts";
import { AuthOrchestrationOperateScope } from "@specweave-studio/contracts";
import { useMemo } from "react";

import { isThisMachineTarget } from "~/connection/desktopLocal";
import { isThisMachineCatchingUp, machineStatus } from "~/lib/machineStatus";
import { useMachineNicknames } from "~/studio/machineNickname";
import { useEnvironment } from "~/state/environments";
import { useEnvironmentScope } from "~/state/session";

/**
 * The machine a sent chat runs on, as the chat itself shows it. A chat never
 * moves between machines (continuing elsewhere starts a linked chat), so one
 * label covers every turn, command, file and terminal in it.
 */
export interface ThreadMachine {
  readonly kind: EnvironmentMachineKind;
  /** The machine's name as the person knows it: their nickname, else its host label. */
  readonly label: string;
  /** Says where the chat runs and why that matters, with the host name when it differs. */
  readonly tip: string;
  /** Short words for a machine the app cannot reach now, shown in the warning tone. */
  readonly warning: string | null;
}

const OS_LABELS: Record<ExecutionEnvironmentPlatformOs, string | null> = {
  darwin: "macOS",
  linux: "Linux",
  windows: "Windows",
  unknown: null,
};

export function threadMachinePresentation(input: {
  readonly name: string;
  readonly hostLabel: string;
  readonly kind: EnvironmentMachineKind;
  readonly os: ExecutionEnvironmentPlatformOs | null;
  readonly isThisMachine: boolean;
  readonly phase: Parameters<typeof machineStatus>[0]["phase"];
  readonly error: string | null;
  readonly canOperate: boolean;
}): ThreadMachine {
  const os = input.os ? OS_LABELS[input.os] : null;
  const host = input.hostLabel && input.hostLabel !== input.name ? input.hostLabel : null;
  const facts = [host, os].filter((fact): fact is string => fact !== null).join(", ");
  const where = input.isThisMachine ? `this computer, ${input.name}` : input.name;
  const status = machineStatus(
    { phase: input.phase, error: input.error },
    input.canOperate,
    input.isThisMachine,
  );
  const unreachable = input.phase !== "connected";
  const busy = input.isThisMachine && isThisMachineCatchingUp(input.phase);
  const warning = !unreachable
    ? null
    : busy
      ? null
      : input.isThisMachine
        ? status.text
        : status.retryable
          ? "Can't reach"
          : status.text;
  return {
    kind: input.kind,
    label: input.name,
    tip:
      `Runs on ${where}${facts ? ` (${facts})` : ""}. ` +
      "Its commands, files and terminal are on that machine." +
      (unreachable ? ` ${status.text}.` : ""),
    warning,
  };
}

export function useThreadMachine(environmentId: EnvironmentId | null): ThreadMachine | null {
  const environment = useEnvironment(environmentId);
  const nameOf = useMachineNicknames();
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  return useMemo(() => {
    if (environment === null) return null;
    const config = environment.serverConfig ?? null;
    return threadMachinePresentation({
      name: nameOf(environment.environmentId, environment.label),
      hostLabel: environment.label,
      kind: resolveEnvironmentMachineKind(config),
      os: config?.environment.platform.os ?? null,
      isThisMachine: isThisMachineTarget(environment.entry),
      phase: environment.connection.phase,
      error: environment.connection.error ?? null,
      canOperate,
    });
  }, [environment, nameOf, canOperate]);
}
