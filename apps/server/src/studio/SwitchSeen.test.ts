import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { HostProcessEnvironment } from "@specweave-studio/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Settings from "../serverSettings.ts";
import * as Capacity from "./Capacity.ts";
import { provider, rawSnapshot, settings } from "./fixtures.ts";
import * as NativeRoute from "./NativeRoute.ts";
import { SwitchFetch } from "./SwitchClient.ts";
import * as SwitchSeen from "./SwitchSeen.ts";

const configLayer = Layer.fresh(
  ServerConfig.layerTest("/tmp", { prefix: "studio-switch-seen-test-" }),
).pipe(Layer.provideMerge(NodeServices.layer));

/** A store built now, the way a server start builds it. */
const startedStore = Effect.gen(function* () {
  return yield* SwitchSeen.SwitchSeen;
}).pipe(Effect.provide(SwitchSeen.layer));

it.layer(configLayer)("the record that Switch answered on this machine", (it) => {
  it.effect("starts unseen, and keeps the first answer across restarts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const file = path.join(stateDir, "switch-seen");

      const first = yield* startedStore;
      assert.isFalse(yield* first.get);
      assert.isFalse(yield* fs.exists(file));

      yield* first.mark;
      yield* first.mark;
      assert.isTrue(yield* first.get);
      assert.isTrue(yield* fs.exists(file));

      const afterRestart = yield* startedStore;
      assert.isTrue(yield* afterRestart.get);
    }),
  );
});

/** The Overview's read through the layer the server runs, with Switch up or down. */
const serverRead = (switchUp: boolean) =>
  Effect.flatMap(Capacity.Capacity, (capacity) => capacity.current).pipe(
    Effect.provide(
      Capacity.layerLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(NativeRoute.NativeRoute, { verify: () => Effect.succeed(true) }),
            Layer.mock(Settings.ServerSettingsService)({ getSettings: Effect.succeed(settings) }),
            Layer.mock(Providers.ProviderRegistry)({
              getProviders: Effect.succeed([provider()]),
            }),
          ),
        ),
      ),
    ),
    Effect.provideService(HostProcessEnvironment, {}),
    Effect.provideService(SwitchFetch, (async () => {
      if (!switchUp) throw new Error("nothing listens on the Switch port");
      return Response.json(rawSnapshot());
    }) as typeof fetch),
  );

it.layer(
  Layer.fresh(ServerConfig.layerTest("/tmp", { prefix: "studio-switch-seen-server-" })).pipe(
    Layer.provideMerge(NodeServices.layer),
  ),
)("the capacity layer the server runs", (it) => {
  it.effect("stays quiet until Switch answers, then warns across restarts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const file = path.join(stateDir, "switch-seen");

      const fresh = yield* serverRead(false);
      assert.isFalse(fresh.available);
      assert.isNull(fresh.error);
      assert.strictEqual(fresh.switchSeen, false);
      assert.isFalse(yield* fs.exists(file));

      const answered = yield* serverRead(true);
      assert.isTrue(answered.available);
      assert.strictEqual(answered.switchSeen, true);
      assert.isTrue(yield* fs.exists(file));

      // Each read builds the layer anew, as a server start does.
      const down = yield* serverRead(false);
      assert.strictEqual(down.error, "switch-unavailable");
      assert.strictEqual(down.switchSeen, true);
    }),
  );
});

it.effect("counts Switch as seen when no store is provided", () =>
  Effect.gen(function* () {
    const store = yield* SwitchSeen.SwitchSeen;
    assert.isTrue(yield* store.get);
  }),
);

it.effect("keeps an in-memory answer for tests", () =>
  Effect.gen(function* () {
    const store = SwitchSeen.makeMemorySwitchSeen(false);
    assert.isFalse(yield* store.get);
    yield* store.mark;
    assert.isTrue(yield* store.get);
  }),
);
