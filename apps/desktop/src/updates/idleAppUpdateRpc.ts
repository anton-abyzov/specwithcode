import { issueRemoteWebSocketTicket } from "@specweave-studio/client-runtime/authorization";
import {
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  WS_METHODS,
  WsRpcGroup,
  type ServerPrepareServiceUpdateInput,
} from "@specweave-studio/contracts";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { RpcClient } from "effect/rpc";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";
import type { LocalServerTarget } from "../app/DesktopHandoffSleep.ts";

/** Authenticated local RPC, without opening the service database or a renderer. */
export const prepareIdleAppUpdate = (
  target: LocalServerTarget,
  payload: ServerPrepareServiceUpdateInput,
) =>
  Effect.gen(function* () {
    const ticket = yield* issueRemoteWebSocketTicket({
      httpBaseUrl: target.httpBaseUrl.href,
      bearerToken: target.bearerToken,
      timeoutMs: 5_000,
    });
    const url = new URL("/ws", target.httpBaseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("wsTicket", ticket.ticket);
    url.searchParams.set(
      ORCHESTRATION_PROTOCOL_QUERY_PARAM,
      String(ORCHESTRATION_PROTOCOL_VERSION),
    );
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const client = yield* RpcClient.make(WsRpcGroup);
        return yield* client[WS_METHODS.serverPrepareServiceUpdate](payload);
      }),
    ).pipe(
      Effect.provide(
        Layer.effect(
          RpcClient.Protocol,
          RpcClient.makeProtocolSocket({
            retryTransientErrors: false,
            retryPolicy: Schedule.recurs(0),
          }),
        ).pipe(
          Layer.provide(
            Layer.mergeAll(
              Socket.layerWebSocket(url.href, { openTimeout: Duration.seconds(5) }).pipe(
                Layer.provide(NodeSocket.layerWebSocketConstructor),
              ),
              RpcSerialization.layerJson,
            ),
          ),
        ),
      ),
    );
  }).pipe(
    Effect.timeout(Duration.seconds(10)),
    Effect.catchCause(() => Effect.succeed(null)),
  );
