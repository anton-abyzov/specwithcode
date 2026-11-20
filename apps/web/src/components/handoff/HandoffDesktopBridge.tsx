import { DESKTOP_HANDOFF_MACHINE_ACTION } from "@specweave-studio/contracts";
import { useEffect } from "react";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { awayIntentForMenuAction, requestAway } from "../../studio/awayRequest";
import { requestHandOffMachine } from "./HandOffMachineDialog";

/**
 * Desktop menu actions: "Move Running Threads..." opens the dialog. "Leave
 * This Machine..." and "Bring Work Back", from the File menu or the tray, open
 * the Away dialog. The Mac going to sleep is not an action: it moves nothing.
 */
export function HandoffDesktopBridge() {
  const environmentId = usePrimaryEnvironmentId();
  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") return;
    const unsubscribe = onMenuAction((action) => {
      const intent = awayIntentForMenuAction(action);
      if (intent !== null) requestAway(intent);
    });
    return () => unsubscribe?.();
  }, []);
  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function" || environmentId === null) return;
    const unsubscribe = onMenuAction((action) => {
      if (action === DESKTOP_HANDOFF_MACHINE_ACTION) requestHandOffMachine(environmentId);
    });
    return () => unsubscribe?.();
  }, [environmentId]);
  return null;
}
