import { resolveSymlinkTarget } from "@specweave-studio/shared/symlink";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

/** File events plus a backstop for a link repointed before fs.watch attaches. */
export const settingsFileEvents = (settingsPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const resolvedSettingsPath = path.resolve(settingsPath);
    const watchFileChanges = (filePath: string) => {
      const directory = path.dirname(filePath);
      const fileName = path.basename(filePath);
      const resolvedFilePath = path.resolve(filePath);
      return fs
        .watch(directory)
        .pipe(
          Stream.filter(
            (event) =>
              event.path === fileName ||
              event.path === filePath ||
              path.resolve(directory, event.path) === resolvedFilePath,
          ),
        );
    };
    const readLinkTarget = resolveSymlinkTarget(settingsPath).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.orElseSucceed(() => resolvedSettingsPath),
    );
    const initialTarget = yield* readLinkTarget;
    const targets = Stream.make(initialTarget).pipe(
      Stream.concat(
        Stream.merge(
          watchFileChanges(settingsPath).pipe(Stream.mapEffect(() => readLinkTarget)),
          Stream.fromEffect(readLinkTarget).pipe(Stream.repeat(Schedule.spaced("1 second"))),
        ),
      ),
      Stream.changes,
      Stream.zipWithIndex,
    );
    const targetEvents = targets.pipe(
      Stream.switchMap(([target, index]) =>
        Stream.unwrap(
          Effect.gen(function* () {
            if (target !== resolvedSettingsPath) {
              yield* fs
                .makeDirectory(path.dirname(target), { recursive: true })
                .pipe(Effect.ignore({ log: true }));
            }
            const events =
              target === resolvedSettingsPath
                ? Stream.empty
                : watchFileChanges(target).pipe(
                    Stream.map(() => undefined),
                    Stream.ignore({ log: true }),
                  );
            // Repointing changes the settings even if neither watcher saw a file event.
            // The initial target only attaches its watch; it is not a settings change.
            return index === 0 ? events : Stream.merge(Stream.succeed(undefined), events);
          }),
        ),
      ),
    );
    return Stream.merge(
      watchFileChanges(settingsPath).pipe(Stream.map(() => undefined)),
      targetEvents,
    ).pipe(Stream.debounce(Duration.millis(100)));
  });
