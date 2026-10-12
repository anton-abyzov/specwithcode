import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";

import * as ServerConfig from "../config.ts";
import * as StudioMods from "./StudioMods.ts";

const MANIFEST = {
  name: "review-queue",
  version: "0.1.0",
  description: "Pane listing sessions that wait for review",
  main: "./register.js",
  permissions: ["threads:read", "threads:open", "threads:read"],
};
const MODULE = `export function register(on) {
  on("app.start", ($, e, next) => next(e));
}
`;

/** Seeds `<stateDir>/mods/<name>/` folders before the service starts. */
const withMods = <A, E>(
  seeds: Readonly<Record<string, Readonly<Record<string, string>>>>,
  body: (
    modsDir: string,
  ) => Effect.Effect<
    A,
    E,
    | StudioMods.StudioMods
    | ServerConfig.ServerConfig
    | FileSystem.FileSystem
    | Path.Path
    | Scope.Scope
  >,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-mods-" });
    const modsDir = path.join(baseDir, "userdata", "mods");
    for (const [name, files] of Object.entries(seeds)) {
      yield* fs.makeDirectory(path.join(modsDir, name), { recursive: true });
      for (const [file, contents] of Object.entries(files)) {
        yield* fs.writeFileString(path.join(modsDir, name, file), contents);
      }
    }
    return yield* body(modsDir).pipe(
      Effect.provide(
        StudioMods.layer.pipe(Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir))),
      ),
    );
  }).pipe(Effect.scoped);

const reviewQueue = { "mod.json": JSON.stringify(MANIFEST), "register.js": MODULE };

it.layer(NodeServices.layer)("StudioMods", (it) => {
  it.effect("lists a new mod as pending without sending its code", () =>
    withMods({ "review-queue": reviewQueue }, () =>
      Effect.gen(function* () {
        const mods = yield* StudioMods.StudioMods;
        const [mod] = (yield* mods.list).mods;
        assert.equal(mod?.status, "pending");
        assert.deepEqual(mod?.permissions, ["threads:read", "threads:open"]);
        assert.match(mod?.sha256 ?? "", /^[0-9a-f]{64}$/u);
        assert.isUndefined(mod?.source);
      }),
    ),
  );

  it.effect("runs an approved mod and pauses it when its files change", () =>
    withMods({ "review-queue": reviewQueue }, (modsDir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const mods = yield* StudioMods.StudioMods;
        const sha256 = (yield* mods.list).mods[0]!.sha256!;

        const approved = (yield* mods.approve({ name: "review-queue", sha256 })).mods[0];
        assert.equal(approved?.status, "approved");
        assert.equal(approved?.source, MODULE);

        yield* fs.writeFileString(
          path.join(modsDir, "review-queue", "register.js"),
          `${MODULE}// edited\n`,
        );
        const changed = (yield* mods.list).mods[0];
        assert.equal(changed?.status, "changed");
        assert.isUndefined(changed?.source);
      }),
    ),
  );

  it.effect("refuses an approval for contents the user did not review", () =>
    withMods({ "review-queue": reviewQueue }, () =>
      Effect.gen(function* () {
        const mods = yield* StudioMods.StudioMods;
        const error = yield* mods
          .approve({ name: "review-queue", sha256: "0".repeat(64) })
          .pipe(Effect.flip);
        assert.equal(error._tag, "ModsError");
        assert.include(error.message, "changed after you reviewed it");
        assert.equal((yield* mods.list).mods[0]?.status, "pending");
      }),
    ),
  );

  it.effect("disables a mod until it is approved again", () =>
    withMods({ "review-queue": reviewQueue }, () =>
      Effect.gen(function* () {
        const mods = yield* StudioMods.StudioMods;
        const sha256 = (yield* mods.list).mods[0]!.sha256!;
        yield* mods.approve({ name: "review-queue", sha256 });
        const disabled = (yield* mods.disable({ name: "review-queue" })).mods[0];
        assert.equal(disabled?.status, "disabled");
        assert.isUndefined(disabled?.source);
        assert.equal(
          (yield* mods.approve({ name: "review-queue", sha256 })).mods[0]?.status,
          "approved",
        );
      }),
    ),
  );

  it.effect("reports folders it cannot load instead of running them", () =>
    withMods(
      {
        misnamed: reviewQueue,
        "no-module": { "mod.json": JSON.stringify(MANIFEST).replace("review-queue", "no-module") },
        "bad-manifest": { "mod.json": "{", "register.js": MODULE },
        "escapes-folder": {
          "mod.json": JSON.stringify({ ...MANIFEST, name: "escapes-folder", main: "../x.js" }),
        },
      },
      () =>
        Effect.gen(function* () {
          const mods = yield* StudioMods.StudioMods;
          const byName = Object.fromEntries((yield* mods.list).mods.map((mod) => [mod.name, mod]));
          for (const name of ["misnamed", "no-module", "bad-manifest", "escapes-folder"]) {
            assert.equal(byName[name]?.status, "invalid", name);
            assert.isAbove(byName[name]?.problems.length ?? 0, 0, name);
            assert.isUndefined(byName[name]?.source, name);
          }
          assert.include(byName.misnamed?.problems[0], 'names "review-queue"');
          const error = yield* mods
            .approve({ name: "misnamed", sha256: byName.misnamed?.sha256 ?? "" })
            .pipe(Effect.flip);
          assert.include(error.message, "cannot be loaded");
        }),
    ),
  );
});
