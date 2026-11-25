import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { DesktopArtifactApp } from "@specweave-studio/contracts";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import * as ArtifactAppRecords from "./ArtifactAppRecords.ts";

const app = (
  installId: string,
  overrides: Partial<DesktopArtifactApp> = {},
): DesktopArtifactApp => ({
  installId,
  name: "Morning dashboard",
  environmentId: "environment-1",
  threadId: "thread-1",
  attachmentId: "attachment-1",
  title: "Morning dashboard",
  installedAt: "2026-11-24T12:00:00.000Z",
  ...overrides,
});

const idFor = (index: number) => index.toString(16).padStart(32, "0");
const ID_A = "a".repeat(32);
const ID_B = "b".repeat(32);

// A private test home per test; nothing touches the person's user data.
const withHome = <A, E>(
  body: (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly directory: string;
    readonly recordsPath: string;
    readonly open: (
      fileSystem?: FileSystem.FileSystem,
    ) => Effect.Effect<ArtifactAppRecords.ArtifactAppRecords["Service"]>;
  }) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "studio-desktop-artifact-app-records-test-",
    });
    const recordsPath = path.join(
      directory,
      "user-data",
      ArtifactAppRecords.ARTIFACT_APPS_RECORD_FILE,
    );
    const open = (override: FileSystem.FileSystem = fileSystem) =>
      Effect.service(ArtifactAppRecords.ArtifactAppRecords).pipe(
        Effect.provide(ArtifactAppRecords.layer(recordsPath)),
        Effect.provideService(FileSystem.FileSystem, override),
        Effect.provideService(Path.Path, path),
      );
    return yield* body({ fileSystem, path, directory, recordsPath, open });
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

const readDocument = (fileSystem: FileSystem.FileSystem, recordsPath: string) =>
  fileSystem.readFileString(recordsPath).pipe(Effect.map((raw) => JSON.parse(raw) as unknown));

const writeRaw = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  recordsPath: string,
  contents: string,
) =>
  fileSystem
    .makeDirectory(path.dirname(recordsPath), { recursive: true })
    .pipe(Effect.andThen(fileSystem.writeFileString(recordsPath, contents)));

const temporaryFiles = (fileSystem: FileSystem.FileSystem, path: Path.Path, recordsPath: string) =>
  fileSystem
    .readDirectory(path.dirname(recordsPath))
    .pipe(Effect.map((names) => names.filter((name) => name.endsWith(".tmp"))));

