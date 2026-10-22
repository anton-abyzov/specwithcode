import { WS_METHODS, WsDesignSystemImportRpcGroup } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

import { RpcInstrumentation } from "../../observability/RpcInstrumentation.ts";
import { DesignSystemService, type DesignSystemCaller } from "./DesignSystemService.ts";

/**
 * The `designSystem.*` import handlers for one connection. Every RPC caller
 * is the user; the session decides the access level the same way the design
 * handlers do (`designCallerForSession`), which the caller passes in.
 */
export const layerRpcHandlers = (caller: DesignSystemCaller) =>
  WsDesignSystemImportRpcGroup.middleware(RpcInstrumentation).toLayer(
    Effect.gen(function* () {
      const systems = yield* DesignSystemService;
      return {
        [WS_METHODS.designSystemScan]: (input) => systems.scan(caller, input),
        [WS_METHODS.designSystemPropose]: (input) => systems.propose(caller, input),
        [WS_METHODS.designSystemProposals]: (input) => systems.proposals(caller, input.filter),
        [WS_METHODS.designSystemProposal]: (input) => systems.getProposal(caller, input.proposalId),
        [WS_METHODS.designSystemConfirm]: (input) => systems.confirm(caller, input),
        [WS_METHODS.designSystemDiscard]: (input) => systems.discard(caller, input.proposalId),
        [WS_METHODS.designSystemRescan]: (input) => systems.rescan(caller, input),
        [WS_METHODS.designSystemFigmaStatus]: () => systems.figmaStatus(),
      };
    }),
  );
