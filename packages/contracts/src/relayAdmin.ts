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

/** The highest machine limit an owner can set for one account. */
export const RELAY_ADMIN_MACHINE_LIMIT_MAX = 1000;

/** Recorded actions the action list returns, newest first. */
export const RELAY_ADMIN_ACTIONS_PAGE_SIZE = 100;

/** The signed-in owner an admin request runs as. */
export class RelayAdminPrincipal extends Context.Service<
  RelayAdminPrincipal,
  { readonly userId: string }
>()("@specweave-studio/contracts/relayAdmin/RelayAdminPrincipal") {}

export class RelayAdminUnavailableError extends Schema.TaggedError<RelayAdminUnavailableError>()(
  "RelayAdminUnavailableError",
  {
    code: Schema.Literal("admin_unavailable"),
    /**
     * - "record_failed": the action's record could not be written, so the action did not run.
     * - "action_failed": the record was written and the action then failed part way. An
     *   unlink can be sent again to finish; a phone removal has already removed the phone.
     */
    reason: Schema.Literals([
      "persistence_failed",
      "identity_lookup_failed",
      "record_failed",
      "action_failed",
    ]),
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

/** The account exists, but it has no such linked machine or phone. */
export class RelayAdminTargetNotFoundError extends Schema.TaggedError<RelayAdminTargetNotFoundError>()(
  "RelayAdminTargetNotFoundError",
  {
    code: Schema.Literal("target_not_found"),
    target: Schema.Literals(["machine", "phone"]),
  },
  { httpApiStatus: 404 },
) {
  override get message(): string {
    return `The account has no such ${this.target}.`;
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
});

/**
 * A search travels in the request body. In a URL, a customer's email would
 * land in the relay's request logs.
 */
export const RelayAdminAccountsSearchRequest = Schema.Struct({
  /** A Clerk user id (`user_...`), or an email or name to look up in Clerk. */
  query: Schema.String,
});

export const RelayAdminAccountsResponse = Schema.Struct({
  accounts: Schema.Array(RelayAdminAccount),
  nextCursor: Schema.NullOr(Schema.String),
  /** "unavailable": Clerk did not answer, so this page has ids only. */
  identities: Schema.Literals(["read", "unavailable"]),
  /** True when more people matched a search than it reads: narrow it. */
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
    HttpApiEndpoint.post("searchAccounts", "/v1/admin/accounts/search", {
      payload: RelayAdminAccountsSearchRequest,
      success: RelayAdminAccountsResponse,
      error: RelayAdminUnavailableError,
    }).annotate(OpenApi.Summary, "Find accounts by id, email or name"),
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

/**
 * What an owner sets as one account's machine limit:
 * - "limited": this many machines, 0 to 1000.
 * - "unlimited": no account limit; the relay's global cap still applies.
 * - "default": remove the owner's setting, back to the founder or free limit.
 */
export const RelayAdminMachineLimitSetting = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("limited"),
    maxMachines: Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(0),
      Schema.isLessThanOrEqualTo(RELAY_ADMIN_MACHINE_LIMIT_MAX),
    ),
  }),
  Schema.Struct({ kind: Schema.Literal("unlimited") }),
  Schema.Struct({ kind: Schema.Literal("default") }),
]);
export type RelayAdminMachineLimitSetting = typeof RelayAdminMachineLimitSetting.Type;

export const RelayAdminSetMachineLimitRequest = Schema.Struct({
  limit: RelayAdminMachineLimitSetting,
});

export const RelayAdminSetMachineLimitResponse = Schema.Struct({
  /** The account's limit now. Machines already linked stay linked. */
  limit: RelayAdminMachineLimit,
});
export type RelayAdminSetMachineLimitResponse = typeof RelayAdminSetMachineLimitResponse.Type;

export const RelayAdminMachineParams = Schema.Struct({
  userId: Schema.String,
  environmentId: Schema.String,
});

export const RelayAdminUnlinkMachineResponse = Schema.Struct({ unlinked: Schema.Boolean });
export type RelayAdminUnlinkMachineResponse = typeof RelayAdminUnlinkMachineResponse.Type;

