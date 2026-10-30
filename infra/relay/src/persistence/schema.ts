import type {
  RelayAgentActivityAggregateState,
  RelayAgentActivityState,
  RelayAgentAwarenessPreferences,
  RelayManagedEndpointOrigin,
} from "@specweave-studio/contracts/relay";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const relayMobileDevices = sqliteTable(
  "relay_mobile_devices",
  {
    userId: text("user_id").notNull(),
    deviceId: text("device_id").notNull(),
    label: text("label").notNull().default("iOS device"),
    platform: text("platform").notNull().$type<"ios" | "android">(),
    iosMajorVersion: integer("ios_major_version"),
    androidApiLevel: integer("android_api_level"),
    appVersion: text("app_version"),
    bundleId: text("bundle_id"),
    apsEnvironment: text("aps_environment").$type<"sandbox" | "production">(),
    pushToken: text("push_token"),
    pushToStartToken: text("push_to_start_token"),
    preferencesJson: text("preferences_json", { mode: "json" })
      .notNull()
      .$type<RelayAgentAwarenessPreferences>(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.deviceId] }),
    uniqueIndex("idx_relay_mobile_devices_push_token").on(table.pushToken),
    uniqueIndex("idx_relay_mobile_devices_push_to_start_token").on(table.pushToStartToken),
  ],
);

export const relayLiveActivities = sqliteTable(
  "relay_live_activities",
  {
    userId: text("user_id").notNull(),
    deviceId: text("device_id").notNull(),
    activityPushToken: text("activity_push_token"),
    remoteStartQueuedAt: text("remote_start_queued_at"),
    remoteStartedAt: text("remote_started_at"),
    endedAt: text("ended_at"),
    lastAggregateJson: text("last_aggregate_json", {
      mode: "json",
    }).$type<RelayAgentActivityAggregateState>(),
    lastLiveActivityDeliveryAt: text("last_live_activity_delivery_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.deviceId] }),
    uniqueIndex("idx_relay_live_activities_activity_push_token").on(table.activityPushToken),
  ],
);

export const relayEnvironmentLinks = sqliteTable(
  "relay_environment_links",
  {
    userId: text("user_id").notNull(),
    environmentId: text("environment_id").notNull(),
    environmentLabel: text("environment_label").notNull().default("Studio Environment"),
    environmentPublicKey: text("environment_public_key").notNull(),
    endpointHttpBaseUrl: text("endpoint_http_base_url").notNull(),
    endpointWsBaseUrl: text("endpoint_ws_base_url").notNull(),
    endpointProviderKind: text("endpoint_provider_kind").notNull(),
    notificationsEnabled: integer("notifications_enabled", { mode: "boolean" })
      .notNull()
      .default(true),
    liveActivitiesEnabled: integer("live_activities_enabled", { mode: "boolean" })
      .notNull()
      .default(true),
    managedTunnelsEnabled: integer("managed_tunnels_enabled", { mode: "boolean" })
      .notNull()
      .default(false),
    // Opt-in: hold webhook requests while the environment is offline.
    holdWebhooksWhileOffline: integer("hold_webhooks_while_offline", { mode: "boolean" })
      .notNull()
      .default(false),
    createdByDeviceId: text("created_by_device_id"),
    revokedAt: text("revoked_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.environmentId] }),
    index("idx_relay_environment_links_environment").on(table.environmentId, table.revokedAt),
  ],
);

export const relayManagedEndpointAllocations = sqliteTable(
  "relay_managed_endpoint_allocations",
  {
    userId: text("user_id").notNull(),
    environmentId: text("environment_id").notNull(),
    hostname: text("hostname").notNull(),
    tunnelId: text("tunnel_id"),
    tunnelName: text("tunnel_name").notNull(),
    dnsRecordId: text("dns_record_id"),
    readyAt: text("ready_at"),
    recoveryEnabledAt: text("recovery_enabled_at"),
    recoveryEnvironmentPublicKey: text("recovery_environment_public_key"),
    // Set when cleanup deletes the recorded tunnel; cleared when a tunnel is recorded again.
    tunnelReleasedAt: text("tunnel_released_at"),
    origin: text("origin", { mode: "json" }).$type<RelayManagedEndpointOrigin>(),
    generation: integer("generation").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.environmentId] }),
    uniqueIndex("idx_relay_managed_endpoint_allocations_hostname").on(table.hostname),
    uniqueIndex("idx_relay_managed_endpoint_allocations_tunnel_name").on(table.tunnelName),
  ],
);

