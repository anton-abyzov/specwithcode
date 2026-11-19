import { scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import { useMemo } from "react";

import { useThreadShell } from "../../state/entities";
import { useConnectedEnvironmentIds } from "../../state/environments";
import { useMachineNicknames } from "../../studio/machineNickname";
import { Button } from "../ui/button";
import { bringBackOffer, type BringBackOffer, type BringBackThread } from "./bringBack.logic";
import { requestHandOffThread } from "./HandOffThreadDialog";

/**
 * Bring back for the thread this window shows (1390 AC-23), or null. The
 * source's copy reads the continuation from the machine that runs it now.
 */
export function useBringBackOffer(
  thread: Omit<BringBackThread, "hasPendingApprovals" | "hasPendingUserInput"> | null,
): BringBackOffer | null {
  const connected = useConnectedEnvironmentIds();
  const machineName = useMachineNicknames();
  const own = useThreadShell(thread ? scopeThreadRef(thread.environmentId, thread.id) : null);
  const movedTo = thread?.movedTo ?? null;
  const continuation = useThreadShell(
    movedTo?.kind === "handoff" && movedTo.environmentId !== undefined
      ? scopeThreadRef(movedTo.environmentId, movedTo.threadId)
      : null,
  );
  const environmentId = thread?.environmentId ?? null;
  const id = thread?.id ?? null;
  const movedFrom = thread?.movedFrom ?? null;
  const sourceRoot = thread?.execution?.sourceRoot ?? null;
  const hasPendingApprovals = own?.hasPendingApprovals ?? false;
  const hasPendingUserInput = own?.hasPendingUserInput ?? false;
  return useMemo(
    () =>
      environmentId === null || id === null
        ? null
        : bringBackOffer({
            thread: {
              environmentId,
              id,
              movedTo,
              movedFrom,
              execution: { sourceRoot },
              hasPendingApprovals,
              hasPendingUserInput,
            },
            connected,
            continuation,
            machineName,
          }),
    [
      connected,
      continuation,
      environmentId,
      hasPendingApprovals,
      hasPendingUserInput,
      id,
      machineName,
      movedFrom,
      movedTo,
      sourceRoot,
    ],
  );
}

/** Opens the one-thread hand off back to the source, the same one a move by hand runs. */
export function BringBackButton({ offer }: { offer: BringBackOffer | null }) {
  if (offer === null) return null;
  return (
    <Button
      size="xs"
      variant="outline"
      disabled={offer.refused !== null}
      title={offer.refused ?? undefined}
      onClick={() =>
        requestHandOffThread(offer.threadRef, {
          destinationEnvironmentId: offer.destinationEnvironmentId,
        })
      }
    >
      Bring back to {offer.machine}
    </Button>
  );
}
