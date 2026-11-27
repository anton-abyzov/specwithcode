import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ArtifactAppShimRecords from "./ArtifactAppShimRecords.ts";

const ID = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";
const RECORD = {
  hostAppPath: "/Applications/SpecWithCode.app",
  hostBundleId: "com.specweave.studio",
  minimumSystemVersion: "13.0",
  serverName: "com.specweave.studio.artifact-apps",
  cdHash: "25e5341a25cccfad30bd55c5b3b507f581bd1d07",
};

const withStore = <A, E>(
  body: (input: {
    readonly store: ArtifactAppShimRecords.ArtifactAppShimRecords["Service"];
    readonly directory: string;
  }) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "studio-shims-" });
    return yield* Effect.gen(function* () {
      const store = yield* ArtifactAppShimRecords.ArtifactAppShimRecords;
      return yield* body({ store, directory });
    }).pipe(Effect.provide(ArtifactAppShimRecords.layer(directory)));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("ArtifactAppShimRecords", () => {
  it.effect("keeps a private record per install", () =>
    withStore(({ store, directory }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        assert.deepEqual(yield* store.get(ID), Option.none());
        yield* store.set(ID, RECORD);
        yield* store.set(OTHER, { ...RECORD, cdHash: "0".repeat(40) });
        assert.deepEqual(yield* store.get(ID), Option.some(RECORD));
        const file = path.join(directory, ArtifactAppShimRecords.ARTIFACT_APP_SHIMS_FILE);
        assert.equal((yield* fileSystem.stat(file)).mode & 0o777, 0o600);
        yield* store.remove(ID);
        assert.deepEqual(yield* store.get(ID), Option.none());
        assert.isTrue(Option.isSome(yield* store.get(OTHER)));
      }),
    ),
  );

  it.effect("drops entries that are not a valid install and hash, and a malformed file", () =>
    withStore(({ store, directory }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const file = path.join(directory, ArtifactAppShimRecords.ARTIFACT_APP_SHIMS_FILE);
        yield* fileSystem.writeFileString(
          file,
          JSON.stringify({
            version: 1,
            shims: {
              [ID]: { ...RECORD, cdHash: "not a hash" },
              "../x": RECORD,
              [OTHER]: RECORD,
            },
          }),
        );
        assert.deepEqual(yield* store.get(ID), Option.none());
        assert.deepEqual(yield* store.get(OTHER), Option.some(RECORD));
        yield* fileSystem.writeFileString(file, "{");
        assert.deepEqual(yield* store.get(OTHER), Option.none());
      }),
    ),
  );

  it.effect("hands back the reopen list once", () =>
    withStore(({ store }) =>
      Effect.gen(function* () {
        assert.deepEqual(yield* store.takeReopen, []);
        yield* store.writeReopen([ID, "bad", OTHER, ID]);
        assert.deepEqual(yield* store.takeReopen, [ID, OTHER]);
        assert.deepEqual(yield* store.takeReopen, []);
      }),
    ),
  );
});
