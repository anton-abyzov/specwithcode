import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { DesktopArtifactAppInstallInput } from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import type * as Scope from "effect/Scope";
import type * as Electron from "electron";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import * as ArtifactAppInstaller from "./ArtifactAppInstaller.ts";
import * as ArtifactAppRecords from "./ArtifactAppRecords.ts";
import * as ArtifactAppWindows from "./ArtifactAppWindows.ts";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";

const input: DesktopArtifactAppInstallInput = {
  environmentId: "environment-1",
  threadId: "thread-1",
  attachmentId: "attachment-1",
  title: "Morning dashboard",
};

interface HostCalls {
  readonly dialogs: Array<Electron.MessageBoxOptions>;
  readonly codesigned: Array<string>;
  readonly refreshed: Array<string>;
  readonly shortcuts: Array<{ readonly path: string; readonly options: Electron.ShortcutDetails }>;
  readonly trashed: Array<string>;
  readonly revealed: Array<string>;
}

const newCalls = (): HostCalls => ({
  dialogs: [],
  codesigned: [],
  refreshed: [],
  shortcuts: [],
  trashed: [],
  revealed: [],
});

const hostLayer = (input: {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly calls: HostCalls;
  readonly answer?: number;
  readonly icns?: string;
  readonly fileSystem?: FileSystem.FileSystem;
  readonly installedAppNames?: ReadonlyArray<string>;
  readonly trashFails?: boolean;
}) =>
  Layer.succeed(
    ArtifactAppInstaller.ArtifactAppInstallerHost,
    ArtifactAppInstaller.ArtifactAppInstallerHost.of({
      platform: input.platform,
      displayName: "SpecWithCode",
      scheme: "studio",
      bundleIdPrefix: "com.specweave.studio",
      appUserModelId: "com.specweave.studio",
      linuxApplicationsDir: `${input.home}/.local/share/applications`,
      windowsExecutable: {
        path: "C:\\Program Files\\SpecWithCode\\SpecWithCode.exe",
        leadingArgs: [],
      },
      folders: Effect.succeed(
        input.platform === "win32"
          ? {
              home: "C:\\Users\\alice",
              appData: "C:\\Users\\alice\\AppData\\Roaming",
              desktop: "C:\\Users\\alice\\Desktop",
            }
          : {
              home: input.home,
              appData: `${input.home}/appdata`,
              desktop: `${input.home}/Desktop`,
            },
      ),
      icons: Effect.succeed({
        macIcns: Option.fromNullishOr(input.icns),
        windowsIcon: Option.some("C:\\Program Files\\SpecWithCode\\SpecWithCode.exe"),
        linuxIcon: Option.some("/opt/SpecWithCode/icon.png"),
      }),
      // Faked: tests never list the computer's real apps.
      installedAppNames: Effect.succeed(input.installedAppNames ?? []),
      showMessageBox: (_owner, options) =>
        Effect.sync(() => {
          input.calls.dialogs.push(options);
          return input.answer ?? 0;
        }),
      codesign: (bundlePath) =>
        Effect.sync(() => {
          input.calls.codesigned.push(bundlePath);
        }),
      refreshLinuxApplications: (directory) =>
        Effect.sync(() => {
          input.calls.refreshed.push(directory);
        }),
      writeShortcutLink: (path, options) =>
        Effect.sync(() => {
          input.calls.shortcuts.push({ path, options });
          return true;
        }),
      // The shortcut this test wrote at that path, read back like Windows would.
      readShortcut: (path) =>
        Effect.sync(() => {
          const written = input.calls.shortcuts.findLast((shortcut) => shortcut.path === path);
          return written === undefined
            ? Option.none()
            : Option.some({
                target: written.options.target,
                args: written.options.args ?? "",
                appUserModelId: written.options.appUserModelId ?? "",
              });
        }),
      trashItem: (path) =>
        Effect.gen(function* () {
          input.calls.trashed.push(path);
          if (input.trashFails === true) return yield* Effect.die(new Error("Trash refused"));
          // The real Trash moves the bundle away; the test removes it.
          if (input.fileSystem !== undefined) {
            yield* input.fileSystem.remove(path, { recursive: true }).pipe(Effect.orDie);
          }
        }),
      showItemInFolder: (path) =>
        Effect.sync(() => {
          input.calls.revealed.push(path);
        }),
    }),
  );

