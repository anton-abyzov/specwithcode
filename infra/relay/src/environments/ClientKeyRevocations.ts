import { makeEnvironmentHttpApiClient } from "@specweave-studio/client-runtime/rpc";
import type { RelayRevokeClientKeysProofPayload } from "@specweave-studio/contracts/relay";
import {
  normalizeRelayIssuer,
  RELAY_REVOKE_CLIENT_KEYS_REQUEST_TYP,
  signRelayJwt,
} from "@specweave-studio/shared/relayJwt";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as HttpClient from "effect/http/HttpClient";

import * as RelayConfiguration from "../Config.ts";
import { validateManagedEndpoint, withoutRedirects } from "./EnvironmentConnector.ts";
import * as EnvironmentLinks from "./EnvironmentLinks.ts";
import * as ManagedEndpointAllocations from "./ManagedEndpointAllocations.ts";

/**
 * Shorter than the connector's mint timeout: notifying runs inside the
 * removal request, which the relay cuts off at 9 s. An environment that
 * misses the order pulls the removed keys when it next applies relay config.
 */
export const CLIENT_KEY_REVOCATION_TIMEOUT_MS = 5_000;

export class ClientKeyRevocations extends Context.Service<
  ClientKeyRevocations,
  {
    /**
     * Tells each of the user's linked, ready managed environments to end the
     * sessions bound to these DPoP keys. Best effort: failures are logged and
     * never fail the caller.
     */
    readonly notify: (input: {
      readonly userId: string;
      readonly proofKeyThumbprints: ReadonlyArray<string>;
      readonly exceptEnvironmentId?: string | undefined;
    }) => Effect.Effect<void>;
  }
>()("studio-relay/environments/ClientKeyRevocations") {}

export const make = Effect.gen(function* () {
  const links = yield* EnvironmentLinks.EnvironmentLinks;
  const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
  const settings = yield* RelayConfiguration.RelayConfiguration;
  const httpClient = yield* HttpClient.HttpClient;
  const crypto = yield* Crypto.Crypto;
  const relayIssuer = normalizeRelayIssuer(settings.relayIssuer);

  const notifyEnvironment = Effect.fn("relay.client_key_revocations.notify_environment")(
    function* (input: {
      readonly userId: string;
      readonly environmentId: string;
      readonly proofKeyThumbprints: ReadonlyArray<string>;
    }) {
      yield* Effect.annotateCurrentSpan({ "relay.environment_id": input.environmentId });
      const link = yield* links.getForUser(input);
      if (!link) return "skipped" as const;
      const allocation = yield* allocations.get(input);
      const endpoint = validateManagedEndpoint({
        link,
        allocation,
        baseDomain: settings.managedEndpointBaseDomain,
      });
      if (Result.isFailure(endpoint)) return "skipped" as const;
      const now = yield* DateTime.now;
      const issuedAt = Math.floor(now.epochMilliseconds / 1_000);
      const payload = {
        iss: relayIssuer,
        aud: `studio-env:${link.environmentId}`,
        sub: input.userId,
        jti: yield* crypto.randomUUIDv4,
        iat: issuedAt,
        exp: issuedAt + 120,
        environmentId: link.environmentId,
        proofKeyThumbprints: [...input.proofKeyThumbprints],
        nonce: yield* crypto.randomUUIDv4,
        scope: ["environment:revoke-client"],
      } satisfies RelayRevokeClientKeysProofPayload;
      const proof = yield* signRelayJwt({
        privateKey: Redacted.value(settings.cloudMintPrivateKey),
        typ: RELAY_REVOKE_CLIENT_KEYS_REQUEST_TYP,
        payload,
      });
      const client = yield* makeEnvironmentHttpApiClient(endpoint.success.httpBaseUrl).pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient),
      );
      const response = yield* client.connect.studioRevokeClientKeys({ payload: { proof } }).pipe(
        withoutRedirects,
        Effect.timeoutOrElse({
          duration: Duration.millis(CLIENT_KEY_REVOCATION_TIMEOUT_MS),
          orElse: () => Effect.fail("timeout" as const),
        }),
      );
      yield* Effect.annotateCurrentSpan({
        "relay.client_key_revocation.revoked": response.revoked,
      });
      return "notified" as const;
    },
  );

  return ClientKeyRevocations.of({
    notify: Effect.fn("relay.client_key_revocations.notify")(function* (input) {
      if (input.proofKeyThumbprints.length === 0) return;
      const environments = yield* links.listForUser({ userId: input.userId }).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("client key revocation could not list environments", {
            errorTag: error._tag,
          }),
        ),
        Effect.orElseSucceed(() => []),
      );
      yield* Effect.forEach(
        environments.filter(
          (environment) =>
            environment.endpoint.providerKind === "cloudflare_tunnel" &&
            environment.environmentId !== input.exceptEnvironmentId,
        ),
        (environment) =>
          notifyEnvironment({
            userId: input.userId,
            environmentId: environment.environmentId,
            proofKeyThumbprints: input.proofKeyThumbprints,
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("client key revocation was not delivered", {
                environmentId: environment.environmentId,
                cause,
              }),
            ),
          ),
        { concurrency: "unbounded", discard: true },
      );
    }),
  });
});

export const layer = Layer.effect(ClientKeyRevocations, make);
