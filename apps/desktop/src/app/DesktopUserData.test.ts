import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import { resolveUserDataPath } from "./DesktopUserData.ts";

it.effect("identifies a failed source read and preserves its cause", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    // Built with the host join so the noop file system sees the path the product asks for.
    const sourceState = path.join("/profiles", "studio", "Local State");
    const cause = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "readFileString",
      pathOrDescriptor: sourceState,
    });
    const error = yield* resolveUserDataPath({
      appDataDirectory: "/profiles",
      isDevelopment: false,
      platform: "win32",
    }).pipe(
      Effect.flip,
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          exists: (candidate) => Effect.succeed(candidate === sourceState),
          readFileString: () => Effect.fail(cause),
        }),
      ),
    );
    assert.equal(error.operation, "read");
    assert.equal(error.resourcePath, sourceState);
    assert.equal(error.category, "PermissionDenied");
    assert.strictEqual(error.cause, cause);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each(["studio", "SpecWeave Studio (Alpha)"])(
  "preserves Windows credential keys from %s without copying browser databases",
  (sourceName) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "studio-v2-profile-" });
      const source = path.join(directory, sourceName);
      const destination = path.join(directory, "SpecWithCode");
      const state = '{"os_crypt":{"encrypted_key":"test-encrypted-key"}}';
      yield* fs.makeDirectory(path.join(directory, "SpecWeave Studio (Alpha)"), {
        recursive: true,
      });
      yield* fs.makeDirectory(path.join(source, "IndexedDB"), { recursive: true });
      yield* fs.writeFileString(path.join(source, "Local State"), state);
      yield* fs.writeFileString(path.join(source, "IndexedDB", "LOCK"), "V1 owns this database");
      yield* resolveUserDataPath({
        appDataDirectory: directory,
        isDevelopment: false,
        platform: "win32",
      });
      assert.equal(yield* fs.readFileString(path.join(destination, "Local State")), state);
      assert.equal(yield* fs.readFileString(path.join(source, "Local State")), state);
      assert.isFalse(yield* fs.exists(path.join(destination, "IndexedDB")));
      yield* fs.writeFileString(path.join(destination, "Local State"), "existing V2 state");
      yield* resolveUserDataPath({
        appDataDirectory: directory,
        isDevelopment: false,
        platform: "win32",
      });
      assert.equal(
        yield* fs.readFileString(path.join(destination, "Local State")),
        "existing V2 state",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const resolvePackaged = (
  appDataDirectory: string,
  platform: NodeJS.Platform,
  isProcessRunning: (pid: number) => boolean = () => false,
) => resolveUserDataPath({ appDataDirectory, isDevelopment: false, platform, isProcessRunning });

const profileFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "specwithcode-profile-" });
  const previous = path.join(directory, "studio-v2");
  const branded = path.join(directory, "SpecWithCode");
  const seedPrevious = Effect.gen(function* () {
    yield* fs.makeDirectory(path.join(previous, "IndexedDB"), { recursive: true });
    yield* fs.writeFileString(path.join(previous, "Local State"), "previous state");
    yield* fs.writeFileString(path.join(previous, "IndexedDB", "LOCK"), "database");
    yield* fs.writeFileString(path.join(previous, "v1-local-storage-imported"), "");
  });
  return { fs, path, directory, previous, branded, seedPrevious };
});

