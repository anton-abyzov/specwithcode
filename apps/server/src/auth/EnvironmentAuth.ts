import {
  AuthAccessTokenType,
  AuthAccessWriteScope,
  AuthAdministrativeScopes,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthStandardClientScopes,
  type AuthAccessTokenResult,
  type AuthBrowserSessionResult,
  type AuthClientMetadata,
  type TeamRulesRefusal,
  type AuthPrincipal,
  type AuthClientSession,
  type AuthCreatePairingCredentialInput,
  type AuthEnvironmentScope,
  type AuthMcpClientAccess,
  AUTH_MCP_CLIENT_TOKEN_MAX_TTL_SECONDS,
  type AuthPairingLink,
  type AuthPairingCredentialResult,
  type AuthSessionId,
  type AuthSessionState,
  authScopeResponse,
  type ServerAuthDescriptor,
  type ServerAuthSessionMethod,
  type AuthWebSocketTicketResult,
} from "@specweave-studio/contracts";
import { encodeOAuthScope } from "@specweave-studio/shared/oauthScope";
import {
  teamRulesMachineLinkRefusal,
  teamRulesReachOff,
  teamRulesReachRefusal,
} from "@specweave-studio/shared/teamRules";
import { currentTeamRules } from "../teamRules/TeamRules.ts";
import {
  callerFingerprint,
  isPhoneSession,
  type RuledSession,
  sessionFollowsReachRules,
  teamRulesSessionRefusal,
  teamRulesOpenSessionRefusal,
  isConnectSubject,
} from "../teamRules/TeamRulesReach.ts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as HttpServerRequest from "effect/http/HttpServerRequest";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerConfig from "../config.ts";
import * as EnvironmentAuthPolicy from "./EnvironmentAuthPolicy.ts";
import {
  principalApproval,
  principalRevocations,
  type PrincipalApproval,
} from "./principalApproval.ts";
import * as PairingGrantStore from "./PairingGrantStore.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";
import { REUSABLE_DEV_SESSION_EXPIRES_AT, resolveReusableDevAuth } from "./ReusableDevAuth.ts";
import { verifyRequestDpopProof } from "./dpop.ts";
import { arrivedOverConnect } from "./CredentialFailureLimiter.ts";
import { coordinatorOfWorkerLabel } from "../fleet/workGrantPolicy.ts";
import {
  isFleetRedeemSubject,
  parseFleetRedeemSubject,
  withinFleetInviteScopes,
} from "../fleet/fleetRedemption.ts";
import { capacityMutationOriginAllowed, mutationTrustedOrigins } from "./requestOrigin.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ConnectDeviceTrust from "../fleet/ConnectDeviceTrust.ts";

const DEFAULT_SESSION_SUBJECT = "local-cli-owner";
export const INTERNAL_ADMINISTRATIVE_BOOTSTRAP_SUBJECT = "administrative-bootstrap";

export interface IssuedPairingLink {
  readonly id: string;
  readonly credential: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly subject: string;
  readonly label?: string;
  readonly createdAt: DateTime.Utc;
  readonly expiresAt: DateTime.Utc;
}

export interface IssuedBearerSession {
  readonly sessionId: AuthSessionId;
  readonly token: string;
  /** `dpop-access-token` when issued bound to a proof key: it then works only with a DPoP proof. */
  readonly method: "bearer-access-token" | "dpop-access-token";
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly subject: string;
  readonly client: AuthClientMetadata;
  readonly expiresAt: DateTime.Utc;
}

/**
 * Sessions an MCP client (an agent SpecWithCode did not launch) obtains through
 * OAuth. They are accepted only by `/mcp`, where every action is capped by the
 * access the user approved; the HTTP API and WebSocket reject them so an agent
 * token cannot reach the full RPC surface around that cap.
 *
 * A read-only grant holds `orchestration:read` alone. Any other grant also
 * holds `orchestration:operate` and carries its runtime-mode ceiling.
 */
const TEAM_RULES_SOCKET_CHECK = "5 seconds";

/**
 * Settles when the reach rules turn this socket's session off. Only the sockets
 * those rules could end wait here, so a machine with no phones or fleet does not.
 */
const untilTeamRulesRefuse = (session: RuledSession): Effect.Effect<void> =>
  Effect.gen(function* () {
    while (teamRulesOpenSessionRefusal(yield* currentTeamRules, session) === null) {
      yield* Effect.sleep(TEAM_RULES_SOCKET_CHECK);
    }
  });

/** How often an open socket of a gated device rechecks its approval (AC-01: closed within 10 seconds). */
const DEVICE_TRUST_SOCKET_CHECK = "5 seconds";

export const MCP_CLIENT_SUBJECT = "mcp-client";
/** The subject of the management token a fleet invitation hands another machine. */
export const FLEET_INVITATION_SUBJECT = "fleet-invitation";
/** How long an MCP client sign-in, OAuth-approved or a static token, lasts by default. */
export const MCP_CLIENT_SESSION_TTL = Duration.days(30);

export const mcpClientScopes = (
  access: AuthMcpClientAccess,
): ReadonlyArray<AuthEnvironmentScope> =>
  access === "read-only"
    ? [AuthOrchestrationReadScope]
    : [AuthOrchestrationReadScope, AuthOrchestrationOperateScope];

export interface McpClientSession extends PrincipalApproval {
  readonly sessionId: AuthSessionId;
  readonly label: string;
  readonly access: AuthMcpClientAccess;
  /** The approved device this client acts for (1327); what its tools mint is bound to it. */
  readonly deviceKey?: string;
}

export interface AuthenticatedSession extends PrincipalApproval {
  readonly sessionId: AuthSessionId;
  readonly subject: string;
  readonly method: ServerAuthSessionMethod;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly proofKeyThumbprint?: string;
  readonly expiresAt?: DateTime.DateTime;
  /** What the client said it is, for the rule about phones. */
  readonly clientDeviceType?: string;
  /** What the client calls itself, for `rules records`. Self-reported. */
  readonly clientLabel?: string;
  /**
   * The approved device behind this session (1327): its own key, or the key
   * of the device whose credential minted it. What it mints is bound to it.
   */
  readonly deviceKey?: string;
  /** The device and approval this session was minted for, from its signed claims. */
  readonly boundDevice?: SessionStore.SessionDeviceBinding;
}

export * from "./EnvironmentAuthErrors.ts";
import {
  ServerAuthAuthenticatedAccessTokenIssueError,
  ServerAuthAuthenticatedSessionIssueError,
  ServerAuthBootstrapCredentialValidationError,
  ServerAuthForbiddenOperationError,
  ServerAuthInvalidCredentialError,
  ServerAuthMcpApprovalCodeError,
  ServerAuthMissingCredentialError,
  ServerAuthOtherSessionsRevocationError,
  ServerAuthPairingLinkCreationError,
  ServerAuthPairingLinkRevocationError,
  ServerAuthPairingLinksListError,
  ServerAuthScopeNotGrantedError,
  ServerAuthSessionCredentialValidationError,
  ServerAuthSessionRevocationError,
  ServerAuthSessionTokenIssueError,
  ServerAuthSessionsListError,
  ServerAuthWebSocketTokenIssueError,
  isServerAuthCredentialError,
  serverAuthCredentialReason,
  serverAuthTeamRulesMessage,
  serverAuthDeviceRefusal,
  type ServerAuthCredentialError,
  type ServerAuthInternalError,
  type ServerAuthInvalidRequestError,
} from "./EnvironmentAuthErrors.ts";

