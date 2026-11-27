/**
 * What the shell keeps about macOS shim launchers, away from the client-facing
 * install record: for each install, the app the shim was pointed at, its shim
 * server's name and the code hash of the bundle as signed. A shim is trusted
 * only while the process that connects has exactly that hash. Beside it, the
 * pages to open again after a restart. Both are 0600 files in the desktop state
 * folder; a bad file reads as empty and a bad entry is dropped.
 */
import { ArtifactAppInstallIdSchema } from "@specweave-studio/contracts";
import { fromLenientJson } from "@specweave-studio/shared/schemaJson";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import {
  makeArtifactAppPrivateFileWriter,
  type ArtifactAppPrivateFileWriteError,
} from "./ArtifactAppPrivateFile.ts";

export const ARTIFACT_APP_SHIMS_FILE = "artifact-app-shims.json";
export const ARTIFACT_APP_REOPEN_FILE = "artifact-apps-reopen.json";

const VERSION = 1;

/** How a code directory hash prints in `codesign -d`: 20 bytes as hex. */
export const ArtifactAppCdHashSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/));

/** Everything the shim's Info.plist was built from, so the bundle can be rebuilt exactly. */
export const ArtifactAppShimRecordSchema = Schema.Struct({
  hostAppPath: Schema.String,
  hostBundleId: Schema.String,
  serverName: Schema.String,
  minimumSystemVersion: Schema.String,
  cdHash: ArtifactAppCdHashSchema,
});
export type ArtifactAppShimRecord = typeof ArtifactAppShimRecordSchema.Type;

const decodeEnvelope = Schema.decodeUnknownOption(
  fromLenientJson(
    Schema.Struct({
      version: Schema.Number,
      shims: Schema.Record(Schema.String, Schema.Unknown),
    }),
  ),
);
const decodeReopen = Schema.decodeUnknownOption(
  fromLenientJson(
    Schema.Struct({ version: Schema.Number, installIds: Schema.Array(Schema.Unknown) }),
  ),
);
const decodeInstallId = Schema.decodeUnknownOption(ArtifactAppInstallIdSchema);
const decodeRecord = Schema.decodeUnknownOption(ArtifactAppShimRecordSchema);

export class ArtifactAppShimRecords extends Context.Service<
  ArtifactAppShimRecords,
  {
    readonly get: (installId: string) => Effect.Effect<Option.Option<ArtifactAppShimRecord>>;
    readonly set: (
      installId: string,
      record: ArtifactAppShimRecord,
    ) => Effect.Effect<void, ArtifactAppPrivateFileWriteError>;
    readonly remove: (installId: string) => Effect.Effect<void, ArtifactAppPrivateFileWriteError>;
    /** Remembers the pages open at quit, replacing the previous list. */
    readonly writeReopen: (
      installIds: ReadonlyArray<string>,
    ) => Effect.Effect<void, ArtifactAppPrivateFileWriteError>;
    /** The pages open at the last quit, each once: the list is removed as it is read. */
    readonly takeReopen: Effect.Effect<ReadonlyArray<string>>;
  }
>()("@specweave-studio/desktop/artifactApps/ArtifactAppShimRecords") {}

const make = Effect.fnUntraced(function* (stateDir: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const shimsPath = path.join(stateDir, ARTIFACT_APP_SHIMS_FILE);
  const reopenPath = path.join(stateDir, ARTIFACT_APP_REOPEN_FILE);
  const writeShims = makeArtifactAppPrivateFileWriter({ fileSystem, path, filePath: shimsPath });
  const writeReopenFile = makeArtifactAppPrivateFileWriter({
    fileSystem,
    path,
    filePath: reopenPath,
  });
  const writeLock = yield* Semaphore.make(1);

  const readText = (filePath: string) =>
    fileSystem.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));

  const readShims = Effect.gen(function* () {
    const envelope = decodeEnvelope(yield* readText(shimsPath));
    const shims = new Map<string, ArtifactAppShimRecord>();
    if (Option.isNone(envelope) || envelope.value.version !== VERSION) return shims;
    for (const [installId, entry] of Object.entries(envelope.value.shims)) {
      const record = decodeRecord(entry);
      if (Option.isSome(decodeInstallId(installId)) && Option.isSome(record)) {
        shims.set(installId, record.value);
      }
    }
    return shims;
  });

  const save = (shims: ReadonlyMap<string, ArtifactAppShimRecord>) =>
    writeShims(`${JSON.stringify({ version: VERSION, shims: Object.fromEntries(shims) })}\n`);

  return ArtifactAppShimRecords.of({
    get: (installId) =>
      readShims.pipe(Effect.map((shims) => Option.fromUndefinedOr(shims.get(installId)))),
    set: (installId, record) =>
      writeLock.withPermits(1)(
        Effect.gen(function* () {
          const shims = yield* readShims;
          shims.set(installId, record);
          yield* save(shims);
        }),
      ),
    remove: (installId) =>
      writeLock.withPermits(1)(
        Effect.gen(function* () {
          const shims = yield* readShims;
          if (!shims.delete(installId)) return;
          yield* save(shims);
        }),
      ),
    writeReopen: (installIds) =>
      writeReopenFile(
        `${JSON.stringify({
          version: VERSION,
          installIds: installIds.filter((id) => Option.isSome(decodeInstallId(id))),
        })}\n`,
      ),
    takeReopen: Effect.gen(function* () {
      const envelope = decodeReopen(yield* readText(reopenPath));
      yield* fileSystem.remove(reopenPath, { force: true }).pipe(Effect.ignore);
      if (Option.isNone(envelope) || envelope.value.version !== VERSION) return [];
      const ids = envelope.value.installIds.flatMap((entry) =>
        Option.toArray(decodeInstallId(entry)),
      );
      return [...new Set(ids)];
    }),
  });
});

/** Both stores in `stateDir`, the desktop state folder. */
export const layer = (
  stateDir: string,
): Layer.Layer<ArtifactAppShimRecords, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(ArtifactAppShimRecords, make(stateDir));
