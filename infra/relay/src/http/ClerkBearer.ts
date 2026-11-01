/**
 * Clerk bearer verification for relay client requests and token exchange:
 * session JWTs against the pinned key or Clerk's JWKS, and opaque OAuth
 * tokens (the headless CLI) through Clerk's Backend API.
 */
import { createClerkClient, verifyToken } from "@clerk/backend";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as RelayConfiguration from "../Config.ts";

export class ClerkTokenVerificationFailed extends Schema.TaggedError<ClerkTokenVerificationFailed>()(
  "ClerkTokenVerificationFailed",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Clerk token verification failed";
  }
}

function safeAuthFailureReason(value: string): string {
  return /^[a-z0-9._-]+$/i.test(value) ? value : "unknown";
}

export function clerkVerificationFailureReason(cause: unknown): string {
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

export function hasExpectedClerkAudience(audience: unknown, expectedAudience: string): boolean {
  return typeof audience === "string"
    ? audience === expectedAudience
    : Array.isArray(audience) &&
        audience.some((entry) => typeof entry === "string" && entry === expectedAudience);
}

export function verifyClerkBearerToken(
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

/** The Clerk session id (`sid`) of a verified session JWT, when it has one. */
export function clerkSessionIdClaim(verified: object): { readonly sid?: string } {
  const sid = (verified as { readonly sid?: unknown }).sid;
  return typeof sid === "string" && sid.length > 0 ? { sid } : {};
}

/**
 * Verifies a Clerk session JWT or, failing that, a Clerk OAuth token. Only a
 * session JWT carries a Clerk session id (`sid`).
 */
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
        ? Effect.succeed({
            sub: verified.sub,
            ...clerkSessionIdClaim(verified),
            mode: "clerk_session_bearer" as const,
          })
        : Effect.fail(new ClerkTokenVerificationFailed({ cause: "missing_relay_audience" })),
    ),
    Effect.catch(() => verifyOAuth),
  );
}
