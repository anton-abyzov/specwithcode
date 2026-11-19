/**
 * While this device waits for a machine to allow it (1327), a small row in the
 * sidebar footer says so, and "Show code" opens the floating card again after
 * the owner closed it. Gone once every machine let this device in.
 */
import { KeyRoundIcon } from "lucide-react";

import { useTx } from "../../i18n";
import { showWaitingCodes, useWaitingCodes } from "../devices/waitingCodes";

export function SidebarJoinCodePill() {
  const tx = useTx();
  const waiting = useWaitingCodes();
  const first = waiting[0];
  if (first === undefined) return null;
  const label =
    waiting.length === 1
      ? tx("Waiting for {machine}", { machine: first.machine })
      : tx("Waiting for machines to allow this device");
  return (
    <div
      data-sidebar-join-code
      className="flex min-h-7 items-center gap-1.5 rounded-lg px-2 text-2xs leading-4 text-muted-foreground [&_svg]:size-3.5 [&_svg]:shrink-0"
    >
      <KeyRoundIcon />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <button
        type="button"
        data-sidebar-join-code-show
        className="cursor-pointer rounded-sm px-1 font-medium text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
        onClick={() => showWaitingCodes()}
      >
        {tx("Show code")}
      </button>
    </div>
  );
}
