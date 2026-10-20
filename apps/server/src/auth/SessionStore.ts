import {
  AuthSessionId,
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  type AuthWorkerGrantRenewalRequest,
  type AuthWorkerGrantRenewalResult,
  AuthAdministrativeScopes,
  AuthStandardClientScopes,
  AuthEnvironmentScopes,
  type AuthClientMetadata,
  type AuthClientSession,
  type AuthEnvironmentScope,
  type ClientSurface,
  RuntimeMode,
  type ServerAuthSessionMethod,
} from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import {
  REUSABLE_DEV_SESSION_EXPIRES_AT,
  REUSABLE_DEV_SESSION_PREFIX,
  resolveReusableDevAuth,
} from "./ReusableDevAuth.ts";
import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  resolveLegacySessionCookieName,
  resolveMovedSessionCookiePrefix,
  resolveSessionCookieName,
  signPayload,
  timingSafeEqualBase64Url,
} from "./utils.ts";

export interface LegacySessionCookie {
  readonly name: string;
  readonly token: string;
}

export interface IssuedSession {
  readonly sessionId: AuthSessionId;
  readonly token: string;
  readonly method: ServerAuthSessionMethod;
  readonly client: AuthClientMetadata;
  readonly expiresAt: DateTime.DateTime;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly proofKeyThumbprint?: string;
}

export interface VerifiedSession {
  readonly sessionId: AuthSessionId;
  readonly token: string;
  readonly method: ServerAuthSessionMethod;
  readonly client: AuthClientMetadata;
  readonly expiresAt?: DateTime.DateTime;
  readonly subject: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly proofKeyThumbprint?: string;
  /** The most an MCP client approved through OAuth may hand to the threads it drives. */
  readonly runtimeModeCeiling?: RuntimeMode;
}

export type SessionCredentialChange =
  | {
      readonly type: "clientUpserted";
      readonly clientSession: AuthClientSession;
    }
  | {
      readonly type: "clientRemoved";
      readonly sessionId: AuthSessionId;
    };

export class MalformedSessionTokenError extends Schema.TaggedError<MalformedSessionTokenError>()(
  "MalformedSessionTokenError",
  {},
) {
  override get message(): string {
    return "Malformed session token.";
  }
}

export class InvalidSessionTokenSignatureError extends Schema.TaggedError<InvalidSessionTokenSignatureError>()(
  "InvalidSessionTokenSignatureError",
  {},
) {
  override get message(): string {
    return "Invalid session token signature.";
  }
}

export class InvalidSessionTokenPayloadError extends Schema.TaggedError<InvalidSessionTokenPayloadError>()(
  "InvalidSessionTokenPayloadError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Invalid session token payload.";
  }
}

export class SessionTokenExpiredError extends Schema.TaggedError<SessionTokenExpiredError>()(
  "SessionTokenExpiredError",
  {
    sessionId: AuthSessionId,
    expiresAt: Schema.DateTimeUtc,
    observedAt: Schema.DateTimeUtc,
  },
) {
  override get message(): string {
    return "Session token expired.";
  }
}

export class UnknownSessionTokenError extends Schema.TaggedError<UnknownSessionTokenError>()(
  "UnknownSessionTokenError",
  {
    sessionId: AuthSessionId,
  },
) {
  override get message(): string {
    return "Unknown session token.";
  }
}

export class SessionTokenRevokedError extends Schema.TaggedError<SessionTokenRevokedError>()(
  "SessionTokenRevokedError",
  {
    sessionId: AuthSessionId,
    revokedAt: Schema.DateTimeUtc,
  },
) {
  override get message(): string {
    return "Session token revoked.";
  }
}

export class InvalidSessionExpirationClaimError extends Schema.TaggedError<InvalidSessionExpirationClaimError>()(
  "InvalidSessionExpirationClaimError",
  {
    sessionId: AuthSessionId,
    expirationClaim: Schema.Number,
  },
) {
  override get message(): string {
    return "Invalid `exp` claim";
  }
}

export class MalformedWebSocketTokenError extends Schema.TaggedError<MalformedWebSocketTokenError>()(
  "MalformedWebSocketTokenError",
  {},
) {
  override get message(): string {
    return "Malformed websocket token.";
  }
}

export class InvalidWebSocketTokenSignatureError extends Schema.TaggedError<InvalidWebSocketTokenSignatureError>()(
  "InvalidWebSocketTokenSignatureError",
  {},
) {
  override get message(): string {
    return "Invalid websocket token signature.";
  }
}

export class InvalidWebSocketTokenPayloadError extends Schema.TaggedError<InvalidWebSocketTokenPayloadError>()(
  "InvalidWebSocketTokenPayloadError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Invalid websocket token payload.";
  }
}

export class WebSocketTokenExpiredError extends Schema.TaggedError<WebSocketTokenExpiredError>()(
  "WebSocketTokenExpiredError",
  {
    sessionId: AuthSessionId,
    expiresAt: Schema.DateTimeUtc,
    observedAt: Schema.DateTimeUtc,
  },
) {
  override get message(): string {
    return "Websocket token expired.";
  }
}

export class UnknownWebSocketSessionError extends Schema.TaggedError<UnknownWebSocketSessionError>()(
  "UnknownWebSocketSessionError",
  {
    sessionId: AuthSessionId,
  },
) {
  override get message(): string {
    return "Unknown websocket session.";
  }
}

