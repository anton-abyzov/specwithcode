import { describe, expect, it } from "@effect/vitest";
import { eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as RelayConfiguration from "../Config.ts";
import * as RelayDb from "../db.ts";
import * as ConnectAccounts from "../environments/ConnectAccounts.ts";
import * as ManagedTunnelLimits from "../environments/ManagedTunnelLimits.ts";
import {
  relayConnectPromos,
  relayEnvironmentLinks,
  relayManagedTunnelLimits,
} from "../persistence/schema.ts";
import { adminLink, adminTestConfig, seedConnectAdmin } from "../testing/connectAdminFixtures.ts";
import { layerSqliteRelayDb } from "../testing/sqliteD1.ts";
import * as ConnectAdminQueries from "./ConnectAdminQueries.ts";

const layer = (overrides?: Partial<RelayConfiguration.RelayConfiguration["Service"]>) =>
  Layer.mergeAll(ConnectAdminQueries.layer, ManagedTunnelLimits.layer, ConnectAccounts.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(layerSqliteRelayDb(), RelayConfiguration.layer(adminTestConfig(overrides))),
    ),
  );

const ids = (accounts: ReadonlyArray<ConnectAdminQueries.AdminAccountRow>) =>
  accounts.map((account) => account.userId);

describe("the Connect admin's read of the relay database", () => {
  it.effect("counts accounts, machines, tunnels, phones and founder seats", () =>
    Effect.gen(function* () {
      yield* seedConnectAdmin;
      const queries = yield* ConnectAdminQueries.ConnectAdminQueries;
      expect(yield* queries.overview()).toEqual({
        accounts: 5,
        // The unlinked machine is not counted.
        linkedMachines: 4,
        // The released tunnel is not counted; the provisioning one is, but is not ready.
        tunnelsAllocated: 2,
        tunnelsReady: 1,
        phones: 2,
        founderSeatsGranted: 2,
        founderSeatCap: 300,
        freeMachineLimit: 5,
        globalTunnelCap: 180,
      });
    }).pipe(Effect.provide(layer({ connectFreeTunnelLimit: 5, globalManagedTunnelCap: 180 }))),
  );

  it.effect("reads an empty database as zeros, with the default limit and no cap", () =>
    Effect.gen(function* () {
      const queries = yield* ConnectAdminQueries.ConnectAdminQueries;
      expect(yield* queries.overview()).toMatchObject({
        accounts: 0,
        linkedMachines: 0,
        tunnelsAllocated: 0,
        tunnelsReady: 0,
        phones: 0,
        freeMachineLimit: 3,
        globalTunnelCap: null,
      });
      expect(yield* queries.listAccounts({ limit: 50 })).toEqual({
        accounts: [],
        nextCursor: null,
      });
    }).pipe(Effect.provide(layer())),
  );

  it.effect("counts new accounts, accounts seen and machines linked per window", () =>
    Effect.gen(function* () {
      yield* seedConnectAdmin;
      const queries = yield* ConnectAdminQueries.ConnectAdminQueries;
      // A Wednesday. The month window starts on October 12 at noon.
      const usage = yield* queries.usage(Date.parse("2026-11-11T12:00:00.000Z"));
      expect(usage).toMatchObject({
        // Only the account with a client key was first seen inside the month.
        created: { day: 0, week: 0, month: 1 },
        // The owner's phone was seen 12 hours ago; the key a month ago.
        active: { day: 1, week: 1, month: 2 },
        machinesLinked: { day: 0, week: 0, month: 0 },
      });
      expect(usage.weekly.map((week) => week.count)).toEqual([0, 0, 0, 0, 0, 1, 2, 2, 0, 0, 0, 0]);
      expect(usage.weekly[5]?.weekStart).toBe("2026-09-28T00:00:00.000Z");

      // Earlier, the same rows fall in other windows; later rows are not counted yet.
      const earlier = yield* queries.usage(Date.parse("2026-10-10T12:00:00.000Z"));
      expect(earlier).toMatchObject({
        created: { day: 1, week: 2, month: 3 },
        // The owner's phone is seen a month after this moment, so the owner is not counted.
        active: { day: 1, week: 2, month: 2 },
        // An unlinked machine was still linked in that window.
        machinesLinked: { day: 1, week: 2, month: 5 },
      });
    }).pipe(Effect.provide(layer())),
  );

  it.effect("reads usage of an empty database as zeros for every window and week", () =>
    Effect.gen(function* () {
      const queries = yield* ConnectAdminQueries.ConnectAdminQueries;
      const usage = yield* queries.usage(Date.parse("2026-11-11T12:00:00.000Z"));
      const none = { day: 0, week: 0, month: 0 };
      expect(usage).toMatchObject({ created: none, active: none, machinesLinked: none });
      expect(usage.weekly).toHaveLength(12);
      expect(usage.weekly.every((week) => week.count === 0)).toBe(true);
    }).pipe(Effect.provide(layer())),
  );

  it.effect("lists every account newest first, also one with only a phone or a key", () =>
    Effect.gen(function* () {
      yield* seedConnectAdmin;
      const queries = yield* ConnectAdminQueries.ConnectAdminQueries;
      const { accounts, nextCursor } = yield* queries.listAccounts({ limit: 50 });
      expect(ids(accounts)).toEqual([
        "user_key",
        "user_phone",
        "user_founder",
        "user_free",
        "user_owner",
      ]);
      expect(nextCursor).toBeNull();
      expect(accounts.at(-1)).toEqual({
        userId: "user_owner",
        founderNumber: 1,
        limit: { maxMachines: null, source: "override" },
        machineCount: 2,
        phoneCount: 1,
        firstSeenAt: "2026-10-01T00:00:00.000Z",
        // The phone was seen after anything else of this account changed.
        lastSeenAt: "2026-11-11T00:00:00.000Z",
      });
      expect(accounts[0]).toMatchObject({ machineCount: 0, phoneCount: 0, founderNumber: null });
      expect(accounts[1]).toMatchObject({ machineCount: 0, phoneCount: 1 });
    }).pipe(Effect.provide(layer())),
  );

  it.effect("pages through the list without repeating or skipping an account", () =>
    Effect.gen(function* () {
      yield* seedConnectAdmin;
      const queries = yield* ConnectAdminQueries.ConnectAdminQueries;
      const seen: Array<string> = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = yield* queries.listAccounts({ limit: 2, cursor });
        seen.push(...ids(page.accounts));
        cursor = page.nextCursor ?? undefined;
        pages += 1;
      } while (cursor !== undefined && pages < 10);
      expect(pages).toBe(3);
      expect(seen).toEqual(["user_key", "user_phone", "user_founder", "user_free", "user_owner"]);
    }).pipe(Effect.provide(layer())),
  );

  it.effect("ends the list on a cursor it did not make, so a caller's loop ends too", () =>
    Effect.gen(function* () {
      yield* seedConnectAdmin;
      const queries = yield* ConnectAdminQueries.ConnectAdminQueries;
      for (const cursor of ["not-a-cursor", "e30"]) {
        expect(yield* queries.listAccounts({ limit: 2, cursor })).toEqual({
          accounts: [],
          nextCursor: null,
        });
      }
      // No cursor at all is the first page.
      expect(ids((yield* queries.listAccounts({ limit: 2, cursor: "" })).accounts)).toEqual([
        "user_key",
        "user_phone",
      ]);
    }).pipe(Effect.provide(layer())),
  );

  it.effect("pages through accounts first seen at the same moment", () =>
    Effect.gen(function* () {
      const db = yield* RelayDb.RelayDb;
      const at = "2026-11-05T00:00:00.000Z";
      yield* db
        .insert(relayEnvironmentLinks)
        .values(
          ["user_c", "user_a", "user_d", "user_b"].map((userId) =>
            adminLink(userId, `m-${userId}`, userId, at),
          ),
        );
      const queries = yield* ConnectAdminQueries.ConnectAdminQueries;
      const seen: Array<string> = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = yield* queries.listAccounts({ limit: 1, cursor });
        seen.push(...ids(page.accounts));
        cursor = page.nextCursor ?? undefined;
        pages += 1;
      } while (cursor !== undefined && pages < 10);
      expect(seen).toEqual(["user_d", "user_c", "user_b", "user_a"]);
    }).pipe(Effect.provide(layer())),
  );

  it.effect("narrows the list to the given ids, and to nothing for no ids", () =>
    Effect.gen(function* () {
      yield* seedConnectAdmin;
      const queries = yield* ConnectAdminQueries.ConnectAdminQueries;
      expect(
        ids(
          (yield* queries.listAccounts({
            limit: 50,
            userIds: ["user_free", "user_nobody", "user_owner"],
          })).accounts,
        ),
      ).toEqual(["user_free", "user_owner"]);
      // A full page of ids, most of them unknown, still fits one statement.
      const many = Array.from({ length: 49 }, (_, n) => `user_unknown${n}`);
      expect(
        ids((yield* queries.listAccounts({ limit: 50, userIds: [...many, "user_key"] })).accounts),
      ).toEqual(["user_key"]);
      // An id is data, never SQL.
      expect(
        (yield* queries.listAccounts({ limit: 50, userIds: [`x') OR 1=1 --`, '"]'] })).accounts,
      ).toEqual([]);
      expect(yield* queries.listAccounts({ limit: 50, userIds: [] })).toEqual({
        accounts: [],
        nextCursor: null,
      });
    }).pipe(Effect.provide(layer())),
  );

  it.effect("gives each account the limit the relay enforces for it", () =>
    Effect.gen(function* () {
      yield* seedConnectAdmin;
      const db = yield* RelayDb.RelayDb;
      const queries = yield* ConnectAdminQueries.ConnectAdminQueries;
      const limits = yield* ManagedTunnelLimits.ManagedTunnelLimits;
      yield* db.insert(relayManagedTunnelLimits).values({
        userId: "user_phone",
        maxTunnels: 7,
        unlimited: false,
        createdAt: "2026-10-12T00:00:00.000Z",
        updatedAt: "2026-10-12T00:00:00.000Z",
      });
      const compare = Effect.gen(function* () {
        const { accounts } = yield* queries.listAccounts({ limit: 50 });
        const listed: Record<string, unknown> = {};
        for (const account of accounts) {
          const enforced = yield* limits.resolve({ userId: account.userId });
          // The list resolves a whole page from five queries; it must agree
          // with the one the link path asks account by account.
          expect(account.limit).toEqual({
            maxMachines: enforced.maxTunnels,
            source: enforced.source,
          });
          listed[account.userId] = account.limit;
        }
        return listed;
      });
      // Seats are still being granted: an account without one would get the founder limit.
      expect(yield* compare).toEqual({
        user_owner: { maxMachines: null, source: "override" },
        user_founder: { maxMachines: 10, source: "founder" },
        user_free: { maxMachines: 10, source: "founder" },
        user_phone: { maxMachines: 7, source: "override" },
        user_key: { maxMachines: 10, source: "founder" },
      });
      yield* db
        .update(relayConnectPromos)
        .set({ grantsOpen: false })
        .where(eq(relayConnectPromos.id, ConnectAccounts.FOUNDERS_PROMO_ID));
      expect(yield* compare).toMatchObject({
        user_founder: { maxMachines: 10, source: "founder" },
        user_free: { maxMachines: 4, source: "free" },
        user_key: { maxMachines: 4, source: "free" },
      });
    }).pipe(Effect.provide(layer({ connectFreeTunnelLimit: 4 }))),
  );

  it("reads a malformed override as no machines, since it refuses every link", () => {
    for (const maxTunnels of [-1, 1.5, Number.NaN]) {
      expect(
        ConnectAdminQueries.resolveAdminMachineLimit({
          override: { maxTunnels, unlimited: false },
          founderLimit: 10,
          openPromoLimit: 10,
          freeLimit: 3,
        }),
      ).toEqual({ maxMachines: 0, source: "override" });
    }
  });

  it.effect("shows one account's machines, linked first, with what the relay recorded", () =>
    Effect.gen(function* () {
      yield* seedConnectAdmin;
      const queries = yield* ConnectAdminQueries.ConnectAdminQueries;
      const found = yield* queries.account("user_owner");
      expect(found?.account.userId).toBe("user_owner");
      expect(found?.machines).toEqual([
        {
          environmentId: "m1",
          label: "M1",
          hostname: "prod-m1.tunnels.example.test",
          linkedAt: "2026-10-02T00:00:00.000Z",
          updatedAt: "2026-10-02T00:00:00.000Z",
          unlinkedAt: null,
          tunnel: "released",
          // A released tunnel no longer exists at Cloudflare, so there is nothing to read.
          tunnelId: null,
        },
        {
          environmentId: "m4",
          label: "M4 Max",
          hostname: "prod-m4.tunnels.example.test",
          linkedAt: "2026-10-01T00:00:00.000Z",
          updatedAt: "2026-10-01T00:00:00.000Z",
          unlinkedAt: null,
          tunnel: "ready",
          tunnelId: "tunnel-m4",
        },
        {
          environmentId: "old",
          label: "Old laptop",
          hostname: null,
          linkedAt: "2026-10-03T00:00:00.000Z",
          updatedAt: "2026-10-20T00:00:00.000Z",
          unlinkedAt: "2026-10-20T00:00:00.000Z",
          tunnel: "none",
          tunnelId: null,
        },
      ]);
      expect(found?.phones).toEqual([
        {
          deviceId: "iphone-16",
          label: "Anton's iPhone",
          platform: "ios",
          model: "iPhone17,3",
          appVersion: "0.1.1",
          lastSeenAt: "2026-11-11T00:00:00.000Z",
        },
      ]);
      expect((yield* queries.account("user_founder"))?.machines[0]).toMatchObject({
        tunnel: "provisioning",
        tunnelId: "tunnel-studio",
      });
      expect((yield* queries.account("user_free"))?.machines[0]).toMatchObject({
        tunnel: "none",
        hostname: null,
      });
    }).pipe(Effect.provide(layer())),
  );

  it.effect("knows an account with only a phone, and no account it never saw", () =>
    Effect.gen(function* () {
      yield* seedConnectAdmin;
      const queries = yield* ConnectAdminQueries.ConnectAdminQueries;
      const phoneOnly = yield* queries.account("user_phone");
      expect(phoneOnly?.machines).toEqual([]);
      expect(phoneOnly?.phones.map((phone) => phone.platform)).toEqual(["android"]);
      expect(yield* queries.account("user_nobody")).toBeNull();
      // An id is data, never SQL.
      expect(yield* queries.account("user_owner' OR '1'='1")).toBeNull();
    }).pipe(Effect.provide(layer())),
  );

  it("round-trips its own cursor", () => {
    const cursor = ConnectAdminQueries.encodeAccountsCursor(
      "2026-10-01T00:00:00.000Z",
      "user_owner",
    );
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(ConnectAdminQueries.decodeAccountsCursor(cursor)).toEqual([
      "2026-10-01T00:00:00.000Z",
      "user_owner",
    ]);
    expect(ConnectAdminQueries.decodeAccountsCursor(undefined)).toBeNull();
  });
});