const windowsLayer = (opened: Array<string>, closed: Array<string>) =>
  Layer.succeed(
    ArtifactAppWindows.ArtifactAppWindows,
    ArtifactAppWindows.ArtifactAppWindows.of({
      open: (installId) =>
        Effect.sync(() => {
          opened.push(installId);
          return "opened" as const;
        }),
      installIdForWebContents: () => Effect.succeedNone,
      close: (installId) =>
        Effect.sync(() => {
          closed.push(installId);
        }),
      closeAll: Effect.void,
    }),
  );

interface Harness {
  readonly installer: ArtifactAppInstaller.ArtifactAppInstaller["Service"];
  readonly records: ArtifactAppRecords.ArtifactAppRecords["Service"];
  readonly calls: HostCalls;
  readonly opened: Array<string>;
  readonly closed: Array<string>;
  readonly home: string;
}

const harness = (
  options: {
    readonly platform: NodeJS.Platform;
    readonly answer?: number;
    readonly icns?: string;
    readonly fileSystem?: FileSystem.FileSystem;
    readonly installedAppNames?: ReadonlyArray<string>;
    readonly trashFails?: boolean;
  },
  home: string,
  recordsPath: string,
) =>
  Effect.gen(function* () {
    const fileSystem = options.fileSystem ?? (yield* FileSystem.FileSystem);
    const calls = newCalls();
    const opened: Array<string> = [];
    const closed: Array<string> = [];
    const context = yield* Layer.build(
      ArtifactAppInstaller.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            hostLayer({ ...options, home, calls, fileSystem }),
            windowsLayer(opened, closed),
            ArtifactAppRecords.layer(recordsPath),
          ),
        ),
        Layer.provide(Layer.succeed(FileSystem.FileSystem, fileSystem)),
      ),
    );
    return {
      installer: Context.get(context, ArtifactAppInstaller.ArtifactAppInstaller),
      records: Context.get(context, ArtifactAppRecords.ArtifactAppRecords),
      calls,
      opened,
      closed,
      home,
    } satisfies Harness;
  });

// A private test home per test; nothing is written to the person's Applications or user data.
const withHome = <A, E>(
  body: (paths: {
    readonly home: string;
    readonly recordsPath: string;
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
  }) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "studio-desktop-artifact-app-installer-test-",
    });
    const home = path.join(directory, "home");
    yield* fileSystem.makeDirectory(home);
    const recordsPath = path.join(
      directory,
      "user-data",
      ArtifactAppRecords.ARTIFACT_APPS_RECORD_FILE,
    );
    return yield* body({ home, recordsPath, fileSystem, path });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const mode = (fileSystem: FileSystem.FileSystem, path: string) =>
  fileSystem.stat(path).pipe(Effect.map((info) => info.mode & 0o777));

