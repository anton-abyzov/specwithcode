import { eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import * as RelayConfiguration from "../Config.ts";
import * as RelayDb from "../db.ts";
import { FOUNDERS_PROMO_ID } from "../environments/ConnectAccounts.ts";
import {
  relayClientKeys,
  relayConnectAccounts,
  relayConnectPromos,
  relayEnvironmentCredentials,
  relayEnvironmentLinks,
  relayManagedEndpointAllocations,
  relayManagedTunnelLimits,
  relayMobileDevices,
} from "../persistence/schema.ts";

export const adminTestConfig = (
  overrides: Partial<RelayConfiguration.RelayConfiguration["Service"]> = {},
) =>
  RelayConfiguration.RelayConfiguration.of({
    relayIssuer: "https://relay.example.test",
    apns: null,
    apnsDeliveryJobSigningSecret: Redacted.make("job-secret"),
    clerkSecretKey: Redacted.make("clerk-secret"),
    clerkPublishableKey: "pk_test_test",
    clerkJwtAudience: "studio-code-relay",
    cloudMintPrivateKey: Redacted.make("private-key"),
    cloudMintPublicKey: "public-key",
    managedEndpointBaseDomain: undefined,
    managedEndpointNamespace: undefined,
    ...overrides,
  });

/**
 * Values no admin response may ever carry. Each sits in a column the admin
 * queries read rows from, so a query that selects too much shows up as a leak.
 */
export const ADMIN_SECRETS = {
  environmentPublicKey: "SECRET-environment-public-key",
  recoveryPublicKey: "SECRET-recovery-public-key",
  credentialHash: "SECRET-credential-hash",
  pushToken: "SECRET-push-token",
  pushToStartToken: "SECRET-push-to-start-token",
  proofKeyThumbprint: "SECRET-proof-key-thumbprint",
  clerkSessionId: "SECRET-clerk-session-id",
} as const;

const link = (
  userId: string,
  environmentId: string,
  label: string,
  at: string,
  extra: Partial<typeof relayEnvironmentLinks.$inferInsert> = {},
): typeof relayEnvironmentLinks.$inferInsert => ({
  userId,
  environmentId,
  environmentLabel: label,
  environmentPublicKey: ADMIN_SECRETS.environmentPublicKey,
  endpointHttpBaseUrl: `https://${environmentId}.example.test`,
  endpointWsBaseUrl: `wss://${environmentId}.example.test`,
  endpointProviderKind: "managed",
  managedTunnelsEnabled: true,
  createdAt: at,
  updatedAt: at,
  ...extra,
});

const allocation = (
  userId: string,
  environmentId: string,
  at: string,
  extra: Partial<typeof relayManagedEndpointAllocations.$inferInsert> = {},
): typeof relayManagedEndpointAllocations.$inferInsert => ({
  userId,
  environmentId,
  hostname: `prod-${environmentId}.tunnels.example.test`,
  tunnelName: `studiorelay-managedendpoint-prod-${environmentId}`,
  tunnelId: `tunnel-${environmentId}`,
  recoveryEnvironmentPublicKey: ADMIN_SECRETS.recoveryPublicKey,
  createdAt: at,
  updatedAt: at,
  ...extra,
});

/**
 * Five accounts, oldest to newest:
 * - user_owner: unlimited override, founder 1, two linked machines (one tunnel
 *   ready, one released), one unlinked machine, one phone.
 * - user_free: one machine linked without a managed tunnel, no seat.
 * - user_founder: founder 2, one machine whose tunnel is still provisioning.
 * - user_phone: a phone and nothing else.
 * - user_key: a client key and nothing else.
 */
export const seedConnectAdmin = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  yield* db.insert(relayEnvironmentLinks).values([
    link("user_owner", "m4", "M4 Max", "2026-10-01T00:00:00.000Z"),
    link("user_owner", "m1", "M1", "2026-10-02T00:00:00.000Z"),
    link("user_owner", "old", "Old laptop", "2026-10-03T00:00:00.000Z", {
      revokedAt: "2026-10-20T00:00:00.000Z",
      updatedAt: "2026-10-20T00:00:00.000Z",
    }),
    link("user_free", "home", "Home PC", "2026-10-05T00:00:00.000Z", {
      endpointProviderKind: "manual",
      managedTunnelsEnabled: false,
    }),
    link("user_founder", "studio", "Studio", "2026-10-10T00:00:00.000Z"),
  ]);
  yield* db.insert(relayManagedEndpointAllocations).values([
    allocation("user_owner", "m4", "2026-10-01T00:00:00.000Z", {
      readyAt: "2026-10-01T00:01:00.000Z",
    }),
    allocation("user_owner", "m1", "2026-10-02T00:00:00.000Z", {
      readyAt: "2026-10-02T00:01:00.000Z",
      tunnelReleasedAt: "2026-10-08T00:00:00.000Z",
    }),
    allocation("user_founder", "studio", "2026-10-10T00:00:00.000Z"),
  ]);
  yield* db.insert(relayConnectAccounts).values([
    {
      userId: "user_owner",
      promoId: FOUNDERS_PROMO_ID,
      founderNumber: 1,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    },
    {
      userId: "user_founder",
      promoId: FOUNDERS_PROMO_ID,
      founderNumber: 2,
      createdAt: "2026-10-10T00:00:00.000Z",
      updatedAt: "2026-10-10T00:00:00.000Z",
    },
  ]);
  yield* db
    .update(relayConnectPromos)
    .set({ seatsGranted: 2 })
    .where(eq(relayConnectPromos.id, FOUNDERS_PROMO_ID));
  yield* db.insert(relayManagedTunnelLimits).values({
    userId: "user_owner",
    maxTunnels: 3,
    unlimited: true,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  });
  yield* db.insert(relayMobileDevices).values([
    {
      userId: "user_owner",
      deviceId: "iphone-16",
      label: "Anton's iPhone",
      platform: "ios",
      iosMajorVersion: 26,
      appVersion: "0.1.1",
      model: "iPhone17,3",
      pushToken: ADMIN_SECRETS.pushToken,
      pushToStartToken: ADMIN_SECRETS.pushToStartToken,
      proofKeyThumbprint: ADMIN_SECRETS.proofKeyThumbprint,
      clerkSessionId: ADMIN_SECRETS.clerkSessionId,
      lastSeenAt: "2026-11-11T00:00:00.000Z",
      preferencesJson: {} as never,
      createdAt: "2026-10-04T00:00:00.000Z",
      updatedAt: "2026-10-04T00:00:00.000Z",
    },
    {
      userId: "user_phone",
      deviceId: "pixel",
      label: "Pixel",
      platform: "android",
      androidApiLevel: 36,
      preferencesJson: {} as never,
      createdAt: "2026-10-12T00:00:00.000Z",
      updatedAt: "2026-10-12T00:00:00.000Z",
    },
  ]);
  yield* db.insert(relayClientKeys).values({
    userId: "user_key",
    proofKeyThumbprint: `${ADMIN_SECRETS.proofKeyThumbprint}-2`,
    clientId: "desktop",
    clerkSessionId: ADMIN_SECRETS.clerkSessionId,
    lastSeenAt: "2026-10-15T00:00:00.000Z",
  });
  yield* db.insert(relayEnvironmentCredentials).values({
    credentialId: "credential-1",
    environmentId: "m4",
    environmentPublicKey: ADMIN_SECRETS.environmentPublicKey,
    credentialHash: ADMIN_SECRETS.credentialHash,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  });
});