export class WebSocketSessionExpiredError extends Schema.TaggedError<WebSocketSessionExpiredError>()(
  "WebSocketSessionExpiredError",
  {
    sessionId: AuthSessionId,
    expiresAt: Schema.DateTimeUtc,
    observedAt: Schema.DateTimeUtc,
  },
) {
  override get message(): string {
    return "Websocket session expired.";
  }
}

export class WebSocketSessionRevokedError extends Schema.TaggedError<WebSocketSessionRevokedError>()(
  "WebSocketSessionRevokedError",
  {
    sessionId: AuthSessionId,
    revokedAt: Schema.DateTimeUtc,
  },
) {
  override get message(): string {
    return "Websocket session revoked.";
  }
}

export const SessionCredentialInvalidError = Schema.Union([
  MalformedSessionTokenError,
  InvalidSessionTokenSignatureError,
  InvalidSessionTokenPayloadError,
  SessionTokenExpiredError,
  UnknownSessionTokenError,
  SessionTokenRevokedError,
  InvalidSessionExpirationClaimError,
  MalformedWebSocketTokenError,
  InvalidWebSocketTokenSignatureError,
  InvalidWebSocketTokenPayloadError,
  WebSocketTokenExpiredError,
  UnknownWebSocketSessionError,
  WebSocketSessionExpiredError,
  WebSocketSessionRevokedError,
]);
export type SessionCredentialInvalidError = typeof SessionCredentialInvalidError.Type;
export const isSessionCredentialInvalidError = Schema.is(SessionCredentialInvalidError);

const sessionCredentialInternalErrorContext = {
  cause: Schema.Defect(),
};

export class SessionClaimsEncodingError extends Schema.TaggedError<SessionClaimsEncodingError>()(
  "SessionClaimsEncodingError",
  {
    sessionId: AuthSessionId,
    operation: Schema.Literals(["encode_session_claims", "encode_websocket_claims"]),
    ...sessionCredentialInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to encode claims";
  }
}

export class SessionCredentialIssueError extends Schema.TaggedError<SessionCredentialIssueError>()(
  "SessionCredentialIssueError",
  {
    sessionId: Schema.optional(AuthSessionId),
    ...sessionCredentialInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to issue session credential.";
  }
}

export class SessionCredentialVerificationError extends Schema.TaggedError<SessionCredentialVerificationError>()(
  "SessionCredentialVerificationError",
  {
    sessionId: AuthSessionId,
    ...sessionCredentialInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to verify session credential.";
  }
}

export class WebSocketTokenIssueError extends Schema.TaggedError<WebSocketTokenIssueError>()(
  "WebSocketTokenIssueError",
  {
    sessionId: AuthSessionId,
    ...sessionCredentialInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to issue websocket token.";
  }
}

export class WebSocketTokenVerificationError extends Schema.TaggedError<WebSocketTokenVerificationError>()(
  "WebSocketTokenVerificationError",
  {
    sessionId: AuthSessionId,
    ...sessionCredentialInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to verify websocket token.";
  }
}

export class ActiveSessionsListError extends Schema.TaggedError<ActiveSessionsListError>()(
  "ActiveSessionsListError",
  {
    ...sessionCredentialInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to list active sessions.";
  }
}

export class SessionRevocationError extends Schema.TaggedError<SessionRevocationError>()(
  "SessionRevocationError",
  {
    sessionId: AuthSessionId,
    ...sessionCredentialInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to revoke session.";
  }
}

export class OtherSessionsRevocationError extends Schema.TaggedError<OtherSessionsRevocationError>()(
  "OtherSessionsRevocationError",
  {
    currentSessionId: AuthSessionId,
    ...sessionCredentialInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to revoke other sessions.";
  }
}

export const SessionCredentialInternalError = Schema.Union([
  SessionClaimsEncodingError,
  SessionCredentialIssueError,
  SessionCredentialVerificationError,
  WebSocketTokenIssueError,
  WebSocketTokenVerificationError,
  ActiveSessionsListError,
  SessionRevocationError,
  OtherSessionsRevocationError,
]);
export type SessionCredentialInternalError = typeof SessionCredentialInternalError.Type;

export const SessionCredentialError = Schema.Union([
  SessionCredentialInvalidError,
  SessionCredentialInternalError,
]);
export type SessionCredentialError = typeof SessionCredentialError.Type;

export class WorkerGrantRenewalError extends Schema.TaggedError<WorkerGrantRenewalError>()(
  "WorkerGrantRenewalError",
  { code: Schema.Literals(["grant_invalid", "grant_missing", "grant_revoked"]) },
) {
  override get message(): string {
    return "The original worker grant cannot be renewed.";
  }
}

