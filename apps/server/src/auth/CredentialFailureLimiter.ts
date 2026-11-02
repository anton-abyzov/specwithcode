/**
 * Slows down guessing at credentials. A SpecWithCode Connect address is
 * reachable from the internet, so every place that checks a presented
 * credential counts the failures per client and refuses that client for a
 * while once it has failed too often.
 *
 * Clients are told apart by Cloudflare's `cf-connecting-ip` for requests that
 * came through the Connect tunnel (they all arrive from loopback), and by the
 * connection's peer address otherwise. A request carrying a DPoP proof is
 * also told apart by its proof key, so one device behind a home address that
 * keeps presenting a refused credential does not lock out the others there;
 * all proof keys behind one address still share a higher ceiling, because a
 * guesser can mint a new key for every attempt. Other loopback requests are not
 * limited: a process on this machine can read the credential store anyway,
 * and Tailscale Serve also forwards from loopback, so limiting it would only
 * lock the owner's own apps out after a burst of stale-token retries.
 *
 * State lives in memory: a restart clears it.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off - a synchronous hash inside a pure key function.
import { createHash } from "node:crypto";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";

import { isManagedEndpointHost } from "../fleet/fleetOrigin.ts";
import { requestRemoteAddress } from "./utils.ts";

export const CREDENTIAL_FAILURE_WINDOW_MS = 10 * 60_000;
export const CREDENTIAL_FAILURE_LIMIT = 30;
export const CREDENTIAL_BLOCK_MS = 10 * 60_000;
export const CREDENTIAL_LIMITER_MAX_KEYS = 512;
/** Marks a bucket for one DPoP proof key behind an address. */
const PROOF_KEY_BUCKET_MARK = "#key:";
/** Failures all clients behind one address may share before it is blocked. */
export const CREDENTIAL_ADDRESS_FAILURE_LIMIT = CREDENTIAL_FAILURE_LIMIT * 10;

export class CredentialRateLimited extends Data.TaggedError("CredentialRateLimited")<{
  readonly retryAfterSeconds: number;
}> {
  override get message(): string {
    return "Too many failed credential checks from this client.";
  }
}

export interface CredentialFailureLimiterShape {
  /** Fails while `key` is blocked. A null key (an exempt client) always passes. */
  readonly gate: (key: string | null) => Effect.Effect<void, CredentialRateLimited>;
  /**
   * Counts one failed check for `key`; blocks it once the limit is reached.
   * `limit` overrides the limiter's own for this key.
   */
  readonly recordFailure: (key: string | null, limit?: number) => Effect.Effect<void>;
}

interface Entry {
  windowStart: number;
  failures: number;
  blockedUntil: number;
}

