import { useCallback, useRef, useState } from "react";
import type { MachineHandoffOpenRequest } from "./ProjectMachineHandoff";

/**
 * The machine menu's request to open the handoff dialog. It is held only until the dialog
 * takes it: a dialog mounted again later (the window switched machine and back) finds no
 * request, so nothing opens without a new click.
 */
export function useMachineHandoffRequest() {
  const [request, setRequest] = useState<MachineHandoffOpenRequest | null>(null);
  const seq = useRef(0);
  const ask = useCallback((mode: MachineHandoffOpenRequest["mode"], target?: string) => {
    seq.current += 1;
    setRequest({ mode, seq: seq.current, ...(target ? { target } : {}) });
  }, []);
  /** The dialog acted on this request; a newer one stays. */
  const handled = useCallback(
    (done: MachineHandoffOpenRequest) =>
      setRequest((current) => (current?.seq === done.seq ? null : current)),
    [],
  );
  return { request, ask, handled };
}
