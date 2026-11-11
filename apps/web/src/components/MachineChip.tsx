import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";
import { machineColorProps, type MachineIdentity } from "../studio/machineIdentity";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";

/**
 * A machine as a chip: its icon and name in its color. The name can be hidden
 * (`iconOnly`) where the chip has shrunk; the accessible name still says it.
 */
export function MachineChip({
  identity,
  iconOnly = false,
  label,
  className,
  ...props
}: Omit<ComponentProps<"span">, "children"> & {
  readonly identity: MachineIdentity;
  readonly iconOnly?: boolean;
  /** What the chip says in full, for assistive technology ("Runs on M1"). */
  readonly label?: string;
}) {
  return (
    <span
      {...machineColorProps(identity)}
      data-machine-chip={identity.environmentId}
      className={cn(
        "machine-chip inline-flex h-6 max-w-40 min-w-0 shrink-0 items-center gap-1.5 rounded-full ps-1.5 pe-2 text-xs font-semibold",
        iconOnly && "pe-1.5",
        className,
      )}
      {...props}
    >
      <EnvironmentMachineIcon kind={identity.icon} className="size-3.5 shrink-0" aria-hidden />
      <span className={iconOnly ? "sr-only" : "min-w-0 truncate"}>{label ?? identity.name}</span>
    </span>
  );
}
