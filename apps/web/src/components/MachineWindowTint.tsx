import { usePrimaryEnvironment } from "../state/environments";
import { machineColorProps, useMachineIdentity } from "../studio/machineIdentity";

/**
 * Always on: a thin, semi-transparent edge of this window's machine color, so
 * it is clear at a glance which machine the window is working on. It sits
 * above the page but takes no clicks and no layout room, and it is hidden
 * from assistive technology, since the machine's name is already said where
 * the machine is shown. Its strength is set in index.css per theme.
 */
export function MachineWindowTint() {
  const environment = usePrimaryEnvironment();
  const identity = useMachineIdentity(environment?.environmentId ?? null, environment?.label);
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
