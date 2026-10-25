import {
  authScopeRequiredResponse,
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  EnvironmentWorkerGrantInvalidError,
  EnvironmentWorkerGrantUnavailableError,
  AuthStandardClientScopes,
  AuthGrantScope,
  EnvironmentAuthInvalidError,
  type EnvironmentAuthInvalidReason,
  EnvironmentHttpApi,
  EnvironmentInternalError,
  type EnvironmentInternalErrorReason,
  EnvironmentOperationForbiddenError,
  EnvironmentRequestInvalidError,
  type EnvironmentRequestInvalidReason,
  EnvironmentResourceNotFoundError,
  type EnvironmentResourceNotFoundReason,
  EnvironmentScopeRequiredError,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
} from "@specweave-studio/contracts";
import type { AuthEnvironmentScope, DpopFailureReason } from "@specweave-studio/contracts";
import { parseOAuthScope } from "@specweave-studio/shared/oauthScope";
import { causeErrorTag } from "@specweave-studio/shared/observability";
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";
import { identity } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Cookies from "effect/http/Cookies";
import * as HttpEffect from "effect/http/HttpEffect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as SessionStore from "./SessionStore.ts";
import { traceAuthenticatedRelayRequest, traceRelayRequest } from "../cloud/traceRelayRequest.ts";
import { deriveAuthClientMetadata } from "./utils.ts";
import { verifyRequestDpopProof } from "./dpop.ts";
import { browserCookieAttributes } from "./browserCookiePolicy.ts";

const CREDENTIAL_RESPONSE_HEADERS = {
  "cache-control": "no-store",
  pragma: "no-cache",
} as const;

const appendCredentialResponseHeaders = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeaders(response, CREDENTIAL_RESPONSE_HEADERS)),
);

const appendDpopChallengeHeader = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeader(response, "www-authenticate", "DPoP")),
);

const appendDpopChallengeOnUnauthorized = (error: EnvironmentAuthInvalidError) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const usesDpop =
      (request.originalUrl.startsWith("/oauth/token") && request.headers.dpop !== undefined) ||
      request.headers.authorization?.startsWith("DPoP ") === true;
    if (usesDpop) {
      yield* appendDpopChallengeHeader;
    }
    return yield* error;
  });

const currentEnvironmentTraceId = Effect.currentParentSpan.pipe(
  Effect.map((span) => span.traceId),
  Effect.orElseSucceed(() => "unavailable"),
);

/** Whether a failed request ended on a typed error or a defect. The full
    cause (stacks, nested fibers, arbitrary defect text) stays in the trace
    span; the warning carries only bounded fields. */
function requestFailureKind(cause: Cause.Cause<unknown>): "error" | "defect" {
  return Cause.hasFails(cause) ? "error" : "defect";
}

export function annotateEnvironmentRequest(endpoint: string) {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    const traceId = yield* currentEnvironmentTraceId;

    yield* Effect.addFinalizer((exit) =>
      // A client that gave up (its fetch timed out or the socket closed)
      // interrupts the handler; that is not a server failure worth a warning.
      exit._tag === "Failure" && !Cause.hasInterruptsOnly(exit.cause)
        ? Effect.logWarning("environment api request failed", {
            endpoint,
            traceId,
            errorTag: causeErrorTag(exit.cause),
            failureKind: requestFailureKind(exit.cause),
          })
        : Effect.void,
    );
    yield* Effect.annotateLogsScoped({ "environment.endpoint": endpoint, traceId });
    yield* Effect.annotateCurrentSpan({
      "environment.endpoint": endpoint,
      "http.request.method": request.method,
      "url.path": url._tag === "Some" ? url.value.pathname : "unknown",
    });
  });
}

export function failEnvironmentAuthInvalid(
  reason: EnvironmentAuthInvalidReason,
  dpopFailureReason?: DpopFailureReason,
) {
  return currentEnvironmentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(
        new EnvironmentAuthInvalidError({
          code: "auth_invalid",
          reason,
          ...(dpopFailureReason === undefined ? {} : { dpopFailureReason }),
          traceId,
        }),
      ),
    ),
  );
}

export function failEnvironmentInvalidRequest(reason: EnvironmentRequestInvalidReason) {
  return currentEnvironmentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(new EnvironmentRequestInvalidError({ code: "invalid_request", reason, traceId })),
    ),
  );
}

export function failEnvironmentScopeRequired(requiredScope: AuthEnvironmentScope) {
  return currentEnvironmentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(
        new EnvironmentScopeRequiredError({
          code: "insufficient_scope",
          ...authScopeRequiredResponse(requiredScope),
          traceId,
        }),
      ),
    ),
  );
}

