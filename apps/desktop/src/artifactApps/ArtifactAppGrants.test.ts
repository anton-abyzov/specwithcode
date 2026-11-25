import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import * as ArtifactAppGrants from "./ArtifactAppGrants.ts";

const ID_A = "a".repeat(32);
const ID_B = "b".repeat(32);
const SHA = "1".repeat(64);
const VERSION_1 = "thread-1-0f8fad5b-d9cb-469f-a165-70867728950e-html";
const VERSION_2 = "thread-1-1f8fad5b-d9cb-469f-a165-70867728950e-html";

const grant = (
  overrides: Partial<ArtifactAppGrants.ArtifactAppGrant> = {},
): ArtifactAppGrants.ArtifactAppGrant => ({
  installId: ID_A,
  attachmentId: VERSION_1,
  sha256: SHA,
  powers: ["notifications", "tray"],
  answeredAt: "2026-11-25T12:00:00.000Z",
  ...overrides,
});

// A private test home per test; nothing touches the person's user data.
const withHome = <A, E>(
  body: (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly grantsPath: string;
    readonly open: (
      fileSystem?: FileSystem.FileSystem,
    ) => Effect.Effect<ArtifactAppGrants.ArtifactAppGrants["Service"]>;
  }) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "studio-desktop-artifact-app-grants-test-",
    });
    const grantsPath = path.join(
      directory,
      "user-data",
      ArtifactAppGrants.ARTIFACT_APP_GRANTS_FILE,
    );
    const open = (override: FileSystem.FileSystem = fileSystem) =>
      Effect.service(ArtifactAppGrants.ArtifactAppGrants).pipe(
        Effect.provide(ArtifactAppGrants.layer(grantsPath)),
        Effect.provideService(FileSystem.FileSystem, override),
        Effect.provideService(Path.Path, path),
      );
    return yield* body({ fileSystem, path, grantsPath, open });
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

const writeRaw = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  grantsPath: string,
  contents: string,
) =>
  fileSystem
    .makeDirectory(path.dirname(grantsPath), { recursive: true })
    .pipe(Effect.andThen(fileSystem.writeFileString(grantsPath, contents)));

const document = (grants: ReadonlyArray<unknown>, version = 1) =>
  JSON.stringify({ version, grants });

