import { type SQL, sql } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type {
  RelayAdminMachineLimit,
  RelayAdminTunnelState,
} from "@specweave-studio/contracts/relayAdmin";

import * as RelayConfiguration from "../Config.ts";
import * as RelayDb from "../db.ts";
import { FOUNDERS_PROMO_ID } from "../environments/ConnectAccounts.ts";
import { DEFAULT_MANAGED_TUNNEL_LIMIT } from "../environments/ManagedTunnelLimits.ts";

export class ConnectAdminQueryError extends Schema.TaggedError<ConnectAdminQueryError>()(
  "ConnectAdminQueryError",
  {
    operation: Schema.Literals(["overview", "list-accounts", "account"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Connect admin query '${this.operation}' failed`;
  }
}

export interface AdminOverview {
  readonly accounts: number;
  readonly linkedMachines: number;
  readonly tunnelsAllocated: number;
  readonly tunnelsReady: number;
  readonly phones: number;
  readonly founderSeatsGranted: number;
  readonly founderSeatCap: number;
  readonly freeMachineLimit: number;
  readonly globalTunnelCap: number | null;
}

/** An account as the relay's own tables know it; who it is comes from Clerk. */
export interface AdminAccountRow {
  readonly userId: string;
  readonly founderNumber: number | null;
  readonly limit: RelayAdminMachineLimit;
  readonly machineCount: number;
  readonly phoneCount: number;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

export interface AdminMachineRow {
  readonly environmentId: string;
  readonly label: string;
  readonly hostname: string | null;
  readonly linkedAt: string;
  readonly updatedAt: string;
  readonly unlinkedAt: string | null;
  readonly tunnel: RelayAdminTunnelState;
  /** Cloudflare's id, for reading the live status. Never sent to the caller. */
  readonly tunnelId: string | null;
}

export interface AdminPhoneRow {
  readonly deviceId: string;
  readonly label: string;
  readonly platform: "ios" | "android";
  readonly model: string | null;
  readonly appVersion: string | null;
  readonly lastSeenAt: string | null;
}

export class ConnectAdminQueries extends Context.Service<
  ConnectAdminQueries,
  {
    readonly overview: () => Effect.Effect<AdminOverview, ConnectAdminQueryError>;
    /**
     * Accounts newest first. An account is any user id with a Connect account
     * row, a machine link, a phone or a client key. `userIds` narrows the list
     * to those ids (at most 50).
     */
    readonly listAccounts: (input: {
      readonly limit: number;
      readonly cursor?: string | undefined;
      readonly userIds?: ReadonlyArray<string> | undefined;
    }) => Effect.Effect<
      { readonly accounts: ReadonlyArray<AdminAccountRow>; readonly nextCursor: string | null },
      ConnectAdminQueryError
    >;
    /** One account with every machine it linked (unlinked ones too) and its phones. */
    readonly account: (userId: string) => Effect.Effect<
      {
        readonly account: AdminAccountRow;
        readonly machines: ReadonlyArray<AdminMachineRow>;
        readonly phones: ReadonlyArray<AdminPhoneRow>;
      } | null,
      ConnectAdminQueryError
    >;
  }
>()("studio-relay/admin/ConnectAdminQueries") {}

type Row = Record<string, unknown>;

const text = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;
const count = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};
const flag = (value: unknown): boolean => value === true || Number(value) === 1;

/**
 * Every user id the relay holds anything for, with when it was first and last
 * seen. `where` narrows each table before the rows are put together.
 */
const seenUsers = (where: SQL = sql``) => sql`
  SELECT user_id, created_at AS first_seen, updated_at AS last_seen
    FROM relay_connect_accounts ${where}
  UNION ALL
  SELECT user_id, created_at, updated_at FROM relay_environment_links ${where}
  UNION ALL
  SELECT user_id, created_at, COALESCE(last_seen_at, updated_at)
    FROM relay_mobile_devices ${where}
  UNION ALL
  SELECT user_id, last_seen_at, last_seen_at FROM relay_client_keys ${where}`;

/** Only the accounts named in the `wanted` list the statement starts with. */
const ONLY_WANTED = sql`WHERE user_id IN (SELECT user_id FROM wanted)`;

const inList = (values: ReadonlyArray<string>): SQL =>
  sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );

/** The page position: the last account's first-seen time and id. */
export function encodeAccountsCursor(firstSeenAt: string, userId: string): string {
  return btoa(JSON.stringify([firstSeenAt, userId]))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/** Null for anything that is not a cursor this relay made; the list then ends. */
export function decodeAccountsCursor(
  cursor: string | undefined,
): readonly [firstSeenAt: string, userId: string] | null {
  if (!cursor) return null;
  try {
    const parsed: unknown = JSON.parse(atob(cursor.replaceAll("-", "+").replaceAll("_", "/")));
    return Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string"
      ? [parsed[0], parsed[1]]
      : null;
  } catch {
    return null;
  }
}

/**
 * The same order as `ManagedTunnelLimits.resolve`, from rows read once for a
 * whole page: an override row, else a founder seat, else the founder limit
 * while seats are still being granted, else the free limit.
 */
export function resolveAdminMachineLimit(input: {
  readonly override: { readonly maxTunnels: number; readonly unlimited: boolean } | undefined;
  readonly founderLimit: number | undefined;
  readonly openPromoLimit: number | undefined;
  readonly freeLimit: number;
}): RelayAdminMachineLimit {
  if (input.override !== undefined) {
    if (input.override.unlimited) return { maxMachines: null, source: "override" };
    const finite = input.override.maxTunnels;
    // A malformed override refuses every link, so it reads as no machines.
    return {
      maxMachines: Number.isSafeInteger(finite) && finite >= 0 ? finite : 0,
      source: "override",
    };
  }
  if (input.founderLimit !== undefined) {
    return { maxMachines: input.founderLimit, source: "founder" };
  }
  if (input.openPromoLimit !== undefined) {
    return { maxMachines: input.openPromoLimit, source: "founder" };
  }
  return { maxMachines: input.freeLimit, source: "free" };
}

function tunnelState(row: Row): RelayAdminTunnelState {
  if (text(row.hostname) === null) return "none";
  if (text(row.tunnel_released_at) !== null) return "released";
  return text(row.tunnel_id) !== null && text(row.ready_at) !== null ? "ready" : "provisioning";
}

export const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const config = yield* RelayConfiguration.RelayConfiguration;
  const freeLimit = config.connectFreeTunnelLimit ?? DEFAULT_MANAGED_TUNNEL_LIMIT;

  const run = (
    operation: ConnectAdminQueryError["operation"],
    queries: ReadonlyArray<SQL>,
  ): Effect.Effect<ReadonlyArray<ReadonlyArray<Row>>, ConnectAdminQueryError> =>
    RelayDb.batch(db, queries.map(RelayDb.rawQuery)).pipe(
      Effect.mapError((cause) => new ConnectAdminQueryError({ operation, cause })),
    );

  /** Counts, founder seats and limits for the accounts of one page, in one batch. */
  const describe = Effect.fnUntraced(function* (
    operation: ConnectAdminQueryError["operation"],
    seen: ReadonlyArray<Row>,
  ) {
    if (seen.length === 0) return [] as ReadonlyArray<AdminAccountRow>;
    const ids = inList(seen.map((row) => String(row.user_id)));
    const [machines, phones, overrides, founders, openPromos] = yield* run(operation, [
      sql`SELECT user_id, COUNT(*) AS n FROM relay_environment_links
          WHERE revoked_at IS NULL AND user_id IN (${ids}) GROUP BY user_id`,
      sql`SELECT user_id, COUNT(*) AS n FROM relay_mobile_devices
          WHERE user_id IN (${ids}) GROUP BY user_id`,
      sql`SELECT user_id, max_tunnels, unlimited FROM relay_managed_tunnel_limits
          WHERE user_id IN (${ids})`,
      sql`SELECT a.user_id, a.founder_number, p.founder_tunnel_limit
          FROM relay_connect_accounts a
          LEFT JOIN relay_connect_promos p ON p.id = a.promo_id
          WHERE a.user_id IN (${ids})`,
      sql`SELECT founder_tunnel_limit FROM relay_connect_promos
          WHERE id = ${FOUNDERS_PROMO_ID} AND grants_open = 1 AND seats_granted < seat_cap`,
    ]);
    const byUser = (rows: ReadonlyArray<Row> | undefined) =>
      new Map((rows ?? []).map((row) => [String(row.user_id), row] as const));
    const machineCounts = byUser(machines);
    const phoneCounts = byUser(phones);
    const overrideRows = byUser(overrides);
    const founderRows = byUser(founders);
    const openPromo = openPromos?.[0];
    return seen.map((row): AdminAccountRow => {
      const userId = String(row.user_id);
      const override = overrideRows.get(userId);
      const founder = founderRows.get(userId);
      const founderNumber =
        founder?.founder_number === null || founder?.founder_number === undefined
          ? null
          : count(founder.founder_number);
      return {
        userId,
        founderNumber,
        limit: resolveAdminMachineLimit({
          override:
            override === undefined
              ? undefined
              : { maxTunnels: Number(override.max_tunnels), unlimited: flag(override.unlimited) },
          founderLimit:
            founderNumber !== null && founder?.founder_tunnel_limit != null
              ? count(founder.founder_tunnel_limit)
              : undefined,
          openPromoLimit:
            openPromo === undefined ? undefined : count(openPromo.founder_tunnel_limit),
          freeLimit,
        }),
        machineCount: count(machineCounts.get(userId)?.n),
        phoneCount: count(phoneCounts.get(userId)?.n),
        firstSeenAt: String(row.first_seen),
        lastSeenAt: String(row.last_seen),
      };
    });
  });

  const listAccounts: ConnectAdminQueries["Service"]["listAccounts"] = Effect.fn(
    "relay.admin.queries.list_accounts",
  )(function* (input) {
    if (input.userIds !== undefined && input.userIds.length === 0) {
      return { accounts: [], nextCursor: null };
    }
    const cursor = decodeAccountsCursor(input.cursor);
    // A cursor this relay did not make ends the list; it never restarts it.
    if (input.cursor && cursor === null) return { accounts: [], nextCursor: null };
    // The ids are bound once, and each table is then read by user id.
    const wanted =
      input.userIds === undefined
        ? sql``
        : sql`WITH wanted(user_id) AS (VALUES ${sql.join(
            input.userIds.map((userId) => sql`(${userId})`),
            sql`, `,
          )})`;
    const having =
      cursor === null
        ? sql``
        : sql`HAVING (MIN(first_seen) < ${cursor[0]} OR (MIN(first_seen) = ${cursor[0]} AND user_id < ${cursor[1]}))`;
    // One row more than the page tells whether another page follows.
    const [seen = []] = yield* run("list-accounts", [
      sql`${wanted}
          SELECT user_id, MIN(first_seen) AS first_seen, MAX(last_seen) AS last_seen
          FROM (${seenUsers(input.userIds === undefined ? undefined : ONLY_WANTED)})
          GROUP BY user_id ${having}
          ORDER BY first_seen DESC, user_id DESC LIMIT ${input.limit + 1}`,
    ]);
    const page = seen.slice(0, input.limit);
    const last = page.at(-1);
    return {
      accounts: yield* describe("list-accounts", page),
      nextCursor:
        seen.length > input.limit && last !== undefined
          ? encodeAccountsCursor(String(last.first_seen), String(last.user_id))
          : null,
    };
  });

  return ConnectAdminQueries.of({
    overview: Effect.fn("relay.admin.queries.overview")(function* () {
      const [accounts, machines, tunnels, phones, promos] = yield* run("overview", [
        sql`SELECT COUNT(DISTINCT user_id) AS n FROM (${seenUsers()})`,
        sql`SELECT COUNT(*) AS n FROM relay_environment_links WHERE revoked_at IS NULL`,
        sql`SELECT COUNT(*) AS allocated,
                   COALESCE(SUM(CASE WHEN ready_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS ready
            FROM relay_managed_endpoint_allocations
            WHERE tunnel_id IS NOT NULL AND tunnel_released_at IS NULL`,
        sql`SELECT COUNT(*) AS n FROM relay_mobile_devices`,
        sql`SELECT seat_cap, seats_granted FROM relay_connect_promos WHERE id = ${FOUNDERS_PROMO_ID}`,
      ]);
      return {
        accounts: count(accounts?.[0]?.n),
        linkedMachines: count(machines?.[0]?.n),
        tunnelsAllocated: count(tunnels?.[0]?.allocated),
        tunnelsReady: count(tunnels?.[0]?.ready),
        phones: count(phones?.[0]?.n),
        founderSeatsGranted: count(promos?.[0]?.seats_granted),
        founderSeatCap: count(promos?.[0]?.seat_cap),
        freeMachineLimit: freeLimit,
        globalTunnelCap: config.globalManagedTunnelCap ?? null,
      };
    }),
    listAccounts,
    account: Effect.fn("relay.admin.queries.account")(function* (userId) {
      const listed = yield* listAccounts({ limit: 1, userIds: [userId] }).pipe(
        Effect.mapError(
          (error) => new ConnectAdminQueryError({ operation: "account", cause: error.cause }),
        ),
      );
      const account = listed.accounts[0];
      if (account === undefined) return null;
      const [machines = [], phones = []] = yield* run("account", [
        sql`SELECT l.environment_id, l.environment_label, l.created_at, l.updated_at, l.revoked_at,
                   a.hostname, a.tunnel_id, a.ready_at, a.tunnel_released_at
            FROM relay_environment_links l
            LEFT JOIN relay_managed_endpoint_allocations a
              ON a.user_id = l.user_id AND a.environment_id = l.environment_id
            WHERE l.user_id = ${userId}
            ORDER BY (l.revoked_at IS NOT NULL), l.created_at DESC, l.environment_id`,
        sql`SELECT device_id, label, platform, model, app_version, last_seen_at
            FROM relay_mobile_devices WHERE user_id = ${userId}
            ORDER BY COALESCE(last_seen_at, updated_at) DESC, device_id`,
      ]);
      return {
        account,
        machines: machines.map((row): AdminMachineRow => {
          const tunnel = tunnelState(row);
          return {
            environmentId: String(row.environment_id),
            label: String(row.environment_label),
            hostname: text(row.hostname),
            linkedAt: String(row.created_at),
            updatedAt: String(row.updated_at),
            unlinkedAt: text(row.revoked_at),
            tunnel,
            tunnelId: tunnel === "ready" || tunnel === "provisioning" ? text(row.tunnel_id) : null,
          };
        }),
        phones: phones.map((row): AdminPhoneRow => ({
          deviceId: String(row.device_id),
          label: String(row.label),
          platform: row.platform === "android" ? "android" : "ios",
          model: text(row.model),
          appVersion: text(row.app_version),
          lastSeenAt: text(row.last_seen_at),
        })),
      };
    }),
  });
});

export const layer = Layer.effect(ConnectAdminQueries, make);
