import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import type * as ArtifactAppInstaller from "./ArtifactAppInstaller.ts";
import { harness, hostPath, input, withHome } from "./artifactAppInstallerTestHarness.ts";

const shimConfig = (loaderPath: string): ArtifactAppInstaller.ArtifactAppShimConfig => ({
  loaderPath,
  hostAppPath: "/Applications/SpecWithCode.app",
  hostBundleId: "com.specweave.studio",
  serverName: "com.specweave.studio.artifact-apps",
  minimumSystemVersion: "13.0",
});

const writeLoader = (fileSystem: FileSystem.FileSystem, path: Path.Path, home: string) =>
  Effect.gen(function* () {
    const loaderPath = path.join(home, "app_shim_loader");
    yield* fileSystem.writeFileString(loaderPath, "MACH-O LOADER");
    return loaderPath;
  });

describe("ArtifactAppInstaller with app shims", () => {
  it.effect("writes a signed shim bundle, keeps its hash privately and starts it", () =>
    withHome(({ home, recordsPath, fileSystem, path }) =>
      Effect.gen(function* () {
        const appShim = shimConfig(yield* writeLoader(fileSystem, path, home));
        const h = yield* harness({ platform: "darwin", appShim, fileSystem }, home, recordsPath);
        const result = yield* h.installer.install(input);
        assert.equal(result.status, "installed");
        if (result.status !== "installed") return;
        const bundle = path.join(
          home,
          "Applications",
          "SpecWithCode Apps",
          "Morning dashboard.app",
        );
        // The executable is the loader itself; there is no script.
        assert.equal(
          yield* fileSystem.readFileString(path.join(bundle, "Contents", "MacOS", "page")),
          "MACH-O LOADER",
        );
        assert.isFalse(
          yield* fileSystem.exists(path.join(bundle, "Contents", "MacOS", "launcher")),
        );
        const plist = yield* fileSystem.readFileString(path.join(bundle, "Contents", "Info.plist"));
        assert.include(plist, "<key>ElectronAppShimServerName</key>");
        assert.include(plist, "<string>/Applications/SpecWithCode.app</string>");
        // Signed and hashed before it was moved into place, then started instead of a window here.
        assert.equal(h.calls.codesigned.length, 1);
        // Read once as signed, and again, verified, before it was started.
        assert.deepEqual(h.calls.cdHashReads, [...h.calls.codesigned, hostPath(bundle)]);
        assert.deepEqual(h.calls.openedApps, [hostPath(bundle)]);
        assert.deepEqual(h.opened, []);
        const record = yield* h.shimRecords.get(result.app.installId);
        assert.deepEqual(
          record,
          Option.some({ ...appShimWithoutLoader(appShim), cdHash: "a".repeat(39) + "1" }),
        );
        // The client record carries no paths or hashes.
        assert.notProperty(result.app, "cdHash");
        assert.deepEqual(
          yield* h.installer.shimInstallFor(bundle),
          Option.some({ installId: result.app.installId, cdHash: "a".repeat(39) + "1" }),
        );
        assert.deepEqual(
          yield* h.installer.shimInstallFor(path.join(home, "Elsewhere.app")),
          Option.none(),
        );

        // Installing the same page again starts the app again.
        const again = yield* h.installer.install(input);
        assert.equal(again.status, "already-installed");
        assert.equal(h.calls.openedApps.length, 2);
        assert.isTrue(yield* h.installer.launch(result.app.installId));
        assert.equal(h.calls.openedApps.length, 3);

        // A changed executable is never started, though its plist still matches.
        h.calls.tampered.add(hostPath(bundle));
        assert.isFalse(yield* h.installer.launch(result.app.installId));
        assert.equal(h.calls.openedApps.length, 3);
        h.calls.tampered.clear();

        // A bundle whose plist was changed is no longer this install's.
        yield* fileSystem.writeFileString(
          path.join(bundle, "Contents", "Info.plist"),
          plist.replace("SpecWithCode.app", "Other.app"),
        );
        assert.deepEqual(yield* h.installer.shimInstallFor(bundle), Option.none());
        assert.isFalse(yield* h.installer.launch(result.app.installId));
      }),
    ),
  );

  it.effect("fails the install and leaves nothing when the hash cannot be read", () =>
    withHome(({ home, recordsPath, fileSystem, path }) =>
      Effect.gen(function* () {
        const appShim = shimConfig(yield* writeLoader(fileSystem, path, home));
        const h = yield* harness(
          { platform: "darwin", appShim, fileSystem, cdHashFails: true },
          home,
          recordsPath,
        );
        const result = yield* h.installer.install(input);
        assert.equal(result.status, "failed");
        const folder = path.join(home, "Applications", "SpecWithCode Apps");
        assert.deepEqual(
          (yield* fileSystem.readDirectory(folder)).filter((entry) => !entry.startsWith(".")),
          [],
        );
        assert.deepEqual(yield* h.records.list, []);
        assert.deepEqual(h.calls.openedApps, []);
      }),
    ),
  );

  it.effect("uninstall forgets the shim's hash", () =>
    withHome(({ home, recordsPath, fileSystem, path }) =>
      Effect.gen(function* () {
        const appShim = shimConfig(yield* writeLoader(fileSystem, path, home));
        const h = yield* harness({ platform: "darwin", appShim, fileSystem }, home, recordsPath);
        const result = yield* h.installer.install(input);
        if (result.status !== "installed") return assert.fail(result.status);
        assert.isTrue(yield* h.installer.uninstall(result.app.installId));
        assert.deepEqual(yield* h.shimRecords.get(result.app.installId), Option.none());
        assert.deepEqual(h.closed, [result.app.installId]);
      }),
    ),
  );

  it.effect("upgrades an owned script launcher to a shim and leaves a changed one alone", () =>
    withHome(({ home, recordsPath, fileSystem, path }) =>
      Effect.gen(function* () {
        // Installed by a build without shims.
        const before = yield* harness({ platform: "darwin", fileSystem }, home, recordsPath);
        const first = yield* before.installer.install(input);
        const second = yield* before.installer.install({ ...input, title: "Evening board" });
        if (first.status !== "installed" || second.status !== "installed") {
          return assert.fail("not installed");
        }
        const folder = path.join(home, "Applications", "SpecWithCode Apps");
        const firstBundle = path.join(folder, "Morning dashboard.app");
        const secondScript = path.join(
          folder,
          "Evening board.app",
          "Contents",
          "MacOS",
          "launcher",
        );
        yield* fileSystem.writeFileString(secondScript, "#!/bin/sh\nexec /bin/sh -c 'evil'\n");

        const appShim = shimConfig(yield* writeLoader(fileSystem, path, home));
        const after = yield* harness(
          { platform: "darwin", appShim, fileSystem },
          home,
          recordsPath,
        );
        yield* after.installer.upgradeLaunchers;

        assert.equal(
          yield* fileSystem.readFileString(path.join(firstBundle, "Contents", "MacOS", "page")),
          "MACH-O LOADER",
        );
        assert.isFalse(
          yield* fileSystem.exists(path.join(firstBundle, "Contents", "MacOS", "launcher")),
        );
        assert.isTrue(Option.isSome(yield* after.shimRecords.get(first.app.installId)));
        assert.isTrue(Option.isSome(yield* after.installer.shimInstallFor(firstBundle)));
        // The old bundle went to the Trash from its private removal name.
        assert.equal(after.calls.trashed.length, 1);
        assert.include(after.calls.trashed[0]!, ".upgrading-");
        // Nothing is left under a removal name, so uninstall still works.
        assert.deepEqual(
          (yield* fileSystem.readDirectory(folder)).filter((entry) => entry.startsWith(".")),
          [],
        );
        // The changed bundle was not rebuilt or recorded.
        assert.include(yield* fileSystem.readFileString(secondScript), "evil");
        assert.deepEqual(yield* after.shimRecords.get(second.app.installId), Option.none());

        // A second pass has nothing to do.
        yield* after.installer.upgradeLaunchers;
        assert.equal(after.calls.trashed.length, 1);
        assert.isTrue(yield* after.installer.uninstall(first.app.installId));
      }),
    ),
  );

  it.effect("keeps the old launcher when the new hash cannot be kept", () =>
    withHome(({ home, recordsPath, fileSystem, path }) =>
      Effect.gen(function* () {
        const before = yield* harness({ platform: "darwin", fileSystem }, home, recordsPath);
        const first = yield* before.installer.install(input);
        if (first.status !== "installed") return assert.fail(first.status);
        // A folder where the hash file goes makes every write of it fail.
        yield* fileSystem.makeDirectory(
          path.join(`${recordsPath}.shims`, "artifact-app-shims.json"),
          {
            recursive: true,
          },
        );
        const appShim = shimConfig(yield* writeLoader(fileSystem, path, home));
        const after = yield* harness(
          { platform: "darwin", appShim, fileSystem },
          home,
          recordsPath,
        );
        yield* after.installer.upgradeLaunchers;
        const folder = path.join(home, "Applications", "SpecWithCode Apps");
        const bundle = path.join(folder, "Morning dashboard.app");
        assert.isTrue(yield* fileSystem.exists(path.join(bundle, "Contents", "MacOS", "launcher")));
        assert.isFalse(yield* fileSystem.exists(path.join(bundle, "Contents", "MacOS", "page")));
        assert.deepEqual(
          (yield* fileSystem.readDirectory(folder)).filter((entry) => entry.startsWith(".")),
          [],
        );
        assert.deepEqual(after.calls.trashed, []);
      }),
    ),
  );

  it.effect("reports the hash of a shim it rebuilt for a moved app", () =>
    withHome(({ home, recordsPath, fileSystem, path }) =>
      Effect.gen(function* () {
        const loader = yield* writeLoader(fileSystem, path, home);
        const before = yield* harness(
          { platform: "darwin", appShim: shimConfig(loader), fileSystem },
          home,
          recordsPath,
        );
        const first = yield* before.installer.install(input);
        if (first.status !== "installed") return assert.fail(first.status);
        const oldHash = Option.getOrThrow(
          yield* before.shimRecords.get(first.app.installId),
        ).cdHash;
        const moved = {
          ...shimConfig(loader),
          hostAppPath: "/Applications/Tools/SpecWithCode.app",
        };
        const after = yield* harness(
          { platform: "darwin", appShim: moved, fileSystem },
          home,
          recordsPath,
        );
        const replaced = yield* after.installer.upgradeLaunchers;
        assert.deepEqual([...replaced], [[first.app.installId, oldHash]]);
        const record = Option.getOrThrow(yield* after.shimRecords.get(first.app.installId));
        assert.equal(record.hostAppPath, "/Applications/Tools/SpecWithCode.app");
        // Nothing to rebuild the second time.
        assert.deepEqual([...(yield* after.installer.upgradeLaunchers)], []);
      }),
    ),
  );

  it.effect("finishes an upgrade that stopped part way", () =>
    withHome(({ home, recordsPath, fileSystem, path }) =>
      Effect.gen(function* () {
        const before = yield* harness({ platform: "darwin", fileSystem }, home, recordsPath);
        const first = yield* before.installer.install(input);
        if (first.status !== "installed") return assert.fail(first.status);
        const folder = path.join(home, "Applications", "SpecWithCode Apps");
        const bundle = path.join(folder, "Morning dashboard.app");
        // Stopped between the renames: the old launcher sits under its removal name.
        const aside = path.join(
          folder,
          `.Morning dashboard.app.upgrading-${first.app.installId}.${"0".repeat(32)}`,
        );
        yield* fileSystem.rename(bundle, aside);
        const loader = yield* writeLoader(fileSystem, path, home);
        const after = yield* harness(
          { platform: "darwin", appShim: shimConfig(loader), fileSystem },
          home,
          recordsPath,
        );
        yield* after.installer.upgradeLaunchers;
        assert.equal(
          yield* fileSystem.readFileString(path.join(bundle, "Contents", "MacOS", "page")),
          "MACH-O LOADER",
        );
        assert.isTrue(Option.isSome(yield* after.installer.shimInstallFor(bundle)));
        assert.deepEqual(
          (yield* fileSystem.readDirectory(folder)).filter((entry) => entry.startsWith(".")),
          [],
        );

        // Stopped after the swap, before the record: the new bundle is rebuilt, not trusted,
        // and the old one it had moved aside goes too, so nothing hidden is left.
        const oldAside = path.join(
          folder,
          `.Morning dashboard.app.upgrading-${first.app.installId}.${"1".repeat(32)}`,
        );
        yield* fileSystem.makeDirectory(path.join(oldAside, "Contents"), { recursive: true });
        const recorded = Option.getOrThrow(yield* after.shimRecords.get(first.app.installId));
        yield* after.shimRecords.set(first.app.installId, {
          ...recorded,
          hostAppPath: "/Applications/Old/SpecWithCode.app",
        });
        assert.deepEqual(yield* after.installer.shimInstallFor(bundle), Option.none());
        const signedBefore = after.calls.codesigned.length;
        yield* after.installer.upgradeLaunchers;
        assert.equal(after.calls.codesigned.length, signedBefore + 1);
        const rebuilt = Option.getOrThrow(yield* after.shimRecords.get(first.app.installId));
        assert.equal(rebuilt.hostAppPath, "/Applications/SpecWithCode.app");
        assert.isTrue(Option.isSome(yield* after.installer.shimInstallFor(bundle)));
        assert.include(after.calls.trashed, hostPath(oldAside));
        assert.isTrue(yield* after.installer.uninstall(first.app.installId));
      }),
    ),
  );

  it.effect("clears a stale upgrade copy left after the record was saved", () =>
    withHome(({ home, recordsPath, fileSystem, path }) =>
      Effect.gen(function* () {
        const loader = yield* writeLoader(fileSystem, path, home);
        const appShim = shimConfig(loader);
        const h = yield* harness({ platform: "darwin", appShim, fileSystem }, home, recordsPath);
        const first = yield* h.installer.install(input);
        if (first.status !== "installed") return assert.fail(first.status);
        const folder = path.join(home, "Applications", "SpecWithCode Apps");
        const bundle = path.join(folder, "Morning dashboard.app");
        // Stopped after the record, before the old copy was trashed: the launcher is current.
        const stale = path.join(
          folder,
          `.Morning dashboard.app.upgrading-${first.app.installId}.${"3".repeat(32)}`,
        );
        yield* fileSystem.makeDirectory(path.join(stale, "Contents"), { recursive: true });
        const signedBefore = h.calls.codesigned.length;
        yield* h.installer.upgradeLaunchers;
        assert.equal(h.calls.codesigned.length, signedBefore);
        assert.include(h.calls.trashed, hostPath(stale));
        assert.isFalse(yield* fileSystem.exists(stale));
        assert.isTrue(Option.isSome(yield* h.installer.shimInstallFor(bundle)));
      }),
    ),
  );

  it.effect("leaves an upgrade copy alone while an uninstall's copy is beside it", () =>
    withHome(({ home, recordsPath, fileSystem, path }) =>
      Effect.gen(function* () {
        const loader = yield* writeLoader(fileSystem, path, home);
        const appShim = shimConfig(loader);
        const h = yield* harness({ platform: "darwin", appShim, fileSystem }, home, recordsPath);
        const first = yield* h.installer.install(input);
        if (first.status !== "installed") return assert.fail(first.status);
        const folder = path.join(home, "Applications", "SpecWithCode Apps");
        const bundle = path.join(folder, "Morning dashboard.app");
        const stale = path.join(
          folder,
          `.Morning dashboard.app.upgrading-${first.app.installId}.${"4".repeat(32)}`,
        );
        yield* fileSystem.makeDirectory(path.join(stale, "Contents"), { recursive: true });
        // An uninstall moved the current launcher aside, then the Trash failed.
        yield* fileSystem.rename(
          bundle,
          path.join(
            folder,
            `.Morning dashboard.app.removing-${first.app.installId}.${"5".repeat(32)}`,
          ),
        );
        yield* h.installer.upgradeLaunchers;
        assert.isFalse(yield* fileSystem.exists(bundle));
        assert.isTrue(yield* h.installer.uninstall(first.app.installId));
        assert.isFalse(yield* fileSystem.exists(stale));
        assert.deepEqual(
          (yield* fileSystem.readDirectory(folder)).filter((entry) => entry.startsWith(".")),
          [],
        );
      }),
    ),
  );

  it.effect("never puts back a copy a failed uninstall left aside", () =>
    withHome(({ home, recordsPath, fileSystem, path }) =>
      Effect.gen(function* () {
        const before = yield* harness({ platform: "darwin", fileSystem }, home, recordsPath);
        const first = yield* before.installer.install(input);
        if (first.status !== "installed") return assert.fail(first.status);
        const folder = path.join(home, "Applications", "SpecWithCode Apps");
        const bundle = path.join(folder, "Morning dashboard.app");
        // An uninstall moved it aside, then the Trash failed: the record stays.
        yield* fileSystem.rename(
          bundle,
          path.join(
            folder,
            `.Morning dashboard.app.removing-${first.app.installId}.${"2".repeat(32)}`,
          ),
        );
        const loader = yield* writeLoader(fileSystem, path, home);
        const after = yield* harness(
          { platform: "darwin", appShim: shimConfig(loader), fileSystem },
          home,
          recordsPath,
        );
        yield* after.installer.upgradeLaunchers;
        assert.isFalse(yield* fileSystem.exists(bundle));
        assert.isTrue(yield* after.installer.uninstall(first.app.installId));
      }),
    ),
  );

  it.effect("never puts back a copy older than the saved records", () =>
    withHome(({ home, recordsPath, fileSystem, path }) =>
      Effect.gen(function* () {
        const before = yield* harness({ platform: "darwin", fileSystem }, home, recordsPath);
        const first = yield* before.installer.install(input);
        if (first.status !== "installed") return assert.fail(first.status);
        const folder = path.join(home, "Applications", "SpecWithCode Apps");
        const bundle = path.join(folder, "Morning dashboard.app");
        const oldCopy = path.join(home, "old-launcher.app");
        yield* fileSystem.copy(bundle, oldCopy);
        const loader = yield* writeLoader(fileSystem, path, home);
        const after = yield* harness(
          { platform: "darwin", appShim: shimConfig(loader), fileSystem },
          home,
          recordsPath,
        );
        yield* after.installer.upgradeLaunchers;
        // The upgrade saved its record and stopped before trashing the old copy; then an
        // uninstall trashed the launcher and stopped before its cleanup.
        yield* fileSystem.rename(
          oldCopy,
          path.join(
            folder,
            `.Morning dashboard.app.upgrading-${first.app.installId}.${"6".repeat(32)}`,
          ),
        );
        yield* fileSystem.remove(bundle, { recursive: true });
        yield* after.installer.upgradeLaunchers;
        assert.isFalse(yield* fileSystem.exists(bundle));
        assert.isTrue(yield* after.installer.uninstall(first.app.installId));
        assert.deepEqual(
          (yield* fileSystem.readDirectory(folder)).filter((entry) => entry.startsWith(".")),
          [],
        );
      }),
    ),
  );

  it.effect("never puts back a shim copy whose executable changed", () =>
    withHome(({ home, recordsPath, fileSystem, path }) =>
      Effect.gen(function* () {
        const loader = yield* writeLoader(fileSystem, path, home);
        const appShim = shimConfig(loader);
        const h = yield* harness({ platform: "darwin", appShim, fileSystem }, home, recordsPath);
        const first = yield* h.installer.install(input);
        if (first.status !== "installed") return assert.fail(first.status);
        const folder = path.join(home, "Applications", "SpecWithCode Apps");
        const bundle = path.join(folder, "Morning dashboard.app");
        // Left aside between the renames, then its loader changed: the plist still matches.
        const aside = path.join(
          folder,
          `.Morning dashboard.app.upgrading-${first.app.installId}.${"8".repeat(32)}`,
        );
        yield* fileSystem.rename(bundle, aside);
        h.calls.tampered.add(hostPath(aside));
        yield* h.installer.upgradeLaunchers;
        assert.isFalse(yield* fileSystem.exists(bundle));
        assert.isTrue(yield* fileSystem.exists(aside));
      }),
    ),
  );

  it.effect("says so when a reinstall finds a changed launcher", () =>
    withHome(({ home, recordsPath, fileSystem, path }) =>
      Effect.gen(function* () {
        const loader = yield* writeLoader(fileSystem, path, home);
        const appShim = shimConfig(loader);
        const h = yield* harness({ platform: "darwin", appShim, fileSystem }, home, recordsPath);
        const first = yield* h.installer.install(input);
        if (first.status !== "installed") return assert.fail(first.status);
        const bundle = path.join(
          home,
          "Applications",
          "SpecWithCode Apps",
          "Morning dashboard.app",
        );
        const opened = h.calls.openedApps.length;
        h.calls.tampered.add(hostPath(bundle));
        const again = yield* h.installer.install(input);
        assert.equal(again.status, "failed");
        assert.equal(h.calls.openedApps.length, opened);
      }),
    ),
  );

  it.effect("does not open another thread's app whose launcher changed", () =>
    withHome(({ home, recordsPath, fileSystem, path }) =>
      Effect.gen(function* () {
        const loader = yield* writeLoader(fileSystem, path, home);
        const appShim = shimConfig(loader);
        const h = yield* harness({ platform: "darwin", appShim, fileSystem }, home, recordsPath);
        const first = yield* h.installer.install(input);
        if (first.status !== "installed") return assert.fail(first.status);
        const bundle = path.join(
          home,
          "Applications",
          "SpecWithCode Apps",
          "Morning dashboard.app",
        );
        const opened = h.calls.openedApps.length;
        h.calls.tampered.add(hostPath(bundle));
        // The same title from another thread, and the person picks Open.
        const other = yield* h.installer.install({ ...input, threadId: "thread-2" });
        assert.equal(other.status, "failed");
        assert.equal(h.calls.dialogs.at(-1)?.message, "Morning dashboard is already installed.");
        assert.equal(h.calls.openedApps.length, opened);
        assert.deepEqual(yield* h.records.list, [first.app]);
      }),
    ),
  );

  it.effect("leaves upgrade copies alone through a linked apps folder", () =>
    withHome(({ home, recordsPath, fileSystem, path }) =>
      Effect.gen(function* () {
        const loader = yield* writeLoader(fileSystem, path, home);
        const appShim = shimConfig(loader);
        const h = yield* harness({ platform: "darwin", appShim, fileSystem }, home, recordsPath);
        const first = yield* h.installer.install(input);
        if (first.status !== "installed") return assert.fail(first.status);
        const folder = path.join(home, "Applications", "SpecWithCode Apps");
        const elsewhere = path.join(home, "backup");
        yield* fileSystem.rename(folder, elsewhere);
        const copy = path.join(
          elsewhere,
          `.Morning dashboard.app.upgrading-${first.app.installId}.${"7".repeat(32)}`,
        );
        yield* fileSystem.makeDirectory(path.join(copy, "Contents"), { recursive: true });
        yield* fileSystem.symlink(elsewhere, folder);
        yield* h.installer.uninstall(first.app.installId);
        yield* h.installer.upgradeLaunchers;
        assert.isTrue(yield* fileSystem.exists(copy));
        assert.notInclude(
          h.calls.trashed.map((trashed) => trashed.split(/[\\/]/).pop()),
          path.basename(copy),
        );
      }),
    ),
  );

  it.effect("writes script launchers once shims are turned off", () =>
    withHome(({ home, recordsPath, fileSystem, path }) =>
      Effect.gen(function* () {
        const appShim = shimConfig(yield* writeLoader(fileSystem, path, home));
        const h = yield* harness({ platform: "darwin", appShim, fileSystem }, home, recordsPath);
        yield* h.installer.disableShims;
        const result = yield* h.installer.install(input);
        assert.equal(result.status, "installed");
        const bundle = path.join(
          home,
          "Applications",
          "SpecWithCode Apps",
          "Morning dashboard.app",
        );
        assert.isTrue(yield* fileSystem.exists(path.join(bundle, "Contents", "MacOS", "launcher")));
        assert.deepEqual(h.calls.openedApps, []);
        assert.equal(h.opened.length, 1);
      }),
    ),
  );

  it.effect("does nothing off macOS or without a loader", () =>
    withHome(({ home, recordsPath, fileSystem }) =>
      Effect.gen(function* () {
        const h = yield* harness({ platform: "darwin", fileSystem }, home, recordsPath);
        const result = yield* h.installer.install(input);
        assert.equal(result.status, "installed");
        yield* h.installer.upgradeLaunchers;
        assert.deepEqual(h.calls.cdHashReads, []);
        // Without a shim the page opens in a window here, as before.
        assert.equal(h.opened.length, 1);
        assert.deepEqual(h.calls.openedApps, []);
      }),
    ),
  );
});

function appShimWithoutLoader(config: ArtifactAppInstaller.ArtifactAppShimConfig) {
  const { loaderPath: _loaderPath, ...rest } = config;
  return rest;
}
