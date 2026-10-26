import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";
import * as HttpServerRespondable from "effect/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import {
  StudioFleetAddInput,
  StudioFleetAddResult,
  StudioFleetSnapshot,
  StudioFleetConnectInput,
  StudioFleetConnectResult,
  StudioFleetInviteInput,
  StudioFleetInviteProblem,
  StudioFleetInviteResult,
  StudioFleetRemoteWorkersQuery,
  StudioFleetTailscaleSignInInput,
  StudioFleetTailscaleSignInResult,
  StudioFleetTailscaleStatus,
  StudioFleetRemoteWorkersResult,
  StudioFleetWorkersAllowInput,
  StudioFleetWorkersResult,
  StudioFleetWorkersStopInput,
  StudioFleetRemoveInput,
  StudioFleetRemoveResult,
  StudioFleetPhoneRosterInput,
  StudioFleetPhoneRoster,
  StudioFleetPhoneMintInput,
  StudioFleetPhoneMintResult,
  StudioFleetPhoneLinksInput,
  StudioFleetPhoneLinksResult,
  StudioWorkGrantsSnapshot,
  StudioWorkGrantUpdateInput,
  StudioWorkGrantRevokeInput,
  StudioWorkGrantRestoreInput,
  StudioWorkGrantResult,
} from "./studioFleet.ts";
import {
  DeviceSignInApproveInput,
  DeviceSignInApproveResult,
  DeviceSignInPollInput,
  DeviceSignInPollResult,
  DeviceSignInStartInput,
  DeviceSignInStartResult,
} from "./deviceSignIn.ts";
import {
  StudioCapacitySnapshot,
  StudioCapacityRefreshInput,
  StudioCapacityPolicyInput,
  StudioCapacitySelectInput,
} from "./studio.ts";

import {
  AuthAccessTokenResult,
  AuthBrowserSessionRequest,
  AuthBrowserSessionResult,
  AuthClientSession,
  AuthCreatePairingCredentialInput,
  AuthMcpApprovalDecisionRequest,
  AuthMcpApprovalDetails,
  AuthMcpApprovalError,
  AuthMcpApprovalRedirect,
  AuthMcpAuthorizationRequest,
  AuthMcpAuthorizationServerMetadata,
  AuthMcpClientRegistration,
  AuthMcpProtectedResourceMetadata,
  AuthMcpRegisteredClient,
  AuthMcpRegistrationError,
  AuthMcpTokenError,
  AuthMcpTokenRequest,
  AuthMcpTokenResult,
  AuthPairingCredentialResult,
  AuthPairingLink,
  AuthRevokeClientSessionInput,
  AuthRevokePairingLinkInput,
  AuthEnvironmentScope,
  AuthTokenExchangeRequest,
  AuthSessionState,
  AuthWebSocketTicketResult,
  AuthWorkerGrantRenewalRequest,
  AuthWorkerGrantRenewalResult,
  ServerAuthSessionMethod,
} from "./auth.ts";
import {
  ExecutionEnvironmentDescriptor,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
} from "./environment.ts";
import {
  DpopFailureReason,
  AuthSessionId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ThreadBoundedSnapshot,
  OrchestrationV2ThreadDetailSnapshot,
  OrchestrationV2ThreadHistoryPage,
} from "./orchestrationV2.ts";
import {
  Project,
  ProjectFolderCheck,
  ProjectFolderCheckInput,
  ProjectMutation,
  ProjectSnapshot,
} from "./project.ts";
import {
  PullRequestDiffInput,
  PullRequestDiffResult,
  PullRequestOperationError,
  PullRequestUnavailableError,
} from "./pullRequest.ts";
import {
  RelayCloudEnvironmentHealthRequest,
  RelayCloudMintCredentialRequest,
  RelayEnvironmentConfigRequest,
  RelayEnvironmentHealthResponse,
  RelayEnvironmentLinkProof,
  RelayEnvironmentMintResponse,
  RelayLinkProofRequest,
} from "./relay.ts";

const OptionalBearerHeaders = Schema.Struct({
  authorization: Schema.optionalKey(Schema.String),
  dpop: Schema.optionalKey(Schema.String),
});

const OrchestrationProtocolHeaders = Schema.Struct({
  authorization: Schema.optionalKey(Schema.String),
  dpop: Schema.optionalKey(Schema.String),
  [ORCHESTRATION_PROTOCOL_HEADER]: Schema.Literal(ORCHESTRATION_PROTOCOL_VERSION_TEXT),
});

const OptionalDpopProofHeaders = Schema.Struct({
  dpop: Schema.optionalKey(Schema.String),
});

export const EnvironmentRequestInvalidReason = Schema.Literals([
  "invalid_scope",
  "scope_not_granted",
  "invalid_command",
  "invalid_history_cursor",
  "project_settings_conflict",
  "project_confirmation_required",
  "project_active_work",
  "project_delete_rate_limited",
  "project_environment_active",
  "project_environment_invalid",
  "project_folder_change_refused",
  "project_folder_missing",
  "project_name_taken",
  "project_assistant_exists",
  "project_kind_fixed",
]);
export type EnvironmentRequestInvalidReason = typeof EnvironmentRequestInvalidReason.Type;