describe("ArtifactAppInstaller on macOS", () => {
  it.effect("writes a bundle with the plist, an executable launcher and the app icon", () =>
    withHome(({ home, recordsPath, fileSystem, path }) =>
      Effect.gen(function* () {
        const icns = path.join(home, "source.icns");
        yield* fileSystem.writeFileString(icns, "ICNS");
        const h = yield* harness({ platform: "darwin", icns }, home, recordsPath);

        const result = yield* h.installer.install(input);
        assert.equal(result.status, "installed");
        if (result.status !== "installed") return;
        const { app } = result;
        assert.match(app.installId, /^[0-9a-f]{32}$/);
        assert.equal(app.name, "Morning dashboard");
        assert.equal(app.title, input.title);
        assert.equal(app.attachmentId, input.attachmentId);
        assert.isFalse(Number.isNaN(Date.parse(app.installedAt)));

        const folder = path.join(home, "Applications", "SpecWithCode Apps");
        const bundle = path.join(folder, "Morning dashboard.app");
        assert.deepEqual((yield* fileSystem.readDirectory(folder)).sort(), [
          "Morning dashboard.app",
        ]);
        assert.equal(yield* mode(fileSystem, folder), 0o755);
        const plist = yield* fileSystem.readFileString(path.join(bundle, "Contents/Info.plist"));
        assert.include(plist, `com.specweave.studio.artifactapp.${app.installId}`);
        assert.include(plist, "<string>Morning dashboard</string>");
        const launcher = path.join(bundle, "Contents/MacOS/launcher");
        assert.include(
          yield* fileSystem.readFileString(launcher),
          `exec /usr/bin/open 'studio://app/artifact-app/${app.installId}'`,
        );
        assert.equal(yield* mode(fileSystem, launcher), 0o755);
        assert.equal(yield* mode(fileSystem, path.join(bundle, "Contents/Info.plist")), 0o644);
        const icon = path.join(bundle, "Contents/Resources/AppIcon.icns");
        assert.equal(yield* fileSystem.readFileString(icon), "ICNS");
        assert.equal(yield* mode(fileSystem, icon), 0o644);
        assert.equal(
          yield* fileSystem.readFileString(path.join(bundle, "Contents/PkgInfo")),
          "APPL????",
        );

        // Signed while staged, then moved in; the staging folder is gone.
        assert.equal(h.calls.codesigned.length, 1);
        assert.include(h.calls.codesigned[0]!, "staging");
        assert.deepEqual(
          (yield* fileSystem.readDirectory(path.join(home, "Applications"))).sort(),
          ["SpecWithCode Apps"],
        );

        assert.deepEqual(h.calls.dialogs, [
          ArtifactAppInstaller.artifactAppInstallConfirmation("Morning dashboard"),
        ]);
        assert.deepEqual(h.opened, [app.installId]);
        assert.deepEqual(yield* h.records.list, [app]);
      }),
    ),
  );

  it.effect("asks with Cancel as the default and writes nothing when cancelled", () =>
    withHome(({ home, recordsPath, fileSystem, path }) =>
      Effect.gen(function* () {
        const h = yield* harness({ platform: "darwin", answer: 1 }, home, recordsPath);
        const result = yield* h.installer.install(input);
        assert.deepEqual(result, { status: "cancelled" });
        const [dialog] = h.calls.dialogs;
        assert.equal(dialog?.message, "Install Morning dashboard as an app?");
        assert.equal(
          dialog?.detail,
          "It gets its own icon and window and always shows the newest version of this page. It can't reach your files or run programs.",
        );
        assert.deepEqual(dialog?.buttons, ["Install", "Cancel"]);
        assert.equal(dialog?.defaultId, 1);
        assert.equal(dialog?.cancelId, 1);
        assert.isFalse(yield* fileSystem.exists(path.join(home, "Applications")));
        assert.deepEqual(yield* h.records.list, []);
        assert.deepEqual(h.opened, []);
      }),
    ),
  );

  it.effect("says already installed for the same page and focuses its window", () =>
    withHome(({ home, recordsPath }) =>
      Effect.gen(function* () {
        const h = yield* harness({ platform: "darwin" }, home, recordsPath);
        const first = yield* h.installer.install(input);
        assert.equal(first.status, "installed");
        if (first.status !== "installed") return;

        const again = yield* h.installer.install({ ...input, attachmentId: "attachment-2" });
        assert.deepEqual(again, { status: "already-installed", app: first.app });
        assert.equal(h.calls.dialogs.length, 1);
        assert.deepEqual(h.opened, [first.app.installId, first.app.installId]);

        // Another thread's page with the same title is its own app, with its own name.
        const other = yield* h.installer.install({ ...input, threadId: "thread-2" });
        assert.equal(other.status, "installed");
        if (other.status === "installed") assert.equal(other.app.name, "Morning dashboard 2");
      }),
    ),
  );

  it.effect("installs again when the launcher was deleted by hand", () =>
    withHome(({ home, recordsPath, fileSystem, path }) =>
      Effect.gen(function* () {
        const h = yield* harness({ platform: "darwin" }, home, recordsPath);
        const first = yield* h.installer.install(input);
        if (first.status !== "installed") return assert.fail("not installed");
        yield* fileSystem.remove(
          path.join(home, "Applications", "SpecWithCode Apps", "Morning dashboard.app"),
          { recursive: true },
        );
        const second = yield* h.installer.install(input);
        assert.equal(second.status, "installed");
        if (second.status !== "installed") return;
        assert.notEqual(second.app.installId, first.app.installId);
        assert.deepEqual(
          (yield* h.records.list).map((app) => app.installId),
          [second.app.installId],
        );
      }),
    ),
  );

  it.effect("never replaces an app already in the folder", () =>
    withHome(({ home, recordsPath, fileSystem, path }) =>
      Effect.gen(function* () {
        const folder = path.join(home, "Applications", "SpecWithCode Apps");
        yield* fileSystem.makeDirectory(path.join(folder, "Morning dashboard.app"), {
          recursive: true,
        });
        const h = yield* harness({ platform: "darwin" }, home, recordsPath);
        const result = yield* h.installer.install(input);
        assert.equal(result.status, "installed");
        if (result.status === "installed") assert.equal(result.app.name, "Morning dashboard 2");
      }),
    ),
  );

  it.effect("refuses an apps folder that is a symbolic link or a file", () =>
    withHome(({ home, recordsPath, fileSystem, path }) =>
      Effect.gen(function* () {
        const applications = path.join(home, "Applications");
        const elsewhere = path.join(home, "elsewhere");
        yield* fileSystem.makeDirectory(applications);
        yield* fileSystem.makeDirectory(elsewhere);
        yield* fileSystem.symlink(elsewhere, path.join(applications, "SpecWithCode Apps"));
        const h = yield* harness({ platform: "darwin" }, home, recordsPath);

        const linked = yield* h.installer.install(input);
        assert.deepEqual(linked, {
          status: "failed",
          message:
            "The SpecWithCode Apps folder is a link or a file, so the page was not installed.",
        });
        assert.deepEqual(yield* fileSystem.readDirectory(elsewhere), []);
        assert.deepEqual(yield* h.records.list, []);
        assert.deepEqual(h.opened, []);

        yield* fileSystem.remove(path.join(applications, "SpecWithCode Apps"));
        yield* fileSystem.writeFileString(path.join(applications, "SpecWithCode Apps"), "");
        const file = yield* h.installer.install(input);
        assert.equal(file.status, "failed");
        assert.deepEqual(yield* h.records.list, []);
      }),
    ),
  );

  it.effect("uninstall moves the bundle to the Trash, forgets it and closes its window", () =>
    withHome(({ home, recordsPath, fileSystem, path }) =>
      Effect.gen(function* () {
        const h = yield* harness({ platform: "darwin", fileSystem }, home, recordsPath);
        const result = yield* h.installer.install(input);
        if (result.status !== "installed") return assert.fail("not installed");
        const bundle = path.join(
          home,
          "Applications",
          "SpecWithCode Apps",
          "Morning dashboard.app",
        );

        assert.isTrue(yield* h.installer.reveal(result.app.installId));
        assert.deepEqual(h.calls.revealed, [bundle]);

        assert.isTrue(yield* h.installer.uninstall(result.app.installId));
        // Moved to a random private name and checked there before it goes to the Trash.
        assert.equal(h.calls.trashed.length, 1);
        assert.equal(path.dirname(h.calls.trashed[0]!), path.dirname(bundle));
        assert.match(
          path.basename(h.calls.trashed[0]!),
          /^\.Morning dashboard\.app\.removing-[0-9a-f]{32}$/,
        );
        assert.isFalse(yield* fileSystem.exists(bundle));
        assert.deepEqual(yield* h.records.list, []);
        assert.deepEqual(h.closed, [result.app.installId]);

        assert.isFalse(yield* h.installer.uninstall(result.app.installId));
        assert.isFalse(yield* h.installer.reveal(result.app.installId));
        assert.isFalse(yield* h.installer.uninstall("not-an-id"));
      }),
    ),
  );
});