export function makeCredentialFailureLimiter(
  options: {
    readonly windowMs?: number;
    readonly limit?: number;
    readonly blockMs?: number;
    readonly maxKeys?: number;
  } = {},
): CredentialFailureLimiterShape {
  const windowMs = options.windowMs ?? CREDENTIAL_FAILURE_WINDOW_MS;
  const limit = options.limit ?? CREDENTIAL_FAILURE_LIMIT;
  const blockMs = options.blockMs ?? CREDENTIAL_BLOCK_MS;
  const maxKeys = options.maxKeys ?? CREDENTIAL_LIMITER_MAX_KEYS;
  // Insertion order is recency order: a touched key moves to the end, and the
  // oldest is dropped first once the map is full. Proof-key buckets live in a
  // map of their own: a guesser minting a key per attempt must not push its
  // address's buckets out and so reset them.
  const addressEntries = new Map<string, Entry>();
  const proofKeyEntries = new Map<string, Entry>();
  const mapFor = (key: string) =>
    key.includes(PROOF_KEY_BUCKET_MARK) ? proofKeyEntries : addressEntries;

  const touch = (key: string, entry: Entry, now: number) => {
    const entries = mapFor(key);
    entries.delete(key);
    entries.set(key, entry);
    while (entries.size > maxKeys) {
      // Drop the oldest key that is not blocked: evicting a blocked key would
      // let a client with many addresses unblock itself by flooding new ones.
      let victim: string | undefined;
      for (const [candidate, value] of entries) {
        if (candidate !== key && value.blockedUntil <= now) {
          victim = candidate;
          break;
        }
      }
      // Every other key is blocked: memory still stays bounded.
      victim ??= entries.keys().next().value;
      if (victim === undefined) break;
      entries.delete(victim);
    }
  };

  return {
    gate: (key) =>
      key === null
        ? Effect.void
        : Clock.currentTimeMillis.pipe(
            Effect.flatMap((now) => {
              const entry = mapFor(key).get(key);
              if (entry === undefined || entry.blockedUntil <= now) return Effect.void;
              return Effect.fail(
                new CredentialRateLimited({
                  retryAfterSeconds: Math.max(1, Math.ceil((entry.blockedUntil - now) / 1000)),
                }),
              );
            }),
          ),
    recordFailure: (key, keyLimit = limit) =>
      key === null
        ? Effect.void
        : Clock.currentTimeMillis.pipe(
            Effect.map((now) => {
              const previous = mapFor(key).get(key);
              const entry: Entry =
                previous === undefined || now - previous.windowStart >= windowMs
                  ? { windowStart: now, failures: 0, blockedUntil: previous?.blockedUntil ?? 0 }
                  : previous;
              entry.failures += 1;
              if (entry.failures >= keyLimit) {
                entry.blockedUntil = now + blockMs;
                entry.failures = 0;
                entry.windowStart = now;
              }
              touch(key, entry, now);
            }),
          ),
  };
}

/**
 * One limiter per process. The default value makes every server and test
 * layer limited without wiring; `layer` gives a server its own explicitly.
 */
export const CredentialFailureLimiter = Context.Reference<CredentialFailureLimiterShape>(
  "specweave-studio/auth/CredentialFailureLimiter",
  { defaultValue: () => makeCredentialFailureLimiter() },
);

export const layer = Layer.sync(CredentialFailureLimiter, () => makeCredentialFailureLimiter());

const LOOPBACK = /^(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|localhost)$/i;

/**
 * Whether a request came in through the SpecWithCode Connect tunnel: its Host
 * is a managed endpoint, or Cloudflare stamped it. A local process can fake
 * either, which only ever makes the server stricter with it.
 */
export function arrivedOverConnect(request: HttpServerRequest.HttpServerRequest): boolean {
  const host = request.headers.host?.trim().replace(/\.(?=$|:)/, "");
  return (
    isManagedEndpointHost(host) ||
    typeof request.headers["cf-connecting-ip"] === "string" ||
    typeof request.headers["cf-ray"] === "string"
  );
}

