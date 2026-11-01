import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  EnvironmentRateLimitedError,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
} from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";
import * as Result from "effect/Result";
import { withRelayClientTracing } from "@specweave-studio/shared/relayTracing";
import { FetchHttpClient, type HttpMethod } from "effect/http";

import type { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import {
  ConnectionTransientError,
  type PreparedConnection,
  type PreparedHttpAuthorization,
} from "../connection/model.ts";
import type { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import {
  executeEnvironmentHttpRequest,
  makeEnvironmentHttpApiGroupClient,
  RemoteEnvironmentAuthFetchError,
  RemoteEnvironmentAuthTimeoutError,
  type RemoteEnvironmentRequestError,
} from "../rpc/http.ts";

export interface EnvironmentHttpAuthHeaders {
  readonly authorization?: string;
  readonly dpop?: string;
}

export function withOrchestrationProtocolHeader(
  headers: EnvironmentHttpAuthHeaders,
): EnvironmentHttpAuthHeaders & {
  readonly [ORCHESTRATION_PROTOCOL_HEADER]: typeof ORCHESTRATION_PROTOCOL_VERSION_TEXT;
} {
  return {
    ...headers,
    [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  };
}

/**
 * Primary/local environments with no bearer or DPoP credential authenticate the
 * browser via a session cookie. A cross-origin `fetch` does not send cookies by
 * default, so those requests must opt into credentialed mode; bearer/DPoP
 * connections carry their credential in a header and need no cookies. Applied
 * per-request via `FetchHttpClient.RequestInit`, which the fetch client reads
 * from the fiber context at request time.
 */
const withEnvironmentCredentials = <A, E, R>(
  authorization: PreparedHttpAuthorization | null,
  request: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  authorization === null
    ? request.pipe(Effect.provideService(FetchHttpClient.RequestInit, { credentials: "include" }))
    : request;

/**
 * Build request-bound headers from the current environment credential:
 * - primary/local connections carry no credential,
 * - bearer connections send a static `Bearer` token,
 * - relay connections send a `DPoP` access token with a freshly signed proof
 *   bound to this request's method and URL.
 *
 * The DPoP signer is passed in (not resolved from context) and is only required
 * for relay/DPoP connections, so bearer/primary connections work even when no
 * signer is available.
 */
const buildEnvironmentAuthHeaders = (
  authorization: PreparedHttpAuthorization | null,
  method: HttpMethod.HttpMethod,
  url: string,
  signer: Option.Option<ManagedRelayDpopSigner["Service"]>,
): Effect.Effect<EnvironmentHttpAuthHeaders, RemoteEnvironmentAuthFetchError> =>
  Effect.gen(function* () {
    if (authorization === null) {
      return {};
    }
    if (authorization._tag === "Bearer") {
      return { authorization: `Bearer ${authorization.token}` };
    }
    if (Option.isNone(signer)) {
      return yield* new RemoteEnvironmentAuthFetchError({
        message: "No DPoP signer is available to authorize the environment request.",
        cause: authorization._tag,
      });
    }
    const proof = yield* signer.value
      .createProof({ method, url, accessToken: authorization.accessToken })
      .pipe(
        Effect.mapError(
          (cause) =>
            new RemoteEnvironmentAuthFetchError({
              message: "Could not create the environment request authorization proof.",
              cause,
            }),
        ),
      );
    return { authorization: `DPoP ${authorization.accessToken}`, dpop: proof };
  });

/**
 * Resolve relay credentials at request time without replacing the live socket.
 * A rejected credential gets one refresh and retry, with a new request-bound
 * proof. Cookie and bearer requests keep their existing authentication behavior.
 *
 * A DPoP request is Studio Connect work, so its span starts an exported trace that
 * the environment continues; its local caller's span would leave that trace
 * without a root.
 */
export const executeAuthenticatedEnvironmentHttpRequest = <
  Group extends Parameters<typeof makeEnvironmentHttpApiGroupClient>[1],
  A,
  E,
  R,
>(
  input: Parameters<typeof executeEnvironmentRequest<Group, A, E, R>>[0],
) =>
  input.prepared.httpAuthorization?._tag === "Dpop"
    ? executeEnvironmentRequest(input).pipe(
        Effect.withSpan(ENVIRONMENT_REQUEST_SPAN, { root: true }),
        withRelayClientTracing,
      )
    : executeEnvironmentRequest(input).pipe(Effect.withSpan(ENVIRONMENT_REQUEST_SPAN));

const ENVIRONMENT_REQUEST_SPAN = "clientRuntime.state.executeAuthenticatedEnvironmentHttpRequest";

/** How long an environment that refuses a freshly renewed credential is left alone. */
export const UNFIXABLE_CREDENTIAL_BACKOFF_MS = 5 * 60_000;

/**
 * Environments that refused this client in a way a new credential cannot fix
 * (a renewed token still rejected) or that rate limited it, with the error to repeat until the time given. Without this, a
 * poll that gets 401 renews through the relay, mints and exchanges a token,
 * fails again, and repeats on every tick; each failure also counts against
 * every device behind the same address on that machine.
 */
const environmentCooldowns = new Map<
  string,
  { readonly until: number; readonly error: RemoteEnvironmentRequestError }
>();

/** Forgets every cooldown, for tests. */
export function clearEnvironmentRequestCooldowns(): void {
  environmentCooldowns.clear();
}

/**
 * Forgets one environment's cooldown. The connection supervisor calls this
 * when it connects with a fresh credential, so a re-pair, reapproval or a
 * newly granted access is not held back for the rest of the five minutes.
 */
export function clearEnvironmentRequestCooldown(environmentId: string): void {
  environmentCooldowns.delete(environmentId);
}

const isEnvironmentRateLimitedError = Schema.is(EnvironmentRateLimitedError);
const isConnectionTransientError = Schema.is(ConnectionTransientError);

/**
 * The rate limit behind a failed request or authorization, if that is what it
 * was. Authorization reports a token exchange refused with 429 as a
 * `rate-limited` connection error carrying the wait.
 */
function rateLimitOf(error: unknown): EnvironmentRateLimitedError | undefined {
  for (let current = error, depth = 0; current !== undefined && depth < 6; depth++) {
    if (isEnvironmentRateLimitedError(current)) return current;
    if (
      isConnectionTransientError(current) &&
      current.reason === "rate-limited" &&
      current.retryAfterMs !== undefined
    ) {
      return new EnvironmentRateLimitedError({
        code: "rate_limited",
        retryAfterSeconds: Math.max(1, Math.ceil(current.retryAfterMs / 1000)),
      });
    }
    current =
      typeof current === "object" && current !== null && "cause" in current
        ? (current as { readonly cause?: unknown }).cause
        : undefined;
  }
  return undefined;
}

const coolDown = (environmentId: string, error: RemoteEnvironmentRequestError, ms: number) =>
  Clock.currentTimeMillis.pipe(
    Effect.map((now) => {
      environmentCooldowns.set(environmentId, { until: now + ms, error });
    }),
  );

const executeEnvironmentRequest = Effect.fnUntraced(function* <
  Group extends Parameters<typeof makeEnvironmentHttpApiGroupClient>[1],
  A,
  E,
  R,
>(input: {
  readonly prepared: PreparedConnection;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly remoteAuthorization?: Option.Option<RemoteEnvironmentAuthorization["Service"]>;
  readonly method: HttpMethod.HttpMethod;
  readonly url: (httpBaseUrl: string) => string;
  readonly timeoutMs: number;
  readonly group: Group;
  readonly request: (input: {
    readonly client: Effect.Success<ReturnType<typeof makeEnvironmentHttpApiGroupClient<Group>>>;
    readonly headers: EnvironmentHttpAuthHeaders;
  }) => Effect.Effect<A, E, R>;
  /** Some endpoints report rejected credentials in a successful response. */
  readonly isUnauthorizedResponse?: (response: NoInfer<A>) => boolean;
}): Effect.fn.Return<
  A,
  RemoteEnvironmentRequestError,
  Effect.Services<ReturnType<typeof makeEnvironmentHttpApiGroupClient<Group>>> | R
> {
  let httpBaseUrl = input.prepared.httpBaseUrl;
  return yield* Effect.gen(function* () {
    let rejectedAccessToken: string | undefined;
    const environmentId = input.prepared.environmentId;
    for (;;) {
      let authorization = input.prepared.httpAuthorization;
      if (authorization?._tag === "Dpop") {
        const cooldown = environmentCooldowns.get(environmentId);
        if (cooldown !== undefined) {
          if (cooldown.until > (yield* Clock.currentTimeMillis))
            return yield* Effect.fail(cooldown.error);
          environmentCooldowns.delete(environmentId);
        }
        const remote = input.remoteAuthorization;
        if (remote === undefined || Option.isNone(remote)) {
          return yield* new RemoteEnvironmentAuthFetchError({
            message: "No relay authorization service is available for the environment request.",
            cause: input.prepared.target._tag,
          });
        }
        const current = yield* remote.value
          .authorizeDpopHttp({
            expectedEnvironmentId: input.prepared.environmentId,
            ...(rejectedAccessToken === undefined ? {} : { rejectedAccessToken }),
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                rateLimitOf(cause) ??
                new RemoteEnvironmentAuthFetchError({
                  message: "Could not authorize the environment request.",
                  cause,
                }),
            ),
            Effect.tapError((error) =>
              isEnvironmentRateLimitedError(error)
                ? coolDown(environmentId, error, Math.max(1, error.retryAfterSeconds) * 1000)
                : Effect.void,
            ),
          );
        // A learned direct route keeps its own origin; only the token renews.
        if (input.prepared.target._tag === "RelayConnectionTarget") {
          httpBaseUrl = current.httpBaseUrl;
        }
        authorization = current.httpAuthorization;
      }

      const requestUrl = input.url(httpBaseUrl);
      const client = yield* makeEnvironmentHttpApiGroupClient(httpBaseUrl, input.group);
      const headers = yield* buildEnvironmentAuthHeaders(
        authorization,
        input.method,
        requestUrl,
        input.signer,
      );
      const result = yield* executeEnvironmentHttpRequest(
        requestUrl,
        input.timeoutMs,
        withEnvironmentCredentials(authorization, input.request({ client, headers })),
      ).pipe(Effect.result);

      if (Result.isFailure(result)) {
        if (
          authorization?._tag === "Dpop" &&
          rejectedAccessToken === undefined &&
          result.failure._tag === "EnvironmentAuthInvalidError" &&
          result.failure.reason === "invalid_credential"
        ) {
          rejectedAccessToken = authorization.accessToken;
          continue;
        }
        if (authorization?._tag === "Dpop") {
          const failure = result.failure;
          if (isEnvironmentRateLimitedError(failure)) {
            yield* coolDown(environmentId, failure, Math.max(1, failure.retryAfterSeconds) * 1000);
          } else if (
            // A missing scope is per endpoint and never renews, so it needs no cooldown.
            failure._tag === "EnvironmentAuthInvalidError" &&
            rejectedAccessToken !== undefined
          ) {
            yield* coolDown(environmentId, failure, UNFIXABLE_CREDENTIAL_BACKOFF_MS);
          }
        }
        return yield* result.failure;
      }

      if (
        authorization?._tag === "Dpop" &&
        input.isUnauthorizedResponse?.(result.success) === true
      ) {
        if (rejectedAccessToken === undefined) {
          rejectedAccessToken = authorization.accessToken;
          continue;
        }
        const rejected = new RemoteEnvironmentAuthFetchError({
          message: "The environment rejected the renewed session authorization.",
          cause: result.success,
        });
        yield* coolDown(environmentId, rejected, UNFIXABLE_CREDENTIAL_BACKOFF_MS);
        return yield* rejected;
      }
      return result.success;
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: input.timeoutMs,
      orElse: () =>
        Effect.fail(new RemoteEnvironmentAuthTimeoutError(input.url(httpBaseUrl), input.timeoutMs)),
    }),
  );
});
