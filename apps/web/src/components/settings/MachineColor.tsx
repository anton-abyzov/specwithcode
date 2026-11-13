import type { EnvironmentId, MachineColorId } from "@specweave-studio/contracts";
import { useState } from "react";

import { useTx } from "../../i18n";
import { cn } from "~/lib/utils";
import {
  MACHINE_COLOR_IDS,
  MACHINE_COLOR_LABELS,
  machineColorProps,
  useMachineColorWearers,
  useMachineIdentity,
} from "../../studio/machineIdentity";
import { renameMachineLockText, useCustomMachineNickname } from "../../studio/machineNickname";
import { useRenameMachine } from "../../studio/useRenameMachine";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";

const TILE_SIZE = {
  md: { tile: "size-6 rounded-md", icon: "size-3.5" },
  lg: { tile: "size-8 rounded-lg", icon: "size-4.5" },
} as const;

/**
 * The machine's icon on its color, heading its card. Pressing it opens the eight
 * colors right there, each naming the machines that already wear it, so a
 * free one is easy to find. A pick saves at once and reaches the other devices
 * with the name; the name, chip letters and icon stay where they were.
 */
export function MachineColorButton({
  environmentId,
  fallbackLabel,
  size = "md",
  className,
}: {
  environmentId: EnvironmentId;
  fallbackLabel?: string | null;
  size?: keyof typeof TILE_SIZE;
  className?: string;
}) {
  const tx = useTx();
  const identity = useMachineIdentity(environmentId, fallbackLabel);
  const custom = useCustomMachineNickname(environmentId);
  const wearers = useMachineColorWearers();
  const { lock, saveIdentity } = useRenameMachine();
  const [open, setOpen] = useState(false);
  if (!identity) return null;
  const dims = TILE_SIZE[size];
  const colorName = tx(MACHINE_COLOR_LABELS[identity.color]);
  const icon = (
    <EnvironmentMachineIcon aria-hidden kind={identity.icon} className={dims.icon} />
  );
  const tileClass = cn(
    "machine-tile inline-flex shrink-0 items-center justify-center",
    dims.tile,
    className,
  );
  if (lock !== null) {
    return (
      <span
        {...machineColorProps(identity)}
        data-machine-color-button=""
        className={tileClass}
        title={`${tx("{name} wears {color}", { name: identity.name, color: colorName })}. ${renameMachineLockText(lock) ?? ""}`.trim()}
      >
        {icon}
      </span>
    );
  }
  const pick = (color: MachineColorId) => {
    setOpen(false);
    if (color === identity.color) return;
    saveIdentity(environmentId, { name: custom ?? "", color, icon: identity.icon });
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            {...machineColorProps(identity)}
            data-machine-color-button=""
            aria-label={tx("Change the color of {name}, now {color}", {
              name: identity.name,
              color: colorName,
            })}
            title={tx("Change color")}
            className={cn(
              tileClass,
              "cursor-pointer outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
            )}
          />
        }
      >
        {icon}
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="start" width="sm" padding="compact">
        <PopoverTitle className="text-xs font-medium">
          {tx("Color of {name}", { name: identity.name })}
        </PopoverTitle>
        <div
          role="radiogroup"
          aria-label={tx("Color of {name}", { name: identity.name })}
          className="mt-2 grid grid-cols-4 gap-x-1 gap-y-2"
          data-machine-color-popover=""
        >
          {MACHINE_COLOR_IDS.map((color) => {
            const others = (wearers.get(color) ?? []).filter(
              (wearer) => wearer.environmentId !== environmentId,
            );
            const label = tx(MACHINE_COLOR_LABELS[color]);
            const worn = others.map((wearer) => wearer.short).join(" ");
            return (
              <button
                key={color}
                type="button"
                role="radio"
                aria-checked={identity.color === color}
                aria-label={
                  others.length > 0
                    ? tx("{color}, also on {names}", {
                        color: label,
                        names: others.map((wearer) => wearer.name).join(", "),
                      })
                    : label
                }
                data-machine-color-choice={color}
                className="flex min-w-0 cursor-pointer flex-col items-center gap-1 rounded-md px-0.5 py-1 outline-hidden hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => pick(color)}
              >
                <span
                  aria-hidden
                  data-machine-color={color}
                  className={cn(
                    "machine-swatch size-6 rounded-full",
                    identity.color === color && "machine-swatch-on",
                  )}
                />
                <span aria-hidden className="text-2xs text-muted-foreground">
                  {label}
                </span>
                <span
                  aria-hidden
                  className="h-3.5 max-w-full truncate text-2xs font-semibold text-foreground/80"
                  title={others.map((wearer) => wearer.name).join(", ") || undefined}
                >
                  {worn}
                </span>
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-2xs text-muted-foreground">
          {tx("Letters under a color name the machines that wear it.")}
        </p>
      </PopoverPopup>
    </Popover>
  );
}