/** Groups an IPv6 address by its /64, which one client usually holds whole. */
function clientAddressKey(ip: string): string {
  const address = ip.toLowerCase();
  if (!address.includes(":") || address.includes(".")) return address;
  const [head = "", tail] = address.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === undefined || tail === "" ? [] : tail.split(":");
  const groups =
    tail === undefined
      ? left
      : [
          ...left,
          ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0"),
          ...right,
        ];
  return `${groups
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}

/**
 * The client a failure counts against, or null for an exempt local client.
 * Cloudflare's `cf-connecting-ip` is believed only from a loopback peer (the
 * tunnel connector): any other peer could set it to land in a fresh bucket on
 * every attempt, so it is counted by its own address.
 */
export function credentialLimiterKey(request: HttpServerRequest.HttpServerRequest): string | null {
  const peer = requestRemoteAddress(request);
  const loopbackPeer = peer !== undefined && LOOPBACK.test(peer);
  if (peer !== undefined && !loopbackPeer) return `peer:${clientAddressKey(peer)}`;
  if (arrivedOverConnect(request)) {
    const ip = request.headers["cf-connecting-ip"]?.trim();
    return `cf:${ip && ip.length > 0 && ip.length <= 64 ? clientAddressKey(ip) : "unknown"}`;
  }
  return loopbackPeer ? null : "peer:unknown";
}

/**
 * Failures that prove the client once held a genuine credential (signed by
 * this server, now expired or revoked, or a device that must be approved
 * again) are not guesses: an app retrying with a stale token must not lock
 * itself out. Everything else presented and refused counts.
 */
const GENUINE_BUT_STALE = new Set([
  "SessionTokenExpiredError",
  "SessionTokenRevokedError",
  "DeviceReapprovalRequiredError",
  "WebSocketTokenExpiredError",
  "WebSocketSessionExpiredError",
  "WebSocketSessionRevokedError",
]);

/** Whether a refused credential counts toward the client's failure budget. */
export function countsAsCredentialGuess(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const tagged = error as {
    readonly _tag?: unknown;
    readonly cause?: unknown;
    readonly teamRulesMessage?: unknown;
  };
  if (tagged._tag !== "ServerAuthInvalidCredentialError") return false;
  // A genuine credential a rule refuses: its address must not get locked out with it.
  if (tagged.teamRulesMessage !== undefined) return false;
  const cause = tagged.cause as { readonly _tag?: unknown } | undefined;
  return !(typeof cause?._tag === "string" && GENUINE_BUT_STALE.has(cause._tag));
}

/**
 * A short stable id for the public key in a DPoP proof's header, or null when
 * the header is not a readable proof. The proof is not verified here: a forged
 * key only lands its sender in a bucket of its own under the address ceiling.
 */
export function dpopProofKeyId(proof: string | undefined): string | null {
  const header = proof?.trim().split(".")[0];
  if (!header || header.length > 2048) return null;
  try {
    const jwk = (JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as { jwk?: unknown })
      .jwk as Record<string, unknown> | undefined;
    if (typeof jwk !== "object" || jwk === null) return null;
    const members = ["kty", "crv", "x", "y", "n", "e"].map((name) => String(jwk[name] ?? ""));
    if (!members[2] && !members[4]) return null;
    return createHash("sha256").update(members.join(".")).digest("base64url").slice(0, 22);
  } catch {
    return null;
  }
}

/**
 * The buckets a request's failures count against: its proof key behind its
 * address with the normal limit, or the address itself when no proof is
 * presented, plus the ceiling every client behind the address shares.
 */
export function credentialLimiterBuckets(
  request: HttpServerRequest.HttpServerRequest,
): ReadonlyArray<{ readonly key: string; readonly limit?: number }> {
  const address = credentialLimiterKey(request);
  if (address === null) return [];
  const proofKey = dpopProofKeyId(request.headers.dpop);
  const ceiling = { key: `${address}#all`, limit: CREDENTIAL_ADDRESS_FAILURE_LIMIT };
  if (proofKey === null) return [{ key: address }, ceiling];
  return [{ key: `${address}${PROOF_KEY_BUCKET_MARK}${proofKey}` }, ceiling];
}

/** Gate `request`'s client, failing with `CredentialRateLimited` while it is blocked. */
export const gateRequest = (request: HttpServerRequest.HttpServerRequest) =>
  CredentialFailureLimiter.pipe(
    Effect.flatMap((limiter) =>
      Effect.forEach(credentialLimiterBuckets(request), (bucket) => limiter.gate(bucket.key), {
        discard: true,
      }),
    ),
  );

/** Count one failed credential check against `request`'s client. */
export const recordRequestFailure = (request: HttpServerRequest.HttpServerRequest) =>
  CredentialFailureLimiter.pipe(
    Effect.flatMap((limiter) =>
      Effect.forEach(
        credentialLimiterBuckets(request),
        (bucket) => limiter.recordFailure(bucket.key, bucket.limit),
        { discard: true },
      ),
    ),
  );