describe("ArtifactAppGrants", () => {
  it.effect("records an answer per install and version in a private file", () =>
    withHome(({ fileSystem, grantsPath, open }) =>
      Effect.gen(function* () {
        const grants = yield* open();
        assert.deepEqual(yield* grants.find(ID_A, VERSION_1), Option.none());
        yield* grants.record(grant());
        yield* grants.record(grant({ installId: ID_B, powers: [] }));
        assert.deepEqual(yield* grants.find(ID_A, VERSION_1), Option.some(grant()));
        // Another version of the same install, and the same version of another install, have none.
        assert.deepEqual(yield* grants.find(ID_A, VERSION_2), Option.none());
        assert.deepEqual(
          (yield* grants.find(ID_B, VERSION_1)).pipe(Option.map((g) => g.powers)),
          Option.some([]),
        );
        // A second store on the same file reads the same answers.
        assert.deepEqual(yield* (yield* open()).find(ID_A, VERSION_1), Option.some(grant()));
        if ((yield* HostProcessPlatform) !== "win32") {
          assert.equal((yield* fileSystem.stat(grantsPath)).mode & 0o777, 0o600);
        }
      }),
    ),
  );

  it.effect("replaces the earlier answer for the same version", () =>
    withHome(({ open }) =>
      Effect.gen(function* () {
        const grants = yield* open();
        yield* grants.record(grant());
        yield* grants.record(grant({ powers: [], sha256: "2".repeat(64) }));
        assert.deepEqual(
          yield* grants.find(ID_A, VERSION_1),
          Option.some(grant({ powers: [], sha256: "2".repeat(64) })),
        );
      }),
    ),
  );

  it.effect("forgets every answer for an install and leaves the others", () =>
    withHome(({ open }) =>
      Effect.gen(function* () {
        const grants = yield* open();
        yield* grants.record(grant());
        yield* grants.record(grant({ attachmentId: VERSION_2 }));
        yield* grants.record(grant({ installId: ID_B }));
        yield* grants.forget(ID_A);
        assert.deepEqual(yield* grants.find(ID_A, VERSION_1), Option.none());
        assert.deepEqual(yield* grants.find(ID_A, VERSION_2), Option.none());
        assert.isTrue(Option.isSome(yield* grants.find(ID_B, VERSION_1)));
        // Forgetting an install with no answers writes nothing and does not fail.
        yield* grants.forget("c".repeat(32));
      }),
    ),
  );

  it.effect("keeps only the newest answers of one install", () =>
    withHome(({ open }) =>
      Effect.gen(function* () {
        const grants = yield* open();
        const versionFor = (index: number) =>
          `thread-1-${index.toString(16).padStart(8, "0")}-d9cb-469f-a165-70867728950e-html`;
        yield* grants.record(grant({ installId: ID_B }));
        for (let index = 0; index < 22; index += 1) {
          yield* grants.record(grant({ attachmentId: versionFor(index) }));
        }
        assert.isTrue(Option.isNone(yield* grants.find(ID_A, versionFor(0))));
        assert.isTrue(Option.isNone(yield* grants.find(ID_A, versionFor(1))));
        assert.isTrue(Option.isSome(yield* grants.find(ID_A, versionFor(2))));
        assert.isTrue(Option.isSome(yield* grants.find(ID_A, versionFor(21))));
        assert.isTrue(Option.isSome(yield* grants.find(ID_B, VERSION_1)));
      }),
    ),
  );

  it.effect("reads no grant from anything it does not fully understand", () =>
    withHome(({ fileSystem, path, grantsPath, open }) =>
      Effect.gen(function* () {
        const grants = yield* open();
        for (const contents of [
          "",
          "{not json",
          "[]",
          JSON.stringify({ grants: [grant()] }),
          JSON.stringify({ version: "1", grants: [grant()] }),
          JSON.stringify({ version: 1, grants: { 0: grant() } }),
          // An older or newer layout is not this one.
          document([grant()], 0),
          document([grant()], 2),
          // Entries that do not decode.
          document([{ ...grant(), sha256: "short" }]),
          document([{ ...grant(), sha256: SHA.toUpperCase().replace(/1/g, "A") }]),
          document([{ ...grant(), powers: ["notifications", "files"] }]),
          document([{ ...grant(), powers: "notifications" }]),
          document([{ ...grant(), installId: "../x" }]),
          document([{ ...grant(), attachmentId: "" }]),
          document([{ installId: ID_A, attachmentId: VERSION_1, sha256: SHA }]),
          document([null, "x", 7]),
          // Two answers for one version: neither counts.
          document([grant({ powers: [] }), grant()]),
          document([grant(), grant()]),
        ]) {
          yield* writeRaw(fileSystem, path, grantsPath, contents);
          assert.deepEqual(
            yield* grants.find(ID_A, VERSION_1),
            Option.none(),
            contents.slice(0, 80),
          );
        }
        // An entry that cannot be read may be the newer answer for any version, so a file
        // with one grants nothing: here it could be the "off" that follows this Allow.
        for (const unreadable of [
          { ...grant(), sha256: "short" },
          { ...grant(), powers: 7 },
          null,
        ]) {
          yield* writeRaw(
            fileSystem,
            path,
            grantsPath,
            document([grant({ attachmentId: VERSION_2 }), unreadable]),
          );
          assert.deepEqual(yield* grants.find(ID_A, VERSION_2), Option.none());
        }
      }),
    ),
  );

  it.effect("reads no grant when the file cannot be read", () =>
    withHome(({ fileSystem, open }) =>
      Effect.gen(function* () {
        yield* (yield* open()).record(grant());
        const denied: FileSystem.FileSystem = {
          ...fileSystem,
          readFileString: (path) =>
            Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "readFileString",
                pathOrDescriptor: path,
              }),
            ),
        };
        const grants = yield* open(denied);
        assert.deepEqual(yield* grants.find(ID_A, VERSION_1), Option.none());
        // And a write does not replace a file it could not read.
        const error = yield* Effect.flip(grants.record(grant({ powers: [] })));
        assert.equal(error.operation, "read-grants");
        assert.deepEqual(yield* (yield* open()).find(ID_A, VERSION_1), Option.some(grant()));
        // A read that dies is still "no grant".
        const dying: FileSystem.FileSystem = {
          ...fileSystem,
          readFileString: () => Effect.die(new Error("boom")),
        };
        assert.deepEqual(yield* (yield* open(dying)).find(ID_A, VERSION_1), Option.none());
      }),
    ),
  );

  it.effect("never overwrites a file from a newer build", () =>
    withHome(({ fileSystem, path, grantsPath, open }) =>
      Effect.gen(function* () {
        const newer = document([grant()], 2);
        yield* writeRaw(fileSystem, path, grantsPath, newer);
        const grants = yield* open();
        assert.equal((yield* Effect.flip(grants.record(grant()))).operation, "read-grants");
        assert.equal((yield* Effect.flip(grants.forget(ID_A))).operation, "read-grants");
        assert.equal(yield* fileSystem.readFileString(grantsPath), newer);
      }),
    ),
  );

  it.effect("replaces a malformed file on the next answer and leaves no temporary file", () =>
    withHome(({ fileSystem, path, grantsPath, open }) =>
      Effect.gen(function* () {
        yield* writeRaw(fileSystem, path, grantsPath, "{not json");
        const grants = yield* open();
        yield* grants.record(grant());
        assert.deepEqual(yield* grants.find(ID_A, VERSION_1), Option.some(grant()));
        const names = yield* fileSystem.readDirectory(path.dirname(grantsPath));
        assert.deepEqual(names, [ArtifactAppGrants.ARTIFACT_APP_GRANTS_FILE]);
      }),
    ),
  );
});
