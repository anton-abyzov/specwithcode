import type { ScopedThreadRef } from "@specweave-studio/contracts";
import { ChevronDownIcon } from "lucide-react";
import { requestHandOffThread } from "../handoff/HandOffThreadDialog";
import { useHandoffDestinations } from "../handoff/useHandoffDestinations";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { cn } from "~/lib/utils";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { machineShortCharsProps, useMachineNameFit } from "../machineNameFit";
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
 * It wears the machine's color. The machine and the model are the two things
 * the toolbar keeps readable: the chip counts at its full width, so other
 * controls fold into the overflow menu and the composer's foot wraps onto a
 * second row before "Runs on <machine>" is cut. Only a name too long for its
 * cap shortens, to an ellipsis and then to its short label ("M4", "LM") in
 * the same tint. It never shrinks to the icon alone; the tooltip and
 * accessible name stay full.
 */
const RUNS_ON = "Runs on ";

/** Fits "Runs on <name>" to the room it has, counting only the machine's name. */
function useThreadMachineFit(machine: ThreadMachine) {
  const fit = useMachineNameFit<HTMLSpanElement>(`${RUNS_ON}${machine.label}`, RUNS_ON.length);
  const short = machine.short ?? machine.label;
  return {
    ref: fit.ref,
    rootProps: {
      ...(fit.compact ? { "data-machine-compact": "" } : {}),
      ...machineShortCharsProps(short),
    },
    shortLabel: (
      <span aria-hidden data-machine-short="" data-thread-machine-short="">
        {short}
      </span>
    ),
  };
}
export function ThreadMachineComposerChip({
  machine,
  size,
  threadRef,
}: {
  readonly threadRef?: ScopedThreadRef | null;
  readonly machine: ThreadMachine;
  readonly size: ComposerControlSize;
}) {
  if (threadRef && machine.canMove)
    return <ThreadMachineMenu machine={machine} size={size} threadRef={threadRef} />;
  return <ThreadMachineLabel machine={machine} size={size} />;
}

function ThreadMachineLabel({
  machine,
  size,
}: {
  machine: ThreadMachine;
  size: ComposerControlSize;
}) {
  const fit = useThreadMachineFit(machine);
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <ComposerControl
              size={size}
              // A role that can carry the label: with no room the name is hidden and the label says it.
              render={<span tabIndex={0} role="group" />}
              aria-label={`${machine.tip}${machine.warning ? ` ${machine.warning}.` : ""}`}
              data-thread-machine-chip=""
              {...(machine.color ? { "data-machine-color": machine.color } : {})}
              {...fit.rootProps}
              className={cn(
                "max-w-48 shrink cursor-default overflow-hidden",
                machine.color ? "machine-chip font-semibold" : "hover:bg-transparent",
              )}
            />
          }
        >
          <EnvironmentMachineIcon
            aria-hidden
            data-machine-full=""
            kind={machine.kind}
            className={cn(
              size === "xs" ? "size-3.5" : "size-4",
              machine.warning ? "text-warning-foreground" : machine.color && "text-current",
            )}
          />
          <span
            ref={fit.ref}
            className="min-w-0 truncate"
            data-thread-machine-name=""
            data-machine-full=""
            data-machine-name-slot=""
          >
            {RUNS_ON}
            {machine.label}
          </span>
          {fit.shortLabel}
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

function ThreadMachineMenu({
  machine,
  size,
  threadRef,
}: {
  machine: ThreadMachine;
  size: ComposerControlSize;
  threadRef: ScopedThreadRef;
}) {
  const destinations = useHandoffDestinations(threadRef.environmentId, false);
  const fit = useThreadMachineFit(machine);
  return (
    <>
      <Menu>
        <MenuTrigger
          render={<ComposerControl size={size} />}
          data-thread-machine-chip=""
          data-machine-color={machine.color}
          {...fit.rootProps}
          className="machine-chip max-w-48 overflow-hidden"
          aria-label={`Runs on ${machine.label}. Choose a machine`}
        >
          <EnvironmentMachineIcon
            aria-hidden
            data-machine-full=""
            kind={machine.kind}
            className="size-4 shrink-0"
          />
          <span
            ref={fit.ref}
            className="min-w-0 truncate"
            data-thread-machine-name=""
            data-machine-full=""
            data-machine-name-slot=""
          >
            {RUNS_ON}
            {machine.label}
          </span>
          {fit.shortLabel}
          {machine.warning ? (
            <span className="text-xs text-warning-foreground">{machine.warning}</span>
          ) : null}
          <ChevronDownIcon aria-hidden className="size-3 shrink-0" />
        </MenuTrigger>
        <MenuPopup align="start">
          <MenuItem disabled>Runs on {machine.label}</MenuItem>
          {destinations.map((destination) => (
            <MenuItem
              key={destination.environmentId}
              disabled={destination.state === "offline"}
              onClick={() =>
                requestHandOffThread(threadRef, {
                  destinationEnvironmentId: destination.environmentId,
                })
              }
            >
              Move to {destination.label}
              {destination.reason ? ` · ${destination.reason}` : ""}
            </MenuItem>
          ))}
          {!destinations.length ? (
            <p className="px-2 py-1 text-sm text-muted-foreground">No other machines connected</p>
          ) : null}
        </MenuPopup>
      </Menu>
      <ComposerControlSeparator size={size} data-thread-machine-separator="" />
    </>
  );
}
