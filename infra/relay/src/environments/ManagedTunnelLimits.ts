import { and, eq, isNotNull, lt } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { RelayManagedTunnelPolicy } from "@specweave-studio/contracts/relay";

import * as RelayConfiguration from "../Config.ts";
import * as RelayDb from "../db.ts";
import * as ConnectAccounts from "./ConnectAccounts.ts";
import {
  relayConnectAccounts,
  relayConnectPromos,
  relayManagedTunnelLimits,
} from "../persistence/schema.ts";

/**
 * Managed tunnels an account may hold when it has no override row in
 * `relay_managed_tunnel_limits`, no founder seat, and the deploy does not set
 * `RELAY_CONNECT_FREE_TUNNEL_LIMIT`.
 */
export const DEFAULT_MANAGED_TUNNEL_LIMIT = RelayConfiguration.DEFAULT_CONNECT_FREE_TUNNEL_LIMIT;

export const ManagedTunnelLimitSource = Schema.Literals(["override", "founder", "free"]);
export type ManagedTunnelLimitSource = typeof ManagedTunnelLimitSource.Type;

/** Why a new managed machine was refused. */
export const ManagedTunnelLimitReason = Schema.Literals(["account_limit", "service_capacity"]);
export type ManagedTunnelLimitReason = typeof ManagedTunnelLimitReason.Type;

export class ManagedTunnelLimitPersistenceError extends Schema.TaggedError<ManagedTunnelLimitPersistenceError>()(
  "ManagedTunnelLimitPersistenceError",
  {
    operation: Schema.Literals(["load-limit"]),
    userId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Managed tunnel limit '${this.operation}' failed for user '${this.userId}'`;
  }
}

export class ManagedTunnelLimitExceeded extends Schema.TaggedError<ManagedTunnelLimitExceeded>()(
  "ManagedTunnelLimitExceeded",
  {
    userId: Schema.String,
    environmentId: Schema.String,
    reason: ManagedTunnelLimitReason,
    /** The account's limit and its tunnels in use, whichever cap was hit. */
    maxTunnels: Schema.Number,
    activeTunnels: Schema.Number,
    /** Set for `service_capacity`: the global cap and the total in use. */
    globalCap: Schema.optionalKey(Schema.Number),
    globalActiveTunnels: Schema.optionalKey(Schema.Number),
  },
) {
  override get message(): string {
    return this.reason === "service_capacity"
      ? `Managed tunnel service capacity reached: ${this.globalActiveTunnels ?? "?"} of ${this.globalCap ?? "?"} tunnels in use`
      : `Managed tunnel limit reached for user '${this.userId}': ${this.activeTunnels} of ${this.maxTunnels} tunnels in use`;
  }
}

export interface ResolvedManagedTunnelLimit {
  /**
   * Managed machines the account may hold; null for an override row marked
   * unlimited. The global service cap still applies either way.
   */
  readonly maxTunnels: number | null;
  readonly source: ManagedTunnelLimitSource;
}

/** The client-facing form of a resolved limit: finite or explicitly unlimited. */
export function toManagedTunnelPolicy(limit: ResolvedManagedTunnelLimit): RelayManagedTunnelPolicy {
  return limit.maxTunnels === null
    ? { kind: "unlimited" }
    : { kind: "limited", maxTunnels: limit.maxTunnels };
}

export class ManagedTunnelLimits extends Context.Service<
  ManagedTunnelLimits,
  {
    /**
     * The account's managed machine limit: a manual override row (finite, or
     * unlimited when its `unlimited` flag is set), else the
     * promo's founder limit for founders and for accounts that would take a
     * seat on this link (grants open, seats left), else the free limit.
     * Enforcement happens atomically in the allocation insert.
     */
    readonly resolve: (input: {
      readonly userId: string;
    }) => Effect.Effect<ResolvedManagedTunnelLimit, ManagedTunnelLimitPersistenceError>;
  }
>()("studio-relay/environments/ManagedTunnelLimits") {}

export const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const config = yield* RelayConfiguration.RelayConfiguration;
  const freeLimit = config.connectFreeTunnelLimit ?? DEFAULT_MANAGED_TUNNEL_LIMIT;

  return ManagedTunnelLimits.of({
    resolve: Effect.fn("relay.managed_tunnel_limits.resolve")(function* (input) {
      const fail = (cause: unknown) =>
        new ManagedTunnelLimitPersistenceError({
          operation: "load-limit",
          userId: input.userId,
          cause,
        });
      const overrides = yield* db
        .select({
          maxTunnels: relayManagedTunnelLimits.maxTunnels,
          unlimited: relayManagedTunnelLimits.unlimited,
        })
        .from(relayManagedTunnelLimits)
        .where(eq(relayManagedTunnelLimits.userId, input.userId))
        .limit(1)
        .pipe(Effect.mapError(fail));
      const override = overrides[0];
      if (override !== undefined) {
        if (override.unlimited === true) {
          return { maxTunnels: null, source: "override" } as const;
        }
        // A malformed finite override fails closed rather than falling back.
        if (!Number.isSafeInteger(override.maxTunnels) || override.maxTunnels < 0) {
          return yield* fail("Invalid finite tunnel override");
        }
        return { maxTunnels: override.maxTunnels, source: "override" } as const;
      }
      const founders = yield* db
        .select({ maxTunnels: relayConnectPromos.founderTunnelLimit })
        .from(relayConnectAccounts)
        .innerJoin(relayConnectPromos, eq(relayConnectPromos.id, relayConnectAccounts.promoId))
        .where(
          and(
            eq(relayConnectAccounts.userId, input.userId),
            isNotNull(relayConnectAccounts.founderNumber),
          ),
        )
        .limit(1)
        .pipe(Effect.mapError(fail));
      const founder = founders[0];
      if (founder !== undefined) {
        return { maxTunnels: founder.maxTunnels, source: "founder" } as const;
      }
      // The seat is granted only after a managed link succeeds, so an account
      // without one gets the founder limit while it would still be granted:
      // grants are open and seats remain.
      const openPromos = yield* db
        .select({ maxTunnels: relayConnectPromos.founderTunnelLimit })
        .from(relayConnectPromos)
        .where(
          and(
            eq(relayConnectPromos.id, ConnectAccounts.FOUNDERS_PROMO_ID),
            eq(relayConnectPromos.grantsOpen, true),
            lt(relayConnectPromos.seatsGranted, relayConnectPromos.seatCap),
          ),
        )
        .limit(1)
        .pipe(Effect.mapError(fail));
      const openPromo = openPromos[0];
      if (openPromo !== undefined) {
        return { maxTunnels: openPromo.maxTunnels, source: "founder" } as const;
      }
      return { maxTunnels: freeLimit, source: "free" } as const;
    }),
  });
});

export const layer = Layer.effect(ManagedTunnelLimits, make);
