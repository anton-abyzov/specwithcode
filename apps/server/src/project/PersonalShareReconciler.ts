/**
 * Keeps the one Percy linked without a window open (1448 T-14, AC-17,
 * AC-18): on every linked-sync tick it goes over the machines this one
 * considers (confirmed here, link members and vouched for), picks one driver
 * per pair from the grants each side stores (`pairDriver`), and runs the
 * two-phase exchange toward the peers it drives. The other side of each pair
 * records its state when the driver calls it; a pair with no usable grant
 * either way shows `no_grant`.
 *
 * Liveness: the two sides read different records (one its held credential,
 * the other its issued policy), so both may conclude the other drives. A seat
 * that can call and has not been called for two ticks drives anyway; the
 * exchange is serialized and repeatable, so a double drive is safe.
 *
 * @module PersonalShareReconciler
 */
import type { EnvironmentId } from "@specweave-studio/contracts";
import { pairDriver } from "@specweave-studio/shared/linkedPairSync";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { PersonalShareEngine } from "./PersonalShareEngine.ts";
import { PersonalShareStates } from "./PersonalShareState.ts";

/** The linked-sync tick this rides on. */
export const PERSONAL_SHARE_TICK_MS = 60_000;
/** A peer that should drive and has not called for this long is driven from here. */
export const PERSONAL_SHARE_SILENT_MS = 2 * PERSONAL_SHARE_TICK_MS;

const WAITING_FOR_PEER = "Waiting for the other machine to call this one.";
const NO_GRANT_DETAIL =
  "The two machines have no access to each other. Pair them again with your own access.";

export class PersonalShareReconciler extends Context.Service<
  PersonalShareReconciler,
  {
    /** One pass over the candidates. Never fails. */
    readonly tick: Effect.Effect<void>;
  }
>()("specweave-studio/project/PersonalShareReconciler") {}

export interface PersonalShareReconcilerDeps {
  readonly selfEnvironmentId: EnvironmentId;
  readonly engine: PersonalShareEngine["Service"];
  readonly states: PersonalShareStates["Service"];
}

export const makePersonalShareReconciler = (deps: PersonalShareReconcilerDeps) =>
  Effect.sync(() => {
    const { selfEnvironmentId: self, engine, states } = deps;
    /** When this machine first considered each peer, so a new peer gets its own ticks first. */
    const firstSeen = new Map<EnvironmentId, number>();

    const one = (peer: EnvironmentId) =>
      Effect.gen(function* () {
        const reach = yield* engine.reach(peer);
        const driver = pairDriver(self, peer, reach);
        if (driver === "self") return yield* engine.exchange(peer);
        if (driver === null)
          return yield* states.record(peer, { state: "no_grant", detail: NO_GRANT_DETAIL });
        // The peer drives. Drive anyway when it has been silent and this side can call.
        const now = yield* Clock.currentTimeMillis;
        const seen = firstSeen.get(peer) ?? now;
        firstSeen.set(peer, seen);
        const called = yield* states.inboundAt(peer);
        const silent = (called ?? seen) <= now - PERSONAL_SHARE_SILENT_MS;
        if (silent && reach.selfCanCall) return yield* engine.exchange(peer);
        if ((yield* states.recordedAt(peer)) === null)
          yield* states.record(peer, { state: "waiting", detail: WAITING_FOR_PEER });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logDebug("Percy share reconcile failed for a peer", { peer, cause }),
        ),
      );

    const tick = Effect.gen(function* () {
      const candidates = yield* engine.candidates;
      // In turn: one change of this seat's link at a time keeps the join order readable.
      yield* Effect.forEach(candidates, one, { discard: true });
    }).pipe(
      Effect.catchCause((cause) => Effect.logDebug("Percy share reconcile failed", { cause })),
    );

    return PersonalShareReconciler.of({ tick });
  });

export const make = Effect.gen(function* () {
  const environment = yield* ServerEnvironment.ServerEnvironment;
  return yield* makePersonalShareReconciler({
    selfEnvironmentId: yield* environment.getEnvironmentId,
    engine: yield* PersonalShareEngine,
    states: yield* PersonalShareStates,
  });
});

/** Needs `PersonalShareEngine`, `PersonalShareStates` and `ServerEnvironment`. */
export const layer = Layer.effect(PersonalShareReconciler, make);
