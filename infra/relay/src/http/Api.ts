import { createClerkClient, verifyToken } from "@clerk/backend";
import { sql as drizzleSql } from "drizzle-orm";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import * as Headers from "effect/http/Headers";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpMiddleware from "effect/http/HttpMiddleware";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpTraceContext from "effect/http/HttpTraceContext";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiError from "effect/http-api/HttpApiError";
import { encodeOAuthScope } from "@specweave-studio/shared/oauthScope";
import * as HttpObservability from "@specweave-studio/shared/httpObservability";

import {
  RelayApi,
  RelayAgentActivityPublishProofExpiredError,
  RelayAgentActivityPublishProofInvalidError,
  RelayClientAuth,
  RelayClientPrincipal,
  RelayAccessTokenType,
  RelayDpopClientAuth,
  RelayEnvironmentConnectScope,
  RelayEnvironmentStatusScope,
  RelayMobileRegistrationScope,
  RelayAuthInvalidError,
  type RelayAuthInvalidReason,
  type RelayDpopFailureReason,
  RelayEnvironmentAuth,
  RelayEnvironmentConnectNotAuthorizedError,
  RelayEnvironmentEndpointTimedOutError,
  RelayEnvironmentEndpointUnavailableError,
  RelayEnvironmentLinkFailedError,
  RelayEnvironmentLinkProofExpiredError,
  RelayEnvironmentLinkProofInvalidError,
  RelayEnvironmentLinkUnavailableError,
  RelayEnvironmentLinkLimitExceededError,
  RelayEnvironmentPrincipal,
  type RelayEnvironmentConnectRequest,
  type RelayDpopAccessTokenScope,
  RelayInternalError,
} from "@specweave-studio/contracts/relay";
import { normalizeRelayIssuer } from "@specweave-studio/shared/relayJwt";

import * as DeliveryAttempts from "../agentActivity/DeliveryAttempts.ts";
import * as AgentActivityRows from "../agentActivity/AgentActivityRows.ts";
import * as Devices from "../agentActivity/Devices.ts";
import * as DpopProofs from "../auth/DpopProofs.ts";
import * as RelayTokens from "../auth/RelayTokens.ts";
import * as EnvironmentCredentials from "../environments/EnvironmentCredentials.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import * as HookForwarder from "../hooks/HookForwarder.ts";
import * as HeldHooks from "../hooks/HeldHooks.ts";
import * as HookInbox from "../hooks/HookInbox.ts";
import * as LiveActivities from "../agentActivity/LiveActivities.ts";
import * as RelayConfiguration from "../Config.ts";
import * as AgentActivityPublisher from "../agentActivity/AgentActivityPublisher.ts";
import * as EnvironmentConnector from "../environments/EnvironmentConnector.ts";
import * as EnvironmentLinker from "../environments/EnvironmentLinker.ts";
import * as ManagedEndpointProvider from "../environments/ManagedEndpointProvider.ts";
import * as ManagedEndpointAllocations from "../environments/ManagedEndpointAllocations.ts";
import * as ConnectAccounts from "../environments/ConnectAccounts.ts";
import * as ManagedTunnelLimits from "../environments/ManagedTunnelLimits.ts";
import * as EnvironmentPublishSignatures from "../environments/EnvironmentPublishSignatures.ts";
import * as MobileRegistrations from "../agentActivity/MobileRegistrations.ts";
import { withSpanAttributes } from "../spanAttributes.ts";
import { isRelayHookPath, redactRelayHookUrl } from "../hooks/HookForwarder.ts";
import * as AccountDeletion from "../account/AccountDeletion.ts";
import * as RelayDb from "../db.ts";
import { currentTraceId, mapErrorTags } from "./mapErrorTags.ts";
import {
  revokeEnvironmentLinkRecord,
  unlinkEnvironmentRecord,
} from "../environments/EnvironmentUnlink.ts";
import {
  recoverEnvironmentTunnelRecord,
  registerEnvironmentTunnelRecovery,
  verifyEnvironmentTunnelRecoveryProof,
} from "../environments/EnvironmentTunnelRecovery.ts";

// Delegated thread IDs carry escaped command provenance and exceed the router's
// default 100-character path parameter limit. Match the environment server.
export const RELAY_HTTP_ROUTER_CONFIG = {
  maxParamLength: 512,
} as const;

const appendRelayCredentialResponseHeaders = HttpEffect.appendPreResponseHandler(
  (_request, response) =>
    Effect.succeed(
      HttpServerResponse.setHeaders(response, {
        "cache-control": "no-store",
        pragma: "no-cache",
      }),
    ),
);

/**
 * The public founders counter is aggregate and unauthenticated: let browsers
 * and shared caches keep it for a minute instead of reading D1 on every hit.
 */
const appendPublicCounterCacheHeader = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(
    response.status === 200
      ? HttpServerResponse.setHeader(response, "cache-control", "public, max-age=60, s-maxage=60")
      : response,
  ),
);

const appendRelayDpopChallengeHeader = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(
    response.status === 401
      ? HttpServerResponse.setHeader(response, "www-authenticate", "DPoP")
      : response,
  ),
);

const appendRelayTraceContextResponseHeader = Effect.gen(function* () {
  const span = yield* Effect.currentParentSpan;
  if (span._tag !== "Span") {
    return;
  }
  const traceparent = HttpTraceContext.toHeaders(span).traceparent;
  if (traceparent === undefined) {
    return;
  }
  yield* HttpEffect.appendPreResponseHandler((_request, response) =>
    Effect.succeed(HttpServerResponse.setHeader(response, "traceparent", traceparent)),
  );
}).pipe(Effect.ignore);

const relayCorsMiddleware = HttpMiddleware.cors({
  allowedMethods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["authorization", "b3", "traceparent", "content-type", "dpop"],
  exposedHeaders: ["traceparent", "www-authenticate"],
  maxAge: 86_400,
});

// The CORS headers come from a pre-response handler, so they reach every response
// the request sends: handler failures and defects, and the deadline 504 that
// `traceRelayHttpRequest` produces outside the router.
export const layerCors = HttpRouter.middleware(
  Effect.fnUntraced(function* <E, R>(
    httpEffect: Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      E,
      HttpServerRequest.HttpServerRequest | R
    >,
  ) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    // Public webhook forwarding is server-to-server: no preflight, no CORS grants.
    if (isRelayHookPath(request.url)) {
      return yield* httpEffect;
    }
    return yield* relayCorsMiddleware(httpEffect);
  }),
  { global: true },
);

export const layerNotFoundRoute = HttpRouter.add(
  "*",
  "/*",
  HttpServerResponse.empty({ status: 404 }),
);

export const layerDocsRedirectRoute = HttpRouter.add(
  "GET",
  "/",
  HttpServerResponse.redirect("/docs"),
);

// Shorter than the mobile client's 10s request timeout on purpose: when a
// request hangs (e.g. a stuck upstream query), the client would otherwise
// abort first, the invocation would die with the request span still open, and
// the batched spans would never export — leaving no server-side trace at all.
// Failing server-side first turns the hang into a completed 504 whose trace
// contains the exact child span that stalled, and the response still carries
// the traceparent back to the client.
export const RELAY_REQUEST_DEADLINE_MS = 9_000;
/**
 * Webhook forwarding reads a body of up to 1 MiB, waits up to the upstream
 * timeout, and may then hold the request, so it needs more room than an API
 * call; cutting it off before the hold would drop a request it should keep.
 */
export const RELAY_HOOK_REQUEST_DEADLINE_MS = 25_000;

