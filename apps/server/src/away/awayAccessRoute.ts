/**
 * `POST /api/away/v1/access`: another machine asks this one, for Away mode,
 * what its grant here allows, sends a request for missing access, or asks
 * how that request stands. Only a machine that holds a key here gets in:
 * the management token this machine gave its main machine, or a worker
 * credential (both carry the caller's environment id as a coordinator
 * principal). Nothing here changes a grant: only the owner's approval in
 * this machine's app does (`AwayAccess.decide`).
 */
import type { AuthPrincipal, AwayError, EnvironmentId } from "@specweave-studio/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { coordinatorOfPrincipal } from "../fleet/workGrantPolicy.ts";
import { parseJson } from "../json.ts";
import { AWAY_PEER_PATH, AwayAccess, AwayPeerRequest } from "./AwayAccessRequest.ts";

const MAX_BODY_BYTES = 256 * 1024;
const decodeRequest = Schema.decodeUnknownOption(AwayPeerRequest);

const answer = (status: number, body: unknown) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: { "cache-control": "no-store" } });

/** The calling machine, from whichever credential it sent. */
export function awayCaller(
  sessions: ReadonlyArray<{ readonly principal?: AuthPrincipal | undefined } | undefined>,
): EnvironmentId | undefined {
  for (const session of sessions) {
    const caller = coordinatorOfPrincipal(session?.principal);
    if (caller !== undefined) return caller;
  }
  return undefined;
}

export const layer = HttpRouter.add(
  "POST",
  AWAY_PEER_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const http = yield* auth.authenticateHttpRequest(request).pipe(Effect.option);
    const mcp = Option.isSome(http)
      ? Option.none()
      : yield* auth.authenticateMcpClient(request).pipe(Effect.option);
    if (Option.isNone(http) && Option.isNone(mcp)) return answer(401, { error: "unauthorized" });
    const from = awayCaller([Option.getOrUndefined(http), Option.getOrUndefined(mcp)]);
    if (from === undefined) {
      return answer(403, { error: "Only another of the owner's machines may ask this." });
    }
    const contentLength = Number(request.headers["content-length"] ?? "0");
    if (!Number.isFinite(contentLength) || contentLength > MAX_BODY_BYTES) {
      return answer(413, { error: "The request is too large." });
    }
    const text = yield* request.text.pipe(
      Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(MAX_BODY_BYTES)),
      Effect.option,
    );
    if (Option.isNone(text)) return answer(413, { error: "The request is too large." });
    let raw: unknown = null;
    try {
      raw = parseJson(text.value);
    } catch {
      raw = null;
    }
    const body = decodeRequest(raw);
    if (Option.isNone(body))
      return answer(400, { error: "The request does not match this version." });

    const access = yield* AwayAccess;
    const self = yield* (yield* ServerEnvironment).getEnvironmentId;
    const input = body.value;
    const outcome: Effect.Effect<unknown, AwayError> =
      input.action === "grant"
        ? access.grantFor(from).pipe(Effect.map((grant) => ({ grant })))
        : input.action === "request"
          ? access.receive({ self, from, fromLabel: input.fromLabel, missing: input.missing })
          : access.statusFor({ from, requestId: input.requestId });
    return yield* outcome.pipe(
      Effect.map((value) => answer(200, value)),
      Effect.catchTags({
        AwayError: (error) =>
          Effect.succeed(
            answer(error.code === "not_found" ? 410 : error.code === "invalid" ? 400 : 500, {
              error: error.message,
            }),
          ),
      }),
    );
  }),
);
