import type { EnvironmentId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";
import type * as Semaphore from "effect/Semaphore";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { accountOwnersChanged, planAccountOwners, settlePendingSaves } from "./accountOwners.ts";
import type { ConnectionCatalogEntry } from "./catalog.ts";
import type { PlatformReady } from "./platformReady.ts";
import { type makeOwnerMemory, savedFingerprints } from "./registryOwnerSaves.ts";

/**
 * Account cleanup for the registry (1434, D-01): plans which saved machines
 * leave with the account that left and forgets them on this client, each under
 * its lease and `accountLock`. Nothing runs before the platform has reported,
 * and the window's own machine is never planned.
 */
export function makeAccountCleanup<E>(deps: {
  readonly owners: ReturnType<typeof makeOwnerMemory>;
  readonly ownersStore: {
    readonly forgotten: (environmentId: EnvironmentId) => Effect.Effect<void>;
  };
  readonly accountScope: SubscriptionRef.SubscriptionRef<string | null | undefined>;
  readonly accountLock: Semaphore.Semaphore;
  readonly failedRemovals: Ref.Ref<{
    readonly account: string | null | undefined;
    readonly ids: ReadonlySet<string>;
  }>;
  readonly platformEnvironmentIds: Ref.Ref<ReadonlySet<EnvironmentId>>;
  readonly persistedEnvironmentIds: Ref.Ref<ReadonlySet<EnvironmentId>>;
  readonly entries: SubscriptionRef.SubscriptionRef<
    ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>
  >;
  readonly platformReady: PlatformReady;
  readonly withLeaseLock: <A, E, R>(
    environmentId: EnvironmentId,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly dropMachineLocked: (environmentId: EnvironmentId) => Effect.Effect<void, E>;
}) {
  const { owners, accountScope, accountLock, failedRemovals, platformReady } = deps;

  /**
   * The window's own machine: the primary the platform reported, or, when the
   * local server could not be read this time, the one an earlier start recorded.
   */
  const ownMachineId = Effect.gen(function* () {
    const reported = yield* platformReady.primary;
    if (reported !== undefined) return reported;
    return (yield* owners.read)?.localMachine as EnvironmentId | undefined;
  });

  /** Machines this client saved, never platform-managed ones or its own machine. */
  const savedMachineIds = Effect.gen(function* () {
    const platform = yield* Ref.get(deps.platformEnvironmentIds);
    const own = yield* ownMachineId;
    return [...(yield* Ref.get(deps.persistedEnvironmentIds))]
      .filter((environmentId) => !platform.has(environmentId) && environmentId !== own)
      .sort();
  });

  let settledSaves = false;

  /** Plans owners for `account`, writes them, and returns the machines to forget. */
  const planOwnersLocked = Effect.fn("EnvironmentRegistry.planOwnersLocked")(function* (
    account: string | null,
    adoptedFrom: string | null,
  ) {
    const read = yield* owners.read;
    const saved = yield* savedMachineIds;
    // Saves cut short are settled once, by the first plan: only then do the
    // loaded entries match the catalog. A note left later in this session waits
    // for the next start, or is replaced by the next save of that machine.
    const settle = read !== null && !settledSaves;
    settledSaves = true;
    const stored = settle
      ? settlePendingSaves(read, savedFingerprints(yield* SubscriptionRef.get(deps.entries), saved))
      : read;
    const failed = yield* Ref.get(failedRemovals);
    const plan = planAccountOwners({
      stored,
      account,
      savedMachines: saved,
      pending: failed.account === account ? failed.ids : new Set<string>(),
      adoptedFrom,
    });
    const reported = yield* platformReady.primary;
    const next =
      reported === undefined || plan.next.localMachine === reported
        ? plan.next
        : { ...plan.next, localMachine: reported as string };
    if (owners.stale() || accountOwnersChanged(read, next)) yield* owners.write(next);
    return plan.drop as ReadonlyArray<EnvironmentId>;
  });

  /** Whether a machine still leaves for `account` now. Callers hold `accountLock`. */
  const stillLeavesLocked = Effect.fn("EnvironmentRegistry.stillLeavesLocked")(function* (
    environmentId: EnvironmentId,
    account: string | null,
  ) {
    const saved = yield* savedMachineIds;
    if (!saved.includes(environmentId)) return false;
    const plan = planAccountOwners({
      stored: yield* owners.read,
      account,
      savedMachines: [environmentId],
    });
    return plan.drop.includes(environmentId);
  });

  // The last signed-in account settled in this session, for adoption (D-03).
  let lastSignedIn: string | null = null;

  const setAccount = Effect.fn("EnvironmentRegistry.setAccount")(function* (
    account: string | null,
  ) {
    // Captured before the wait: waiters need not leave the gate in call order,
    // and an account settled while the gate was closed never ran its plan.
    const adoptedFrom = lastSignedIn;
    if (account !== null) lastSignedIn = account;
    // Set at once, not behind the lock: a removal still running for an earlier
    // account sees the change before its next machine and stops.
    yield* SubscriptionRef.set(accountScope, account);
    // Planning waits until the platform has reported, so a saved route that
    // shares the own machine's environment id is never taken for another one.
    yield* platformReady.await;
    const drop = yield* accountLock.withPermits(1)(
      Effect.gen(function* () {
        if ((yield* SubscriptionRef.get(accountScope)) !== account) return [];
        yield* Ref.update(failedRemovals, (current) =>
          current.account === account ? current : { account, ids: new Set<string>() },
        );
        return yield* planOwnersLocked(account, adoptedFrom);
      }),
    );
    if (drop.length === 0) return;
    for (const environmentId of drop) {
      const exit = yield* deps
        .withLeaseLock(
          environmentId,
          accountLock.withPermits(1)(
            Effect.gen(function* () {
              // Checked under the lease: a removal planned for an account that
              // has since left never runs.
              if ((yield* SubscriptionRef.get(accountScope)) !== account) return;
              // Planned again here: the new account may have saved it since.
              if (!(yield* stillLeavesLocked(environmentId, account))) return;
              yield* deps.ownersStore.forgotten(environmentId);
              yield* deps.dropMachineLocked(environmentId);
            }),
          ),
        )
        .pipe(Effect.exit);
      if (Exit.isSuccess(exit)) continue;
      yield* Effect.logWarning("Could not forget a machine saved under another Connect account.", {
        environmentId,
        cause: exit.cause,
      });
      yield* Ref.update(failedRemovals, (current) =>
        current.account === account
          ? { account, ids: new Set(current.ids).add(environmentId) }
          : current,
      );
    }
    // Owners again: the account that left stays recorded while any removal is
    // owed, so the next start finishes the switch.
    yield* accountLock.withPermits(1)(
      Effect.gen(function* () {
        if ((yield* SubscriptionRef.get(accountScope)) !== account) return;
        yield* planOwnersLocked(account, adoptedFrom);
      }),
    );
  });

  return { ownMachineId, setAccount };
}