export class EnvironmentAuth extends Context.Service<
  EnvironmentAuth,
  {
    readonly onPrincipalRevoked: (
      listener: (principal: AuthPrincipal) => Effect.Effect<void>,
    ) => Effect.Effect<() => void>;
    readonly setPrincipalRevoked: (
      principal: AuthPrincipal,
      revoked: boolean,
    ) => Effect.Effect<void, ServerAuthInternalError>;
    readonly getDescriptor: () => Effect.Effect<ServerAuthDescriptor>;
    readonly getSessionState: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<AuthSessionState, ServerAuthInternalError>;
    readonly createBrowserSession: (
      credential: string,
      requestMetadata: AuthClientMetadata,
      previousSessionToken?: string,
      options?: {
        /** The request came through SpecWithCode Connect (see `refuseUnboundCoordinatorGrant`). */
        readonly overConnect?: boolean;
      },
    ) => Effect.Effect<
      {
        readonly response: AuthBrowserSessionResult;
        readonly sessionToken: string;
        readonly cookieName?: string;
        readonly expireNormalCookie?: boolean;
      },
      ServerAuthInvalidCredentialError | ServerAuthInternalError
    >;
    readonly exchangeBootstrapCredentialForAccessToken: (
      credential: string,
      requestedScopes: ReadonlyArray<AuthEnvironmentScope> | undefined,
      requestMetadata: AuthClientMetadata,
      input?: {
        readonly proofKeyThumbprint?: string;
        /** The request came through SpecWithCode Connect (see `refuseUnboundCoordinatorGrant`). */
        readonly overConnect?: boolean;
      },
    ) => Effect.Effect<
      AuthAccessTokenResult,
      ServerAuthInvalidCredentialError | ServerAuthInvalidRequestError | ServerAuthInternalError
    >;
    readonly createPairingLink: (input?: {
      readonly ttl?: Duration.Duration;
      readonly label?: string;
      readonly scopes?: ReadonlyArray<AuthEnvironmentScope>;
      readonly principal?: AuthPrincipal;
      readonly principalGeneration?: number | undefined;
      readonly subject?: string;
      readonly proofKeyThumbprint?: string;
      readonly purpose?: "startup";
      /**
       * The approved device asking (1327): the link carries its binding and
       * stops working when that device is removed.
       */
      readonly creatorDeviceKey?: string | undefined;
    }) => Effect.Effect<IssuedPairingLink, ServerAuthInternalError>;
    readonly issuePairingCredential: (
      input?: AuthCreatePairingCredentialInput & {
        readonly principalGeneration?: number | undefined;
        readonly creatorDeviceKey?: string | undefined;
      },
    ) => Effect.Effect<AuthPairingCredentialResult, ServerAuthInternalError>;
    /** Revokes the unredeemed pairing credentials one device created; answers how many. */
    readonly revokeDeviceCredentials: (
      key: string,
    ) => Effect.Effect<number, ServerAuthInternalError>;
    readonly issueStartupPairingCredential: () => Effect.Effect<
      AuthPairingCredentialResult,
      ServerAuthInternalError
    >;
    readonly listPairingLinks: (input?: {
      readonly excludeSubjects?: ReadonlyArray<string>;
    }) => Effect.Effect<ReadonlyArray<AuthPairingLink>, ServerAuthInternalError>;
    readonly revokePairingLink: (id: string) => Effect.Effect<boolean, ServerAuthInternalError>;
    readonly issueSession: (input?: {
      readonly principal?: AuthPrincipal;
      readonly principalGeneration?: number | undefined;
      readonly ttl?: Duration.Duration;
      readonly subject?: string;
      readonly scopes?: ReadonlyArray<AuthEnvironmentScope>;
      readonly label?: string;
      /** Binds the token to this DPoP key: it is then accepted only with a proof from it. */
      readonly proofKeyThumbprint?: string;
      /** Where the session was requested from, shown in this machine's client list. */
      readonly ipAddress?: string;
      /** No row: lives in this process only (SessionStore `issue` `inMemory`). */
      readonly inMemory?: boolean;
    }) => Effect.Effect<IssuedBearerSession, ServerAuthInternalError>;
    /**
     * Spends a v2 fleet invitation's one-time credential. Only a grant this
     * server minted for a fleet invitation qualifies: subject
     * `fleet-invitation-redeem:<days>`, a coordinator principal and no scope
     * beyond the invitation's. Anything else is spent and refused.
     */
    readonly consumeFleetRedemption: (credential: string) => Effect.Effect<
      {
        readonly principal: Extract<AuthPrincipal, { readonly kind: "coordinator" }>;
        readonly principalGeneration?: number | undefined;
        readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
        readonly label?: string;
        readonly days: number;
      },
      ServerAuthInvalidCredentialError | ServerAuthInternalError
    >;
    readonly listSessions: () => Effect.Effect<
      ReadonlyArray<AuthClientSession>,
      ServerAuthInternalError
    >;
    readonly revokeSession: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<boolean, ServerAuthInternalError>;
    readonly revokeOtherSessionsExcept: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<number, ServerAuthInternalError>;
    readonly listClientSessions: (
      currentSessionId: AuthSessionId,
    ) => Effect.Effect<ReadonlyArray<AuthClientSession>, ServerAuthInternalError>;
    /**
     * Revoking a SpecWithCode Connect phone's session ends every session bound
     * to its DPoP key and reports that key, so the caller can remove the phone
     * from the account too.
     */
    readonly revokeClientSession: (
      currentSessionId: AuthSessionId,
      targetSessionId: AuthSessionId,
    ) => Effect.Effect<
      { readonly revoked: boolean; readonly connectProofKeyThumbprint: string | null },
      ServerAuthForbiddenOperationError | ServerAuthInternalError
    >;
    /** Ends every session bound to one of these DPoP keys; returns how many. */
    readonly revokeSessionsByProofKeyThumbprints: (
      proofKeyThumbprints: ReadonlyArray<string>,
    ) => Effect.Effect<number, ServerAuthInternalError>;
    readonly revokeOtherClientSessions: (
      currentSessionId: AuthSessionId,
    ) => Effect.Effect<number, ServerAuthInternalError>;
    /**
     * A cookie, bearer or DPoP credential. A cookie authorizes a request other
     * than GET or HEAD only from this server's own origin or a trusted
     * one (devUrl, `STUDIO_DEV_ALLOWED_ORIGINS`, the Mac app).
     */
    readonly authenticateHttpRequest: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<AuthenticatedSession, ServerAuthCredentialError | ServerAuthInternalError>;
    /**
     * WebSocket upgrades and media requests: a `wsTicket`, a bearer or DPoP
     * header, or a cookie. As in `authenticateHttpRequest`, a cookie upgrade or
     * state-changing request must come from this server's own origin or a
     * trusted one.
     */
    readonly authenticateWebSocketUpgrade: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<AuthenticatedSession, ServerAuthCredentialError | ServerAuthInternalError>;
    /**
     * See `SessionStore.watchEnd`: completes once the session is revoked or
     * replaced, and for a browser cookie session also once it expires. A
     * bearer or DPoP token's expiry is not an end: those clients get a new
     * token without renewing the session their open sockets are bound to.
     */
    readonly watchSessionEnd: (
      session: Pick<
        AuthenticatedSession,
        | "sessionId"
        | "method"
        | "expiresAt"
        | "subject"
        | "principal"
        | "clientDeviceType"
        | "clientLabel"
        | "proofKeyThumbprint"
        | "deviceKey"
        | "boundDevice"
      >,
    ) => Effect.Effect<Effect.Effect<void>, never, Scope.Scope>;
    readonly issueWebSocketTicket: (
      session: Pick<AuthenticatedSession, "sessionId" | "boundDevice">,
    ) => Effect.Effect<AuthWebSocketTicketResult, ServerAuthInternalError>;
    readonly issueStartupPairingUrl: (
      baseUrl: string,
    ) => Effect.Effect<string, ServerAuthInternalError>;
    /**
     * Only `mcp-client` sessions: a bearer one with `Bearer`, or a proof-bound
     * one with `DPoP` and a valid proof. Never cookies. A bearer grant held by
     * another machine is refused over SpecWithCode Connect.
     */
    readonly authenticateMcpClient: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<McpClientSession, ServerAuthCredentialError | ServerAuthInternalError>;
    readonly issueMcpClientSession: (input: {
      readonly principal?: AuthPrincipal;
      readonly principalGeneration?: number | undefined;
      readonly label: string;
      readonly access: AuthMcpClientAccess;
      readonly client: AuthClientMetadata;
      /** Binds the grant to this DPoP key (`token_type: "DPoP"`). */
      readonly proofKeyThumbprint?: string;
      /** Lifetime; `MCP_CLIENT_SESSION_TTL` when left out. Static tokens set their own. */
      readonly ttl?: Duration.Duration;
      /** The approved device asking: the session stays gated by that device (1327). */
      readonly deviceKey?: string | undefined;
    }) => Effect.Effect<
      {
        readonly sessionId: AuthSessionId;
        readonly token: string;
        readonly expiresAt: DateTime.DateTime;
        readonly tokenType: "Bearer" | "DPoP";
      },
      ServerAuthInternalError
    >;
    /**
     * Spends a one-time pairing code as approval for an MCP client with the
     * given access; the code must hold every scope that access grants.
     * Proof-bound codes (Studio Connect) are refused without being spent, and
     * desktop bootstrap grants never qualify.
     */
    readonly consumeMcpApprovalCode: (
      code: string,
      access: AuthMcpClientAccess,
    ) => Effect.Effect<
      {
        readonly principal?: AuthPrincipal;
        readonly principalGeneration?: number | undefined;
        /** A phone's pairing code: the MCP session it approves stays that phone's. */
        readonly deviceKey?: string;
      },
      ServerAuthMcpApprovalCodeError | ServerAuthInternalError
    >;
    /**
     * Checks the request's `dpop` proof (method, URL, time window, single use)
     * and answers its key thumbprint. For endpoints that bind what they issue
     * to the caller's key.
     */
    readonly verifyRequestProof: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<string, ServerAuthInvalidCredentialError | ServerAuthInternalError>;
    /** A browser cookie session only; a bearer header never counts as one. */
    readonly authenticateBrowserSession: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<AuthenticatedSession, ServerAuthCredentialError | ServerAuthInternalError>;
  }
>()("specweave-studio/auth/EnvironmentAuth") {}

type BootstrapExchangeResult = {
  readonly response: AuthBrowserSessionResult;
  readonly sessionToken: string;
  readonly cookieName?: string;
  readonly expireNormalCookie?: boolean;
};

const AUTHORIZATION_PREFIX = "Bearer ";
const DPOP_AUTHORIZATION_PREFIX = "DPoP ";
const WEBSOCKET_TICKET_QUERY_PARAM = "wsTicket";

const bySessionPriority = (left: AuthClientSession, right: AuthClientSession) => {
  const leftCanManage = left.scopes.includes(AuthAccessWriteScope);
  const rightCanManage = right.scopes.includes(AuthAccessWriteScope);
  if (leftCanManage !== rightCanManage) {
    return leftCanManage ? -1 : 1;
  }
  if (left.connected !== right.connected) {
    return left.connected ? -1 : 1;
  }
  return right.issuedAt.epochMilliseconds - left.issuedAt.epochMilliseconds;
};

export function toBootstrapExchangeError(
  cause: PairingGrantStore.BootstrapCredentialError,
): ServerAuthInvalidCredentialError | ServerAuthInternalError {
  if (PairingGrantStore.isBootstrapCredentialInternalError(cause)) {
    return new ServerAuthBootstrapCredentialValidationError({ cause });
  }

  return new ServerAuthInvalidCredentialError({
    cause,
  });
}

