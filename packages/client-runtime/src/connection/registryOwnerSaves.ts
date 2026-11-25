import type { EnvironmentId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

import type * as Persistence from "../platform/persistence.ts";
import {
  type AccountOwners,
  beginPendingSave,
  ownerForSave,
  saveTakesMachine,
} from "./accountOwners.ts";
import type { ConnectionCatalogEntry } from "./catalog.ts";
import { connectionRoutes } from "./routes.ts";

type OwnersStore = {
  readonly read: Effect.Effect<AccountOwners | null>;
  readonly write: (
    owners: AccountOwners,
  ) => Effect.Effect<void, Persistence.ConnectionPersistenceError>;
};

/**
 * Owners as this session knows them (1434). Every decision reads this copy, so
 * a write the window's storage refused never misleads a later step; storage
 * is brought up to date by the next write that succeeds.
 */
export function makeOwnerMemory(store: OwnersStore) {
  let loaded = false;
  let current: AccountOwners | null = null;
  // Storage is behind this session's copy since a refused write.
  let stale = false;
  const read = Effect.suspend(() =>
    loaded
      ? Effect.succeed(current)
      : store.read.pipe(
          Effect.tap((stored) =>
            Effect.sync(() => {
              if (!loaded) {
                loaded = true;
                current = stored;
              }
            }),
          ),
          Effect.map(() => current),
        ),
  );
  /** Stored, or nothing changes: used where a save must not go ahead untracked. */
  const writeOrFail = (owners: AccountOwners) =>
    store.write(owners).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          current = owners;
          stale = false;
        }),
      ),
    );
  /** Kept for this session even when storage refuses it; the refusal is logged. */
  const write = (owners: AccountOwners) =>
    Effect.sync(() => (current = owners)).pipe(
      Effect.andThen(store.write(owners)),
      Effect.tap(() => Effect.sync(() => (stale = false))),
      Effect.catch((error) =>
        Effect.sync(() => (stale = true)).pipe(
          Effect.andThen(
            Effect.logWarning("Could not store which Connect account saved each machine.", {
              error,
            }),
          ),
        ),
      ),
    );
  return { read, writeOrFail, write, stale: () => stale };
}

/**
 * How the registry records the owner of a save. The save is noted before the
 * catalog write and its owner recorded after it, so a save that fails or is
 * cut short changes nobody's machine, and one that lands is never left without
 * its owner. Callers hold the machine's lease and `accountLock`.
 */
export function makeOwnerSaves(owners: ReturnType<typeof makeOwnerMemory>) {
  /**
   * The account signed in when a machine is saved owns it, even one an earlier
   * account saved: saving it again is a choice the new account made. Nothing
   * is recorded before the first account has settled. Fails when the note
   * cannot be stored, so the save does not go ahead untracked. Returns whether
   * a note was made: only that save may finish or cancel it. `saved` says
   * whether the machine is saved now: a record left from before it was removed
   * is not inherited, so a machine added again while signed out is new.
   */
  const beginOwnerSaveLocked = Effect.fn("EnvironmentRegistry.beginOwnerSaveLocked")(function* (
    environmentId: EnvironmentId,
    scope: string | null | undefined,
    routes: ReadonlyArray<unknown>,
    saved: boolean,
  ) {
    const stored = yield* owners.read;
    const owner = ownerForSave(scope, saved ? stored?.machines[environmentId] : undefined);
    if (owner === undefined || stored === null) return false;
    // Notes left by an earlier session are settled by the first plan, before
    // any save can begin, so a note here is never overwritten.
    yield* owners.writeOrFail(
      beginPendingSave(stored, environmentId, { owner, fingerprint: routesFingerprint(routes) }),
    );
    return true;
  });

  /** Finishes or cancels the note this save made. */
  const endOwnerSaveLocked = (
    environmentId: EnvironmentId,
    begun: boolean,
    end: (stored: AccountOwners, environmentId: string) => AccountOwners,
  ) =>
    Effect.gen(function* () {
      if (!begun) return;
      const stored = yield* owners.read;
      if (stored?.saving?.[environmentId] === undefined) return;
      yield* owners.write(end(stored, environmentId));
    });

  /** Whether this save takes the machine from another account; see `saveTakesMachine`. */
  const takesMachineLocked = (environmentId: EnvironmentId, scope: string | null | undefined) =>
    owners.read.pipe(Effect.map((stored) => saveTakesMachine(stored, environmentId, scope)));

  return { beginOwnerSaveLocked, endOwnerSaveLocked, takesMachineLocked };
}

/** A stable fingerprint of a list of saved routes: key order never matters. */
export function routesFingerprint(routes: ReadonlyArray<unknown>): string {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.keys(value)
          .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
          .sort()
          .map((key) => [key, stable((value as Record<string, unknown>)[key])]),
      );
    }
    return value;
  };
  return JSON.stringify(stable(routes));
}

/** The fingerprint of each saved machine's routes now, to settle saves cut short. */
export function savedFingerprints(
  entries: ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>,
  saved: ReadonlyArray<EnvironmentId>,
): ReadonlyMap<string, string> {
  return new Map(
    saved.flatMap((environmentId) => {
      const entry = entries.get(environmentId);
      if (entry === undefined) return [];
      return [
        [environmentId as string, routesFingerprint(connectionRoutes(entry).map((r) => r.target))],
      ];
    }),
  );
}
