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
 * The machine a sent chat runs on, as the chat itself shows it. The label is
 * not a picker: a chat is moved only by "Hand off to…" in its thread menu,
 * which continues it on the other machine and leaves this copy read-only, so
 * one label covers every turn, command, file and terminal in it.
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

/**
 * "available": the menu has an enabled "Hand off to…". "continued": it is
 * greyed out because the chat already continued elsewhere. "private": a
 * personal assistant's chat, which never leaves its machine. "none": the
 * machine has no handoff mode, or its state is not known yet.
 */
export type ThreadMachineHandoff = "available" | "continued" | "private" | "none";

const HANDOFF_TIPS: Record<ThreadMachineHandoff, string> = {
  available:
    " To move it, choose Hand off to… from the thread's menu: click its title or ⋯, or right-click it in the sidebar.",
  continued: " It already continued on another machine, so this copy stays here.",
  private: " A personal assistant's chats stay on their machine.",
  none: "",
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
  /** How the thread's own menu offers "Hand off to…" now; the tip says no more than that. */
  readonly handoff: ThreadMachineHandoff;
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
      (unreachable ? ` ${status.text}.` : "") +
      // The menu greys out "Hand off to…" for a viewer who cannot operate the machine.
      HANDOFF_TIPS[input.handoff === "available" && !input.canOperate ? "none" : input.handoff],
    warning,
  };
}

export function useThreadMachine(
  environmentId: EnvironmentId | null,
  handoff: ThreadMachineHandoff,
): ThreadMachine | null {
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
      handoff,
    });
  }, [environment, nameOf, canOperate, handoff]);
}
