import type { EnvironmentMachineKind } from "@specweave-studio/contracts";

import { cn } from "~/lib/utils";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";

/**
 * The machine a thread or project runs on, by name ("M4"). The name tells machines apart;
 * the icon only says it is one, so the name always shows and the icon joins it where the
 * surface is roomy (`withIcon`: the command palette, the project picker). Sidebar rows are
 * tight and keep the name alone. A long name ends in an ellipsis.
 */
export function MachineNameTag(props: {
  readonly label: string;
  readonly kind: EnvironmentMachineKind;
  readonly withIcon?: boolean;
  readonly className?: string;
}) {
  return (
    <span
      className={cn("inline-flex min-w-0 shrink items-center gap-1", props.className)}
      data-machine-name-tag=""
    >
      {props.withIcon ? (
        <EnvironmentMachineIcon aria-hidden kind={props.kind} className="size-3 shrink-0" />
      ) : null}
      <span className="min-w-0 max-w-[10ch] truncate" title={props.label}>
        {props.label}
      </span>
    </span>
  );
}
