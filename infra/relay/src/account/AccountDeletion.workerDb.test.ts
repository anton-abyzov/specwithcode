import { describe, expect, it } from "@effect/vitest";
import * as Drizzle from "alchemy/Drizzle";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as RelayDb from "../db.ts";
import { relayConnectAccounts, relayEnvironmentLinks } from "../persistence/schema.ts";
import { makeSqliteD1 } from "../testing/sqliteD1.ts";
import * as AccountDeletion from "./AccountDeletion.ts";

/** RelayDb built the way the Worker builds it: alchemy's chain proxy over drizzle. */
const layerWorkerRelayDb = () => {
  const { d1 } = makeSqliteD1();
  return Layer.effect(
    RelayDb.RelayDb,
    Drizzle.D1(Effect.succeed(d1) as never) as unknown as Effect.Effect<RelayDb.RelayDatabase>,
  );
};

const now = "2026-11-25T00:00:00.000Z";

describe("account deletion on the Worker's database", () => {
  it.effect("deletes a user's rows through the chain proxy", () =>
    Effect.gen(function* () {
      const db = yield* RelayDb.RelayDb;
      yield* db.insert(relayConnectAccounts).values({
        userId: "user-a",
        founderNumber: 1,
        createdAt: now,
        updatedAt: now,
      } as typeof relayConnectAccounts.$inferInsert);
      const records = yield* AccountDeletion.AccountRecords;
      expect(yield* records.deleteUserRows({ userId: "user-a" })).toBe(true);
      expect(yield* db.select().from(relayConnectAccounts)).toEqual([]);
      expect(yield* db.select().from(relayEnvironmentLinks)).toEqual([]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        AccountDeletion.layerAccountRecords.pipe(Layer.provideMerge(layerWorkerRelayDb())),
      ),
    ),
  );
});
