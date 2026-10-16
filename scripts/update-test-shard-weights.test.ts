import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { ShardWeightsError, updateShardWeights } from "./update-test-shard-weights.ts";

// One vitest JSON reporter file: only the fields the regenerator reads, plus noise it ignores.
const report = (root: string, files: ReadonlyArray<readonly [string, number]>) =>
  JSON.stringify({
    numTotalTests: files.length,
    success: true,
    testResults: files.map(([file, milliseconds]) => ({
      name: `${root}/${file}`,
      startTime: 1_000_000,
      endTime: 1_000_000 + milliseconds,
      status: "passed",
      assertionResults: [],
    })),
  });

const fixture = Effect.fn("fixture")(function* (previous: Record<string, number>) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const base = yield* fs.makeTempDirectoryScoped({ prefix: "update-test-shard-weights-" });
  const serverRoot = path.join(base, "apps/server");
  const weightsFile = path.join(serverRoot, "src/testUtils/shardWeights.json");
  yield* fs.makeDirectory(path.dirname(weightsFile), { recursive: true });
  yield* fs.writeFileString(weightsFile, `${JSON.stringify(previous, null, 2)}\n`);
  const write = (name: string, files: ReadonlyArray<readonly [string, number]>) =>
    fs
      .writeFileString(path.join(base, name), report(serverRoot, files))
      .pipe(Effect.as(path.join(base, name)));
  const read = fs.readFileString(weightsFile);
  return { base, serverRoot, weightsFile, write, read };
});

it.layer(NodeServices.layer)("update-test-shard-weights", (it) => {
  it.effect("replaces the weights with every shard's sorted, rounded file times", () =>
    Effect.gen(function* () {
      const { serverRoot, weightsFile, write, read } = yield* fixture({
        "src/removed.test.ts": 9,
        "src/z.test.ts": 1,
      });
      const shard1 = yield* write("server-1.json", [
        ["src/z.test.ts", 12_345],
        ["src/fast.test.ts", 120],
      ]);
      const shard2 = yield* write("server-2.json", [
        ["src/a/b.test.ts", 2_049],
        ["integration/x.integration.test.ts", 500],
      ]);

      const summary = yield* updateShardWeights({
        serverRoot,
        weightsFile,
        reports: [shard1, shard2],
      });

      const text = yield* read;
      assert.strictEqual(
        text,
        `${JSON.stringify(
          {
            "integration/x.integration.test.ts": 0.5,
            "src/a/b.test.ts": 2,
            "src/z.test.ts": 12.3,
          },
          null,
          2,
        )}\n`,
      );
      assert.deepStrictEqual(summary, {
        measuredFiles: 4,
        recordedFiles: 3,
        recordedSeconds: 14.8,
        previousFiles: 2,
        previousSeconds: 10,
      });
    }),
  );

  it.effect("keeps unmeasured entries with merge and takes the slower of two runs", () =>
    Effect.gen(function* () {
      const { serverRoot, weightsFile, write, read } = yield* fixture({
        "src/kept.test.ts": 4.2,
        "src/now-fast.test.ts": 3,
        "src/z.test.ts": 1,
      });
      const first = yield* write("first.json", [
        ["src/z.test.ts", 2_000],
        ["src/now-fast.test.ts", 100],
      ]);
      const rerun = yield* write("rerun.json", [["src/z.test.ts", 3_000]]);

      yield* updateShardWeights({ serverRoot, weightsFile, reports: [first, rerun], merge: true });

      assert.deepStrictEqual(JSON.parse(yield* read), {
        "src/kept.test.ts": 4.2,
        "src/z.test.ts": 3,
      });
    }),
  );

  it.effect("refuses a report from a checkout other than --root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { base, serverRoot, weightsFile, read } = yield* fixture({ "src/z.test.ts": 1 });
      const elsewhere = path.join(base, "other.json");
      yield* fs.writeFileString(
        elsewhere,
        report("/other/checkout/apps/server", [["src/z.test.ts", 5_000]]),
      );

      const error = yield* updateShardWeights({
        serverRoot,
        weightsFile,
        reports: [elsewhere],
      }).pipe(Effect.flip);

      assert.instanceOf(error, ShardWeightsError);
      assert.strictEqual(error.operation, "locate");
      assert.include(error.message, "--root");
      assert.deepStrictEqual(JSON.parse(yield* read), { "src/z.test.ts": 1 });
    }),
  );

  it.effect("names a report that is not vitest JSON", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { base, serverRoot, weightsFile } = yield* fixture({});
      const broken = path.join(base, "broken.json");
      yield* fs.writeFileString(broken, "{ not json");

      const error = yield* updateShardWeights({ serverRoot, weightsFile, reports: [broken] }).pipe(
        Effect.flip,
      );

      assert.instanceOf(error, ShardWeightsError);
      assert.strictEqual(error.operation, "decode");
      assert.strictEqual(error.filePath, broken);
    }),
  );
});