const rejectMcpClientAudience = <S extends { readonly subject: string }>(session: S) =>
  session.subject === MCP_CLIENT_SUBJECT
    ? Effect.fail(
        new ServerAuthInvalidCredentialError({
          diagnostic: "MCP client sessions are only accepted by the MCP endpoint.",
        }),
      ).pipe(Effect.tap(() => Effect.logWarning("Rejected an MCP client session outside /mcp.")))
    : Effect.succeed(session);

const mapSessionVerificationErrors = <A, R>(
  effect: Effect.Effect<A, SessionStore.SessionCredentialError, R>,
): Effect.Effect<A, ServerAuthInvalidCredentialError | ServerAuthInternalError, R> =>
  effect.pipe(
    Effect.mapError((cause) =>
      SessionStore.isSessionCredentialInvalidError(cause)
        ? new ServerAuthInvalidCredentialError({
            cause,
            ...(cause._tag === "DeviceReapprovalRequiredError"
              ? { diagnostic: "device_reapproval_required" }
              : {}),
          })
        : new ServerAuthSessionCredentialValidationError({ cause }),
    ),
  );

function parseBearerToken(request: HttpServerRequest.HttpServerRequest): string | null {
  const header = request.headers["authorization"];
  if (typeof header !== "string" || !header.startsWith(AUTHORIZATION_PREFIX)) {
    return null;
  }
  const token = header.slice(AUTHORIZATION_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

function parseDpopToken(request: HttpServerRequest.HttpServerRequest): string | null {
  const header = request.headers["authorization"];
  if (typeof header !== "string" || !header.startsWith(DPOP_AUTHORIZATION_PREFIX)) {
    return null;
  }
  const token = header.slice(DPOP_AUTHORIZATION_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

export function selectRequestCredential(
  request: HttpServerRequest.HttpServerRequest,
  cookieName: string,
  findLegacyCookie: (
    cookies: Readonly<Record<string, string | undefined>>,
  ) => SessionStore.LegacySessionCookie | undefined,
) {
  const cookieToken = request.cookies[cookieName];
  if (cookieToken !== undefined) {
    return { token: cookieToken, source: "cookie" } as const;
  }

  const bearerToken = parseBearerToken(request);
  if (bearerToken !== null) {
    return { token: bearerToken, source: "bearer" } as const;
  }

  const dpopToken = parseDpopToken(request);
  if (dpopToken !== null) {
    return { token: dpopToken, source: "dpop" } as const;
  }

  const legacyCookie = findLegacyCookie(request.cookies);
  if (legacyCookie !== undefined) {
    return {
      token: legacyCookie.token,
      source: "legacy-cookie",
      cookieName: legacyCookie.name,
    } as const;
  }

  return undefined;
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const policy = yield* EnvironmentAuthPolicy.EnvironmentAuthPolicy;
  const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;
  const sessions = yield* SessionStore.SessionStore;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const crypto = yield* Crypto.Crypto;
  const descriptor = yield* policy.getDescriptor();
  const config = yield* ServerConfig.ServerConfig;
  const devAuth = resolveReusableDevAuth(config);
  // Unwired, it refuses every gated device: the gate fails closed.
  const deviceTrust = yield* ConnectDeviceTrust.ConnectDeviceTrust;

  const authenticateToken = (
    token: string,
  ): Effect.Effect<
    AuthenticatedSession,
    ServerAuthInvalidCredentialError | ServerAuthInternalError
  > =>
    sessions.verify(token).pipe(
      Effect.tapError((cause) =>
        SessionStore.isSessionCredentialInvalidError(cause)
          ? Effect.logWarning("Rejected authenticated session credential.").pipe(
              Effect.annotateLogs({
                reason: cause.message,
              }),
            )
          : Effect.void,
      ),
      mapSessionVerificationErrors,
      Effect.flatMap(rejectMcpClientAudience),
      Effect.map((session) => ({
        sessionId: session.sessionId,
        ...principalApproval(session),
        subject: session.subject,
        method: session.method,
        scopes: session.scopes,
        ...(session.proofKeyThumbprint ? { proofKeyThumbprint: session.proofKeyThumbprint } : {}),
        ...(session.expiresAt ? { expiresAt: session.expiresAt } : {}),
        clientDeviceType: session.client.deviceType,
        ...(session.client.label === undefined ? {} : { clientLabel: session.client.label }),
        ...(session.boundDevice === undefined ? {} : { boundDevice: session.boundDevice }),
      })),
    );

  const refusedByTeamRules = (refused: TeamRulesRefusal) =>
    Effect.fail(
      new ServerAuthInvalidCredentialError({
        diagnostic: refused.message,
        teamRulesMessage: refused.message,
      }),
    );

  /** Reach rules decide on each request, so a rule change needs no session change. */
  const refuseSessionByTeamRules = <S extends AuthenticatedSession>(
    session: S,
    request: HttpServerRequest.HttpServerRequest,
  ) =>
    Effect.gen(function* () {
      const state = yield* currentTeamRules;
      const refused =
        teamRulesReachOff(state, "connect") && arrivedOverConnect(request)
          ? teamRulesReachRefusal(state, "connect")
          : teamRulesSessionRefusal(
              state,
              {
                subject: session.subject,
                deviceType: session.clientDeviceType,
                coordinator: session.principal?.kind === "coordinator",
              },
              callerFingerprint(request.headers),
            );
      return refused === null ? session : yield* refusedByTeamRules(refused);
    });

  /**
   * The one device gate (1327): a Connect device or hub-linked phone this
   * machine has not approved is refused here, on every route that turns a
   * credential into a session (HTTP, WebSocket ticket, browser cookie, MCP).
   * The refusal travels as `teamRulesMessage`, so older clients show the words
   * instead of asking to pair again, plus `device_not_approved` and the code.
   */
  const refuseUnapprovedDevice = <
    S extends ConnectDeviceTrust.DeviceSessionFacts & { readonly sessionId?: string },
  >(
    session: S,
  ): Effect.Effect<S & { readonly deviceKey?: string }, ServerAuthInvalidCredentialError> =>
    deviceTrust.check(session).pipe(
      Effect.flatMap((verdict) => {
        if (verdict._tag === "allowed") {
          const deviceKey =
            verdict.deviceKey ?? ConnectDeviceTrust.gatedDevice(session)?.key ?? undefined;
          return Effect.succeed(deviceKey === undefined ? session : { ...session, deviceKey });
        }
        return Effect.fail(
          new ServerAuthInvalidCredentialError({
            diagnostic: "device_not_approved",
            teamRulesMessage: verdict.message,
            deviceRefusal: "device_not_approved",
            ...(verdict.approvalCode === undefined
              ? {}
              : { deviceApprovalCode: verdict.approvalCode }),
          }),
        );
      }),
    );

  /**
   * A pairing credential an approved device created works only while that
   * device's approval stands (1327): Remove revokes the ones not yet redeemed,
   * and this catches any that slipped through, a damaged list included.
   */
  const refuseRemovedCreator = <
    G extends { readonly creatorDevice?: ConnectDeviceTrust.DeviceBinding },
  >(
    grant: G,
  ): Effect.Effect<G, ServerAuthInvalidCredentialError> =>
    grant.creatorDevice === undefined
      ? Effect.succeed(grant)
      : deviceTrust.checkBinding(grant.creatorDevice).pipe(
          Effect.flatMap((verdict) =>
            verdict._tag === "allowed"
              ? Effect.succeed(grant)
              : Effect.fail(
                  new ServerAuthInvalidCredentialError({
                    diagnostic: "device_not_approved",
                    teamRulesMessage: verdict.message,
                    deviceRefusal: "device_not_approved",
                  }),
                ),
          ),
        );

  /** Team rules first, then the device gate: every authenticated route calls this. */
  const refuseSession = <S extends AuthenticatedSession>(
    session: S,
    request: HttpServerRequest.HttpServerRequest,
  ) => refuseSessionByTeamRules(session, request).pipe(Effect.flatMap(refuseUnapprovedDevice));

  /** Refuses a new session the reach rules turn off, or that a hold could be hiding. */
  const refuseNewSessionByTeamRules = (input: {
    readonly subject?: string | undefined;
    readonly deviceType: string | undefined;
    readonly coordinator: boolean;
    readonly overConnect: boolean | undefined;
  }) =>
    Effect.gen(function* () {
      const state = yield* currentTeamRules;
      if (state.status === "none") return;
      // A Connect client renews through here, and a hold keeps what is already connected.
      if (
        state.status === "hold" &&
        (input.subject === undefined || isConnectSubject(input.subject))
      )
        return;
      const refused =
        (input.overConnect === true ? teamRulesReachRefusal(state, "connect") : null) ??
        (isPhoneSession({ subject: input.subject ?? "", deviceType: input.deviceType })
          ? teamRulesReachRefusal(state, "phones")
          : null) ??
        (input.coordinator ? teamRulesMachineLinkRefusal(state) : null);
      if (refused !== null) return yield* refusedByTeamRules(refused);
    });

  /** Refuses before the credential is spent, so it still works once the rules allow it. */
  const refuseCredentialByTeamRules = (
    credential: string,
    deviceType: string | undefined,
    overConnect: boolean | undefined,
  ) =>
    Effect.gen(function* () {
      if ((yield* currentTeamRules).status === "none") return;
      const pending = yield* bootstrapCredentials
        .peek(credential)
        .pipe(Effect.catch(() => Effect.succeed(undefined)));
      yield* refuseNewSessionByTeamRules({
        subject: pending?.subject,
        deviceType,
        coordinator: pending?.coordinator ?? false,
        overConnect,
      });
    });

  const authenticateRequestCredential = (
    request: HttpServerRequest.HttpServerRequest,
  ): Effect.Effect<
    { readonly session: AuthenticatedSession; readonly cookie: boolean },
    ServerAuthCredentialError | ServerAuthInternalError
  > => {
    const selectedCredential = selectRequestCredential(
      request,
      sessions.cookieName,
      sessions.findLegacyCookie,
    );
    const dpopToken = parseDpopToken(request);
    const hasAuthorization = request.headers.authorization !== undefined;
    const devCookieToken = devAuth ? request.cookies[devAuth.cookieName] : undefined;
    const credential =
      selectedCredential ??
      (!hasAuthorization && devCookieToken !== undefined
        ? { token: devCookieToken, source: "dev-cookie" as const }
        : undefined);
    if (!credential?.token) {
      return Effect.fail(new ServerAuthMissingCredentialError({}));
    }
    return authenticateToken(credential.token).pipe(
      Effect.flatMap((session) => refuseSessionByTeamRules(session, request)),
      Effect.flatMap((session) => {
        if (session.proofKeyThumbprint) {
          if (!dpopToken || dpopToken !== credential.token) {
            return Effect.fail(
              new ServerAuthInvalidCredentialError({
                diagnostic: "DPoP-bound access token requires DPoP authorization.",
                dpopFailureReason: "invalid_proof",
              }),
            );
          }
          return verifyRequestDpopProof({
            request,
            expectedThumbprint: session.proofKeyThumbprint,
            expectedAccessToken: dpopToken,
          }).pipe(
            Effect.provideService(ServerSecretStore.ServerSecretStore, secretStore),
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.as(session),
          );
        }
        if (dpopToken) {
          return Effect.fail(
            new ServerAuthInvalidCredentialError({
              diagnostic: "DPoP authorization requires a proof-bound access token.",
              dpopFailureReason: "invalid_proof",
            }),
          );
        }
        // Anything acting for another machine of the fleet (a management
        // token, or a session or cookie paired from one) is unbound here: a
        // long-lived bearer is never accepted from the internet-facing
        // Connect address, only from the tailnet.
        if (session.principal?.kind === "coordinator" && arrivedOverConnect(request)) {
          return Effect.logWarning(
            "Rejected an unbound fleet machine credential over SpecWithCode Connect.",
          ).pipe(
            Effect.andThen(
              Effect.fail(
                new ServerAuthInvalidCredentialError({
                  diagnostic:
                    session.subject === FLEET_INVITATION_SUBJECT
                      ? "This management token works only over Tailscale. On that machine, choose Join a main machine again and add the new line here to use SpecWithCode Connect."
                      : "This credential works only over Tailscale.",
                }),
              ),
            ),
          );
        }
        return Effect.succeed(session);
      }),
      // After the proof: only the key's holder learns its approval code.
      Effect.flatMap(refuseUnapprovedDevice),
      Effect.map((session) => ({
        session,
        cookie: credential.source !== "bearer" && credential.source !== "dpop",
      })),
    );
  };

  const authenticateRequest = (
    request: HttpServerRequest.HttpServerRequest,
  ): Effect.Effect<AuthenticatedSession, ServerAuthCredentialError | ServerAuthInternalError> =>
    authenticateRequestCredential(request).pipe(Effect.map(({ session }) => session));

  const trustedOrigins = mutationTrustedOrigins(config);
  // Browsers attach cookies to any same-site request, and every port of
  // 127.0.0.1 or localhost is the same site. A cookie may open a socket or
  // change state only from this server's own origin or a trusted one. Plain
  // reads stay open: an <img> sends no Origin, and the same-origin policy
  // keeps another page from reading the response. A POST without a body
  // needs no preflight, so CORS alone does not stop it.
  const cookieRequestOriginAllowed = (request: HttpServerRequest.HttpServerRequest) =>
    (request.headers.upgrade?.toLowerCase() !== "websocket" &&
      (request.method === "GET" || request.method === "HEAD")) ||
    capacityMutationOriginAllowed({
      origin: request.headers.origin,
      host: request.headers.host,
      requestUrl: request.originalUrl,
      forwardedProto: request.headers["x-forwarded-proto"],
      fetchSite: request.headers["sec-fetch-site"],
      authorization: request.headers.authorization,
      cookie: request.headers.cookie,
      trustedOrigins,
    });

  const authenticateSameOriginRequest = (request: HttpServerRequest.HttpServerRequest) =>
    authenticateRequestCredential(request).pipe(
      Effect.flatMap(({ session, cookie }) =>
        cookie && !cookieRequestOriginAllowed(request)
          ? Effect.logWarning("Rejected a cookie-authenticated request from another origin.").pipe(
              Effect.andThen(
                Effect.fail(
                  new ServerAuthInvalidCredentialError({
                    diagnostic:
                      "A cookie session can open sockets or change state only from this server's own origin.",
                  }),
                ),
              ),
            )
          : Effect.succeed(session),
      ),
    );

  const teamRulesMessageField = (error: ServerAuthCredentialError) => {
    const message = serverAuthTeamRulesMessage(error);
    return message === undefined ? {} : { message };
  };
  const getSessionState: EnvironmentAuth["Service"]["getSessionState"] = (request) =>
    authenticateRequest(request).pipe(
      Effect.map(
        (session) =>
          ({
            authenticated: true,
            auth: descriptor,
            ...authScopeResponse(session.scopes),
            sessionMethod: session.method,
            ...(session.expiresAt ? { expiresAt: DateTime.toUtc(session.expiresAt) } : {}),
          }) satisfies AuthSessionState,
      ),
      Effect.catchIf(isServerAuthCredentialError, (error) =>
        Effect.succeed({
          authenticated: false,
          ...(serverAuthCredentialReason(error) === "device_reapproval_required"
            ? { reapprovalRequired: true, message: error.message }
            : {}),
          // Why, in the owner's words: a client must not read this as a lost pairing.
          ...teamRulesMessageField(error),
          ...serverAuthDeviceRefusal(error),
          auth: descriptor,
        } satisfies AuthSessionState),
      ),
      Effect.withSpan("EnvironmentAuth.getSessionState"),
    );

  /**
   * A fleet invitation's redeem credential buys only a proof-bound management
   * token through `consumeFleetRedemption`. Every other exchange spends it and
   * refuses, so a leaked line never yields a bearer or a browser session.
   */
  const refuseFleetRedeemGrant = (grant: { readonly subject: string }) =>
    isFleetRedeemSubject(grant.subject)
      ? Effect.logWarning(
          "Refused a fleet invitation credential outside its redeem endpoint.",
        ).pipe(
          Effect.andThen(
            Effect.fail(
              new ServerAuthInvalidCredentialError({
                diagnostic: "This credential can only be redeemed by the machine it was made for.",
              }),
            ),
          ),
        )
      : Effect.void;

  /**
   * A pairing code minted for another machine of the fleet (coordinator
   * principal) crosses Cloudflare when that machine uses the Connect address.
   * Over Connect it may only become a proof-bound token, never a bearer or a
   * cookie: whoever saw the code at the TLS terminator holds no key. The code
   * is already spent when this refuses.
   */
  const refuseUnboundCoordinatorGrant = (
    grant: { readonly principal?: AuthPrincipal | undefined },
    options: { readonly overConnect?: boolean; readonly proofKeyThumbprint?: string } | undefined,
  ) =>
    grant.principal?.kind === "coordinator" &&
    options?.overConnect === true &&
    options.proofKeyThumbprint === undefined
      ? Effect.logWarning(
          "Refused an unbound exchange of a fleet machine's pairing code over SpecWithCode Connect.",
        ).pipe(
          Effect.andThen(
            Effect.fail(
              new ServerAuthInvalidCredentialError({
                diagnostic:
                  "Over SpecWithCode Connect this code works only with a DPoP proof. Use Tailscale, or pair again.",
              }),
            ),
          ),
        )
      : Effect.void;

  const createBrowserSession: EnvironmentAuth["Service"]["createBrowserSession"] = Effect.fn(
    "EnvironmentAuth.createBrowserSession",
  )(function* (credential, requestMetadata, previousSessionToken, options) {
    yield* refuseCredentialByTeamRules(
      credential,
      requestMetadata.deviceType,
      options?.overConnect,
    );
    if (devAuth?.matches(credential)) {
      return yield* sessions.verify(credential).pipe(
        mapSessionVerificationErrors,
        Effect.flatMap((session) =>
          DateTime.now.pipe(
            Effect.map(
              (now) =>
                ({
                  response: {
                    authenticated: true,
                    ...authScopeResponse(session.scopes),
                    sessionMethod: session.method,
                    expiresAt: DateTime.toUtc(DateTime.add(now, { days: 30 })),
                  } satisfies AuthBrowserSessionResult,
                  sessionToken: credential,
                  cookieName: devAuth.cookieName,
                  expireNormalCookie: true,
                }) satisfies BootstrapExchangeResult,
            ),
          ),
        ),
        Effect.withSpan("EnvironmentAuth.createBrowserSession"),
      );
    }
    const previousSession =
      previousSessionToken === undefined
        ? undefined
        : yield* sessions.verify(previousSessionToken).pipe(
            Effect.catchIf(SessionStore.isSessionCredentialInvalidError, () => Effect.void),
            Effect.mapError((cause) => new ServerAuthSessionCredentialValidationError({ cause })),
          );
    const grant = yield* bootstrapCredentials
      .consume(credential)
      .pipe(Effect.mapError(toBootstrapExchangeError), Effect.flatMap(refuseRemovedCreator));
    yield* refuseFleetRedeemGrant(grant);
    yield* refuseUnboundCoordinatorGrant(grant, options);
    // The rules can change while the credential is spent; the check above is the one that keeps it.
    yield* refuseNewSessionByTeamRules({
      subject: grant.subject,
      deviceType: requestMetadata.deviceType,
      coordinator: grant.principal?.kind === "coordinator",
      overConnect: options?.overConnect,
    });
    if (
      grant.method === "one-time-token" &&
      !grant.principal &&
      grant.subject !== INTERNAL_ADMINISTRATIVE_BOOTSTRAP_SUBJECT
    ) {
      return yield* new ServerAuthInvalidCredentialError({
        diagnostic: "device_reapproval_required",
      });
    }
    const session = yield* sessions
      .issue({
        method: "browser-session-cookie",
        ...principalApproval(grant),
        subject: grant.subject,
        scopes: grant.scopes,
        ...(previousSession?.method === "browser-session-cookie"
          ? { replaceSessionId: previousSession.sessionId }
          : {}),
        client: {
          ...requestMetadata,
          ...(grant.label ? { label: grant.label } : {}),
        },
      })
      .pipe(Effect.mapError((cause) => new ServerAuthAuthenticatedSessionIssueError({ cause })));
    return {
      response: {
        authenticated: true,
        ...authScopeResponse(session.scopes),
        sessionMethod: session.method,
        expiresAt: DateTime.toUtc(session.expiresAt),
      } satisfies AuthBrowserSessionResult,
      sessionToken: session.token,
    } satisfies BootstrapExchangeResult;
  });

  type ResolvedBootstrapGrant = Pick<
    PairingGrantStore.BootstrapGrant,
    "scopes" | "subject" | "label" | "principal" | "principalGeneration" | "creatorDevice"
  > & {
    readonly method: PairingGrantStore.BootstrapGrant["method"] | "reusable-dev-token";
  };
  const resolveBootstrapGrant = (
    credential: string,
    input?: {
      readonly proofKeyThumbprint?: string;
      readonly requestedScopes?: ReadonlyArray<AuthEnvironmentScope>;
      readonly requiredScopes?: ReadonlyArray<AuthEnvironmentScope>;
    },
  ): Effect.Effect<
    ResolvedBootstrapGrant,
    ServerAuthInvalidCredentialError | ServerAuthInternalError | ServerAuthScopeNotGrantedError
  > => {
    if (!devAuth?.matches(credential)) {
      return bootstrapCredentials.consume(credential, input).pipe(
        Effect.mapError((cause) =>
          cause._tag === "BootstrapCredentialScopeNotGrantedError"
            ? new ServerAuthScopeNotGrantedError({})
            : toBootstrapExchangeError(cause),
        ),
        Effect.flatMap(refuseRemovedCreator),
      );
    }
    return sessions.verify(credential).pipe(
      mapSessionVerificationErrors,
      Effect.filterOrFail(
        (session) =>
          input?.requiredScopes === undefined ||
          input.requiredScopes.every((scope) => session.scopes.includes(scope)),
        () => new ServerAuthScopeNotGrantedError({}),
      ),
      Effect.map(
        (session) =>
          ({
            method: "reusable-dev-token",
            scopes: session.scopes,
            subject: "reusable-dev-token-child",
          }) satisfies ResolvedBootstrapGrant,
      ),
    );
  };

  const exchangeBootstrapCredentialForAccessToken: EnvironmentAuth["Service"]["exchangeBootstrapCredentialForAccessToken"] =
    (credential, requestedScopes, requestMetadata, input) => {
      return refuseCredentialByTeamRules(
        credential,
        requestMetadata.deviceType,
        input?.overConnect,
      ).pipe(
        Effect.andThen(
          resolveBootstrapGrant(credential, {
            ...input,
            ...(requestedScopes !== undefined ? { requestedScopes } : {}),
          }),
        ),
        Effect.flatMap((grant) =>
          Effect.gen(function* () {
            yield* refuseFleetRedeemGrant(grant);
            yield* refuseUnboundCoordinatorGrant(grant, input);
            // A removed or denied key gets no session under a subject the gate
            // exempts. A gated one (its own Connect sign-in) may ask again.
            if (
              ConnectDeviceTrust.gatedDevice({ subject: grant.subject }) === null &&
              (yield* refuseTurnedAwayKey(input?.proofKeyThumbprint))
            )
              return yield* new ServerAuthInvalidCredentialError({
                diagnostic: "device_not_approved",
                deviceRefusal: "device_not_approved",
              });
            yield* refuseNewSessionByTeamRules({
              subject: grant.subject,
              deviceType: requestMetadata.deviceType,
              coordinator: grant.principal?.kind === "coordinator",
              overConnect: input?.overConnect,
            });
            if (
              grant.method === "one-time-token" &&
              !grant.principal &&
              grant.subject !== INTERNAL_ADMINISTRATIVE_BOOTSTRAP_SUBJECT
            ) {
              return yield* new ServerAuthInvalidCredentialError({
                diagnostic: "device_reapproval_required",
              });
            }
            const grantedScopes =
              requestedScopes === undefined
                ? grant.scopes
                : [...new Set(requestedScopes)].filter((scope) => grant.scopes.includes(scope));
            if (grantedScopes.length === 0) {
              return yield* new ServerAuthScopeNotGrantedError({});
            }
            return yield* sessions
              .issue({
                method: input?.proofKeyThumbprint ? "dpop-access-token" : "bearer-access-token",
                ...principalApproval(grant),
                subject: grant.subject,
                scopes: grantedScopes,
                ...(input?.proofKeyThumbprint
                  ? {
                      proofKeyThumbprint: input.proofKeyThumbprint,
                      ttl: Duration.hours(1),
                    }
                  : {}),
                // Desktop restarts forget the previous bearer token. Replace
                // its session, including stale entries left by older versions.
                replaceActiveForSubjectAndMethod: grant.method === "desktop-bootstrap",
                client: {
                  ...requestMetadata,
                  ...(grant.label ? { label: grant.label } : {}),
                },
              })
              .pipe(
                Effect.mapError(
                  (cause) => new ServerAuthAuthenticatedAccessTokenIssueError({ cause }),
                ),
              );
          }),
        ),
        Effect.flatMap((session) =>
          DateTime.now.pipe(
            Effect.map(
              (now) =>
                ({
                  access_token: session.token,
                  issued_token_type: AuthAccessTokenType,
                  token_type: input?.proofKeyThumbprint ? "DPoP" : "Bearer",
                  expires_in: Math.max(
                    0,
                    Math.floor(
                      (session.expiresAt.epochMilliseconds - now.epochMilliseconds) / 1000,
                    ),
                  ),
                  scope: encodeOAuthScope(session.scopes),
                }) satisfies AuthAccessTokenResult,
            ),
          ),
        ),
        Effect.withSpan("EnvironmentAuth.exchangeBootstrapCredentialForAccessToken"),
      );
    };

  const issuePairingCredentialForSubject = (input: {
    readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
    readonly subject: string;
    readonly principal?: AuthPrincipal;
    readonly principalGeneration?: number | undefined;
    readonly label?: string;
    readonly ttl?: Duration.Duration;
    readonly purpose?: "startup";
    readonly creatorDeviceKey?: string | undefined;
  }) =>
    createPairingLink({
      scopes: input.scopes,
      subject: input.subject,
      ...principalApproval(input),
      ...(input.label ? { label: input.label } : {}),
      ...(input.ttl ? { ttl: input.ttl } : {}),
      ...(input.purpose ? { purpose: input.purpose } : {}),
      ...(input.creatorDeviceKey === undefined ? {} : { creatorDeviceKey: input.creatorDeviceKey }),
    }).pipe(
      Effect.map(
        (issued) =>
          ({
            id: issued.id,
            credential: issued.credential,
            ...(issued.label ? { label: issued.label } : {}),
            expiresAt: issued.expiresAt,
          }) satisfies AuthPairingCredentialResult,
      ),
    );

  const createPairingLink: EnvironmentAuth["Service"]["createPairingLink"] = Effect.fn(
    "EnvironmentAuth.createPairingLink",
  )(
    function* (input) {
      const createdAt = yield* DateTime.now;
      // Bound to its creator's approval, stored on the link itself (1327).
      const creatorDevice =
        input?.creatorDeviceKey === undefined
          ? undefined
          : yield* deviceTrust.bindingFor(input.creatorDeviceKey);
      if (creatorDevice === null)
        return yield* new ServerAuthPairingLinkCreationError({
          cause: "The device asking is not approved here.",
        });
      const issued = yield* bootstrapCredentials.issueOneTimeToken({
        ...(creatorDevice === undefined ? {} : { creatorDevice }),
        scopes: input?.scopes ?? AuthStandardClientScopes,
        subject: input?.subject ?? "one-time-token",
        ...principalApproval(input ?? {}),
        ...(input?.ttl ? { ttl: input.ttl } : {}),
        ...(input?.label ? { label: input.label } : {}),
        ...(input?.proofKeyThumbprint ? { proofKeyThumbprint: input.proofKeyThumbprint } : {}),
        ...(input?.purpose ? { purpose: input.purpose } : {}),
      });
      return {
        id: issued.id,
        credential: issued.credential,
        scopes: input?.scopes ?? AuthStandardClientScopes,
        subject: input?.subject ?? "one-time-token",
        ...(issued.label ? { label: issued.label } : {}),
        createdAt: DateTime.toUtc(createdAt),
        expiresAt: DateTime.toUtc(issued.expiresAt),
      } satisfies IssuedPairingLink;
    },
    Effect.mapError((cause) => new ServerAuthPairingLinkCreationError({ cause })),
  );

  const listPairingLinks: EnvironmentAuth["Service"]["listPairingLinks"] = (input) =>
    bootstrapCredentials.listActive().pipe(
      Effect.map((pairingLinks) => {
        const excludedSubjects = input?.excludeSubjects ?? [
          INTERNAL_ADMINISTRATIVE_BOOTSTRAP_SUBJECT,
        ];
        return pairingLinks
          .filter((pairingLink) => !excludedSubjects.includes(pairingLink.subject))
          .map((link) => ({ ...link, ...authScopeResponse(link.scopes) }))
          .toSorted(
            (left, right) => right.createdAt.epochMilliseconds - left.createdAt.epochMilliseconds,
          );
      }),
      Effect.mapError((cause) => new ServerAuthPairingLinksListError({ cause })),
      Effect.withSpan("EnvironmentAuth.listPairingLinks"),
    );

  const revokePairingLink: EnvironmentAuth["Service"]["revokePairingLink"] = (id) =>
    bootstrapCredentials.revoke(id).pipe(
      Effect.mapError((cause) => new ServerAuthPairingLinkRevocationError({ cause })),
      Effect.withSpan("EnvironmentAuth.revokePairingLink"),
    );

  const issueSession: EnvironmentAuth["Service"]["issueSession"] = (input) =>
    sessions
      .issue({
        subject: input?.subject ?? DEFAULT_SESSION_SUBJECT,
        ...(input?.principal
          ? { principal: input.principal, principalGeneration: input.principalGeneration }
          : {}),
        method: input?.proofKeyThumbprint ? "dpop-access-token" : "bearer-access-token",
        ...(input?.proofKeyThumbprint ? { proofKeyThumbprint: input.proofKeyThumbprint } : {}),
        scopes: input?.scopes ?? AuthAdministrativeScopes,
        client: {
          ...(input?.label ? { label: input.label } : {}),
          ...(input?.ipAddress ? { ipAddress: input.ipAddress } : {}),
          deviceType: "bot",
        },
        ...(input?.ttl ? { ttl: input.ttl } : {}),
        ...(input?.inMemory ? { inMemory: true } : {}),
      })
      .pipe(
        Effect.map(
          (issued) =>
            ({
              sessionId: issued.sessionId,
              token: issued.token,
              method: input?.proofKeyThumbprint ? "dpop-access-token" : "bearer-access-token",
              scopes: issued.scopes,
              subject: input?.subject ?? DEFAULT_SESSION_SUBJECT,
              client: issued.client,
              expiresAt: DateTime.toUtc(issued.expiresAt),
            }) satisfies IssuedBearerSession,
        ),
        Effect.mapError((cause) => new ServerAuthSessionTokenIssueError({ cause })),
        Effect.withSpan("EnvironmentAuth.issueSession"),
      );

  const consumeFleetRedemption: EnvironmentAuth["Service"]["consumeFleetRedemption"] = (
    credential,
  ) =>
    bootstrapCredentials.consume(credential).pipe(
      Effect.mapError(toBootstrapExchangeError),
      Effect.flatMap(refuseRemovedCreator),
      Effect.flatMap((grant) => {
        const days = parseFleetRedeemSubject(grant.subject);
        const principal = grant.principal;
        // Checked after the grant is spent: a wrong credential is burned either way.
        return grant.method === "one-time-token" &&
          days !== null &&
          principal?.kind === "coordinator" &&
          withinFleetInviteScopes(grant.scopes)
          ? Effect.succeed({
              principal,
              ...(grant.principalGeneration !== undefined
                ? { principalGeneration: grant.principalGeneration }
                : {}),
              scopes: grant.scopes,
              ...(grant.label ? { label: grant.label } : {}),
              days,
            })
          : Effect.fail(
              new ServerAuthInvalidCredentialError({
                diagnostic: "Not a fleet invitation credential.",
              }),
            );
      }),
      Effect.withSpan("EnvironmentAuth.consumeFleetRedemption"),
    );

  const listSessions: EnvironmentAuth["Service"]["listSessions"] = () =>
    sessions.listActive().pipe(
      Effect.map((activeSessions) => activeSessions.toSorted(bySessionPriority)),
      Effect.mapError((cause) => new ServerAuthSessionsListError({ cause })),
      Effect.withSpan("EnvironmentAuth.listSessions"),
    );

  const revokeSession: EnvironmentAuth["Service"]["revokeSession"] = (sessionId) =>
    sessions.revoke(sessionId).pipe(
      Effect.mapError((cause) => new ServerAuthSessionRevocationError({ cause })),
      Effect.withSpan("EnvironmentAuth.revokeSession"),
    );

  const revokeOtherSessionsExcept: EnvironmentAuth["Service"]["revokeOtherSessionsExcept"] = (
    sessionId,
  ) =>
    sessions.revokeAllExcept(sessionId).pipe(
      Effect.mapError((cause) => new ServerAuthOtherSessionsRevocationError({ cause })),
      Effect.withSpan("EnvironmentAuth.revokeOtherSessionsExcept"),
    );

  const issuePairingCredential: EnvironmentAuth["Service"]["issuePairingCredential"] = (input) =>
    issuePairingCredentialForSubject({
      scopes: input?.scopes ?? AuthStandardClientScopes,
      subject: "one-time-token",
      principalGeneration: input?.principalGeneration,
      ...(input?.coordinatorEnvironmentId
        ? {
            principal: {
              kind: "coordinator" as const,
              environmentId: input.coordinatorEnvironmentId,
            },
          }
        : {}),
      ...(input?.label ? { label: input.label } : {}),
      ...(input?.ttlSeconds ? { ttl: Duration.seconds(input.ttlSeconds) } : {}),
      ...(input?.creatorDeviceKey === undefined
        ? {}
        : { creatorDeviceKey: input.creatorDeviceKey }),
    }).pipe(Effect.withSpan("EnvironmentAuth.issuePairingCredential"));

  const revokeDeviceCredentials: EnvironmentAuth["Service"]["revokeDeviceCredentials"] = (key) =>
    bootstrapCredentials.revokeByCreatorDevice(key).pipe(
      Effect.mapError((cause) => new ServerAuthPairingLinkRevocationError({ cause })),
      Effect.withSpan("EnvironmentAuth.revokeDeviceCredentials"),
    );

  const issueStartupPairingCredential: EnvironmentAuth["Service"]["issueStartupPairingCredential"] =
    () => {
      const fallback = issuePairingCredentialForSubject({
        scopes: AuthAdministrativeScopes,
        subject: INTERNAL_ADMINISTRATIVE_BOOTSTRAP_SUBJECT,
        purpose: "startup",
      });
      if (!devAuth) {
        return fallback.pipe(Effect.withSpan("EnvironmentAuth.issueStartupPairingCredential"));
      }
      return sessions.verify(devAuth.credential).pipe(
        Effect.map(
          (session) =>
            ({
              id: session.sessionId,
              credential: devAuth.credential,
              label: "Reusable dev token",
              expiresAt: DateTime.toUtc(session.expiresAt ?? REUSABLE_DEV_SESSION_EXPIRES_AT),
            }) satisfies AuthPairingCredentialResult,
        ),
        Effect.catch((cause) =>
          SessionStore.isSessionCredentialInvalidError(cause)
            ? fallback
            : Effect.fail(new ServerAuthPairingLinkCreationError({ cause })),
        ),
        Effect.withSpan("EnvironmentAuth.issueStartupPairingCredential"),
      );
    };

  const listClientSessions: EnvironmentAuth["Service"]["listClientSessions"] = (currentSessionId) =>
    listSessions().pipe(
      Effect.map((clientSessions) =>
        clientSessions.map((clientSession): AuthClientSession => ({
          ...clientSession,
          ...authScopeResponse(clientSession.scopes),
          current: clientSession.sessionId === currentSessionId,
        })),
      ),
      Effect.withSpan("EnvironmentAuth.listClientSessions"),
    );

  const revokeClientSession: EnvironmentAuth["Service"]["revokeClientSession"] = Effect.fn(
    "EnvironmentAuth.revokeClientSession",
  )(function* (currentSessionId, targetSessionId) {
    if (currentSessionId === targetSessionId) {
      return yield* new ServerAuthForbiddenOperationError({});
    }
    const binding = yield* sessions
      .readProofKeyBinding(targetSessionId)
      .pipe(Effect.mapError((cause) => new ServerAuthSessionRevocationError({ cause })));
    const connectProofKeyThumbprint =
      Option.isSome(binding) && binding.value.subject === "cloud-connect"
        ? binding.value.proofKeyThumbprint
        : null;
    const revoked = yield* revokeSession(targetSessionId);
    if (connectProofKeyThumbprint === null) {
      return { revoked, connectProofKeyThumbprint };
    }
    const revokedWithKey = yield* revokeSessionsByProofKeyThumbprints([connectProofKeyThumbprint]);
    return { revoked: revoked || revokedWithKey > 0, connectProofKeyThumbprint };
  });

  const revokeSessionsByProofKeyThumbprints: EnvironmentAuth["Service"]["revokeSessionsByProofKeyThumbprints"] =
    (proofKeyThumbprints) =>
      sessions.revokeByProofKeyThumbprints(proofKeyThumbprints).pipe(
        Effect.map((revokedSessionIds) => revokedSessionIds.length),
        Effect.mapError((cause) => new ServerAuthSessionRevocationError({ cause })),
        Effect.withSpan("EnvironmentAuth.revokeSessionsByProofKeyThumbprints"),
      );

  const revokeOtherClientSessions: EnvironmentAuth["Service"]["revokeOtherClientSessions"] = (
    currentSessionId,
  ) =>
    revokeOtherSessionsExcept(currentSessionId).pipe(
      Effect.withSpan("EnvironmentAuth.revokeOtherClientSessions"),
    );

  const issueStartupPairingUrl: EnvironmentAuth["Service"]["issueStartupPairingUrl"] = (baseUrl) =>
    issueStartupPairingCredential().pipe(
      Effect.map((issued) => {
        const url = new URL(baseUrl);
        url.pathname = "/pair";
        url.searchParams.delete("token");
        url.hash = new URLSearchParams([["token", issued.credential]]).toString();
        return url.toString();
      }),
      Effect.withSpan("EnvironmentAuth.issueStartupPairingUrl"),
    );

  const issueWebSocketTicket: EnvironmentAuth["Service"]["issueWebSocketTicket"] = (session) =>
    sessions
      .issueWebSocketToken(
        session.sessionId,
        session.boundDevice === undefined ? undefined : { boundDevice: session.boundDevice },
      )
      .pipe(
        Effect.mapError((cause) => new ServerAuthWebSocketTokenIssueError({ cause })),
        Effect.map(
          (issued) =>
            ({
              ticket: issued.token,
              expiresAt: DateTime.toUtc(issued.expiresAt),
            }) satisfies AuthWebSocketTicketResult,
        ),
        Effect.withSpan("EnvironmentAuth.issueWebSocketTicket"),
      );

  const authenticateHttpRequest: EnvironmentAuth["Service"]["authenticateHttpRequest"] = (
    request,
  ) =>
    authenticateSameOriginRequest(request).pipe(
      Effect.withSpan("EnvironmentAuth.authenticateHttpRequest"),
    );

  const authenticateWebSocketUpgrade: EnvironmentAuth["Service"]["authenticateWebSocketUpgrade"] =
    Effect.fn("EnvironmentAuth.authenticateWebSocketUpgrade")(function* (request) {
      const requestUrl = HttpServerRequest.toURL(request);
      if (Option.isSome(requestUrl)) {
        const websocketTicket = requestUrl.value.searchParams.get(WEBSOCKET_TICKET_QUERY_PARAM);
        if (websocketTicket && websocketTicket.trim().length > 0) {
          return yield* sessions.verifyWebSocketToken(websocketTicket).pipe(
            mapSessionVerificationErrors,
            Effect.flatMap(rejectMcpClientAudience),
            Effect.map((session) => ({
              sessionId: session.sessionId,
              ...principalApproval(session),
              subject: session.subject,
              method: session.method,
              scopes: session.scopes,
              // The device gate keys on it; a ticket session is the key holder's session.
              ...(session.proofKeyThumbprint
                ? { proofKeyThumbprint: session.proofKeyThumbprint }
                : {}),
              ...(session.expiresAt ? { expiresAt: session.expiresAt } : {}),
              clientDeviceType: session.client.deviceType,
              ...(session.client.label === undefined ? {} : { clientLabel: session.client.label }),
              ...(session.boundDevice === undefined ? {} : { boundDevice: session.boundDevice }),
            })),
            Effect.flatMap((session) => refuseSession(session, request)),
          );
        }
      }

      return yield* authenticateSameOriginRequest(request);
    });

  const untilDeviceRefused = (
    session: ConnectDeviceTrust.DeviceSessionFacts & { readonly sessionId: string },
  ) =>
    Effect.gen(function* () {
      while ((yield* deviceTrust.check(session))._tag === "allowed") {
        yield* Effect.sleep(DEVICE_TRUST_SOCKET_CHECK);
      }
    });

  // Browser-cookie sockets end at expiry because re-pairing replaces the session.
  // Relay/mobile/hosted clients renew hourly DPoP tokens, and desktop clients cache
  // bearers. Their sockets end on revoke or replacement; reconnect needs a valid token.
  const watchSessionEnd: EnvironmentAuth["Service"]["watchSessionEnd"] = (session) =>
    sessions
      .watchEnd({
        sessionId: session.sessionId,
        expiresAt: session.method === "browser-session-cookie" ? session.expiresAt : undefined,
      })
      .pipe(
        Effect.map((ended) => {
          const ruled = {
            subject: session.subject,
            deviceType: session.clientDeviceType,
            coordinator: session.principal?.kind === "coordinator",
          };
          const ruledEnd = sessionFollowsReachRules(ruled)
            ? Effect.raceFirst(ended, untilTeamRulesRefuse(ruled))
            : ended;
          // A removed device's open socket closes within the check interval.
          return ConnectDeviceTrust.gatedDevice(session) === null &&
            session.deviceKey === undefined &&
            session.boundDevice === undefined
            ? ruledEnd
            : Effect.raceFirst(ruledEnd, untilDeviceRefused(session));
        }),
      );

  const authenticateMcpClient: EnvironmentAuth["Service"]["authenticateMcpClient"] = (request) => {
    const bearer = parseBearerToken(request);
    const dpop = bearer === null ? parseDpopToken(request) : null;
    const token = bearer ?? dpop;
    if (token === null) return Effect.fail(new ServerAuthMissingCredentialError({}));
    const refuse = (diagnostic: string) =>
      Effect.fail(new ServerAuthInvalidCredentialError({ diagnostic }));
    return sessions.verify(token).pipe(
      mapSessionVerificationErrors,
      Effect.flatMap((session) => {
        if (session.subject !== MCP_CLIENT_SUBJECT)
          return refuse("Only MCP client sessions are accepted here.");
        if (bearer !== null) {
          if (session.method !== "bearer-access-token" || session.proofKeyThumbprint)
            return refuse("A proof-bound MCP grant needs DPoP authorization.");
          // Another machine's unbound grant is a 30-day bearer: over the
          // internet-facing Connect address it must be proof-bound.
          if (session.principal?.kind === "coordinator" && arrivedOverConnect(request))
            return refuse("This machine's grant works only over Tailscale here.");
          return Effect.succeed(session);
        }
        if (session.method !== "dpop-access-token" || !session.proofKeyThumbprint)
          return refuse("DPoP authorization requires a proof-bound MCP grant.");
        return verifyRequestDpopProof({
          request,
          expectedThumbprint: session.proofKeyThumbprint,
          expectedAccessToken: token,
        }).pipe(
          Effect.provideService(ServerSecretStore.ServerSecretStore, secretStore),
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.as(session),
        );
      }),
      // Only `mcp-client` sessions reach here. The gate exempts them unless a
      // device approved the client: then that device's approval must stand.
      // The binding rides in the token's signed claims, so a damaged or
      // repaired device list refuses it instead of reading as unbound.
      Effect.flatMap((session) =>
        refuseUnapprovedDevice({
          sessionId: session.sessionId,
          subject: session.subject,
          proofKeyThumbprint: session.proofKeyThumbprint,
          clientLabel: session.client.label,
          clientDeviceType: session.client.deviceType,
          boundDevice: session.boundDevice,
        }).pipe(Effect.map((checked) => ({ session, deviceKey: checked.deviceKey }))),
      ),
      Effect.map(
        ({ session, deviceKey }) =>
          ({
            sessionId: session.sessionId,
            ...principalApproval(session),
            label: session.client.label ?? "MCP client",
            access: session.scopes.includes(AuthOrchestrationOperateScope)
              ? (session.runtimeModeCeiling ?? "approval-required")
              : "read-only",
            ...(deviceKey === undefined ? {} : { deviceKey }),
          }) satisfies McpClientSession,
      ),
      Effect.withSpan("EnvironmentAuth.authenticateMcpClient"),
    );
  };

  const issueRefused = (message: string) =>
    Effect.fail(new ServerAuthSessionTokenIssueError({ cause: new Error(message) }));

  /** A key this machine removed or denied gets no new session, whatever its subject (1327). */
  const refuseTurnedAwayKey = (proofKeyThumbprint: string | undefined) =>
    proofKeyThumbprint === undefined || proofKeyThumbprint.trim() === ""
      ? Effect.succeed(false)
      : deviceTrust.isTurnedAway(ConnectDeviceTrust.deviceKeyOfThumbprint(proofKeyThumbprint));

  const issueMcpClientSession: EnvironmentAuth["Service"]["issueMcpClientSession"] = (input) =>
    Effect.gen(function* () {
      if (yield* refuseTurnedAwayKey(input.proofKeyThumbprint))
        return yield* issueRefused("That key was removed from this machine.");
      // The binding goes into the token itself, not only into the device list.
      const binding =
        input.deviceKey === undefined ? undefined : yield* deviceTrust.bindingFor(input.deviceKey);
      if (binding === null)
        return yield* issueRefused("The approving device is not approved here.");
      const issued = yield* sessions
        .issue({
          ...principalApproval(input),
          subject: MCP_CLIENT_SUBJECT,
          method: input.proofKeyThumbprint ? "dpop-access-token" : "bearer-access-token",
          ...(input.proofKeyThumbprint ? { proofKeyThumbprint: input.proofKeyThumbprint } : {}),
          scopes: mcpClientScopes(input.access),
          ttl: input.ttl ?? MCP_CLIENT_SESSION_TTL,
          ...(input.access === "read-only" ? {} : { runtimeModeCeiling: input.access }),
          client: { ...input.client, label: input.label, deviceType: "bot" },
          ...(binding === undefined ? {} : { boundDevice: binding }),
        })
        .pipe(Effect.mapError((cause) => new ServerAuthSessionTokenIssueError({ cause })));
      // Noted so Remove ends it at once; its claims refuse it either way.
      if (binding !== undefined)
        yield* deviceTrust.trackCredential({
          id: ConnectDeviceTrust.sessionBindingId(issued.sessionId),
          binding,
          expiresAtMillis: issued.expiresAt.epochMilliseconds,
        });
      return {
        sessionId: issued.sessionId,
        token: issued.token,
        expiresAt: issued.expiresAt,
        tokenType: input.proofKeyThumbprint ? ("DPoP" as const) : ("Bearer" as const),
      };
    }).pipe(Effect.withSpan("EnvironmentAuth.issueMcpClientSession"));

  const authenticateBrowserSession: EnvironmentAuth["Service"]["authenticateBrowserSession"] = (
    request,
  ) => {
    const token =
      request.cookies[sessions.cookieName] ??
      sessions.findLegacyCookie(request.cookies)?.token ??
      (devAuth ? request.cookies[devAuth.cookieName] : undefined);
    if (!token) return Effect.fail(new ServerAuthMissingCredentialError({}));
    return authenticateToken(token).pipe(
      Effect.filterOrFail(
        (session) => session.method === "browser-session-cookie" && !session.proofKeyThumbprint,
        () => new ServerAuthInvalidCredentialError({ diagnostic: "Not a browser session." }),
      ),
      Effect.flatMap((session) => refuseSession(session, request)),
      Effect.withSpan("EnvironmentAuth.authenticateBrowserSession"),
    );
  };

  /**
   * A human device's pairing code (a hub-linked phone's) approves an MCP
   * client only once this machine approved that device, and the client stays
   * tied to it: an MCP session is exempt from the gate, so it must not be a
   * way around it (1327).
   */
  const approvedDeviceOfGrant = (grant: ResolvedBootstrapGrant) =>
    Effect.gen(function* () {
      const device = ConnectDeviceTrust.gatedDevice({ subject: grant.subject });
      // A code an approved device created: the client it approves stays that device's.
      if (device === null)
        return grant.creatorDevice === undefined
          ? principalApproval(grant)
          : { ...principalApproval(grant), deviceKey: grant.creatorDevice.key };
      if (device.key === null || !(yield* deviceTrust.isApproved(device.key)))
        return yield* new ServerAuthMcpApprovalCodeError({ reason: "device_not_approved" });
      return { ...principalApproval(grant), deviceKey: device.key };
    });

  const consumeMcpApprovalCode: EnvironmentAuth["Service"]["consumeMcpApprovalCode"] = (
    code,
    access,
  ) =>
    // No proof key: a code bound to a Studio Connect client's key fails without being spent.
    resolveBootstrapGrant(code.trim(), { requiredScopes: mcpClientScopes(access) }).pipe(
      Effect.catchTags({
        ServerAuthInvalidCredentialError: (error) =>
          Effect.fail(
            new ServerAuthMcpApprovalCodeError({
              reason: error.deviceRefusal === undefined ? "unknown_or_used" : "device_not_approved",
            }),
          ),
        ServerAuthScopeNotGrantedError: () =>
          Effect.fail(new ServerAuthMcpApprovalCodeError({ reason: "insufficient_scope" })),
      }),
      Effect.flatMap((grant) =>
        isFleetRedeemSubject(grant.subject)
          ? Effect.fail(new ServerAuthMcpApprovalCodeError({ reason: "not_a_pairing_code" }))
          : grant.method === "one-time-token" && !grant.principal
            ? Effect.fail(new ServerAuthMcpApprovalCodeError({ reason: "reapproval_required" }))
            : grant.method !== "one-time-token" && grant.method !== "reusable-dev-token"
              ? Effect.fail(new ServerAuthMcpApprovalCodeError({ reason: "not_a_pairing_code" }))
              : approvedDeviceOfGrant(grant),
      ),
      Effect.withSpan("EnvironmentAuth.consumeMcpApprovalCode"),
    );

  const revocations = principalRevocations();
  return EnvironmentAuth.of({
    onPrincipalRevoked: revocations.listen,
    setPrincipalRevoked: (principal, revoked) =>
      sessions.setPrincipalRevoked(principal, revoked).pipe(
        Effect.tap(() => (revoked ? revocations.notify(principal) : Effect.void)),
        Effect.mapError((cause) => new ServerAuthSessionRevocationError({ cause })),
      ),
    getDescriptor: () =>
      Effect.succeed(descriptor).pipe(Effect.withSpan("EnvironmentAuth.getDescriptor")),
    getSessionState,
    createBrowserSession,
    exchangeBootstrapCredentialForAccessToken,
    createPairingLink,
    issuePairingCredential,
    revokeDeviceCredentials,
    issueStartupPairingCredential,
    listPairingLinks,
    revokePairingLink,
    issueSession,
    consumeFleetRedemption,
    listSessions,
    revokeSession,
    revokeOtherSessionsExcept,
    listClientSessions,
    revokeClientSession,
    revokeSessionsByProofKeyThumbprints,
    revokeOtherClientSessions,
    authenticateHttpRequest,
    authenticateWebSocketUpgrade,
    watchSessionEnd,
    issueWebSocketTicket,
    issueStartupPairingUrl,
    authenticateMcpClient,
    issueMcpClientSession,
    consumeMcpApprovalCode,
    verifyRequestProof: (request) =>
      verifyRequestDpopProof({ request }).pipe(
        Effect.provideService(ServerSecretStore.ServerSecretStore, secretStore),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.withSpan("EnvironmentAuth.verifyRequestProof"),
      ),
    authenticateBrowserSession,
  });
});

const MCP_CLIENT_TOKEN_MAX_LABEL_LENGTH = 100;

/** A static MCP client token request this server refuses, with why. */
export class StaticMcpTokenInputError extends Schema.TaggedError<StaticMcpTokenInputError>()(
  "StaticMcpTokenInputError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

/**
 * Mints a static MCP client token: the same `mcp-client` session an OAuth
 * approval issues, for a client that can only send a fixed
 * `Authorization: Bearer` header (Grok's remote MCP, the OpenAI Responses
 * `mcp` tool, n8n, a bot). It carries its own device principal, so work
 * grants bind it like any signed-in agent, and it is listed and revoked with
 * the other MCP clients. Never key-bound, and not a machine's grant, so it is
 * accepted over SpecWithCode Connect within its access ceiling. The token is
 * returned once and never logged.
 */
export const mintStaticMcpClientToken = Effect.fn("EnvironmentAuth.mintStaticMcpClientToken")(
  function* (
    environmentAuth: EnvironmentAuth["Service"],
    input: {
      readonly label: string;
      readonly access: AuthMcpClientAccess;
      readonly ttl?: Duration.Duration | undefined;
      /** The approved device asking: the token stays gated by that device. */
      readonly deviceKey?: string | undefined;
    },
  ) {
    const label = input.label.trim();
    const ttl = input.ttl ?? MCP_CLIENT_SESSION_TTL;
    const ttlMs = Duration.toMillis(ttl);
    if (label.length === 0 || label.length > MCP_CLIENT_TOKEN_MAX_LABEL_LENGTH) {
      return yield* new StaticMcpTokenInputError({
        reason: `The label must be 1 to ${MCP_CLIENT_TOKEN_MAX_LABEL_LENGTH} characters.`,
      });
    }
    // A worker name claims a machine's grant, which only that machine's approval may hold.
    if (coordinatorOfWorkerLabel(label) !== undefined) {
      return yield* new StaticMcpTokenInputError({
        reason: "That label is reserved for another machine's fleet grant.",
      });
    }
    if (
      !Number.isFinite(ttlMs) ||
      ttlMs < 60_000 ||
      ttlMs > AUTH_MCP_CLIENT_TOKEN_MAX_TTL_SECONDS * 1000
    ) {
      return yield* new StaticMcpTokenInputError({
        reason: "The TTL must be between 1 minute and 90 days.",
      });
    }
    const issued = yield* environmentAuth.issueMcpClientSession({
      label,
      access: input.access,
      client: { label, deviceType: "bot" },
      ttl,
      ...(input.deviceKey === undefined ? {} : { deviceKey: input.deviceKey }),
    });
    yield* Effect.logInfo("Issued a static MCP client token.", {
      sessionId: issued.sessionId,
      client: label,
      access: input.access,
    });
    return {
      sessionId: issued.sessionId,
      token: issued.token,
      tokenType: "Bearer" as const,
      label,
      access: input.access,
      expiresAt: DateTime.toUtc(issued.expiresAt),
    };
  },
);

export const layer = Layer.effect(EnvironmentAuth, make).pipe(
  // The device gate's store; merged so CloudLink and the settings routes share it.
  Layer.provideMerge(ConnectDeviceTrust.layer),
  Layer.provideMerge(PairingGrantStore.layer),
  Layer.provideMerge(SessionStore.layer),
  Layer.provideMerge(EnvironmentAuthPolicy.layer),
);

const layerStorage = Layer.mergeAll(
  ServerSecretStore.layer,
  SqlitePersistence.layerConfigOutsideService,
);

/**
 * The auth store for the CLI, opened directly. It refuses while a service runs
 * from the same home (Sqlite.layerConfigOutsideService); a command that needs
 * the running service calls it with the local CLI credential instead
 * (LocalCliCredential.ts, cli/liveService.ts). The service uses `layer`.
 */
export const layerRuntime = layer.pipe(
  Layer.provideMerge(layerStorage),
  Layer.provideMerge(ServerEnvironment.layerIdentity),
);
