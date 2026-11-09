/**
 * The bridge only works if both layer groups in server.ts share one instance:
 * the sleep trigger registers on it and the runner reads it. Layers built
 * from the same value are memoized, so two branches that each provide
 * `layer` see the same bridge (N2: Bring back reaches the wake check).
 */
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { AwaySleepBridge, layer } from "./awaySleepBridge.ts";

class Registers extends Context.Service<Registers, { readonly done: true }>()(
  "specweave-studio/away/awaySleepBridge.test/Registers",
) {}
class Reads extends Context.Service<Reads, { readonly wakeCheck: Effect.Effect<boolean> }>()(
  "specweave-studio/away/awaySleepBridge.test/Reads",
) {}

describe("AwaySleepBridge", () => {
  it.effect("two groups that each provide the layer share one registration", () =>
    Effect.gen(function* () {
      let checked = 0;
      // Like the sleep trigger's group: registers its wake check.
      const sleepGroup = Layer.effect(
        Registers,
        Effect.gen(function* () {
          const bridge = yield* AwaySleepBridge;
          yield* bridge.register({
            wakeCheck: Effect.sync(() => void (checked += 1)),
            forceLocal: Effect.succeed({ ok: true, projectIds: [], threadIds: [] }),
          });
          return { done: true } as const;
        }),
      ).pipe(Layer.provide(layer));
      // Like the runner's group: reads it when Bring back meets a waiting lid close.
      const runnerGroup = Layer.effect(
        Reads,
        Effect.gen(function* () {
          const bridge = yield* AwaySleepBridge;
          return {
            wakeCheck: bridge.handlers.pipe(
              Effect.flatMap((handlers) =>
                handlers === null
                  ? Effect.succeed(false)
                  : handlers.wakeCheck.pipe(Effect.as(true)),
              ),
            ),
          };
        }),
      ).pipe(Layer.provide(layer));
      const ran = yield* Effect.gen(function* () {
        yield* Registers;
        return yield* (yield* Reads).wakeCheck;
      }).pipe(Effect.provide(Layer.mergeAll(sleepGroup, runnerGroup)));
      expect(ran).toBe(true);
      expect(checked).toBe(1);
    }),
  );
});
