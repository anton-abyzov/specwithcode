/**
 * The private record of installed pages on this computer: a 0600 JSON file in
 * the app's user data. A launcher only names an install id, so this record is
 * what decides whether that id means anything. Reads are forgiving (a bad
 * entry is dropped, a malformed file reads as empty); writes are atomic and
 * serialized so two installs at once cannot lose each other.
 */
import { DesktopArtifactAppSchema, type DesktopArtifactApp } from "@specweave-studio/contracts";
import { fromLenientJson } from "@specweave-studio/shared/schemaJson";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

export const ARTIFACT_APPS_RECORD_FILE = "artifact-apps-installed.json";

const RECORDS_VERSION = 1;
const RECORDS_FILE_MODE = 0o600;

export class ArtifactAppRecordsWriteError extends Schema.TaggedError<ArtifactAppRecordsWriteError>()(
  "ArtifactAppRecordsWriteError",
  {
    operation: Schema.Literals([
      "read-records",
      "encode-document",
      "create-directory",
      "write-temporary-file",
      "replace-records-file",
    ]),
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Installed page records write failed during ${this.operation} at ${this.path}.`;
  }
}

export class ArtifactAppRecords extends Context.Service<
  ArtifactAppRecords,
  {
    readonly list: Effect.Effect<ReadonlyArray<DesktopArtifactApp>>;
    readonly get: (installId: string) => Effect.Effect<Option.Option<DesktopArtifactApp>>;
    /** Adds the install, or replaces the entry with the same install id in place. */
    readonly add: (app: DesktopArtifactApp) => Effect.Effect<void, ArtifactAppRecordsWriteError>;
    /** Forgets the install; false when it was not recorded. */
    readonly remove: (installId: string) => Effect.Effect<boolean, ArtifactAppRecordsWriteError>;
  }
>()("@specweave-studio/desktop/artifactApps/ArtifactAppRecords") {}

// The envelope is decoded loosely and each entry on its own, so one bad entry never empties the list.
const decodeEnvelope = Schema.decodeUnknownOption(
  fromLenientJson(Schema.Struct({ version: Schema.Number, apps: Schema.Array(Schema.Unknown) })),
);
const decodeApp = Schema.decodeUnknownOption(DesktopArtifactAppSchema);
const encodeDocument = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      version: Schema.Literal(RECORDS_VERSION),
      apps: Schema.Array(DesktopArtifactAppSchema),
    }),
  ),
);

type RecordsRead =
  | { readonly _tag: "Apps"; readonly apps: ReadonlyArray<DesktopArtifactApp> }
  | { readonly _tag: "Malformed" }
  | { readonly _tag: "NewerVersion"; readonly version: number };

class UnsupportedRecordsVersion extends Error {
  readonly version: number;
  constructor(version: number) {
    super(`Installed page records use version ${version}, newer than this build reads.`);
    this.version = version;
  }
}

function parseRecords(raw: string): RecordsRead {
  const envelope = decodeEnvelope(raw);
  if (Option.isNone(envelope)) return { _tag: "Malformed" };
  const { version, apps: entries } = envelope.value;
  if (version > RECORDS_VERSION) return { _tag: "NewerVersion", version };
  if (version !== RECORDS_VERSION) return { _tag: "Malformed" };
  const seen = new Set<string>();
  const apps: Array<DesktopArtifactApp> = [];
  for (const entry of entries) {
    const app = decodeApp(entry);
    if (Option.isNone(app) || seen.has(app.value.installId)) continue;
    seen.add(app.value.installId);
    apps.push(app.value);
  }
  return { _tag: "Apps", apps };
}

const make = Effect.fnUntraced(function* (filePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const writeLock = yield* Semaphore.make(1);
  // Writes are serialized in-process and the pid separates processes, so a counter names temp files.
  let temporaryFileCounter = 0;

  const readRecords: Effect.Effect<RecordsRead, PlatformError.PlatformError> = fileSystem
    .readFileString(filePath)
    .pipe(
      Effect.map(parseRecords),
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed<RecordsRead>({ _tag: "Apps", apps: [] })
            : Effect.fail(error),
      }),
    );

  const warn = (message: string, annotations: Record<string, unknown>) =>
    Effect.logWarning(message).pipe(
      Effect.annotateLogs({ component: "desktop-artifact-app-records", recordsPath: filePath }),
      Effect.annotateLogs(annotations),
    );

  const list: ArtifactAppRecords["Service"]["list"] = readRecords.pipe(
    Effect.flatMap((read) => {
      switch (read._tag) {
        case "Apps":
          return Effect.succeed(read.apps);
        case "Malformed":
          return warn("installed page records are malformed; reading none", {}).pipe(Effect.as([]));
        case "NewerVersion":
          return warn("installed page records are from a newer build; reading none", {
            version: read.version,
          }).pipe(Effect.as([]));
      }
    }),
    Effect.catchTags({
      PlatformError: (error) =>
        warn("installed page records could not be read; reading none", {
          reason: error.reason._tag,
        }).pipe(Effect.as([])),
    }),
    Effect.withSpan("desktop.artifactAppRecords.list"),
  );

  // A write starts from what is on disk. Only a missing or malformed file counts as empty: an
  // unreadable or newer file is never overwritten, or one failed read would forget every install.
  const readForWrite: Effect.Effect<
    ReadonlyArray<DesktopArtifactApp>,
    ArtifactAppRecordsWriteError
  > = readRecords.pipe(
    Effect.mapError(
      (cause) =>
        new ArtifactAppRecordsWriteError({ operation: "read-records", path: filePath, cause }),
    ),
    Effect.flatMap((read) => {
      switch (read._tag) {
        case "Apps":
          return Effect.succeed(read.apps);
        case "Malformed":
          return warn("installed page records are malformed; replacing them", {}).pipe(
            Effect.as([]),
          );
        case "NewerVersion":
          return Effect.fail(
            new ArtifactAppRecordsWriteError({
              operation: "read-records",
              path: filePath,
              cause: new UnsupportedRecordsVersion(read.version),
            }),
          );
      }
    }),
  );

  const writeRecords = Effect.fnUntraced(function* (apps: ReadonlyArray<DesktopArtifactApp>) {
    const encoded = yield* encodeDocument({ version: RECORDS_VERSION, apps }).pipe(
      Effect.mapError(
        (cause) =>
          new ArtifactAppRecordsWriteError({ operation: "encode-document", path: filePath, cause }),
      ),
    );
    const directory = path.dirname(filePath);
    yield* fileSystem.makeDirectory(directory, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new ArtifactAppRecordsWriteError({
            operation: "create-directory",
            path: directory,
            cause,
          }),
      ),
    );
    temporaryFileCounter += 1;
    const temporaryPath = `${filePath}.${process.pid}.${temporaryFileCounter}.tmp`;
    const removeTemporary = fileSystem.remove(temporaryPath, { force: true }).pipe(Effect.ignore);
    yield* fileSystem
      .writeFileString(temporaryPath, `${encoded}\n`, { mode: RECORDS_FILE_MODE })
      .pipe(
        // The mode on create is masked by the umask; set it explicitly before the file is visible.
        Effect.andThen(fileSystem.chmod(temporaryPath, RECORDS_FILE_MODE)),
        Effect.mapError(
          (cause) =>
            new ArtifactAppRecordsWriteError({
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
          new ArtifactAppRecordsWriteError({
            operation: "replace-records-file",
            path: filePath,
            cause,
          }),
      ),
      Effect.tapError(() => removeTemporary),
    );
  });

  const add = Effect.fn("desktop.artifactAppRecords.add")(function* (app: DesktopArtifactApp) {
    yield* writeLock.withPermits(1)(
      Effect.gen(function* () {
        const apps = yield* readForWrite;
        const index = apps.findIndex((existing) => existing.installId === app.installId);
        const next =
          index === -1
            ? [...apps, app]
            : apps.map((existing, at) => (at === index ? app : existing));
        yield* writeRecords(next);
      }),
    );
  });

  const remove = Effect.fn("desktop.artifactAppRecords.remove")(function* (installId: string) {
    return yield* writeLock.withPermits(1)(
      Effect.gen(function* () {
        const apps = yield* readForWrite;
        const next = apps.filter((existing) => existing.installId !== installId);
        if (next.length === apps.length) return false;
        yield* writeRecords(next);
        return true;
      }),
    );
  });

  return ArtifactAppRecords.of({
    list,
    get: (installId) =>
      list.pipe(
        Effect.map((apps) =>
          Option.fromNullishOr(apps.find((existing) => existing.installId === installId)),
        ),
      ),
    add,
    remove,
  });
});

/** The record store at `filePath`, normally `<userData>/artifact-apps-installed.json`. */
export const layer = (
  filePath: string,
): Layer.Layer<ArtifactAppRecords, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(ArtifactAppRecords, make(filePath));
