import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import { resolveSymlinkTarget } from "@specweave-studio/shared/symlink";

/**
 * Windows refuses a rename over a file another process holds open without
 * delete sharing (a virus scanner, the search indexer). The same codes also
 * mean a denial that never clears, so retries are bounded.
 */
export const isWindowsRenameLock = (error: PlatformError.PlatformError) => {
  const code = (error.reason.cause as NodeJS.ErrnoException | undefined)?.code;
  return code === "EBUSY" || code === "EPERM" || code === "EACCES";
};

/**
 * The mode a save leaves: the replaced file's, or owner-only for a new file.
 * The owner keeps read and write, so a save also repairs a file it could not
 * read. Set with chmod after writing, since the umask narrows the mode a file
 * is opened with.
 */
const modeAfterSave = (fs: FileSystem.FileSystem, targetPath: string) =>
  fs.stat(targetPath).pipe(
    Effect.map((info) => (info.mode & 0o777) | 0o600),
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed(0o600),
    ),
  );

/**
 * Writes a save's temp file. Synced before the rename, since otherwise a crash
 * soon after it can leave the target empty; closed before it too, which
 * Windows needs. Off Windows it takes the mode the save leaves.
 */
export const writeSyncedTemp = (input: {
  readonly fs: FileSystem.FileSystem;
  readonly platform: NodeJS.Platform;
  readonly tempPath: string;
  readonly targetPath: string;
  readonly contents: Uint8Array;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { fs, tempPath } = input;
      const file = yield* fs.open(tempPath, { flag: "w" });
      yield* file.writeAll(input.contents);
      if (input.platform !== "win32") {
        yield* fs.chmod(tempPath, yield* modeAfterSave(fs, input.targetPath));
      }
      yield* file.sync;
    }),
  );

/**
 * Makes a rename into `directory` durable. Best effort: the rename has landed
 * by then, so a folder this process cannot open (replacing a file needs only
 * write and search access to it) or cannot sync (Windows, some filesystems)
 * leaves the save standing.
 */
export const syncFolder = (fs: FileSystem.FileSystem, directory: string) =>
  fs.open(directory, { flag: "r" }).pipe(
    Effect.flatMap((folder) => folder.sync),
    Effect.scoped,
    Effect.catch((error) =>
      Effect.logDebug("A saved file's folder could not be synced", { directory, error }),
    ),
  );

// About 2 seconds. Settings and keybinding saves hold their write lock while
// they wait, so a denial that is not a brief scan has to surface quickly.
const LOCKED_RENAME_RETRIES = 20;
const LOCKED_RENAME_RETRY_DELAY = "100 millis";

/**
 * Replaces a file's contents via a sibling temp file and rename. A symlinked
 * target is resolved first so the link survives and its destination is
 * rewritten, since renaming over the link itself would swap it for a regular file.
 * On Windows a rename refused by a brief lock is retried (see isWindowsRenameLock).
 * Elsewhere the save keeps the replaced file's mode, creates a new one owner-only,
 * and syncs the data and the rename to disk.
 */
export const writeFileStringAtomically = (input: {
  readonly filePath: string;
  readonly contents: string;
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

      yield* writeSyncedTemp({
        fs,
        platform,
        tempPath,
        targetPath,
        contents: new TextEncoder().encode(input.contents),
      });
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
