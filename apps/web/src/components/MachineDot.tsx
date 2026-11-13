import { cn } from "~/lib/utils";
import { machineColorProps, type MachineIdentity } from "../studio/machineIdentity";

/**
 * A machine's color as the sidebar shows it: a small square before its name.
 * Decorative; the name beside it says which machine it is.
 */
export function MachineDot({
  identity,
  className,
}: {
  identity: Pick<MachineIdentity, "color"> | null | undefined;
  className?: string;
}) {
  if (!identity) return null;
  return (
    <span
      aria-hidden
      data-machine-dot=""
      {...machineColorProps(identity)}
      className={cn("machine-dot", className)}
    />
  );
}
