import {
  type ClientConnectionMethod,
  EnvironmentAuthInvalidError,
  EnvironmentId,
  type ExecutionEnvironmentDescriptor,
} from "@specweave-studio/contracts";
import { RelayEnvironmentConnectScope } from "@specweave-studio/contracts/relay";
import { withRelayClientTracing } from "@specweave-studio/shared/relayTracing";
import {
  exchangeRemoteDpopAccessToken,
  type RemoteEnvironmentAuthError,
  resolveRemoteDpopWebSocketConnectionUrl,
  resolveRemoteWebSocketConnectionUrl,
} from "./remote.ts";
import {
  environmentMismatchError,
  mapManagedRelayError,
  mapRemoteDpopEnvironmentError,
  mapRemoteEnvironmentError,
} from "../connection/errors.ts";
import {
  ConnectionBlockedError,
  ConnectionTransientError,
  type ConnectionAttemptError,
} from "../connection/model.ts";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import * as TokenStore from "./tokenStore.ts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/http/HttpClient";

import {
  DPOP_ACCESS_TOKEN_REFRESH_SKEW_MS,
  type PreparedHttpAuthorization,
} from "../connection/model.ts";

export interface AuthorizedRemoteEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly httpBaseUrl: string;
  readonly socketUrl: string;
  readonly httpAuthorization: PreparedHttpAuthorization;
  /**
   * The descriptor this authorization fetched and checked against the expected
   * environment during this call, so the caller does not fetch it again.
   * Absent when the check reused a cached descriptor, which can be stale.
   */
  readonly descriptor?: ExecutionEnvironmentDescriptor;
}

export interface AuthorizedRemoteHttpEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly httpBaseUrl: string;
  readonly httpAuthorization: Extract<PreparedHttpAuthorization, { readonly _tag: "Dpop" }>;
}

export class RemoteEnvironmentAuthorization extends Context.Service<
  RemoteEnvironmentAuthorization,
  {
    readonly authorizeBearer: (input: {
      readonly expectedEnvironmentId: EnvironmentId;
      readonly httpBaseUrl: string;
      readonly wsBaseUrl: string;
      readonly bearerToken: string;
      readonly connectionMethod: ClientConnectionMethod;
      /** Budget for each setup request; the default suits a remote server. */
      readonly requestTimeoutMs?: number;
    }) => Effect.Effect<AuthorizedRemoteEnvironment, ConnectionAttemptError>;
    readonly authorizeDpop: (input: {
      readonly expectedEnvironmentId: EnvironmentId;
      /**
       * Connect to this origin instead of the Studio Connect tunnel. The access
       * token is not bound to an origin, and each proof is minted for the URL
       * it signs, so a token from the relay also works on the environment's
       * LAN or tailnet address.
       */
      readonly directEndpoint?: { readonly httpBaseUrl: string; readonly wsBaseUrl: string };
    }) => Effect.Effect<AuthorizedRemoteEnvironment, ConnectionAttemptError>;
    readonly authorizeDpopHttp: (input: {
      readonly expectedEnvironmentId: EnvironmentId;
      readonly rejectedAccessToken?: string;
    }) => Effect.Effect<AuthorizedRemoteHttpEnvironment, ConnectionAttemptError>;
  }
>()("@specweave-studio/client-runtime/authorization/service/RemoteEnvironmentAuthorization") {}

const CACHED_ENDPOINT_SOCKET_TIMEOUT_MS = 3_000;
const BEARER_DESCRIPTOR_CACHE_TTL_MS = 10_000;
const DPOP_AUTHORIZATION_TIMEOUT_MS = 30_000;

/** First wait after a failed credential renewal; it doubles with each failure in a row. */
export const DPOP_RENEWAL_BACKOFF_BASE_MS = 5_000;
/** Longest wait between failed credential renewals for one environment. */
export const DPOP_RENEWAL_BACKOFF_MAX_MS = 300_000;

/**
 * How long to wait before the next credential renewal after `failures` failed
 * in a row (counting from 1). Each renewal asks the machine to mint a pairing
 * credential through the relay, so a client that keeps failing must not ask on
 * every poll. Equal jitter spreads clients that failed together.
 */
