import {
  RelayMobileClientId,
  type RelayPhoneRecord,
  type RelayPublicClientId,
} from "@specweave-studio/contracts/relay";
import { and, desc, eq, inArray, isNotNull, or, sql, type SQL } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as RelayDb from "../db.ts";
import {
  relayClientKeys,
  relayLiveActivities,
  relayMobileDeviceRemovals,
  relayMobileDevices,
} from "../persistence/schema.ts";

export class PhoneRemovalPersistenceError extends Schema.TaggedError<PhoneRemovalPersistenceError>()(
  "PhoneRemovalPersistenceError",
  {
    userId: Schema.String,
    stage: Schema.Literals([
      "find-blocking",
      "record-key",
      "resolve-devices",
      "resolve-keys",
      "list-removals",
      "remove",
      "clear",
      "list-thumbprints",
      "list-phones",
      "backfill",
      "key-status",
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.stage} phone removals for ${this.userId}.`;
  }
}

export interface PhoneRemovalRecord {
  readonly id: string;
  readonly deviceId: string | null;
  readonly proofKeyThumbprint: string | null;
  readonly clerkSessionId: string | null;
  readonly label: string | null;
  readonly removedAt: string;
}

/** A phone named by its device id, its DPoP key thumbprint, or both. */
export interface PhoneSelector {
  readonly userId: string;
  readonly deviceId?: string | undefined;
  readonly proofKeyThumbprint?: string | undefined;
}

/** A request's view of a phone: also the Clerk session it uses, when known. */
export interface PhoneRequestSelector extends PhoneSelector {
  readonly clerkSessionId?: string | undefined;
}

export interface PhoneRemovalResult {
  /** False only when the account has no such phone and never removed it. */
  readonly removed: boolean;
  /** Clerk sessions the removed phones last used, to end them. */
  readonly clerkSessionIds: ReadonlyArray<string>;
  /** DPoP keys of the removed phones, for linked environments to revoke. */
  readonly proofKeyThumbprints: ReadonlyArray<string>;
}

export class PhoneRemovals extends Context.Service<
  PhoneRemovals,
  {
    /**
     * The newest removal matching the phone's device id, DPoP key or Clerk
     * session, if any.
     */
    readonly findBlocking: (
      input: PhoneRequestSelector,
    ) => Effect.Effect<PhoneRemovalRecord | null, PhoneRemovalPersistenceError>;
    /** Whether any account removed the phone holding this DPoP key. */
    readonly isKeyRemoved: (input: {
      readonly proofKeyThumbprint: string;
    }) => Effect.Effect<boolean, PhoneRemovalPersistenceError>;
    /**
     * Remembers which client, device and Clerk session a DPoP key was
     * exchanged for. One upsert per token exchange.
     */
    readonly recordClientKey: (input: {
      readonly userId: string;
      readonly proofKeyThumbprint: string;
      readonly clientId: RelayPublicClientId;
      readonly deviceId?: string | undefined;
      readonly clerkSessionId?: string | undefined;
    }) => Effect.Effect<void, PhoneRemovalPersistenceError>;
    /**
     * Records a removal for each matching phone, registered or known only by
     * the keys it exchanged, with every key and Clerk session it used, and
     * deletes its registrations, Live Activities and key records, so pushes
     * stop. With `onlyPhones`, a key that belongs to no phone (a browser's)
     * is left alone; otherwise a key nothing names gets a key-only removal.
     * Idempotent.
     */
    readonly remove: (
      input: PhoneSelector & { readonly onlyPhones?: boolean | undefined },
    ) => Effect.Effect<PhoneRemovalResult, PhoneRemovalPersistenceError>;
    /**
     * Fills in a removal's missing device id, key or Clerk session the first
     * time the removed phone presents them.
     */
    readonly backfill: (input: {
      readonly userId: string;
      readonly removalId: string;
      readonly deviceId?: string | undefined;
      readonly proofKeyThumbprint?: string | undefined;
      readonly clerkSessionId?: string | undefined;
    }) => Effect.Effect<void, PhoneRemovalPersistenceError>;
    /** Deletes the removals matching the phone's device id, DPoP key or Clerk session. */
    readonly clear: (
      input: PhoneRequestSelector,
    ) => Effect.Effect<void, PhoneRemovalPersistenceError>;
    readonly listRemovedThumbprints: (input: {
      readonly userId: string;
    }) => Effect.Effect<ReadonlyArray<string>, PhoneRemovalPersistenceError>;
    /**
     * The account's phones; `current` marks the caller's: a registration
     * using `clerkSessionId`, or holding its DPoP key or the key of one that
     * does (a reinstalled app keeps its key under a new device id).
     */
    readonly listPhones: (input: {
      readonly userId: string;
      readonly clerkSessionId?: string | undefined;
      readonly proofKeyThumbprint?: string | undefined;
    }) => Effect.Effect<ReadonlyArray<RelayPhoneRecord>, PhoneRemovalPersistenceError>;
  }
>()("studio-relay/agentActivity/PhoneRemovals") {}

const unique = <A>(values: ReadonlyArray<A | null | undefined>): Array<A> => [
  ...new Set(values.filter((value): value is A => value !== null && value !== undefined)),
];

const removalMatch = (input: PhoneRequestSelector): SQL | undefined => {
  const keys = [
    ...(input.deviceId ? [eq(relayMobileDeviceRemovals.deviceId, input.deviceId)] : []),
    ...(input.proofKeyThumbprint
      ? [eq(relayMobileDeviceRemovals.proofKeyThumbprint, input.proofKeyThumbprint)]
      : []),
    ...(input.clerkSessionId
      ? [eq(relayMobileDeviceRemovals.clerkSessionId, input.clerkSessionId)]
      : []),
  ];
  return keys.length === 0
    ? undefined
    : and(eq(relayMobileDeviceRemovals.userId, input.userId), or(...keys));
};

const removalColumns = {
  id: relayMobileDeviceRemovals.id,
  deviceId: relayMobileDeviceRemovals.deviceId,
  proofKeyThumbprint: relayMobileDeviceRemovals.proofKeyThumbprint,
  clerkSessionId: relayMobileDeviceRemovals.clerkSessionId,
  label: relayMobileDeviceRemovals.label,
  removedAt: relayMobileDeviceRemovals.removedAt,
};

export const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const crypto = yield* Crypto.Crypto;
  const fail = (userId: string, stage: PhoneRemovalPersistenceError["stage"]) => (cause: unknown) =>
    new PhoneRemovalPersistenceError({ userId, stage, cause });

  // The drizzle handle is alchemy's lazy proxy chain: every db chain below is
  // consumed with `yield*`, never handed to Effect.all (see Devices.ts).
  const findDevices = Effect.fnUntraced(function* (input: {
    readonly userId: string;
    readonly deviceIds: ReadonlyArray<string>;
    readonly proofKeyThumbprints: ReadonlyArray<string>;
  }) {
    const keys = [
      ...(input.deviceIds.length > 0
        ? [inArray(relayMobileDevices.deviceId, [...input.deviceIds])]
        : []),
      ...(input.proofKeyThumbprints.length > 0
        ? [inArray(relayMobileDevices.proofKeyThumbprint, [...input.proofKeyThumbprints])]
        : []),
    ];
    if (keys.length === 0) return [];
    return yield* db
      .select({
        deviceId: relayMobileDevices.deviceId,
        label: relayMobileDevices.label,
        proofKeyThumbprint: relayMobileDevices.proofKeyThumbprint,
        clerkSessionId: relayMobileDevices.clerkSessionId,
      })
      .from(relayMobileDevices)
      .where(and(eq(relayMobileDevices.userId, input.userId), or(...keys)))
      .pipe(Effect.mapError(fail(input.userId, "resolve-devices")));
  });

  const findKeys = Effect.fnUntraced(function* (input: {
    readonly userId: string;
    readonly deviceIds: ReadonlyArray<string>;
    readonly proofKeyThumbprints: ReadonlyArray<string>;
  }) {
    const keys = [
      ...(input.deviceIds.length > 0
        ? [inArray(relayClientKeys.deviceId, [...input.deviceIds])]
        : []),
      ...(input.proofKeyThumbprints.length > 0
        ? [inArray(relayClientKeys.proofKeyThumbprint, [...input.proofKeyThumbprints])]
        : []),
    ];
    if (keys.length === 0) return [];
    return yield* db
      .select({
        proofKeyThumbprint: relayClientKeys.proofKeyThumbprint,
        clientId: relayClientKeys.clientId,
        deviceId: relayClientKeys.deviceId,
        clerkSessionId: relayClientKeys.clerkSessionId,
        lastSeenAt: relayClientKeys.lastSeenAt,
      })
      .from(relayClientKeys)
      .where(and(eq(relayClientKeys.userId, input.userId), or(...keys)))
      .orderBy(desc(relayClientKeys.lastSeenAt))
      .pipe(Effect.mapError(fail(input.userId, "resolve-keys")));
  });

  const listMatchingRemovals = Effect.fnUntraced(function* (input: PhoneSelector) {
    const match = removalMatch(input);
    if (!match) return [];
    return yield* db
      .select(removalColumns)
      .from(relayMobileDeviceRemovals)
      .where(match)
      .orderBy(desc(relayMobileDeviceRemovals.removedAt))
      .pipe(Effect.mapError(fail(input.userId, "list-removals")));
  });

  return PhoneRemovals.of({
    findBlocking: Effect.fn("relay.phone_removals.find_blocking")(function* (input) {
      const match = removalMatch(input);
      if (!match) return null;
      const rows = yield* db
        .select(removalColumns)
        .from(relayMobileDeviceRemovals)
        .where(match)
        .orderBy(desc(relayMobileDeviceRemovals.removedAt))
        .limit(1)
        .pipe(Effect.mapError(fail(input.userId, "find-blocking")));
      return rows[0] ?? null;
    }),
    isKeyRemoved: Effect.fn("relay.phone_removals.is_key_removed")(function* (input) {
      const rows = yield* db
        .select({ id: relayMobileDeviceRemovals.id })
        .from(relayMobileDeviceRemovals)
        .where(eq(relayMobileDeviceRemovals.proofKeyThumbprint, input.proofKeyThumbprint))
        .limit(1)
        .pipe(Effect.mapError(fail("*", "key-status")));
      return rows.length > 0;
    }),
    recordClientKey: Effect.fn("relay.phone_removals.record_client_key")(function* (input) {
      const lastSeenAt = DateTime.formatIso(yield* DateTime.now);
      yield* db
        .insert(relayClientKeys)
        .values({
          userId: input.userId,
          proofKeyThumbprint: input.proofKeyThumbprint,
          clientId: input.clientId,
          deviceId: input.deviceId ?? null,
          clerkSessionId: input.clerkSessionId ?? null,
          lastSeenAt,
        })
        .onConflictDoUpdate({
          target: [relayClientKeys.userId, relayClientKeys.proofKeyThumbprint],
          set: {
            clientId: input.clientId,
            deviceId: sql`coalesce(excluded.device_id, ${relayClientKeys.deviceId})`,
            clerkSessionId: sql`coalesce(excluded.clerk_session_id, ${relayClientKeys.clerkSessionId})`,
            lastSeenAt,
          },
        })
        .pipe(Effect.mapError(fail(input.userId, "record-key")));
    }),
    remove: Effect.fn("relay.phone_removals.remove")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.phone_removal.by_device_id": input.deviceId !== undefined,
        "relay.phone_removal.by_key": input.proofKeyThumbprint !== undefined,
      });
      const named = yield* findDevices({
        userId: input.userId,
        deviceIds: unique([input.deviceId]),
        proofKeyThumbprints: unique([input.proofKeyThumbprint]),
      });
      // Every key the phone exchanged, by its device id or the named key.
      const phoneKeys = (yield* findKeys({
        userId: input.userId,
        deviceIds: unique([input.deviceId, ...named.map((device) => device.deviceId)]),
        proofKeyThumbprints: unique([
          input.proofKeyThumbprint,
          ...named.map((device) => device.proofKeyThumbprint),
        ]),
      })).filter((key) => key.clientId === RelayMobileClientId);
      // A reinstalled app keeps its Keychain DPoP key under a new device id:
      // every registration holding one of the phone's keys is the same phone.
      const keys = unique([
        ...named.map((device) => device.proofKeyThumbprint),
        ...phoneKeys.map((key) => key.proofKeyThumbprint),
      ]);
      const knownDeviceIds = unique([
        ...named.map((device) => device.deviceId),
        ...phoneKeys.map((key) => key.deviceId),
      ]);
      const devices =
        keys.length === 0 && knownDeviceIds.length === named.length
          ? named
          : yield* findDevices({
              userId: input.userId,
              deviceIds: knownDeviceIds,
              proofKeyThumbprints: keys,
            });
      const prior = yield* listMatchingRemovals(input);
      if (
        input.onlyPhones &&
        devices.length === 0 &&
        phoneKeys.length === 0 &&
        prior.length === 0
      ) {
        // Another browser over Connect, or a key the relay never saw a phone use.
        return { removed: false, clerkSessionIds: [], proofKeyThumbprints: [] };
      }
      const removedAt = DateTime.formatIso(yield* DateTime.now);
      const rows: Array<typeof relayMobileDeviceRemovals.$inferInsert> = [];
      const seen = new Set<string>();
      const addRow = Effect.fnUntraced(function* (row: {
        readonly deviceId: string | null;
        readonly proofKeyThumbprint: string | null;
        readonly clerkSessionId: string | null;
        readonly label: string | null;
      }) {
        const key = [row.deviceId, row.proofKeyThumbprint, row.clerkSessionId].join("\u0000");
        if (seen.has(key)) return;
        seen.add(key);
        rows.push({
          id: yield* crypto.randomUUIDv4.pipe(Effect.mapError(fail(input.userId, "remove"))),
          userId: input.userId,
          ...row,
          removedAt,
        });
      });
      for (const device of devices) {
        // A registration made before keys were recorded on it borrows the
        // newest key its device id exchanged.
        const latest = phoneKeys.find((key) => key.deviceId === device.deviceId);
        yield* addRow({
          deviceId: device.deviceId,
          proofKeyThumbprint: device.proofKeyThumbprint ?? latest?.proofKeyThumbprint ?? null,
          clerkSessionId: device.clerkSessionId ?? latest?.clerkSessionId ?? null,
          label: device.label,
        });
      }
      for (const key of phoneKeys) {
        yield* addRow({
          deviceId: key.deviceId,
          proofKeyThumbprint: key.proofKeyThumbprint,
          clerkSessionId: key.clerkSessionId,
          label: devices.find((device) => device.deviceId === key.deviceId)?.label ?? null,
        });
      }
      if (
        rows.length === 0 &&
        prior.length === 0 &&
        input.proofKeyThumbprint &&
        !input.onlyPhones
      ) {
        // Refuse a key no registration or exchange names.
        yield* addRow({
          deviceId: null,
          proofKeyThumbprint: input.proofKeyThumbprint,
          clerkSessionId: null,
          label: null,
        });
      }
      if (rows.length > 0) {
        const deviceIds = devices.map((device) => device.deviceId);
        const removedKeys = unique(rows.map((row) => row.proofKeyThumbprint));
        // One batch: the removal is recorded exactly when the phone stops
        // receiving pushes.
        yield* RelayDb.batch(db, [
          db.insert(relayMobileDeviceRemovals).values(rows),
          ...(deviceIds.length > 0
            ? [
                db
                  .delete(relayLiveActivities)
                  .where(
                    and(
                      eq(relayLiveActivities.userId, input.userId),
                      inArray(relayLiveActivities.deviceId, deviceIds),
                    ),
                  ),
                db
                  .delete(relayMobileDevices)
                  .where(
                    and(
                      eq(relayMobileDevices.userId, input.userId),
                      inArray(relayMobileDevices.deviceId, deviceIds),
                    ),
                  ),
              ]
            : []),
          ...(removedKeys.length > 0
            ? [
                db
                  .delete(relayClientKeys)
                  .where(
                    and(
                      eq(relayClientKeys.userId, input.userId),
                      inArray(relayClientKeys.proofKeyThumbprint, removedKeys),
                    ),
                  ),
              ]
            : []),
        ]).pipe(Effect.mapError(fail(input.userId, "remove")));
      }
      const all = [...rows, ...prior];
      return {
        removed: all.length > 0,
        clerkSessionIds: unique(all.map((row) => row.clerkSessionId)),
        proofKeyThumbprints: unique(all.map((row) => row.proofKeyThumbprint)),
      };
    }),
    backfill: Effect.fn("relay.phone_removals.backfill")(function* (input) {
      const set = {
        ...(input.deviceId
          ? {
              deviceId: sql`coalesce(${relayMobileDeviceRemovals.deviceId}, ${input.deviceId})`,
            }
          : {}),
        ...(input.proofKeyThumbprint
          ? {
              proofKeyThumbprint: sql`coalesce(${relayMobileDeviceRemovals.proofKeyThumbprint}, ${input.proofKeyThumbprint})`,
            }
          : {}),
        ...(input.clerkSessionId
          ? {
              clerkSessionId: sql`coalesce(${relayMobileDeviceRemovals.clerkSessionId}, ${input.clerkSessionId})`,
            }
          : {}),
      };
      if (Object.keys(set).length === 0) return;
      yield* db
        .update(relayMobileDeviceRemovals)
        .set(set)
        .where(
          and(
            eq(relayMobileDeviceRemovals.userId, input.userId),
            eq(relayMobileDeviceRemovals.id, input.removalId),
          ),
        )
        .pipe(Effect.mapError(fail(input.userId, "backfill")));
    }),
    clear: Effect.fn("relay.phone_removals.clear")(function* (input) {
      const match = removalMatch(input);
      if (!match) return;
      yield* db
        .delete(relayMobileDeviceRemovals)
        .where(match)
        .pipe(Effect.mapError(fail(input.userId, "clear")));
    }),
    listRemovedThumbprints: Effect.fn("relay.phone_removals.list_removed_thumbprints")(
      function* (input) {
        const rows = yield* db
          .selectDistinct({ proofKeyThumbprint: relayMobileDeviceRemovals.proofKeyThumbprint })
          .from(relayMobileDeviceRemovals)
          .where(
            and(
              eq(relayMobileDeviceRemovals.userId, input.userId),
              isNotNull(relayMobileDeviceRemovals.proofKeyThumbprint),
            ),
          )
          .pipe(Effect.mapError(fail(input.userId, "list-thumbprints")));
        return unique(rows.map((row) => row.proofKeyThumbprint)).sort();
      },
    ),
    listPhones: Effect.fn("relay.phone_removals.list_phones")(function* (input) {
      const rows = yield* db
        .select({
          deviceId: relayMobileDevices.deviceId,
          label: relayMobileDevices.label,
          platform: relayMobileDevices.platform,
          model: relayMobileDevices.model,
          appVersion: relayMobileDevices.appVersion,
          iosMajorVersion: relayMobileDevices.iosMajorVersion,
          bundleId: relayMobileDevices.bundleId,
          proofKeyThumbprint: relayMobileDevices.proofKeyThumbprint,
          clerkSessionId: relayMobileDevices.clerkSessionId,
          lastSeenAt: relayMobileDevices.lastSeenAt,
          updatedAt: relayMobileDevices.updatedAt,
        })
        .from(relayMobileDevices)
        .where(eq(relayMobileDevices.userId, input.userId))
        .pipe(Effect.mapError(fail(input.userId, "list-phones")));
      const usesSession = (row: (typeof rows)[number]) =>
        input.clerkSessionId !== undefined &&
        row.clerkSessionId !== null &&
        row.clerkSessionId === input.clerkSessionId;
      const currentKeys = new Set(
        unique([
          input.proofKeyThumbprint,
          ...rows.filter(usesSession).map((row) => row.proofKeyThumbprint),
        ]),
      );
      return rows
        .map((row) => ({
          deviceId: row.deviceId,
          label: row.label,
          platform: row.platform,
          model: row.model,
          appVersion: row.appVersion,
          iosMajorVersion: row.iosMajorVersion,
          bundleId: row.bundleId,
          lastSeenAt: row.lastSeenAt ?? row.updatedAt,
          current:
            usesSession(row) ||
            (row.proofKeyThumbprint !== null && currentKeys.has(row.proofKeyThumbprint)),
        }))
        .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));
    }),
  });
});

export const layer = Layer.effect(PhoneRemovals, make);
