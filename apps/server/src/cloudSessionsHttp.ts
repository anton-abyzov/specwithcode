import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  EnvironmentHttpBadRequestError,
  EnvironmentHttpForbiddenError,
  EnvironmentHttpInternalServerError,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as HttpEffect from "effect/http/HttpEffect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { requireEnvironmentScope } from "./auth/http.ts";
import * as CloudSessions from "./cloudSessions/CloudSessions.ts";
import * as Config from "./config.ts";
import { capacityMutationOriginAllowed, mutationTrustedOrigins } from "./studio/http.ts";

const noStore = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(
    HttpServerResponse.setHeaders(response, {
      "cache-control": "no-store",
      pragma: "no-cache",
      "x-content-type-options": "nosniff",
    }),
  ),
);

/** The service's reasons as HTTP errors; the detail is already written for the user. */
const asHttpError = (error: CloudSessions.CloudSessionError) =>
  error.reason === "invalid_request" ||
  error.reason === "not_found" ||
  error.reason === "unavailable"
    ? new EnvironmentHttpBadRequestError({ message: error.detail })
    : new EnvironmentHttpInternalServerError({ message: error.detail });

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "cloudSessions",
  Effect.fnUntraced(function* (handlers) {
    const config = yield* Config.ServerConfig;
    const cloud = yield* CloudSessions.CloudSessions;
    /** Starting or messaging a session spends the user's plan, so it takes Operate and a request from this app itself. */
    const requireOperator = Effect.gen(function* () {
      yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
      const request = yield* HttpServerRequest.HttpServerRequest;
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
          message: "Cloud sessions can only be started from an authorized same-origin request.",
        });
    });
    return handlers
      .handle("cloudSessions", ({ query }) =>
        Effect.gen(function* () {
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          yield* noStore;
          if (query.refresh === "true") yield* cloud.availability({ refresh: true });
          return yield* cloud.list({ projectId: query.projectId });
        }),
      )
      .handle("createCloudSession", ({ payload }) =>
        Effect.gen(function* () {
          yield* noStore;
          yield* requireOperator;
          return yield* cloud.create(payload).pipe(Effect.mapError(asHttpError));
        }),
      )
      .handle("sendCloudSession", ({ payload }) =>
        Effect.gen(function* () {
          yield* noStore;
          yield* requireOperator;
          return yield* cloud.send(payload).pipe(Effect.mapError(asHttpError));
        }),
      );
  }),
);
