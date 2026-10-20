import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  EnvironmentHttpForbiddenError,
  EnvironmentHttpBadRequestError,
  EnvironmentHttpInternalServerError,
  EnvironmentHttpConflictError,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as HttpEffect from "effect/http/HttpEffect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { requireEnvironmentScope } from "../auth/http.ts";
import { capacityMutationOriginAllowed, mutationTrustedOrigins } from "../auth/requestOrigin.ts";
import * as ServerConfig from "../config.ts";
import * as Capacity from "./Capacity.ts";

const noStore = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(
    HttpServerResponse.setHeaders(response, {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    }),
  ),
);
const mutationAllowed = Effect.gen(function* () {
  yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
  const request = yield* HttpServerRequest.HttpServerRequest;
  const config = yield* ServerConfig.ServerConfig;
  if (
    !capacityMutationOriginAllowed({
      origin: request.headers.origin,
      host: request.headers.host,
      requestUrl: request.originalUrl,
      forwardedProto: request.headers["x-forwarded-proto"],
      fetchSite: request.headers["sec-fetch-site"],
      authorization: request.headers.authorization,
      cookie: request.headers.cookie,
      trustedOrigins: mutationTrustedOrigins(config),
    })
  )
    return yield* new EnvironmentHttpForbiddenError({
      message: "Capacity changes require an authorized same-origin request.",
    });
  if (Number(request.headers["content-length"] ?? 0) > 4096)
    return yield* new EnvironmentHttpBadRequestError({ message: "Capacity request is too large." });
  yield* noStore;
});
const mutationResponse = <A, R>(effect: Effect.Effect<A, Capacity.CapacityMutationError, R>) =>
  effect.pipe(
    Effect.catchTags({
      CapacityMutationError: (error) =>
        error.category === "profile-not-eligible"
          ? Effect.fail(new EnvironmentHttpBadRequestError({ message: error.message }))
          : error.category === "switch-busy"
            ? Effect.fail(new EnvironmentHttpConflictError({ message: error.message }))
            : Effect.fail(new EnvironmentHttpInternalServerError({ message: error.message })),
    }),
  );

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "studio",
  Effect.fnUntraced(function* (handlers) {
    const capacity = yield* Capacity.Capacity;
    return handlers
      .handle("capacity", () =>
        Effect.gen(function* () {
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          yield* noStore;
          return yield* capacity.current;
        }),
      )
      .handle("refreshCapacity", () =>
        mutationAllowed.pipe(Effect.andThen(mutationResponse(capacity.refresh))),
      )
      .handle("setCapacityPolicy", ({ payload }) =>
        mutationAllowed.pipe(Effect.andThen(mutationResponse(capacity.policy(payload)))),
      )
      .handle("selectCapacityAccount", ({ payload }) =>
        mutationAllowed.pipe(Effect.andThen(mutationResponse(capacity.select(payload)))),
      );
  }),
);