const relayRequestDeadline = <E, R>(
  httpEffect: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    E,
    HttpServerRequest.HttpServerRequest | R
  >,
  deadlineMs = RELAY_REQUEST_DEADLINE_MS,
) =>
  httpEffect.pipe(
    Effect.timeoutOption(Duration.millis(deadlineMs)),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            yield* Effect.logError("relay request exceeded deadline", {
              "http.method": request.method,
              "http.url": request.url,
              "relay.request.deadline_ms": deadlineMs,
            });
            yield* Effect.annotateCurrentSpan({
              "relay.request.deadline_exceeded": true,
            });
            return HttpServerResponse.jsonUnsafe(
              { error: "relay_request_deadline_exceeded" },
              { status: 504 },
            );
          }),
        onSome: Effect.succeed,
      }),
    ),
  );

/** Trace context headers in every format the tracer reads (W3C and B3). */
const SENDER_TRACE_HEADER = /^(traceparent|tracestate|b3|x-b3-.*)$/i;

export const traceRelayHttpRequest = <E, R>(
  httpEffect: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    E,
    HttpServerRequest.HttpServerRequest | R
  >,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const traced = appendRelayTraceContextResponseHeader.pipe(
      Effect.andThen(relayRequestDeadline(httpEffect)),
    );
    if (!isRelayHookPath(request.url)) {
      return yield* HttpMiddleware.tracer(traced).pipe(
        // The worker turns its own request span off; this one is ours.
        Effect.provideService(HttpMiddleware.TracerDisabledWhen, () => false),
        // HttpMiddleware finalizes its span on the dispatcher; do not close a request-scoped exporter first.
        Effect.ensuring(Effect.yieldNow),
      );
    }
    // Hook URLs carry a secret token: the tracer and deadline log see a redacted
    // request, while the route itself still receives the original. A webhook
    // sender's trace context is dropped, so it cannot pick the trace our relay
    // and environment spans land in.
    const redacted = request.modify({
      url: redactRelayHookUrl(request.url),
      headers: Headers.removeMany(
        request.headers,
        Object.keys(request.headers).filter((name) => SENDER_TRACE_HEADER.test(name)),
      ),
    });
    return yield* HttpMiddleware.tracer(
      appendRelayTraceContextResponseHeader.pipe(
        Effect.andThen(
          relayRequestDeadline(
            httpEffect.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request)),
            RELAY_HOOK_REQUEST_DEADLINE_MS,
          ),
        ),
      ),
    ).pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, redacted),
      // The worker turns its own request span off; this one is ours.
      Effect.provideService(HttpMiddleware.TracerDisabledWhen, () => false),
      Effect.ensuring(Effect.yieldNow),
    );
  });

// Webhook senders put shared secrets and signatures in headers such as
// x-hub-signature-256, stripe-signature, x-gitlab-token and x-webhook-key.
const layerWebhookHeaderRedaction = Layer.effect(
  Headers.CurrentRedactedNames,
  Effect.map(Headers.CurrentRedactedNames, (names) => [
    ...names,
    /signature/i,
    /token/i,
    /secret/i,
    /key/i,
    /auth/i,
  ]),
);

export const traceRelayHttpRequestWith = <E, R, LayerError, LayerRequirements>(
  httpEffect: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    E,
    HttpServerRequest.HttpServerRequest | R
  >,
  tracerLayer: Layer.Layer<never, LayerError, LayerRequirements>,
) =>
  traceRelayHttpRequest(httpEffect).pipe(
    Effect.provide(
      Layer.merge(
        tracerLayer,
        layerWebhookHeaderRedaction.pipe(Layer.provide(HttpObservability.layer)),
      ),
    ),
  );

export const withoutCapturedParentSpan = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.withFiber((fiber) => {
    const context = fiber.context;
    // HttpApiBuilder captures its build context for route handlers; an event parent would outlive export.
    fiber.setContext(Context.omit(Tracer.ParentSpan)(context));
    return effect.pipe(Effect.ensuring(Effect.sync(() => fiber.setContext(context))));
  });

export const layerClientAuth = Layer.effect(
  RelayClientAuth,
  Effect.gen(function* () {
    const config = yield* RelayConfiguration.RelayConfiguration;
    return {
      clientBearer: Effect.fn("relay.auth.client.bearer")(function* (httpEffect, { credential }) {
        const token = readHttpAuthorizationCredential(credential);
        const verified = yield* verifyRelayClientBearerToken(config, token).pipe(
          Effect.tapError((error) =>
            Effect.annotateCurrentSpan(
              "relay.auth.clerk_verification_failure",
              clerkVerificationFailureReason(error.cause),
            ),
          ),
          Effect.catch(() => relayAuthInvalidError("invalid_bearer")),
        );
        if (!verified.sub) {
          yield* Effect.annotateCurrentSpan({
            "relay.auth.clerk_verification_failure": "missing_subject",
          });
          return yield* relayAuthInvalidError("invalid_bearer");
        }
        yield* Effect.annotateCurrentSpan({
          "relay.auth.mode": verified.mode,
          "relay.auth.subject": verified.sub,
        });

        return yield* httpEffect.pipe(
          withSpanAttributes({ "user.id": verified.sub }),
          Effect.provideService(RelayClientPrincipal, {
            userId: verified.sub,
            token,
          }),
        );
      }),
    };
  }),
);

export const layerEnvironmentAuth = Layer.effect(
  RelayEnvironmentAuth,
  Effect.gen(function* () {
    const credentials = yield* EnvironmentCredentials.EnvironmentCredentials;
    return {
      environmentBearer: Effect.fn("relay.auth.environment.bearer")(function* (
        httpEffect,
        { credential },
      ) {
        const token = readHttpAuthorizationCredential(credential);
        const principal = yield* credentials.authenticate(token).pipe(
          Effect.catchTags({
            EnvironmentCredentialAuthenticatePersistenceError: () =>
              relayInternalErrorResponse("persistence_failed"),
          }),
        );
        if (principal._tag === "None") {
          return yield* relayAuthInvalidError("not_authorized");
        }
        yield* Effect.annotateCurrentSpan({
          "relay.auth.mode": "environment_credential",
        });
        return yield* httpEffect.pipe(
          withSpanAttributes({
            "relay.environment_id": principal.value.environmentId,
          }),
          Effect.provideService(RelayEnvironmentPrincipal, principal.value),
        );
      }),
    };
  }),
);

export const layerDpopClientAuth = Layer.effect(
  RelayDpopClientAuth,
  Effect.gen(function* () {
    const relayTokens = yield* RelayTokens.RelayTokens;
    return {
      relayDpop: Effect.fn("relay.auth.dpop_client")(function* (httpEffect, { credential }) {
        yield* appendRelayDpopChallengeHeader;
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (!isDpopAuthorizationHeader(request.headers.authorization)) {
          return yield* relayAuthInvalidError("invalid_bearer");
        }
        const token = readHttpAuthorizationCredential(credential);
        const now = yield* DateTime.now;
        const verified = yield* relayTokens.verifyDpopAccessToken({
          token,
          nowEpochSeconds: Math.floor(now.epochMilliseconds / 1_000),
        });
        if (!verified) {
          return yield* relayAuthInvalidError("invalid_bearer");
        }
        yield* Effect.annotateCurrentSpan({
          "relay.auth.mode": "dpop",
          "relay.auth.subject": verified.sub,
        });
        return yield* httpEffect.pipe(
          withSpanAttributes({ "user.id": verified.sub }),
          Effect.provideService(RelayClientPrincipal, {
            userId: verified.sub,
            token,
            proofKeyThumbprint: verified.cnf.jkt,
            dpopScopes: verified.scope,
          }),
        );
      }),
    };
  }),
);

