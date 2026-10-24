import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";

import { removeInstalledAppDownload } from "./pendingAppUpdate.ts";

// electron-updater's cache as MacUpdater 6.8.9 leaves it after a download:
// pending/update-info.json, pending/<download> and the update.zip copy.
describe("removeInstalledAppDownload", () => {
  const join = (...parts: ReadonlyArray<string>) => parts.join("/");

  const withCache = <A, E>(
    download: string | null,
    run: (cacheDir: string, fileSystem: FileSystem.FileSystem) => Effect.Effect<A, E>,
  ) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "studio-updater-cache-" });
      const cacheDir = join(root, "studio-updater");
      if (download !== null) {
        yield* fileSystem.makeDirectory(join(cacheDir, "pending"), { recursive: true });
        yield* fileSystem.writeFileString(
          join(cacheDir, "pending", "update-info.json"),
          JSON.stringify({ fileName: download, sha512: "c2hhNTEy", isAdminRightsRequired: false }),
        );
        yield* fileSystem.writeFileString(join(cacheDir, "pending", download), "zip");
        yield* fileSystem.writeFileString(join(cacheDir, "update.zip"), "zip");
      }
      return yield* run(cacheDir, fileSystem);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

  it.effect.each([
    { label: "the running release", download: "SpecWithCode-1.0.74-arm64.zip" },
    { label: "an older release", download: "SpecWithCode-1.0.73-arm64.zip" },
  ])("removes the download of $label and update.zip", ({ download }) =>
    withCache(download, (cacheDir, fileSystem) =>
      Effect.gen(function* () {
        const removed = yield* removeInstalledAppDownload(fileSystem, join, cacheDir, "1.0.74");
        assert.equal(removed, /-(\d+\.\d+\.\d+)-/.exec(download)?.[1]);
        assert.isFalse(yield* fileSystem.exists(join(cacheDir, "pending")));
        assert.isFalse(yield* fileSystem.exists(join(cacheDir, "update.zip")));
        assert.isTrue(yield* fileSystem.exists(cacheDir));
      }),
    ),
  );

  it.effect("keeps the download of a newer release", () =>
    withCache("SpecWithCode-1.0.75-arm64.zip", (cacheDir, fileSystem) =>
      Effect.gen(function* () {
        assert.isNull(yield* removeInstalledAppDownload(fileSystem, join, cacheDir, "1.0.74"));
        assert.isTrue(
          yield* fileSystem.exists(join(cacheDir, "pending", "SpecWithCode-1.0.75-arm64.zip")),
        );
        assert.isTrue(yield* fileSystem.exists(join(cacheDir, "pending", "update-info.json")));
        assert.isTrue(yield* fileSystem.exists(join(cacheDir, "update.zip")));
      }),
    ),
  );

  it.effect("keeps a download whose release it cannot tell", () =>
    withCache(null, (cacheDir, fileSystem) =>
      Effect.gen(function* () {
        // A download that never finished: no update-info.json.
        yield* fileSystem.makeDirectory(join(cacheDir, "pending"), { recursive: true });
        yield* fileSystem.writeFileString(join(cacheDir, "pending", "temp-x.zip"), "zip");
        yield* fileSystem.writeFileString(join(cacheDir, "update.zip"), "zip");
        assert.isNull(yield* removeInstalledAppDownload(fileSystem, join, cacheDir, "1.0.74"));
        assert.isTrue(yield* fileSystem.exists(join(cacheDir, "pending", "temp-x.zip")));
        assert.isTrue(yield* fileSystem.exists(join(cacheDir, "update.zip")));
        // Nor against a running version that is not a release.
        yield* fileSystem.writeFileString(
          join(cacheDir, "pending", "update-info.json"),
          JSON.stringify({ fileName: "SpecWithCode-1.0.73-arm64.zip", sha512: "c2hhNTEy" }),
        );
        assert.isNull(yield* removeInstalledAppDownload(fileSystem, join, cacheDir, "dev"));
        assert.isTrue(yield* fileSystem.exists(join(cacheDir, "update.zip")));
      }),
    ),
  );

  it.effect.each([
    { label: "malformed JSON", updateInfo: "{not json" },
    {
      label: "a name out of the folder",
      updateInfo: JSON.stringify({
        fileName: "../SpecWithCode-1.0.73-arm64.zip",
        sha512: "c2hhNTEy",
      }),
    },
  ])("keeps the cache when update-info.json holds $label", ({ updateInfo }) =>
    withCache("SpecWithCode-1.0.73-arm64.zip", (cacheDir, fileSystem) =>
      Effect.gen(function* () {
        yield* fileSystem.writeFileString(
          join(cacheDir, "pending", "update-info.json"),
          updateInfo,
        );
        assert.isNull(yield* removeInstalledAppDownload(fileSystem, join, cacheDir, "1.0.74"));
        assert.isTrue(
          yield* fileSystem.exists(join(cacheDir, "pending", "SpecWithCode-1.0.73-arm64.zip")),
        );
        assert.isTrue(yield* fileSystem.exists(join(cacheDir, "update.zip")));
      }),
    ),
  );

  // The startup check runs after this removal, so a failure must not escape.
  it.effect("answers null when the cache cannot be removed", () =>
    withCache("SpecWithCode-1.0.73-arm64.zip", (cacheDir, fileSystem) =>
      Effect.gen(function* () {
        const denied: FileSystem.FileSystem = {
          ...fileSystem,
          remove: (path) =>
            Effect.fail(
              PlatformError.systemError({
                module: "FileSystem",
                method: "remove",
                _tag: "PermissionDenied",
                pathOrDescriptor: path,
              }),
            ),
        };
        assert.isNull(yield* removeInstalledAppDownload(denied, join, cacheDir, "1.0.74"));
        assert.isTrue(yield* fileSystem.exists(join(cacheDir, "pending")));
      }),
    ),
  );

  it.effect("does nothing without a cache folder", () =>
    withCache(null, (cacheDir, fileSystem) =>
      Effect.gen(function* () {
        assert.isNull(yield* removeInstalledAppDownload(fileSystem, join, cacheDir, "1.0.74"));
        assert.isNull(yield* removeInstalledAppDownload(fileSystem, join, null, "1.0.74"));
        assert.isFalse(yield* fileSystem.exists(cacheDir));
      }),
    ),
  );
});
