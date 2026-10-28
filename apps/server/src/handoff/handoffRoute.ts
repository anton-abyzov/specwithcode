/**
 * The machine-to-machine handoff API (`/api/handoff/v1/<path>`). Only a
 * paired machine's worker credential gets in: the work grant it holds here
 * names the source, and every request must name that same source.
 */
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as WorkGrants from "../fleet/WorkGrants.ts";
import { parseJson } from "../json.ts";
import { clientRuntimeModeCeiling } from "../mcp/McpInvocationContext.ts";
import * as ServiceUpdateHold from "../serviceUpdate/ServiceUpdateHold.ts";
import { HandoffReceiver, type HandoffRefusal, type ReceiverCaller } from "./HandoffReceiver.ts";
import {
  decodeFrame,
  HANDOFF_FRAME_META_MAX_BYTES,
  HANDOFF_JSON_MAX_BYTES,
  HANDOFF_PEER_PREFIX,
  HeartbeatRequest,
  NegotiateRequest,
  PEER_PATHS,
  PeerPreflightRequest,
  type PeerPath,
  ReplicateMeta,
  TakeoverRequest,
} from "./handoffWire.ts";
import { HANDOFF_MAX_BUNDLE_BYTES } from "@specweave-studio/contracts";

const decodeMeta = Schema.decodeUnknownOption(ReplicateMeta);
const MAX_BODY_BYTES = HANDOFF_MAX_BUNDLE_BYTES + HANDOFF_FRAME_META_MAX_BYTES + 4;

const refusal = (status: number, error: string, extra: Record<string, unknown> = {}) =>
  HttpServerResponse.jsonUnsafe(
    { error, ...extra },
    { status, headers: { "cache-control": "no-store" } },
  );

const fromRefusal = (error: HandoffRefusal) =>
  refusal(error.status, error.message, {
    code: error.code,
    ...(error.check === undefined ? {} : { check: error.check }),
  });

const decodeJson = <S extends Schema.Top>(schema: S, bytes: Uint8Array) => {
  let raw: unknown;
  try {
    raw = parseJson(new TextDecoder().decode(bytes));
  } catch {
    return Option.none<S["Type"]>();
  }
  return Schema.decodeUnknownOption(schema as never)(raw) as Option.Option<S["Type"]>;
};

const ok = (value: unknown) =>
  HttpServerResponse.jsonUnsafe(value, { headers: { "cache-control": "no-store" } });

export const layer = HttpRouter.add(
  "POST",
  `${HANDOFF_PEER_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (yield* (yield* ServiceUpdateHold.optional).isHeld) {
      return refusal(503, "This machine is updating; try again in a minute.", { code: "busy" });
    }
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) return refusal(400, "invalid_request", { code: "invalid" });
    const path = url.value.pathname.slice(HANDOFF_PEER_PREFIX.length + 1);
    if (!PEER_PATHS.has(path)) return refusal(404, "not_found", { code: "not_found" });

    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const client = yield* auth.authenticateMcpClient(request).pipe(Effect.option);
    if (Option.isNone(client)) return refusal(401, "unauthorized", { code: "needs_grant" });
    const grants = yield* WorkGrants.WorkGrants;
    const grant = yield* grants.forClient(client.value).pipe(Effect.option);
    if (Option.isNone(grant) || grant.value === undefined) {
      return refusal(403, "Only a paired machine's worker credential may hand off here.", {
        code: "needs_grant",
        check: "grant",
      });
    }
    if (grant.value.revoked) {
      return refusal(403, "This machine revoked that machine's work here.", {
        code: "needs_grant",
        check: "grant",
      });
    }
    const caller: ReceiverCaller = {
      sourceEnvironmentId: grant.value.coordinatorEnvironmentId,
      grant: grant.value,
      // From the credential on this request, not the stored policy: a legacy
      // grant has no stored cap until its coordinator calls again.
      runtimeCeiling: clientRuntimeModeCeiling(client.value),
    };

    const limit = path === "replicate" ? MAX_BODY_BYTES : HANDOFF_JSON_MAX_BYTES;
    const contentLength = Number(request.headers["content-length"] ?? "0");
    if (!Number.isFinite(contentLength) || contentLength > limit) {
      return refusal(413, "The request is too large.", { code: "too_large" });
    }
    const body = yield* request.arrayBuffer.pipe(
      Effect.map((buffer) => new Uint8Array(buffer)),
      Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(limit)),
      Effect.option,
    );
    if (Option.isNone(body))
      return refusal(413, "The request is too large.", { code: "too_large" });

    const receiver = yield* HandoffReceiver;
    const invalid = refusal(400, "The request does not match this version.", { code: "invalid" });
    const answer = (effect: Effect.Effect<unknown, HandoffRefusal>) =>
      effect.pipe(
        Effect.map(ok),
        Effect.catchTags({ HandoffRefusal: (error) => Effect.succeed(fromRefusal(error)) }),
      );

    switch (path as PeerPath) {
      case "negotiate": {
        const input = decodeJson(NegotiateRequest, body.value);
        return Option.isNone(input)
          ? invalid
          : yield* answer(receiver.negotiate(caller, input.value));
      }
      case "preflight": {
        const input = decodeJson(PeerPreflightRequest, body.value);
        return Option.isNone(input)
          ? invalid
          : yield* answer(receiver.preflight(caller, input.value));
      }
      case "takeover": {
        const input = decodeJson(TakeoverRequest, body.value);
        return Option.isNone(input)
          ? invalid
          : yield* answer(receiver.takeover(caller, input.value));
      }
      case "heartbeat": {
        const input = decodeJson(HeartbeatRequest, body.value);
        return Option.isNone(input)
          ? invalid
          : yield* answer(receiver.heartbeat(caller, input.value));
      }
      case "replicate": {
        let frame: { meta: unknown; bundle: Uint8Array };
        try {
          frame = decodeFrame(body.value);
        } catch {
          return invalid;
        }
        const meta = decodeMeta(frame.meta);
        return Option.isNone(meta)
          ? invalid
          : yield* answer(receiver.replicate(caller, meta.value, frame.bundle));
      }
    }
  }),
);
