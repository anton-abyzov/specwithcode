/**
 * Client for the relay's owner-only admin routes (`/v1/admin/...`). The relay
 * answers them only for a signed-in owner; everyone else gets the same empty
 * 404 as a path it does not have, which this client reads as "not an owner".
 */
import { RelayApi } from "@specweave-studio/contracts/relay";
import type {
  RelayAdminAccountResponse,
  RelayAdminAccountsResponse,
  RelayAdminActionsResponse,
  RelayAdminMachineLimitSetting,
  RelayAdminOverviewResponse,
  RelayAdminRemovePhoneResponse,
  RelayAdminSetMachineLimitResponse,
  RelayAdminUnlinkMachineResponse,
  RelayAdminUsageResponse,
} from "@specweave-studio/contracts/relayAdmin";
import { normalizeSecureRelayUrl } from "@specweave-studio/shared/relayUrl";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

/** How long one admin call may take; the relay reads Clerk and Cloudflare for some. */
const RELAY_ADMIN_REQUEST_TIMEOUT_MS = 20_000;

/**
 * Why an admin call failed:
 * - "not_owner": the relay answered 404, so this account is not (or no longer) an owner.
 * - "account_not_found": no Connect account has that id.
 * - "target_not_found": the machine is not linked to that account, or the phone is not its.
 * - "unavailable": the relay could not read its database or Clerk (HTTP 503).
 * - "not_recorded": the relay could not record the action, so it did not run.
 * - "action_failed": the action was recorded and stopped part way; it can be sent again.
 * - "timeout": no answer in time.
 * - "network": the request never reached the relay.
 * - "failed": anything else, with the HTTP status when there was one.
 */
export type RelayAdminFailureKind =
  | "not_owner"
  | "account_not_found"
  | "target_not_found"
  | "unavailable"
  | "not_recorded"
  | "action_failed"
  | "timeout"
  | "network"
  | "failed";

/**
 * Carries no cause on purpose: the HTTP client's error names the request URL,
 * an account read has another person's id in it, and a failed span exports its
 * error with every cause.
 */
export class RelayAdminRequestError extends Data.TaggedError("RelayAdminRequestError")<{
  readonly kind: RelayAdminFailureKind;
  readonly status: number | null;
  readonly traceId: string | null;
}> {
  override get message(): string {
    return this.status === null
      ? `Connect admin request failed: ${this.kind}`
      : `Connect admin request failed: ${this.kind} (HTTP ${this.status})`;
  }
}

export interface RelayAdminClientShape {
  readonly relayUrl: string;
  /** True only when the relay answered 200 to `/v1/admin/me`. */
  readonly isOwner: (input: {
    readonly clerkToken: string;
  }) => Effect.Effect<boolean, RelayAdminRequestError>;
  readonly overview: (input: {
    readonly clerkToken: string;
  }) => Effect.Effect<RelayAdminOverviewResponse, RelayAdminRequestError>;
  /** Sign-ups and activity over time, as counts; no person is named. */
  readonly usage: (input: {
    readonly clerkToken: string;
  }) => Effect.Effect<RelayAdminUsageResponse, RelayAdminRequestError>;
  readonly listAccounts: (input: {
    readonly clerkToken: string;
    readonly cursor?: string;
  }) => Effect.Effect<RelayAdminAccountsResponse, RelayAdminRequestError>;
  /** The search text travels in the request body, never in the URL. */
  readonly searchAccounts: (input: {
    readonly clerkToken: string;
    readonly query: string;
  }) => Effect.Effect<RelayAdminAccountsResponse, RelayAdminRequestError>;
  readonly account: (input: {
    readonly clerkToken: string;
    readonly userId: string;
  }) => Effect.Effect<RelayAdminAccountResponse, RelayAdminRequestError>;
  /** The newest recorded owner actions. */
  readonly listActions: (input: {
    readonly clerkToken: string;
  }) => Effect.Effect<RelayAdminActionsResponse, RelayAdminRequestError>;
  /** Applies to the account's next link; machines already linked stay linked. */
  readonly setMachineLimit: (input: {
    readonly clerkToken: string;
    readonly userId: string;
    readonly limit: RelayAdminMachineLimitSetting;
  }) => Effect.Effect<RelayAdminSetMachineLimitResponse, RelayAdminRequestError>;
  readonly unlinkMachine: (input: {
    readonly clerkToken: string;
    readonly userId: string;
    readonly environmentId: string;
  }) => Effect.Effect<RelayAdminUnlinkMachineResponse, RelayAdminRequestError>;
  readonly removePhone: (input: {
    readonly clerkToken: string;
    readonly userId: string;
    readonly deviceId: string;
  }) => Effect.Effect<RelayAdminRemovePhoneResponse, RelayAdminRequestError>;
}

export class RelayAdminClient extends Context.Service<RelayAdminClient, RelayAdminClientShape>()(
  "@specweave-studio/client-runtime/relay/relayAdmin/RelayAdminClient",
) {}

/** The Clerk session token of the call in flight; the admin routes take no other credential. */
class RelayAdminBearer extends Context.Reference(
  "@specweave-studio/client-runtime/relay/relayAdmin/RelayAdminBearer",
  { defaultValue: () => "" },
) {}

const traceIdOf = (cause: unknown): string | null => {
  if (typeof cause !== "object" || cause === null) return null;
  const declared = (cause as { readonly traceId?: unknown }).traceId;
  if (typeof declared === "string" && declared.length > 0) return declared;
  const response = HttpClientError.isHttpClientError(cause) ? cause.response : undefined;
  return response?.headers.traceparent?.split("-")[1] ?? null;
};

const tagOf = (cause: unknown): string | null =>
  typeof cause === "object" && cause !== null && "_tag" in cause && typeof cause._tag === "string"
    ? cause._tag
    : null;

