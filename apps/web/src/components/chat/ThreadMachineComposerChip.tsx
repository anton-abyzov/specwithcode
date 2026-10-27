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
 * names the machine: a sent chat cannot move, so there is nothing to pick.
 * On a narrow composer it keeps the icon and drops the name.
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
              className="max-w-48 cursor-default hover:bg-transparent"
            />
          }
        >
          <EnvironmentMachineIcon
            aria-hidden
            kind={machine.kind}
            className={cn(
              size === "xs" ? "size-3.5" : "size-4",
              machine.warning && "text-warning-foreground",
            )}
          />
          <span className="min-w-0 truncate @max-[520px]/composer-surface:hidden">
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
