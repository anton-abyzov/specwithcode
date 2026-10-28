import {
  DESKTOP_HANDOFF_MACHINE_ACTION,
  DESKTOP_HANDOFF_SLEEP_ACTION,
  type EnvironmentId,
} from "@specweave-studio/contracts";
import { useEffect } from "react";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { handoffMode, runHandoffMode } from "../../studio/handoffMode";
import { handleHandoffSleep } from "../../studio/handoffSleep";
import { requestHandOffMachine } from "./HandOffMachineDialog";

export function runHandoffSleep(environmentId: EnvironmentId) {
  return handleHandoffSleep(environmentId, {
    snapshot: (id) => runHandoffMode(handoffMode.snapshot, { environmentId: id, input: {} }),
    handOffMachine: (id, destinationEnvironmentId) =>
      runHandoffMode(handoffMode.handOffMachine, {
        environmentId: id,
        input: { destinationEnvironmentId, reason: "sleep" },
      }),
  });
}

/**
 * Desktop menu actions: "Move Running Threads..." opens the dialog, and the
 * Mac's 'suspend' asks the local server to move running threads to the sleep
 * target, with no dialog.
 */
export function HandoffDesktopBridge() {
  const environmentId = usePrimaryEnvironmentId();
  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function" || environmentId === null) return;
    const unsubscribe = onMenuAction((action) => {
      if (action === DESKTOP_HANDOFF_MACHINE_ACTION) requestHandOffMachine(environmentId);
      else if (action === DESKTOP_HANDOFF_SLEEP_ACTION) void runHandoffSleep(environmentId);
    });
    return () => unsubscribe?.();
  }, [environmentId]);
  return null;
}
