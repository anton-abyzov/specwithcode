/**
 * Slows down guessing at credentials. A SpecWithCode Connect address is
 * reachable from the internet, so every place that checks a presented
 * credential counts the failures per client and refuses that client for a
 * while once it has failed too often.
 *
 * Clients are told apart by Cloudflare's `cf-connecting-ip` for requests that
 * came through the Connect tunnel (they all arrive from loopback), and by the
 * connection's peer address otherwise. Other loopback requests are not
 * limited: a process on this machine can read the credential store anyway,
 * and Tailscale Serve also forwards from loopback, so limiting it would only
 * lock the owner's own apps out after a burst of stale-token retries.
 *
 * State lives in memory: a restart clears it.
 */
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
  /** Counts one failed check for `key`; blocks it once the limit is reached. */
  readonly recordFailure: (key: string | null) => Effect.Effect<void>;
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
  // oldest is dropped first once the map is full.
  const entries = new Map<string, Entry>();

  const touch = (key: string, entry: Entry, now: number) => {
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
              const entry = entries.get(key);
              if (entry === undefined || entry.blockedUntil <= now) return Effect.void;
              return Effect.fail(
                new CredentialRateLimited({
                  retryAfterSeconds: Math.max(1, Math.ceil((entry.blockedUntil - now) / 1000)),
                }),
              );
            }),
          ),
    recordFailure: (key) =>
      key === null
        ? Effect.void
        : Clock.currentTimeMillis.pipe(
            Effect.map((now) => {
              const previous = entries.get(key);
              const entry: Entry =
                previous === undefined || now - previous.windowStart >= windowMs
                  ? { windowStart: now, failures: 0, blockedUntil: previous?.blockedUntil ?? 0 }
                  : previous;
              entry.failures += 1;
              if (entry.failures >= limit) {
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
  const tagged = error as { readonly _tag?: unknown; readonly cause?: unknown };
  if (tagged._tag !== "ServerAuthInvalidCredentialError") return false;
  const cause = tagged.cause as { readonly _tag?: unknown } | undefined;
  return !(typeof cause?._tag === "string" && GENUINE_BUT_STALE.has(cause._tag));
}

/** Gate `request`'s client, failing with `CredentialRateLimited` while it is blocked. */
export const gateRequest = (request: HttpServerRequest.HttpServerRequest) =>
  CredentialFailureLimiter.pipe(
    Effect.flatMap((limiter) => limiter.gate(credentialLimiterKey(request))),
  );

/** Count one failed credential check against `request`'s client. */
export const recordRequestFailure = (request: HttpServerRequest.HttpServerRequest) =>
  CredentialFailureLimiter.pipe(
    Effect.flatMap((limiter) => limiter.recordFailure(credentialLimiterKey(request))),
  );
