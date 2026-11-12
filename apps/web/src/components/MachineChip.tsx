import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";
import { machineColorProps, type MachineIdentity } from "../studio/machineIdentity";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { machineShortCharsProps, useMachineNameFit } from "./machineNameFit";

/**
 * A machine as a chip: its icon and name in its color. Where the chip has
 * shrunk too far to read the name, the icon and name give way to the machine's
 * short label ("M4", "LM"), never the icon alone; the accessible name still
 * says it in full.
 */
export function MachineChip({
  identity,
  label,
  className,
  ...props
}: Omit<ComponentProps<"span">, "children"> & {
  readonly identity: MachineIdentity;
  /** What the chip says in full, for assistive technology ("Runs on M1"). */
  readonly label?: string;
}) {
  const text = label ?? identity.name;
  const fit = useMachineNameFit<HTMLSpanElement>(text);
  return (
    <span
      {...machineColorProps(identity)}
      data-machine-chip={identity.environmentId}
      {...(fit.compact ? { "data-machine-compact": "" } : {})}
      {...machineShortCharsProps(identity.short)}
      className={cn(
        "machine-chip inline-flex h-6 max-w-40 shrink-0 items-center gap-1.5 rounded-full ps-1.5 pe-2 text-xs font-semibold",
        className,
      )}
      {...props}
    >
      <EnvironmentMachineIcon
        kind={identity.icon}
        className="size-3.5 shrink-0"
        aria-hidden
        data-machine-full=""
      />
      <span
        ref={fit.ref}
        className="min-w-0 truncate"
        data-machine-full=""
        data-machine-name-slot=""
      >
        {text}
      </span>
      {fit.compact ? <span className="sr-only">{text}</span> : null}
      <span aria-hidden data-machine-short="">
        {identity.short}
      </span>
    </span>
  );
}
