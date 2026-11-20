import type { EnvironmentId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

import type * as Persistence from "../platform/persistence.ts";
import { type AccountOwners, beginPendingSave, ownerForNewSave } from "./accountOwners.ts";
import type { ConnectionCatalogEntry } from "./catalog.ts";
import { connectionRouteId, connectionRoutes } from "./routes.ts";

/**
 * How the registry records the owner of a save (1434). The save is noted
 * before the catalog write and its owner recorded after it, so a save that
 * fails or is cut short changes nobody's machine, and one that lands is never
 * left without its owner. Callers hold the machine's lease and `accountLock`.
 */
export function makeOwnerSaves(accountOwners: {
  readonly read: Effect.Effect<AccountOwners | null>;
  readonly write: (
    owners: AccountOwners,
  ) => Effect.Effect<void, Persistence.ConnectionPersistenceError>;
}) {
  /**
   * The account signed in when a machine is saved owns it, even one an earlier
   * account saved: saving it again is a choice the new account made. Nothing
   * is recorded before the first account has settled. Fails when the note
   * cannot be stored, so the save does not go ahead untracked.
   */
  const beginOwnerSaveLocked = Effect.fn("EnvironmentRegistry.beginOwnerSaveLocked")(function* (
    environmentId: EnvironmentId,
    scope: string | null | undefined,
    route: { readonly routeId: string; readonly routeWasSaved: boolean },
  ) {
    const owner = ownerForNewSave(scope);
    const stored = yield* accountOwners.read;
    if (owner === undefined || stored === null) return;
    yield* accountOwners.write(beginPendingSave(stored, environmentId, { owner, ...route }));
  });

  /** Finishes or cancels a noted save; one that cannot be stored is settled by the next plan. */
  const endOwnerSaveLocked = (
    environmentId: EnvironmentId,
    end: (stored: AccountOwners, environmentId: string) => AccountOwners,
  ) =>
    Effect.gen(function* () {
      const stored = yield* accountOwners.read;
      if (stored?.saving?.[environmentId] === undefined) return;
      yield* accountOwners.write(end(stored, environmentId));
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not record a machine's Connect owner.", { environmentId, error }),
      ),
    );

  return { beginOwnerSaveLocked, endOwnerSaveLocked };
}

/** The route ids each saved machine has now, to settle saves cut short. */
export function savedRouteIds(
  entries: ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>,
  saved: ReadonlyArray<EnvironmentId>,
): ReadonlyMap<string, ReadonlySet<string>> {
  return new Map(
    saved.map((environmentId) => {
      const entry = entries.get(environmentId);
      const routes = entry === undefined ? [] : connectionRoutes(entry);
      return [
        environmentId as string,
        new Set(routes.map((route) => connectionRouteId(route.target))),
      ];
    }),
  );
}
