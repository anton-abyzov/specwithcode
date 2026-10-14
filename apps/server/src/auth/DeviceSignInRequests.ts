/**
 * In-memory store behind approve-a-device sign-in.
 *
 * A request lives a few minutes and holds no credential until a signed-in
 * client types its code. Nothing lists pending requests: the owner has to read
 * the code off the new device, so a stranger who starts a request has no
 * prompt to trick anyone into approving. Its poll token is kept only as a
 * SHA-256 hash and compared in constant time; an unknown id and a wrong token
 * look the same ("expired") to the caller. Pending requests are capped per
 * source and overall. A restart forgets every request, which only means the
 * asking device asks again.
 *
 * @module DeviceSignInRequests
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off - synchronous sign-in state uses native constant-time comparison, absent from Effect Crypto.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { DeviceSignInPollResult } from "@specweave-studio/contracts/deviceSignIn";

/** Same alphabet as pairing codes: no 0/O, 1/I/L. */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LENGTH = 6;

export const DEVICE_SIGN_IN_TTL_MS = 5 * 60_000;
export const DEVICE_SIGN_IN_POLL_INTERVAL_MS = 2_000;
export const DEVICE_SIGN_IN_MAX_PENDING = 20;
/** Per address, so one noisy device cannot lock everyone else out. */
export const DEVICE_SIGN_IN_MAX_PENDING_PER_SOURCE = 3;
/** How long an approved credential waits for the asking browser to collect it. */
export const DEVICE_SIGN_IN_APPROVED_TTL_MS = 2 * 60_000;

export interface DeviceSignInClientInfo {
  readonly deviceType: string;
  readonly browser: string | null;
  readonly os: string | null;
  readonly ipAddress: string | null;
  readonly origin: string | null;
  /** Who the per-source cap counts against: the client address. */
  readonly source: string;
}

type RequestState =
  | { readonly kind: "pending" }
  | { readonly kind: "approved"; readonly credential: string; readonly linkId: string };

interface StoredRequest extends DeviceSignInClientInfo {
  readonly requestId: string;
  readonly pollTokenHash: Buffer;
  readonly code: string;
  readonly createdAt: number;
  expiresAt: number;
  state: RequestState;
}

export type DeviceSignInStartOutcome =
  | {
      readonly ok: true;
      readonly requestId: string;
      readonly pollToken: string;
      readonly code: string;
      readonly expiresAt: number;
    }
  | { readonly ok: false; readonly reason: "too-many-pending" };

/** "abc-def", "ABC DEF" and "abcdef" all mean ABCDEF. */
export function normalizeDeviceSignInCode(code: string): string {
  return code.replace(/[\s-]/g, "").toUpperCase();
}

export interface DeviceSignInRequestsOptions {
  readonly now?: () => number;
  readonly random?: (size: number) => Buffer;
  readonly ttlMs?: number;
  readonly maxPending?: number;
  readonly maxPendingPerSource?: number;
}

const hashToken = (token: string) => createHash("sha256").update(token, "utf8").digest();

export class DeviceSignInRequests {
  readonly #requests = new Map<string, StoredRequest>();
  readonly #now: () => number;
  readonly #random: (size: number) => Buffer;
  readonly #ttlMs: number;
  readonly #maxPending: number;
  readonly #maxPendingPerSource: number;

  constructor(options: DeviceSignInRequestsOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? randomBytes;
    this.#ttlMs = options.ttlMs ?? DEVICE_SIGN_IN_TTL_MS;
    this.#maxPending = options.maxPending ?? DEVICE_SIGN_IN_MAX_PENDING;
    this.#maxPendingPerSource =
      options.maxPendingPerSource ?? DEVICE_SIGN_IN_MAX_PENDING_PER_SOURCE;
  }

  start(client: DeviceSignInClientInfo): DeviceSignInStartOutcome {
    this.#sweep();
    const pending = [...this.#requests.values()].filter(
      (request) => request.state.kind === "pending",
    );
    if (
      pending.length >= this.#maxPending ||
      pending.filter((request) => request.source === client.source).length >=
        this.#maxPendingPerSource
    )
      return { ok: false, reason: "too-many-pending" };
    const requestId = this.#random(18).toString("base64url");
    const pollToken = this.#random(32).toString("base64url");
    const taken = new Set(pending.map((request) => request.code));
    let code = this.#code();
    while (taken.has(code)) code = this.#code();
    const createdAt = this.#now();
    const expiresAt = createdAt + this.#ttlMs;
    this.#requests.set(requestId, {
      ...client,
      requestId,
      pollTokenHash: hashToken(pollToken),
      code,
      createdAt,
      expiresAt,
      state: { kind: "pending" },
    });
    return { ok: true, requestId, pollToken, code, expiresAt };
  }

  /**
   * What the asking browser learns. An approved credential is told once; the
   * request is gone afterwards.
   */
  poll(requestId: string, pollToken: string): DeviceSignInPollResult {
    this.#sweep();
    const request = this.#requests.get(requestId);
    if (!request || !this.#tokenMatches(request, pollToken)) return { status: "expired" };
    switch (request.state.kind) {
      case "pending":
        return { status: "pending" };
      case "approved":
        this.#requests.delete(requestId);
        return { status: "approved", credential: request.state.credential };
    }
  }

  /** The pending request whose code the owner typed, or null. */
  pendingByCode(
    code: string,
  ): (DeviceSignInClientInfo & { readonly requestId: string; readonly createdAt: number }) | null {
    this.#sweep();
    const wanted = normalizeDeviceSignInCode(code);
    for (const request of this.#requests.values()) {
      if (request.state.kind === "pending" && request.code === wanted) return request;
    }
    return null;
  }

  /**
   * Hand an issued one-time credential to a pending request. False when the
   * request expired or was decided meanwhile; the caller then revokes the link.
   */
  approve(
    requestId: string,
    credential: { readonly id: string; readonly credential: string },
  ): boolean {
    this.#sweep();
    const request = this.#requests.get(requestId);
    if (request?.state.kind !== "pending") return false;
    request.state = { kind: "approved", credential: credential.credential, linkId: credential.id };
    request.expiresAt = this.#now() + DEVICE_SIGN_IN_APPROVED_TTL_MS;
    return true;
  }

  #tokenMatches(request: StoredRequest, pollToken: string): boolean {
    const presented = hashToken(pollToken);
    return (
      presented.length === request.pollTokenHash.length &&
      timingSafeEqual(presented, request.pollTokenHash)
    );
  }

  #code(): string {
    let code = "";
    // Rejection sampling keeps every character equally likely.
    const limit = 256 - (256 % CODE_ALPHABET.length);
    while (code.length < CODE_LENGTH) {
      for (const byte of this.#random(CODE_LENGTH * 2)) {
        if (byte < limit && code.length < CODE_LENGTH)
          code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
      }
    }
    return code;
  }

  #sweep() {
    const now = this.#now();
    for (const [id, request] of this.#requests) {
      if (request.expiresAt <= now) this.#requests.delete(id);
    }
  }
}
