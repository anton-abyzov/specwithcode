/**
 * The installer's test seams: a private temp home per test and a host with the
 * platform, dialogs, code signing, the app shim loader, shortcuts and the Trash
 * faked. Nothing touches the person's Applications folder or user data.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert } from "@effect/vitest";
import type { DesktopArtifactAppInstallInput } from "@specweave-studio/contracts";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import type * as Electron from "electron";

import * as ArtifactAppGrants from "./ArtifactAppGrants.ts";
import * as ArtifactAppInstaller from "./ArtifactAppInstaller.ts";
import * as ArtifactAppInstallerHost from "./ArtifactAppInstallerHost.ts";
import * as ArtifactAppRecords from "./ArtifactAppRecords.ts";
import * as ArtifactAppShimRecords from "./ArtifactAppShimRecords.ts";
import * as ArtifactAppWindows from "./ArtifactAppWindows.ts";

export const input: DesktopArtifactAppInstallInput = {
  environmentId: "environment-1",
  threadId: "thread-1",
  attachmentId: "attachment-1",
  title: "Morning dashboard",
};

export interface HostCalls {
  readonly dialogs: Array<Electron.MessageBoxOptions>;
  readonly codesigned: Array<string>;
  readonly refreshed: Array<string>;
  readonly shortcuts: Array<{ readonly path: string; readonly options: Electron.ShortcutDetails }>;
  readonly trashed: Array<string>;
  readonly revealed: Array<string>;
  readonly openedApps: Array<string>;
  readonly cdHashReads: Array<string>;
  /** Bundles whose executable was changed after signing: they no longer verify. */
  readonly tampered: Set<string>;
}

export const newCalls = (): HostCalls => ({
  dialogs: [],
  codesigned: [],
  refreshed: [],
  shortcuts: [],
  trashed: [],
  revealed: [],
  openedApps: [],
  cdHashReads: [],
  tampered: new Set(),
});

export const WINDOWS_HOST = HostProcessPlatform.defaultValue() === "win32";
// The macOS and Linux code joins with "/" even on a Windows test host; the test
// builds its expected paths with the host's separator.
export const hostPath = (path: string) => (WINDOWS_HOST ? path.replaceAll("/", "\\") : path);

export const hostLayer = (input: {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly calls: HostCalls;
  readonly answer?: number;
  /** Dialog answers in order; once used up, `answer` (or 0) answers. */
  readonly answers?: ReadonlyArray<number>;
  readonly icns?: string;
  readonly fileSystem?: FileSystem.FileSystem;
  readonly installedAppNames?: ReadonlyArray<string>;
  readonly trashFails?: boolean;
  readonly appShim?: ArtifactAppInstaller.ArtifactAppShimConfig;
  readonly cdHashFails?: boolean;
}) => {
  const answers = [...(input.answers ?? [])];
  return Layer.succeed(
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
          return answers.shift() ?? input.answer ?? 0;
        }),
      codesign: (bundlePath) =>
        Effect.sync(() => {
          input.calls.codesigned.push(hostPath(bundlePath));
        }),
      appShim: Option.fromNullishOr(input.appShim),
      // A distinct hash per signing, as a rebuilt bundle would have; reading again gives
      // the same one, and a changed bundle fails verification.
      readCdHash: (bundlePath) =>
        Effect.gen(function* () {
          input.calls.cdHashReads.push(hostPath(bundlePath));
          if (input.cdHashFails === true || input.calls.tampered.has(hostPath(bundlePath))) {
            return yield* Effect.fail(
              new ArtifactAppInstallerHost.ArtifactAppHostCommandError({
                command: "codesign-read",
              }),
            );
          }
          return String(input.calls.codesigned.length).padStart(40, "a");
        }),
      openApp: (bundlePath) =>
        Effect.sync(() => {
          input.calls.openedApps.push(hostPath(bundlePath));
        }),
      refreshLinuxApplications: (directory) =>
        Effect.sync(() => {
          input.calls.refreshed.push(hostPath(directory));
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
          input.calls.trashed.push(hostPath(path));
          if (input.trashFails === true) return yield* Effect.die(new Error("Trash refused"));
          // The real Trash moves the bundle away; the test removes it.
          if (input.fileSystem !== undefined) {
            yield* input.fileSystem.remove(path, { recursive: true }).pipe(Effect.orDie);
          }
        }),
      showItemInFolder: (path) =>
        Effect.sync(() => {
          input.calls.revealed.push(hostPath(path));
        }),
    }),
  );
};

export const windowsLayer = (opened: Array<string>, closed: Array<string>) =>
  Layer.succeed(
    ArtifactAppWindows.ArtifactAppWindows,
    ArtifactAppWindows.ArtifactAppWindows.of({
      shimInstallIds: Effect.succeed([]),
      open: (installId) =>
        Effect.sync(() => {
          opened.push(installId);
          return "opened" as const;
        }),
      installIdForWebContents: () => Effect.succeedNone,
      windowForInstall: () => Effect.succeedNone,
      setVersionUrl: () => Effect.void,
      isFrameOnVersion: () => Effect.succeed(false),
      onClosed: () => Effect.void,
      onFrameStrayed: () => Effect.void,
      close: (installId) =>
        Effect.sync(() => {
          closed.push(installId);
        }),
      closeAll: Effect.void,
    }),
  );

export interface Harness {
  readonly installer: ArtifactAppInstaller.ArtifactAppInstaller["Service"];
  readonly records: ArtifactAppRecords.ArtifactAppRecords["Service"];
  readonly grants: ArtifactAppGrants.ArtifactAppGrants["Service"];
  readonly shimRecords: ArtifactAppShimRecords.ArtifactAppShimRecords["Service"];
  readonly calls: HostCalls;
  readonly opened: Array<string>;
  readonly closed: Array<string>;
  readonly home: string;
}

export const harness = (
  options: {
    readonly platform: NodeJS.Platform;
    readonly answer?: number;
    /** Dialog answers in order; once used up, `answer` (or 0) answers. */
    readonly answers?: ReadonlyArray<number>;
    readonly icns?: string;
    readonly fileSystem?: FileSystem.FileSystem;
    readonly installedAppNames?: ReadonlyArray<string>;
    readonly trashFails?: boolean;
    readonly appShim?: ArtifactAppInstaller.ArtifactAppShimConfig;
    readonly cdHashFails?: boolean;
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
            // Beside the records, in the same private test home.
            ArtifactAppGrants.layer(`${recordsPath}.grants.json`),
            ArtifactAppShimRecords.layer(`${recordsPath}.shims`),
          ),
        ),
        Layer.provide(Layer.succeed(FileSystem.FileSystem, fileSystem)),
      ),
    );
    return {
      installer: Context.get(context, ArtifactAppInstaller.ArtifactAppInstaller),
      records: Context.get(context, ArtifactAppRecords.ArtifactAppRecords),
      grants: Context.get(context, ArtifactAppGrants.ArtifactAppGrants),
      shimRecords: Context.get(context, ArtifactAppShimRecords.ArtifactAppShimRecords),
      calls,
      opened,
      closed,
      home,
    } satisfies Harness;
  });

// A private test home per test; nothing is written to the person's Applications or user data.
export const withHome = <A, E>(
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

// Windows has no POSIX file modes, so a mode is only checked elsewhere.
export const assertMode = (fileSystem: FileSystem.FileSystem, path: string, expected: number) =>
  WINDOWS_HOST
    ? Effect.void
    : fileSystem.stat(path).pipe(Effect.map((info) => assert.equal(info.mode & 0o777, expected)));
