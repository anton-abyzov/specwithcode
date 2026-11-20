import { useCallback, useRef, useState } from "react";
import type { HandoffFolderMethod } from "../../studio/folderCopy";
import type { MachineHandoffOpenRequest } from "./ProjectMachineHandoff";

/**
 * The machine menu's request to open the handoff dialog. It is held only until the dialog
 * takes it: a dialog mounted again later (the window switched machine and back) finds no
 * request, so nothing opens without a new click.
 */
export function useMachineHandoffRequest() {
  const [request, setRequest] = useState<MachineHandoffOpenRequest | null>(null);
  const seq = useRef(0);
  /**
   * `target` names the machine's copy for "sync" (`${environmentId}:${projectId}`); `method`
   * replaces the default way files travel, "copy" for the measured per-file compare.
   */
  const ask = useCallback(
    (mode: MachineHandoffOpenRequest["mode"], target?: string, method?: HandoffFolderMethod) => {
      seq.current += 1;
      setRequest({
        mode,
        seq: seq.current,
        ...(target ? { target } : {}),
        ...(method ? { method } : {}),
      });
    },
    [],
  );
  /** The dialog acted on this request; a newer one stays. */
  const handled = useCallback(
    (done: MachineHandoffOpenRequest) =>
      setRequest((current) => (current?.seq === done.seq ? null : current)),
    [],
  );
  return { request, ask, handled };
}
