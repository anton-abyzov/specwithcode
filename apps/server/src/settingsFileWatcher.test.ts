import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { settingsFileEvents } from "./settingsFileWatcher.ts";

it.layer(NodeServices.layer)("settingsFileEvents", (it) => {
  it.effect(
    "reloads and moves the watch after a missed repoint, without repeating unchanged targets",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "studio-settings-watch-" });
          const first = path.join(root, "first", "settings.json");
          const second = path.join(root, "second", "settings.json");
          const link = path.join(root, "settings.json");
          for (const file of [first, second]) {
            yield* fs.makeDirectory(path.dirname(file), { recursive: true });
            yield* fs.writeFileString(file, "{}");
          }
          yield* fs.symlink(first, link);
          const watched: string[] = [];
          // Suppress every filesystem event, including the repoint. Recovery must
          // come from identity observation, not a lucky native watch notification.
          const silentFs = FileSystem.FileSystem.of({
            ...fs,
            watch: (directory) =>
              Stream.unwrap(
                Effect.sync(() => {
                  watched.push(directory);
                  return Stream.never;
                }),
              ),
          });
          const events = yield* settingsFileEvents(link).pipe(
            Effect.provideService(FileSystem.FileSystem, silentFs),
          );
          const changed = yield* Deferred.make<void>();
          let count = 0;
          yield* events.pipe(
            Stream.runForEach(() =>
              Effect.sync(() => {
                count++;
              }).pipe(Effect.andThen(Deferred.succeed(changed, undefined))),
            ),
            Effect.forkScoped,
          );
          yield* fs.remove(link);
          yield* fs.symlink(second, link);
          yield* Deferred.await(changed).pipe(Effect.timeout("15 seconds"));
          assert.include(watched, path.dirname(second));
          const attached = watched.length;
          yield* Effect.sleep("2200 millis");
          assert.strictEqual(count, 1);
          assert.strictEqual(watched.length, attached);
        }),
      ).pipe(TestClock.withLive),
  );
});
