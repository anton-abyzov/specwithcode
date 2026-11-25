/**
 * The live document session calls on one machine's server. Changing the
 * document goes through the guarded command boundary, so a window without
 * filesystem:write never sends an update; the server refuses one all the same.
 */
import { subscribe } from "@specweave-studio/client-runtime/rpc";
import {
  createEnvironmentRpcCommand,
  createEnvironmentSubscriptionAtomFamily,
} from "@specweave-studio/client-runtime/state/runtime";
import {
  DOCUMENT_SESSION_RPC_METHODS,
  type DocumentSessionEvent,
  type DocumentSessionOpenInput,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { connectionAtomRuntime } from "../../connection/runtime";

/** Where each open session's events go, by the key the window chose for it. */
const receivers = new Map<string, (event: DocumentSessionEvent) => void>();

/** Route a session's events to `receive` until the returned function is called. */
export function receiveDocumentSession(
  sessionKey: string,
  receive: (event: DocumentSessionEvent) => void,
): () => void {
  receivers.set(sessionKey, receive);
  return () => {
    if (receivers.get(sessionKey) === receive) receivers.delete(sessionKey);
  };
}

export const documentSession = {
  /**
   * Keeps one session open while mounted. Every event is handed to the
   * session's receiver in order; the atom's own value is only the kind of the last one.
   */
  open: createEnvironmentSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "documents:session",
    subscribe: (input: DocumentSessionOpenInput) =>
      subscribe(DOCUMENT_SESSION_RPC_METHODS.documentSessionOpen, input).pipe(
        Stream.tap((event) => Effect.sync(() => receivers.get(input.sessionKey)?.(event))),
        Stream.map((event) => event.type),
      ),
  }),
  update: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "documents:session-update",
    tag: DOCUMENT_SESSION_RPC_METHODS.documentSessionUpdate,
  }),
  presence: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "documents:session-presence",
    tag: DOCUMENT_SESSION_RPC_METHODS.documentSessionPresence,
  }),
};
