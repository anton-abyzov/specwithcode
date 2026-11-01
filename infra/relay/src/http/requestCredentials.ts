import type {
  RelayDpopFailureReason,
  RelayEnvironmentConnectRequest,
} from "@specweave-studio/contracts/relay";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpApiError from "effect/http-api/HttpApiError";

import * as DpopProofs from "../auth/DpopProofs.ts";

export function isDpopAuthorizationHeader(value: string | undefined): boolean {
  return /^DPoP +/iu.test(value ?? "");
}

export function readHttpAuthorizationCredential(credential: Redacted.Redacted<string>): string {
  // Effect beta.73 leaves the scheme separator in decoded HTTP credentials.
  return Redacted.value(credential).trimStart();
}

export function relayDpopFailureReason(
  code: DpopProofs.DpopProofFailureCode,
): RelayDpopFailureReason {
  switch (code) {
    case "time_window":
      return "time_window";
    case "key_mismatch":
      return "key_mismatch";
    case "method_mismatch":
    case "url_mismatch":
      return "request_mismatch";
    case "access_token_hash_mismatch":
      return "token_mismatch";
    case "replayed":
      return "replay";
    case "missing_proof":
    case "malformed_proof":
    case "invalid_signature":
    case "invalid_proof":
      return "invalid_proof";
  }
}

export function resolveConnectClientKeyThumbprint(
  payload: RelayEnvironmentConnectRequest,
): string | null {
  const requestedThumbprint = payload.clientKeyThumbprint ?? payload.clientProofKeyThumbprint;
  if (!requestedThumbprint) {
    return null;
  }
  if (
    payload.clientKeyThumbprint &&
    payload.clientProofKeyThumbprint &&
    payload.clientKeyThumbprint !== payload.clientProofKeyThumbprint
  ) {
    return null;
  }
  return requestedThumbprint;
}

/** Verifies and consumes the request's DPoP proof for the given key. */
export const requireDpopThumbprint = Effect.fn("relay.api.require_dpop_thumbprint")(function* (
  expectedThumbprint: string,
  options?: {
    readonly expectedAccessToken?: string;
  },
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const now = yield* DateTime.now;
  const url = HttpServerRequest.toURL(request);
  if (url._tag === "None") {
    return yield* new HttpApiError.Unauthorized({});
  }
  const dpopProofs = yield* DpopProofs.DpopProofReplay;
  return yield* dpopProofs.verifyAndConsume({
    proof: request.headers.dpop,
    method: request.method,
    url: url.value.href,
    now,
    expectedThumbprint,
    ...(options?.expectedAccessToken ? { expectedAccessToken: options.expectedAccessToken } : {}),
  });
});

/** Verifies and consumes the request's DPoP proof, returning its key thumbprint. */
export const requireDpopProof = Effect.fn("relay.api.require_dpop_proof")(function* (options?: {
  readonly expectedAccessToken?: string;
}) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const now = yield* DateTime.now;
  const url = HttpServerRequest.toURL(request);
  if (url._tag === "None") {
    return yield* new HttpApiError.Unauthorized({});
  }
  const dpopProofs = yield* DpopProofs.DpopProofReplay;
  return yield* dpopProofs.verifyAndConsume({
    proof: request.headers.dpop,
    method: request.method,
    url: url.value.href,
    now,
    ...(options?.expectedAccessToken ? { expectedAccessToken: options.expectedAccessToken } : {}),
  });
});
