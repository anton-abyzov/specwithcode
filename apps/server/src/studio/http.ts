import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope, EnvironmentHttpApi,
  EnvironmentHttpForbiddenError, EnvironmentHttpBadRequestError, EnvironmentHttpInternalServerError, EnvironmentHttpConflictError } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as HttpEffect from "effect/http/HttpEffect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { requireEnvironmentScope } from "../auth/http.ts";
import * as ServerConfig from "../config.ts";
import * as Capacity from "./Capacity.ts";

/** Browser CSRF check. An untrusted forwarded host never chooses the authority. */
export function capacityMutationOriginAllowed(input: {
  origin?: string | undefined; host?: string | undefined; requestUrl: string; forwardedProto?: string | undefined;
  fetchSite?: string | undefined; authorization?: string | undefined; cookie?: string | undefined;
  trustedOrigins: ReadonlyArray<string>;
}): boolean {
  if (input.origin && input.trustedOrigins.includes(input.origin)) return true;
  if (input.fetchSite === "cross-site") return false;
  if (!input.origin) return !input.cookie && /^(Bearer|DPoP)\s+\S+$/i.test(input.authorization ?? "") && !input.fetchSite;
  try {
    const origin = new URL(input.origin);
    if (origin.origin !== input.origin || origin.username || origin.password) return false;
    const request = new URL(input.requestUrl, `http://${input.host ?? "127.0.0.1"}`);
    const host = input.host ?? request.host;
    const protocol = input.forwardedProto === "https" ? "https:" : request.protocol;
    return origin.host === host && origin.protocol === protocol && (protocol === "http:" || protocol === "https:");
  } catch { return false; }
}

/**
 * Origins a mutation may come from besides the server's own. The Mac app's
 * renderer is trusted in every mode: a web page cannot send these origins, and
 * the app also drives a separately launched web-mode service such as M4's.
 */
export function mutationTrustedOrigins(
  config: Pick<ServerConfig.ServerConfig["Service"], "devAllowedOrigins" | "devUrl">,
): ReadonlyArray<string> {
  return [...config.devAllowedOrigins, ...(config.devUrl ? [config.devUrl.origin] : []),
    "studio://app", "studio-dev://app"];
}

const noStore = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeaders(response, { "cache-control": "no-store", "x-content-type-options": "nosniff" })));
const mutationAllowed = Effect.gen(function* () {
  yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
  const request = yield* HttpServerRequest.HttpServerRequest;
  const config = yield* ServerConfig.ServerConfig;
  if (!capacityMutationOriginAllowed({ origin: request.headers.origin, host: request.headers.host,
    requestUrl: request.originalUrl, forwardedProto: request.headers["x-forwarded-proto"],
    fetchSite: request.headers["sec-fetch-site"], authorization: request.headers.authorization,
    cookie: request.headers.cookie, trustedOrigins: mutationTrustedOrigins(config) }))
    return yield* new EnvironmentHttpForbiddenError({ message: "Capacity changes require an authorized same-origin request." });
  if (Number(request.headers["content-length"] ?? 0) > 4096)
    return yield* new EnvironmentHttpBadRequestError({ message: "Capacity request is too large." });
  yield* noStore;
});
const mutationResponse = <A, R>(effect: Effect.Effect<A, Capacity.CapacityMutationError, R>) => effect.pipe(
  Effect.catchTags({ CapacityMutationError: (error) => error.category === "profile-not-eligible"
    ? Effect.fail(new EnvironmentHttpBadRequestError({ message: error.message }))
    : error.category === "switch-busy" ? Effect.fail(new EnvironmentHttpConflictError({ message: error.message }))
    : Effect.fail(new EnvironmentHttpInternalServerError({ message: error.message })) }),
);

export const layer = HttpApiBuilder.group(EnvironmentHttpApi, "studio", Effect.fnUntraced(function* (handlers) {
  const capacity = yield* Capacity.Capacity;
  return handlers
    .handle("capacity", () => Effect.gen(function* () { yield* requireEnvironmentScope(AuthOrchestrationReadScope); yield* noStore; return yield* capacity.current; }))
    .handle("refreshCapacity", () => mutationAllowed.pipe(Effect.andThen(mutationResponse(capacity.refresh))))
    .handle("setCapacityPolicy", ({ payload }) => mutationAllowed.pipe(Effect.andThen(mutationResponse(capacity.policy(payload)))))
    .handle("selectCapacityAccount", ({ payload }) => mutationAllowed.pipe(Effect.andThen(mutationResponse(capacity.select(payload)))));
}));
