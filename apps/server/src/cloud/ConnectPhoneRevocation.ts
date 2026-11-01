/**
 * Ending a removed SpecWithCode Connect phone's access to this environment. A
 * phone is known here only by the DPoP key its `cloud-connect` sessions are
 * bound to. The relay orders this environment to end those sessions when the
 * owner removes a phone elsewhere; revoking a phone here tells the relay, so
 * its other environments end theirs and it cannot connect again without a
 * fresh sign-in; and a start, a relay config change and a slow periodic
 * catch-up pull the keys removed while this environment was offline or
 * missed the relay's order.
 */
import type { EnvironmentId } from "@specweave-studio/contracts";
import {
  RelayRevokeClientKeysProofPayload,
  type RelayRevokeClientKeysRequest,
  type RelayRevokeClientKeysResponse,
} from "@specweave-studio/contracts/relay";
import {
  normalizeRelayIssuer,
  RELAY_REVOKE_CLIENT_KEYS_REQUEST_TYP,
  verifyRelayJwt,
} from "@specweave-studio/shared/relayJwt";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { makeRelayEnvironmentHttpClient } from "../relay/relayEnvironmentClient.ts";
import { forkParked } from "../serverActivation.ts";
import {
  CloudLinkInternalError,
  CloudLinkProofRejectedError,
  CloudLinkProofReplayedError,
  consumeCloudReplayGuards,
} from "./CloudLink.ts";
import {
  CLOUD_LINKED_USER_ID,
  CLOUD_MINT_PUBLIC_KEY,
  readRelayConnection,
  RELAY_ISSUER_SECRET,
  RELAY_URL_SECRET,
} from "./config.ts";
import { hasBoundedCloudProofLifetime, hasExactScope } from "./linkChecks.ts";

const CLOUD_REVOKE_NONCE_PREFIX = "cloud-revoke-nonce-";
const CLOUD_REVOKE_JTI_PREFIX = "cloud-revoke-jti-";
/** Secret store name prefixes of revoke replay markers. The server prunes expired ones. */
export const CLIENT_KEY_REVOCATION_REPLAY_MARKER_PREFIXES = [
  CLOUD_REVOKE_NONCE_PREFIX,
  CLOUD_REVOKE_JTI_PREFIX,
] as const;

const RELAY_REQUEST_TIMEOUT = "10 seconds";
/** How often a running environment re-checks the account for removed phones. */
export const REMOVED_CLIENT_KEYS_CATCH_UP_INTERVAL = "10 minutes";

const decodeRevokeProof = Schema.decodeUnknownEffect(RelayRevokeClientKeysProofPayload);

export class ConnectPhoneRevocation extends Context.Service<
  ConnectPhoneRevocation,
  {
    /** The relay's signed order to end every session bound to these phone keys. */
    readonly revokeClientKeys: (
      request: RelayRevokeClientKeysRequest,
    ) => Effect.Effect<
      RelayRevokeClientKeysResponse,
      | CloudLinkProofRejectedError
      | CloudLinkProofReplayedError
      | CloudLinkInternalError
      | EnvironmentAuth.ServerAuthInternalError
    >;
    /**
     * Removes the owner's phone holding this key from their account. Any
     * Connect client's key may be sent: the relay acts only on a phone's and
     * answers false for another client, such as a browser. Best effort: false,
     * with a warning logged, when unlinked or the relay fails.
     */
    readonly removeAtRelay: (proofKeyThumbprint: string) => Effect.Effect<boolean>;
    /**
     * Ends the local sessions of phones removed from the account, for removals
     * made while this environment was offline or missed the relay's order. Best
     * effort; returns how many.
     */
    readonly syncRemovedClientKeys: () => Effect.Effect<number>;
    /** {@link syncRemovedClientKeys} in the background, for the life of this service. */
    readonly requestSync: () => Effect.Effect<void>;
  }
