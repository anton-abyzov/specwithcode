/**
 * The loopback address Google redirects the browser to after consent.
 *
 * It needs no Studio session: completing a sign-in requires the single-use
 * state Studio generated for an authenticated `googleAccount.startSignIn`,
 * and the code is bound to that sign-in's PKCE verifier. The path is kept out
 * of request traces because its query holds the authorization code.
 *
 * @module googleOAuthRoute
 */
import * as Effect from "effect/Effect";
import { HttpRouter } from "effect/http";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import * as GoogleAccountService from "./GoogleAccountService.ts";
import { GOOGLE_CALLBACK_PATH } from "./googleAccountLogic.ts";

export const layer = HttpRouter.add(
  "GET",
  GOOGLE_CALLBACK_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const service = yield* GoogleAccountService.GoogleAccountService;
    const queryIndex = request.url.indexOf("?");
    const page = yield* service.callbackPage(
      queryIndex === -1 ? "" : request.url.slice(queryIndex),
    );
    return HttpServerResponse.text(page, {
      contentType: "text/html; charset=utf-8",
      headers: {
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      },
    });
  }),
);
