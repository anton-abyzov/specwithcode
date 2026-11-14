import { useTx } from "../../i18n";
import type { EnvironmentId } from "@specweave-studio/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@specweave-studio/client-runtime/state/runtime";
import { useState } from "react";

import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { requestConfirmDialog } from "../../confirmDialog";
import { environmentCatalog } from "~/connection/catalog";
import { useEnvironments } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { setFleetEnvironmentSkipped } from "../../studio/fleetAutoConnect";
import { noteMachineRemoved } from "../../studio/knownMachines";
import { RemoveStudioConnectEnvironmentDialog } from "../clerk/RemoveStudioConnectEnvironmentDialog";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";

/**
 * Removes an old record of a machine that joined again under a new id. It
 * forgets this device's saved pairing for the dead id only; the machine's live
 * record, its name and its Connect link are not touched.
 */
export function RemoveOldRecord({
  environmentId,
  name,
  hostLabel,
}: {
  environmentId: EnvironmentId;
  name: string;
  hostLabel: string;
}) {
  const tx = useTx();
  const remove = useAtomCommand(environmentCatalog.remove, { reportFailure: false });
  const { environments } = useEnvironments();
  // A record saved over Connect is removed through the Connect dialog, which says
  // where its account registration can be deregistered, as Saved connections does.
  const relayManaged =
    hasCloudPublicConfig() &&
    environments.some(
      (environment) => environment.environmentId === environmentId && environment.relayManaged,
    );
  const [removing, setRemoving] = useState(false);
  const [confirmingConnect, setConfirmingConnect] = useState(false);
  async function removeRecord() {
    setRemoving(true);
    // Recorded first, so automatic connection cannot add the record back in between.
    setFleetEnvironmentSkipped(environmentId, true);
    const result = await remove(environmentId);
    setRemoving(false);
    if (result._tag !== "Failure") {
      // It stops holding a name or chip letters now, though a fleet list still names it.
      noteMachineRemoved(environmentId, true);
      return;
    }
    setFleetEnvironmentSkipped(environmentId, false);
    if (isAtomCommandInterrupted(result)) return;
    const failure = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: tx("Could not remove the old record"),
        description: failure instanceof Error ? failure.message : String(failure),
      }),
    );
  }
  async function onRemove() {
    if (relayManaged) {
      setConfirmingConnect(true);
      return;
    }
    const confirmed = await requestConfirmDialog(
      tx(
        "Remove the old record of {name} ({host}) from this device?\nThis machine joined again as a new one and keeps working; only the dead record and its cached threads here go.",
        { name, host: hostLabel },
      ),
      { variant: "destructive" },
    );
    if (confirmed) await removeRecord();
  }
  return (
    <>
      <Button
        className="shrink-0"
        size="xs"
        variant="outline"
        disabled={removing}
        data-remove-old-record=""
        onClick={() => void onRemove()}
      >
        {removing ? tx("Removing…") : tx("Remove old record")}
      </Button>
      {relayManaged ? (
        <RemoveStudioConnectEnvironmentDialog
          environmentLabel={confirmingConnect ? `${name} (${hostLabel})` : null}
          onCancel={() => setConfirmingConnect(false)}
          onConfirm={() => {
            setConfirmingConnect(false);
            void removeRecord();
          }}
        />
      ) : null}
    </>
  );
}
