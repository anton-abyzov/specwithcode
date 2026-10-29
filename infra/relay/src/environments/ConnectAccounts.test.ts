import { describe, expect, it } from "@effect/vitest";
import { eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as AccountDeletion from "../account/AccountDeletion.ts";
import * as RelayDb from "../db.ts";
import {
  relayAccountDeletions,
  relayConnectAccounts,
  relayConnectPromos,
  relayEnvironmentLinks,
} from "../persistence/schema.ts";
import { layerSqliteRelayDb } from "../testing/sqliteD1.ts";
import * as ConnectAccounts from "./ConnectAccounts.ts";

const layer = () =>
  Layer.mergeAll(ConnectAccounts.layer, AccountDeletion.layerAccountRecords).pipe(
    Layer.provideMerge(layerSqliteRelayDb()),
  );

const setPromo = (values: Partial<typeof relayConnectPromos.$inferInsert>) =>
  Effect.gen(function* () {
    const db = yield* RelayDb.RelayDb;
    yield* db
      .update(relayConnectPromos)
      .set(values)
      .where(eq(relayConnectPromos.id, ConnectAccounts.FOUNDERS_PROMO_ID));
  });

const now = "2026-10-28T00:00:00.000Z";

/** ensureAccount runs after a managed link succeeded, so give the user one. */
const linkManaged = (userId: string, managedTunnelsEnabled = true) =>
  Effect.gen(function* () {
    const db = yield* RelayDb.RelayDb;
    yield* db
      .insert(relayEnvironmentLinks)
      .values({
        userId,
        environmentId: "env-1",
        environmentPublicKey: "key",
        endpointHttpBaseUrl: "https://example.test",
        endpointWsBaseUrl: "wss://example.test",
        endpointProviderKind: "managed",
        managedTunnelsEnabled,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
  });

const ensureOnly = (userId: string) =>
  Effect.gen(function* () {
    const accounts = yield* ConnectAccounts.ConnectAccounts;
    return yield* accounts.ensureAccount({ userId });
  });

const ensure = (userId: string) => linkManaged(userId).pipe(Effect.andThen(ensureOnly(userId)));

const summary = Effect.gen(function* () {
  const accounts = yield* ConnectAccounts.ConnectAccounts;
  return yield* accounts.foundersSummary();
});

describe("ConnectAccounts", () => {
  it.effect("seeds the Founding 1,000 promo with 10 machines and open grants", () =>
    Effect.gen(function* () {
      const db = yield* RelayDb.RelayDb;
      const [promo] = yield* db.select().from(relayConnectPromos);
      expect(promo).toMatchObject({
        id: "founders",
        seatCap: 1000,
        seatsGranted: 0,
        founderTunnelLimit: 10,
        grantsOpen: true,
      });
      expect(yield* summary).toEqual({
        seatCap: 1000,
        seatsGranted: 0,
        seatsLeft: 1000,
        grantsOpen: true,
      });
    }).pipe(Effect.provide(layer())),
  );

  it.effect("grants founder numbers in signup order and keeps them on later links", () =>
    Effect.gen(function* () {
      const first = yield* ensure("user-a");
      const second = yield* ensure("user-b");
      expect(first).toMatchObject({ userId: "user-a", promoId: "founders", founderNumber: 1 });
      expect(second).toMatchObject({ userId: "user-b", promoId: "founders", founderNumber: 2 });

      const again = yield* ensure("user-a");
      expect(again).toEqual(first);
      expect(yield* summary).toMatchObject({ seatsGranted: 2, seatsLeft: 998 });
    }).pipe(Effect.provide(layer())),
  );

  it.effect("stops granting at the seat cap without blocking account creation", () =>
    Effect.gen(function* () {
      yield* setPromo({ seatCap: 1 });
      expect((yield* ensure("user-a")).founderNumber).toBe(1);
      const late = yield* ensure("user-b");
      expect(late).toMatchObject({ userId: "user-b", promoId: null, founderNumber: null });
      expect(yield* summary).toEqual({
        seatCap: 1,
        seatsGranted: 1,
        seatsLeft: 0,
        grantsOpen: false,
      });
    }).pipe(Effect.provide(layer())),
  );

  it.effect("never exceeds the seat cap or shares a number under concurrent first links", () =>
    Effect.gen(function* () {
      yield* setPromo({ seatCap: 5 });
      const userIds = Array.from({ length: 40 }, (_, index) => `user-${index}`);
      // Every user links twice at once, so duplicate first links race too.
      const results = yield* Effect.forEach([...userIds, ...userIds], ensure, {
        concurrency: "unbounded",
      });
      const founderNumbers = new Map<string, number | null>();
      for (const result of results) {
        const previous = founderNumbers.get(result.userId);
        if (previous !== undefined) expect(result.founderNumber).toBe(previous);
        founderNumbers.set(result.userId, result.founderNumber);
      }
      const granted = [...founderNumbers.values()].filter((value) => value !== null);
      expect(granted.sort()).toEqual([1, 2, 3, 4, 5]);
      expect(yield* summary).toMatchObject({ seatsGranted: 5, seatsLeft: 0 });
    }).pipe(Effect.provide(layer())),
  );

  it.effect("closing grants stops new founders and keeps existing ones", () =>
    Effect.gen(function* () {
      const founder = yield* ensure("user-a");
      yield* setPromo({ grantsOpen: false });
      const late = yield* ensure("user-b");
      expect(late.founderNumber).toBeNull();
      expect(yield* ensure("user-a")).toEqual(founder);
      expect(yield* summary).toMatchObject({ seatsGranted: 1, grantsOpen: false });

      // After grants reopen, an account created while they were closed takes
      // the next seat on its next managed link.
      yield* setPromo({ grantsOpen: true });
      expect((yield* ensure("user-b")).founderNumber).toBe(2);
      expect((yield* ensure("user-c")).founderNumber).toBe(3);
      expect(yield* summary).toMatchObject({ seatsGranted: 3 });
    }).pipe(Effect.provide(layer())),
  );

  it.effect("deleting an account removes its row and never returns the seat", () =>
    Effect.gen(function* () {
      const db = yield* RelayDb.RelayDb;
      yield* ensure("user-a");
      yield* ensure("user-b");
      const records = yield* AccountDeletion.AccountRecords;
      yield* records.deleteUserRows({ userId: "user-a" });

      const remaining = yield* db
        .select({ userId: relayConnectAccounts.userId })
        .from(relayConnectAccounts);
      expect(remaining).toEqual([{ userId: "user-b" }]);
      expect(yield* summary).toMatchObject({ seatsGranted: 2, seatsLeft: 998 });
      expect((yield* ensure("user-c")).founderNumber).toBe(3);
    }).pipe(Effect.provide(layer())),
  );

  it.effect("reports no open seats when the promo row is missing", () =>
    Effect.gen(function* () {
      const db = yield* RelayDb.RelayDb;
      yield* db.delete(relayConnectPromos);
      expect(yield* summary).toEqual({
        seatCap: 0,
        seatsGranted: 0,
        seatsLeft: 0,
        grantsOpen: false,
      });
      expect(yield* ensure("user-a")).toMatchObject({ promoId: null, founderNumber: null });
    }).pipe(Effect.provide(layer())),
  );

  it.effect("creates no account and takes no seat without a live managed link", () =>
    Effect.gen(function* () {
      const db = yield* RelayDb.RelayDb;
      const noLink = yield* ensureOnly("user-a").pipe(Effect.flip);
      expect(noLink._tag).toBe("ConnectAccountPersistenceError");
      yield* linkManaged("user-b", false);
      const publishOnly = yield* ensureOnly("user-b").pipe(Effect.flip);
      expect(publishOnly._tag).toBe("ConnectAccountPersistenceError");
      expect(yield* db.select().from(relayConnectAccounts)).toEqual([]);
      expect(yield* summary).toMatchObject({ seatsGranted: 0 });
    }).pipe(Effect.provide(layer())),
  );

  it.effect("creates no account and takes no seat once deletion has started", () =>
    Effect.gen(function* () {
      const db = yield* RelayDb.RelayDb;
      yield* db.insert(relayAccountDeletions).values({ userId: "user-a", startedAt: now });
      const error = yield* ensure("user-a").pipe(Effect.flip);
      expect(error._tag).toBe("ConnectAccountPersistenceError");
      expect(yield* db.select().from(relayConnectAccounts)).toEqual([]);
      expect(yield* summary).toMatchObject({ seatsGranted: 0 });
    }).pipe(Effect.provide(layer())),
  );

  it.effect("fails visibly instead of swallowing a founder number clash", () =>
    Effect.gen(function* () {
      yield* ensure("user-a");
      // An operator lowers seats_granted by hand: the next grant would reuse 1.
      yield* setPromo({ seatsGranted: 0 });
      const error = yield* ensure("user-b").pipe(Effect.flip);
      expect(error._tag).toBe("ConnectAccountPersistenceError");
      const db = yield* RelayDb.RelayDb;
      const rows = yield* db.select().from(relayConnectAccounts);
      expect(rows.map((row) => row.userId)).toEqual(["user-a"]);
    }).pipe(Effect.provide(layer())),
  );
});