describe("ArtifactAppRecords", () => {
  it.effect("reads a missing file as no installs", () =>
    withHome(({ open }) =>
      Effect.gen(function* () {
        const records = yield* open();
        assert.deepEqual(yield* records.list, []);
        assert.isTrue(Option.isNone(yield* records.get(ID_A)));
      }),
    ),
  );

  it.effect("adds installs to a versioned 0600 JSON file", () =>
    withHome(({ fileSystem, open, recordsPath }) =>
      Effect.gen(function* () {
        const records = yield* open();
        yield* records.add(app(ID_A));
        yield* records.add(app(ID_B, { name: "Board", title: "Board" }));

        assert.deepEqual(yield* records.list, [
          app(ID_A),
          app(ID_B, { name: "Board", title: "Board" }),
        ]);
        assert.deepEqual(
          yield* records.get(ID_B),
          Option.some(app(ID_B, { name: "Board", title: "Board" })),
        );
        assert.deepEqual(yield* readDocument(fileSystem, recordsPath), {
          version: 1,
          apps: [app(ID_A), app(ID_B, { name: "Board", title: "Board" })],
        });
        if ((yield* HostProcessPlatform) !== "win32") {
          const info = yield* fileSystem.stat(recordsPath);
          assert.equal(info.mode & 0o777, 0o600);
        }
      }),
    ),
  );

  it.effect("rewrites a loose file as 0600", () =>
    withHome(({ fileSystem, path, open, recordsPath }) =>
      Effect.gen(function* () {
        if ((yield* HostProcessPlatform) === "win32") return;
        yield* writeRaw(fileSystem, path, recordsPath, JSON.stringify({ version: 1, apps: [] }));
        yield* fileSystem.chmod(recordsPath, 0o644);
        const records = yield* open();
        yield* records.add(app(ID_A));
        const info = yield* fileSystem.stat(recordsPath);
        assert.equal(info.mode & 0o777, 0o600);
      }),
    ),
  );

  it.effect("replaces an install with the same id in place", () =>
    withHome(({ open }) =>
      Effect.gen(function* () {
        const records = yield* open();
        yield* records.add(app(ID_A));
        yield* records.add(app(ID_B));
        yield* records.add(app(ID_A, { name: "Renamed" }));
        assert.deepEqual(yield* records.list, [app(ID_A, { name: "Renamed" }), app(ID_B)]);
      }),
    ),
  );

  it.effect("removes an install and reports whether it was recorded", () =>
    withHome(({ fileSystem, open, recordsPath }) =>
      Effect.gen(function* () {
        const records = yield* open();
        assert.isFalse(yield* records.remove(ID_A));
        assert.isFalse(yield* fileSystem.exists(recordsPath));

        yield* records.add(app(ID_A));
        yield* records.add(app(ID_B));
        assert.isTrue(yield* records.remove(ID_A));
        assert.isFalse(yield* records.remove(ID_A));
        assert.deepEqual(yield* records.list, [app(ID_B)]);
      }),
    ),
  );

  it.effect("reads malformed JSON as no installs and replaces it on the next write", () =>
    withHome(({ fileSystem, path, open, recordsPath }) =>
      Effect.gen(function* () {
        yield* writeRaw(fileSystem, path, recordsPath, "{ not json");
        const records = yield* open();
        assert.deepEqual(yield* records.list, []);
        yield* records.add(app(ID_A));
        assert.deepEqual(yield* records.list, [app(ID_A)]);
      }),
    ),
  );

  it.effect.each<readonly [string, string]>([
    ["an array", "[]"],
    ["no apps", JSON.stringify({ version: 1 })],
    ["apps not an array", JSON.stringify({ version: 1, apps: {} })],
    ["an older version", JSON.stringify({ version: 0, apps: [app(ID_A)] })],
    ["empty", ""],
  ])("reads %s as no installs", ([_label, contents]) =>
    withHome(({ fileSystem, path, open, recordsPath }) =>
      Effect.gen(function* () {
        yield* writeRaw(fileSystem, path, recordsPath, contents);
        const records = yield* open();
        assert.deepEqual(yield* records.list, []);
      }),
    ),
  );

  it.effect("drops bad entries and keeps the first of duplicate ids", () =>
    withHome(({ fileSystem, path, open, recordsPath }) =>
      Effect.gen(function* () {
        const document = {
          version: 1,
          apps: [
            app(ID_A),
            { ...app(ID_B), installId: ID_B.toUpperCase() },
            { ...app(ID_B), installId: "b".repeat(31) },
            { ...app(ID_B), threadId: 7 },
            { installId: ID_B },
            null,
            "text",
            app(ID_A, { name: "Duplicate" }),
            app(ID_B),
          ],
        };
        yield* writeRaw(fileSystem, path, recordsPath, JSON.stringify(document));
        const records = yield* open();
        assert.deepEqual(yield* records.list, [app(ID_A), app(ID_B)]);
        assert.deepEqual(yield* records.get(ID_A), Option.some(app(ID_A)));
      }),
    ),
  );

  it.effect("never overwrites a file from a newer build", () =>
    withHome(({ fileSystem, path, open, recordsPath }) =>
      Effect.gen(function* () {
        const newer = JSON.stringify({ version: 2, apps: [app(ID_A)] });
        yield* writeRaw(fileSystem, path, recordsPath, newer);
        const records = yield* open();
        assert.deepEqual(yield* records.list, []);
        const error = yield* records.add(app(ID_B)).pipe(Effect.flip);
        assert.instanceOf(error, ArtifactAppRecords.ArtifactAppRecordsWriteError);
        assert.equal(error.operation, "read-records");
        assert.equal(yield* fileSystem.readFileString(recordsPath), newer);
      }),
    ),
  );

  it.effect("never overwrites the file when it cannot be read", () =>
    withHome(({ fileSystem, open, recordsPath }) =>
      Effect.gen(function* () {
        const records = yield* open();
        yield* records.add(app(ID_A));
        const saved = yield* fileSystem.readFileString(recordsPath);
        const cause = PlatformError.systemError({
          _tag: "PermissionDenied",
          module: "FileSystem",
          method: "readFileString",
          pathOrDescriptor: recordsPath,
        });
        const blocked = yield* open(
          FileSystem.FileSystem.of({
            ...fileSystem,
            readFileString: () => Effect.fail(cause),
          }),
        );
        assert.deepEqual(yield* blocked.list, []);
        const addError = yield* blocked.add(app(ID_B)).pipe(Effect.flip);
        assert.equal(addError.operation, "read-records");
        assert.strictEqual(addError.cause, cause);
        const removeError = yield* blocked.remove(ID_A).pipe(Effect.flip);
        assert.equal(removeError.operation, "read-records");
        assert.equal(yield* fileSystem.readFileString(recordsPath), saved);
      }),
    ),
  );

  it.effect("keeps the old file and no temporary file when the rename fails", () =>
    withHome(({ fileSystem, path, open, recordsPath }) =>
      Effect.gen(function* () {
        const records = yield* open();
        yield* records.add(app(ID_A));
        const saved = yield* fileSystem.readFileString(recordsPath);
        const failing = yield* open(
          FileSystem.FileSystem.of({
            ...fileSystem,
            rename: (from) =>
              Effect.fail(
                PlatformError.systemError({
                  _tag: "Busy",
                  module: "FileSystem",
                  method: "rename",
                  pathOrDescriptor: from,
                }),
              ),
          }),
        );
        const error = yield* failing.add(app(ID_B)).pipe(Effect.flip);
        assert.instanceOf(error, ArtifactAppRecords.ArtifactAppRecordsWriteError);
        assert.equal(error.operation, "replace-records-file");
        assert.equal(error.path, recordsPath);
        assert.equal(
          error.message,
          `Installed page records write failed during replace-records-file at ${recordsPath}.`,
        );
        assert.equal(yield* fileSystem.readFileString(recordsPath), saved);
        assert.deepEqual(yield* temporaryFiles(fileSystem, path, recordsPath), []);
      }),
    ),
  );

  it.effect("serializes concurrent writes so none is lost", () =>
    withHome(({ fileSystem, path, open, recordsPath }) =>
      Effect.gen(function* () {
        const records = yield* open();
        const ids = Array.from({ length: 20 }, (_, index) => idFor(index + 1));
        yield* Effect.forEach(ids, (installId) => records.add(app(installId)), {
          concurrency: "unbounded",
          discard: true,
        });
        const listed = yield* records.list;
        assert.deepEqual(listed.map((entry) => entry.installId).toSorted(), ids.toSorted());
        yield* Effect.forEach(ids.slice(0, 10), (installId) => records.remove(installId), {
          concurrency: "unbounded",
          discard: true,
        });
        assert.deepEqual(
          (yield* records.list).map((entry) => entry.installId).toSorted(),
          ids.slice(10).toSorted(),
        );
        assert.deepEqual(yield* temporaryFiles(fileSystem, path, recordsPath), []);
      }),
    ),
  );

  it.effect("rejects an entry the contract would not accept and leaves the file alone", () =>
    withHome(({ fileSystem, open, recordsPath }) =>
      Effect.gen(function* () {
        const records = yield* open();
        yield* records.add(app(ID_A));
        const saved = yield* fileSystem.readFileString(recordsPath);
        const error = yield* records.add(app("not-an-install-id")).pipe(Effect.flip);
        assert.equal(error.operation, "encode-document");
        assert.equal(yield* fileSystem.readFileString(recordsPath), saved);
      }),
    ),
  );
});
