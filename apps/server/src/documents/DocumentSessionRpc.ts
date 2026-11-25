/** The `documents.session.*` handlers (see `WsDocumentSessionRpcGroup`). */
import {
  DOCUMENT_SESSION_RPC_METHODS,
  WsDocumentSessionRpcGroup,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

import { RpcInstrumentation } from "../observability/RpcInstrumentation.ts";
import * as DocumentSession from "./DocumentSession.ts";

/**
 * Registered in server.ts, like the project sync handlers, to keep ws.ts's
 * handler graph small. The group's middleware has already held the call to the
 * scopes its access asks for: "edit" and every update need filesystem:write.
 */
export const layerRpcHandlers = WsDocumentSessionRpcGroup.middleware(RpcInstrumentation).toLayer(
  Effect.gen(function* () {
    const sessions = yield* DocumentSession.DocumentSession;
    return {
      [DOCUMENT_SESSION_RPC_METHODS.documentSessionOpen]: (input) => sessions.open(input),
      [DOCUMENT_SESSION_RPC_METHODS.documentSessionUpdate]: (input) => sessions.update(input),
      [DOCUMENT_SESSION_RPC_METHODS.documentSessionPresence]: (input) =>
        sessions.presence(input).pipe(Effect.as({})),
    };
  }),
);