export const EnvironmentAuthInvalidReason = Schema.Literals([
  "missing_credential",
  "invalid_credential",
  "device_reapproval_required",
]);
export type EnvironmentAuthInvalidReason = typeof EnvironmentAuthInvalidReason.Type;

export const EnvironmentOperationForbiddenReason = Schema.Literals([
  "current_session_revoke_not_allowed",
]);
export type EnvironmentOperationForbiddenReason = typeof EnvironmentOperationForbiddenReason.Type;

export const EnvironmentInternalErrorReason = Schema.Literals([
  "bootstrap_validation_failed",
  "browser_session_issuance_failed",
  "browser_session_cookie_failed",
  "access_token_issuance_failed",
  "websocket_ticket_issuance_failed",
  "pairing_credential_issuance_failed",
  "pairing_links_load_failed",
  "pairing_link_revoke_failed",
  "client_sessions_load_failed",
  "client_session_revoke_failed",
  "project_snapshot_failed",
  "project_mutation_failed",
  "orchestration_snapshot_failed",
  "orchestration_thread_snapshot_failed",
  "orchestration_thread_bounded_snapshot_failed",
  "orchestration_thread_history_failed",
  "internal_error",
]);
export type EnvironmentInternalErrorReason = typeof EnvironmentInternalErrorReason.Type;

export class EnvironmentRequestInvalidError extends Schema.TaggedError<EnvironmentRequestInvalidError>()(
  "EnvironmentRequestInvalidError",
  {
    code: Schema.Literal("invalid_request"),
    reason: EnvironmentRequestInvalidReason,
    /**
     * The server's own words for this refusal, when the reason alone cannot say
     * what to do (why a project folder change was refused). Older servers omit it.
     */
    detail: Schema.optionalKey(Schema.String),
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 400 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentRequestInvalidError)(this, { status: 400 });
  }

  override get message(): string {
    if (this.detail !== undefined && this.detail.length > 0) return this.detail;
    switch (this.reason) {
      case "project_settings_conflict":
        return "Project settings changed elsewhere. Reload before saving.";
      case "project_confirmation_required":
        return "Type the project name exactly to confirm deletion.";
      case "project_environment_active":
        return "Stop active project work before removing or changing folder access. Adding a folder works while threads run.";
      case "project_environment_invalid":
        return "Use existing approved folders and credential-free HTTPS or SSH repository URLs.";
      case "project_active_work":
        return "Finish or stop active project work before deleting the project.";
      case "project_delete_rate_limited":
        return "Too many projects were deleted in the last minute. Wait a minute, then delete the rest.";
      case "project_folder_missing":
        return "The project folder does not exist. Choose an existing folder or create it before importing.";
      case "project_folder_change_refused":
        return "The project folder did not change. Check the folder in project settings before trying again.";
      case "project_name_taken":
        return "Another project already has this name. Choose a different one.";
      case "project_assistant_exists":
        return "This machine already has its personal assistant. Open it instead of creating another.";
      case "project_kind_fixed":
        return "A project's kind is set when it is created and cannot be changed.";
      default:
        return `The environment rejected the request (${this.reason}).`;
    }
  }
}

export class EnvironmentAuthInvalidError extends Schema.TaggedError<EnvironmentAuthInvalidError>()(
  "EnvironmentAuthInvalidError",
  {
    code: Schema.Literal("auth_invalid"),
    reason: EnvironmentAuthInvalidReason,
    // Older servers do not send a DPoP failure category.
    dpopFailureReason: Schema.optionalKey(DpopFailureReason),
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 401 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentAuthInvalidError)(this, { status: 401 });
  }

  override get message(): string {
    return this.reason === "device_reapproval_required"
      ? "Approve this device again in SpecWithCode. Create a new pairing code on the receiving machine and sign in again."
      : `The environment rejected this client's credentials (${this.reason}).`;
  }
}

/** These codes describe the supplied grant, never the management credential. */
export class EnvironmentWorkerGrantInvalidError extends Schema.TaggedError<EnvironmentWorkerGrantInvalidError>()(
  "EnvironmentWorkerGrantInvalidError",
  { code: Schema.Literal("grant_invalid"), error: Schema.String },
  { httpApiStatus: 400 },
) {}

export class EnvironmentWorkerGrantUnavailableError extends Schema.TaggedError<EnvironmentWorkerGrantUnavailableError>()(
  "EnvironmentWorkerGrantUnavailableError",
  { code: Schema.Literals(["grant_missing", "grant_revoked"]), error: Schema.String },
  { httpApiStatus: 409 },
) {}

export class EnvironmentScopeRequiredError extends Schema.TaggedError<EnvironmentScopeRequiredError>()(
  "EnvironmentScopeRequiredError",
  {
    code: Schema.Literal("insufficient_scope"),
    requiredScope: AuthEnvironmentScope,
    requiredPermission: Schema.optionalKey(Schema.String),
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 403 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentScopeRequiredError)(this, { status: 403 });
  }

  override get message(): string {
    return `This request needs the ${this.requiredPermission ?? this.requiredScope} scope, which this client does not have.`;
  }
}

export class EnvironmentOperationForbiddenError extends Schema.TaggedError<EnvironmentOperationForbiddenError>()(
  "EnvironmentOperationForbiddenError",
  {
    code: Schema.Literal("operation_forbidden"),
    reason: EnvironmentOperationForbiddenReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 403 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentOperationForbiddenError)(this, { status: 403 });
  }

  override get message(): string {
    return `The environment refused this operation (${this.reason}).`;
  }
}

