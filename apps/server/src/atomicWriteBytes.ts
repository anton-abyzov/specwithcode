import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import { resolveSymlinkTarget } from "@specweave-studio/shared/symlink";

import { isWindowsRenameLock, syncFolder, writeSyncedTemp } from "./atomicWrite.ts";

// About 2 seconds, as in atomicWrite.ts: a denial that is not a brief scan
// (Excel holding the workbook open) has to surface quickly.
const LOCKED_RENAME_RETRIES = 20;
const LOCKED_RENAME_RETRY_DELAY = "100 millis";

/**
 * Replaces a file's bytes via a sibling temp file and rename: the binary twin of
 * writeFileStringAtomically in atomicWrite.ts (kept separate so that widely
 * imported module stays unchanged), with the same symlink and Windows lock handling. A symlinked
 * target is resolved first so the link survives and its destination is
 * rewritten, since renaming over the link itself would swap it for a regular file.
 * On Windows a rename refused by a brief lock is retried (see isWindowsRenameLock).
 * Elsewhere it keeps the replaced file's mode and syncs, as atomicWrite.ts does.
 */
export const writeFileBytesAtomically = (input: {
  readonly filePath: string;
  readonly contents: Uint8Array;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const platform = yield* HostProcessPlatform;
      const targetPath = yield* resolveSymlinkTarget(input.filePath);
      const targetDirectory = path.dirname(targetPath);

      yield* fs.makeDirectory(targetDirectory, { recursive: true });
      // The temp directory is cleanup, not part of the write: failing to remove
      // it (a virus scanner holding it on Windows) must not fail a write that
      // already landed.
      const tempDirectory = yield* Effect.acquireRelease(
        fs.makeTempDirectory({
          directory: targetDirectory,
          prefix: `${path.basename(targetPath)}.`,
        }),
        (directory) => fs.remove(directory, { recursive: true }).pipe(Effect.ignore({ log: true })),
      );
      const tempPath = path.join(tempDirectory, "contents.tmp");

      yield* writeSyncedTemp({ fs, platform, tempPath, targetPath, contents: input.contents });
      if (platform !== "win32") {
        yield* fs.rename(tempPath, targetPath);
        return yield* syncFolder(fs, targetDirectory);
      }

      // A retry must not replace a save another process landed meanwhile, so it
      // stops once the target is no longer the file seen here. A read-only
      // target, or a directory in the file's place, fails with the same EPERM
      // as a held one but never clears.
      const targetVersion = fs.stat(targetPath).pipe(
        Effect.map((info) => ({
          id: `${Option.getOrUndefined(info.ino)}:${info.size}:${Option.getOrUndefined(info.mtime)?.getTime()}`,
          readOnly: (info.mode & 0o200) === 0 || info.type === "Directory",
        })),
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeed({ id: "missing", readOnly: false }),
        ),
        Effect.option,
      );
      const before = yield* targetVersion;
      const firstAttempt = yield* Effect.result(fs.rename(tempPath, targetPath));
      if (Result.isSuccess(firstAttempt)) return;
      const lockError = firstAttempt.failure;
      if (!isWindowsRenameLock(lockError) || Option.isNone(before) || before.value.readOnly) {
        return yield* lockError;
      }
      for (let retry = 0; retry < LOCKED_RENAME_RETRIES; retry += 1) {
        yield* Effect.sleep(LOCKED_RENAME_RETRY_DELAY);
        const current = yield* targetVersion;
        if (Option.isNone(current) || current.value.id !== before.value.id) break;
        const attempt = yield* Effect.result(fs.rename(tempPath, targetPath));
        if (Result.isSuccess(attempt)) return;
        if (!isWindowsRenameLock(attempt.failure)) return yield* attempt.failure;
      }
      return yield* lockError;
    }),
  );
