import {
  RelayManagedEndpointOrigin,
  RelayManagedEndpointRuntimeConfig,
} from "@specweave-studio/contracts/relay";
import {
  managedEndpointBaseDomainFromRelayUrl,
  managedEndpointHashFor,
  splitManagedEndpointLabel,
} from "@specweave-studio/shared/managedEndpoint";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { managedEndpointBaseDomain, parseFleetOrigin } from "../fleet/fleetOrigin.ts";

export const CLOUD_MINT_PUBLIC_KEY = "cloud-mint-ed25519-public-key";
export const CLOUD_ENDPOINT_RUNTIME_CONFIG = "cloud-endpoint-runtime-config";
export const CLOUD_ENDPOINT_CONFIRMED_ORIGIN = "cloud-endpoint-confirmed-origin";
export const CLOUD_LINKED_USER_ID = "cloud-linked-user-id";
/** This environment's public SpecWithCode Connect origin (https://<managed host>), for fleet invitations. */
export const CLOUD_ENDPOINT_PUBLIC_ORIGIN = "cloud-endpoint-public-origin";
export const RELAY_URL_SECRET = "cloud-relay-url";
export const RELAY_ISSUER_SECRET = "cloud-relay-issuer";
export const RELAY_ENVIRONMENT_CREDENTIAL_SECRET = "cloud-relay-environment-credential";
export const PUBLISH_AGENT_ACTIVITY_SECRET = "cloud-publish-agent-activity";
export const HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET = "cloud-hold-webhooks-while-offline";

export const encodeEndpointRuntimeConfigJson = Schema.encodeEffect(
  Schema.fromJsonString(RelayManagedEndpointRuntimeConfig),
);

export const decodeRuntimeConfig = Schema.decodeUnknownOption(
  Schema.fromJsonString(RelayManagedEndpointRuntimeConfig),
);

export const ManagedEndpointConfirmedOrigin = Schema.Struct({
  config: RelayManagedEndpointRuntimeConfig,
  origin: RelayManagedEndpointOrigin,
});

export const encodeConfirmedOriginJson = Schema.encodeEffect(
  Schema.fromJsonString(ManagedEndpointConfirmedOrigin),
);

export const decodeConfirmedOrigin = Schema.decodeUnknownOption(
  Schema.fromJsonString(ManagedEndpointConfirmedOrigin),
);

export function isAgentActivityPublishingEnabledValue(value: string | null): boolean {
  return value === "true";
}

/** Whether agent-activity publishes currently leave this environment: the
    publish opt-in secret is enabled and the relay link credentials exist.
    Mirrors the per-publish gate in AgentAwarenessRelay, so the descriptor
    capability never advertises publishing that the publisher would skip. */
export const readAgentActivityPublishingActive = (
  secrets: ServerSecretStore.ServerSecretStore["Service"],
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const readSecretString = (name: string) =>
      secrets
        .get(name)
        .pipe(
          Effect.map((bytes) =>
            Option.isSome(bytes) ? new TextDecoder().decode(bytes.value) : null,
          ),
        );
    const [enabled, url, environmentCredential] = yield* Effect.all(
      [
        readSecretString(PUBLISH_AGENT_ACTIVITY_SECRET),
        readSecretString(RELAY_URL_SECRET),
        readSecretString(RELAY_ENVIRONMENT_CREDENTIAL_SECRET),
      ],
      { concurrency: "unbounded" },
    );
    // Empty strings are as unconfigured as missing files: the publisher's
    // truthiness gate skips them, so the capability must too.
    return (
      isAgentActivityPublishingEnabledValue(enabled) &&
      url !== null &&
      url !== "" &&
      environmentCredential !== null &&
      environmentCredential !== ""
    );
  }).pipe(Effect.orElseSucceed(() => false));

/** A non-empty secret as text, or null when it is missing, empty or unreadable. */
const readSecretString = (name: string) =>
  ServerSecretStore.ServerSecretStore.pipe(
    Effect.flatMap((secrets) => secrets.get(name)),
    Effect.map((bytes) =>
      Option.isSome(bytes) && bytes.value.length > 0 ? new TextDecoder().decode(bytes.value) : null,
    ),
    Effect.orElseSucceed(() => null),
  );

/** The relay URL and environment credential, or null when not linked to Studio Connect. */
export const readRelayConnection = Effect.all(
  [readSecretString(RELAY_URL_SECRET), readSecretString(RELAY_ENVIRONMENT_CREDENTIAL_SECRET)],
  { concurrency: "unbounded" },
).pipe(
  Effect.map(([url, environmentCredential]) =>
    url && environmentCredential ? { url, environmentCredential } : null,
  ),
);

/** Whether this environment opted in to Studio Connect holding webhooks while it is offline. */
export const readHoldWebhooksWhileOffline = readSecretString(
  HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET,
).pipe(Effect.map((value) => value === "true"));

