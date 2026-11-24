/**
 * What this machine learned about the other machines of its Percy (1448
 * T-14), in memory: each one's state for `status`, the members a linked
 * member lists (so this seat can accept them as vouched for), and the grants
 * this machine holds that a peer refused (so the pair's driver flips to the
 * side whose grant works). Written by the share engine and the reconciler,
 * read by `PersonalShare.status` through `PersonalSharePeers`.
 *
 * @module PersonalShareState
 */
import type { EnvironmentId } from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { PersonalSharePeers, type PersonalSharePeerState } from "./PersonalShare.ts";

/** How long a grant a peer refused stays out of the driver rule before it is tried again. */
export const REFUSED_GRANT_HOLD_MS = 30 * 60_000;

interface Store {
  readonly states: ReadonlyMap<EnvironmentId, PersonalSharePeerState & { readonly at: number }>;
  readonly vouches: ReadonlyMap<EnvironmentId, ReadonlySet<string>>;
  readonly refused: ReadonlyMap<EnvironmentId, number>;
}

export class PersonalShareStates extends Context.Service<
  PersonalShareStates,
  {
    readonly record: (
      environmentId: EnvironmentId,
      state: PersonalSharePeerState,
    ) => Effect.Effect<void>;
    readonly states: Effect.Effect<ReadonlyMap<EnvironmentId, PersonalSharePeerState>>;
    /** When this machine last recorded a state for the peer, in epoch milliseconds. */
    readonly recordedAt: (environmentId: EnvironmentId) => Effect.Effect<number | null>;
    /** The members a linked member listed when it last accepted this machine. */
    readonly setVouches: (
      member: EnvironmentId,
      members: ReadonlyArray<string>,
    ) => Effect.Effect<void>;
    readonly vouches: Effect.Effect<ReadonlyMap<EnvironmentId, ReadonlySet<string>>>;
    /** The peer refused the grant this machine holds there; held out of the driver rule for a while. */
    readonly markHeldRefused: (environmentId: EnvironmentId) => Effect.Effect<void>;
    readonly heldRefused: (environmentId: EnvironmentId) => Effect.Effect<boolean>;
    readonly clearHeldRefused: (environmentId: EnvironmentId) => Effect.Effect<void>;
  }
>()("specweave-studio/project/PersonalShareState/PersonalShareStates") {}

export const make = Effect.gen(function* () {
  const store = yield* Ref.make<Store>({
    states: new Map(),
    vouches: new Map(),
    refused: new Map(),
  });
  const update = (change: (current: Store) => Store) => Ref.update(store, change);
  return PersonalShareStates.of({
    record: (environmentId, state) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((at) =>
          update((current) => {
            const previous = current.states.get(environmentId);
            // A pass that did not sync keeps the time the pair was last in step.
            const lastSyncedAt = state.lastSyncedAt ?? previous?.lastSyncedAt;
            return {
              ...current,
              states: new Map(current.states).set(environmentId, {
                state: state.state,
                ...(state.detail === undefined ? {} : { detail: state.detail }),
                ...(lastSyncedAt === undefined ? {} : { lastSyncedAt }),
                at,
              }),
            };
          }),
        ),
      ),
    states: Ref.get(store).pipe(
      Effect.map(
        (current) =>
          new Map(
            [...current.states].map(([id, { at: _at, ...state }]) => [id, state] as const),
          ) as ReadonlyMap<EnvironmentId, PersonalSharePeerState>,
      ),
    ),
    recordedAt: (environmentId) =>
      Ref.get(store).pipe(Effect.map((current) => current.states.get(environmentId)?.at ?? null)),
    setVouches: (member, members) =>
      update((current) => ({
        ...current,
        vouches: new Map(current.vouches).set(member, new Set(members.slice(0, 64))),
      })),
    vouches: Ref.get(store).pipe(Effect.map((current) => current.vouches)),
    markHeldRefused: (environmentId) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          update((current) => ({
            ...current,
            refused: new Map(current.refused).set(environmentId, now + REFUSED_GRANT_HOLD_MS),
          })),
        ),
      ),
    heldRefused: (environmentId) =>
      Effect.gen(function* () {
        const until = (yield* Ref.get(store)).refused.get(environmentId);
        return until !== undefined && until > (yield* Clock.currentTimeMillis);
      }),
    clearHeldRefused: (environmentId) =>
      update((current) => {
        if (!current.refused.has(environmentId)) return current;
        const refused = new Map(current.refused);
        refused.delete(environmentId);
        return { ...current, refused };
      }),
  });
});

/** One instance per server: the engine, the reconciler and `status` share it. */
export const layer = Layer.effect(PersonalShareStates, make);

/** `PersonalShare.status` reads the peer states through its optional seam. */
export const layerPeers = Layer.effect(
  PersonalSharePeers,
  Effect.gen(function* () {
    const states = yield* PersonalShareStates;
    return PersonalSharePeers.of({ states: states.states });
  }),
);
