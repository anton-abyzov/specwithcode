import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as Projects from "../project/ProjectService.ts";
import * as Instances from "../provider/ProviderInstanceRegistry.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as Settings from "../serverSettings.ts";
import * as Fallback from "./ProviderFallbackWorker.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

it.effect("builds the production fallback layer and registers its sweep", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(60_000);
    const registrations: string[] = [];
    const dependencies = Layer.mergeAll(
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
    assert.deepEqual(registrations, ["provider-fallback"]);
  }).pipe(Effect.scoped),
);