export class SessionStore extends Context.Service<
  SessionStore,
  {
    readonly cookieName: string;
    readonly legacyCookieName: string | undefined;
    /**
     * A session cookie this server issued under an earlier name: the legacy
     * remote name, or a loopback name from before the state directory moved.
     */
    readonly findLegacyCookie: (
      cookies: Readonly<Record<string, string | undefined>>,
    ) => LegacySessionCookie | undefined;
    readonly issue: (input?: {
      readonly ttl?: Duration.Duration;
      readonly subject?: string;
      readonly method?: ServerAuthSessionMethod;
      readonly scopes?: ReadonlyArray<AuthEnvironmentScope>;
      readonly client?: AuthClientMetadata;
      readonly proofKeyThumbprint?: string;
      readonly runtimeModeCeiling?: RuntimeMode;
      /**
       * Atomically revoke active sessions with the same subject and method
       * before storing this session.
       */
      readonly replaceActiveForSubjectAndMethod?: boolean;
      /** Replace only this session, of the same method, in the issuance transaction. */
      readonly replaceSessionId?: AuthSessionId;
    }) => Effect.Effect<IssuedSession, SessionCredentialInternalError>;
    readonly renewWorkerGrant: (
      input: AuthWorkerGrantRenewalRequest,
    ) => Effect.Effect<
      AuthWorkerGrantRenewalResult,
      WorkerGrantRenewalError | SessionCredentialInternalError
    >;
    readonly verify: (token: string) => Effect.Effect<VerifiedSession, SessionCredentialError>;
    readonly issueWebSocketToken: (
      sessionId: AuthSessionId,
      input?: {
        readonly ttl?: Duration.Duration;
      },
    ) => Effect.Effect<
      {
        readonly token: string;
        readonly expiresAt: DateTime.DateTime;
      },
      SessionCredentialInternalError
    >;
    readonly verifyWebSocketToken: (
      token: string,
    ) => Effect.Effect<VerifiedSession, SessionCredentialError>;
    readonly listActive: () => Effect.Effect<
      ReadonlyArray<AuthClientSession>,
      SessionCredentialInternalError
    >;
    readonly streamChanges: Stream.Stream<SessionCredentialChange>;
    /**
     * Watches one session for the end of its validity: a revocation, including
     * replacement by a newer session, and `expiresAt` when one is given. A
     * revoke made by this process ends the watch at once; one made by another
     * process on the same database within 30 seconds. The watch is live once
     * this returns, for the life of the current scope; the returned effect
     * completes when the session ends, or at once when it already has.
     */
    readonly watchEnd: (session: {
      readonly sessionId: AuthSessionId;
      readonly expiresAt?: DateTime.DateTime | undefined;
    }) => Effect.Effect<Effect.Effect<void>, never, Scope.Scope>;
    readonly revoke: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<boolean, SessionCredentialInternalError>;
    readonly revokeAllExcept: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<number, SessionCredentialInternalError>;
    readonly markConnected: (sessionId: AuthSessionId) => Effect.Effect<void, never>;
    readonly markDisconnected: (sessionId: AuthSessionId) => Effect.Effect<void, never>;
    readonly recordClientConnection: (
      sessionId: AuthSessionId,
      client: {
        readonly surface?: ClientSurface | undefined;
        readonly appVersion?: string | undefined;
      },
    ) => Effect.Effect<void, never>;
  }
>()("specweave-studio/auth/SessionStore") {}

const SIGNING_SECRET_NAME = "server-signing-key";
const DEFAULT_SESSION_TTL = Duration.days(30);
/** How often a watched session's row is read again, for revokes made by another process. */
const SESSION_WATCH_RECHECK_INTERVAL = Duration.seconds(30);
const DEFAULT_WEBSOCKET_TOKEN_TTL = Duration.minutes(5);

const SessionClaims = Schema.Struct({
  v: Schema.Literals([1, 2]),
  kind: Schema.Literal("session"),
  sid: AuthSessionId,
  sub: Schema.String,
  scopes: AuthEnvironmentScopes,
  method: Schema.Literals(["browser-session-cookie", "bearer-access-token", "dpop-access-token"]),
  jkt: Schema.optionalKey(Schema.String),
  rtc: Schema.optionalKey(RuntimeMode),
  iat: Schema.Number,
  exp: Schema.Number,
});
type SessionClaims = typeof SessionClaims.Type;

const WebSocketClaims = Schema.Struct({
  v: Schema.Literal(1),
  kind: Schema.Literal("websocket"),
  sid: AuthSessionId,
  iat: Schema.Number,
  exp: Schema.Number,
});
type WebSocketClaims = typeof WebSocketClaims.Type;

const decodeSessionClaims = Schema.decodeUnknownEffect(Schema.fromJsonString(SessionClaims));
const decodeWebSocketClaims = Schema.decodeUnknownEffect(Schema.fromJsonString(WebSocketClaims));

function createDefaultClientMetadata(): AuthClientMetadata {
  return {
    deviceType: "unknown",
  };
}

function toClientMetadata(record: {
  readonly label: string | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly deviceType: AuthClientMetadata["deviceType"];
  readonly os: string | null;
  readonly browser: string | null;
}): AuthClientMetadata {
  return {
    ...(record.label ? { label: record.label } : {}),
    ...(record.ipAddress ? { ipAddress: record.ipAddress } : {}),
    ...(record.userAgent ? { userAgent: record.userAgent } : {}),
    deviceType: record.deviceType,
    ...(record.os ? { os: record.os } : {}),
    ...(record.browser ? { browser: record.browser } : {}),
  };
}