function isDpopAuthorizationHeader(value: string | undefined): boolean {
  return /^DPoP +/iu.test(value ?? "");
}

function readHttpAuthorizationCredential(credential: Redacted.Redacted<string>): string {
  // Effect beta.73 leaves the scheme separator in decoded HTTP credentials.
  return Redacted.value(credential).trimStart();
}

export const layerMetadataApi = HttpApiBuilder.group(
  RelayApi,
  "metadata",
  Effect.fnUntraced(function* (handlers) {
    const settings = yield* RelayConfiguration.RelayConfiguration;
    const issuer = normalizeRelayIssuer(settings.relayIssuer);
    const scopes = [
      RelayEnvironmentConnectScope,
      RelayEnvironmentStatusScope,
      RelayMobileRegistrationScope,
    ] as const;
    return handlers
      .handle("authorizationServer", () =>
        Effect.succeed({
          issuer,
          token_endpoint: `${issuer}/v1/client/dpop-token`,
          grant_types_supported: ["urn:ietf:params:oauth:grant-type:token-exchange"],
          token_endpoint_auth_methods_supported: ["none"],
          dpop_signing_alg_values_supported: ["ES256"],
          scopes_supported: scopes,
        }),
      )
      .handle("protectedResource", () =>
        Effect.succeed({
          resource: issuer,
          authorization_servers: [issuer],
          scopes_supported: scopes,
          dpop_bound_access_tokens_required: true,
          dpop_signing_alg_values_supported: ["ES256"],
        }),
      );
  }),
);

export const layerPublicApi = HttpApiBuilder.group(
  RelayApi,
  "public",
  Effect.fnUntraced(function* (handlers) {
    const connectAccounts = yield* ConnectAccounts.ConnectAccounts;
    return handlers.handle(
      "founders",
      Effect.fn("relay.api.public.founders")(
        function* () {
          yield* appendPublicCounterCacheHeader;
          return yield* connectAccounts.foundersSummary();
        },
        Effect.catch(() => relayInternalErrorResponse("database_unavailable")),
      ),
    );
  }),
);

export const layerHealthApi = HttpApiBuilder.group(
  RelayApi,
  "health",
  Effect.fnUntraced(function* (handlers) {
    const db = yield* RelayDb.RelayDb;
    return handlers.handle(
      "health",
      Effect.fn("relay.api.health")(
        function* () {
          yield* db.all(drizzleSql`SELECT 1`);
          return { ok: true, service: "relay" as const };
        },
        Effect.catch(() => relayInternalErrorResponse("database_unavailable")),
      ),
    );
  }),
);

export {
  recoverEnvironmentTunnelRecord,
  registerEnvironmentTunnelRecovery,
  revokeEnvironmentLinkRecord,
  unlinkEnvironmentRecord,
  verifyEnvironmentTunnelRecoveryProof,
};

export const layerMobileApi = HttpApiBuilder.group(
  RelayApi,
  "mobile",
  Effect.fnUntraced(function* (handlers) {
    const registrations = yield* MobileRegistrations.MobileRegistrations;
    const dpopProofs = yield* DpopProofs.DpopProofReplay;
    return handlers
      .handle(
        "registerDevice",
        Effect.fn("relay.api.mobile.registerDevice")(function* (args) {
          const { payload } = args;
          const { userId, token } = yield* RelayClientPrincipal;
          const proofKeyThumbprint = yield* requireDpopPrincipalScope("mobile:registration");
          yield* requireDpopThumbprint(proofKeyThumbprint, {
            expectedAccessToken: token,
          }).pipe(Effect.provideService(DpopProofs.DpopProofReplay, dpopProofs));
          return yield* registrations.registerDevice({ userId, payload });
        }, mapRelayCommonApiErrors("invalid_dpop")),
      )
      .handle(
        "registerLiveActivity",
        Effect.fn("relay.api.mobile.registerLiveActivity")(function* (args) {
          const { payload } = args;
          const { userId, token } = yield* RelayClientPrincipal;
          const proofKeyThumbprint = yield* requireDpopPrincipalScope("mobile:registration");
          yield* requireDpopThumbprint(proofKeyThumbprint, {
            expectedAccessToken: token,
          }).pipe(Effect.provideService(DpopProofs.DpopProofReplay, dpopProofs));
          return yield* registrations.registerLiveActivity({ userId, payload });
        }, mapRelayCommonApiErrors("invalid_dpop")),
      )
      .handle(
        "getAgentActivitySnapshot",
        Effect.fn("relay.api.mobile.getAgentActivitySnapshot")(function* () {
          const { userId, token } = yield* RelayClientPrincipal;
          const proofKeyThumbprint = yield* requireDpopPrincipalScope("mobile:registration");
          yield* requireDpopThumbprint(proofKeyThumbprint, {
            expectedAccessToken: token,
          }).pipe(Effect.provideService(DpopProofs.DpopProofReplay, dpopProofs));
          return yield* registrations.getAgentActivitySnapshot({ userId });
        }, mapRelayCommonApiErrors("invalid_dpop")),
      )
      .handle(
        "unregisterDevice",
        Effect.fn("relay.api.mobile.unregisterDevice")(function* (args) {
          const { params } = args;
          const { userId, token } = yield* RelayClientPrincipal;
          const proofKeyThumbprint = yield* requireDpopPrincipalScope("mobile:registration");
          yield* requireDpopThumbprint(proofKeyThumbprint, {
            expectedAccessToken: token,
          }).pipe(Effect.provideService(DpopProofs.DpopProofReplay, dpopProofs));
          return yield* registrations.unregisterDevice({ userId, deviceId: params.deviceId });
        }, mapRelayCommonApiErrors("invalid_dpop")),
      );
  }),
);