it.effect("uses SpecWithCode on a new install and creates nothing", () =>
  Effect.gen(function* () {
    const { fs, directory, previous, branded } = yield* profileFixture;
    assert.equal(yield* resolvePackaged(directory, "darwin"), branded);
    assert.equal(yield* resolvePackaged(directory, "linux"), branded);
    assert.isFalse(yield* fs.exists(branded));
    assert.isFalse(yield* fs.exists(previous));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// Plain directory links need a privilege on Windows. The app makes a junction there,
// which DesktopPreReadyFileSystem.test.ts covers on every host.
const hostIsWindows = HostProcessPlatform.defaultValue() === "win32";

for (const platform of ["darwin", "linux", "win32"] as const) {
  it.effect.skipIf(hostIsWindows)(
    `renames an existing studio-v2 profile to SpecWithCode on ${platform} and keeps the old name as a link`,
    () =>
      Effect.gen(function* () {
        const { fs, path, directory, previous, branded, seedPrevious } = yield* profileFixture;
        yield* seedPrevious;

        assert.equal(yield* resolvePackaged(directory, platform), branded);

        assert.equal(yield* fs.readFileString(path.join(branded, "Local State")), "previous state");
        assert.equal(yield* fs.readFileString(path.join(branded, "IndexedDB", "LOCK")), "database");
        assert.isTrue(yield* fs.exists(path.join(branded, "v1-local-storage-imported")));
        // An older build still opens studio-v2 and lands in the same profile.
        assert.equal(yield* fs.readLink(previous), branded);
        assert.equal(
          yield* fs.readFileString(path.join(previous, "Local State")),
          "previous state",
        );
        // Startup resolves the path more than once.
        assert.equal(yield* resolvePackaged(directory, platform), branded);
        assert.equal(yield* fs.readLink(previous), branded);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}

it.effect.skipIf(hostIsWindows)("leaves a profile alone while a running app holds it", () =>
  Effect.gen(function* () {
    const { fs, path, directory, previous, branded, seedPrevious } = yield* profileFixture;
    yield* seedPrevious;
    yield* fs.symlink("host.local-4242", path.join(previous, "SingletonLock"));
    const asked: number[] = [];

    const held = yield* resolvePackaged(directory, "darwin", (pid) => {
      asked.push(pid);
      return true;
    });

    assert.equal(held, previous);
    assert.deepEqual(asked, [4242]);
    assert.isFalse(yield* fs.exists(branded));
    // A lock left by a crashed app does not hold the rename back.
    assert.equal(yield* resolvePackaged(directory, "darwin", () => false), branded);
    assert.equal(yield* fs.readLink(previous), branded);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("keeps studio-v2 when SpecWithCode already holds other files", () =>
  Effect.gen(function* () {
    const { fs, path, directory, previous, branded, seedPrevious } = yield* profileFixture;
    yield* seedPrevious;
    yield* fs.makeDirectory(branded);
    yield* fs.writeFileString(path.join(branded, "unrelated.txt"), "not a profile");

    assert.equal(yield* resolvePackaged(directory, "darwin"), previous);

    assert.equal(yield* fs.readFileString(path.join(previous, "Local State")), "previous state");
    assert.equal(yield* fs.readFileString(path.join(branded, "unrelated.txt")), "not a profile");
    assert.isFalse(yield* fs.exists(path.join(branded, "Local State")));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("prefers a SpecWithCode profile that is already in use", () =>
  Effect.gen(function* () {
    const { fs, path, directory, previous, branded, seedPrevious } = yield* profileFixture;
    yield* seedPrevious;
    yield* fs.makeDirectory(branded);
    yield* fs.writeFileString(path.join(branded, "Local State"), "branded state");

    assert.equal(yield* resolvePackaged(directory, "win32"), branded);

    assert.equal(yield* fs.readFileString(path.join(branded, "Local State")), "branded state");
    assert.equal(yield* fs.readFileString(path.join(previous, "Local State")), "previous state");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("keeps studio-v2 when the rename is refused", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const previous = path.join("/profiles", "studio-v2");
    const calls: string[] = [];
    const resolved = yield* resolvePackaged("/profiles", "linux").pipe(
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          exists: (candidate) => Effect.succeed(candidate === previous),
          rename: (from) => {
            calls.push(`rename:${from}`);
            return Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "rename",
                pathOrDescriptor: from,
              }),
            );
          },
          symlink: () => Effect.sync(() => void calls.push("symlink")),
        }),
      ),
    );
    assert.equal(resolved, previous);
    assert.deepEqual(calls, [`rename:${previous}`]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.skipIf(hostIsWindows)("keeps a studio-v2 link the user made to another place", () =>
  Effect.gen(function* () {
    const { fs, path, directory, previous, branded } = yield* profileFixture;
    const elsewhere = path.join(directory, "moved-profile");
    yield* fs.makeDirectory(elsewhere);
    yield* fs.writeFileString(path.join(elsewhere, "Local State"), "moved state");
    yield* fs.symlink(elsewhere, previous);
    yield* fs.makeDirectory(branded);

    assert.equal(yield* resolvePackaged(directory, "darwin"), previous);

    assert.equal(yield* fs.readLink(previous), elsewhere);
    assert.isFalse(yield* fs.exists(path.join(branded, "Local State")));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("starts on studio-v2 when the folders cannot be inspected", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const refused = (method: string, target: string) =>
      Effect.fail(
        PlatformError.systemError({
          _tag: "PermissionDenied",
          module: "FileSystem",
          method,
          pathOrDescriptor: target,
        }),
      );
    const resolved = yield* resolvePackaged("/profiles", "darwin").pipe(
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          exists: (candidate) => refused("exists", candidate),
          readLink: (candidate) => refused("readLink", candidate),
          rename: (from) => refused("rename", from),
        }),
      ),
    );
    assert.equal(resolved, path.join("/profiles", "studio-v2"));
  }).pipe(Effect.provide(NodeServices.layer)),
);
