import type { EnvironmentId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type { EnvironmentCacheStore } from "../platform/persistence.ts";
import type { SupervisorConnectionState } from "./model.ts";

type Cache = EnvironmentCacheStore["Service"];

function makeAccess(cache: Cache, environmentId: EnvironmentId) {
  const lock = Semaphore.makeUnsafe(1);
  let epoch: object | null = {};
  let purgePending = false;

  const transition = (state: SupervisorConnectionState) => {
    if (
      state.phase === "blocked" &&
      (state.lastFailure?.reason === "authentication" || state.lastFailure?.reason === "permission")
    ) {
      if (epoch !== null) {
        epoch = null;
        purgePending = true;
      }
    } else if (state.phase === "connected" && epoch === null) {
      epoch = {};
    }
    return epoch;
  };

  // Multiple views can receive the same transition. Only a currently connected
  // supervisor may reopen access; an old queued “connected” event cannot.
  const observe = (
    states: SubscriptionRef.SubscriptionRef<SupervisorConnectionState>,
    event: SupervisorConnectionState,
  ) =>
    event.phase === "connected"
      ? SubscriptionRef.get(states).pipe(Effect.map(transition))
      : Effect.sync(() => transition(event));

  const purge = lock.withPermit(
    Effect.suspend(() =>
      purgePending
        ? cache.clear(environmentId).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                purgePending = false;
              }),
            ),
            Effect.catch(() =>
              Effect.logWarning("Could not clear denied environment cache.", { environmentId }),
            ),
            Effect.uninterruptible,
          )
        : Effect.void,
    ),
  );

  const forEpoch = (expected: object): Cache => {
    const guarded = <A, E>(run: Effect.Effect<A, E>, fallback: A) =>
      lock.withPermit(
        Effect.suspend(() =>
          epoch === expected && !purgePending
            ? Effect.uninterruptible(run)
            : Effect.succeed(fallback),
        ),
      );
    return {
      ...cache,
      loadShell: (id) => guarded(cache.loadShell(id), Option.none()),
      loadThread: (id, thread) => guarded(cache.loadThread(id, thread), Option.none()),
      saveShell: (id, shell) => guarded(cache.saveShell(id, shell), undefined),
      saveThread: (id, thread) => guarded(cache.saveThread(id, thread), undefined),
      removeThread: (id, thread) => guarded(cache.removeThread(id, thread), undefined),
    };
  };
  return { observe, purge, forEpoch, isCurrent: (candidate: object) => candidate === epoch };
}

// Separate app runtimes can use the same environment ID with different stores.
const stores = new WeakMap<Cache, Map<EnvironmentId, ReturnType<typeof makeAccess>>>();

export function projectionAccess(cache: Cache, environmentId: EnvironmentId) {
  let environments = stores.get(cache);
  if (!environments) {
    environments = new Map();
    stores.set(cache, environments);
  }
  let access = environments.get(environmentId);
  if (!access) {
    access = makeAccess(cache, environmentId);
    environments.set(environmentId, access);
  }
  return access;
}