export const relayManagedTunnelLimits = sqliteTable("relay_managed_tunnel_limits", {
  userId: text("user_id").primaryKey(),
  maxTunnels: integer("max_tunnels").notNull(),
  unlimited: integer("unlimited", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * A Connect promo such as the "Founding 1,000". `seatsGranted` only grows:
 * deleting a founder's account never returns the seat. `grantsOpen` is the
 * kill switch for new founder numbers; existing founders keep theirs.
 */
export const relayConnectPromos = sqliteTable("relay_connect_promos", {
  id: text("id").primaryKey(),
  seatCap: integer("seat_cap").notNull(),
  seatsGranted: integer("seats_granted").notNull().default(0),
  founderTunnelLimit: integer("founder_tunnel_limit").notNull(),
  grantsOpen: integer("grants_open", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** One row per account that has linked a managed machine, in signup order. */
export const relayConnectAccounts = sqliteTable(
  "relay_connect_accounts",
  {
    userId: text("user_id").primaryKey(),
    promoId: text("promo_id"),
    founderNumber: integer("founder_number"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_relay_connect_accounts_founder_number").on(table.promoId, table.founderNumber),
  ],
);

/**
 * Accounts whose deletion has started. Written first by account deletion and
 * never removed (Clerk user ids are not reused), so a link racing the
 * deletion cannot create a Connect account or a managed allocation for it.
 */
export const relayAccountDeletions = sqliteTable("relay_account_deletions", {
  userId: text("user_id").primaryKey(),
  startedAt: text("started_at").notNull(),
});

export const relayEnvironmentCredentials = sqliteTable(
  "relay_environment_credentials",
  {
    credentialId: text("credential_id").primaryKey(),
    environmentId: text("environment_id").notNull(),
    environmentPublicKey: text("environment_public_key").notNull(),
    credentialHash: text("credential_hash").notNull(),
    revokedAt: text("revoked_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_relay_environment_credentials_hash").on(table.credentialHash),
    index("idx_relay_environment_credentials_environment").on(table.environmentId, table.revokedAt),
    index("idx_relay_environment_credentials_environment_key").on(
      table.environmentId,
      table.environmentPublicKey,
      table.revokedAt,
    ),
  ],
);

export const relayAgentActivityRows = sqliteTable(
  "relay_agent_activity_rows",
  {
    environmentId: text("environment_id").notNull(),
    environmentPublicKey: text("environment_public_key").notNull(),
    threadId: text("thread_id").notNull(),
    stateJson: text("state_json", { mode: "json" }).notNull().$type<RelayAgentActivityState>(),
    updatedAt: text("updated_at").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.environmentId, table.environmentPublicKey, table.threadId] }),
    index("idx_relay_agent_activity_rows_updated").on(table.updatedAt),
  ],
);

export const relayDeliveryAttempts = sqliteTable(
  "relay_delivery_attempts",
  {
    id: text("id").primaryKey(),
    createdAt: text("created_at").notNull(),
    userId: text("user_id"),
    environmentId: text("environment_id"),
    threadId: text("thread_id"),
    deviceId: text("device_id"),
    kind: text("kind").notNull(),
    sourceJobId: text("source_job_id"),
    tokenSuffix: text("token_suffix"),
    apnsStatus: integer("apns_status"),
    apnsReason: text("apns_reason"),
    apnsId: text("apns_id"),
    transportError: text("transport_error"),
  },
  (table) => [
    index("idx_relay_delivery_attempts_created").on(table.createdAt),
    uniqueIndex("idx_relay_delivery_attempts_source_job").on(table.sourceJobId),
  ],
);

export const relayDpopProofs = sqliteTable(
  "relay_dpop_proofs",
  {
    thumbprint: text("thumbprint").notNull(),
    jti: text("jti").notNull(),
    iat: integer("iat").notNull(),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.thumbprint, table.jti] }),
    index("idx_relay_dpop_proofs_expires_at").on(table.expiresAt),
  ],
);
