/**
 * Owner-only admin routes of the SpecWithCode Connect relay: who uses Connect,
 * which machines and phones each account has, and what its machine limit is.
 * Read-only. Nothing here is a credential or lets the caller reach a machine.
 */
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware";
import * as HttpApiSecurity from "effect/http-api/HttpApiSecurity";
import * as OpenApi from "effect/http-api/OpenApi";

/** Accounts one page of the account list holds. */
export const RELAY_ADMIN_ACCOUNTS_PAGE_SIZE = 50;

/** The signed-in owner an admin request runs as. */
export class RelayAdminPrincipal extends Context.Service<
  RelayAdminPrincipal,
  { readonly userId: string }
>()("@specweave-studio/contracts/relayAdmin/RelayAdminPrincipal") {}

export class RelayAdminUnavailableError extends Schema.TaggedError<RelayAdminUnavailableError>()(
  "RelayAdminUnavailableError",
  {
    code: Schema.Literal("admin_unavailable"),
    reason: Schema.Literals(["persistence_failed", "identity_lookup_failed"]),
    traceId: Schema.String,
  },
  { httpApiStatus: 503 },
) {
  override get message(): string {
    return `Connect admin is unavailable: ${this.reason}`;
  }
}

export class RelayAdminAccountNotFoundError extends Schema.TaggedError<RelayAdminAccountNotFoundError>()(
  "RelayAdminAccountNotFoundError",
  { code: Schema.Literal("account_not_found") },
  { httpApiStatus: 404 },
) {
  override get message(): string {
    return "No Connect account has that id.";
  }
}

const RelayAdminBearerAuthorization = HttpApiSecurity.http({ scheme: "bearer" }).pipe(
  HttpApiSecurity.annotate(
    OpenApi.Description,
    "Clerk session token of a signed-in owner. Every other caller gets 404.",
  ),
);

/**
 * Lets a request through only for an interactive Clerk session of an owner
 * listed in the relay's `RELAY_ADMIN_USER_IDS`. Everything else, also a
 * missing or invalid token, is answered 404 with an empty body, the same as a
 * path the relay does not have.
 */
export class RelayAdminAuth extends HttpApiMiddleware.Service<
  RelayAdminAuth,
  { provides: RelayAdminPrincipal }
>()("RelayAdminAuth", {
  security: { adminBearer: RelayAdminBearerAuthorization },
}) {}

/** Where an account's machine limit comes from. */
export const RelayAdminMachineLimitSource = Schema.Literals(["override", "founder", "free"]);
export type RelayAdminMachineLimitSource = typeof RelayAdminMachineLimitSource.Type;

export const RelayAdminMachineLimit = Schema.Struct({
  /** Machines the account may link through Connect; null means no account limit. */
  maxMachines: Schema.NullOr(Schema.Number),
  source: RelayAdminMachineLimitSource,
});
export type RelayAdminMachineLimit = typeof RelayAdminMachineLimit.Type;

export const RelayAdminAccount = Schema.Struct({
  userId: Schema.String,
  /** From Clerk; null when Clerk has no such user or could not be asked. */
  email: Schema.NullOr(Schema.String),
  name: Schema.NullOr(Schema.String),
  founderNumber: Schema.NullOr(Schema.Number),
  limit: RelayAdminMachineLimit,
  /** Machines linked now; unlinked ones are not counted. */
  machineCount: Schema.Number,
  phoneCount: Schema.Number,
  firstSeenAt: Schema.String,
  lastSeenAt: Schema.String,
});
export type RelayAdminAccount = typeof RelayAdminAccount.Type;

export const RelayAdminMeResponse = Schema.Struct({ userId: Schema.String });
export type RelayAdminMeResponse = typeof RelayAdminMeResponse.Type;

export const RelayAdminOverviewResponse = Schema.Struct({
  accounts: Schema.Number,
  linkedMachines: Schema.Number,
  tunnelsAllocated: Schema.Number,
  tunnelsReady: Schema.Number,
  phones: Schema.Number,
  founderSeatsGranted: Schema.Number,
  founderSeatCap: Schema.Number,
  freeMachineLimit: Schema.Number,
  /** Null when the relay has no global cap. */
  globalTunnelCap: Schema.NullOr(Schema.Number),
});
export type RelayAdminOverviewResponse = typeof RelayAdminOverviewResponse.Type;

