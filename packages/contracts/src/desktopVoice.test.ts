import { expect, it } from "vite-plus/test";

import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { WS_METHODS } from "./rpc.ts";

it("requires orchestration permission before using the configured cloud voice", () => {
  expect(clientRpcRequiredScopes(WS_METHODS.voiceSynthesize, { text: "Hello" })).toEqual([
    "orchestration:operate",
  ]);
});
