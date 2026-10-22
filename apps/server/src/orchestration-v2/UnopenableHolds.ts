import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { UNOPENABLE_HOLD_MS } from "./unopenableFallback.ts";

export interface UnopenableHoldsShape {
  /** Instance id to the time its latest open failure was seen. */
  readonly get: Effect.Effect<ReadonlyMap<string, number>>;
  readonly set: (held: ReadonlyMap<string, number>) => Effect.Effect<void>;
}

/**
 * The provider instances the fallback sweep holds out of fallbacks because a
 * thread could not open them (see `unopenableHolds`), shared so the
 * coordinator's turn selection keeps off them too. One per process: the
 * default is made once and kept, so it needs no layer.
 */
export const UnopenableHolds = Context.Reference<UnopenableHoldsShape>(
  "@specweave-studio/server/orchestration-v2/UnopenableHolds",
  {
    defaultValue: () => {
      const held = Ref.makeUnsafe<ReadonlyMap<string, number>>(new Map());
      return { get: Ref.get(held), set: (next) => Ref.set(held, next) };
    },
  },
);

/** The instances still held at `nowMs`. */
export const heldInstances = (nowMs: number) =>
  Effect.gen(function* () {
    const held = yield* (yield* UnopenableHolds).get;
    const ids = new Set<string>();
    for (const [instanceId, failedAt] of held)
      if (nowMs - failedAt < UNOPENABLE_HOLD_MS) ids.add(instanceId);
    return ids;
  });
