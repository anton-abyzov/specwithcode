import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Projects from "../project/ProjectService.ts";
import * as Instances from "../provider/ProviderInstanceRegistry.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as Settings from "../serverSettings.ts";
import * as EventSink from "./EventSink.ts";
import * as Fallback from "./ProviderFallbackWorker.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

it.effect("builds the production fallback layer and registers its sweeps", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(60_000);
    const registrations: string[] = [];
    const dependencies = Layer.mergeAll(
      Layer.mock(EventSink.EventSinkV2)({
        latestSequence: () => Effect.succeed(0),
        stream: () => Stream.empty,
      }),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
      Layer.mock(ThreadManagement.ThreadManagementService)({}),
      Layer.mock(Providers.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
      Layer.mock(Instances.ProviderInstanceRegistry)({}),
      Layer.mock(Projects.ProjectService)({}),
      Settings.layerTest({
        providerLimitAction: "ask",
        providerLimitRedeemResets: false,
        providerLimitSpendCredits: false,
        providerLimitUseApiCredits: false,
      }),
      Layer.succeed(Scheduler.Scheduler, {
        register: (name, sweep) =>
          Effect.sync(() => registrations.push(name)).pipe(
            // Disabled policy must be safe even before providers/projects exist.
            Effect.andThen(sweep),
            Effect.orDie,
          ),
      }),
    );
    // Do not supply ProjectAdmission here: the exported production layer must
    // wire its own shared admission dependency, as the recovery worker does.
    yield* Layer.build(Fallback.layer.pipe(Layer.provide(dependencies)));
    // The layer also carries Auto routing's escalation sweep (see the layer's comment).
    assert.deepEqual([...registrations].sort(), ["provider-fallback", "task-routing-escalation"]);
  }).pipe(Effect.scoped),
);

it.effect("wakes the sweep for failed runs only, from the latest event on", () =>
  Effect.gen(function* () {
    const wakes = yield* Ref.make(0);
    const run = (id: string, status: string) =>
      ({ event: { type: "run.updated", payload: { id, status } } }) as never;
    const streamed: Array<unknown> = [];
    yield* Fallback.wakeOnFailedRuns(Ref.update(wakes, (count) => count + 1)).pipe(
      Effect.provide(
        Layer.mock(EventSink.EventSinkV2)({
          latestSequence: () => Effect.succeed(41),
          stream: (input) => {
            streamed.push(input);
            return Stream.make(
              run("r1", "running"),
              run("r1", "failed"),
              run("r2", "completed"),
              run("r3", "failed"),
            );
          },
        }),
      ),
    );
    // Past failures are already in the snapshot the sweep reads; only new ones wake it.
    assert.deepEqual(streamed, [{ afterSequence: 41, eventType: "run.updated" }]);
    assert.strictEqual(yield* Ref.get(wakes), 2);
  }),
);
