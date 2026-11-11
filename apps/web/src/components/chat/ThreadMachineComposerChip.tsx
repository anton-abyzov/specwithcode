import { cn } from "~/lib/utils";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  ComposerControl,
  ComposerControlSeparator,
  type ComposerControlSize,
} from "./ComposerControl";
import type { ThreadMachine } from "./threadMachine";

/**
 * The machine a sent chat runs on, first in the composer's controls, the way
 * a draft's "Run on" picker sits there before the first message. It only
 * names the machine; moving a sent chat uses Move thread in its thread menu.
 * It wears the machine's color. Its name is the first thing in the toolbar to
 * give way: it shortens to an ellipsis and then to the icon alone before any
 * other control folds into the overflow menu, and the color, the icon and the
 * tooltip go on naming the machine.
 */
export function ThreadMachineComposerChip({
  machine,
  size,
}: {
  readonly machine: ThreadMachine;
  readonly size: ComposerControlSize;
}) {
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <ComposerControl
              size={size}
              render={<span tabIndex={0} />}
              aria-label={`${machine.tip}${machine.warning ? ` ${machine.warning}.` : ""}`}
              data-thread-machine-chip=""
              {...(machine.color ? { "data-machine-color": machine.color } : {})}
              className={cn(
                "max-w-48 min-w-7 shrink cursor-default overflow-hidden",
                machine.color ? "machine-chip font-semibold" : "hover:bg-transparent",
                !machine.warning && "@max-[520px]/composer-surface:max-w-26",
              )}
            />
          }
        >
          <EnvironmentMachineIcon
            aria-hidden
            kind={machine.kind}
            className={cn(
              size === "xs" ? "size-3.5" : "size-4",
              machine.warning ? "text-warning-foreground" : machine.color && "text-current",
            )}
          />
          <span className="min-w-0 truncate" data-thread-machine-name="">
            {machine.label}
          </span>
          {machine.warning ? (
            <span className="shrink-0 text-xs text-warning-foreground">{machine.warning}</span>
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="top" className="max-w-80 break-words">
          {machine.tip}
        </TooltipPopup>
      </Tooltip>
      <ComposerControlSeparator size={size} data-thread-machine-separator="" />
    </>
  );
}
