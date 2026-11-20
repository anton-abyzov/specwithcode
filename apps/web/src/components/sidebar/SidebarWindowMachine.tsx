import { useTx } from "../../i18n";
import { useEnvironment, usePrimaryEnvironmentId } from "../../state/environments";
import { machineColorProps, useMachineIdentity } from "../../studio/machineIdentity";
import { windowMachineWords } from "../../studio/machineLabels";
import { useMachineNickname } from "../../studio/machineNickname";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";

/**
 * The sidebar header's "Window on M5": the machine this window is served by, in its colour.
 * Every page may show another machine's work, so the window's own machine is always named
 * (1427 AC-05). Nothing until the window knows its machine.
 */
export function SidebarWindowMachine() {
  const tx = useTx();
  const environmentId = usePrimaryEnvironmentId();
  const environment = useEnvironment(environmentId);
  const name = useWindowMachineName();
  const identity = useMachineIdentity(environmentId, environment?.label);
  if (environmentId === null || name === null) return null;
  const words = windowMachineWords(name);
  return (
    <span
      className="machine-chip relative z-10 inline-flex h-6 min-w-0 shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-border px-2 text-2xs text-muted-foreground"
      data-window-machine=""
      {...machineColorProps(identity)}
    >
      <EnvironmentMachineIcon
        kind={identity?.icon ?? "laptop"}
        className="machine-mark size-3 shrink-0"
        aria-hidden
      />
      <span>{tx(words.text, words.values)}</span>
    </span>
  );
}

/** The name of the machine this window is served by; null until the window knows it. */
export function useWindowMachineName(): string | null {
  const environmentId = usePrimaryEnvironmentId();
  const name = useMachineNickname(environmentId, useEnvironment(environmentId)?.label);
  return environmentId === null || name === "" ? null : name;
}