export const RelayAdminAccountsQuery = Schema.Struct({
  /** `nextCursor` of the page before. */
  cursor: Schema.optionalKey(Schema.String),
  /** A Clerk user id (`user_...`), or an email or name to look up in Clerk. */
  query: Schema.optionalKey(Schema.String),
});

export const RelayAdminAccountsResponse = Schema.Struct({
  accounts: Schema.Array(RelayAdminAccount),
  nextCursor: Schema.NullOr(Schema.String),
  /** "unavailable": Clerk did not answer, so this page has ids only. */
  identities: Schema.Literals(["read", "unavailable"]),
  /** True when more people matched `query` than one search reads: narrow it. */
  searchTruncated: Schema.Boolean,
});
export type RelayAdminAccountsResponse = typeof RelayAdminAccountsResponse.Type;

/**
 * What the relay recorded for a machine's managed tunnel:
 * - "ready": provisioned and handed to the machine.
 * - "provisioning": allocated, not finished.
 * - "released": the machine gave its tunnel back (it shut down or was unlinked).
 * - "none": the machine is linked without a managed tunnel.
 */
export const RelayAdminTunnelState = Schema.Literals(["ready", "provisioning", "released", "none"]);
export type RelayAdminTunnelState = typeof RelayAdminTunnelState.Type;

/** Cloudflare's live reading of the tunnel; "unknown" when it was not read in time. */
export const RelayAdminTunnelLive = Schema.Literals([
  "healthy",
  "degraded",
  "down",
  "inactive",
  "unknown",
]);
export type RelayAdminTunnelLive = typeof RelayAdminTunnelLive.Type;

export const RelayAdminMachine = Schema.Struct({
  environmentId: Schema.String,
  label: Schema.String,
  hostname: Schema.NullOr(Schema.String),
  linkedAt: Schema.String,
  updatedAt: Schema.String,
  unlinkedAt: Schema.NullOr(Schema.String),
  tunnel: RelayAdminTunnelState,
  live: RelayAdminTunnelLive,
  /** When the tunnel last lost its connection, when Cloudflare reported it. */
  liveChangedAt: Schema.NullOr(Schema.String),
});
export type RelayAdminMachine = typeof RelayAdminMachine.Type;

export const RelayAdminPhone = Schema.Struct({
  deviceId: Schema.String,
  label: Schema.String,
  platform: Schema.Literals(["ios", "android"]),
  model: Schema.NullOr(Schema.String),
  appVersion: Schema.NullOr(Schema.String),
  lastSeenAt: Schema.NullOr(Schema.String),
});
export type RelayAdminPhone = typeof RelayAdminPhone.Type;

export const RelayAdminAccountParams = Schema.Struct({ userId: Schema.String });

export const RelayAdminAccountResponse = Schema.Struct({
  account: RelayAdminAccount,
  machines: Schema.Array(RelayAdminMachine),
  phones: Schema.Array(RelayAdminPhone),
});
export type RelayAdminAccountResponse = typeof RelayAdminAccountResponse.Type;

export const RelayAdminGroup = HttpApiGroup.make("admin")
  .add(
    HttpApiEndpoint.get("me", "/v1/admin/me", {
      success: RelayAdminMeResponse,
    }).annotate(OpenApi.Summary, "Whether the caller is a Connect owner"),
    HttpApiEndpoint.get("overview", "/v1/admin/overview", {
      success: RelayAdminOverviewResponse,
      error: RelayAdminUnavailableError,
    }).annotate(OpenApi.Summary, "Totals across every Connect account"),
    HttpApiEndpoint.get("listAccounts", "/v1/admin/accounts", {
      query: RelayAdminAccountsQuery,
      success: RelayAdminAccountsResponse,
      error: RelayAdminUnavailableError,
    }).annotate(OpenApi.Summary, "List Connect accounts, newest first"),
    HttpApiEndpoint.get("account", "/v1/admin/accounts/:userId", {
      params: RelayAdminAccountParams,
      success: RelayAdminAccountResponse,
      error: [RelayAdminUnavailableError, RelayAdminAccountNotFoundError],
    }).annotate(OpenApi.Summary, "One account's machines and phones"),
  )
  .annotate(OpenApi.Description, "Owner-only view of Connect accounts. Read-only.")
  // Not in the public /openapi.json or /docs: nothing there tells a visitor the routes exist.
  .annotate(OpenApi.Exclude, true)
  .middleware(RelayAdminAuth);
