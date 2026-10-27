import type * as Layer from "effect/Layer";
import type * as McpHttpServer from "./mcp/McpHttpServer.ts";
import type * as Ws from "./ws.ts";
import type * as Server from "./server.ts";

type IsAny<T> = 0 extends 1 & T ? true : false;
type IsUnknown<T> = IsAny<T> extends true ? false : unknown extends T ? true : false;
type AssertFalse<T extends false> = T;

/** Keep the inferred producer and materialized route boundary equally strict. */
export type WebSocketLayerTypeChecks = [
  AssertFalse<IsAny<Layer.Services<typeof Ws.layer>>>,
  AssertFalse<IsUnknown<Layer.Services<typeof Ws.layer>>>,
  AssertFalse<IsAny<Layer.Services<Server.WebSocketRouteLayer>>>,
  AssertFalse<IsUnknown<Layer.Services<Server.WebSocketRouteLayer>>>,
  AssertFalse<
    typeof Ws.layer extends Layer.Layer<
      Layer.Success<typeof Ws.layer>,
      Layer.Error<typeof Ws.layer>,
      never
    >
      ? true
      : false
  >,
  AssertFalse<
    Server.WebSocketRouteLayer extends Layer.Layer<
      Layer.Success<Server.WebSocketRouteLayer>,
      Layer.Error<Server.WebSocketRouteLayer>,
      never
    >
      ? true
      : false
  >,
];

/** The MCP route joins the same graph; its requirements stay exact too. */
export type McpLayerTypeChecks = [
  AssertFalse<IsAny<Layer.Services<typeof McpHttpServer.layer>>>,
  AssertFalse<IsUnknown<Layer.Services<typeof McpHttpServer.layer>>>,
];
