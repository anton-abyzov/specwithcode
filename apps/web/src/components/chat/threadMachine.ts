import {
  resolveEnvironmentMachineKind,
  type EnvironmentId,
  type EnvironmentMachineKind,
  type ExecutionEnvironmentPlatformOs,
  type MachineColorId,
} from "@specweave-studio/contracts";
import { AuthOrchestrationOperateScope } from "@specweave-studio/contracts";
import { useMemo } from "react";

import { isThisMachineTarget } from "~/connection/desktopLocal";
import { isThisMachineCatchingUp, machineStatus } from "~/lib/machineStatus";
import { useMachineIdentities } from "~/studio/machineIdentity";
import { useEnvironment } from "~/state/environments";
import { useEnvironmentScope } from "~/state/session";

/**
 * The machine a sent chat runs on, as the chat itself shows it. The label is
 * not a picker: a chat is moved only by "Move thread…" in its thread menu,
 * which continues it on the other machine and leaves this copy read-only, so
 * one label covers every turn, command, file and terminal in it.
 */
export interface ThreadMachine {
  readonly kind: EnvironmentMachineKind;
  /** The machine's name as the person knows it: their nickname, else its host label. */
  readonly label: string;
  /** Two or three characters the chip keeps when it runs out of room ("M4", "LM"). */
  readonly short?: string | undefined;
  /** Says where the chat runs and why that matters, with the host name when it differs. */
  readonly tip: string;
  /** Short words for a machine the app cannot reach now, shown in the warning tone. */
  readonly warning: string | null;
  /** The machine's color; absent where the caller has no identity for it. */
  readonly color?: MachineColorId | undefined;
  /** False for another machine: a send goes there, and the composer says so. */
  readonly isThisMachine?: boolean | undefined;
}

const OS_LABELS: Record<ExecutionEnvironmentPlatformOs, string | null> = {
  darwin: "macOS",
  linux: "Linux",
  windows: "Windows",
  unknown: null,
};

/**
 * "available": the menu has an enabled "Move thread…". "continued": it is
 * greyed out because the chat already continued elsewhere. "private": a
 * personal assistant's chat, which never leaves its machine. "none": the
 * machine has no handoff mode, or its state is not known yet.
 */
export type ThreadMachineHandoff = "available" | "continued" | "private" | "none";

const HANDOFF_TIPS: Record<ThreadMachineHandoff, string> = {
  available: " To move it, use ⋯ › Move thread.",
  continued: " It already moved to another machine, so this copy stays here to read.",
  private: " A personal assistant's chats stay on their machine.",
  none: "",
};

export function threadMachinePresentation(input: {
  readonly name: string;
  /** The machine's short label; its name stands in where none is known. */
  readonly short?: string | undefined;
  readonly hostLabel: string;
  readonly kind: EnvironmentMachineKind;
  readonly os: ExecutionEnvironmentPlatformOs | null;
  readonly isThisMachine: boolean;
  readonly phase: Parameters<typeof machineStatus>[0]["phase"];
  readonly error: string | null;
  readonly canOperate: boolean;
  /** How the thread's own menu offers "Move thread…" now; the tip says no more than that. */
  readonly handoff: ThreadMachineHandoff;
  readonly color?: MachineColorId | undefined;
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
  // The menu greys out "Move thread…" for a viewer who cannot operate the machine.
  const handoff = input.handoff === "available" && !input.canOperate ? "none" : input.handoff;
  return {
    kind: input.kind,
    label: input.name,
    short: input.short ?? input.name,
    tip:
      `Runs on ${where}${facts ? ` (${facts})` : ""}.` +
      // Where the move is offered, the tip says how to move it instead of what lives there.
      (handoff === "available" ? "" : " Its commands, files and terminal are on that machine.") +
      (unreachable ? ` ${status.text}.` : "") +
      HANDOFF_TIPS[handoff],
    warning,
    ...(input.color ? { color: input.color } : {}),
    isThisMachine: input.isThisMachine,
  };
}

export function useThreadMachine(
  environmentId: EnvironmentId | null,
  handoff: ThreadMachineHandoff,
): ThreadMachine | null {
  const environment = useEnvironment(environmentId);
  const identityOf = useMachineIdentities();
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  return useMemo(() => {
    if (environment === null) return null;
    const config = environment.serverConfig ?? null;
    const identity = identityOf(environment.environmentId, environment.label);
    return threadMachinePresentation({
      name: identity.name,
      short: identity.short,
      hostLabel: environment.label,
      // The icon chosen with the nickname, else the kind of hardware it reports.
      kind: config ? identity.icon : resolveEnvironmentMachineKind(config),
      color: identity.color,
      os: config?.environment.platform.os ?? null,
      isThisMachine: isThisMachineTarget(environment.entry),
      phase: environment.connection.phase,
      error: environment.connection.error ?? null,
      canOperate,
      handoff,
    });
  }, [environment, identityOf, canOperate, handoff]);
}
