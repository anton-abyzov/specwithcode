import { usePrimaryEnvironment } from "../state/environments";
import { machineColorProps, useMachineIdentity } from "../studio/machineIdentity";
import { useClaimedWindowMachine } from "../studio/windowMachine";

/**
 * Always on: a thin bar along the window's top edge in the color of the
 * machine doing the work in the view on screen. A coordinator or thread that
 * runs on another machine claims it (see windowMachine.ts), so the bar matches
 * that view's composer, chip and Send; elsewhere it is this window's own
 * machine. It takes no clicks and no layout room, and it is hidden from
 * assistive technology, since the machine's name is said where it is shown.
 */
export function MachineWindowTint() {
  const environment = usePrimaryEnvironment();
  const claimed = useClaimedWindowMachine();
  const environmentId = claimed ?? environment?.environmentId ?? null;
  const identity = useMachineIdentity(
    environmentId,
    environmentId === environment?.environmentId ? environment?.label : undefined,
  );
  if (!identity) return null;
  return (
    <div
      aria-hidden
      className="machine-window-tint"
      data-machine-window-tint={identity.environmentId}
      {...machineColorProps(identity)}
    />
  );
}
