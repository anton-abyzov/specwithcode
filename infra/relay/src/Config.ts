import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export const ApnsEnvironment = Schema.Literals(["sandbox", "production"]);
export type ApnsEnvironment = typeof ApnsEnvironment.Type;

export const ManagedEndpointCleanupMode = Schema.Literals(["off", "dry-run", "enabled"]);
export type ManagedEndpointCleanupMode = typeof ManagedEndpointCleanupMode.Type;
const decodeManagedEndpointCleanupMode = Schema.decodeUnknownEffect(ManagedEndpointCleanupMode);

const RELAY_TUNNEL_CLEANUP_MODE = "RELAY_TUNNEL_CLEANUP_MODE";
/** Separate switch for tunnels whose host never registered recovery. */
const RELAY_LEGACY_TUNNEL_CLEANUP_MODE = "RELAY_LEGACY_TUNNEL_CLEANUP_MODE";

const cleanupModeConfig = (name: string) =>
  Config.String(name).pipe(
    Config.withDefault("off"),
    Config.map((value) => value.trim() || "off"),
    Config.mapEffect((value) =>
      decodeManagedEndpointCleanupMode(value).pipe(
        Effect.mapError((error) => new Config.ConfigError(error)),
      ),
    ),
  );

export const managedEndpointCleanupModeConfig = cleanupModeConfig(RELAY_TUNNEL_CLEANUP_MODE);
export const legacyManagedEndpointCleanupModeConfig = cleanupModeConfig(
  RELAY_LEGACY_TUNNEL_CLEANUP_MODE,
);

/**
 * Overrides the 7-day legacy grace period, in minutes, so the disposable
 * canary stage can exercise legacy cleanup. Ignored on the prod stage.
 */
const RELAY_LEGACY_TUNNEL_GRACE_MINUTES = "RELAY_LEGACY_TUNNEL_GRACE_MINUTES";

// A zero or negative override would be ignored at runtime, silently leaving
// the canary on the 7-day grace period, so reject it when the deploy reads it.
export const legacyTunnelGraceMinutesConfig = Config.option(
  Config.schema(
    Schema.NumberFromString.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThan(0))),
    RELAY_LEGACY_TUNNEL_GRACE_MINUTES,
  ),
);

const decodePositiveInteger = Schema.decodeUnknownEffect(
  Schema.NumberFromString.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThan(0))),
);

// Unset GitHub variables reach the deploy as empty strings, so blank means unset.
const optionalPositiveIntegerConfig = (name: string) =>
  Config.String(name).pipe(
    Config.withDefault(""),
    Config.mapEffect((raw) => {
      const value = raw.trim();
      return value === ""
        ? Effect.succeed(undefined)
        : decodePositiveInteger(value).pipe(
            Effect.mapError((error) => new Config.ConfigError(error)),
          );
    }),
  );

/** Managed machines an account without an override or founder seat may link. */
export const DEFAULT_CONNECT_FREE_TUNNEL_LIMIT = 3;

export const connectFreeTunnelLimitConfig = optionalPositiveIntegerConfig(
  "RELAY_CONNECT_FREE_TUNNEL_LIMIT",
).pipe(Config.map((value) => value ?? DEFAULT_CONNECT_FREE_TUNNEL_LIMIT));

/** Total managed machines across all accounts; unset means no global cap. */
export const globalManagedTunnelCapConfig = optionalPositiveIntegerConfig(
  "RELAY_GLOBAL_MANAGED_TUNNEL_CAP",
);

export interface ApnsCredentials {
  readonly teamId: string;
  readonly keyId: string;
  readonly privateKey: Redacted.Redacted<string>;
  readonly bundleId: string;
  readonly environment: ApnsEnvironment;
}

export class RelayConfiguration extends Context.Service<
  RelayConfiguration,
  {
    readonly relayIssuer: string;
    readonly apns: ApnsCredentials | null;
    readonly fcmServiceAccount?: Redacted.Redacted<string>;
    readonly clerkSecretKey: Redacted.Redacted<string>;
    readonly clerkPublishableKey: string;
    readonly clerkJwtAudience: string;
    readonly apnsDeliveryJobSigningSecret: Redacted.Redacted<string>;
    readonly cloudMintPrivateKey: Redacted.Redacted<string>;
    readonly cloudMintPublicKey: string;
    readonly managedEndpointBaseDomain: string | undefined;
    readonly managedEndpointNamespace: string | undefined;
    readonly managedEndpointCleanupMode?: ManagedEndpointCleanupMode;
    readonly legacyManagedEndpointCleanupMode?: ManagedEndpointCleanupMode;
    /** Canary-only override of the legacy grace period; ignored on prod. */
    readonly legacyTunnelGraceMinutes?: number;
    /** Managed machines for accounts without an override or founder seat. Default 3. */
    readonly connectFreeTunnelLimit?: number;
    /** New managed machine allocations stop at this total. Unset means no cap. */
    readonly globalManagedTunnelCap?: number;
  }
>()("studio-relay/Config/RelayConfiguration") {}

export const make = (configuration: RelayConfiguration["Service"]) =>
  RelayConfiguration.of(configuration);

export const layer = (configuration: RelayConfiguration["Service"]) =>
  Layer.succeed(RelayConfiguration, make(configuration));