export const layerClientApi = HttpApiBuilder.group(
  RelayApi,
  "client",
  Effect.fnUntraced(function* (handlers) {
    const config = yield* RelayConfiguration.RelayConfiguration;
    const crypto = yield* Crypto.Crypto;
    const relayTokens = yield* RelayTokens.RelayTokens;
    const linker = yield* EnvironmentLinker.EnvironmentLinker;
    const links = yield* EnvironmentLinks.EnvironmentLinks;
    const managedEndpointProvider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
    const devices = yield* Devices.Devices;
    return handlers
      .handle(
        "listEnvironments",
        Effect.fn("relay.api.client.listEnvironments")(function* () {
          yield* appendRelayCredentialResponseHeaders;
          const { userId } = yield* RelayClientPrincipal;
          const environments = yield* links.listForUser({ userId });
          const limits = yield* ManagedTunnelLimits.ManagedTunnelLimits;
          const managedTunnelPolicy = ManagedTunnelLimits.toManagedTunnelPolicy(
            yield* limits.resolve({ userId }),
          );
          return { environments, managedTunnelPolicy };
        }, mapRelayCommonApiErrors("not_authorized")),
      )
      .handle(
        "listDevices",
        Effect.fn("relay.api.client.listDevices")(function* () {
          yield* appendRelayCredentialResponseHeaders;
          const { userId } = yield* RelayClientPrincipal;
          const registered = yield* devices.listForUser({ userId });
          return {
            devices: registered.flatMap((device) =>
              device.platform === "ios" && device.iosMajorVersion !== null
                ? [{ ...device, platform: "ios" as const, iosMajorVersion: device.iosMajorVersion }]
                : [],
            ),
          };
        }, mapRelayCommonApiErrors("not_authorized")),
      )
      .handle(
        "listDevicesV2",
        Effect.fn("relay.api.client.listDevicesV2")(function* () {
          yield* appendRelayCredentialResponseHeaders;
          const { userId } = yield* RelayClientPrincipal;
          return { devices: yield* devices.listForUser({ userId }) };
        }, mapRelayCommonApiErrors("not_authorized")),
      )
      .handle(
        "linkEnvironment",
        Effect.fn("relay.api.client.linkEnvironment")(
          function* (args) {
            const { payload } = args;
            yield* appendRelayCredentialResponseHeaders;
            const { userId } = yield* RelayClientPrincipal;
            const result = yield* linker.link({ userId, request: payload });
            return {
              ok: true,
              cloudUserId: userId,
              environmentId: result.environmentId,
              endpoint: result.endpoint,
              endpointRuntime: result.endpointRuntime,
              relayIssuer: config.relayIssuer,
              environmentCredential: result.environmentCredential,
              cloudMintPublicKey: config.cloudMintPublicKey,
            };
          },
          mapErrorTags({
            EnvironmentLinkProofExpired: (_error, traceId) =>
              new RelayEnvironmentLinkProofExpiredError({
                code: "environment_link_proof_expired",
                traceId,
              }),
            EnvironmentLinkProofInvalid: (linkError, traceId) =>
              new RelayEnvironmentLinkProofInvalidError({
                code: "environment_link_proof_invalid",
                reason: linkError.reason,
                traceId,
              }),
            ManagedEndpointProvisioningNotConfigured: (_error, traceId) =>
              new RelayEnvironmentLinkUnavailableError({
                code: "environment_link_unavailable",
                reason: "managed_endpoint_not_configured",
                traceId,
              }),
            ManagedEndpointProvisioningFailed: (_error, traceId) =>
              new RelayEnvironmentLinkUnavailableError({
                code: "environment_link_unavailable",
                reason: "managed_endpoint_provisioning_failed",
                traceId,
              }),
            ManagedEndpointOriginNotAllowed: (_error, traceId) =>
              new RelayEnvironmentLinkProofInvalidError({
                code: "environment_link_proof_invalid",
                reason: "origin_not_allowed",
                traceId,
              }),
            ManagedTunnelLimitExceeded: (limitError, traceId) =>
              relayLinkLimitExceededError(limitError, traceId),
            ConnectAccountPersistenceError: (_error, traceId) =>
              new RelayEnvironmentLinkFailedError({
                code: "environment_link_failed",
                reason: "link_persistence_failed",
                traceId,
              }),
            EnvironmentLinkUpsertPersistenceError: (_error, traceId) =>
              new RelayEnvironmentLinkFailedError({
                code: "environment_link_failed",
                reason: "link_persistence_failed",
                traceId,
              }),
            EnvironmentCredentialCreatePersistenceError: (_error, traceId) =>
              new RelayEnvironmentLinkFailedError({
                code: "environment_link_failed",
                reason: "credential_persistence_failed",
                traceId,
              }),
            DpopProofReplayPersistenceError: (_error, traceId) =>
              new RelayEnvironmentLinkFailedError({
                code: "environment_link_failed",
                reason: "replay_persistence_failed",
                traceId,
              }),
          }),
          mapRelayCommonApiErrors("not_authorized"),
        ),
      )
      .handle(
        "createEnvironmentLinkChallenge",
        Effect.fn("relay.api.client.createEnvironmentLinkChallenge")(function* (args) {
          yield* appendRelayCredentialResponseHeaders;
          const { userId } = yield* RelayClientPrincipal;
          const now = yield* DateTime.now;
          const expiresAt = DateTime.add(now, { minutes: 5 });
          const jti = yield* crypto.randomUUIDv4.pipe(
            Effect.catch(() => relayInternalErrorResponse("internal_error")),
          );
          const challenge = yield* relayTokens
            .issueLinkChallenge({
              userId,
              request: args.payload,
              jti,
              issuedAtEpochSeconds: Math.floor(now.epochMilliseconds / 1_000),
              expiresAtEpochSeconds: Math.floor(expiresAt.epochMilliseconds / 1_000),
            })
            .pipe(Effect.catch(() => relayInternalErrorResponse("internal_error")));
          return { challenge, expiresAt: DateTime.formatIso(expiresAt) };
        }, mapRelayCommonApiErrors("not_authorized")),
      )
      .handle(
        "unlinkEnvironment",
        Effect.fn("relay.api.client.unlinkEnvironment")(function* (args) {
          const { params } = args;
          const { userId } = yield* RelayClientPrincipal;
          const unlinked = yield* unlinkEnvironmentRecord({
            userId,
            environmentId: params.environmentId,
            managedEndpointNamespace: config.managedEndpointNamespace,
          }).pipe(
            Effect.catchTags({
              ManagedEndpointDeprovisioningFailed: () =>
                relayInternalErrorResponse("upstream_unavailable"),
            }),
          );
          return { ok: unlinked };
        }, mapRelayCommonApiErrors("not_authorized")),
      )
      .handle(
        "deleteAccount",
        Effect.fn("relay.api.client.deleteAccount")(function* () {
          const { userId } = yield* RelayClientPrincipal;
          return yield* AccountDeletion.deleteAccountRecords({
            userId,
            managedEndpointNamespace: config.managedEndpointNamespace,
          }).pipe(
            Effect.catchTags({
              ManagedEndpointDeprovisioningFailed: () =>
                relayInternalErrorResponse("upstream_unavailable"),
              AccountDeletionIncomplete: () => relayInternalErrorResponse("upstream_unavailable"),
              ClerkUserDeletionFailed: () => relayInternalErrorResponse("upstream_unavailable"),
            }),
          );
        }, mapRelayCommonApiErrors("not_authorized")),
      )
      .handle(
        "releaseEnvironmentTunnel",
        Effect.fn("relay.api.client.releaseEnvironmentTunnel")(function* (args) {
          const { params } = args;
          const { userId } = yield* RelayClientPrincipal;
          // ok mirrors whether the connector token is now dead: false means a
          // concurrent provision kept the recorded tunnel alive, so the caller
          // must not discard its runtime config.
          const released = yield* managedEndpointProvider
            .release({
              userId,
              environmentId: params.environmentId,
            })
            .pipe(Effect.catch(() => relayInternalErrorResponse("upstream_unavailable")));
          return { ok: released };
        }, mapRelayCommonApiErrors("not_authorized")),
      );
  }),
);

