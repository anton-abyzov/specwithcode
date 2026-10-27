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
  type AuthPrincipal,
  type AuthClientSession,
  type AuthCreatePairingCredentialInput,
  type AuthEnvironmentScope,
  type AuthMcpClientAccess,
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
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
import {
  isFleetRedeemSubject,
  parseFleetRedeemSubject,
  withinFleetInviteScopes,
} from "../fleet/fleetRedemption.ts";
import { capacityMutationOriginAllowed, mutationTrustedOrigins } from "./requestOrigin.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";

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
export const MCP_CLIENT_SUBJECT = "mcp-client";
/** The subject of the management token a fleet invitation hands another machine. */
export const FLEET_INVITATION_SUBJECT = "fleet-invitation";
const MCP_CLIENT_SESSION_TTL = Duration.days(30);

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
}

export interface AuthenticatedSession extends PrincipalApproval {
  readonly sessionId: AuthSessionId;
  readonly subject: string;
  readonly method: ServerAuthSessionMethod;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly proofKeyThumbprint?: string;
  readonly expiresAt?: DateTime.DateTime;
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
    }) => Effect.Effect<IssuedPairingLink, ServerAuthInternalError>;
    readonly issuePairingCredential: (
      input?: AuthCreatePairingCredentialInput & {
        readonly principalGeneration?: number | undefined;
      },
    ) => Effect.Effect<AuthPairingCredentialResult, ServerAuthInternalError>;
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
    readonly revokeClientSession: (
      currentSessionId: AuthSessionId,
      targetSessionId: AuthSessionId,
    ) => Effect.Effect<boolean, ServerAuthForbiddenOperationError | ServerAuthInternalError>;
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
      session: Pick<AuthenticatedSession, "sessionId" | "method" | "expiresAt">,
    ) => Effect.Effect<Effect.Effect<void>, never, Scope.Scope>;
    readonly issueWebSocketTicket: (
      session: Pick<AuthenticatedSession, "sessionId">,
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
    }) => Effect.Effect<
      {
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
      { readonly principal?: AuthPrincipal; readonly principalGeneration?: number | undefined },
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
      })),
    );

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
                      ? "This management token works only over Tailscale. Invite this machine again to use SpecWithCode Connect."
                      : "This credential works only over Tailscale.",
                }),
              ),
            ),
          );
        }
        return Effect.succeed(session);
      }),
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
      .pipe(Effect.mapError(toBootstrapExchangeError));
    yield* refuseFleetRedeemGrant(grant);
    yield* refuseUnboundCoordinatorGrant(grant, options);
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
    "scopes" | "subject" | "label" | "principal" | "principalGeneration"
  > & {
    readonly method: PairingGrantStore.BootstrapGrant["method"] | "reusable-dev-token";
  };
  const resolveBootstrapGrant = (
    credential: string,
    input?: {
      readonly proofKeyThumbprint?: string;
      readonly requestedScopes?: ReadonlyArray<AuthEnvironmentScope>;
    },
  ): Effect.Effect<
    ResolvedBootstrapGrant,
    ServerAuthInvalidCredentialError | ServerAuthInternalError | ServerAuthScopeNotGrantedError
  > => {
    if (!devAuth?.matches(credential)) {
      return bootstrapCredentials
        .consume(credential, input)
        .pipe(
          Effect.mapError((cause) =>
            cause._tag === "BootstrapCredentialScopeNotGrantedError"
              ? new ServerAuthScopeNotGrantedError({})
              : toBootstrapExchangeError(cause),
          ),
        );
    }
    return sessions.verify(credential).pipe(
      mapSessionVerificationErrors,
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
      return resolveBootstrapGrant(credential, {
        ...input,
        ...(requestedScopes !== undefined ? { requestedScopes } : {}),
      }).pipe(
        Effect.flatMap((grant) =>
          Effect.gen(function* () {
            yield* refuseFleetRedeemGrant(grant);
            yield* refuseUnboundCoordinatorGrant(grant, input);
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
  }) =>
    createPairingLink({
      scopes: input.scopes,
      subject: input.subject,
      ...principalApproval(input),
      ...(input.label ? { label: input.label } : {}),
      ...(input.ttl ? { ttl: input.ttl } : {}),
      ...(input.purpose ? { purpose: input.purpose } : {}),
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
      const issued = yield* bootstrapCredentials.issueOneTimeToken({
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
    }).pipe(Effect.withSpan("EnvironmentAuth.issuePairingCredential"));

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
    return yield* revokeSession(targetSessionId);
  });

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
    sessions.issueWebSocketToken(session.sessionId).pipe(
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
              ...(session.expiresAt ? { expiresAt: session.expiresAt } : {}),
            })),
          );
        }
      }

      return yield* authenticateSameOriginRequest(request);
    });

  // Browser-cookie sockets end at expiry because re-pairing replaces the session.
  // Relay/mobile/hosted clients renew hourly DPoP tokens, and desktop clients cache
  // bearers. Their sockets end on revoke or replacement; reconnect needs a valid token.
  const watchSessionEnd: EnvironmentAuth["Service"]["watchSessionEnd"] = (session) =>
    sessions.watchEnd({
      sessionId: session.sessionId,
      expiresAt: session.method === "browser-session-cookie" ? session.expiresAt : undefined,
    });

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
      Effect.map(
        (session) =>
          ({
            sessionId: session.sessionId,
            ...principalApproval(session),
            label: session.client.label ?? "MCP client",
            access: session.scopes.includes(AuthOrchestrationOperateScope)
              ? (session.runtimeModeCeiling ?? "approval-required")
              : "read-only",
          }) satisfies McpClientSession,
      ),
      Effect.withSpan("EnvironmentAuth.authenticateMcpClient"),
    );
  };

  const issueMcpClientSession: EnvironmentAuth["Service"]["issueMcpClientSession"] = (input) =>
    sessions
      .issue({
        ...principalApproval(input),
        subject: MCP_CLIENT_SUBJECT,
        method: input.proofKeyThumbprint ? "dpop-access-token" : "bearer-access-token",
        ...(input.proofKeyThumbprint ? { proofKeyThumbprint: input.proofKeyThumbprint } : {}),
        scopes: mcpClientScopes(input.access),
        ttl: MCP_CLIENT_SESSION_TTL,
        ...(input.access === "read-only" ? {} : { runtimeModeCeiling: input.access }),
        client: { ...input.client, label: input.label, deviceType: "bot" },
      })
      .pipe(
        Effect.map((issued) => ({
          token: issued.token,
          expiresAt: issued.expiresAt,
          tokenType: input.proofKeyThumbprint ? ("DPoP" as const) : ("Bearer" as const),
        })),
        Effect.mapError((cause) => new ServerAuthSessionTokenIssueError({ cause })),
        Effect.withSpan("EnvironmentAuth.issueMcpClientSession"),
      );

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
      Effect.withSpan("EnvironmentAuth.authenticateBrowserSession"),
    );
  };

  const consumeMcpApprovalCode: EnvironmentAuth["Service"]["consumeMcpApprovalCode"] = (
    code,
    access,
  ) =>
    // No proof key: a code bound to a Studio Connect client's key fails without being spent.
    resolveBootstrapGrant(code.trim()).pipe(
      Effect.catchTags({
        ServerAuthInvalidCredentialError: () =>
          Effect.fail(new ServerAuthMcpApprovalCodeError({ reason: "unknown_or_used" })),
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
              : mcpClientScopes(access).every((scope) => grant.scopes.includes(scope))
                ? Effect.succeed(principalApproval(grant))
                : Effect.fail(new ServerAuthMcpApprovalCodeError({ reason: "insufficient_scope" })),
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

export const layer = Layer.effect(EnvironmentAuth, make).pipe(
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
