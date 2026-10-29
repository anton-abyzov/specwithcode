import { eq, sql } from "drizzle-orm";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as RelayDb from "../db.ts";
import { relayConnectPromos } from "../persistence/schema.ts";

/** The "Founding 1,000" promo row, seeded by the connect_founders migration. */
export const FOUNDERS_PROMO_ID = "founders";

export interface ConnectAccount {
  readonly userId: string;
  readonly promoId: string | null;
  /** 1-based signup order within the promo; null when no seat was granted. */
  readonly founderNumber: number | null;
  readonly createdAt: string;
}

export interface FoundersSummary {
  readonly seatCap: number;
  readonly seatsGranted: number;
  readonly seatsLeft: number;
  readonly grantsOpen: boolean;
}

export class ConnectAccountPersistenceError extends Schema.TaggedError<ConnectAccountPersistenceError>()(
  "ConnectAccountPersistenceError",
  {
    operation: Schema.Literals(["ensure-account", "founders-summary"]),
    userId: Schema.optionalKey(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.userId === undefined
      ? `Connect account '${this.operation}' failed`
      : `Connect account '${this.operation}' failed for user '${this.userId}'`;
  }
}

export class ConnectAccounts extends Context.Service<
  ConnectAccounts,
  {
    /**
     * Records the account after a managed link succeeded. An account without
     * a seat takes the next founder number while grants are open and seats
     * remain; an account that has one keeps it, so later links never move or
     * take back a seat. Fails when the account has no live managed link or
     * its deletion has started.
     */
    readonly ensureAccount: (input: {
      readonly userId: string;
    }) => Effect.Effect<ConnectAccount, ConnectAccountPersistenceError>;
    readonly foundersSummary: () => Effect.Effect<FoundersSummary, ConnectAccountPersistenceError>;
  }
>()("studio-relay/environments/ConnectAccounts") {}

const toNumberOrNull = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

export const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;

  return ConnectAccounts.of({
    ensureAccount: Effect.fn("relay.connect_accounts.ensure_account")(function* (input) {
      const now = DateTime.formatIso(yield* DateTime.now);
      const fail = (cause?: unknown) =>
        new ConnectAccountPersistenceError({
          operation: "ensure-account",
          userId: input.userId,
          ...(cause === undefined ? {} : { cause }),
        });
      // D1 has no row locks or interactive transactions. One batch is one
      // implicit transaction, and every write in it is conditional. It runs
      // after a managed link succeeded, so a seat only goes to an account
      // that holds a live managed machine:
      // 1. insert the account (no seat yet) only while it has a live managed
      //    link and its deletion has not started;
      // 2. give an account without a seat the next founder number while
      //    grants are open and seats remain. This also covers accounts first
      //    linked while grants were closed or seats were full;
      // 3. advance seats_granted only if this account now holds exactly
      //    seats_granted + 1, which is true only right after step 2;
      // 4. read the account back.
      // The unique (promo_id, founder_number) index backs this up: a clash
      // fails the batch instead of sharing a number.
      const results = yield* RelayDb.batch(db, [
        RelayDb.rawQuery(sql`
          insert into relay_connect_accounts (user_id, promo_id, founder_number, created_at, updated_at)
          select ${input.userId}, null, null, ${now}, ${now}
          where exists (
              select 1 from relay_environment_links l
              where l.user_id = ${input.userId}
                and l.revoked_at is null
                and l.managed_tunnels_enabled = 1
            )
            and not exists (
              select 1 from relay_account_deletions d where d.user_id = ${input.userId}
            )
          on conflict (user_id) do nothing
        `),
        RelayDb.rawQuery(sql`
          update relay_connect_accounts
          set promo_id = ${FOUNDERS_PROMO_ID},
              founder_number = (
                select p.seats_granted + 1 from relay_connect_promos p where p.id = ${FOUNDERS_PROMO_ID}
              ),
              updated_at = ${now}
          where user_id = ${input.userId}
            and founder_number is null
            and exists (
              select 1 from relay_connect_promos p
              where p.id = ${FOUNDERS_PROMO_ID}
                and p.grants_open = 1
                and p.seats_granted < p.seat_cap
            )
        `),
        RelayDb.rawQuery(sql`
          update relay_connect_promos
          set seats_granted = seats_granted + 1, updated_at = ${now}
          where id = ${FOUNDERS_PROMO_ID}
            and exists (
              select 1 from relay_connect_accounts a
              where a.user_id = ${input.userId}
                and a.promo_id = relay_connect_promos.id
                and a.founder_number = relay_connect_promos.seats_granted + 1
            )
        `),
        RelayDb.rawQuery(sql`
          select user_id, promo_id, founder_number, created_at
          from relay_connect_accounts
          where user_id = ${input.userId}
        `),
      ]).pipe(Effect.mapError(fail));
      const row = results[3]?.[0];
      if (row === undefined) {
        return yield* fail();
      }
      return {
        userId: String(row.user_id),
        promoId: row.promo_id === null || row.promo_id === undefined ? null : String(row.promo_id),
        founderNumber: toNumberOrNull(row.founder_number),
        createdAt: String(row.created_at),
      } satisfies ConnectAccount;
    }),
    foundersSummary: () =>
      db
        .select({
          seatCap: relayConnectPromos.seatCap,
          seatsGranted: relayConnectPromos.seatsGranted,
          grantsOpen: relayConnectPromos.grantsOpen,
        })
        .from(relayConnectPromos)
        .where(eq(relayConnectPromos.id, FOUNDERS_PROMO_ID))
        .limit(1)
        .pipe(
          Effect.map((rows): FoundersSummary => {
            const promo = rows[0];
            if (promo === undefined) {
              return { seatCap: 0, seatsGranted: 0, seatsLeft: 0, grantsOpen: false };
            }
            const seatsLeft = Math.max(0, promo.seatCap - promo.seatsGranted);
            return {
              seatCap: promo.seatCap,
              seatsGranted: promo.seatsGranted,
              seatsLeft,
              grantsOpen: promo.grantsOpen && seatsLeft > 0,
            };
          }),
          Effect.mapError(
            (cause) => new ConnectAccountPersistenceError({ operation: "founders-summary", cause }),
          ),
          Effect.withSpan("relay.connect_accounts.founders_summary"),
        ),
  });
});

export const layer = Layer.effect(ConnectAccounts, make);