describe("ArtifactAppInstaller uninstall leaves files that are not its launcher", () => {
  it.effect("keeps an app that took the launcher's place and forgets the install", () =>
    withHome(({ home, recordsPath, fileSystem, path }) =>
      Effect.gen(function* () {
        const h = yield* harness({ platform: "darwin", fileSystem }, home, recordsPath);
        const result = yield* h.installer.install(input);
        if (result.status !== "installed") return assert.fail("not installed");
        const folder = path.join(home, "Applications", "SpecWithCode Apps");
        const bundle = path.join(folder, "Morning dashboard.app");

        // The launcher is moved away and another app is put at its path.
        yield* fileSystem.rename(bundle, path.join(home, "moved.app"));
        const macOS = path.join(bundle, "Contents", "MacOS");
        yield* fileSystem.makeDirectory(macOS, { recursive: true });
        yield* fileSystem.writeFileString(path.join(macOS, "Morning dashboard"), "#!/bin/sh\n");

        assert.isFalse(yield* h.installer.reveal(result.app.installId));
        assert.isTrue(yield* h.installer.uninstall(result.app.installId));
        assert.deepEqual(h.calls.trashed, []);
        assert.isTrue(yield* fileSystem.exists(bundle));
        assert.deepEqual(yield* h.records.list, []);
      }),
    ),
  );

  it.effect("keeps a bundle whose launcher script was swapped, even with its plist kept", () =>
    withHome(({ home, recordsPath, fileSystem, path }) =>
      Effect.gen(function* () {
        const h = yield* harness({ platform: "darwin", fileSystem }, home, recordsPath);
        const result = yield* h.installer.install(input);
        if (result.status !== "installed") return assert.fail("not installed");
        const bundle = path.join(
          home,
          "Applications",
          "SpecWithCode Apps",
          "Morning dashboard.app",
        );
        const macOS = path.join(bundle, "Contents", "MacOS");
        for (const entry of yield* fileSystem.readDirectory(macOS)) {
          yield* fileSystem.writeFileString(path.join(macOS, entry), "#!/bin/sh\necho other\n");
        }

        assert.isTrue(yield* h.installer.uninstall(result.app.installId));
        assert.deepEqual(h.calls.trashed, []);
        assert.isTrue(yield* fileSystem.exists(bundle));
      }),
    ),
  );

  it.effect("keeps a bundle pointed at another program or through a linked folder", () =>
    withHome(({ home, recordsPath, fileSystem, path }) =>
      Effect.gen(function* () {
        const h = yield* harness({ platform: "darwin", fileSystem }, home, recordsPath);
        const result = yield* h.installer.install(input);
        if (result.status !== "installed") return assert.fail("not installed");
        const bundle = path.join(
          home,
          "Applications",
          "SpecWithCode Apps",
          "Morning dashboard.app",
        );
        const plist = path.join(bundle, "Contents", "Info.plist");
        const original = yield* fileSystem.readFileString(plist);

        // The plist now runs another program; the launcher script is untouched.
        yield* fileSystem.writeFileString(
          plist,
          original.replace("<string>launcher</string>", "<string>other</string>"),
        );
        assert.isTrue(yield* h.installer.uninstall(result.app.installId));
        assert.deepEqual(h.calls.trashed, []);

        // A bundle whose Contents is a link to an exact copy is not removed either.
        const h2 = yield* harness({ platform: "darwin", fileSystem }, home, recordsPath);
        const second = yield* h2.installer.install({ ...input, title: "Evening dashboard" });
        if (second.status !== "installed") return assert.fail("not installed");
        const secondBundle = path.join(
          home,
          "Applications",
          "SpecWithCode Apps",
          "Evening dashboard.app",
        );
        const copy = path.join(home, "Contents copy");
        yield* fileSystem.rename(path.join(secondBundle, "Contents"), copy);
        yield* fileSystem.symlink(copy, path.join(secondBundle, "Contents"));
        assert.isTrue(yield* h2.installer.uninstall(second.app.installId));
        assert.deepEqual(h2.calls.trashed, []);
      }),
    ),
  );

  it.effect("keeps the install when the Trash fails and finishes on the next uninstall", () =>
    withHome(({ home, recordsPath, fileSystem, path }) =>
      Effect.gen(function* () {
        const h = yield* harness(
          { platform: "darwin", fileSystem, trashFails: true },
          home,
          recordsPath,
        );
        const result = yield* h.installer.install(input);
        if (result.status !== "installed") return assert.fail("not installed");
        const folder = path.join(home, "Applications", "SpecWithCode Apps");

        assert.isFalse(yield* h.installer.uninstall(result.app.installId));
        const [left] = yield* fileSystem.readDirectory(folder);
        assert.match(left!, /^\.Morning dashboard\.app\.removing-[0-9a-f]{32}$/);
        assert.equal((yield* h.records.list).length, 1);

        // Something new at the old path is never touched.
        yield* fileSystem.makeDirectory(path.join(folder, "Morning dashboard.app"));
        const retry = yield* harness({ platform: "darwin", fileSystem }, home, recordsPath);
        assert.isTrue(yield* retry.installer.uninstall(result.app.installId));
        assert.deepEqual(retry.calls.trashed, [path.join(folder, left!)]);
        assert.deepEqual(yield* fileSystem.readDirectory(folder), ["Morning dashboard.app"]);
        assert.deepEqual(yield* retry.records.list, []);
      }),
    ),
  );

  it.effect("finishes a pending removal before installing again, or keeps the install", () =>
    withHome(({ home, recordsPath, fileSystem, path }) =>
      Effect.gen(function* () {
        const failing = yield* harness(
          { platform: "darwin", fileSystem, trashFails: true },
          home,
          recordsPath,
        );
        const result = yield* failing.installer.install(input);
        if (result.status !== "installed") return assert.fail("not installed");
        const folder = path.join(home, "Applications", "SpecWithCode Apps");
        assert.isFalse(yield* failing.installer.uninstall(result.app.installId));

        // The Trash still fails: installing again neither forgets nor asks.
        const again = yield* failing.installer.install(input);
        assert.equal(again.status, "failed");
        assert.equal((yield* failing.records.list).length, 1);

        // An exact copy kept under another hidden name is not a pending removal.
        const [pending] = yield* fileSystem.readDirectory(folder);
        const backup = path.join(folder, ".Morning dashboard.app.removing-backup");
        yield* fileSystem.copy(path.join(folder, pending!), backup);

        const working = yield* harness({ platform: "darwin", fileSystem }, home, recordsPath);
        const reinstalled = yield* working.installer.install(input);
        assert.equal(reinstalled.status, "installed");
        assert.deepEqual(working.calls.trashed, [path.join(folder, pending!)]);
        assert.isTrue(yield* fileSystem.exists(backup));
      }),
    ),
  );

  // Folder modes do not stop Windows or root from listing it.
  it.effect.skipIf(HostProcessPlatform.defaultValue() === "win32" || process.getuid?.() === 0)(
    "keeps the install when its apps folder cannot be listed",
    () =>
      withHome(({ home, recordsPath, fileSystem, path }) =>
        Effect.gen(function* () {
          const h = yield* harness({ platform: "darwin", fileSystem }, home, recordsPath);
          const result = yield* h.installer.install(input);
          if (result.status !== "installed") return assert.fail("not installed");
          const folder = path.join(home, "Applications", "SpecWithCode Apps");
          yield* fileSystem.chmod(folder, 0o000);
          const uninstalled = yield* h.installer
            .uninstall(result.app.installId)
            .pipe(Effect.ensuring(fileSystem.chmod(folder, 0o755).pipe(Effect.orDie)));
          assert.isFalse(uninstalled);
          assert.equal((yield* h.records.list).length, 1);
        }),
      ),
  );

  it.effect("never removes through an apps folder that became a link", () =>
    withHome(({ home, recordsPath, fileSystem, path }) =>
      Effect.gen(function* () {
        const h = yield* harness({ platform: "darwin", fileSystem }, home, recordsPath);
        const result = yield* h.installer.install(input);
        if (result.status !== "installed") return assert.fail("not installed");
        const folder = path.join(home, "Applications", "SpecWithCode Apps");
        const elsewhere = path.join(home, "Elsewhere");

        // The folder is moved and a link to it takes its place.
        yield* fileSystem.rename(folder, elsewhere);
        yield* fileSystem.symlink(elsewhere, folder);

        assert.isTrue(yield* h.installer.uninstall(result.app.installId));
        assert.deepEqual(h.calls.trashed, []);
        assert.isTrue(yield* fileSystem.exists(path.join(elsewhere, "Morning dashboard.app")));
      }),
    ),
  );
});

