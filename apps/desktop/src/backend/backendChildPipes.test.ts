import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

describe("backend child pipes", () => {
  // The backend gets its bootstrap on fd 3. Stopped while it is still loading,
  // it exits without reading it, and on Linux that resets the pipe. Electron
  // turns an uncaught exception into a modal dialog, which blocked the quit.
  it.live("a child that exits without reading its input raises nothing uncaught", () =>
    Effect.gen(function* () {
      const uncaught: Array<unknown> = [];
      const record = (error: unknown) => {
        uncaught.push(error);
      };
      process.on("uncaughtException", record);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => process.removeListener("uncaughtException", record)),
      );

      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const handle = yield* spawner.spawn(
        ChildProcess.make(process.execPath, ["-e", "setTimeout(() => {}, 50)"], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          additionalFds: {
            fd3: { type: "input", stream: Stream.encodeText(Stream.make("bootstrap\n")) },
          },
        }),
      );
      yield* handle.exitCode;
      yield* Effect.sleep("300 millis");

      assert.deepStrictEqual(uncaught, []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
