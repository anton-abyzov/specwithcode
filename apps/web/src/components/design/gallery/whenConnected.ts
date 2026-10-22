/**
 * The gallery renders from the cached shell snapshot before this machine's
 * connection is up, so a fast click can reach a command while no session
 * exists. The client then refuses the request as "not connected" without
 * sending it. Creating commands wait here for the connection instead.
 */
import type { EnvironmentId } from "@specweave-studio/contracts";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentPresentations } from "~/state/presentation";

import { waitForConnected, type ConnectionWait } from "./connectionWait";

export { connectionMessage } from "./connectionWait";

export const CONNECT_TIMEOUT_MS = 15_000;

export function whenConnected(
  environmentId: EnvironmentId,
  timeoutMs = CONNECT_TIMEOUT_MS,
): Promise<ConnectionWait> {
  const atom = environmentPresentations.presentationAtom(environmentId);
  return waitForConnected(
    {
      read: () => appAtomRegistry.get(atom)?.connection ?? null,
      subscribe: (listener) => appAtomRegistry.subscribe(atom, listener),
    },
    timeoutMs,
  );
}
