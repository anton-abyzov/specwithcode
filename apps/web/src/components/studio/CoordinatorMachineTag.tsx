import { LaptopIcon } from "lucide-react";

import { useTx } from "../../i18n";
import { machineColorProps, useMachineIdentity } from "../../studio/machineIdentity";
import { coordinatorTagWords } from "../../studio/machineLabels";
import { useMachineNickname } from "../../studio/machineNickname";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Tip } from "./shell/Tip";

/**
 * Beside the project title while the window shows another machine's coordinator: the tag
 * reads "linux-mini's coordinator" and, next to it, "Window on M5". Both are visible text,
 * so the page never reads as if the window were on the machine it shows (1427 AC-05).
 * Nothing while the window shows its own machine's coordinator, or its machine is unknown.
 */
export function CoordinatorMachineTag(props: {
  readonly shownEnvironmentId: string;
  readonly shownLabel?: string | null | undefined;
  readonly windowEnvironmentId: string | null;
  readonly windowLabel?: string | null | undefined;
}) {
  const tx = useTx();
  const shown = useMachineNickname(props.shownEnvironmentId, props.shownLabel);
  const identity = useMachineIdentity(props.shownEnvironmentId, props.shownLabel);
  const windowName = useMachineNickname(props.windowEnvironmentId, props.windowLabel);
  if (props.windowEnvironmentId === null || props.shownEnvironmentId === props.windowEnvironmentId)
    return null;
  const words = coordinatorTagWords({ shown, window: windowName });
  return (
    <>
      <Tip label={tx(words.tip.text, words.tip.values)}>
        <span
          className="sws-tag sws-project-machine machine-chip shrink-0"
          data-project-machine
          {...machineColorProps(identity)}
        >
          {identity ? (
            <EnvironmentMachineIcon kind={identity.icon} aria-hidden />
          ) : (
            <LaptopIcon aria-hidden />
          )}
          {tx(words.tag.text, words.tag.values)}
        </span>
      </Tip>
      <span
        className="shrink-0 whitespace-nowrap text-2xs text-muted-foreground"
        data-window-machine=""
      >
        {tx(words.window.text, words.window.values)}
      </span>
    </>
  );
}
