import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { projectionAccess } from "../connection/projectionAccess.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";

/** End the whole projection scope on denial, including subscriptions, HTTP
 * loads, history paging and delayed writes. Reauthorization starts a new scope. */
export const authorizedProjection = Effect.fn("authorizedProjection")(function* <A, R>(
  empty: A,
  make: (
    state: SubscriptionRef.SubscriptionRef<A>,
    isCurrent: () => boolean,
  ) => Effect.Effect<void, never, R>,
) {
  const supervisor = yield* EnvironmentSupervisor;
  const cache = yield* EnvironmentCacheStore;
  const access = projectionAccess(cache, supervisor.target.environmentId);
  const visible = yield* SubscriptionRef.make(empty);
  const initialized = yield* Deferred.make<void>();

  yield* SubscriptionRef.changes(supervisor.state).pipe(
    Stream.mapEffect((event) => access.observe(supervisor.state, event)),
    Stream.changes,
    Stream.tap((epoch) => (epoch === null ? SubscriptionRef.set(visible, empty) : Effect.void)),
    Stream.switchMap((epoch) =>
      Stream.fromEffect(
        Effect.gen(function* () {
          if (epoch === null) {
            yield* SubscriptionRef.set(visible, empty);
            yield* Deferred.succeed(initialized, undefined);
            yield* access.purge;
          } else {
            yield* access.purge;
            yield* make(visible, () => access.isCurrent(epoch)).pipe(
              Effect.provideService(EnvironmentCacheStore, access.forEpoch(epoch)),
            );
            yield* Deferred.succeed(initialized, undefined);
          }
          return yield* Effect.never;
        }).pipe(Effect.scoped),
      ),
    ),
    Stream.runDrain,
    Effect.forkScoped({ startImmediately: true }),
  );
  yield* Deferred.await(initialized);
  return visible;
});