export function dpopRenewalBackoffMs(failures: number, random: number): number {
  const ceiling = Math.min(
    DPOP_RENEWAL_BACKOFF_MAX_MS,
    DPOP_RENEWAL_BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1),
  );
  return Math.round(ceiling / 2 + (ceiling / 2) * random);
}

/**
 * The failure to repeat while a renewal backoff lasts. A transient failure
 * carries the time left, so the connection supervisor does not retry sooner.
 */
function withRenewalRetryAfter(error: ConnectionAttemptError, remainingMs: number) {
  if (error._tag !== "ConnectionTransientError") return error;
  return new ConnectionTransientError({
    reason: error.reason,
    detail: error.detail,
    ...(error.traceId === undefined ? {} : { traceId: error.traceId }),
    ...(error.machineOffline === undefined ? {} : { machineOffline: error.machineOffline }),
    retryAfterMs: remainingMs,
  });
}

function mapDpopSocketError(error: RemoteEnvironmentAuthError | ConnectionAttemptError) {
  return error._tag === "ConnectionTransientError" || error._tag === "ConnectionBlockedError"
    ? error
    : mapRemoteDpopEnvironmentError(error);
}

const fetchDescriptor = Effect.fn("clientRuntime.connection.remote.fetchDescriptor")(function* (
  httpBaseUrl: string,
  connectionMethod: ClientConnectionMethod,
  timeoutMs?: number,
) {
  return yield* fetchRemoteEnvironmentDescriptor({
    httpBaseUrl,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  }).pipe(Effect.mapError((error) => mapRemoteEnvironmentError(error, connectionMethod)));
});