export const layerTokenApi = HttpApiBuilder.group(
  RelayApi,
  "token",
  Effect.fnUntraced(function* (handlers) {
    const config = yield* RelayConfiguration.RelayConfiguration;
    const crypto = yield* Crypto.Crypto;
    const dpopProofs = yield* DpopProofs.DpopProofReplay;
    const relayTokens = yield* RelayTokens.RelayTokens;
    return handlers.handle(
      "exchangeDpopAccessToken",
      Effect.fn("relay.api.token.exchangeDpopAccessToken")(function* (args) {
        yield* appendRelayCredentialResponseHeaders;
        const issuer = normalizeRelayIssuer(config.relayIssuer);
        const requestedScopes = relayTokens.resolveDpopAccessTokenScopes({
          clientId: args.payload.client_id,
          scope: args.payload.scope,
        });
        yield* Effect.annotateCurrentSpan({
          "relay.auth.mode": "clerk_bearer_token_exchange",
          "relay.oauth.client_id": args.payload.client_id,
          "relay.oauth.scopes": args.payload.scope,
        });
        if (args.payload.resource !== issuer || requestedScopes === null) {
          return yield* new HttpApiError.Unauthorized({});
        }

        const verified = yield* verifyClerkBearerToken(config, args.payload.subject_token).pipe(
          Effect.catch(() => relayAuthInvalidError("invalid_bearer")),
        );
        if (!verified.sub || !hasExpectedClerkAudience(verified.aud, config.clerkJwtAudience)) {
          return yield* relayAuthInvalidError("invalid_bearer");
        }
        const proofKeyThumbprint = yield* requireDpopProof().pipe(
          Effect.provideService(DpopProofs.DpopProofReplay, dpopProofs),
        );
        const now = yield* DateTime.now;
        const expiresAt = DateTime.addDuration(now, RelayTokens.RELAY_DPOP_ACCESS_TOKEN_TTL);
        const jti = yield* crypto.randomUUIDv4.pipe(
          Effect.catch(() => relayInternalErrorResponse("internal_error")),
        );
        return {
          access_token: yield* relayTokens
            .issueDpopAccessToken({
              userId: verified.sub,
              proofKeyThumbprint,
              jti,
              issuedAtEpochSeconds: Math.floor(now.epochMilliseconds / 1_000),
              expiresAtEpochSeconds: Math.floor(expiresAt.epochMilliseconds / 1_000),
              clientId: args.payload.client_id,
              scopes: requestedScopes,
            })
            .pipe(Effect.catch(() => relayInternalErrorResponse("internal_error"))),
          issued_token_type: RelayAccessTokenType,
          token_type: "DPoP" as const,
          expires_in: Duration.toSeconds(RelayTokens.RELAY_DPOP_ACCESS_TOKEN_TTL),
          scope: encodeOAuthScope(requestedScopes),
        };
      }, mapRelayCommonApiErrors("invalid_dpop")),
    );
  }),
);

export const layerDpopClientApi = HttpApiBuilder.group(
  RelayApi,
  "dpopClient",
  Effect.fnUntraced(function* (handlers) {
    const connector = yield* EnvironmentConnector.EnvironmentConnector;
    const dpopProofs = yield* DpopProofs.DpopProofReplay;
    return handlers
      .handle(
        "connectEnvironment",
        Effect.fn("relay.api.dpopClient.connectEnvironment")(
          function* (args) {
            const { params, payload } = args;
            yield* appendRelayCredentialResponseHeaders;
            const { userId, token } = yield* RelayClientPrincipal;
            const proofKeyThumbprint = yield* requireDpopPrincipalScope("environment:connect");
            const requestedThumbprint = resolveConnectClientKeyThumbprint(payload);
            if (!requestedThumbprint || requestedThumbprint !== proofKeyThumbprint) {
              return yield* new HttpApiError.Unauthorized({});
            }
            const clientProofKeyThumbprint = yield* requireDpopThumbprint(proofKeyThumbprint, {
              expectedAccessToken: token,
            }).pipe(Effect.provideService(DpopProofs.DpopProofReplay, dpopProofs));
            return yield* connector.connect({
              userId,
              environmentId: params.environmentId,
              clientProofKeyThumbprint,
              ...(payload.deviceId ? { deviceId: payload.deviceId } : {}),
            });
          },
          mapRelayCommonApiErrors("invalid_dpop"),
          mapErrorTags({
            EnvironmentConnectNotAuthorized: (error, traceId) =>
              new RelayEnvironmentConnectNotAuthorizedError({
                code: "environment_connect_not_authorized",
                reason: error.reason,
                traceId,
              }),
            EnvironmentMintRequestFailed: (_error, traceId) =>
              new RelayEnvironmentEndpointUnavailableError({
                code: "environment_endpoint_unavailable",
                reason: "endpoint_request_failed",
                traceId,
              }),
            EnvironmentMintRequestTimedOut: (_error, traceId) =>
              new RelayEnvironmentEndpointTimedOutError({
                code: "environment_endpoint_timed_out",
                traceId,
              }),
            EnvironmentMintResponseInvalid: (_error, traceId) =>
              new RelayEnvironmentEndpointUnavailableError({
                code: "environment_endpoint_unavailable",
                reason: "endpoint_response_invalid",
                traceId,
              }),
          }),
        ),
      )
      .handle(
        "getEnvironmentStatus",
        Effect.fn("relay.api.dpopClient.getEnvironmentStatus")(
          function* (args) {
            const { params } = args;
            const { userId, token } = yield* RelayClientPrincipal;
            const proofKeyThumbprint = yield* requireDpopPrincipalScope("environment:status");
            yield* requireDpopThumbprint(proofKeyThumbprint, {
              expectedAccessToken: token,
            }).pipe(Effect.provideService(DpopProofs.DpopProofReplay, dpopProofs));
            return yield* connector.status({
              userId,
              environmentId: params.environmentId,
            });
          },
          mapRelayCommonApiErrors("invalid_dpop"),
          mapErrorTags({
            EnvironmentConnectNotAuthorized: (error, traceId) =>
              new RelayEnvironmentConnectNotAuthorizedError({
                code: "environment_connect_not_authorized",
                reason: error.reason,
                traceId,
              }),
            EnvironmentMintRequestFailed: (_error, traceId) =>
              new RelayEnvironmentEndpointUnavailableError({
                code: "environment_endpoint_unavailable",
                reason: "endpoint_request_failed",
                traceId,
              }),
            EnvironmentMintRequestTimedOut: (_error, traceId) =>
              new RelayEnvironmentEndpointTimedOutError({
                code: "environment_endpoint_timed_out",
                traceId,
              }),
            EnvironmentMintResponseInvalid: (_error, traceId) =>
              new RelayEnvironmentEndpointUnavailableError({
                code: "environment_endpoint_unavailable",
                reason: "endpoint_response_invalid",
                traceId,
              }),
          }),
        ),
      );
  }),
);

