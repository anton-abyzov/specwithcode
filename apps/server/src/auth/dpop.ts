import {
  type DpopVerificationFailureCode as DpopVerificationFailureCodeType,
  verifyDpopProof,
} from "@specweave-studio/shared/dpop";
import type { DpopFailureReason } from "@specweave-studio/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Option from "effect/Option";
import * as HttpServerRequest from "effect/http/HttpServerRequest";

import {
  ServerAuthDpopReplayKeyCalculationError,
  ServerAuthDpopReplayStateRecordError,
  ServerAuthInvalidCredentialError,
  type ServerAuthInternalError,
} from "./EnvironmentAuthErrors.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

/** Secret store name prefix of DPoP replay markers. The server prunes expired ones. */
export const DPOP_REPLAY_MARKER_PREFIX = "dpop-proof-";

export const mapDpopFailureReason = (code: DpopVerificationFailureCodeType): DpopFailureReason => {
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
    case "missing_proof":
    case "malformed_proof":
    case "invalid_signature":
    case "invalid_proof":
      return "invalid_proof";
  }
};

export const mapDpopReplayStoreError = (
  error: ServerSecretStore.SecretStoreError,
): ServerAuthInvalidCredentialError | ServerAuthInternalError =>
  ServerSecretStore.isSecretAlreadyExistsError(error)
    ? new ServerAuthInvalidCredentialError({
        diagnostic: "DPoP proof replayed.",
        dpopFailureReason: "replay",
        cause: error,
      })
    : new ServerAuthDpopReplayStateRecordError({
        cause: error,
      });

/**
 * Replay keys of token requests whose proof passed its checks and whose
 * exchange is still running, per marker store. Held until the request ends,
 * so a concurrent copy of the same proof is refused before it spends anything.
 */
const inFlightReplayKeys = new WeakMap<
  ServerSecretStore.ServerSecretStore["Service"],
  Set<string>
>();

const refusedAsReplay = () =>
  Effect.annotateCurrentSpan({
    "environment.dpop.failure_code": "replay",
  }).pipe(
    Effect.andThen(
      Effect.fail(
        new ServerAuthInvalidCredentialError({
          diagnostic: "DPoP proof replayed.",
          dpopFailureReason: "replay",
        }),
      ),
    ),
  );

const verifyProofAndReplayKey = (input: {
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly expectedThumbprint?: string;
  readonly expectedAccessToken?: string;
}) =>
  Effect.gen(function* () {
    const proof = input.request.headers.dpop;
    const url = HttpServerRequest.toURL(input.request);
    if (Option.isNone(url)) {
      return yield* new ServerAuthInvalidCredentialError({
        diagnostic: "Invalid DPoP request URL.",
      });
    }
    const now = yield* DateTime.now;
    const result = verifyDpopProof({
      proof,
      method: input.request.method,
      url: url.value.href,
      nowEpochSeconds: Math.floor(now.epochMilliseconds / 1_000),
      ...(input.expectedThumbprint ? { expectedThumbprint: input.expectedThumbprint } : {}),
      ...(input.expectedAccessToken ? { expectedAccessToken: input.expectedAccessToken } : {}),
    });
    if (!result.ok) {
      yield* Effect.annotateCurrentSpan({
        "environment.dpop.failure_code": result.code,
      });
      return yield* new ServerAuthInvalidCredentialError({
        diagnostic: result.reason,
        dpopFailureReason: mapDpopFailureReason(result.code),
      });
    }
    const secretStore = yield* ServerSecretStore.ServerSecretStore;
    const replayKey = yield* Crypto.Crypto.pipe(
      Effect.flatMap((crypto) =>
        crypto.digest("SHA-256", new TextEncoder().encode(`${result.thumbprint}:${result.jti}`)),
      ),
      Effect.map(Base64Url.encode),
      Effect.mapError(
        (cause) =>
          new ServerAuthDpopReplayKeyCalculationError({
            cause,
          }),
      ),
    );
    const markerName = `${DPOP_REPLAY_MARKER_PREFIX}${replayKey}`;
    const record: Effect.Effect<void, ServerAuthInvalidCredentialError | ServerAuthInternalError> =
      secretStore
        .create(
          markerName,
          new TextEncoder().encode(
            [
              `thumbprint=${result.thumbprint}`,
              `jti=${result.jti}`,
              `iat=${result.iat}`,
              `consumedAt=${DateTime.formatIso(now)}`,
            ].join("\n"),
          ),
        )
        .pipe(
          Effect.catchIf(ServerSecretStore.isSecretStoreError, (error) =>
            Effect.gen(function* () {
              const mapped = mapDpopReplayStoreError(error);
              if (mapped._tag === "ServerAuthInvalidCredentialError") {
                yield* Effect.annotateCurrentSpan({
                  "environment.dpop.failure_code": mapped.dpopFailureReason,
                });
              }
              return yield* mapped;
            }),
          ),
        );
    return { thumbprint: result.thumbprint, secretStore, markerName, record };
  });

/**
 * Checks a request's DPoP proof and refuses one already recorded or in use
 * by a concurrent request, without recording it. `consume` records the
 * proof's jti, so run it only once the rest of the request is accepted.
 * `release` must run when the request ends, accepted or not (use
 * `Effect.acquireUseRelease`); until then the same proof is refused.
 */
export const checkRequestDpopProof = (input: {
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly expectedThumbprint?: string;
  readonly expectedAccessToken?: string;
}) =>
  Effect.gen(function* () {
    const proof = yield* verifyProofAndReplayKey(input);
    let claimed = inFlightReplayKeys.get(proof.secretStore);
    if (claimed === undefined) {
      claimed = new Set();
      inFlightReplayKeys.set(proof.secretStore, claimed);
    }
    // Test and claim in one synchronous step, before any read can interleave.
    if (claimed.has(proof.markerName)) return yield* refusedAsReplay();
    claimed.add(proof.markerName);
    const claims = claimed;
    const release = Effect.sync(() => {
      claims.delete(proof.markerName);
    });
    const recorded = yield* proof.secretStore.get(proof.markerName).pipe(
      Effect.mapError((cause) => new ServerAuthDpopReplayStateRecordError({ cause })),
      Effect.onError(() => release),
    );
    if (Option.isSome(recorded)) {
      yield* release;
      return yield* refusedAsReplay();
    }
    return { thumbprint: proof.thumbprint, consume: proof.record, release };
  });

/** Checks a request's DPoP proof and records it at once, refusing a replay. */
export const verifyRequestDpopProof = (input: Parameters<typeof checkRequestDpopProof>[0]) =>
  verifyProofAndReplayKey(input).pipe(
    Effect.flatMap((proof) => Effect.as(proof.record, proof.thumbprint)),
  );