export const make = Effect.gen(function* () {
  const serviceScope = yield* Scope.Scope;
  const signer = yield* ManagedRelay.ManagedRelayDpopSigner;
  const relay = yield* ManagedRelay.ManagedRelayClient;
  const cloudSession = yield* ClientCapabilities.CloudSession;
  const deviceIdentity = yield* ClientCapabilities.RelayDeviceIdentity;
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const tokenStore = yield* TokenStore.RemoteDpopAccessTokenStore;
  const httpClient = yield* HttpClient.HttpClient;
  const tokenLock = yield* Semaphore.make(1);
  const tokenOwners = new Map<
    EnvironmentId,
    { readonly accessToken: string; readonly identity: ClientCapabilities.CloudSessionIdentity }
  >();
  const pendingTokens = new Map<
    EnvironmentId,
    {
      readonly id: object;
      readonly identity: ClientCapabilities.CloudSessionIdentity;
      readonly thumbprint: string;
      readonly token: Effect.Effect<TokenStore.RemoteDpopAccessToken, ConnectionAttemptError>;
    }
  >();
  /**
   * Renewals that minted a pairing credential through the relay and then
   * failed, per environment, until the next one may be tried. Without this,
   * every poll asked the machine to mint another credential (one desktop app
   * minted one every few seconds for hours while the machine refused its
   * exchange, or accepted it and then rejected the token it issued).
   *
   * A renewal whose exchange succeeds keeps its record, holding the issued
   * token, until that token is accepted: a socket opens with it, or it is
   * replaced without having been rejected. A rejection counts as one more
   * failed renewal.
   */
  const failedRenewals = new Map<
    EnvironmentId,
    {
      readonly identity: ClientCapabilities.CloudSessionIdentity;
      readonly thumbprint: string;
      readonly failures: number;
      readonly retryAtEpochMs: number;
      readonly error?: ConnectionAttemptError;
      readonly renewedAccessToken?: string;
    }
  >();
  const bearerDescriptors = yield* Ref.make<
    ReadonlyMap<
      EnvironmentId,
      {
        readonly httpBaseUrl: string;
        readonly descriptor: ExecutionEnvironmentDescriptor;
        readonly validatedAtEpochMs: number;
      }
    >
  >(new Map());

  /**
   * Confirms a direct address still serves the expected environment before a
   * credential is sent there. A saved LAN address can belong to another
   * machine on a different network.
   */
  const verifyDirectEndpoint = Effect.fn("clientRuntime.connection.remote.verifyDirectEndpoint")(
    function* (input: {
      readonly expectedEnvironmentId: EnvironmentId;
      readonly httpBaseUrl: string;
      readonly connectionMethod: ClientConnectionMethod;
      readonly requestTimeoutMs?: number;
    }) {
      const now = yield* Clock.currentTimeMillis;
      const cachedDescriptor = (yield* Ref.get(bearerDescriptors)).get(input.expectedEnvironmentId);
      const canReuseDescriptor =
        cachedDescriptor?.httpBaseUrl === input.httpBaseUrl &&
        cachedDescriptor.validatedAtEpochMs + BEARER_DESCRIPTOR_CACHE_TTL_MS > now;
      const descriptor = canReuseDescriptor
        ? cachedDescriptor.descriptor
        : yield* fetchDescriptor(
            input.httpBaseUrl,
            input.connectionMethod,
            input.requestTimeoutMs,
          ).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
      if (descriptor.environmentId !== input.expectedEnvironmentId) {
        return yield* environmentMismatchError({
          expected: input.expectedEnvironmentId,
          actual: descriptor.environmentId,
        });
      }
      if (!canReuseDescriptor) {
        yield* Ref.update(bearerDescriptors, (current) => {
          const next = new Map(current);
          next.set(input.expectedEnvironmentId, {
            httpBaseUrl: input.httpBaseUrl,
            descriptor,
            validatedAtEpochMs: now,
          });
          return next;
        });
      }
      // `fresh` says this call fetched the descriptor rather than reusing the
      // cached one, which can be up to the cache TTL old.
      return { descriptor, fresh: !canReuseDescriptor };
    },
  );

  const authorizeBearer = Effect.fn("clientRuntime.connection.remote.authorizeBearer")(
    function* (input: {
      readonly expectedEnvironmentId: Parameters<
        RemoteEnvironmentAuthorization["Service"]["authorizeBearer"]
      >[0]["expectedEnvironmentId"];
      readonly httpBaseUrl: string;
      readonly wsBaseUrl: string;
      readonly bearerToken: string;
      readonly connectionMethod: ClientConnectionMethod;
      readonly requestTimeoutMs?: number;
    }) {
      const { descriptor, fresh } = yield* verifyDirectEndpoint(input);
      const socketUrl = yield* resolveRemoteWebSocketConnectionUrl({
        wsBaseUrl: input.wsBaseUrl,
        httpBaseUrl: input.httpBaseUrl,
        bearerToken: input.bearerToken,
        clientMetadata: presentation.metadata,
        connectionMethod: input.connectionMethod,
        ...(input.requestTimeoutMs === undefined ? {} : { timeoutMs: input.requestTimeoutMs }),
      }).pipe(
        Effect.mapError(mapRemoteEnvironmentError),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      );
      return {
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        httpBaseUrl: input.httpBaseUrl,
        socketUrl,
        httpAuthorization: {
          _tag: "Bearer" as const,
          token: input.bearerToken,
        },
        // Only a descriptor fetched by this call: a cached one may predate a
        // restart onto another protocol, which the caller must see.
        ...(fresh ? { descriptor } : {}),
      };
    },
  );

  const createDpopSocketUrl = Effect.fn("clientRuntime.connection.remote.createDpopSocketUrl")(
    function* (
      token: TokenStore.RemoteDpopAccessToken,
      timeoutMs?: number,
      endpoint: { readonly httpBaseUrl: string; readonly wsBaseUrl: string } = token.endpoint,
    ) {
      const ticketProof = yield* signer
        .createProof({
          method: "POST",
          url: environmentEndpointUrl(endpoint.httpBaseUrl, "/api/auth/websocket-ticket"),
          accessToken: token.accessToken,
        })
        .pipe(
          Effect.mapError(
            () =>
              new ConnectionBlockedError({
                reason: "configuration",
                detail: "Could not create the websocket authorization proof.",
              }),
          ),
        );
      return yield* resolveRemoteDpopWebSocketConnectionUrl({
        wsBaseUrl: endpoint.wsBaseUrl,
        httpBaseUrl: endpoint.httpBaseUrl,
        accessToken: token.accessToken,
        dpopProof: ticketProof,
        clientMetadata: presentation.metadata,
        connectionMethod: "relay",
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
    },
  );

  const isWaitingForApproval = (failure: { readonly _tag: string }) =>
    Schema.is(EnvironmentAuthInvalidError)(failure) && failure.refusal === "device_not_approved";

  const sessionChanged = () =>
    new ConnectionBlockedError({
      reason: "authentication",
      detail: "Your cloud sign-in changed. Sign in again to authorize the environment.",
    });

  const assertSession = Effect.fnUntraced(function* (
    identity: ClientCapabilities.CloudSessionIdentity,
  ) {
    const current = yield* cloudSession.identity;
    if (Option.isNone(current) || current.value !== identity) {
      return yield* sessionChanged();
    }
  });

  // Called under tokenLock so a late rejection cannot remove a newer credential.
  const removeRejectedToken = Effect.fnUntraced(function* (
    environmentId: EnvironmentId,
    accessToken: string,
  ) {
    const cached = yield* tokenStore.get(environmentId);
    if (Option.isSome(cached) && cached.value.accessToken === accessToken) {
      yield* tokenStore.remove(environmentId);
      tokenOwners.delete(environmentId);
    }
  });

  /** Call with the token lock held. */
  const recordFailedRenewal = Effect.fnUntraced(function* (
    environmentId: EnvironmentId,
    identity: ClientCapabilities.CloudSessionIdentity,
    thumbprint: string,
    error: ConnectionAttemptError,
  ) {
    const failedAt = yield* Clock.currentTimeMillis;
    const previous = failedRenewals.get(environmentId);
    const failures =
      previous?.identity === identity && previous.thumbprint === thumbprint
        ? previous.failures + 1
        : 1;
    const waitMs = Math.max(
      dpopRenewalBackoffMs(failures, yield* Random.next),
      // A machine that rate limits this client says when to come back.
      error._tag === "ConnectionTransientError" ? (error.retryAfterMs ?? 0) : 0,
    );
    failedRenewals.set(environmentId, {
      identity,
      thumbprint,
      failures,
      retryAtEpochMs: failedAt + waitMs,
      error,
    });
  });

  /** A token issued by a renewal was rejected. Call with the token lock held. */
  const recordRejectedRenewal = Effect.fnUntraced(function* (
    environmentId: EnvironmentId,
    accessToken: string,
  ) {
    const renewal = failedRenewals.get(environmentId);
    if (renewal?.renewedAccessToken !== accessToken) return;
    yield* recordFailedRenewal(
      environmentId,
      renewal.identity,
      renewal.thumbprint,
      new ConnectionBlockedError({
        reason: "authentication",
        detail: "The environment rejected its renewed credential.",
      }),
    );
  });

  /** A token issued by a renewal was accepted. Call with the token lock held. */
  const recordAcceptedRenewal = (environmentId: EnvironmentId, accessToken: string) => {
    if (failedRenewals.get(environmentId)?.renewedAccessToken === accessToken) {
      failedRenewals.delete(environmentId);
    }
  };

  const obtainBootstrap = Effect.fn("relay.connection.bootstrap.obtain")(function* (
    environmentId: EnvironmentId,
    identity: ClientCapabilities.CloudSessionIdentity,
  ) {
    yield* assertSession(identity);
    const clerkToken = yield* cloudSession.clerkToken.pipe(
      Effect.withSpan("relay.connection.cloudSessionToken.resolve"),
    );
    const deviceId = yield* deviceIdentity.deviceId.pipe(
      Effect.withSpan("relay.connection.deviceIdentity.resolve"),
    );
    yield* assertSession(identity);
    const connected = yield* relay
      .connectEnvironment({
        clerkToken,
        scopes: [RelayEnvironmentConnectScope],
        environmentId,
        ...(Option.isSome(deviceId) ? { deviceId: deviceId.value } : {}),
      })
      .pipe(Effect.mapError(mapManagedRelayError));
    if (connected.environmentId !== environmentId) {
      return yield* environmentMismatchError({
        expected: environmentId,
        actual: connected.environmentId,
      });
    }
    yield* assertSession(identity);
    return connected;
  });

  const exchangeDpopToken = Effect.fn("clientRuntime.connection.remote.exchangeDpopToken")(
    function* (
      environmentId: EnvironmentId,
      thumbprint: string,
      identity: ClientCapabilities.CloudSessionIdentity,
      attempt: { minted: boolean },
    ) {
      const bootstrap = yield* obtainBootstrap(environmentId, identity);
      attempt.minted = true;
      const descriptor = yield* fetchDescriptor(bootstrap.endpoint.httpBaseUrl, "relay").pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.withSpan("environment.authorization.descriptor"),
      );
      if (descriptor.environmentId !== environmentId) {
        return yield* environmentMismatchError({
          expected: environmentId,
          actual: descriptor.environmentId,
        });
      }
      const bootstrapProof = yield* signer
        .createProof({
          method: "POST",
          url: environmentEndpointUrl(bootstrap.endpoint.httpBaseUrl, "/oauth/token"),
        })
        .pipe(
          Effect.mapError(
            () =>
              new ConnectionBlockedError({
                reason: "configuration",
                detail: "Could not create the environment authorization proof.",
              }),
          ),
        );
      yield* assertSession(identity);
      const access = yield* exchangeRemoteDpopAccessToken({
        httpBaseUrl: bootstrap.endpoint.httpBaseUrl,
        credential: bootstrap.credential,
        dpopProof: bootstrapProof,
        clientMetadata: presentation.metadata,
      }).pipe(
        Effect.mapError(mapRemoteDpopEnvironmentError),
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.withSpan("environment.authorization.accessToken.exchange"),
      );
      const issuedAt = yield* Clock.currentTimeMillis;
      return new TokenStore.RemoteDpopAccessToken({
        environmentId: descriptor.environmentId,
        accountId: identity.accountId,
        label: descriptor.label,
        endpoint: bootstrap.endpoint,
        accessToken: access.access_token,
        expiresAtEpochMs: issuedAt + access.expires_in * 1_000,
        dpopThumbprint: thumbprint,
      });
    },
  );

  const getDpopToken = Effect.fn("clientRuntime.connection.remote.getDpopToken")(function* (
    input: Parameters<RemoteEnvironmentAuthorization["Service"]["authorizeDpopHttp"]>[0] & {
      /**
       * Fail at once while an earlier renewal's backoff lasts. Only HTTP polls
       * do this; the connection supervisor runs its own retry ladder and
       * recovery for sockets.
       */
      readonly respectRenewalBackoff?: boolean;
    },
  ) {
    const session = yield* cloudSession.identity;
    if (Option.isNone(session)) {
      return yield* sessionChanged();
    }
    const identity = session.value;
    const thumbprint = yield* signer.thumbprint.pipe(
      Effect.mapError(
        () =>
          new ConnectionBlockedError({
            reason: "configuration",
            detail: "Could not load the environment authorization key.",
          }),
      ),
      Effect.withSpan("environment.authorization.dpopKey.resolve"),
    );
    const selected = yield* tokenLock.withPermits(1)(
      Effect.gen(function* () {
        yield* assertSession(identity);
        const now = yield* Clock.currentTimeMillis;
        const cached = yield* tokenStore
          .get(input.expectedEnvironmentId)
          .pipe(Effect.withSpan("environment.authorization.accessToken.cache"));
        const owner = tokenOwners.get(input.expectedEnvironmentId);
        if (
          Option.isSome(cached) &&
          cached.value.environmentId === input.expectedEnvironmentId &&
          cached.value.accountId === identity.accountId &&
          cached.value.dpopThumbprint === thumbprint &&
          cached.value.expiresAtEpochMs > now + DPOP_ACCESS_TOKEN_REFRESH_SKEW_MS &&
          cached.value.accessToken !== input.rejectedAccessToken &&
          (owner?.accessToken !== cached.value.accessToken || owner.identity === identity)
        ) {
          tokenOwners.set(input.expectedEnvironmentId, {
            accessToken: cached.value.accessToken,
            identity,
          });
          return { token: Effect.succeed(cached.value), fromCache: true };
        }
        if (input.rejectedAccessToken !== undefined) {
          yield* removeRejectedToken(input.expectedEnvironmentId, input.rejectedAccessToken);
          yield* recordRejectedRenewal(input.expectedEnvironmentId, input.rejectedAccessToken);
        }
        const pending = pendingTokens.get(input.expectedEnvironmentId);
        if (pending?.identity === identity && pending.thumbprint === thumbprint) {
          return { token: pending.token, fromCache: false };
        }
        // A renewed token that is being replaced without a rejection served its purpose.
        if (failedRenewals.get(input.expectedEnvironmentId)?.renewedAccessToken !== undefined) {
          failedRenewals.delete(input.expectedEnvironmentId);
        }
        const failed = failedRenewals.get(input.expectedEnvironmentId);
        if (
          input.respectRenewalBackoff === true &&
          failed?.error !== undefined &&
          failed.identity === identity &&
          failed.thumbprint === thumbprint &&
          failed.retryAtEpochMs > now
        ) {
          yield* Effect.annotateCurrentSpan({
            "connection.remote_token_renewal": "backoff",
            "connection.remote_token_renewal_failures": failed.failures,
          });
          return {
            token: Effect.fail(withRenewalRetryAfter(failed.error, failed.retryAtEpochMs - now)),
            fromCache: false,
          };
        }

        const id = {};
        const attempt = { minted: false };
        const fiber = yield* exchangeDpopToken(
          input.expectedEnvironmentId,
          thumbprint,
          identity,
          attempt,
        ).pipe(
          Effect.flatMap((token) =>
            tokenLock.withPermits(1)(
              Effect.gen(function* () {
                yield* assertSession(identity);
                yield* tokenStore
                  .put(token)
                  .pipe(Effect.withSpan("environment.authorization.accessToken.persist"));
                const current = yield* cloudSession.identity;
                if (Option.isNone(current) || current.value !== identity) {
                  yield* removeRejectedToken(input.expectedEnvironmentId, token.accessToken);
                  return yield* sessionChanged();
                }
                tokenOwners.set(input.expectedEnvironmentId, {
                  accessToken: token.accessToken,
                  identity,
                });
                const previous = failedRenewals.get(input.expectedEnvironmentId);
                failedRenewals.set(input.expectedEnvironmentId, {
                  identity,
                  thumbprint,
                  // The count resets only once the machine accepts the token.
                  failures:
                    previous?.identity === identity && previous.thumbprint === thumbprint
                      ? previous.failures
                      : 0,
                  retryAtEpochMs: 0,
                  renewedAccessToken: token.accessToken,
                });
                if (pendingTokens.get(input.expectedEnvironmentId)?.id === id) {
                  pendingTokens.delete(input.expectedEnvironmentId);
                }
                return token;
              }),
            ),
          ),
          Effect.timeoutOrElse({
            duration: DPOP_AUTHORIZATION_TIMEOUT_MS,
            orElse: () =>
              Effect.fail(
                new ConnectionTransientError({
                  reason: "timeout",
                  detail: "Timed out renewing the environment credential.",
                }),
              ),
          }),
          // Only a renewal that minted a credential costs the machine anything.
          // A network or relay failure before that retries on the caller's terms.
          Effect.tapError((error) =>
            attempt.minted
              ? tokenLock.withPermits(1)(
                  recordFailedRenewal(input.expectedEnvironmentId, identity, thumbprint, error),
                )
              : Effect.void,
          ),
          Effect.ensuring(
            tokenLock.withPermits(1)(
              Effect.sync(() => {
                if (pendingTokens.get(input.expectedEnvironmentId)?.id === id) {
                  pendingTokens.delete(input.expectedEnvironmentId);
                }
              }),
            ),
          ),
          // One caller's timeout must not cancel renewal for other HTTP requests.
          Effect.forkIn(serviceScope),
        );
        const token = Fiber.join(fiber);
        pendingTokens.set(input.expectedEnvironmentId, { id, identity, thumbprint, token });
        return { token, fromCache: false };
      }),
    );
    yield* Effect.annotateCurrentSpan({
      "connection.remote_token_cache": selected.fromCache ? "hit" : "miss",
    });
    const token = yield* selected.token;
    yield* assertSession(identity);
    return { token, fromCache: selected.fromCache, identity };
  });

  const httpAuthorization = (
    token: TokenStore.RemoteDpopAccessToken,
    httpBaseUrl = token.endpoint.httpBaseUrl,
  ): AuthorizedRemoteHttpEnvironment => ({
    environmentId: token.environmentId,
    label: token.label,
    httpBaseUrl,
    httpAuthorization: {
      _tag: "Dpop",
      accessToken: token.accessToken,
      expiresAtEpochMs: token.expiresAtEpochMs,
    },
  });

  const authorizeDpop = Effect.fn("clientRuntime.connection.remote.authorizeDpop")(function* (
    input: Parameters<RemoteEnvironmentAuthorization["Service"]["authorizeDpop"]>[0],
  ) {
    const endpoint = input.directEndpoint;
    if (endpoint !== undefined) {
      yield* verifyDirectEndpoint({
        expectedEnvironmentId: input.expectedEnvironmentId,
        httpBaseUrl: endpoint.httpBaseUrl,
        connectionMethod: "direct",
      });
    }
    const acceptSocketToken = (token: TokenStore.RemoteDpopAccessToken) =>
      tokenLock.withPermits(1)(
        Effect.sync(() => recordAcceptedRenewal(input.expectedEnvironmentId, token.accessToken)),
      );
    const authorized = (token: TokenStore.RemoteDpopAccessToken, socketUrl: string) => ({
      ...httpAuthorization(token, endpoint?.httpBaseUrl),
      socketUrl,
    });
    let selected = yield* getDpopToken(input);
    if (selected.fromCache) {
      const cachedSocket = yield* createDpopSocketUrl(
        selected.token,
        CACHED_ENDPOINT_SOCKET_TIMEOUT_MS,
        endpoint,
      ).pipe(Effect.result);
      if (Result.isSuccess(cachedSocket)) {
        yield* assertSession(selected.identity);
        yield* acceptSocketToken(selected.token);
        return authorized(selected.token, cachedSocket.success);
      }
      // Waiting for the owner's approval: the token is good, keep it (1327).
      if (
        cachedSocket.failure._tag === "ConnectionBlockedError" ||
        isWaitingForApproval(cachedSocket.failure)
      ) {
        return yield* mapDpopSocketError(cachedSocket.failure);
      }
      // An unreachable direct address says nothing about the token, so keep
      // it for the Studio Connect route rather than forcing a relay round trip.
      // A rejected token falls through and is replaced like on the tunnel.
      if (endpoint !== undefined && cachedSocket.failure._tag !== "EnvironmentAuthInvalidError") {
        return yield* mapDpopSocketError(cachedSocket.failure);
      }
      selected = yield* getDpopToken({
        ...input,
        rejectedAccessToken: selected.token.accessToken,
      });
    }
    const socket = yield* createDpopSocketUrl(selected.token, undefined, endpoint).pipe(
      Effect.result,
    );
    if (Result.isFailure(socket)) {
      // A direct address that refuses the socket says nothing about the token,
      // and neither does a machine waiting for its owner to approve this device.
      if (
        (endpoint === undefined || socket.failure._tag === "ConnectionBlockedError") &&
        !isWaitingForApproval(socket.failure)
      ) {
        const failure = socket.failure;
        yield* tokenLock.withPermits(1)(
          Effect.gen(function* () {
            yield* removeRejectedToken(input.expectedEnvironmentId, selected.token.accessToken);
            if (
              failure._tag === "EnvironmentAuthInvalidError" ||
              (failure._tag === "ConnectionBlockedError" && failure.reason === "authentication")
            ) {
              yield* recordRejectedRenewal(input.expectedEnvironmentId, selected.token.accessToken);
            }
          }),
        );
      }
      return yield* mapDpopSocketError(socket.failure);
    }
    yield* assertSession(selected.identity);
    yield* acceptSocketToken(selected.token);
    return authorized(selected.token, socket.success);
  });

  return RemoteEnvironmentAuthorization.of({
    authorizeBearer,
    authorizeDpop: (input) =>
      authorizeDpop(input).pipe(Effect.withSpan("environment.authorization")),
    authorizeDpopHttp: (input) =>
      getDpopToken({ ...input, respectRenewalBackoff: true }).pipe(
        Effect.map(({ token }) => httpAuthorization(token)),
        Effect.withSpan("environment.authorization.http"),
        withRelayClientTracing,
      ),
  });
});

export const layer = Layer.effect(RemoteEnvironmentAuthorization, make);
