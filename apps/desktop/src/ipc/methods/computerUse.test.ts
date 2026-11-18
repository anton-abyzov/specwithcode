import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  FIRST_RUN_RESUME_FILE,
  FIRST_RUN_RESUME_MAX_AGE_MS,
  takeFirstRunResume,
  writeFirstRunResume,
  type FirstRunResumeMarker,
} from "./computerUse.ts";

const AT = 1_800_000_000_000;
const marker: FirstRunResumeMarker = {
  step: "access",
  environmentId: "this-mac",
  setupIds: ["this-mac", "studio"],
  at: AT,
};

const userData = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "first-run-resume-" });
});

describe("first-run resume marker", () => {
  it.effect("a marker written by one main process is returned by the next", () =>
    Effect.gen(function* () {
      const dir = yield* userData;
      yield* writeFirstRunResume(dir, marker);
      // A new process reads the same folder: nothing is kept in memory.
      assert.deepStrictEqual(yield* takeFirstRunResume(dir, AT + 5_000), marker);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps the machines Files and commands was answered for", () =>
    Effect.gen(function* () {
      const dir = yield* userData;
      const answered = { ...marker, filesIds: ["this-mac"] };
      yield* writeFirstRunResume(dir, answered);
      assert.deepStrictEqual(yield* takeFirstRunResume(dir, AT + 5_000), answered);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("a second take returns nothing", () =>
    Effect.gen(function* () {
      const dir = yield* userData;
      yield* writeFirstRunResume(dir, marker);
      assert.isNotNull(yield* takeFirstRunResume(dir, AT));
      assert.isNull(yield* takeFirstRunResume(dir, AT));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("two windows asking at once get it once", () =>
    Effect.gen(function* () {
      const dir = yield* userData;
      yield* writeFirstRunResume(dir, marker);
      const results = yield* Effect.all(
        [takeFirstRunResume(dir, AT), takeFirstRunResume(dir, AT), takeFirstRunResume(dir, AT)],
        { concurrency: "unbounded" },
      );
      assert.strictEqual(results.filter((result) => result !== null).length, 1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("a marker older than ten minutes is deleted and returns nothing", () =>
    Effect.gen(function* () {
      const dir = yield* userData;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* writeFirstRunResume(dir, marker);
      assert.isNull(yield* takeFirstRunResume(dir, AT + FIRST_RUN_RESUME_MAX_AGE_MS + 1));
      assert.isFalse(yield* fs.exists(path.join(dir, FIRST_RUN_RESUME_FILE)));
      assert.deepStrictEqual(yield* fs.readDirectory(dir), []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("an unreadable marker is deleted and returns nothing", () =>
    Effect.gen(function* () {
      const dir = yield* userData;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(path.join(dir, FIRST_RUN_RESUME_FILE), "{not json");
      assert.isNull(yield* takeFirstRunResume(dir, AT));
      yield* fs.writeFileString(
        path.join(dir, FIRST_RUN_RESUME_FILE),
        JSON.stringify({ step: "access" }),
      );
      assert.isNull(yield* takeFirstRunResume(dir, AT));
      assert.deepStrictEqual(yield* fs.readDirectory(dir), []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("no marker returns nothing", () =>
    Effect.gen(function* () {
      assert.isNull(yield* takeFirstRunResume(yield* userData, AT));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
