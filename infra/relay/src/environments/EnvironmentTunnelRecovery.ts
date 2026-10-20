import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpApiError from "effect/http-api/HttpApiError";
import {
  type RelayManagedEndpointOrigin,
  RelayManagedEndpointRecoveryProofPayload,
} from "@specweave-studio/contracts/relay";
import {
  normalizeRelayIssuer,
  RELAY_MANAGED_TUNNEL_RECOVERY_TYP,
  verifyRelayJwt,
} from "@specweave-studio/shared/relayJwt";

import * as RelayConfiguration from "../Config.ts";
import * as EnvironmentLinks from "./EnvironmentLinks.ts";
import * as ManagedEndpointAllocations from "./ManagedEndpointAllocations.ts";
import * as ManagedEndpointProvider from "./ManagedEndpointProvider.ts";

const decodeManagedTunnelRecoveryProof = Schema.decodeUnknownEffect(
  RelayManagedEndpointRecoveryProofPayload,
);

type EnvironmentTunnelRecoveryProofInput = {
  readonly proof: string;
  readonly userId: string;
  readonly environmentId: string;
  readonly environmentPublicKey: string;
} & (
  | {
      readonly action: "register";
      readonly tunnelId: string;
      readonly origin: RelayManagedEndpointOrigin;
    }
  | { readonly action: "recover"; readonly origin: RelayManagedEndpointOrigin }
);

export const verifyEnvironmentTunnelRecoveryProof = Effect.fn(
  "relay.api.server.verifyEnvironmentTunnelRecoveryProof",
)(function* (input: EnvironmentTunnelRecoveryProofInput) {
  const config = yield* RelayConfiguration.RelayConfiguration;
  const now = yield* DateTime.now;
  const verified = yield* verifyRelayJwt({
    publicKey: input.environmentPublicKey,
    token: input.proof,
    typ: RELAY_MANAGED_TUNNEL_RECOVERY_TYP,
    issuer: `studio-env:${input.environmentId}`,
    audience: normalizeRelayIssuer(config.relayIssuer),
    nowEpochSeconds: Math.floor(now.epochMilliseconds / 1_000),
  }).pipe(
    Effect.flatMap(decodeManagedTunnelRecoveryProof),
    Effect.mapError(() => new HttpApiError.Unauthorized({})),
  );

  if (
    verified.environmentId !== input.environmentId ||
    verified.sub !== input.environmentId ||
    verified.cloudUserId !== input.userId ||
    verified.action !== input.action
  ) {
    return yield* new HttpApiError.Unauthorized({});
  }
  if (input.action === "register") {
    if (
      verified.action !== "register" ||
      verified.tunnelId !== input.tunnelId ||
      verified.origin.localHttpHost !== input.origin.localHttpHost ||
      verified.origin.localHttpPort !== input.origin.localHttpPort
    ) {
      return yield* new HttpApiError.Unauthorized({});
    }
    return;
  }
  if (
    verified.action !== "recover" ||
    verified.origin.localHttpHost !== input.origin.localHttpHost ||
    verified.origin.localHttpPort !== input.origin.localHttpPort
  ) {
    return yield* new HttpApiError.Unauthorized({});
  }
});

export const registerEnvironmentTunnelRecovery = Effect.fn(
  "relay.api.server.registerEnvironmentTunnelRecovery",
)(function* (input: {
  readonly userId: string;
  readonly environmentId: string;
  readonly environmentPublicKey: string;
  readonly tunnelId: string;
  readonly origin: RelayManagedEndpointOrigin;
}) {
  const links = yield* EnvironmentLinks.EnvironmentLinks;
  const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
  const managedEndpointProvider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
  const link = yield* links.getForUser({
    userId: input.userId,
    environmentId: input.environmentId,
  });
  if (
    link === null ||
    link.environmentPublicKey !== input.environmentPublicKey ||
    link.endpoint.providerKind !== "cloudflare_tunnel"
  ) {
    return yield* new HttpApiError.Unauthorized({});
  }
  const status = yield* managedEndpointProvider.reconcileOrigin({
    userId: input.userId,
    environmentId: input.environmentId,
    tunnelId: input.tunnelId,
    origin: input.origin,
    endpoint: link.endpoint,
  });
  if (status === "recovery_required") {
    return { status };
  }
  if (!(yield* allocations.enableRecovery(input))) {
    return yield* new HttpApiError.Unauthorized({});
  }
  return { status };
});

export const recoverEnvironmentTunnelRecord = Effect.fn(
  "relay.api.server.recoverEnvironmentTunnelRecord",
)(function* (input: {
  readonly userId: string;
  readonly environmentId: string;
  readonly environmentPublicKey: string;
  readonly origin: RelayManagedEndpointOrigin;
}) {
  const links = yield* EnvironmentLinks.EnvironmentLinks;
  const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
  const managedEndpointProvider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
  const link = yield* links.getForUser({
    userId: input.userId,
    environmentId: input.environmentId,
  });
  if (
    link === null ||
    link.environmentPublicKey !== input.environmentPublicKey ||
    link.endpoint.providerKind !== "cloudflare_tunnel"
  ) {
    return yield* new HttpApiError.Unauthorized({});
  }

  const recovered = yield* managedEndpointProvider.provision({
    userId: input.userId,
    environmentId: input.environmentId,
    origin: input.origin,
  });
  const recoveredTunnelId = recovered.runtime.tunnelId;
  if (
    recoveredTunnelId === undefined ||
    recovered.endpoint.httpBaseUrl !== link.endpoint.httpBaseUrl ||
    recovered.endpoint.wsBaseUrl !== link.endpoint.wsBaseUrl
  ) {
    if (recoveredTunnelId !== undefined) {
      yield* managedEndpointProvider
        .release({
          userId: input.userId,
          environmentId: input.environmentId,
          expectedTunnelId: recoveredTunnelId,
        })
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Failed to clean up a tunnel with a mismatched endpoint", {
              userId: input.userId,
              environmentId: input.environmentId,
              tunnelId: recoveredTunnelId,
              cause,
            }),
          ),
        );
    }
    return yield* new HttpApiError.Unauthorized({});
  }

  const enabled = yield* allocations.enableRecovery({
    userId: input.userId,
    environmentId: input.environmentId,
    tunnelId: recoveredTunnelId,
    environmentPublicKey: input.environmentPublicKey,
    origin: input.origin,
  });
  if (!enabled) {
    const owner = { userId: input.userId, environmentId: input.environmentId };
    const target = yield* managedEndpointProvider.prepareDeprovision(owner);
    const currentLink = target === null ? null : yield* links.getForUser(input);
    if (
      target !== null &&
      (currentLink === null || currentLink.endpoint.providerKind !== "cloudflare_tunnel")
    ) {
      yield* managedEndpointProvider.deprovision({ ...owner, target }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Failed to clean up a tunnel after its managed link was removed", {
            userId: input.userId,
            environmentId: input.environmentId,
            cause,
          }),
        ),
      );
    }
    return yield* new HttpApiError.Unauthorized({});
  }
  return {
    endpoint: recovered.endpoint,
    endpointRuntime: recovered.runtime,
  };
});