function failEnvironmentOperationForbidden(reason: "current_session_revoke_not_allowed") {
  return currentEnvironmentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(
        new EnvironmentOperationForbiddenError({
          code: "operation_forbidden",
          reason,
          traceId,
        }),
      ),
    ),
  );
}

export function failEnvironmentNotFound(reason: EnvironmentResourceNotFoundReason) {
  return currentEnvironmentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(new EnvironmentResourceNotFoundError({ code: "not_found", reason, traceId })),
    ),
  );
}

/**
 * `<img>` and WebSocket cannot set headers, so media routes (device hub,
 * preview stream) authenticate the way the `/ws` upgrade does: a cookie for browser
 * sessions, or a short-lived `wsTicket` minted over authenticated HTTP for
 * bearer and DPoP clients. The upgrade authenticator already implements that
 * fallback order, so it is used for plain requests as well. A cookie upgrade
 * or state change must come from this server's own origin or a trusted one.
 */
export const authenticateMediaRequest = (requiredScope: AuthEnvironmentScope) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* serverAuth.authenticateWebSocketUpgrade(request).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          if (EnvironmentAuth.isServerAuthCredentialError(error)) {
            return yield* failEnvironmentAuthInvalid(
              EnvironmentAuth.serverAuthCredentialReason(error),
              EnvironmentAuth.serverAuthDpopFailureReason(error),
            );
          }
          return yield* failEnvironmentInternal("internal_error", error);
        }),
      ),
    );
    if (!session.scopes.includes(requiredScope)) {
      return yield* failEnvironmentScopeRequired(requiredScope);
    }
    return session;
  });

/** The close code clients already read as "authentication rejected". */
const SESSION_ENDED_CLOSE_CODE = 4401;
/** How long a peer has to answer the close frame before the connection is dropped. */
const SESSION_ENDED_CLOSE_GRACE = Duration.seconds(1);

type WatchedSession = Pick<
  EnvironmentAuth.AuthenticatedSession,
  "sessionId" | "method" | "expiresAt"
>;

/**
 * Sends the 4401 close frame, then drops the TCP connection if the peer has
 * not finished the close handshake within the grace period. The drop is
 * detached: the handler's scope ends as soon as it returns.
 */
const closeEndedSocket = (request: HttpServerRequest.HttpServerRequest, socket: Socket.Socket) =>
  Effect.gen(function* () {
    yield* socket.writer.pipe(
      Effect.flatMap((writer) =>
        writer.write(new Socket.CloseEvent(SESSION_ENDED_CLOSE_CODE, "Session ended")),
      ),
      Effect.ignore,
    );
    const transport = NodeHttpServerRequest.toIncomingMessage(request).socket as
      | { readonly destroyed: boolean; readonly destroy: () => void }
      | undefined;
    if (transport === undefined || typeof transport.destroy !== "function") return;
    yield* Effect.sleep(SESSION_ENDED_CLOSE_GRACE).pipe(
      Effect.andThen(
        Effect.sync(() => {
          if (!transport.destroyed) transport.destroy();
        }),
      ),
      Effect.forkDetach,
    );
  });

/**
 * Serves `handler` on an upgraded media `socket` until `session` is revoked,
 * replaced or expires. Then the handler stops at once, so nothing more is
 * served, and the socket closes with 4401.
 */
export const serveSocketUntilSessionEnds = <A, E, R>(
  socket: Socket.Socket,
  session: WatchedSession,
  handler: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const ended = yield* auth.watchSessionEnd(session);
    return yield* Effect.raceFirst(
      handler,
      ended.pipe(Effect.andThen(closeEndedSocket(request, socket))),
    );
  });

/**
 * Runs an upgrade handler that calls `request.upgrade` itself, such as the RPC
 * server's, until `session` is revoked, replaced or expires. Then the handler
 * stops at once and the socket it opened closes with 4401. The handler sees
 * the current request with only `upgrade` wrapped.
 */