export const layerServerApi = HttpApiBuilder.group(
  RelayApi,
  "server",
  Effect.fnUntraced(function* (handlers) {
    const publisher = yield* AgentActivityPublisher.AgentActivityPublisher;
    const publishSignatures = yield* EnvironmentPublishSignatures.EnvironmentPublishSignatures;
    const heldHooks = yield* HeldHooks.HeldHooks;
    const requireOwnEnvironment = (environmentId: string) =>
      Effect.gen(function* () {
        const principal = yield* RelayEnvironmentPrincipal;
        if (principal.environmentId !== environmentId) {
          return yield* new HttpApiError.Unauthorized({});
        }
      });
    const activityHandlers = handlers.handle(
      "publishAgentActivity",
      Effect.fn("relay.api.server.publishAgentActivity")(
        function* (args) {
          const { params, payload } = args;
          const principal = yield* RelayEnvironmentPrincipal;
          if (principal.environmentId !== params.environmentId) {
            return yield* new HttpApiError.Unauthorized({});
          }
          yield* publishSignatures.verify({
            environmentId: params.environmentId,
            environmentPublicKey: principal.environmentPublicKey,
            threadId: params.threadId,
            request: payload,
          });
          return yield* publisher.publish({
            environmentId: params.environmentId,
            environmentPublicKey: principal.environmentPublicKey,
            threadId: params.threadId,
            state: payload.state,
          });
        },
        mapErrorTags({
          EnvironmentPublishPublicKeyMissing: (_error, traceId) =>
            new RelayAuthInvalidError({
              code: "auth_invalid",
              reason: "not_authorized",
              traceId,
            }),
          EnvironmentPublishSignatureExpired: (_error, traceId) =>
            new RelayAgentActivityPublishProofExpiredError({
              code: "agent_activity_publish_proof_expired",
              traceId,
            }),
          EnvironmentPublishSignatureInvalid: (_error, traceId) =>
            new RelayAgentActivityPublishProofInvalidError({
              code: "agent_activity_publish_proof_invalid",
              reason: "invalid_signature_or_payload",
              traceId,
            }),
          DpopProofReplayPersistenceError: (_error, traceId) =>
            new RelayInternalError({
              code: "internal_error",
              reason: "persistence_failed",
              traceId,
            }),
          ApnsDeliveryJobQueuePayloadInvalid: (_error, traceId) =>
            new RelayInternalError({
              code: "internal_error",
              reason: "internal_error",
              traceId,
            }),
          ApnsDeliveryJobLiveActivityAggregateMissing: (_error, traceId) =>
            new RelayInternalError({
              code: "internal_error",
              reason: "internal_error",
              traceId,
            }),
          ApnsDeliveryJobLiveActivityNotificationUnexpected: (_error, traceId) =>
            new RelayInternalError({
              code: "internal_error",
              reason: "internal_error",
              traceId,
            }),
          ApnsDeliveryJobPushNotificationMissing: (_error, traceId) =>
            new RelayInternalError({
              code: "internal_error",
              reason: "internal_error",
              traceId,
            }),
          ApnsDeliveryJobPushNotificationAggregateUnexpected: (_error, traceId) =>
            new RelayInternalError({
              code: "internal_error",
              reason: "internal_error",
              traceId,
            }),
          ApnsDeliveryJobCreatedAtInvalid: (_error, traceId) =>
            new RelayInternalError({
              code: "internal_error",
              reason: "internal_error",
              traceId,
            }),
          ApnsDeliveryJobExpiresAtInvalid: (_error, traceId) =>
            new RelayInternalError({
              code: "internal_error",
              reason: "internal_error",
              traceId,
            }),
          ApnsDeliveryJobTimeWindowInvalid: (_error, traceId) =>
            new RelayInternalError({
              code: "internal_error",
              reason: "internal_error",
              traceId,
            }),
          ApnsDeliveryJobTimeWindowTooLong: (_error, traceId) =>
            new RelayInternalError({
              code: "internal_error",
              reason: "internal_error",
              traceId,
            }),
          ApnsDeliveryJobSignatureInvalid: (_error, traceId) =>
            new RelayInternalError({
              code: "internal_error",
              reason: "internal_error",
              traceId,
            }),
          ApnsDeliveryJobExpired: (_error, traceId) =>
            new RelayInternalError({
              code: "internal_error",
              reason: "internal_error",
              traceId,
            }),
          ApnsDeliveryJobClaimInFlight: (_error, traceId) =>
            new RelayInternalError({
              code: "internal_error",
              reason: "internal_error",
              traceId,
            }),
          ApnsDeliveryQueueSendError: (_error, traceId) =>
            new RelayInternalError({
              code: "internal_error",
              reason: "upstream_unavailable",
              traceId,
            }),
          FcmDeliveryError: (_error, traceId) =>
            new RelayInternalError({
              code: "internal_error",
              reason: "upstream_unavailable",
              traceId,
            }),
        }),
        mapRelayCommonApiErrors("not_authorized"),
      ),
    );

    return activityHandlers
      .handle(
        "registerManagedEndpointRecovery",
        Effect.fn("relay.api.server.registerManagedEndpointRecovery")(
          function* ({ params, payload }) {
            const principal = yield* RelayEnvironmentPrincipal;
            if (principal.environmentId !== params.environmentId) {
              return yield* new HttpApiError.Unauthorized({});
            }
            yield* verifyEnvironmentTunnelRecoveryProof({
              action: "register",
              proof: payload.proof,
              userId: payload.cloudUserId,
              environmentId: params.environmentId,
              environmentPublicKey: principal.environmentPublicKey,
              tunnelId: payload.tunnelId,
              origin: payload.origin,
            });
            yield* appendRelayCredentialResponseHeaders;
            return yield* registerEnvironmentTunnelRecovery({
              userId: payload.cloudUserId,
              environmentId: params.environmentId,
              environmentPublicKey: principal.environmentPublicKey,
              tunnelId: payload.tunnelId,
              origin: payload.origin,
            });
          },
          Effect.catchTags({
            ManagedEndpointOriginNotAllowed: () => Effect.fail(new HttpApiError.Unauthorized({})),
            ManagedEndpointProvisioningNotConfigured: () =>
              relayInternalErrorResponse("upstream_unavailable"),
            ManagedEndpointProvisioningFailed: () =>
              relayInternalErrorResponse("upstream_unavailable"),
            ManagedTunnelLimitExceeded: (limitError) =>
              currentTraceId.pipe(
                Effect.flatMap((traceId) =>
                  Effect.fail(relayLinkLimitExceededError(limitError, traceId)),
                ),
              ),
          }),
          mapRelayCommonApiErrors("not_authorized"),
        ),
      )
      .handle(
        "recoverManagedEndpoint",
        Effect.fn("relay.api.server.recoverManagedEndpoint")(
          function* ({ params, payload }) {
            const principal = yield* RelayEnvironmentPrincipal;
            if (principal.environmentId !== params.environmentId) {
              return yield* new HttpApiError.Unauthorized({});
            }
            yield* verifyEnvironmentTunnelRecoveryProof({
              action: "recover",
              proof: payload.proof,
              userId: payload.cloudUserId,
              environmentId: params.environmentId,
              environmentPublicKey: principal.environmentPublicKey,
              origin: payload.origin,
            });
            yield* appendRelayCredentialResponseHeaders;
            return yield* recoverEnvironmentTunnelRecord({
              userId: payload.cloudUserId,
              environmentId: params.environmentId,
              environmentPublicKey: principal.environmentPublicKey,
              origin: payload.origin,
            });
          },
          Effect.catchTags({
            ManagedEndpointOriginNotAllowed: () => Effect.fail(new HttpApiError.Unauthorized({})),
            ManagedEndpointProvisioningNotConfigured: () =>
              relayInternalErrorResponse("upstream_unavailable"),
            ManagedEndpointProvisioningFailed: () =>
              relayInternalErrorResponse("upstream_unavailable"),
            ManagedEndpointDeprovisioningFailed: () =>
              relayInternalErrorResponse("upstream_unavailable"),
            ManagedTunnelLimitExceeded: (limitError) =>
              currentTraceId.pipe(
                Effect.flatMap((traceId) =>
                  Effect.fail(relayLinkLimitExceededError(limitError, traceId)),
                ),
              ),
          }),
          mapRelayCommonApiErrors("not_authorized"),
        ),
      )
      .handle(
        "updateLinkPreferences",
        Effect.fn("relay.api.server.updateLinkPreferences")(function* ({ params, payload }) {
          yield* requireOwnEnvironment(params.environmentId);
          const principal = yield* RelayEnvironmentPrincipal;
          yield* heldHooks.setHoldWhileOffline({
            environmentId: params.environmentId,
            environmentPublicKey: principal.environmentPublicKey,
            holdWebhooksWhileOffline: payload.holdWebhooksWhileOffline,
          });
          return payload;
        }, mapRelayCommonApiErrors("not_authorized")),
      )
      .handle(
        "wakeHeldHooks",
        Effect.fn("relay.api.server.wakeHeldHooks")(function* ({ params }) {
          yield* requireOwnEnvironment(params.environmentId);
          const principal = yield* RelayEnvironmentPrincipal;
          const pending = yield* heldHooks.wake({
            environmentId: params.environmentId,
            environmentPublicKey: principal.environmentPublicKey,
          });
          return { pending };
        }, mapRelayCommonApiErrors("not_authorized")),
      );
  }),
);