export class EnvironmentInternalError extends Schema.TaggedError<EnvironmentInternalError>()(
  "EnvironmentInternalError",
  {
    code: Schema.Literal("internal_error"),
    reason: EnvironmentInternalErrorReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 500 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentInternalError)(this, { status: 500 });
  }

  override get message(): string {
    return `The environment failed to answer this request (${this.reason}).`;
  }
}

export const EnvironmentResourceNotFoundReason = Schema.Literals(["thread_not_found"]);
export type EnvironmentResourceNotFoundReason = typeof EnvironmentResourceNotFoundReason.Type;

export class EnvironmentResourceNotFoundError extends Schema.TaggedError<EnvironmentResourceNotFoundError>()(
  "EnvironmentResourceNotFoundError",
  {
    code: Schema.Literal("not_found"),
    reason: EnvironmentResourceNotFoundReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 404 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentResourceNotFoundError)(this, { status: 404 });
  }

  override get message(): string {
    return `The environment could not find what this request named (${this.reason}).`;
  }
}

export const EnvironmentHttpCommonError = Schema.Union([
  EnvironmentRequestInvalidError,
  EnvironmentAuthInvalidError,
  EnvironmentScopeRequiredError,
  EnvironmentOperationForbiddenError,
  EnvironmentResourceNotFoundError,
  EnvironmentInternalError,
]);
export type EnvironmentHttpCommonError = typeof EnvironmentHttpCommonError.Type;

const EnvironmentAuthenticationErrors = [
  EnvironmentAuthInvalidError,
  EnvironmentInternalError,
] as const;

export class EnvironmentHttpBadRequestError extends Schema.TaggedError<EnvironmentHttpBadRequestError>()(
  "EnvironmentHttpBadRequestError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentHttpBadRequestError)(this, { status: 400 });
  }
}

export class EnvironmentHttpUnauthorizedError extends Schema.TaggedError<EnvironmentHttpUnauthorizedError>()(
  "EnvironmentHttpUnauthorizedError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 401 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentHttpUnauthorizedError)(this, { status: 401 });
  }
}

export class EnvironmentHttpForbiddenError extends Schema.TaggedError<EnvironmentHttpForbiddenError>()(
  "EnvironmentHttpForbiddenError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 403 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentHttpForbiddenError)(this, { status: 403 });
  }
}

export class EnvironmentHttpInternalServerError extends Schema.TaggedError<EnvironmentHttpInternalServerError>()(
  "EnvironmentHttpInternalServerError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 500 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentHttpInternalServerError)(this, { status: 500 });
  }
}

/**
 * This server could not publish itself on its Tailscale name for an
 * invitation. `reason` lets the app say what to do; `message` says it plainly.
 */
export class StudioFleetInviteError extends Schema.TaggedError<StudioFleetInviteError>()(
  "StudioFleetInviteError",
  {
    reason: StudioFleetInviteProblem,
    message: Schema.String,
  },
  { httpApiStatus: 409 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(StudioFleetInviteError)(this, { status: 409 });
  }
}

export class EnvironmentHttpConflictError extends Schema.TaggedError<EnvironmentHttpConflictError>()(
  "EnvironmentHttpConflictError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 409 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentHttpConflictError)(this, { status: 409 });
  }
}

export class EnvironmentCloudEndpointUnavailableError extends Schema.TaggedError<EnvironmentCloudEndpointUnavailableError>()(
  "EnvironmentCloudEndpointUnavailableError",
  {
    message: Schema.String,
    endpointRuntimeStatus: Schema.Unknown,
  },
  { httpApiStatus: 503 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentCloudEndpointUnavailableError)(this, {
      status: 503,
    });
  }
}
const EnvironmentSessionCreationErrors = [
  EnvironmentAuthInvalidError,
  EnvironmentInternalError,
] as const;
const EnvironmentTokenExchangeErrors = [
  EnvironmentRequestInvalidError,
  EnvironmentAuthInvalidError,
  EnvironmentInternalError,
] as const;
const EnvironmentScopedOperationErrors = [
  EnvironmentScopeRequiredError,
  EnvironmentInternalError,
] as const;
const EnvironmentPairingCredentialErrors = [
  EnvironmentRequestInvalidError,
  ...EnvironmentScopedOperationErrors,
] as const;
const EnvironmentSessionRevokeErrors = [
  EnvironmentScopeRequiredError,
  EnvironmentOperationForbiddenError,
  EnvironmentInternalError,
] as const;
const EnvironmentProjectSnapshotErrors = [
  EnvironmentScopeRequiredError,
  EnvironmentInternalError,
] as const;
const EnvironmentOrchestrationSnapshotErrors = [
  EnvironmentScopeRequiredError,
  EnvironmentInternalError,
] as const;
const EnvironmentOrchestrationThreadSnapshotErrors = [
  EnvironmentScopeRequiredError,
  EnvironmentResourceNotFoundError,
  EnvironmentInternalError,
] as const;
const EnvironmentProjectMutationErrors = [
  EnvironmentRequestInvalidError,
  EnvironmentScopeRequiredError,
  EnvironmentInternalError,
] as const;

