import type { FolderCopyOfferInput } from "@specweave-studio/contracts";
import { useCallback } from "react";

import { useAtomCommand } from "../../state/use-atom-command";
import { machineHandoff } from "../../studio/machineHandoff";

/**
 * The measured Sync copy names its purpose, so two machines that both opted in may send
 * its file contents over the local network. A move never does.
 */
export const syncOfferInput = (input: FolderCopyOfferInput): FolderCopyOfferInput =>
  input.mode === "copy-only" ? { ...input, lanPurpose: "sync-measured" } : input;

/** The source's offer for a copy the person reviews in the Sync dialog. */
export function useSyncOffer() {
  const offer = useAtomCommand(machineHandoff.copyOffer, { reportFailure: false });
  return useCallback(
    (request: Parameters<typeof offer>[0]) =>
      offer({ ...request, input: syncOfferInput(request.input) }),
    [offer],
  );
}