export const RelayAdminPhoneParams = Schema.Struct({
  userId: Schema.String,
  deviceId: Schema.String,
});

export const RelayAdminRemovePhoneResponse = Schema.Struct({ removed: Schema.Boolean });
export type RelayAdminRemovePhoneResponse = typeof RelayAdminRemovePhoneResponse.Type;

export const RelayAdminActionKind = Schema.Literals([
  "set_machine_limit",
  "unlink_machine",
  "remove_phone",
]);
export type RelayAdminActionKind = typeof RelayAdminActionKind.Type;

/**
 * - "started": recorded, and the action has not reported back (it may still be running, or the
 *   relay stopped part way).
 * - "done": the action finished.
 * - "failed": the action failed part way.
 */
export const RelayAdminActionOutcome = Schema.Literals(["started", "done", "failed"]);
export type RelayAdminActionOutcome = typeof RelayAdminActionOutcome.Type;

/** One recorded owner action: who did what to which account, and when. */
export const RelayAdminAction = Schema.Struct({
  id: Schema.String,
  /** The owner who acted. */
  ownerUserId: Schema.String,
  action: RelayAdminActionKind,
  /** The account acted on. */
  targetUserId: Schema.String,
  /** The machine's environment id or the phone's device id; null for a limit change. */
  targetId: Schema.NullOr(Schema.String),
  /** The machine's or phone's name when the action ran. */
  targetLabel: Schema.NullOr(Schema.String),
  /** For a limit change: the account's limit before it. */
  limitBefore: Schema.NullOr(RelayAdminMachineLimit),
  /** For a limit change: what the owner set. */
  limitSet: Schema.NullOr(RelayAdminMachineLimitSetting),
  outcome: RelayAdminActionOutcome,
  createdAt: Schema.String,
});
export type RelayAdminAction = typeof RelayAdminAction.Type;

export const RelayAdminActionsResponse = Schema.Struct({
  actions: Schema.Array(RelayAdminAction),
});
export type RelayAdminActionsResponse = typeof RelayAdminActionsResponse.Type;

/**
 * What an owner can change. Every change is a POST so the relay's CORS rules
 * need no new method, and each writes its record before it acts.
 */
export const RelayAdminActionsGroup = HttpApiGroup.make("adminActions")
  .add(
    HttpApiEndpoint.get("listActions", "/v1/admin/actions", {
      success: RelayAdminActionsResponse,
      error: RelayAdminUnavailableError,
    }).annotate(OpenApi.Summary, "The last recorded owner actions, newest first"),
    HttpApiEndpoint.post("setMachineLimit", "/v1/admin/accounts/:userId/machine-limit", {
      params: RelayAdminAccountParams,
      payload: RelayAdminSetMachineLimitRequest,
      success: RelayAdminSetMachineLimitResponse,
      error: [RelayAdminUnavailableError, RelayAdminAccountNotFoundError],
    }).annotate(OpenApi.Summary, "Set, lift or reset one account's machine limit"),
    HttpApiEndpoint.post(
      "unlinkMachine",
      "/v1/admin/accounts/:userId/machines/:environmentId/unlink",
      {
        params: RelayAdminMachineParams,
        success: RelayAdminUnlinkMachineResponse,
        error: [
          RelayAdminUnavailableError,
          RelayAdminAccountNotFoundError,
          RelayAdminTargetNotFoundError,
        ],
      },
    ).annotate(OpenApi.Summary, "Unlink one machine of one account"),
    HttpApiEndpoint.post("removePhone", "/v1/admin/accounts/:userId/phones/:deviceId/remove", {
      params: RelayAdminPhoneParams,
      success: RelayAdminRemovePhoneResponse,
      error: [
        RelayAdminUnavailableError,
        RelayAdminAccountNotFoundError,
        RelayAdminTargetNotFoundError,
      ],
    }).annotate(OpenApi.Summary, "Remove one phone of one account"),
  )
  .annotate(OpenApi.Description, "Owner-only changes to Connect accounts. Each is recorded.")
  .annotate(OpenApi.Exclude, true)
  .middleware(RelayAdminAuth);
