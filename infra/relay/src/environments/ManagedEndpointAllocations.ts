import type {
  RelayManagedEndpoint,
  RelayManagedEndpointOrigin,
} from "@specweave-studio/contracts/relay";
import { and, eq, exists, inArray, isNull, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/sqlite-core";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as RelayDb from "../db.ts";
import { isManagedEndpointHostname, managedEndpointForHostname } from "../deploymentConfig.ts";
import { relayEnvironmentLinks, relayManagedEndpointAllocations } from "../persistence/schema.ts";
import { ManagedTunnelLimitExceeded } from "./ManagedTunnelLimits.ts";

export interface ManagedEndpointAllocation {
  readonly userId: string;
  readonly environmentId: string;
  readonly hostname: string;
  readonly tunnelId: string | null;
  readonly tunnelName: string;
  readonly dnsRecordId: string | null;
  readonly readyAt: string | null;
  readonly origin: RelayManagedEndpointOrigin | null;
  readonly updatedAt: string;
  readonly generation: number;
  /** When cleanup deleted the recorded tunnel; null once a tunnel is recorded again. */
  readonly tunnelReleasedAt: string | null;
}

export interface ManagedEndpointTunnelAllocation extends ManagedEndpointAllocation {
  readonly recoveryEnabled: boolean;
}

// D1 allows at most 100 bound parameters per statement.
export const MANAGED_ENDPOINT_ALLOCATION_LOOKUP_BATCH_SIZE = 100;

export function resolveReadyManagedEndpoint(input: {
  readonly allocation: ManagedEndpointAllocation;
  readonly baseDomain: string | undefined;
}): RelayManagedEndpoint | null {
  if (
    !input.baseDomain ||
    input.allocation.readyAt === null ||
    input.allocation.tunnelId === null ||
    input.allocation.dnsRecordId === null ||
    !isManagedEndpointHostname(input.allocation.hostname, input.baseDomain)
  ) {
    return null;
  }
  return managedEndpointForHostname(input.allocation.hostname);
}

export class ManagedEndpointAllocationPersistenceError extends Schema.TaggedError<ManagedEndpointAllocationPersistenceError>()(
  "ManagedEndpointAllocationPersistenceError",
  {
    operation: Schema.Literals([
      "get",
      "reserve",
      "record-tunnel",
      "record-dns",
      "mark-ready",
      "enable-recovery",
      "list-tunnels",
      "lock-tunnel",
      "claim-release",
      "claim-deprovision",
      "remove",
      "remove-claimed",
      "get-by-tunnel-name",
    ]),
    stage: Schema.Literals(["database-request", "resolve-reservation"]),
    userId: Schema.String,
    environmentId: Schema.String,
    hostname: Schema.optionalKey(Schema.String),
    tunnelName: Schema.optionalKey(Schema.String),
    tunnelId: Schema.optionalKey(Schema.String),
    dnsRecordId: Schema.optionalKey(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Managed endpoint allocation '${this.operation}' failed during '${this.stage}' for user '${this.userId}', environment '${this.environmentId}'`;
  }
}

interface ManagedEndpointAllocationKey {
  readonly userId: string;
  readonly environmentId: string;
}

/** Caps a new allocation must fit under; an existing allocation always resolves. */
export interface ManagedEndpointAllocationCapacity {
  /** Managed machines the account may hold; null means no per-account cap. */
  readonly maxTunnels: number | null;
  /** Managed machines across all accounts; undefined means no global cap. */
  readonly globalCap?: number | undefined;
}

interface ReserveManagedEndpointAllocationInput extends ManagedEndpointAllocationKey {
  readonly hostname: string;
  readonly tunnelName: string;
  readonly capacity?: ManagedEndpointAllocationCapacity;
}

interface RecordManagedEndpointTunnelInput extends ManagedEndpointAllocationKey {
  readonly tunnelId: string;
  readonly generation: number;
}

interface RecordManagedEndpointDnsInput extends ManagedEndpointAllocationKey {
  readonly dnsRecordId: string;
  readonly tunnelId: string;
  readonly generation: number;
}

interface MarkManagedEndpointReadyInput extends ManagedEndpointAllocationKey {
  readonly tunnelId: string;
  readonly generation: number;
  readonly origin: RelayManagedEndpointOrigin;
}

interface ClaimManagedEndpointReleaseInput extends ManagedEndpointAllocationKey {
  readonly tunnelId: string;
  readonly generation: number;
  /** Record that the tunnel is being deleted; set only by the claim that deletes it. */
  readonly markReleased?: boolean;
}

interface EnableManagedEndpointRecoveryInput extends ManagedEndpointAllocationKey {
  readonly tunnelId: string;
  readonly environmentPublicKey: string;
  readonly origin: RelayManagedEndpointOrigin;
}

interface ClaimManagedEndpointDeprovisionInput extends ManagedEndpointAllocationKey {
  readonly generation: number;
}

interface RemoveClaimedManagedEndpointAllocationInput extends ManagedEndpointAllocationKey {
  readonly generation: number;
}

export class ManagedEndpointAllocations extends Context.Service<
  ManagedEndpointAllocations,
  {
    readonly get: (
      input: ManagedEndpointAllocationKey,
    ) => Effect.Effect<ManagedEndpointAllocation | null, ManagedEndpointAllocationPersistenceError>;
    /** The allocation that owns a tunnel name; tunnel names are unique. */
    readonly getByTunnelName: (
      tunnelName: string,
    ) => Effect.Effect<ManagedEndpointAllocation | null, ManagedEndpointAllocationPersistenceError>;
    /**
     * Returns the environment's allocation, inserting it if it does not exist.
     * With `capacity`, the writes themselves check the account and global
     * counts, so concurrent reservations can never exceed either cap. An
     * environment whose allocation has a live managed link still resolves at
     * the limit; an existing allocation without one (in flight, left by a
     * failed link, or revoked with a failed teardown) must fit the caps again.
     * No allocation is created once the account's deletion has started.
     */
    readonly reserve: (
      input: ReserveManagedEndpointAllocationInput,
    ) => Effect.Effect<
      ManagedEndpointAllocation,
      ManagedEndpointAllocationPersistenceError | ManagedTunnelLimitExceeded
    >;
    readonly recordTunnel: (
      input: RecordManagedEndpointTunnelInput,
    ) => Effect.Effect<number | null, ManagedEndpointAllocationPersistenceError>;
    readonly recordDns: (
      input: RecordManagedEndpointDnsInput,
    ) => Effect.Effect<number | null, ManagedEndpointAllocationPersistenceError>;
    readonly markReady: (
      input: MarkManagedEndpointReadyInput,
    ) => Effect.Effect<boolean, ManagedEndpointAllocationPersistenceError>;
    readonly enableRecovery: (
      input: EnableManagedEndpointRecoveryInput,
    ) => Effect.Effect<boolean, ManagedEndpointAllocationPersistenceError>;
    readonly listByTunnelNames: (
      tunnelNames: ReadonlyArray<string>,
    ) => Effect.Effect<
      ReadonlyArray<ManagedEndpointTunnelAllocation>,
      ManagedEndpointAllocationPersistenceError
    >;
    /**
     * Atomically claims the right to delete the allocation's tunnel: succeeds
     * only while the recorded tunnel and generation still match what the
     * caller loaded. A concurrent provision increments `generation` when it
     * records its tunnel, which makes a stale claim fail and keeps the freshly
     * issued tunnel alive.
     */
    readonly claimRelease: (
      input: ClaimManagedEndpointReleaseInput,
    ) => Effect.Effect<number | null, ManagedEndpointAllocationPersistenceError>;
    readonly withClaimedTunnel: <A, E, R>(
      input: ClaimManagedEndpointReleaseInput,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<Option.Option<A>, E | ManagedEndpointAllocationPersistenceError, R>;
    /**
     * Claims the complete allocation for teardown only if its generation still
     * matches the snapshot captured by the unlink operation.
     *
     * Returns the claim generation used by `removeClaimed`, or null when a
     * concurrent provision has already superseded the snapshot.
     */
    readonly claimDeprovision: (
      input: ClaimManagedEndpointDeprovisionInput,
    ) => Effect.Effect<number | null, ManagedEndpointAllocationPersistenceError>;
    readonly remove: (
      input: ManagedEndpointAllocationKey,
    ) => Effect.Effect<void, ManagedEndpointAllocationPersistenceError>;
    readonly removeClaimed: (
      input: RemoveClaimedManagedEndpointAllocationInput,
    ) => Effect.Effect<boolean, ManagedEndpointAllocationPersistenceError>;
  }
>()("studio-relay/environments/ManagedEndpointAllocations") {}

const allocationSelection = {
  userId: relayManagedEndpointAllocations.userId,
  environmentId: relayManagedEndpointAllocations.environmentId,
  hostname: relayManagedEndpointAllocations.hostname,
  tunnelId: relayManagedEndpointAllocations.tunnelId,
  tunnelName: relayManagedEndpointAllocations.tunnelName,
  dnsRecordId: relayManagedEndpointAllocations.dnsRecordId,
  readyAt: relayManagedEndpointAllocations.readyAt,
  origin: relayManagedEndpointAllocations.origin,
  updatedAt: relayManagedEndpointAllocations.updatedAt,
  generation: relayManagedEndpointAllocations.generation,
  tunnelReleasedAt: relayManagedEndpointAllocations.tunnelReleasedAt,
};

/**
 * How long an allocation without a live managed link still counts as being
 * provisioned. `reserve` runs before the tunnel exists and the link row is
 * written last, so in-flight allocations must count, or two concurrent first
 * links could both fit under the last slot. After this window an allocation
 * left behind by a failed link stops holding the account's slot.
 */
export const MANAGED_ENDPOINT_IN_FLIGHT_WINDOW_MINUTES = 15;

/** The allocation has a live link with managed tunnels enabled. */
const liveManagedLink = sql`exists (
  select 1 from relay_environment_links l
  where l.user_id = a.user_id
    and l.environment_id = a.environment_id
    and l.revoked_at is null
    and l.managed_tunnels_enabled = 1
)`;

/**
 * Allocations that hold one of the account's managed machine slots: a live
 * managed link, or reserved or touched within the in-flight window.
 */
const occupiesAccountSlot = (inFlightSince: string) =>
  sql`(${liveManagedLink} or a.updated_at > ${inFlightSince})`;

/**
 * Allocations that count toward the global cap, which protects the DNS zone:
 * every account slot plus any allocation that still holds a DNS record
 * (for example one whose teardown failed), whether or not a link remains.
 */
const occupiesGlobalSlot = (inFlightSince: string) =>
  sql`(${occupiesAccountSlot(inFlightSince)} or a.dns_record_id is not null)`;

const accountSlotCount = (input: ManagedEndpointAllocationKey, inFlightSince: string) => sql`(
  select count(*) from relay_managed_endpoint_allocations a
  where a.user_id = ${input.userId}
    and a.environment_id <> ${input.environmentId}
    and ${occupiesAccountSlot(inFlightSince)}
)`;

const globalSlotCount = (input: ManagedEndpointAllocationKey, inFlightSince: string) => sql`(
  select count(*) from relay_managed_endpoint_allocations a
  where not (a.user_id = ${input.userId} and a.environment_id = ${input.environmentId})
    and ${occupiesGlobalSlot(inFlightSince)}
)`;

/** No new allocation once the account's deletion has started. */
const notDeleting = (input: ManagedEndpointAllocationKey) => sql`not exists (
  select 1 from relay_account_deletions d where d.user_id = ${input.userId}
)`;

const whereAllocation = (input: ManagedEndpointAllocationKey) =>
  and(
    eq(relayManagedEndpointAllocations.userId, input.userId),
    eq(relayManagedEndpointAllocations.environmentId, input.environmentId),
  );

export const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;

  return ManagedEndpointAllocations.of({
    get: Effect.fn("relay.managed_endpoint_allocations.get")(function* (
      input: ManagedEndpointAllocationKey,
    ) {
      return yield* db
        .select(allocationSelection)
        .from(relayManagedEndpointAllocations)
        .where(whereAllocation(input))
        .limit(1)
        .pipe(
          Effect.map((rows) => rows[0] ?? null),
          Effect.mapError(
            (cause) =>
              new ManagedEndpointAllocationPersistenceError({
                operation: "get",
                stage: "database-request",
                ...input,
                cause,
              }),
          ),
        );
    }),
    getByTunnelName: Effect.fn("relay.managed_endpoint_allocations.get_by_tunnel_name")(function* (
      tunnelName: string,
    ) {
      return yield* db
        .select(allocationSelection)
        .from(relayManagedEndpointAllocations)
        .where(eq(relayManagedEndpointAllocations.tunnelName, tunnelName))
        .limit(1)
        .pipe(
          Effect.map((rows) => rows[0] ?? null),
          Effect.mapError(
            (cause) =>
              new ManagedEndpointAllocationPersistenceError({
                operation: "get-by-tunnel-name",
                stage: "database-request",
                userId: "",
                environmentId: "",
                tunnelName,
                cause,
              }),
          ),
        );
    }),
    reserve: Effect.fn("relay.managed_endpoint_allocations.reserve")(function* (
      input: ReserveManagedEndpointAllocationInput,
    ) {
      const { capacity, ...key } = input;
      const reserveError = (cause: unknown) =>
        new ManagedEndpointAllocationPersistenceError({
          operation: "reserve",
          stage: "database-request",
          ...key,
          cause,
        });
      const nowDateTime = yield* DateTime.now;
      const now = DateTime.formatIso(nowDateTime);
      if (capacity === undefined) {
        yield* db
          .insert(relayManagedEndpointAllocations)
          .values({ ...key, createdAt: now, updatedAt: now })
          .onConflictDoNothing()
          .pipe(Effect.mapError(reserveError));
        const allocation = yield* db
          .select(allocationSelection)
          .from(relayManagedEndpointAllocations)
          .where(whereAllocation(key))
          .limit(1)
          .pipe(
            Effect.map((rows) => rows[0]),
            Effect.mapError(reserveError),
          );
        if (allocation !== undefined) {
          return allocation;
        }
        return yield* new ManagedEndpointAllocationPersistenceError({
          operation: "reserve",
          stage: "resolve-reservation",
          ...key,
        });
      }

      // D1 has no row locks or interactive transactions, so the caps are
      // part of the writes, and the batch is one implicit transaction:
      // 1. an existing allocation without a live managed link (in flight, left
      //    by a failed link, or revoked with a failed teardown) is checked
      //    against the caps again, and claims a slot by touching updated_at;
      // 2. a new allocation is inserted only under both caps;
      // 3. an allocation with a live managed link resolves at the limit.
      const inFlightSince = DateTime.formatIso(
        DateTime.subtract(nowDateTime, { minutes: MANAGED_ENDPOINT_IN_FLIGHT_WINDOW_MINUTES }),
      );
      const fitsCaps = sql`${notDeleting(key)}
        ${
          capacity.maxTunnels === null
            ? sql``
            : sql`and ${accountSlotCount(key, inFlightSince)} < ${capacity.maxTunnels}`
        }
        ${
          capacity.globalCap === undefined
            ? sql``
            : sql`and ${globalSlotCount(key, inFlightSince)} < ${capacity.globalCap}`
        }`;
      const results = yield* RelayDb.batch(db, [
        RelayDb.rawQuery(sql`
          update relay_managed_endpoint_allocations as a
          set updated_at = ${now}
          where a.user_id = ${key.userId}
            and a.environment_id = ${key.environmentId}
            and not ${liveManagedLink}
            and ${fitsCaps}
          returning user_id
        `),
        RelayDb.rawQuery(sql`
          insert into relay_managed_endpoint_allocations
            (user_id, environment_id, hostname, tunnel_name, created_at, updated_at)
          select ${key.userId}, ${key.environmentId}, ${key.hostname}, ${key.tunnelName}, ${now}, ${now}
          where ${fitsCaps}
          on conflict do nothing
          returning user_id
        `),
        RelayDb.rawQuery(sql`
          select count(*) as live from relay_managed_endpoint_allocations a
          where a.user_id = ${key.userId}
            and a.environment_id = ${key.environmentId}
            and ${liveManagedLink}
        `),
      ]).pipe(Effect.mapError(reserveError));
      const claimed =
        (results[0]?.length ?? 0) > 0 ||
        (results[1]?.length ?? 0) > 0 ||
        Number(results[2]?.[0]?.live ?? 0) > 0;

      if (claimed) {
        const allocation = yield* db
          .select(allocationSelection)
          .from(relayManagedEndpointAllocations)
          .where(whereAllocation(key))
          .limit(1)
          .pipe(
            Effect.map((rows) => rows[0]),
            Effect.mapError(reserveError),
          );
        if (allocation !== undefined) {
          return allocation;
        }
      } else {
        // Nothing was claimed: report which cap refused it. A read here is
        // only for the error; it never decides whether to write.
        const counted = yield* RelayDb.batch(db, [
          RelayDb.rawQuery(
            sql`select ${accountSlotCount(key, inFlightSince)} as account_count, ${globalSlotCount(key, inFlightSince)} as global_count`,
          ),
        ]).pipe(Effect.mapError(reserveError));
        const accountCount = Number(counted[0]?.[0]?.account_count ?? 0);
        const globalCount = Number(counted[0]?.[0]?.global_count ?? 0);
        if (capacity.maxTunnels !== null && accountCount >= capacity.maxTunnels) {
          return yield* new ManagedTunnelLimitExceeded({
            userId: key.userId,
            environmentId: key.environmentId,
            reason: "account_limit",
            maxTunnels: capacity.maxTunnels,
            activeTunnels: accountCount,
          });
        }
        if (capacity.globalCap !== undefined && globalCount >= capacity.globalCap) {
          return yield* new ManagedTunnelLimitExceeded({
            userId: key.userId,
            environmentId: key.environmentId,
            reason: "service_capacity",
            // An unlimited account reports the global cap it hit instead.
            maxTunnels: capacity.maxTunnels ?? capacity.globalCap,
            activeTunnels: accountCount,
            globalCap: capacity.globalCap,
            globalActiveTunnels: globalCount,
          });
        }
      }

      return yield* new ManagedEndpointAllocationPersistenceError({
        operation: "reserve",
        stage: "resolve-reservation",
        ...key,
      });
    }),
    recordTunnel: Effect.fn("relay.managed_endpoint_allocations.record_tunnel")(function* (
      input: RecordManagedEndpointTunnelInput,
    ) {
      return yield* db
        .update(relayManagedEndpointAllocations)
        .set({
          tunnelId: input.tunnelId,
          readyAt: sql`case when ${relayManagedEndpointAllocations.tunnelId} = ${input.tunnelId} then ${relayManagedEndpointAllocations.readyAt} else null end`,
          origin: sql`case when ${relayManagedEndpointAllocations.tunnelId} = ${input.tunnelId} then ${relayManagedEndpointAllocations.origin} else null end`,
          // Recovery registration is per tunnel: a replacement must register
          // again before the reaper may treat it as recoverable.
          recoveryEnabledAt: sql`case when ${relayManagedEndpointAllocations.tunnelId} = ${input.tunnelId} then ${relayManagedEndpointAllocations.recoveryEnabledAt} else null end`,
          recoveryEnvironmentPublicKey: sql`case when ${relayManagedEndpointAllocations.tunnelId} = ${input.tunnelId} then ${relayManagedEndpointAllocations.recoveryEnvironmentPublicKey} else null end`,
          tunnelReleasedAt: null,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
          generation: sql`${relayManagedEndpointAllocations.generation} + 1`,
        })
        .where(
          and(
            whereAllocation(input),
            eq(relayManagedEndpointAllocations.generation, input.generation),
          ),
        )
        .returning({ generation: relayManagedEndpointAllocations.generation })
        .pipe(
          Effect.map((rows) => rows[0]?.generation ?? null),
          Effect.mapError(
            (cause) =>
              new ManagedEndpointAllocationPersistenceError({
                operation: "record-tunnel",
                stage: "database-request",
                ...input,
                cause,
              }),
          ),
        );
    }),
    recordDns: Effect.fn("relay.managed_endpoint_allocations.record_dns")(function* (
      input: RecordManagedEndpointDnsInput,
    ) {
      return yield* db
        .update(relayManagedEndpointAllocations)
        .set({
          dnsRecordId: input.dnsRecordId,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
          generation: sql`${relayManagedEndpointAllocations.generation} + 1`,
        })
        .where(
          and(
            whereAllocation(input),
            eq(relayManagedEndpointAllocations.tunnelId, input.tunnelId),
            eq(relayManagedEndpointAllocations.generation, input.generation),
          ),
        )
        .returning({ generation: relayManagedEndpointAllocations.generation })
        .pipe(
          Effect.map((rows) => rows[0]?.generation ?? null),
          Effect.mapError(
            (cause) =>
              new ManagedEndpointAllocationPersistenceError({
                operation: "record-dns",
                stage: "database-request",
                ...input,
                cause,
              }),
          ),
        );
    }),
    markReady: Effect.fn("relay.managed_endpoint_allocations.mark_ready")(function* (
      input: MarkManagedEndpointReadyInput,
    ) {
      const now = DateTime.formatIso(yield* DateTime.now);
      return yield* db
        .update(relayManagedEndpointAllocations)
        .set({
          readyAt: now,
          origin: input.origin,
          updatedAt: now,
          generation: sql`${relayManagedEndpointAllocations.generation} + 1`,
        })
        .where(
          and(
            whereAllocation(input),
            eq(relayManagedEndpointAllocations.tunnelId, input.tunnelId),
            eq(relayManagedEndpointAllocations.generation, input.generation),
          ),
        )
        .returning({ environmentId: relayManagedEndpointAllocations.environmentId })
        .pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.mapError(
            (cause) =>
              new ManagedEndpointAllocationPersistenceError({
                operation: "mark-ready",
                stage: "database-request",
                ...input,
                cause,
              }),
          ),
        );
    }),
    enableRecovery: Effect.fn("relay.managed_endpoint_allocations.enable_recovery")(function* (
      input: EnableManagedEndpointRecoveryInput,
    ) {
      const now = DateTime.formatIso(yield* DateTime.now);
      return yield* db
        .update(relayManagedEndpointAllocations)
        .set({
          recoveryEnabledAt: now,
          recoveryEnvironmentPublicKey: input.environmentPublicKey,
          updatedAt: now,
          generation: sql`${relayManagedEndpointAllocations.generation} + 1`,
        })
        .where(
          and(
            whereAllocation(input),
            eq(relayManagedEndpointAllocations.tunnelId, input.tunnelId),
            // JSON text equality depends on key order; compare the fields.
            sql`json_extract(${relayManagedEndpointAllocations.origin}, '$.localHttpHost') = ${input.origin.localHttpHost}`,
            sql`json_extract(${relayManagedEndpointAllocations.origin}, '$.localHttpPort') = ${input.origin.localHttpPort}`,
            // One UPDATE statement is atomic in D1, so the link check and the
            // write cannot interleave with a concurrent revoke.
            exists(
              new QueryBuilder()
                .select({ userId: relayEnvironmentLinks.userId })
                .from(relayEnvironmentLinks)
                .where(
                  and(
                    eq(relayEnvironmentLinks.userId, input.userId),
                    eq(relayEnvironmentLinks.environmentId, input.environmentId),
                    eq(relayEnvironmentLinks.environmentPublicKey, input.environmentPublicKey),
                    eq(relayEnvironmentLinks.endpointProviderKind, "cloudflare_tunnel"),
                    isNull(relayEnvironmentLinks.revokedAt),
                  ),
                ),
            ),
          ),
        )
        .returning({ environmentId: relayManagedEndpointAllocations.environmentId })
        .pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.mapError(
            (cause) =>
              new ManagedEndpointAllocationPersistenceError({
                operation: "enable-recovery",
                stage: "database-request",
                ...input,
                cause,
              }),
          ),
        );
    }),
    listByTunnelNames: Effect.fn("relay.managed_endpoint_allocations.list_by_tunnel_names")(
      function* (tunnelNames: ReadonlyArray<string>) {
        if (tunnelNames.length === 0) {
          return [];
        }
        const batches = Array.from(
          { length: Math.ceil(tunnelNames.length / MANAGED_ENDPOINT_ALLOCATION_LOOKUP_BATCH_SIZE) },
          (_, index) =>
            tunnelNames.slice(
              index * MANAGED_ENDPOINT_ALLOCATION_LOOKUP_BATCH_SIZE,
              (index + 1) * MANAGED_ENDPOINT_ALLOCATION_LOOKUP_BATCH_SIZE,
            ),
        );
        const results = yield* Effect.forEach(
          batches,
          (batch) =>
            db
              .select({
                ...allocationSelection,
                recoveryEnabledAt: relayManagedEndpointAllocations.recoveryEnabledAt,
                recoveryEnvironmentPublicKey:
                  relayManagedEndpointAllocations.recoveryEnvironmentPublicKey,
                linkedEnvironmentPublicKey: relayEnvironmentLinks.environmentPublicKey,
              })
              .from(relayManagedEndpointAllocations)
              .leftJoin(
                relayEnvironmentLinks,
                and(
                  eq(relayEnvironmentLinks.userId, relayManagedEndpointAllocations.userId),
                  eq(
                    relayEnvironmentLinks.environmentId,
                    relayManagedEndpointAllocations.environmentId,
                  ),
                  isNull(relayEnvironmentLinks.revokedAt),
                ),
              )
              .where(inArray(relayManagedEndpointAllocations.tunnelName, batch))
              .pipe(
                Effect.map((rows) =>
                  rows.map(
                    ({
                      recoveryEnabledAt,
                      recoveryEnvironmentPublicKey,
                      linkedEnvironmentPublicKey,
                      ...allocation
                    }) => ({
                      ...allocation,
                      recoveryEnabled:
                        recoveryEnabledAt !== null &&
                        recoveryEnvironmentPublicKey !== null &&
                        recoveryEnvironmentPublicKey === linkedEnvironmentPublicKey,
                    }),
                  ),
                ),
                Effect.mapError(
                  (cause) =>
                    new ManagedEndpointAllocationPersistenceError({
                      operation: "list-tunnels",
                      stage: "database-request",
                      userId: "*",
                      environmentId: "*",
                      cause,
                    }),
                ),
              ),
          { concurrency: 1 },
        );
        return results.flat();
      },
    ),
    claimRelease: Effect.fn("relay.managed_endpoint_allocations.claim_release")(function* (
      input: ClaimManagedEndpointReleaseInput,
    ) {
      const now = DateTime.formatIso(yield* DateTime.now);
      const claimed = yield* db
        .update(relayManagedEndpointAllocations)
        .set({
          updatedAt: now,
          generation: sql`${relayManagedEndpointAllocations.generation} + 1`,
          ...(input.markReleased === true ? { tunnelReleasedAt: now } : {}),
        })
        .where(
          and(
            whereAllocation(input),
            eq(relayManagedEndpointAllocations.tunnelId, input.tunnelId),
            eq(relayManagedEndpointAllocations.generation, input.generation),
          ),
        )
        .returning({ generation: relayManagedEndpointAllocations.generation })
        .pipe(
          Effect.map((rows) => rows[0]?.generation ?? null),
          Effect.mapError(
            (cause) =>
              new ManagedEndpointAllocationPersistenceError({
                operation: "claim-release",
                stage: "database-request",
                userId: input.userId,
                environmentId: input.environmentId,
                tunnelId: input.tunnelId,
                cause,
              }),
          ),
        );
      return claimed;
    }),
    withClaimedTunnel: Effect.fn("relay.managed_endpoint_allocations.with_claimed_tunnel")(
      function* <A, E, R>(
        input: ClaimManagedEndpointReleaseInput,
        effect: Effect.Effect<A, E, R>,
      ): Effect.fn.Return<Option.Option<A>, E | ManagedEndpointAllocationPersistenceError, R> {
        const lockError = (cause: unknown) =>
          new ManagedEndpointAllocationPersistenceError({
            operation: "lock-tunnel",
            stage: "database-request",
            userId: input.userId,
            environmentId: input.environmentId,
            tunnelId: input.tunnelId,
            cause,
          });
        // D1 has no row locks. Check that the claim is still current, then run
        // the effect. Its writes are conditional on this same generation and
        // bump it, so a competing claim that ran concurrently loses its write.
        const rows = yield* db
          .select({ generation: relayManagedEndpointAllocations.generation })
          .from(relayManagedEndpointAllocations)
          .where(
            and(
              whereAllocation(input),
              eq(relayManagedEndpointAllocations.tunnelId, input.tunnelId),
              eq(relayManagedEndpointAllocations.generation, input.generation),
            ),
          )
          .limit(1)
          .pipe(Effect.mapError(lockError));
        return rows.length === 0 ? Option.none() : Option.some(yield* effect);
      },
    ),
    claimDeprovision: Effect.fn("relay.managed_endpoint_allocations.claim_deprovision")(function* (
      input: ClaimManagedEndpointDeprovisionInput,
    ) {
      const claimed = yield* db
        .update(relayManagedEndpointAllocations)
        .set({
          updatedAt: DateTime.formatIso(yield* DateTime.now),
          generation: sql`${relayManagedEndpointAllocations.generation} + 1`,
        })
        .where(
          and(
            whereAllocation(input),
            eq(relayManagedEndpointAllocations.generation, input.generation),
          ),
        )
        .returning({ generation: relayManagedEndpointAllocations.generation })
        .pipe(
          Effect.map((rows) => rows[0]?.generation ?? null),
          Effect.mapError(
            (cause) =>
              new ManagedEndpointAllocationPersistenceError({
                operation: "claim-deprovision",
                stage: "database-request",
                userId: input.userId,
                environmentId: input.environmentId,
                cause,
              }),
          ),
        );
      return claimed;
    }),
    remove: Effect.fn("relay.managed_endpoint_allocations.remove")(function* (
      input: ManagedEndpointAllocationKey,
    ) {
      yield* db
        .delete(relayManagedEndpointAllocations)
        .where(whereAllocation(input))
        .pipe(
          Effect.mapError(
            (cause) =>
              new ManagedEndpointAllocationPersistenceError({
                operation: "remove",
                stage: "database-request",
                ...input,
                cause,
              }),
          ),
        );
    }),
    removeClaimed: Effect.fn("relay.managed_endpoint_allocations.remove_claimed")(function* (
      input: RemoveClaimedManagedEndpointAllocationInput,
    ) {
      return yield* db
        .delete(relayManagedEndpointAllocations)
        .where(
          and(
            whereAllocation(input),
            eq(relayManagedEndpointAllocations.generation, input.generation),
          ),
        )
        .returning({ userId: relayManagedEndpointAllocations.userId })
        .pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.mapError(
            (cause) =>
              new ManagedEndpointAllocationPersistenceError({
                operation: "remove-claimed",
                stage: "database-request",
                userId: input.userId,
                environmentId: input.environmentId,
                cause,
              }),
          ),
        );
    }),
  });
});

export const layer = Layer.effect(ManagedEndpointAllocations, make);