>()("specweave-studio/cloud/ConnectPhoneRevocation") {}

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const httpClient = yield* HttpClient.HttpClient;
  const scope = yield* Effect.scope;

  const readSecret = (name: string) =>
    secrets.get(name).pipe(
      Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))),
      Effect.mapError(
        (cause) => new CloudLinkInternalError({ operation: "revoke-client-keys", cause }),
      ),
    );
  const requireSecret = <E>(name: string, missing: () => E) =>
    readSecret(name).pipe(
      Effect.flatMap((value) =>
        Option.isSome(value) ? Effect.succeed(value.value) : Effect.fail(missing()),
      ),
    );

  const revokeClientKeys = Effect.fn("environment.cloud.revokeClientKeys")(function* (
    request: RelayRevokeClientKeysRequest,
  ) {
    const cloudMintPublicKey = yield* requireSecret(
      CLOUD_MINT_PUBLIC_KEY,
      () => new EnvironmentAuth.ServerAuthCloudMintPublicKeyMissingError({}),
    );
    const storedIssuer = yield* readSecret(RELAY_ISSUER_SECRET);
    const relayIssuer = Option.isSome(storedIssuer)
      ? storedIssuer.value
      : yield* requireSecret(
          RELAY_URL_SECRET,
          () => new EnvironmentAuth.ServerAuthCloudRelayIssuerMissingError({}),
        );
    const linkedCloudUserId = yield* requireSecret(
      CLOUD_LINKED_USER_ID,
      () => new EnvironmentAuth.ServerAuthLinkedCloudAccountMissingError({}),
    );
    const environmentId = yield* environment.getEnvironmentId;
    const now = yield* DateTime.now;
    const nowSeconds = Math.floor(now.epochMilliseconds / 1_000);
    const proofOption = yield* verifyRelayJwt({
      publicKey: cloudMintPublicKey,
      token: request.proof,
      typ: RELAY_REVOKE_CLIENT_KEYS_REQUEST_TYP,
      issuer: normalizeRelayIssuer(relayIssuer),
      audience: `studio-env:${environmentId}`,
      nowEpochSeconds: nowSeconds,
    }).pipe(Effect.flatMap(decodeRevokeProof), Effect.option);
    if (
      Option.isNone(proofOption) ||
      proofOption.value.environmentId !== environmentId ||
      proofOption.value.sub !== linkedCloudUserId ||
      !hasBoundedCloudProofLifetime({ ...proofOption.value, nowSeconds }) ||
      !hasExactScope({ scopes: proofOption.value.scope, expected: "environment:revoke-client" })
    ) {
      return yield* new CloudLinkProofRejectedError({ request: "revoke" });
    }
    const proof = proofOption.value;
    const consumedReplayGuards = yield* consumeCloudReplayGuards({
      secrets,
      names: [
        `${CLOUD_REVOKE_JTI_PREFIX}${proof.jti}`,
        `${CLOUD_REVOKE_NONCE_PREFIX}${proof.nonce}`,
      ],
      value: new TextEncoder().encode(DateTime.formatIso(now)),
    }).pipe(
      Effect.mapError(
        (cause) => new CloudLinkInternalError({ operation: "revoke-client-keys", cause }),
      ),
    );
    if (!consumedReplayGuards) {
      return yield* new CloudLinkProofReplayedError({ request: "revoke" });
    }
    const revoked = yield* environmentAuth.revokeSessionsByProofKeyThumbprints(
      proof.proofKeyThumbprints,
    );
    yield* Effect.logInfo("Ended the sessions of phones removed from the account").pipe(
      Effect.annotateLogs({ keys: proof.proofKeyThumbprints.length, revoked }),
    );
    return { revoked } satisfies RelayRevokeClientKeysResponse;
  });

  const withRelay = <A, E>(
    operation: (
      client: Effect.Success<ReturnType<typeof makeRelayEnvironmentHttpClient>>,
      environmentId: EnvironmentId,
    ) => Effect.Effect<A, E>,
  ) =>
    Effect.gen(function* () {
      const connection = yield* readRelayConnection.pipe(
        Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
      );
      if (connection === null) return Option.none<A>();
      const client = yield* makeRelayEnvironmentHttpClient(connection);
      return Option.some(yield* operation(client, yield* environment.getEnvironmentId));
    }).pipe(
      Effect.timeout(RELAY_REQUEST_TIMEOUT),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );

  const removeAtRelay = Effect.fn("environment.cloud.removeClientKeyAtRelay")(
    function* (proofKeyThumbprint: string) {
      const result = yield* withRelay((client, environmentId) =>
        client.server.removeClientKey({
          params: { environmentId },
          payload: { proofKeyThumbprint },
        }),
      );
      if (Option.isNone(result)) {
        yield* Effect.logWarning(
          "Not linked to SpecWithCode Connect; the phone was revoked on this computer only",
        );
        return false;
      }
      if (!result.value.removed) {
        // Expected for a browser or another non-phone Connect client.
        yield* Effect.logDebug("SpecWithCode Connect has no phone with this key to remove");
      }
      return result.value.removed;
    },
    Effect.catchCause((cause) =>
      Effect.logWarning(
        "Could not remove the phone from the SpecWithCode Connect account; it was revoked on this computer only",
        { cause },
      ).pipe(Effect.as(false)),
    ),
  );

  const pullRemovedClientKeys = Effect.fn("environment.cloud.pullRemovedClientKeys")(function* () {
    const result = yield* withRelay((client, environmentId) =>
      client.server.listRemovedClientKeys({ params: { environmentId } }),
    );
    if (Option.isNone(result) || result.value.proofKeyThumbprints.length === 0) return 0;
    return yield* environmentAuth.revokeSessionsByProofKeyThumbprints(
      result.value.proofKeyThumbprints,
    );
  });

  const syncRemovedClientKeys = () =>
    pullRemovedClientKeys().pipe(
      // The relay can be briefly unreachable at startup; a few tries are enough,
      // and the periodic catch-up covers a longer outage.
      Effect.retry({ schedule: Schedule.exponential("2 seconds"), times: 3 }),
      Effect.tap((revoked) =>
        revoked > 0
          ? Effect.logInfo("Ended the sessions of phones removed while this computer was offline", {
              revoked,
            })
          : Effect.void,
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not check SpecWithCode Connect for removed phones", {
          cause,
        }).pipe(Effect.as(0)),
      ),
    );

  const requestSync = () => syncRemovedClientKeys().pipe(Effect.forkIn(scope), Effect.asVoid);

  return ConnectPhoneRevocation.of({
    revokeClientKeys,
    removeAtRelay,
    syncRemovedClientKeys,
    requestSync,
  });
});

export const layer = Layer.effect(ConnectPhoneRevocation, make);

/**
 * Pulls the keys removed while this environment was offline once it is active,
 * then every {@link REMOVED_CLIENT_KEYS_CATCH_UP_INTERVAL}, so a missed relay
 * order still ends a removed phone's sessions. Each check is one small relay
 * request and never fails.
 */
export const layerStartupSync = Layer.effectDiscard(
  Effect.gen(function* () {
    const revocation = yield* ConnectPhoneRevocation;
    yield* forkParked(
      revocation
        .syncRemovedClientKeys()
        .pipe(
          Effect.repeat(Schedule.spaced(REMOVED_CLIENT_KEYS_CATCH_UP_INTERVAL)),
          Effect.asVoid,
        ),
    );
  }),
);
