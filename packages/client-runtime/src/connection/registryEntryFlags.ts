import type { EnvironmentId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type * as Persistence from "../platform/persistence.ts";
import { type ConnectionCatalogEntry, SshConnectionProfile } from "./catalog.ts";
import { ConnectionBlockedError } from "./model.ts";
import { connectionRoutes } from "./routes.ts";

const isSshConnectionProfile = Schema.is(SshConnectionProfile);

interface Lease {
  readonly entry: ConnectionCatalogEntry;
  readonly supervisor: {
    readonly connect: Effect.Effect<void>;
    readonly disconnect: Effect.Effect<void>;
  };
}

/**
 * The registry's switch and compatibility flags for a saved environment. Both
 * update the live lease in place, so the supervisor keeps its generation and
 * durable streams.
 */
export function makeEntryFlags<L extends Lease, NotRegistered>(deps: {
  readonly withLeaseLock: <A, E, R>(
    environmentId: EnvironmentId,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly entries: SubscriptionRef.SubscriptionRef<
    ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>
  >;
  readonly serviceScopes: SubscriptionRef.SubscriptionRef<ReadonlyMap<EnvironmentId, L>>;
  readonly platformEnvironmentIds: Ref.Ref<ReadonlySet<EnvironmentId>>;
  readonly registrations: Persistence.ConnectionRegistrationStore["Service"];
  readonly getEntry: (
    environmentId: EnvironmentId,
  ) => Effect.Effect<ConnectionCatalogEntry, NotRegistered>;
  readonly createServiceScope: (entry: ConnectionCatalogEntry) => Effect.Effect<unknown>;
  readonly disconnectSsh: (
    environmentId: EnvironmentId,
    profile: SshConnectionProfile,
  ) => Effect.Effect<void>;
}) {
  const { withLeaseLock, entries, serviceScopes, platformEnvironmentIds, registrations } = deps;

  const updateLease = (environmentId: EnvironmentId, lease: L, next: ConnectionCatalogEntry) =>
    SubscriptionRef.update(serviceScopes, (current) =>
      new Map(current).set(environmentId, { ...lease, entry: next }),
    );

  /**
   * Switches a saved environment on or off. Off drops the socket, stops the
   * retry ladder, and persists so the next launch stays off.
   */
  const setEnabled = Effect.fn("EnvironmentRegistry.setEnabled")(function* (
    environmentId: EnvironmentId,
    enabled: boolean,
  ) {
    yield* withLeaseLock(
      environmentId,
      Effect.gen(function* () {
        const entry = yield* deps.getEntry(environmentId);
        if (enabled && entry.unsupportedReason !== undefined) {
          return yield* new ConnectionBlockedError({
            reason: "unsupported",
            detail: entry.unsupportedReason,
          });
        }
        if (entry.enabled === enabled) {
          return;
        }
        // Platform-managed environments are reconciled from the host and are
        // never persisted, so only user-saved ones write the flag.
        if (!(yield* Ref.get(platformEnvironmentIds)).has(environmentId)) {
          yield* registrations.setEnabled(environmentId, enabled);
        }
        const next: ConnectionCatalogEntry = { ...entry, enabled };
        const lease = (yield* SubscriptionRef.get(serviceScopes)).get(environmentId);
        if (lease !== undefined) yield* updateLease(environmentId, lease, next);
        yield* SubscriptionRef.update(entries, (current) =>
          new Map(current).set(environmentId, next),
        );
        if (lease !== undefined) {
          yield* enabled ? lease.supervisor.connect : lease.supervisor.disconnect;
        } else if (enabled) {
          yield* deps.createServiceScope(next);
        }
        // The supervisor only owns the RPC session. A managed SSH backend and
        // its tunnel outlive it, so switching off tears those down as well.
        if (!enabled) {
          for (const route of connectionRoutes(entry)) {
            const profile = Option.getOrNull(route.profile);
            if (profile !== null && isSshConnectionProfile(profile)) {
              yield* deps.disconnectSsh(environmentId, profile);
            }
          }
        }
      }),
    );
  });

  const setCompatibility = Effect.fn("EnvironmentRegistry.setCompatibility")(function* (
    environmentId: EnvironmentId,
    error: ConnectionBlockedError | null,
  ) {
    yield* withLeaseLock(
      environmentId,
      Effect.gen(function* () {
        const entry = (yield* SubscriptionRef.get(entries)).get(environmentId);
        if (
          entry === undefined ||
          (entry.unsupportedReason === (error?.message ?? undefined) &&
            entry.serverUpdateRequired === (error?.serverUpdateRequired ?? undefined))
        )
          return;
        const {
          unsupportedReason: _previousReason,
          serverUpdateRequired: _previousUpdateRequired,
          ...rest
        } = entry;
        const next: ConnectionCatalogEntry =
          error === null
            ? rest
            : {
                ...rest,
                enabled: false,
                unsupportedReason: error.message,
                ...(error.serverUpdateRequired === true ? { serverUpdateRequired: true } : {}),
              };
        if (
          error !== null &&
          entry.enabled &&
          !(yield* Ref.get(platformEnvironmentIds)).has(environmentId)
        ) {
          yield* registrations.setEnabled(environmentId, false);
        }
        const lease = (yield* SubscriptionRef.get(serviceScopes)).get(environmentId);
        if (lease !== undefined) {
          yield* updateLease(environmentId, lease, next);
          if (error !== null) yield* lease.supervisor.disconnect;
        }
        yield* SubscriptionRef.update(entries, (current) =>
          new Map(current).set(environmentId, next),
        );
      }),
    );
  });

  return { setEnabled, setCompatibility };
}
