import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
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