describe("ArtifactAppInstaller names", () => {
  it.effect("marks a page that imitates an app on the computer, case folded", () =>
    withHome(({ home, recordsPath }) =>
      Effect.gen(function* () {
        const h = yield* harness(
          { platform: "linux", installedAppNames: ["Morning Dashboard"] },
          home,
          recordsPath,
        );
        const result = yield* h.installer.install(input);
        assert.equal(result.status, "installed");
        if (result.status !== "installed") return;
        assert.equal(result.app.name, "Morning dashboard (Page)");
      }),
    ),
  );
});

describe("ArtifactAppInstaller on Linux", () => {
  it.effect("writes a 0644 desktop entry that opens the launch URL", () =>
    withHome(({ home, recordsPath, fileSystem, path }) =>
      Effect.gen(function* () {
        const h = yield* harness({ platform: "linux", fileSystem }, home, recordsPath);
        const result = yield* h.installer.install(input);
        if (result.status !== "installed") return assert.fail("not installed");
        const directory = path.join(home, ".local/share/applications");
        const entryPath = path.join(directory, `specwithcode-app-${result.app.installId}.desktop`);
        assert.deepEqual(yield* fileSystem.readDirectory(directory), [
          `specwithcode-app-${result.app.installId}.desktop`,
        ]);
        const entry = yield* fileSystem.readFileString(entryPath);
        assert.include(entry, "Name=Morning dashboard");
        assert.include(entry, `Exec=xdg-open "studio://app/artifact-app/${result.app.installId}"`);
        assert.include(entry, "Icon=/opt/SpecWithCode/icon.png");
        assert.equal(yield* mode(fileSystem, entryPath), 0o644);
        assert.deepEqual(h.calls.refreshed, [directory]);
        assert.deepEqual(h.calls.codesigned, []);

        assert.isTrue(yield* h.installer.uninstall(result.app.installId));
        assert.isFalse(yield* fileSystem.exists(entryPath));
        assert.deepEqual(yield* h.records.list, []);
      }),
    ),
  );

  it.effect("still removes its own entry after the app's icon moved", () =>
    withHome(({ home, recordsPath, fileSystem, path }) =>
      Effect.gen(function* () {
        const h = yield* harness({ platform: "linux", fileSystem }, home, recordsPath);
        const result = yield* h.installer.install(input);
        if (result.status !== "installed") return assert.fail("not installed");
        const entryPath = path.join(
          home,
          ".local/share/applications",
          `specwithcode-app-${result.app.installId}.desktop`,
        );
        const entry = yield* fileSystem.readFileString(entryPath);
        yield* fileSystem.writeFileString(
          entryPath,
          entry.replace(/^Icon=.*$/m, "Icon=/tmp/old-icon.png"),
        );

        assert.isTrue(yield* h.installer.uninstall(result.app.installId));
        assert.isFalse(yield* fileSystem.exists(entryPath));
      }),
    ),
  );

  it.effect("leaves an entry whose Exec was pointed at another program", () =>
    withHome(({ home, recordsPath, fileSystem, path }) =>
      Effect.gen(function* () {
        const h = yield* harness({ platform: "linux", fileSystem }, home, recordsPath);
        const result = yield* h.installer.install(input);
        if (result.status !== "installed") return assert.fail("not installed");
        const entryPath = path.join(
          home,
          ".local/share/applications",
          `specwithcode-app-${result.app.installId}.desktop`,
        );
        const entry = yield* fileSystem.readFileString(entryPath);
        yield* fileSystem.writeFileString(
          entryPath,
          entry.replace(/^Exec=.*$/m, "Exec=/usr/bin/other"),
        );

        assert.isFalse(yield* h.installer.reveal(result.app.installId));
        assert.isTrue(yield* h.installer.uninstall(result.app.installId));
        assert.isTrue(yield* fileSystem.exists(entryPath));
      }),
    ),
  );
});

