import type * as Layer from "effect/Layer";
import type * as Ws from "./ws.ts";
import type { WebSocketRouteLayer } from "./server.ts";

type IsAny<T> = 0 extends 1 & T ? true : false;
type IsUnknown<T> = IsAny<T> extends true ? false : unknown extends T ? true : false;
type AssertFalse<T extends false> = T;

/** Keep the inferred producer and materialized route boundary equally strict. */
export type WebSocketLayerTypeChecks = [
  AssertFalse<IsAny<Layer.Services<typeof Ws.layer>>>,
  AssertFalse<IsUnknown<Layer.Services<typeof Ws.layer>>>,
  AssertFalse<IsAny<Layer.Services<WebSocketRouteLayer>>>,
  AssertFalse<IsUnknown<Layer.Services<WebSocketRouteLayer>>>,
  AssertFalse<typeof Ws.layer extends Layer.Layer<Layer.Success<typeof Ws.layer>, Layer.Error<typeof Ws.layer>, never> ? true : false>,
  AssertFalse<WebSocketRouteLayer extends Layer.Layer<Layer.Success<WebSocketRouteLayer>, Layer.Error<WebSocketRouteLayer>, never> ? true : false>,
];