export const upgradeUntilSessionEnds = (
  session: WatchedSession,
  httpEffect: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    never,
    Scope.Scope | HttpServerRequest.HttpServerRequest
  >,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  Scope.Scope | HttpServerRequest.HttpServerRequest | EnvironmentAuth.EnvironmentAuth
> =>
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const ended = yield* auth.watchSessionEnd(session);
    const request = yield* HttpServerRequest.HttpServerRequest;
    let upgraded: Socket.Socket | undefined;
    const upgrade = request.upgrade.pipe(
      Effect.tap((socket) =>
        Effect.sync(() => {
          upgraded = socket;
        }),
      ),
    );
    const watched = new Proxy(request, {
      get: (target, property) =>
        property === "upgrade" ? upgrade : Reflect.get(target, property, target),
    });
    return yield* Effect.raceFirst(
      httpEffect.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, watched)),
      ended.pipe(
        Effect.andThen(
          Effect.suspend(() =>
            upgraded === undefined ? Effect.void : closeEndedSocket(request, upgraded),
          ),
        ),
        Effect.as(HttpServerResponse.empty()),
      ),
    );
  });

export function failEnvironmentInternal(reason: EnvironmentInternalErrorReason, error?: unknown) {
  return Effect.gen(function* () {
    const traceId = yield* currentEnvironmentTraceId;
    if (error !== undefined) {
      yield* Effect.logError("environment api operation failed", {
        reason,
        traceId,
        cause: error,
      });
    }
    return yield* new EnvironmentInternalError({ code: "internal_error", reason, traceId });
  });
}

const appendSessionCookie = (
  cookieName: string,
  token: string,
  expiresAt: DateTime.DateTime,
  expireLegacyCookie?: string,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const attributes = browserCookieAttributes(request);
    const cookies = yield* Effect.fromResult(
      Cookies.set(Cookies.empty, cookieName, token, {
        ...attributes,
        expires: DateTime.toDate(expiresAt),
      }),
    );
    return expireLegacyCookie === undefined
      ? cookies
      : yield* Effect.fromResult(Cookies.expireCookie(cookies, expireLegacyCookie, attributes));
  }).pipe(
    Effect.catch(() => failEnvironmentInternal("browser_session_cookie_failed")),
    Effect.flatMap((cookies) =>
      HttpEffect.appendPreResponseHandler((_request, response) =>
        Effect.succeed(HttpServerResponse.mergeCookies(response, cookies)),
      ),
    ),
  );

export const requireEnvironmentScope = Effect.fn("environment.auth.requireScope")(function* (
  scope: AuthEnvironmentScope,
) {
  const session = yield* EnvironmentAuthenticatedPrincipal;
  if (!session.scopes.has(scope)) {
    return yield* failEnvironmentScopeRequired(scope);
  }
  return session;
});