export const ManagedEndpointPublicOrigin = Schema.Struct({
  origin: Schema.String,
  source: Schema.Literals(["link", "recovery", "client"]),
  recordedAt: Schema.String,
});
export type ManagedEndpointPublicOrigin = typeof ManagedEndpointPublicOrigin.Type;

export const encodePublicOriginJson = Schema.encodeEffect(
  Schema.fromJsonString(ManagedEndpointPublicOrigin),
);

export const decodePublicOrigin = Schema.decodeUnknownOption(
  Schema.fromJsonString(ManagedEndpointPublicOrigin),
);

/** The relay's managed endpoint namespace for production links. */
const DEFAULT_MANAGED_ENDPOINT_NAMESPACE = "prod";

/** `httpBaseUrl` as a Connect origin, or null when it is not a managed endpoint address. */
export const connectOriginOf = (httpBaseUrl: string): string | null => {
  const parsed = parseFleetOrigin(httpBaseUrl);
  return parsed?.transport === "connect" ? parsed.origin : null;
};

/**
 * Whether a managed endpoint a client relayed names this link: its hostname
 * hash must be the relay's hash of (its namespace, this user, this
 * environment), so a client cannot plant another machine's address.
 */
export const endpointMatchesLink = (
  httpBaseUrl: string,
  cloudUserId: string,
  environmentId: string,
): boolean => {
  const origin = connectOriginOf(httpBaseUrl);
  if (origin === null) return false;
  const label = splitManagedEndpointLabel(new URL(origin).hostname, managedEndpointBaseDomain());
  return (
    label !== null &&
    label.hash === managedEndpointHashFor(label.prefix, cloudUserId, environmentId)
  );
};

/**
 * Stores this environment's Connect origin from a managed endpoint the relay
 * returned. An address that is not a managed endpoint clears any stored one,
 * so a stale origin never outlives the link it came from. Returns whether a
 * value was stored.
 */
export const persistConnectOrigin = (
  httpBaseUrl: string,
  source: ManagedEndpointPublicOrigin["source"],
): Effect.Effect<
  boolean,
  ServerSecretStore.SecretStoreError,
  ServerSecretStore.ServerSecretStore
> =>
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const origin = connectOriginOf(httpBaseUrl);
    if (origin === null) {
      yield* secrets.remove(CLOUD_ENDPOINT_PUBLIC_ORIGIN);
      return false;
    }
    const recordedAt = DateTime.formatIso(yield* DateTime.now);
    const json = yield* encodePublicOriginJson({ origin, source, recordedAt }).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (json === null) return false;
    yield* secrets.set(CLOUD_ENDPOINT_PUBLIC_ORIGIN, new TextEncoder().encode(json));
    return true;
  });

/** Only the production relay (`relay.<base>`) uses the "prod" namespace; its base domain, else null. */
const productionRelayBaseDomain = (relayUrl: string): string | null => {
  const baseDomain = managedEndpointBaseDomainFromRelayUrl(relayUrl);
  if (baseDomain === null) return null;
  return URL.canParse(relayUrl) &&
    new URL(relayUrl).hostname.toLowerCase() === `relay.${baseDomain}`
    ? baseDomain
    : null;
};

/**
 * This environment's validated SpecWithCode Connect origin, or null. Only a
 * managed link with a Cloudflare tunnel runtime has one. The stored value
 * wins; a link made before it was stored gets the production address derived
 * the way the relay names it, when its relay is `relay.<base domain>`.
 */
export const readConnectOrigin: Effect.Effect<
  string | null,
  never,
  ServerSecretStore.ServerSecretStore | ServerEnvironment.ServerEnvironment
> = Effect.gen(function* () {
  const [runtimeJson, stored, cloudUserId, relayUrl] = yield* Effect.all(
    [
      readSecretString(CLOUD_ENDPOINT_RUNTIME_CONFIG),
      readSecretString(CLOUD_ENDPOINT_PUBLIC_ORIGIN),
      readSecretString(CLOUD_LINKED_USER_ID),
      readSecretString(RELAY_URL_SECRET),
    ],
    { concurrency: "unbounded" },
  );
  if (runtimeJson === null || cloudUserId === null) return null;
  const runtime = Option.getOrNull(decodeRuntimeConfig(runtimeJson));
  if (runtime?.providerKind !== "cloudflare_tunnel") return null;
  if (stored !== null) {
    const value = Option.getOrNull(decodePublicOrigin(stored));
    const origin = value === null ? null : connectOriginOf(value.origin);
    if (origin !== null) return origin;
  }
  const baseDomain = relayUrl === null ? null : productionRelayBaseDomain(relayUrl);
  if (baseDomain === null) return null;
  const environmentId = yield* ServerEnvironment.ServerEnvironment.pipe(
    Effect.flatMap((environment) => environment.getEnvironmentId),
  );
  const hash = managedEndpointHashFor(
    DEFAULT_MANAGED_ENDPOINT_NAMESPACE,
    cloudUserId,
    environmentId,
  );
  return connectOriginOf(`https://${DEFAULT_MANAGED_ENDPOINT_NAMESPACE}-${hash}.${baseDomain}`);
});