/**
 * Turns whatever the HTTP client failed with into one admin error. A 404 that
 * is not the relay's "account not found" answer is the empty 404 the relay
 * gives a non-owner on every admin route.
 */
function relayAdminRequestError(cause: unknown): RelayAdminRequestError {
  if (cause instanceof RelayAdminRequestError) return cause;
  const traceId = traceIdOf(cause);
  const tag = tagOf(cause);
  if (tag === "RelayAdminUnavailableError") {
    const reason = (cause as { readonly reason?: unknown }).reason;
    return new RelayAdminRequestError({
      kind:
        reason === "record_failed"
          ? "not_recorded"
          : reason === "action_failed"
            ? "action_failed"
            : "unavailable",
      status: 503,
      traceId,
    });
  }
  if (tag === "RelayAdminTargetNotFoundError") {
    return new RelayAdminRequestError({ kind: "target_not_found", status: 404, traceId });
  }
  if (tag === "RelayAdminAccountNotFoundError") {
    return new RelayAdminRequestError({ kind: "account_not_found", status: 404, traceId });
  }
  if (HttpClientError.isHttpClientError(cause)) {
    if (cause.reason._tag === "TransportError") {
      return new RelayAdminRequestError({ kind: "network", status: null, traceId });
    }
    const status = cause.response?.status ?? null;
    return new RelayAdminRequestError({
      kind: status === 404 ? "not_owner" : status === 503 ? "unavailable" : "failed",
      status,
      traceId,
    });
  }
  return new RelayAdminRequestError({ kind: "failed", status: null, traceId });
}

const withinTime = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | RelayAdminRequestError, R> =>
  effect.pipe(
    Effect.timeoutOption(Duration.millis(RELAY_ADMIN_REQUEST_TIMEOUT_MS)),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.currentParentSpan.pipe(
            Effect.map((span): string | null => span.traceId),
            Effect.orElseSucceed(() => null),
            Effect.flatMap((traceId) =>
              Effect.fail(new RelayAdminRequestError({ kind: "timeout", status: null, traceId })),
            ),
          ),
        onSome: Effect.succeed,
      }),
    ),
  );

const notSetUp = Effect.fail(
  new RelayAdminRequestError({ kind: "failed", status: null, traceId: null }),
);

function disabledRelayAdminClient(relayUrl: string): RelayAdminClientShape {
  return {
    relayUrl,
    isOwner: () => Effect.succeed(false),
    overview: () => notSetUp,
    usage: () => notSetUp,
    listAccounts: () => notSetUp,
    searchAccounts: () => notSetUp,
    account: () => notSetUp,
    listActions: () => notSetUp,
    setMachineLimit: () => notSetUp,
    unlinkMachine: () => notSetUp,
    removePhone: () => notSetUp,
  };
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.fn("RelayAdminClient.make")(function* (options: {
  readonly relayUrl: string;
}) {
  const relayUrl = normalizeSecureRelayUrl(options.relayUrl);
  if (relayUrl === null) {
    return RelayAdminClient.of(disabledRelayAdminClient(options.relayUrl));
  }
  const { admin, adminActions } = yield* HttpApiClient.make(RelayApi, {
    baseUrl: relayUrl,
    transformClient: HttpClient.mapRequestEffect((request) =>
      RelayAdminBearer.pipe(Effect.map((token) => HttpClientRequest.bearerToken(request, token))),
    ),
  });

  const call = <A, E>(name: string, clerkToken: string, request: Effect.Effect<A, E>) =>
    request.pipe(
      Effect.provideService(RelayAdminBearer, clerkToken),
      // No HTTP client span and no relay tracing for these calls: the span would
      // record the URL, and an account's routes have another person's id in the path.
      Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
      Effect.mapError(relayAdminRequestError),
      withinTime,
      Effect.withSpan(`clientRuntime.relayAdmin.${name}`),
    );

  return RelayAdminClient.of({
    relayUrl,
    isOwner: (input) =>
      call("isOwner", input.clerkToken, admin.me()).pipe(
        Effect.as(true),
        Effect.catchIf(
          (error) => error.kind === "not_owner",
          () => Effect.succeed(false),
        ),
      ),
    overview: (input) => call("overview", input.clerkToken, admin.overview()),
    usage: (input) => call("usage", input.clerkToken, admin.usage()),
    listAccounts: (input) =>
      call(
        "listAccounts",
        input.clerkToken,
        admin.listAccounts({
          query: input.cursor === undefined ? {} : { cursor: input.cursor },
        }),
      ),
    searchAccounts: (input) =>
      call(
        "searchAccounts",
        input.clerkToken,
        admin.searchAccounts({ payload: { query: input.query } }),
      ),
    account: (input) =>
      call("account", input.clerkToken, admin.account({ params: { userId: input.userId } })),
    listActions: (input) => call("listActions", input.clerkToken, adminActions.listActions()),
    setMachineLimit: (input) =>
      call(
        "setMachineLimit",
        input.clerkToken,
        adminActions.setMachineLimit({
          params: { userId: input.userId },
          payload: { limit: input.limit },
        }),
      ),
    unlinkMachine: (input) =>
      call(
        "unlinkMachine",
        input.clerkToken,
        adminActions.unlinkMachine({
          params: { userId: input.userId, environmentId: input.environmentId },
        }),
      ),
    removePhone: (input) =>
      call(
        "removePhone",
        input.clerkToken,
        adminActions.removePhone({
          params: { userId: input.userId, deviceId: input.deviceId },
        }),
      ),
  });
});

export const layer = (options: { readonly relayUrl: string }) =>
  Layer.effect(RelayAdminClient, make(options));