describe("ArtifactAppInstaller on Windows", () => {
  // Windows paths on a POSIX test host: a recording file system, so nothing lands on disk.
  const recordingFileSystem = (real: FileSystem.FileSystem, recordsPath: string) => {
    const directories: Array<string> = [];
    const removed: Array<string> = [];
    const existing = new Set<string>();
    // Paths that are links (a junction on Windows).
    const links = new Set<string>();
    const recordsDirectory = recordsPath.slice(0, recordsPath.lastIndexOf("/"));
    const isRecords = (path: string) => path.startsWith(recordsDirectory);
    const notFound = (path: string, method: string) =>
      PlatformError.systemError({
        _tag: "NotFound",
        module: "FileSystem",
        method,
        pathOrDescriptor: path,
      });
    const fileSystem = FileSystem.makeNoop({
      ...real,
      exists: (path) => (isRecords(path) ? real.exists(path) : Effect.succeed(existing.has(path))),
      readLink: (path) =>
        isRecords(path)
          ? real.readLink(path)
          : links.has(path)
            ? Effect.succeed("D:\\Elsewhere")
            : Effect.fail(notFound(path, "readLink")),
      readDirectory: (path) =>
        isRecords(path) ? real.readDirectory(path) : Effect.fail(notFound(path, "readDirectory")),
      makeDirectory: (path, options) =>
        isRecords(path)
          ? real.makeDirectory(path, options)
          : Effect.sync(() => {
              directories.push(path);
            }),
      chmod: (path, mode) => (isRecords(path) ? real.chmod(path, mode) : Effect.void),
      remove: (path, options) =>
        isRecords(path)
          ? real.remove(path, options)
          : Effect.sync(() => {
              removed.push(path);
              existing.delete(path);
            }),
    });
    return { fileSystem, directories, removed, existing, links };
  };

  it.effect("creates Start menu and Desktop shortcuts with a per-install identity", () =>
    withHome(({ home, recordsPath, fileSystem: real }) =>
      Effect.gen(function* () {
        const recording = recordingFileSystem(real, recordsPath);
        const h = yield* harness(
          { platform: "win32", fileSystem: recording.fileSystem },
          home,
          recordsPath,
        );
        const result = yield* h.installer.install(input);
        if (result.status !== "installed") return assert.fail(JSON.stringify(result));
        const startMenu =
          "C:\\Users\\alice\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\SpecWithCode Apps";
        assert.deepEqual(recording.directories, [startMenu]);
        const options: Electron.ShortcutDetails = {
          target: "C:\\Program Files\\SpecWithCode\\SpecWithCode.exe",
          args: `"studio://app/artifact-app/${result.app.installId}"`,
          description: "Morning dashboard, a page installed from SpecWithCode",
          icon: "C:\\Program Files\\SpecWithCode\\SpecWithCode.exe",
          iconIndex: 0,
          appUserModelId: `com.specweave.studio.artifactapp.${result.app.installId}`,
        };
        assert.deepEqual(h.calls.shortcuts, [
          { path: `${startMenu}\\Morning dashboard.lnk`, options },
          { path: "C:\\Users\\alice\\Desktop\\Morning dashboard.lnk", options },
        ]);

        for (const shortcut of h.calls.shortcuts) recording.existing.add(shortcut.path);
        // Someone replaced the Desktop shortcut with one of their own: it stays.
        h.calls.shortcuts.push({
          path: "C:\\Users\\alice\\Desktop\\Morning dashboard.lnk",
          options: { target: "C:\\Tools\\other.exe", args: "--other" },
        });
        assert.isTrue(yield* h.installer.uninstall(result.app.installId));
        assert.deepEqual(recording.removed, [`${startMenu}\\Morning dashboard.lnk`]);
        assert.deepEqual(yield* h.records.list, []);
      }),
    ),
  );
  it.effect("leaves the Desktop shortcut when the Desktop folder became a link", () =>
    withHome(({ home, recordsPath, fileSystem: real }) =>
      Effect.gen(function* () {
        const recording = recordingFileSystem(real, recordsPath);
        const h = yield* harness(
          { platform: "win32", fileSystem: recording.fileSystem },
          home,
          recordsPath,
        );
        const result = yield* h.installer.install(input);
        if (result.status !== "installed") return assert.fail(JSON.stringify(result));
        for (const shortcut of h.calls.shortcuts) recording.existing.add(shortcut.path);
        recording.links.add("C:\\Users\\alice\\Desktop");

        assert.isTrue(yield* h.installer.uninstall(result.app.installId));
        assert.deepEqual(recording.removed, [
          "C:\\Users\\alice\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\SpecWithCode Apps\\Morning dashboard.lnk",
        ]);
      }),
    ),
  );
  it.effect("leaves a shortcut that was pointed at another program", () =>
    withHome(({ home, recordsPath, fileSystem: real }) =>
      Effect.gen(function* () {
        const recording = recordingFileSystem(real, recordsPath);
        const h = yield* harness(
          { platform: "win32", fileSystem: recording.fileSystem },
          home,
          recordsPath,
        );
        const result = yield* h.installer.install(input);
        if (result.status !== "installed") return assert.fail(JSON.stringify(result));
        for (const shortcut of h.calls.shortcuts) recording.existing.add(shortcut.path);
        // Both shortcuts keep the URL argument but now start another program.
        // A copy: the loop adds to the list it reads.
        const written = h.calls.shortcuts.slice();
        for (const shortcut of written) {
          h.calls.shortcuts.push({
            path: shortcut.path,
            options: { ...shortcut.options, target: "C:\\Tools\\other.exe" },
          });
        }

        assert.isFalse(yield* h.installer.reveal(result.app.installId));
        assert.isTrue(yield* h.installer.uninstall(result.app.installId));
        assert.deepEqual(recording.removed, []);
      }),
    ),
  );
});