export const layerAuthenticatedAuth = Layer.effect(
  EnvironmentAuthenticatedAuth,
  Effect.gen(function* () {
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const startTime = yield* Clock.currentTimeNanos;
        const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
          Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
            failEnvironmentAuthInvalid(
              EnvironmentAuth.serverAuthCredentialReason(error),
              EnvironmentAuth.serverAuthDpopFailureReason(error),
            ),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("internal_error", error),
          ),
        );
        const endTime = yield* Clock.currentTimeNanos;
        const handler = httpEffect.pipe(
          Effect.provideService(EnvironmentAuthenticatedPrincipal, {
            ...session,
            scopes: new Set(session.scopes),
          }),
        );
        return yield* session.subject === "cloud-connect"
          ? traceAuthenticatedRelayRequest(handler, { startTime, endTime })
          : handler;
      }).pipe(Effect.catchTags({ EnvironmentAuthInvalidError: appendDpopChallengeOnUnauthorized }));
  }),
);

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "auth",
  Effect.fnUntraced(function* (handlers) {
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const sessions = yield* SessionStore.SessionStore;

    return handlers
      .handle(
        "session",
        Effect.fn("environment.auth.session")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const request = yield* HttpServerRequest.HttpServerRequest;
            const result = yield* serverAuth.getSessionState(request);
            const credential = EnvironmentAuth.selectRequestCredential(
              request,
              sessions.cookieName,
              sessions.findLegacyCookie,
            );
            if (
              (credential?.source === "cookie" || credential?.source === "legacy-cookie") &&
              result.authenticated &&
              result.sessionMethod === "browser-session-cookie" &&
              result.expiresAt
            ) {
              yield* appendSessionCookie(
                sessions.cookieName,
                credential.token,
                result.expiresAt,
                credential.source === "legacy-cookie" ? credential.cookieName : undefined,
              );
              yield* appendCredentialResponseHeaders;
            }
            return result;
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("internal_error", error),
          ),
        ),
      )
      .handle(
        "browserSession",
        Effect.fn("environment.auth.browserSession")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const request = yield* HttpServerRequest.HttpServerRequest;
            const previousCredential = EnvironmentAuth.selectRequestCredential(
              request,
              sessions.cookieName,
              sessions.findLegacyCookie,
            );
            const result = yield* serverAuth.createBrowserSession(
              args.payload.credential,
              deriveAuthClientMetadata({ request }),
              previousCredential?.source === "cookie" ||
                previousCredential?.source === "legacy-cookie"
                ? previousCredential.token
                : undefined,
            );
            const cookieName = result.cookieName ?? sessions.cookieName;
            const selectedCookie = yield* Effect.fromResult(
              Cookies.set(Cookies.empty, cookieName, result.sessionToken, {
                ...browserCookieAttributes(request),
                expires: DateTime.toDate(result.response.expiresAt),
              }),
            ).pipe(Effect.catch(() => failEnvironmentInternal("browser_session_cookie_failed")));
            const sessionCookies = result.expireNormalCookie
              ? yield* Effect.fromResult(
                  Cookies.expireCookie(selectedCookie, sessions.cookieName, {
                    ...browserCookieAttributes(request),
                  }),
                ).pipe(Effect.catch(() => failEnvironmentInternal("browser_session_cookie_failed")))
              : selectedCookie;

            yield* HttpEffect.appendPreResponseHandler((_request, response) =>
              Effect.succeed(HttpServerResponse.mergeCookies(response, sessionCookies)),
            );
            yield* appendCredentialResponseHeaders;
            return result.response;
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
            failEnvironmentAuthInvalid(
              EnvironmentAuth.serverAuthCredentialReason(error),
              EnvironmentAuth.serverAuthDpopFailureReason(error),
            ),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("browser_session_issuance_failed", error),
          ),
        ),
      )
      .handle(
        "token",
        Effect.fn("environment.auth.token")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const request = yield* HttpServerRequest.HttpServerRequest;
            const requestedScopes =
              args.payload.scope === undefined
                ? undefined
                : (parseOAuthScope(args.payload.scope)?.filter(Schema.is(AuthGrantScope)) ?? null);
            if (requestedScopes === null || requestedScopes?.length === 0) {
              return yield* failEnvironmentInvalidRequest("invalid_scope");
            }
            const proofKeyThumbprint = args.headers.dpop
              ? yield* verifyRequestDpopProof({ request }).pipe(
                  Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
                    appendDpopChallengeHeader.pipe(
                      Effect.andThen(
                        failEnvironmentAuthInvalid(
                          "invalid_credential",
                          EnvironmentAuth.serverAuthDpopFailureReason(error),
                        ),
                      ),
                    ),
                  ),
                  Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
                    failEnvironmentInternal("access_token_issuance_failed", error),
                  ),
                )
              : undefined;
            yield* appendCredentialResponseHeaders;
            return yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
              args.payload.subject_token,
              requestedScopes,
              deriveAuthClientMetadata({
                request,
                presented: {
                  ...(args.payload.client_label ? { label: args.payload.client_label } : {}),
                  ...(args.payload.client_device_type
                    ? { deviceType: args.payload.client_device_type }
                    : {}),
                  ...(args.payload.client_os ? { os: args.payload.client_os } : {}),
                },
              }),
              proofKeyThumbprint ? { proofKeyThumbprint } : undefined,
            );
          },
          traceRelayRequest,
          Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
            failEnvironmentAuthInvalid(
              EnvironmentAuth.serverAuthCredentialReason(error),
              EnvironmentAuth.serverAuthDpopFailureReason(error),
            ),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInvalidRequestError, (error) =>
            failEnvironmentInvalidRequest(EnvironmentAuth.serverAuthInvalidRequestReason(error)),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("access_token_issuance_failed", error),
          ),
        ),
      )
      .handle(
        "webSocketTicket",
        Effect.fn("environment.auth.webSocketTicket")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* EnvironmentAuthenticatedPrincipal;
            yield* appendCredentialResponseHeaders;
            return yield* serverAuth.issueWebSocketTicket(session);
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("websocket_ticket_issuance_failed", error),
          ),
        ),
      )
      .handle(
        "renewWorkerGrant",
        Effect.fn("environment.auth.renewWorkerGrant")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* appendCredentialResponseHeaders;
          const manager = yield* requireEnvironmentScope(AuthAccessWriteScope);
          if (
            manager.principal?.kind === "coordinator" &&
            manager.principal.environmentId !== args.payload.coordinatorEnvironmentId
          ) {
            return yield* failEnvironmentAuthInvalid("invalid_credential");
          }
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* sessions.renewWorkerGrant(args.payload).pipe(
            Effect.catchTag(
              "WorkerGrantRenewalError",
              (
                error,
              ): Effect.Effect<
                never,
                EnvironmentWorkerGrantInvalidError | EnvironmentWorkerGrantUnavailableError
              > =>
                error.code === "grant_invalid"
                  ? Effect.fail(
                      new EnvironmentWorkerGrantInvalidError({
                        code: error.code,
                        error: error.message,
                      }),
                    )
                  : Effect.fail(
                      new EnvironmentWorkerGrantUnavailableError({
                        code: error.code,
                        error: error.message,
                      }),
                    ),
            ),
            Effect.catchIf(Schema.is(SessionStore.SessionCredentialInternalError), (error) =>
              failEnvironmentInternal("internal_error", error),
            ),
          );
        }),
      )
      .handle(
        "pairingCredential",
        Effect.fn("environment.auth.pairingCredential")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* requireEnvironmentScope(AuthAccessWriteScope);
            const delegatedScopes = args.payload.scopes ?? AuthStandardClientScopes;
            if (
              delegatedScopes.length === 0 ||
              new Set<AuthEnvironmentScope>(delegatedScopes).size !== delegatedScopes.length
            ) {
              return yield* failEnvironmentInvalidRequest("invalid_scope");
            }
            for (const delegatedScope of delegatedScopes) {
              if (!session.scopes.has(delegatedScope)) {
                return yield* failEnvironmentScopeRequired(delegatedScope);
              }
            }
            const coordinator =
              session.principal?.kind === "coordinator"
                ? session.principal.environmentId
                : args.payload.coordinatorEnvironmentId;
            if (
              session.principal?.kind === "coordinator" &&
              args.payload.coordinatorEnvironmentId !== undefined &&
              args.payload.coordinatorEnvironmentId !== coordinator
            ) {
              return yield* failEnvironmentAuthInvalid("invalid_credential");
            }
            return yield* serverAuth.issuePairingCredential({
              ...args.payload,
              ...(coordinator ? { coordinatorEnvironmentId: coordinator } : {}),
              ...(session.principal?.kind === "coordinator"
                ? { principalGeneration: session.principalGeneration }
                : {}),
            });
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("pairing_credential_issuance_failed", error),
          ),
        ),
      )
      .handle(
        "pairingLinks",
        Effect.fn("environment.auth.pairingLinks")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            yield* requireEnvironmentScope(AuthAccessReadScope);
            return yield* serverAuth.listPairingLinks();
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("pairing_links_load_failed", error),
          ),
        ),
      )
      .handle(
        "revokePairingLink",
        Effect.fn("environment.auth.revokePairingLink")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            yield* requireEnvironmentScope(AuthAccessWriteScope);
            const revoked = yield* serverAuth.revokePairingLink(args.payload.id);
            return { revoked };
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("pairing_link_revoke_failed", error),
          ),
        ),
      )
      .handle(
        "clients",
        Effect.fn("environment.auth.clients")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* requireEnvironmentScope(AuthAccessReadScope);
            return yield* serverAuth.listClientSessions(session.sessionId);
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("client_sessions_load_failed", error),
          ),
        ),
      )
      .handle(
        "revokeClient",
        Effect.fn("environment.auth.revokeClient")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* requireEnvironmentScope(AuthAccessWriteScope);
            const revoked = yield* serverAuth.revokeClientSession(
              session.sessionId,
              args.payload.sessionId,
            );
            return { revoked };
          },
          Effect.catchTags({
            ServerAuthForbiddenOperationError: () =>
              failEnvironmentOperationForbidden("current_session_revoke_not_allowed"),
          }),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("client_session_revoke_failed", error),
          ),
        ),
      )
      .handle(
        "revokeOtherClients",
        Effect.fn("environment.auth.revokeOtherClients")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* requireEnvironmentScope(AuthAccessWriteScope);
            const revokedCount = yield* serverAuth.revokeOtherClientSessions(session.sessionId);
            return { revokedCount };
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("client_session_revoke_failed", error),
          ),
        ),
      )
      .handle(
        "revokeOwnSession",
        Effect.fn("environment.auth.revokeOwnSession")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            // Any bearer credential may give itself up; it needs no scope to do so.
            // A browser signs out through its own session, never a cross-site POST.
            const session = yield* EnvironmentAuthenticatedPrincipal;
            if (session.method !== "bearer-access-token")
              return yield* failEnvironmentOperationForbidden("current_session_revoke_not_allowed");
            const revoked = yield* serverAuth.revokeSession(session.sessionId);
            return { revoked };
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("client_session_revoke_failed", error),
          ),
        ),
      );
  }),
);