class ClerkTokenVerificationFailed extends Schema.TaggedError<ClerkTokenVerificationFailed>()(
  "ClerkTokenVerificationFailed",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Clerk token verification failed";
  }
}

const isHttpUnauthorized = Schema.is(HttpApiError.Unauthorized);
const isDpopProofRejected = Schema.is(DpopProofs.DpopProofRejected);

const RelayCommonPersistenceError = Schema.Union([
  ManagedTunnelLimits.ManagedTunnelLimitPersistenceError,
  Devices.DeviceRegistrationPersistenceError,
  Devices.DeviceUnregistrationPersistenceError,
  Devices.DeviceListPersistenceError,
  LiveActivities.LiveActivityRegistrationPersistenceError,
  EnvironmentLinks.EnvironmentLinkUserListPersistenceError,
  EnvironmentLinks.EnvironmentLinkListPersistenceError,
  EnvironmentLinks.EnvironmentLinkLookupPersistenceError,
  EnvironmentLinks.EnvironmentLinkRevokePersistenceError,
  ManagedEndpointAllocations.ManagedEndpointAllocationPersistenceError,
  EnvironmentCredentials.EnvironmentCredentialAuthenticatePersistenceError,
  EnvironmentCredentials.EnvironmentCredentialRevokePersistenceError,
  DpopProofs.DpopProofReplayPersistenceError,
  LiveActivities.LiveActivityTargetListPersistenceError,
  AgentActivityRows.AgentActivityRowUpsertPersistenceError,
  AgentActivityRows.AgentActivityRowDeletePersistenceError,
  AgentActivityRows.AgentActivityRowListPersistenceError,
  LiveActivities.LiveActivityDeliveryMarkPersistenceError,
  DeliveryAttempts.DeliveryAttemptRecordPersistenceError,
  EnvironmentLinks.EnvironmentLinkEnvironmentLookupPersistenceError,
  HookInbox.HookInboxError,
  AccountDeletion.AccountRecordsPersistenceError,
]);
type RelayCommonPersistenceError = typeof RelayCommonPersistenceError.Type;
const isRelayCommonPersistenceError = Schema.is(RelayCommonPersistenceError);

type MapRelayCommonApiError<E> =
  | Exclude<
      E,
      HttpApiError.Unauthorized | DpopProofs.DpopProofRejected | RelayCommonPersistenceError
    >
  | (Extract<E, HttpApiError.Unauthorized> extends never ? never : RelayAuthInvalidError)
  | (Extract<E, DpopProofs.DpopProofRejected> extends never ? never : RelayAuthInvalidError)
  | (Extract<E, RelayCommonPersistenceError> extends never ? never : RelayInternalError);

export function relayDpopFailureReason(
  code: DpopProofs.DpopProofFailureCode,
): RelayDpopFailureReason {
  switch (code) {
    case "time_window":
      return "time_window";
    case "key_mismatch":
      return "key_mismatch";
    case "method_mismatch":
    case "url_mismatch":
      return "request_mismatch";
    case "access_token_hash_mismatch":
      return "token_mismatch";
    case "replayed":
      return "replay";
    case "missing_proof":
    case "malformed_proof":
    case "invalid_signature":
    case "invalid_proof":
      return "invalid_proof";
  }
}

/** The 403 every managed-machine path returns when a cap refuses a new machine. */
function relayLinkLimitExceededError(
  limitError: Pick<ManagedTunnelLimits.ManagedTunnelLimitExceeded, "maxTunnels" | "reason">,
  traceId: string,
) {
  return new RelayEnvironmentLinkLimitExceededError({
    code: "environment_link_limit_exceeded",
    maxTunnels: limitError.maxTunnels,
    reason: limitError.reason,
    traceId,
  });
}

function relayInternalErrorResponse(reason: RelayInternalError["reason"]) {
  return currentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(new RelayInternalError({ code: "internal_error", reason, traceId })),
    ),
  );
}

function mapRelayCommonApiErrors(authReason: RelayAuthInvalidReason) {
  const mapError = Effect.fnUntraced(function* <E>(error: E) {
    const traceId = yield* currentTraceId;
    if (isDpopProofRejected(error)) {
      yield* Effect.annotateCurrentSpan({
        "relay.dpop.failure_code": error.code,
      });
      return yield* Effect.fail(
        new RelayAuthInvalidError({
          code: "auth_invalid",
          reason: authReason,
          ...(authReason === "invalid_dpop"
            ? { dpopFailureReason: relayDpopFailureReason(error.code) }
            : {}),
          traceId,
        }) as MapRelayCommonApiError<E>,
      );
    }
    if (isHttpUnauthorized(error)) {
      if (authReason === "invalid_dpop") {
        yield* Effect.annotateCurrentSpan({
          "relay.dpop.failure_code": "invalid_proof",
        });
      }
      return yield* Effect.fail(
        new RelayAuthInvalidError({
          code: "auth_invalid",
          reason: authReason,
          ...(authReason === "invalid_dpop" ? { dpopFailureReason: "invalid_proof" } : {}),
          traceId,
        }) as MapRelayCommonApiError<E>,
      );
    }
    if (isRelayCommonPersistenceError(error)) {
      return yield* Effect.fail(
        new RelayInternalError({
          code: "internal_error",
          reason: "persistence_failed",
          traceId,
        }) as MapRelayCommonApiError<E>,
      );
    }

    return yield* Effect.fail(error as MapRelayCommonApiError<E>);
  });

  return <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, MapRelayCommonApiError<E>, R> => effect.pipe(Effect.catch(mapError));
}

function resolveConnectClientKeyThumbprint(payload: RelayEnvironmentConnectRequest): string | null {
  const requestedThumbprint = payload.clientKeyThumbprint ?? payload.clientProofKeyThumbprint;
  if (!requestedThumbprint) {
    return null;
  }
  if (
    payload.clientKeyThumbprint &&
    payload.clientProofKeyThumbprint &&
    payload.clientKeyThumbprint !== payload.clientProofKeyThumbprint
  ) {
    return null;
  }
  return requestedThumbprint;
}

function safeAuthFailureReason(value: string): string {
  return /^[a-z0-9._-]+$/i.test(value) ? value : "unknown";
}

function clerkVerificationFailureReason(cause: unknown): string {
  if (
    cause instanceof Error &&
    (cause.message.startsWith("Invalid JWT audience claim ") ||
      cause.message.startsWith("Invalid JWT audience claim array "))
  ) {
    return "audience_mismatch";
  }
  if (typeof cause === "object" && cause !== null && "reason" in cause) {
    const reason = (cause as { readonly reason?: unknown }).reason;
    if (typeof reason === "string" && reason.length > 0) {
      return safeAuthFailureReason(reason);
    }
  }
  if (cause instanceof Error && cause.name) {
    return safeAuthFailureReason(cause.name);
  }
  return "unknown";
}