function toAuthClientSession(input: Omit<AuthClientSession, "current">): AuthClientSession {
  return {
    ...input,
    current: false,
  };
}

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const authSessions = yield* AuthSessions.AuthSessionRepository;
  const signingSecret = yield* secretStore.getOrCreateRandom(SIGNING_SECRET_NAME, 32);
  const connectedSessionsRef = yield* Ref.make(new Map<AuthSessionId, number>());
  const changesPubSub = yield* PubSub.unbounded<SessionCredentialChange>();
  const credentialChangesLock = yield* Semaphore.make(1);
  const cookieInput = {
    mode: serverConfig.mode,
    port: serverConfig.port,
    host: serverConfig.host,
    instanceKey: serverConfig.stateDir,
    environmentId: yield* serverEnvironment.getEnvironmentId,
    development: serverConfig.devUrl !== undefined,
  } as const;
  const cookieName = resolveSessionCookieName(cookieInput);
  const legacyCookieName = resolveLegacySessionCookieName(cookieInput);
  const movedCookiePrefix = resolveMovedSessionCookiePrefix(cookieInput);
  const findLegacyCookie = (
    cookies: Readonly<Record<string, string | undefined>>,
  ): LegacySessionCookie | undefined => {
    if (legacyCookieName !== undefined) {
      const token = cookies[legacyCookieName];
      return token === undefined ? undefined : { name: legacyCookieName, token };
    }
    if (movedCookiePrefix === undefined) return undefined;
    for (const [name, token] of Object.entries(cookies)) {
      if (name === cookieName || !name.startsWith(movedCookiePrefix) || !token) continue;
      const [encodedPayload, signature, extra] = token.split(".");
      if (!encodedPayload || !signature || extra !== undefined) continue;
      if (timingSafeEqualBase64Url(signature, signPayload(encodedPayload, signingSecret))) {
        return { name, token };
      }
    }
    return undefined;
  };
  const devAuth = resolveReusableDevAuth(serverConfig);
  if (devAuth) {
    yield* authSessions
      .createIfAbsent({
        sessionId: devAuth.sessionId,
        subject: "reusable-dev-token",
        scopes: AuthAdministrativeScopes,
        method: "browser-session-cookie",
        client: {
          label: "Reusable dev token",
          ipAddress: null,
          userAgent: null,
          deviceType: "unknown",
          os: null,
          browser: null,
        },
        issuedAt: yield* DateTime.now,
        expiresAt: REUSABLE_DEV_SESSION_EXPIRES_AT,
      })
      .pipe(
        Effect.mapError(
          (cause) => new SessionCredentialIssueError({ sessionId: devAuth.sessionId, cause }),
        ),
      );
  }

  const emitUpsert = (clientSession: AuthClientSession) =>
    PubSub.publish(changesPubSub, {
      type: "clientUpserted",
      clientSession,
    }).pipe(Effect.asVoid);

  const publishRemoved = (sessionId: AuthSessionId) =>
    PubSub.publish(changesPubSub, {
      type: "clientRemoved",
      sessionId,
    }).pipe(Effect.asVoid);

  // A revoke may commit while renewal is reloading a row. Its removal event
  // must follow that reload's publication, so a stale snapshot cannot win.
  const emitRemoved = (sessionId: AuthSessionId) =>
    credentialChangesLock.withPermits(1)(publishRemoved(sessionId));

  const loadActiveSession = (sessionId: AuthSessionId) =>
    Effect.gen(function* () {
      const row = yield* authSessions.getById({ sessionId });
      if (Option.isNone(row) || row.value.revokedAt !== null) {
        return Option.none<AuthClientSession>();
      }

      const connectedSessions = yield* Ref.get(connectedSessionsRef);
      const connected = connectedSessions.has(row.value.sessionId);
      const now = yield* DateTime.now;
      if (!connected && row.value.expiresAt.epochMilliseconds <= now.epochMilliseconds) {
        return Option.none<AuthClientSession>();
      }
      return Option.some(
        toAuthClientSession({
          sessionId: row.value.sessionId,
          subject: row.value.subject,
          scopes: row.value.scopes,
          method: row.value.method,
          client: toClientMetadata(row.value.client),
          issuedAt: row.value.issuedAt,
          expiresAt: row.value.expiresAt,
          lastConnectedAt: row.value.lastConnectedAt,
          connected,
        }),
      );
    });

  const markConnected: SessionStore["Service"]["markConnected"] = (sessionId) =>
    Ref.modify(connectedSessionsRef, (current) => {
      const next = new Map(current);
      const wasDisconnected = !next.has(sessionId);
      next.set(sessionId, (next.get(sessionId) ?? 0) + 1);
      return [wasDisconnected, next] as const;
    }).pipe(
      Effect.flatMap((wasDisconnected) =>
        wasDisconnected
          ? DateTime.now.pipe(
              Effect.flatMap((lastConnectedAt) =>
                authSessions.setLastConnectedAt({
                  sessionId,
                  lastConnectedAt,
                }),
              ),
            )
          : Effect.void,
      ),
      Effect.flatMap(() => loadActiveSession(sessionId)),
      Effect.flatMap((session) =>
        Option.isSome(session) ? emitUpsert(session.value) : Effect.void,
      ),
      Effect.catchCause((cause) =>
        Effect.logError("Failed to publish connected-session auth update.").pipe(
          Effect.annotateLogs({
            sessionId,
            cause,
          }),
        ),
      ),
      Effect.withSpan("SessionStore.markConnected"),
    );

  // Best-effort: connection metadata must never block or fail a connect.
  const recordClientConnection: SessionStore["Service"]["recordClientConnection"] = (
    sessionId,
    client,
  ) =>
    client.surface === undefined && client.appVersion === undefined
      ? Effect.void
      : authSessions
          .setClientConnection({
            sessionId,
            surface: client.surface ?? null,
            appVersion: client.appVersion ?? null,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to record session client connection metadata.").pipe(
                Effect.annotateLogs({ sessionId, cause }),
              ),
            ),
            Effect.withSpan("SessionStore.recordClientConnection"),
          );

  const markDisconnected: SessionStore["Service"]["markDisconnected"] = (sessionId) =>
    Ref.update(connectedSessionsRef, (current) => {
      const next = new Map(current);
      const remaining = (next.get(sessionId) ?? 0) - 1;
      if (remaining > 0) {
        next.set(sessionId, remaining);
      } else {
        next.delete(sessionId);
      }
      return next;
    }).pipe(
      Effect.flatMap(() => loadActiveSession(sessionId)),
      Effect.flatMap((session) =>
        Option.isSome(session) ? emitUpsert(session.value) : emitRemoved(sessionId),
      ),
      Effect.catchCause((cause) =>
        Effect.logError("Failed to publish disconnected-session auth update.").pipe(
          Effect.annotateLogs({
            sessionId,
            cause,
          }),
        ),
      ),
      Effect.withSpan("SessionStore.markDisconnected"),
    );

  const encodeClaims = Schema.encodeEffect(Schema.fromJsonString(SessionClaims));
  const issue: SessionStore["Service"]["issue"] = Effect.fn("SessionStore.issue")(
    function* (input) {
      const sessionId = AuthSessionId.make(
        yield* crypto.randomUUIDv4.pipe(
          Effect.mapError((cause) => new SessionCredentialIssueError({ cause })),
        ),
      );
      const issuedAt = yield* DateTime.now;
      const expiresAt = DateTime.add(issuedAt, {
        milliseconds: Duration.toMillis(input?.ttl ?? DEFAULT_SESSION_TTL),
      });
      const claims: SessionClaims = {
        v: 1,
        kind: "session",
        sid: sessionId,
        sub: input?.subject ?? "browser",
        scopes: input?.scopes ?? AuthStandardClientScopes,
        method: input?.method ?? "browser-session-cookie",
        ...(input?.proofKeyThumbprint ? { jkt: input.proofKeyThumbprint } : {}),
        ...(input?.runtimeModeCeiling ? { rtc: input.runtimeModeCeiling } : {}),
        iat: issuedAt.epochMilliseconds,
        exp: expiresAt.epochMilliseconds,
      };

      const encodedPayload = yield* encodeClaims(claims).pipe(
        Effect.map(base64UrlEncode),
        Effect.mapError(
          (cause) =>
            new SessionCredentialIssueError({
              sessionId,
              cause: new SessionClaimsEncodingError({
                sessionId,
                operation: "encode_session_claims",
                cause,
              }),
            }),
        ),
      );
      const signature = signPayload(encodedPayload, signingSecret);
      const client = input?.client ?? createDefaultClientMetadata();
      const sessionRecord = {
        sessionId,
        subject: claims.sub,
        scopes: claims.scopes,
        method: claims.method,
        client: {
          label: client.label ?? null,
          ipAddress: client.ipAddress ?? null,
          userAgent: client.userAgent ?? null,
          deviceType: client.deviceType,
          os: client.os ?? null,
          browser: client.browser ?? null,
        },
        issuedAt,
        expiresAt,
      } satisfies AuthSessions.CreateAuthSessionInput;
      const replacedSessionIds = yield* (
        input?.replaceSessionId !== undefined || input?.replaceActiveForSubjectAndMethod
          ? authSessions.createReplacingActive({
              session: sessionRecord,
              revokedAt: issuedAt,
              ...(input.replaceSessionId !== undefined
                ? { replaceSessionId: input.replaceSessionId }
                : {}),
            })
          : authSessions.create(sessionRecord).pipe(Effect.as([] as ReadonlyArray<AuthSessionId>))
      ).pipe(Effect.mapError((cause) => new SessionCredentialIssueError({ sessionId, cause })));
      if (replacedSessionIds.length > 0) {
        yield* Ref.update(connectedSessionsRef, (current) => {
          const next = new Map(current);
          for (const replacedSessionId of replacedSessionIds) {
            next.delete(replacedSessionId);
          }
          return next;
        });
        yield* Effect.forEach(replacedSessionIds, emitRemoved, {
          concurrency: "unbounded",
          discard: true,
        });
      }
      yield* emitUpsert(
        toAuthClientSession({
          sessionId,
          subject: claims.sub,
          scopes: claims.scopes,
          method: claims.method,
          client,
          issuedAt,
          expiresAt,
          lastConnectedAt: null,
          connected: false,
        }),
      );

      return {
        sessionId,
        token: `${encodedPayload}.${signature}`,
        method: claims.method,
        client,
        expiresAt: expiresAt,
        scopes: claims.scopes,
        ...(claims.jkt ? { proofKeyThumbprint: claims.jkt } : {}),
      } satisfies IssuedSession;
    },
  );

  const verify: SessionStore["Service"]["verify"] = Effect.fn("SessionStore.verify")(
    function* (token) {
      if (devAuth?.matches(token)) {
        const row = yield* authSessions
          .getById({ sessionId: devAuth.sessionId })
          .pipe(
            Effect.mapError(
              (cause) =>
                new SessionCredentialVerificationError({ sessionId: devAuth.sessionId, cause }),
            ),
          );
        if (Option.isNone(row)) {
          return yield* new UnknownSessionTokenError({ sessionId: devAuth.sessionId });
        }
        if (row.value.revokedAt !== null) {
          return yield* new SessionTokenRevokedError({
            sessionId: devAuth.sessionId,
            revokedAt: row.value.revokedAt,
          });
        }
        const observedAt = yield* DateTime.now;
        if (row.value.expiresAt.epochMilliseconds <= observedAt.epochMilliseconds) {
          return yield* new SessionTokenExpiredError({
            sessionId: devAuth.sessionId,
            expiresAt: row.value.expiresAt,
            observedAt,
          });
        }
        return {
          sessionId: row.value.sessionId,
          token,
          method: row.value.method,
          client: toClientMetadata(row.value.client),
          expiresAt: row.value.expiresAt,
          subject: row.value.subject,
          scopes: row.value.scopes,
        } satisfies VerifiedSession;
      }
      const [encodedPayload, signature] = token.split(".");
      if (!encodedPayload || !signature) {
        return yield* new MalformedSessionTokenError({});
      }

      const expectedSignature = signPayload(encodedPayload, signingSecret);
      if (!timingSafeEqualBase64Url(signature, expectedSignature)) {
        return yield* new InvalidSessionTokenSignatureError({});
      }

      const claims = yield* decodeSessionClaims(base64UrlDecodeUtf8(encodedPayload)).pipe(
        Effect.mapError((cause) => new InvalidSessionTokenPayloadError({ cause })),
      );

      const observedAt = yield* DateTime.now;
      const expiresAt = DateTime.make(claims.exp);
      if (Option.isNone(expiresAt)) {
        return yield* new InvalidSessionExpirationClaimError({
          sessionId: claims.sid,
          expirationClaim: claims.exp,
        });
      }
      if (claims.exp <= observedAt.epochMilliseconds) {
        return yield* new SessionTokenExpiredError({
          sessionId: claims.sid,
          expiresAt: expiresAt.value,
          observedAt,
        });
      }

      const row = yield* authSessions
        .getById({ sessionId: claims.sid })
        .pipe(
          Effect.mapError(
            (cause) => new SessionCredentialVerificationError({ sessionId: claims.sid, cause }),
          ),
        );
      if (Option.isNone(row)) {
        return yield* new UnknownSessionTokenError({ sessionId: claims.sid });
      }
      if (row.value.revokedAt !== null) {
        return yield* new SessionTokenRevokedError({
          sessionId: claims.sid,
          revokedAt: row.value.revokedAt,
        });
      }

      return {
        sessionId: claims.sid,
        token,
        method: claims.method,
        client: toClientMetadata(row.value.client),
        expiresAt: expiresAt.value,
        subject: claims.sub,
        scopes: claims.scopes,
        ...(claims.jkt ? { proofKeyThumbprint: claims.jkt } : {}),
        ...(claims.rtc ? { runtimeModeCeiling: claims.rtc } : {}),
      } satisfies VerifiedSession;
    },
  );

  // This path accepts expiry only for renewal. Normal verify() remains strict.
  const renewWorkerGrant: SessionStore["Service"]["renewWorkerGrant"] = Effect.fn(
    "SessionStore.renewWorkerGrant",
  )(function* (input) {
    const invalid = () => new WorkerGrantRenewalError({ code: "grant_invalid" });
    const label = `SpecWithCode workers · ${input.coordinatorEnvironmentId}`;
    if (input.environmentId !== cookieInput.environmentId || label.length > 100) {
      return yield* invalid();
    }
    const [payload, signature, extra] = input.accessToken.split(".");
    if (
      !payload ||
      !signature ||
      extra !== undefined ||
      !timingSafeEqualBase64Url(signature, signPayload(payload, signingSecret))
    ) {
      return yield* invalid();
    }
    const claims = yield* decodeSessionClaims(base64UrlDecodeUtf8(payload)).pipe(
      Effect.mapError(invalid),
    );
    const issuedAt = DateTime.make(claims.iat);
    if (
      claims.sub !== "mcp-client" ||
      claims.method !== "bearer-access-token" ||
      claims.jkt !== undefined ||
      claims.rtc === undefined ||
      claims.scopes.length !== 2 ||
      !claims.scopes.includes(AuthOrchestrationReadScope) ||
      !claims.scopes.includes(AuthOrchestrationOperateScope) ||
      !Number.isFinite(claims.iat) ||
      !Number.isFinite(claims.exp) ||
      Option.isNone(issuedAt) ||
      Option.isNone(DateTime.make(claims.exp)) ||
      claims.exp <= claims.iat
    ) {
      return yield* invalid();
    }
    const getOriginal = () =>
      authSessions.getById({ sessionId: claims.sid }).pipe(
        Effect.mapError(
          (cause) => new SessionCredentialVerificationError({ sessionId: claims.sid, cause }),
        ),
        Effect.flatMap((row) =>
          Option.isNone(row)
            ? Effect.fail(new WorkerGrantRenewalError({ code: "grant_missing" }))
            : row.value.revokedAt !== null
              ? Effect.fail(new WorkerGrantRenewalError({ code: "grant_revoked" }))
              : Effect.succeed(row.value),
        ),
      );
    const original = yield* getOriginal();
    if (
      original.subject !== claims.sub ||
      original.method !== claims.method ||
      original.client.label !== label ||
      original.issuedAt.epochMilliseconds !== claims.iat ||
      original.scopes.length !== claims.scopes.length ||
      original.scopes.some((scope, index) => scope !== claims.scopes[index])
    ) {
      return yield* invalid();
    }
    const now = yield* DateTime.now;
    const expiresAt = DateTime.toUtc(
      DateTime.add(now, { milliseconds: Duration.toMillis(DEFAULT_SESSION_TTL) }),
    );
    const encodedPayload = yield* encodeClaims({
      ...claims,
      exp: expiresAt.epochMilliseconds,
    }).pipe(
      Effect.map(base64UrlEncode),
      Effect.mapError((cause) => new SessionCredentialIssueError({ sessionId: claims.sid, cause })),
    );
    // One conditional UPDATE serializes against revoke: never insert, replace or clear a tombstone.
    const renewed = yield* authSessions
      .renewWorker({
        sessionId: claims.sid,
        subject: "mcp-client",
        method: "bearer-access-token",
        scopes: claims.scopes,
        label,
        issuedAt: DateTime.toUtc(issuedAt.value),
        expiresAt,
      })
      .pipe(
        Effect.mapError(
          (cause) => new SessionCredentialIssueError({ sessionId: claims.sid, cause }),
        ),
      );
    if (!renewed) {
      yield* getOriginal();
      return yield* invalid();
    }
    yield* credentialChangesLock.withPermits(1)(
      loadActiveSession(claims.sid).pipe(
        Effect.mapError(
          (cause) => new SessionCredentialVerificationError({ sessionId: claims.sid, cause }),
        ),
        Effect.flatMap((active) =>
          Option.isSome(active) ? emitUpsert(active.value) : publishRemoved(claims.sid),
        ),
      ),
    );
    return {
      accessToken: `${encodedPayload}.${signPayload(encodedPayload, signingSecret)}`,
      expiresAt,
    };
  });

  const encodeWsClaims = Schema.encodeEffect(Schema.fromJsonString(WebSocketClaims));
  const issueWebSocketToken: SessionStore["Service"]["issueWebSocketToken"] = Effect.fn(
    "SessionStore.issueWebSocketToken",
  )(function* (sessionId, input) {
    const issuedAt = yield* DateTime.now;
    const expiresAt = DateTime.add(issuedAt, {
      milliseconds: Duration.toMillis(input?.ttl ?? DEFAULT_WEBSOCKET_TOKEN_TTL),
    });
    const claims: WebSocketClaims = {
      v: 1,
      kind: "websocket",
      sid: sessionId,
      iat: issuedAt.epochMilliseconds,
      exp: expiresAt.epochMilliseconds,
    };
    const encodedPayload = yield* encodeWsClaims(claims).pipe(
      Effect.map(base64UrlEncode),
      Effect.mapError(
        (cause) =>
          new WebSocketTokenIssueError({
            sessionId,
            cause: new SessionClaimsEncodingError({
              sessionId,
              operation: "encode_websocket_claims",
              cause,
            }),
          }),
      ),
    );
    const signature = signPayload(encodedPayload, signingSecret);
    return {
      token: `${encodedPayload}.${signature}`,
      expiresAt,
    };
  });

  const verifyWebSocketToken: SessionStore["Service"]["verifyWebSocketToken"] = Effect.fn(
    "SessionStore.verifyWebSocketToken",
  )(function* (token) {
    const [encodedPayload, signature] = token.split(".");
    if (!encodedPayload || !signature) {
      return yield* new MalformedWebSocketTokenError({});
    }

    const expectedSignature = signPayload(encodedPayload, signingSecret);
    if (!timingSafeEqualBase64Url(signature, expectedSignature)) {
      return yield* new InvalidWebSocketTokenSignatureError({});
    }

    const claims = yield* decodeWebSocketClaims(base64UrlDecodeUtf8(encodedPayload)).pipe(
      Effect.mapError((cause) => new InvalidWebSocketTokenPayloadError({ cause })),
    );
    if (claims.sid.startsWith(REUSABLE_DEV_SESSION_PREFIX) && claims.sid !== devAuth?.sessionId) {
      return yield* new UnknownWebSocketSessionError({ sessionId: claims.sid });
    }

    const observedAt = yield* DateTime.now;
    const expiresAt = DateTime.make(claims.exp);
    if (Option.isNone(expiresAt)) {
      return yield* new InvalidSessionExpirationClaimError({
        sessionId: claims.sid,
        expirationClaim: claims.exp,
      });
    }
    if (claims.exp <= observedAt.epochMilliseconds) {
      return yield* new WebSocketTokenExpiredError({
        sessionId: claims.sid,
        expiresAt: expiresAt.value,
        observedAt,
      });
    }

    const row = yield* authSessions
      .getById({ sessionId: claims.sid })
      .pipe(
        Effect.mapError(
          (cause) => new WebSocketTokenVerificationError({ sessionId: claims.sid, cause }),
        ),
      );
    if (Option.isNone(row)) {
      return yield* new UnknownWebSocketSessionError({ sessionId: claims.sid });
    }
    if (row.value.expiresAt.epochMilliseconds <= observedAt.epochMilliseconds) {
      return yield* new WebSocketSessionExpiredError({
        sessionId: claims.sid,
        expiresAt: row.value.expiresAt,
        observedAt,
      });
    }
    if (row.value.revokedAt !== null) {
      return yield* new WebSocketSessionRevokedError({
        sessionId: claims.sid,
        revokedAt: row.value.revokedAt,
      });
    }

    return {
      sessionId: row.value.sessionId,
      token,
      method: row.value.method,
      client: toClientMetadata(row.value.client),
      expiresAt: row.value.expiresAt,
      subject: row.value.subject,
      scopes: row.value.scopes,
    } satisfies VerifiedSession;
  });

  const listActive: SessionStore["Service"]["listActive"] = Effect.fn("SessionStore.listActive")(
    function* () {
      const now = yield* DateTime.now;
      const connectedSessions = yield* Ref.get(connectedSessionsRef);
      const rows = yield* authSessions.listActive({
        now,
        connectedSessionIds: Array.from(connectedSessions.keys()),
      });

      return rows.map((row) =>
        toAuthClientSession({
          sessionId: row.sessionId,
          subject: row.subject,
          scopes: row.scopes,
          method: row.method,
          client: toClientMetadata(row.client),
          issuedAt: row.issuedAt,
          expiresAt: row.expiresAt,
          lastConnectedAt: row.lastConnectedAt,
          connected: connectedSessions.has(row.sessionId),
        }),
      );
    },
    Effect.mapError((cause) => new ActiveSessionsListError({ cause })),
  );

  const watchEnd: SessionStore["Service"]["watchEnd"] = Effect.fn("SessionStore.watchEnd")(
    function* (session) {
      // Subscribe before reading the row, so a revoke that commits after the
      // read still reaches this watch.
      const changes = yield* PubSub.subscribe(changesPubSub);
      const isActive = authSessions.getById({ sessionId: session.sessionId }).pipe(
        Effect.map((row) => Option.isSome(row) && row.value.revokedAt === null),
        // An unreadable row is not proof of revocation; keep watching.
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not confirm a watched session is still active.").pipe(
            Effect.annotateLogs({ sessionId: session.sessionId, cause }),
            Effect.as(true),
          ),
        ),
      );
      // `clientRemoved` also follows the last disconnect of an expired token
      // session that is still valid for its open sockets, so only a row that
      // is gone or revoked ends the watch.
      const removedHere = Effect.gen(function* () {
        while (true) {
          const change = yield* PubSub.take(changes);
          if (
            change.type === "clientRemoved" &&
            change.sessionId === session.sessionId &&
            !(yield* isActive)
          ) {
            return;
          }
        }
      });
      // Another process (the CLI's `auth session revoke`) publishes to its
      // own change stream, so the row is read again on an interval.
      const removedElsewhere = Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep(SESSION_WATCH_RECHECK_INTERVAL);
          if (!(yield* isActive)) return;
        }
      });
      const expiresAt = session.expiresAt;
      const expired =
        expiresAt === undefined
          ? Effect.never
          : DateTime.now.pipe(
              Effect.flatMap((now) =>
                Effect.sleep(
                  Duration.millis(Math.max(0, expiresAt.epochMilliseconds - now.epochMilliseconds)),
                ),
              ),
            );
      const active = yield* isActive;
      const ended = active
        ? Effect.raceAllFirst([removedHere, removedElsewhere, expired])
        : Effect.void;
      // @effect-diagnostics-next-line returnEffectInGen:off -- the caller awaits this effect for the socket's life
      return ended;
    },
  );

  const revoke: SessionStore["Service"]["revoke"] = Effect.fn("SessionStore.revoke")(
    function* (sessionId) {
      const revokedAt = yield* DateTime.now;
      const revoked = yield* authSessions
        .revoke({
          sessionId,
          revokedAt,
        })
        .pipe(Effect.mapError((cause) => new SessionRevocationError({ sessionId, cause })));
      if (revoked) {
        yield* Ref.update(connectedSessionsRef, (current) => {
          const next = new Map(current);
          next.delete(sessionId);
          return next;
        });
        yield* emitRemoved(sessionId);
      }
      return revoked;
    },
  );

  const revokeAllExcept: SessionStore["Service"]["revokeAllExcept"] = Effect.fn(
    "SessionStore.revokeAllExcept",
  )(function* (sessionId) {
    const revokedAt = yield* DateTime.now;
    const revokedSessionIds = yield* authSessions
      .revokeAllExcept({
        currentSessionId: sessionId,
        revokedAt,
      })
      .pipe(
        Effect.mapError(
          (cause) => new OtherSessionsRevocationError({ currentSessionId: sessionId, cause }),
        ),
      );
    if (revokedSessionIds.length > 0) {
      yield* Ref.update(connectedSessionsRef, (current) => {
        const next = new Map(current);
        for (const revokedSessionId of revokedSessionIds) {
          next.delete(revokedSessionId);
        }
        return next;
      });
      yield* Effect.forEach(
        revokedSessionIds,
        (revokedSessionId) => emitRemoved(revokedSessionId),
        {
          concurrency: "unbounded",
          discard: true,
        },
      );
    }
    return revokedSessionIds.length;
  });

  return SessionStore.of({
    cookieName,
    legacyCookieName,
    findLegacyCookie,
    issue,
    verify,
    renewWorkerGrant,
    issueWebSocketToken,
    verifyWebSocketToken,
    listActive,
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
    watchEnd,
    revoke,
    revokeAllExcept,
    markConnected,
    markDisconnected,
    recordClientConnection,
  });
});

export const layer = Layer.effect(SessionStore, make).pipe(Layer.provideMerge(AuthSessions.layer));
