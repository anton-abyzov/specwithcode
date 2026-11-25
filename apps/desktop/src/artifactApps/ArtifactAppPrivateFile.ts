/**
 * The one way installed-page stores reach the disk: a 0600 file replaced
 * atomically. The contents go to a temporary file with an unguessable name,
 * created exclusively, so a file or link already at that path makes the write
 * fail instead of writing through it; the rename then replaces the store.
 */
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { newArtifactAppInstallId } from "./ArtifactAppUrl.ts";

const PRIVATE_FILE_MODE = 0o600;

export class ArtifactAppPrivateFileWriteError extends Schema.TaggedError<ArtifactAppPrivateFileWriteError>()(
  "ArtifactAppPrivateFileWriteError",
  {
    operation: Schema.Literals(["create-directory", "write-temporary-file", "replace-file"]),
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Installed page store write failed during ${this.operation} at ${this.path}.`;
  }
}

/**
 * A writer for the store at `filePath`. Callers serialize their own writes;
 * the counter and the pid only keep temporary names apart.
 */
export function makeArtifactAppPrivateFileWriter(input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly filePath: string;
}): (contents: string) => Effect.Effect<void, ArtifactAppPrivateFileWriteError> {
  const { fileSystem, path, filePath } = input;
  let temporaryFileCounter = 0;
  return Effect.fnUntraced(function* (contents: string) {
    const directory = path.dirname(filePath);
    yield* fileSystem.makeDirectory(directory, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new ArtifactAppPrivateFileWriteError({
            operation: "create-directory",
            path: directory,
            cause,
          }),
      ),
    );
    temporaryFileCounter += 1;
    const temporaryPath = `${filePath}.${process.pid}.${temporaryFileCounter}.${newArtifactAppInstallId()}.tmp`;
    let created = false;
    const removeTemporary = Effect.suspend(() =>
      created ? fileSystem.remove(temporaryPath, { force: true }) : Effect.void,
    ).pipe(Effect.ignore);
    yield* fileSystem
      .writeFileString(temporaryPath, contents, { mode: PRIVATE_FILE_MODE, flag: "wx" })
      .pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            created = true;
          }),
        ),
        // Anything but "already there" means this write made the file and may have left it.
        Effect.tapError((error) =>
          Effect.sync(() => {
            if (error.reason._tag !== "AlreadyExists") created = true;
          }),
        ),
        // The mode on create is masked by the umask; set it explicitly before the file is visible.
        Effect.andThen(fileSystem.chmod(temporaryPath, PRIVATE_FILE_MODE)),
        Effect.mapError(
          (cause) =>
            new ArtifactAppPrivateFileWriteError({
              operation: "write-temporary-file",
              path: temporaryPath,
              cause,
            }),
        ),
        Effect.tapError(() => removeTemporary),
      );
    yield* fileSystem.rename(temporaryPath, filePath).pipe(
      Effect.mapError(
        (cause) =>
          new ArtifactAppPrivateFileWriteError({
            operation: "replace-file",
            path: filePath,
            cause,
          }),
      ),
      Effect.tapError(() => removeTemporary),
    );
  });
}