function hasExpectedClerkAudience(audience: unknown, expectedAudience: string): boolean {
  return typeof audience === "string"
    ? audience === expectedAudience
    : Array.isArray(audience) &&
        audience.some((entry) => typeof entry === "string" && entry === expectedAudience);
}

function verifyClerkBearerToken(
  config: RelayConfiguration.RelayConfiguration["Service"],
  token: string,
) {
  const verifyRemote = () =>
    verifyToken(token, {
      secretKey: Redacted.value(config.clerkSecretKey),
      audience: config.clerkJwtAudience,
    });
  return Effect.tryPromise({
    try: async () => {
      if (!config.clerkJwtKey) return verifyRemote();
      try {
        return await verifyToken(token, {
          jwtKey: config.clerkJwtKey,
          audience: config.clerkJwtAudience,
        });
      } catch (error) {
        // An expired token stays rejected. Anything else (a rotated Clerk key,
        // a malformed pinned key) gets the remote JWKS check, so a bad
        // variable degrades to the old path instead of rejecting sign-ins.
        if (clerkVerificationFailureReason(error) === "token-expired") throw error;
        return verifyRemote();
      }
    },
    catch: (cause) => new ClerkTokenVerificationFailed({ cause }),
  }).pipe(
    Effect.withSpan("verify_clerk_bearer_token", {
      attributes: {
        "relay.auth.token_length": token.length,
        "relay.auth.jwt_key_pinned": config.clerkJwtKey !== undefined,
      },
    }),
  );
}

const CLERK_OAUTH_TOKEN_PREFIX = "oat_";
const CLERK_OAUTH_CACHE_TTL_MS = 60_000;
const CLERK_OAUTH_CACHE_MAX_ENTRIES = 1_000;

/**
 * Successful CLI OAuth verifications per isolate, keyed by a token digest.
 * Opaque OAuth tokens verify through Clerk's Backend API, which is rate
 * limited per instance; a headless host calls the relay several times a
 * minute with the same token. Revocation takes effect within the TTL.
 */
const clerkOAuthVerifications = new Map<
  string,
  { readonly sub: string; readonly expiresAt: number }
>();

async function clerkOAuthCacheKey(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function clearClerkOAuthVerificationCache(): void {
  clerkOAuthVerifications.clear();
}

function rememberClerkOAuthVerification(key: string, sub: string, now: number): void {
  if (clerkOAuthVerifications.size >= CLERK_OAUTH_CACHE_MAX_ENTRIES) {
    for (const [entryKey, entry] of clerkOAuthVerifications) {
      if (entry.expiresAt <= now) clerkOAuthVerifications.delete(entryKey);
    }
    if (clerkOAuthVerifications.size >= CLERK_OAUTH_CACHE_MAX_ENTRIES) {
      const oldest = clerkOAuthVerifications.keys().next();
      if (!oldest.done) clerkOAuthVerifications.delete(oldest.value);
    }
  }
  clerkOAuthVerifications.set(key, { sub, expiresAt: now + CLERK_OAUTH_CACHE_TTL_MS });
}

function verifyClerkOAuthBearerToken(
  config: RelayConfiguration.RelayConfiguration["Service"],
  token: string,
) {
  return Clock.currentTimeMillis.pipe(
    Effect.flatMap((now) =>
      Effect.tryPromise({
        try: async () => {
          const key = await clerkOAuthCacheKey(token);
          const cached = clerkOAuthVerifications.get(key);
          if (cached && cached.expiresAt > now) {
            return { sub: cached.sub };
          }
          clerkOAuthVerifications.delete(key);
          const client = createClerkClient({
            secretKey: Redacted.value(config.clerkSecretKey),
            publishableKey: config.clerkPublishableKey,
          });
          const state = await client.authenticateRequest(
            new Request(config.relayIssuer, {
              headers: { authorization: `Bearer ${token}` },
            }),
            { acceptsToken: "oauth_token" },
          );
          const auth = state.toAuth();
          if (!state.isAuthenticated || !auth.userId) {
            throw new Error("Clerk OAuth token is not authenticated.");
          }
          rememberClerkOAuthVerification(key, auth.userId, now);
          return { sub: auth.userId };
        },
        catch: (cause) => new ClerkTokenVerificationFailed({ cause }),
      }),
    ),
  );
}

export function verifyRelayClientBearerToken(
  config: RelayConfiguration.RelayConfiguration["Service"],
  token: string,
) {
  const verifyOAuth = verifyClerkOAuthBearerToken(config, token).pipe(
    Effect.map((verified) => ({ ...verified, mode: "clerk_oauth_bearer" as const })),
  );
  // Opaque OAuth tokens are never session JWTs; skip the JWKS round trip.
  if (token.startsWith(CLERK_OAUTH_TOKEN_PREFIX)) {
    return verifyOAuth;
  }
  return verifyClerkBearerToken(config, token).pipe(
    Effect.flatMap((verified) =>
      verified.sub && hasExpectedClerkAudience(verified.aud, config.clerkJwtAudience)
        ? Effect.succeed({ sub: verified.sub, mode: "clerk_session_bearer" as const })
        : Effect.fail(new ClerkTokenVerificationFailed({ cause: "missing_relay_audience" })),
    ),
    Effect.catch(() => verifyOAuth),
  );
}

const requireDpopPrincipalScope = Effect.fn("relay.api.require_dpop_principal_scope")(function* (
  scope: RelayDpopAccessTokenScope,
) {
  yield* Effect.annotateCurrentSpan({ "relay.dpop.required_scope": scope });
  const principal = yield* RelayClientPrincipal;
  if (!principal.proofKeyThumbprint || !principal.dpopScopes?.includes(scope)) {
    return yield* new HttpApiError.Unauthorized({});
  }
  return principal.proofKeyThumbprint;
});

const requireDpopThumbprint = Effect.fn("relay.api.require_dpop_thumbprint")(function* (
  expectedThumbprint: string,
  options?: {
    readonly expectedAccessToken?: string;
  },
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const now = yield* DateTime.now;
  const url = HttpServerRequest.toURL(request);
  if (url._tag === "None") {
    return yield* new HttpApiError.Unauthorized({});
  }
  const dpopProofs = yield* DpopProofs.DpopProofReplay;
  return yield* dpopProofs.verifyAndConsume({
    proof: request.headers.dpop,
    method: request.method,
    url: url.value.href,
    now,
    expectedThumbprint,
    ...(options?.expectedAccessToken ? { expectedAccessToken: options.expectedAccessToken } : {}),
  });
});

const requireDpopProof = Effect.fn("relay.api.require_dpop_proof")(function* (options?: {
  readonly expectedAccessToken?: string;
}) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const now = yield* DateTime.now;
  const url = HttpServerRequest.toURL(request);
  if (url._tag === "None") {
    return yield* new HttpApiError.Unauthorized({});
  }
  const dpopProofs = yield* DpopProofs.DpopProofReplay;
  return yield* dpopProofs.verifyAndConsume({
    proof: request.headers.dpop,
    method: request.method,
    url: url.value.href,
    now,
    ...(options?.expectedAccessToken ? { expectedAccessToken: options.expectedAccessToken } : {}),
  });
});

const relayAuthInvalidError = Effect.fnUntraced(function* (reason: RelayAuthInvalidReason) {
  const traceId = yield* currentTraceId;
  yield* Effect.annotateCurrentSpan({
    "relay.trace_id": traceId,
    "relay.error.outbound_tag": "RelayAuthInvalidError",
    "relay.error.outbound_reason": reason,
  });
  return yield* new RelayAuthInvalidError({ code: "auth_invalid", reason, traceId });
});