export interface EnvironmentSessionPrincipalShape {
  readonly principalGeneration?: number | undefined;
  readonly principal?: import("./auth.ts").AuthPrincipal;
  readonly sessionId: AuthSessionId;
  readonly subject: string;
  readonly method: ServerAuthSessionMethod;
  readonly scopes: ReadonlySet<AuthEnvironmentScope>;
  readonly proofKeyThumbprint?: string;
  readonly expiresAt?: DateTime.DateTime;
}

export class EnvironmentAuthenticatedPrincipal extends Context.Service<
  EnvironmentAuthenticatedPrincipal,
  EnvironmentSessionPrincipalShape
>()("@specweave-studio/contracts/environmentHttp/EnvironmentAuthenticatedPrincipal") {}

export class EnvironmentAuthenticatedAuth extends HttpApiMiddleware.Service<
  EnvironmentAuthenticatedAuth,
  { provides: EnvironmentAuthenticatedPrincipal }
>()("EnvironmentAuthenticatedAuth", {
  error: EnvironmentAuthenticationErrors,
}) {}

const EnvironmentHttpCloudErrors = [
  EnvironmentHttpBadRequestError,
  EnvironmentHttpUnauthorizedError,
  EnvironmentHttpForbiddenError,
  EnvironmentHttpConflictError,
  EnvironmentHttpInternalServerError,
  EnvironmentScopeRequiredError,
] as const;

export const EnvironmentCloudRelayConfigResult = Schema.Struct({
  ok: Schema.Boolean,
  endpointRuntimeStatus: Schema.Unknown,
});
export type EnvironmentCloudRelayConfigResult = typeof EnvironmentCloudRelayConfigResult.Type;

export const EnvironmentCloudLinkStateResult = Schema.Struct({
  linked: Schema.Boolean,
  cloudUserId: Schema.NullOr(Schema.String),
  relayUrl: Schema.NullOr(Schema.String),
  relayIssuer: Schema.NullOr(Schema.String),
  // A managed Cloudflare tunnel is provisioned for this link. False for a
  // publish-only link (activity publishing without a relay-managed tunnel), so
  // clients can present the two capabilities as independent settings.
  // Optional so newer clients tolerate older environment servers.
  managedTunnelActive: Schema.optional(Schema.Boolean),
  publishAgentActivity: Schema.Boolean,
  // Opt-in: Studio Connect holds webhook requests while this environment is
  // offline. Optional so newer clients tolerate older environment servers.
  holdWebhooksWhileOffline: Schema.optional(Schema.Boolean),
});
export type EnvironmentCloudLinkStateResult = typeof EnvironmentCloudLinkStateResult.Type;

export const EnvironmentCloudPreferencesRequest = Schema.Struct({
  publishAgentActivity: Schema.Boolean,
  // Omit to leave the current value unchanged.
  holdWebhooksWhileOffline: Schema.optional(Schema.Boolean),
});
export type EnvironmentCloudPreferencesRequest = typeof EnvironmentCloudPreferencesRequest.Type;

export const AuthPairingLinkRevokeResult = Schema.Struct({
  revoked: Schema.Boolean,
});
export type AuthPairingLinkRevokeResult = typeof AuthPairingLinkRevokeResult.Type;

export const AuthClientSessionRevokeResult = Schema.Struct({
  revoked: Schema.Boolean,
});
export type AuthClientSessionRevokeResult = typeof AuthClientSessionRevokeResult.Type;

export const AuthOtherClientSessionsRevokeResult = Schema.Struct({
  revokedCount: Schema.Number,
});
export type AuthOtherClientSessionsRevokeResult = typeof AuthOtherClientSessionsRevokeResult.Type;

class EnvironmentMetadataHttpApi extends HttpApiGroup.make("metadata").add(
  HttpApiEndpoint.get("descriptor", "/.well-known/studio/environment", {
    success: ExecutionEnvironmentDescriptor,
  }),
) {}

class EnvironmentAuthHttpApi extends HttpApiGroup.make("auth")
  .add(
    HttpApiEndpoint.get("session", "/api/auth/session", {
      headers: OptionalBearerHeaders,
      success: AuthSessionState,
      error: [EnvironmentInternalError],
    }),
  )
  .add(
    HttpApiEndpoint.post("browserSession", "/api/auth/browser-session", {
      payload: AuthBrowserSessionRequest,
      success: AuthBrowserSessionResult,
      error: EnvironmentSessionCreationErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("token", "/oauth/token", {
      headers: OptionalDpopProofHeaders,
      payload: AuthTokenExchangeRequest,
      success: AuthAccessTokenResult,
      error: EnvironmentTokenExchangeErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("webSocketTicket", "/api/auth/websocket-ticket", {
      headers: OptionalBearerHeaders,
      success: AuthWebSocketTicketResult,
      error: [EnvironmentInternalError],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("renewWorkerGrant", "/api/auth/worker-grants/renew", {
      headers: OptionalBearerHeaders,
      payload: AuthWorkerGrantRenewalRequest,
      success: AuthWorkerGrantRenewalResult,
      error: [
        EnvironmentScopeRequiredError,
        EnvironmentInternalError,
        EnvironmentWorkerGrantInvalidError,
        EnvironmentWorkerGrantUnavailableError,
      ],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("pairingCredential", "/api/auth/pairing-token", {
      headers: OptionalBearerHeaders,
      payload: AuthCreatePairingCredentialInput,
      success: AuthPairingCredentialResult,
      error: EnvironmentPairingCredentialErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("pairingLinks", "/api/auth/pairing-links", {
      headers: OptionalBearerHeaders,
      success: Schema.Array(AuthPairingLink),
      error: EnvironmentScopedOperationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("revokePairingLink", "/api/auth/pairing-links/revoke", {
      headers: OptionalBearerHeaders,
      payload: AuthRevokePairingLinkInput,
      success: AuthPairingLinkRevokeResult,
      error: EnvironmentScopedOperationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("clients", "/api/auth/clients", {
      headers: OptionalBearerHeaders,
      success: Schema.Array(AuthClientSession),
      error: EnvironmentScopedOperationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("revokeClient", "/api/auth/clients/revoke", {
      headers: OptionalBearerHeaders,
      payload: AuthRevokeClientSessionInput,
      success: AuthClientSessionRevokeResult,
      error: EnvironmentSessionRevokeErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("revokeOtherClients", "/api/auth/clients/revoke-others", {
      headers: OptionalBearerHeaders,
      success: AuthOtherClientSessionsRevokeResult,
      error: EnvironmentScopedOperationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    /**
     * Revokes the credential that calls it, such as a management token
     * another machine is giving up when it removes this one.
     */
    HttpApiEndpoint.post("revokeOwnSession", "/api/auth/session/revoke", {
      headers: OptionalBearerHeaders,
      success: AuthClientSessionRevokeResult,
      error: EnvironmentSessionRevokeErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  ) {}

/**
 * The OAuth authorization server outside agents use to sign in to `/mcp`.
 * `authorize` is where the agent sends the browser: it answers a redirect to
 * the web app's approval page, or a plain error page for a request that names
 * an unverified client or redirect, so the response is not a schema.
 */
class EnvironmentMcpOAuthHttpApi extends HttpApiGroup.make("mcpOAuth")
  .add(
    HttpApiEndpoint.get("protectedResource", "/.well-known/oauth-protected-resource", {
      success: AuthMcpProtectedResourceMetadata,
    }),
  )
  .add(
    HttpApiEndpoint.get("mcpProtectedResource", "/.well-known/oauth-protected-resource/mcp", {
      success: AuthMcpProtectedResourceMetadata,
    }),
  )
  .add(
    HttpApiEndpoint.get("authorizationServer", "/.well-known/oauth-authorization-server", {
      success: AuthMcpAuthorizationServerMetadata,
    }),
  )
  .add(
    HttpApiEndpoint.post("register", "/oauth/mcp/register", {
      payload: AuthMcpClientRegistration,
      success: AuthMcpRegisteredClient,
      error: AuthMcpRegistrationError,
    }),
  )
  .add(HttpApiEndpoint.get("authorize", "/oauth/mcp/authorize"))
  .add(
    HttpApiEndpoint.post("approval", "/oauth/mcp/approval", {
      payload: AuthMcpAuthorizationRequest,
      success: [AuthMcpApprovalDetails, AuthMcpApprovalRedirect],
      error: AuthMcpApprovalError,
    }),
  )
  .add(
    HttpApiEndpoint.post("decision", "/oauth/mcp/decision", {
      payload: AuthMcpApprovalDecisionRequest,
      success: AuthMcpApprovalRedirect,
      error: AuthMcpApprovalError,
    }),
  )
  .add(
    HttpApiEndpoint.post("token", "/oauth/mcp/token", {
      payload: AuthMcpTokenRequest,
      success: AuthMcpTokenResult,
      error: AuthMcpTokenError,
    }),
  ) {}

const EnvironmentOrchestrationThreadSnapshotParams = Schema.Struct({
  threadId: ThreadId,
});

const EnvironmentOrchestrationThreadHistoryQuery = Schema.Struct({
  cursor: TrimmedNonEmptyString,
});

/**
 * `boundLongTurns=1` cuts a user turn longer than the turn row budget into
 * pages and sends its prompt as `windowTurnStart`. Without it user turns stay
 * whole, as older clients expect; older servers ignore the parameter.
 */
const EnvironmentOrchestrationThreadBoundedSnapshotQuery = Schema.Struct({
  boundLongTurns: Schema.optionalKey(Schema.Literal("1")),
});

const EnvironmentOrchestrationThreadHistoryErrors = [
  EnvironmentRequestInvalidError,
  EnvironmentScopeRequiredError,
  EnvironmentResourceNotFoundError,
  EnvironmentInternalError,
] as const;

class EnvironmentOrchestrationHttpApi extends HttpApiGroup.make("orchestration")
  .add(
    HttpApiEndpoint.get("shellSnapshot", "/api/orchestration/shell", {
      headers: OrchestrationProtocolHeaders,
      success: OrchestrationV2ShellSnapshot,
      error: EnvironmentOrchestrationSnapshotErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("threadSnapshot", "/api/orchestration/threads/:threadId", {
      headers: OrchestrationProtocolHeaders,
      params: EnvironmentOrchestrationThreadSnapshotParams,
      success: OrchestrationV2ThreadDetailSnapshot,
      error: EnvironmentOrchestrationThreadSnapshotErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("threadBoundedSnapshot", "/api/orchestration/threads/:threadId/bounded", {
      headers: OrchestrationProtocolHeaders,
      params: EnvironmentOrchestrationThreadSnapshotParams,
      query: EnvironmentOrchestrationThreadBoundedSnapshotQuery,
      success: OrchestrationV2ThreadBoundedSnapshot,
      error: EnvironmentOrchestrationThreadSnapshotErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("threadHistoryPage", "/api/orchestration/threads/:threadId/history", {
      headers: OrchestrationProtocolHeaders,
      params: EnvironmentOrchestrationThreadSnapshotParams,
      query: EnvironmentOrchestrationThreadHistoryQuery,
      success: OrchestrationV2ThreadHistoryPage,
      error: EnvironmentOrchestrationThreadHistoryErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  ) {}

class EnvironmentProjectsHttpApi extends HttpApiGroup.make("projects")
  .add(
    HttpApiEndpoint.get("snapshot", "/api/projects", {
      headers: OptionalBearerHeaders,
      success: ProjectSnapshot,
      error: EnvironmentProjectSnapshotErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("mutate", "/api/projects/mutate", {
      headers: OptionalBearerHeaders,
      payload: ProjectMutation,
      success: Project,
      error: EnvironmentProjectMutationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    /** What a project.folder.change would do, checked without changing anything (`project move --check`). */
    HttpApiEndpoint.post("folderCheck", "/api/projects/folder-check", {
      headers: OptionalBearerHeaders,
      payload: ProjectFolderCheckInput,
      success: ProjectFolderCheck,
      error: EnvironmentProjectMutationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  ) {}

/** Large, compressible pull-request payloads travel over HTTP rather than the RPC socket. */
class EnvironmentPullRequestsHttpApi extends HttpApiGroup.make("pullRequests").add(
  HttpApiEndpoint.post("diff", "/api/pull-requests/diff", {
    headers: OptionalBearerHeaders,
    payload: PullRequestDiffInput,
    success: PullRequestDiffResult,
    error: [
      PullRequestUnavailableError,
      PullRequestOperationError,
      EnvironmentAuthInvalidError,
      EnvironmentScopeRequiredError,
      EnvironmentInternalError,
    ],
  }).middleware(EnvironmentAuthenticatedAuth),
) {}

class EnvironmentConnectHttpApi extends HttpApiGroup.make("connect")
  .add(
    HttpApiEndpoint.post("linkProof", "/api/connect/link-proof", {
      headers: OptionalBearerHeaders,
      payload: RelayLinkProofRequest,
      success: RelayEnvironmentLinkProof,
      error: EnvironmentHttpCloudErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("relayConfig", "/api/connect/relay-config", {
      headers: OptionalBearerHeaders,
      payload: RelayEnvironmentConfigRequest,
      success: EnvironmentCloudRelayConfigResult,
      error: [...EnvironmentHttpCloudErrors, EnvironmentCloudEndpointUnavailableError],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("linkState", "/api/connect/link-state", {
      headers: OptionalBearerHeaders,
      success: EnvironmentCloudLinkStateResult,
      error: EnvironmentHttpCloudErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("unlink", "/api/connect/unlink", {
      headers: OptionalBearerHeaders,
      success: EnvironmentCloudRelayConfigResult,
      error: EnvironmentHttpCloudErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("preferences", "/api/connect/preferences", {
      headers: OptionalBearerHeaders,
      payload: EnvironmentCloudPreferencesRequest,
      success: EnvironmentCloudLinkStateResult,
      error: EnvironmentHttpCloudErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("health", "/api/studio-connect/health", {
      payload: RelayCloudEnvironmentHealthRequest,
      success: RelayEnvironmentHealthResponse,
      error: EnvironmentHttpCloudErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("mintCredential", "/api/connect/mint-credential", {
      payload: RelayCloudMintCredentialRequest,
      success: RelayEnvironmentMintResponse,
      error: EnvironmentHttpCloudErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("studioMintCredential", "/api/studio-connect/mint-credential", {
      payload: RelayCloudMintCredentialRequest,
      success: RelayEnvironmentMintResponse,
      error: EnvironmentHttpCloudErrors,
    }),
  ) {}

/**
 * Public entry point for webhook tasks. Unauthenticated by design: the token
 * in the path, and an optional body signature, are the credential. The handler
 * reads the raw body itself so a signature is checked over the exact bytes.
 */
const WebhookParams = Schema.Struct({
  hookId: TrimmedNonEmptyString,
  token: TrimmedNonEmptyString,
});
const WebhookAccepted = Schema.Struct({ deliveryId: TrimmedNonEmptyString }).pipe(
  HttpApiSchema.status(202),
);
const webhookEndpoint = {
  params: WebhookParams,
  success: WebhookAccepted,
} as const;
const WEBHOOK_PATH = "/api/hooks/:hookId/:token";

class EnvironmentWebhooksHttpApi extends HttpApiGroup.make("webhooks")
  .add(HttpApiEndpoint.post("webhookPost", WEBHOOK_PATH, webhookEndpoint))
  .add(HttpApiEndpoint.put("webhookPut", WEBHOOK_PATH, webhookEndpoint))
  .add(HttpApiEndpoint.patch("webhookPatch", WEBHOOK_PATH, webhookEndpoint))
  .add(HttpApiEndpoint.get("webhookGet", WEBHOOK_PATH, webhookEndpoint)) {}

class EnvironmentStudioHttpApi extends HttpApiGroup.make("studio")
  .add(
    HttpApiEndpoint.get("capacity", "/api/studio/capacity", {
      headers: OptionalBearerHeaders,
      success: StudioCapacitySnapshot,
      error: EnvironmentScopedOperationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("refreshCapacity", "/api/studio/capacity/refresh", {
      headers: OptionalBearerHeaders,
      payload: StudioCapacityRefreshInput,
      success: StudioCapacitySnapshot,
      error: [
        ...EnvironmentScopedOperationErrors,
        EnvironmentHttpBadRequestError,
        EnvironmentHttpForbiddenError,
        EnvironmentHttpInternalServerError,
        EnvironmentHttpConflictError,
      ],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("setCapacityPolicy", "/api/studio/capacity/policy", {
      headers: OptionalBearerHeaders,
      payload: StudioCapacityPolicyInput,
      success: StudioCapacitySnapshot,
      error: [
        ...EnvironmentScopedOperationErrors,
        EnvironmentHttpBadRequestError,
        EnvironmentHttpForbiddenError,
        EnvironmentHttpInternalServerError,
        EnvironmentHttpConflictError,
      ],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("selectCapacityAccount", "/api/studio/capacity/select", {
      headers: OptionalBearerHeaders,
      payload: StudioCapacitySelectInput,
      success: StudioCapacitySnapshot,
      error: [
        ...EnvironmentScopedOperationErrors,
        EnvironmentHttpBadRequestError,
        EnvironmentHttpForbiddenError,
        EnvironmentHttpInternalServerError,
        EnvironmentHttpConflictError,
      ],
    }).middleware(EnvironmentAuthenticatedAuth),
  ) {}

class EnvironmentStudioFleetHttpApi extends HttpApiGroup.make("studioFleet")
  .add(
    HttpApiEndpoint.get("fleet", "/api/studio/fleet", {
      headers: OptionalBearerHeaders,
      success: StudioFleetSnapshot,
      error: [...EnvironmentScopedOperationErrors, EnvironmentHttpInternalServerError],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("connectFleet", "/api/studio/fleet/connect", {
      headers: OptionalBearerHeaders,
      payload: StudioFleetConnectInput,
      success: StudioFleetConnectResult,
      error: [
        ...EnvironmentScopedOperationErrors,
        EnvironmentHttpBadRequestError,
        EnvironmentHttpForbiddenError,
        EnvironmentHttpInternalServerError,
      ],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("addFleetMachine", "/api/studio/fleet/machines", {
      headers: OptionalBearerHeaders,
      payload: StudioFleetAddInput,
      success: StudioFleetAddResult,
      error: [
        ...EnvironmentScopedOperationErrors,
        EnvironmentHttpBadRequestError,
        EnvironmentHttpForbiddenError,
        EnvironmentHttpInternalServerError,
      ],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("inviteFleetMachine", "/api/studio/fleet/invite", {
      headers: OptionalBearerHeaders,
      payload: StudioFleetInviteInput,
      success: StudioFleetInviteResult,
      error: [
        ...EnvironmentScopedOperationErrors,
        EnvironmentHttpBadRequestError,
        EnvironmentHttpForbiddenError,
        EnvironmentHttpInternalServerError,
        StudioFleetInviteError,
      ],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("fleetTailscale", "/api/studio/fleet/tailscale", {
      headers: OptionalBearerHeaders,
      success: StudioFleetTailscaleStatus,
      error: [...EnvironmentScopedOperationErrors, EnvironmentHttpInternalServerError],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("signInFleetTailscale", "/api/studio/fleet/tailscale/sign-in", {
      headers: OptionalBearerHeaders,
      payload: StudioFleetTailscaleSignInInput,
      success: StudioFleetTailscaleSignInResult,
      error: [
        ...EnvironmentScopedOperationErrors,
        EnvironmentHttpBadRequestError,
        EnvironmentHttpForbiddenError,
        EnvironmentHttpInternalServerError,
        StudioFleetInviteError,
      ],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("allowFleetWorkers", "/api/studio/fleet/workers/allow", {
      headers: OptionalBearerHeaders,
      payload: StudioFleetWorkersAllowInput,
      success: StudioFleetWorkersResult,
      error: [
        ...EnvironmentScopedOperationErrors,
        EnvironmentHttpBadRequestError,
        EnvironmentHttpForbiddenError,
        EnvironmentHttpInternalServerError,
      ],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("stopFleetWorkers", "/api/studio/fleet/workers/stop", {
      headers: OptionalBearerHeaders,
      payload: StudioFleetWorkersStopInput,
      success: StudioFleetWorkersResult,
      error: [
        ...EnvironmentScopedOperationErrors,
        EnvironmentHttpBadRequestError,
        EnvironmentHttpForbiddenError,
        EnvironmentHttpInternalServerError,
      ],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("removeFleetMachine", "/api/studio/fleet/machines/remove", {
      headers: OptionalBearerHeaders,
      payload: StudioFleetRemoveInput,
      success: StudioFleetRemoveResult,
      error: [
        ...EnvironmentScopedOperationErrors,
        EnvironmentHttpBadRequestError,
        EnvironmentHttpForbiddenError,
        EnvironmentHttpInternalServerError,
      ],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("workGrants", "/api/studio/fleet/work-grants", {
      headers: OptionalBearerHeaders,
      success: StudioWorkGrantsSnapshot,
      error: [...EnvironmentScopedOperationErrors, EnvironmentHttpInternalServerError],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("updateWorkGrant", "/api/studio/fleet/work-grants/update", {
      headers: OptionalBearerHeaders,
      payload: StudioWorkGrantUpdateInput,
      success: StudioWorkGrantResult,
      error: [
        ...EnvironmentScopedOperationErrors,
        EnvironmentHttpBadRequestError,
        EnvironmentHttpForbiddenError,
        EnvironmentHttpInternalServerError,
      ],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("revokeWorkGrant", "/api/studio/fleet/work-grants/revoke", {
      headers: OptionalBearerHeaders,
      payload: StudioWorkGrantRevokeInput,
      success: StudioWorkGrantResult,
      error: [
        ...EnvironmentScopedOperationErrors,
        EnvironmentHttpBadRequestError,
        EnvironmentHttpForbiddenError,
        EnvironmentHttpInternalServerError,
      ],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("restoreWorkGrant", "/api/studio/fleet/work-grants/restore", {
      headers: OptionalBearerHeaders,
      payload: StudioWorkGrantRestoreInput,
      success: StudioWorkGrantResult,
      error: [
        ...EnvironmentScopedOperationErrors,
        EnvironmentHttpBadRequestError,
        EnvironmentHttpForbiddenError,
        EnvironmentHttpInternalServerError,
      ],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("phoneRoster", "/api/studio/fleet/phone", {
      headers: OptionalBearerHeaders,
      payload: StudioFleetPhoneRosterInput,
      success: StudioFleetPhoneRoster,
      error: [
        ...EnvironmentScopedOperationErrors,
        EnvironmentHttpBadRequestError,
        EnvironmentHttpForbiddenError,
        EnvironmentHttpInternalServerError,
      ],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("phoneMint", "/api/studio/fleet/phone/mint", {
      headers: OptionalBearerHeaders,
      payload: StudioFleetPhoneMintInput,
      success: StudioFleetPhoneMintResult,
      error: [
        ...EnvironmentScopedOperationErrors,
        EnvironmentHttpBadRequestError,
        EnvironmentHttpForbiddenError,
        EnvironmentHttpInternalServerError,
      ],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("phoneLinks", "/api/studio/fleet/phone/links", {
      headers: OptionalBearerHeaders,
      payload: StudioFleetPhoneLinksInput,
      success: StudioFleetPhoneLinksResult,
      error: [
        ...EnvironmentScopedOperationErrors,
        EnvironmentHttpBadRequestError,
        EnvironmentHttpForbiddenError,
        EnvironmentHttpInternalServerError,
      ],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("remoteWorkers", "/api/studio/fleet/remote-workers", {
      headers: OptionalBearerHeaders,
      query: StudioFleetRemoteWorkersQuery,
      success: StudioFleetRemoteWorkersResult,
      error: [...EnvironmentScopedOperationErrors, EnvironmentHttpInternalServerError],
    }).middleware(EnvironmentAuthenticatedAuth),
  ) {}

const DeviceSignInPublicErrors = [
  EnvironmentHttpBadRequestError,
  EnvironmentHttpForbiddenError,
  EnvironmentHttpConflictError,
  EnvironmentHttpInternalServerError,
] as const;

/**
 * Approve-a-device sign-in. `start` and `poll` are public: the asking browser
 * has no session yet. Both answer only same-origin browser requests on an
 * address the server recognises, and a credential leaves `poll` only after an
 * `access:write` client typed the request's code into `approve`.
 */
class EnvironmentDeviceSignInHttpApi extends HttpApiGroup.make("deviceSignIn")
  .add(
    HttpApiEndpoint.post("start", "/api/auth/device-sign-in/start", {
      payload: DeviceSignInStartInput,
      success: DeviceSignInStartResult,
      error: DeviceSignInPublicErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("poll", "/api/auth/device-sign-in/poll", {
      payload: DeviceSignInPollInput,
      success: DeviceSignInPollResult,
      error: DeviceSignInPublicErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("approve", "/api/auth/device-sign-in/approve", {
      headers: OptionalBearerHeaders,
      payload: DeviceSignInApproveInput,
      success: DeviceSignInApproveResult,
      error: [
        ...EnvironmentScopedOperationErrors,
        EnvironmentHttpBadRequestError,
        EnvironmentHttpForbiddenError,
        EnvironmentHttpInternalServerError,
      ],
    }).middleware(EnvironmentAuthenticatedAuth),
  ) {}

export class EnvironmentHttpApi extends HttpApi.make("environment")
  .add(EnvironmentMetadataHttpApi)
  .add(EnvironmentAuthHttpApi)
  .add(EnvironmentMcpOAuthHttpApi)
  .add(EnvironmentOrchestrationHttpApi)
  .add(EnvironmentPullRequestsHttpApi)
  .add(EnvironmentProjectsHttpApi)
  .add(EnvironmentConnectHttpApi)
  .add(EnvironmentWebhooksHttpApi)
  .add(EnvironmentStudioHttpApi)
  .add(EnvironmentStudioFleetHttpApi)
  .add(EnvironmentDeviceSignInHttpApi) {}
