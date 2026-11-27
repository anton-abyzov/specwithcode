/**
 * What the installer needs from the operating system and Electron, kept apart from
 * the install logic so tests fake it: folders, icons, dialogs, code signing, the
 * app shim loader, shortcuts and the Trash.
 */
import { HostProcessEnvironment } from "@specweave-studio/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Electron from "electron";

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import { getDesktopScheme } from "../electron/ElectronProtocol.ts";
import type { ArtifactAppShimHost } from "./ArtifactAppLaunchers.ts";
import { ArtifactAppCdHashSchema } from "./ArtifactAppShimRecords.ts";

const { logInfo, logWarning } = makeComponentLogger("desktop-artifact-app-installer");

const SHIM_LOADER_PATH = [
  "Frameworks",
  "Electron Framework.framework",
  "Versions",
  "A",
  "Helpers",
  "app_shim_loader",
] as const;

/** A string value of the app's own XML Info.plist; none when the key or format differs. */
export function plistString(plist: string, key: string): Option.Option<string> {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`<key>${escaped}</key>\\s*<string>([^<]+)</string>`).exec(plist);
  return Option.fromNullishOr(match?.[1]?.trim());
}

/** The code directory hash from `codesign -d -vvv` output; none when it is missing. */
export function parseCdHash(output: string): Option.Option<string> {
  const match = /^CDHash=([0-9a-f]{40})$/m.exec(output);
  return Option.filter(Option.fromNullishOr(match?.[1]), Schema.is(ArtifactAppCdHashSchema));
}

const COMMAND_TIMEOUT = "20 seconds";

export class ArtifactAppHostCommandError extends Schema.TaggedError<ArtifactAppHostCommandError>()(
  "ArtifactAppHostCommandError",
  {
    command: Schema.Literals(["codesign", "codesign-read", "update-desktop-database", "open"]),
    exitCode: Schema.optionalKey(Schema.Number),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    const exit = this.exitCode === undefined ? "" : ` with exit code ${this.exitCode}`;
    return `${this.command} failed${exit}.`;
  }
}

export const isHostCommandError = Schema.is(ArtifactAppHostCommandError);

export class ArtifactAppTrashError extends Schema.TaggedError<ArtifactAppTrashError>()(
  "ArtifactAppTrashError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Moving ${this.path} to the Trash failed.`;
  }
}

export interface ArtifactAppHostFolders {
  readonly home: string;
  readonly appData: string;
  readonly desktop: string;
}

/**
 * What a shim launcher needs from the running app: the loader to copy, the app
 * the shim starts and connects to, and the minimum macOS the loader runs on.
 */
export interface ArtifactAppShimConfig extends ArtifactAppShimHost {
  readonly loaderPath: string;
  readonly minimumSystemVersion: string;
}

/** The shim server name a launcher for the app with `bundleId` connects to. */
export function artifactAppShimServerName(bundleId: string): string {
  return `${bundleId}.artifact-apps`;
}

export interface ArtifactAppHostIcons {
  readonly macIcns: Option.Option<string>;
  readonly windowsIcon: Option.Option<string>;
  readonly linuxIcon: Option.Option<string>;
}

/**
 * What the installer needs from the operating system and Electron. A port so
 * tests install into a private temp home with the platform, dialogs, code
 * signing and shortcuts faked; the app uses `layerElectronHost`.
 */
export class ArtifactAppInstallerHost extends Context.Service<
  ArtifactAppInstallerHost,
  {
    readonly platform: NodeJS.Platform;
    /** "SpecWithCode", or the development build's name; the folder is "<displayName> Apps". */
    readonly displayName: string;
    readonly scheme: string;
    readonly bundleIdPrefix: string;
    readonly appUserModelId: string;
    readonly linuxApplicationsDir: string;
    /** What a Windows shortcut starts; an unpackaged build also passes its app folder first. */
    readonly windowsExecutable: {
      readonly path: string;
      readonly leadingArgs: ReadonlyArray<string>;
    };
    readonly folders: Effect.Effect<ArtifactAppHostFolders>;
    readonly icons: Effect.Effect<ArtifactAppHostIcons>;
    /**
     * Names of apps already on the computer, so a page can never pass for one.
     * Best effort: a folder that cannot be read adds nothing.
     */
    readonly installedAppNames: Effect.Effect<ReadonlyArray<string>>;
    /** The index of the button the person chose. */
    readonly showMessageBox: (
      owner: Option.Option<Electron.BrowserWindow>,
      options: Electron.MessageBoxOptions,
    ) => Effect.Effect<number>;
    readonly codesign: (bundlePath: string) => Effect.Effect<void, ArtifactAppHostCommandError>;
    /**
     * Shim launchers, on macOS in a packaged build that ships Electron's shim
     * loader; none elsewhere, where launchers stay scripts and shortcuts.
     */
    readonly appShim: Option.Option<ArtifactAppShimConfig>;
    /** The bundle's code hash, once its contents are verified against its signature. */
    readonly readCdHash: (bundlePath: string) => Effect.Effect<string, ArtifactAppHostCommandError>;
    /** Starts an app bundle, as opening it in Finder would. */
    readonly openApp: (bundlePath: string) => Effect.Effect<void>;
    readonly refreshLinuxApplications: (
      directory: string,
    ) => Effect.Effect<void, ArtifactAppHostCommandError>;
    readonly writeShortcutLink: (
      shortcutPath: string,
      options: Electron.ShortcutDetails,
    ) => Effect.Effect<boolean>;
    /** What a Windows shortcut starts; none when it cannot be read. */
    readonly readShortcut: (
      shortcutPath: string,
    ) => Effect.Effect<Option.Option<ArtifactAppShortcutReadBack>>;
    readonly trashItem: (path: string) => Effect.Effect<void, ArtifactAppTrashError>;
    readonly showItemInFolder: (path: string) => Effect.Effect<void>;
  }
>()("@specweave-studio/desktop/artifactApps/ArtifactAppInstallerHost") {}

/** The fields of a Windows shortcut that decide what it starts. */
export interface ArtifactAppShortcutReadBack {
  readonly target: string;
  readonly args: string;
  readonly appUserModelId: string;
}

const makeElectronHost = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const assets = yield* DesktopAssets.DesktopAssets;
  const fileSystem = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const runCommand = (
    command: ArtifactAppHostCommandError["command"],
    args: string[],
    file: string = command,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make(file, args, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }),
        );
        const exitCode = Number(yield* handle.exitCode.pipe(Effect.timeout(COMMAND_TIMEOUT)));
        if (exitCode !== 0) return yield* new ArtifactAppHostCommandError({ command, exitCode });
      }),
    ).pipe(
      Effect.mapError((error) =>
        isHostCommandError(error)
          ? error
          : new ArtifactAppHostCommandError({ command, cause: error }),
      ),
    );

  const processEnvironment = yield* HostProcessEnvironment;
  const join = environment.path.join;

  const folderEntries = (folder: string) =>
    fileSystem.readDirectory(folder).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

  // Entries of `folder` ending in `extension`, without it ("Notes.app" is "Notes").
  const namesWithExtension = (folder: string, extension: string) =>
    folderEntries(folder).pipe(
      Effect.map((entries) =>
        entries
          .filter((entry) => entry.toLowerCase().endsWith(extension))
          .map((entry) => entry.slice(0, -extension.length)),
      ),
    );

  const ownAppsFolder = `${environment.displayName} Apps`;

  // Start menu folders hold shortcuts at the top and one folder deep; this app's own folder
  // holds installed pages, which are counted as taken names instead.
  const startMenuNames = (programs: string) =>
    Effect.gen(function* () {
      const entries = yield* folderEntries(programs);
      const nested = yield* Effect.forEach(
        // Anything that is not a shortcut may be a folder ("Node.js" is); a file reads as empty.
        entries.filter((entry) => !/\.(lnk|ini|url)$/iu.test(entry) && entry !== ownAppsFolder),
        (entry) => namesWithExtension(join(programs, entry), ".lnk"),
        { concurrency: 8 },
      );
      return [...(yield* namesWithExtension(programs, ".lnk")), ...nested.flat()];
    });

  // The Name= of the [Desktop Entry] group, which is what launchers show.
  const desktopEntryName = (file: string) =>
    fileSystem.readFileString(file).pipe(
      Effect.map((contents) => {
        const group = contents.split(/^\[Desktop Entry\]$/mu)[1]?.split(/^\[/mu)[0] ?? "";
        return group.match(/^Name=(.+)$/mu)?.[1]?.trim() ?? null;
      }),
      Effect.orElseSucceed(() => null),
    );

  const linuxEntryNames = (folder: string) =>
    folderEntries(folder).pipe(
      Effect.flatMap((entries) =>
        Effect.forEach(
          entries
            .filter((entry) => entry.endsWith(".desktop"))
            // This app's own installed pages are taken names, not other apps.
            .filter((entry) => !entry.startsWith("specwithcode-app-"))
            .slice(0, 2000),
          (entry) => desktopEntryName(join(folder, entry)),
          { concurrency: 16 },
        ),
      ),
      Effect.map((names) => names.filter((name): name is string => name !== null)),
    );

  const installedAppNames = Effect.gen(function* () {
    const home = Electron.app.getPath("home");
    if (environment.platform === "darwin") {
      const folders = [
        "/Applications",
        "/Applications/Utilities",
        "/System/Applications",
        "/System/Applications/Utilities",
        join(home, "Applications"),
      ];
      return (yield* Effect.forEach(folders, (folder) =>
        namesWithExtension(folder, ".app"),
      )).flat();
    }
    if (environment.platform === "win32") {
      const startMenu = ["Microsoft", "Windows", "Start Menu", "Programs"] as const;
      const programData = processEnvironment.ProgramData ?? processEnvironment.PROGRAMDATA;
      const folders = [
        join(Electron.app.getPath("appData"), ...startMenu),
        ...(programData === undefined ? [] : [join(programData, ...startMenu)]),
      ];
      return (yield* Effect.forEach(folders, startMenuNames)).flat();
    }
    const folders = [
      environment.linuxApplicationsDir,
      "/usr/share/applications",
      "/usr/local/share/applications",
      "/var/lib/flatpak/exports/share/applications",
      join(home, ".local", "share", "flatpak", "exports", "share", "applications"),
    ];
    return (yield* Effect.forEach(folders, linuxEntryNames)).flat();
  }).pipe(
    Effect.catchCause((cause) =>
      logWarning("installed apps could not be listed", { cause: Cause.pretty(cause) }).pipe(
        Effect.as<ReadonlyArray<string>>([]),
      ),
    ),
  );

  const iconPaths = yield* assets.iconPaths;
  // An AppImage's own resources sit on a mount that is gone after it quits; the URL handler
  // installs a copy of the icon beside the desktop entries, which outlives it.
  const appImageIcon = environment.path.join(
    environment.linuxApplicationsDir,
    "..",
    "icons",
    `${environment.linuxDesktopEntryName}.png`,
  );
  const linuxIcon =
    environment.platform !== "linux"
      ? Effect.succeed(Option.none<string>())
      : Option.isSome(environment.appImagePath)
        ? fileSystem.exists(appImageIcon).pipe(
            Effect.map((found) => (found ? Option.some(appImageIcon) : Option.none<string>())),
            Effect.orElseSucceed(() => Option.none<string>()),
          )
        : Effect.succeed(iconPaths.png);

  // Shim launchers need the packaged app on macOS with Electron's loader inside it. The
  // bundle id and minimum macOS come from the app's own plist, so every channel matches.
  const appShim = yield* Effect.gen(function* () {
    if (environment.platform !== "darwin" || !environment.isPackaged) return Option.none();
    const contents = environment.path.resolve(environment.resourcesPath, "..");
    const hostAppPath = environment.path.resolve(contents, "..");
    const loaderPath = environment.path.join(contents, ...SHIM_LOADER_PATH);
    if (!hostAppPath.endsWith(".app")) return Option.none();
    if (!(yield* fileSystem.exists(loaderPath).pipe(Effect.orElseSucceed(() => false)))) {
      yield* logInfo("this build has no app shim loader; installed pages use script launchers");
      return Option.none();
    }
    const plist = yield* fileSystem
      .readFileString(environment.path.join(contents, "Info.plist"))
      .pipe(Effect.orElseSucceed(() => ""));
    const hostBundleId = plistString(plist, "CFBundleIdentifier");
    if (Option.isNone(hostBundleId)) return Option.none();
    return Option.some({
      loaderPath,
      hostAppPath,
      hostBundleId: hostBundleId.value,
      serverName: artifactAppShimServerName(hostBundleId.value),
      minimumSystemVersion: Option.getOrElse(
        plistString(plist, "LSMinimumSystemVersion"),
        () => "12.0",
      ),
    } satisfies ArtifactAppShimConfig);
  });

  // Runs codesign and keeps what it printed on stderr, where it writes its details.
  const codesign = (args: ReadonlyArray<string>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make("/usr/bin/codesign", args, { stdin: "ignore" }),
        );
        const [, details, exitCode] = yield* Effect.all(
          [
            handle.stdout.pipe(Stream.runDrain),
            handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
            handle.exitCode,
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.timeout(COMMAND_TIMEOUT));
        return { details, exitCode: Number(exitCode) };
      }),
    );

  // `codesign -d` reports the hash the signature claims even after the executable was
  // changed, so the bundle is verified against its signature first.
  const readCdHash = (bundlePath: string) =>
    Effect.gen(function* () {
      const verified = yield* codesign(["--verify", "--strict", bundlePath]);
      if (verified.exitCode !== 0) {
        return yield* new ArtifactAppHostCommandError({
          command: "codesign-read",
          exitCode: verified.exitCode,
        });
      }
      const { details, exitCode } = yield* codesign(["-d", "-vvv", bundlePath]);
      const cdHash = parseCdHash(details);
      if (exitCode !== 0 || Option.isNone(cdHash)) {
        return yield* new ArtifactAppHostCommandError({ command: "codesign-read", exitCode });
      }
      return cdHash.value;
    }).pipe(
      Effect.mapError((error) =>
        isHostCommandError(error)
          ? error
          : new ArtifactAppHostCommandError({ command: "codesign-read", cause: error }),
      ),
    );

  return ArtifactAppInstallerHost.of({
    platform: environment.platform,
    displayName: environment.displayName,
    scheme: getDesktopScheme(environment.isDevelopment),
    bundleIdPrefix: environment.appUserModelId,
    appUserModelId: environment.appUserModelId,
    linuxApplicationsDir: environment.linuxApplicationsDir,
    // As for the URL scheme: the packaged app starts itself; Electron in development needs the app folder.
    windowsExecutable: {
      path: process.execPath,
      leadingArgs: environment.isPackaged ? [] : [environment.appPath],
    },
    folders: Effect.sync(() => ({
      home: Electron.app.getPath("home"),
      appData: Electron.app.getPath("appData"),
      desktop: Electron.app.getPath("desktop"),
    })),
    installedAppNames,
    icons: linuxIcon.pipe(
      Effect.map((linux) => ({
        macIcns: iconPaths.icns,
        // The packaged executable carries the app icon; development points at the source icon.
        windowsIcon: environment.isPackaged ? Option.some(process.execPath) : iconPaths.ico,
        linuxIcon: linux,
      })),
    ),
    showMessageBox: (owner, options) =>
      Effect.promise(() =>
        (Option.isSome(owner) && !owner.value.isDestroyed()
          ? Electron.dialog.showMessageBox(owner.value, options)
          : Electron.dialog.showMessageBox(options)
        ).then(
          (result) => result.response,
          () => options.cancelId ?? -1,
        ),
      ),
    codesign: (bundlePath) =>
      Effect.gen(function* () {
        const codesignPath = "/usr/bin/codesign";
        if (!(yield* fileSystem.exists(codesignPath).pipe(Effect.orElseSucceed(() => false)))) {
          return yield* new ArtifactAppHostCommandError({ command: "codesign" });
        }
        yield* runCommand(
          "codesign",
          ["--force", "--sign", "-", "--timestamp=none", bundlePath],
          codesignPath,
        );
      }),
    appShim,
    readCdHash,
    openApp: (bundlePath) =>
      Effect.promise(() => Electron.shell.openPath(bundlePath)).pipe(
        Effect.flatMap((error) =>
          error === "" ? Effect.void : logWarning("installed page app did not start", { error }),
        ),
      ),
    refreshLinuxApplications: (directory) => runCommand("update-desktop-database", [directory]),
    writeShortcutLink: (shortcutPath, options) =>
      Effect.sync(() => {
        try {
          return Electron.shell.writeShortcutLink(shortcutPath, "create", options);
        } catch {
          return false;
        }
      }),
    readShortcut: (shortcutPath) =>
      Effect.sync(() => {
        try {
          const shortcut = Electron.shell.readShortcutLink(shortcutPath);
          return Option.some({
            target: shortcut.target,
            args: shortcut.args ?? "",
            appUserModelId: shortcut.appUserModelId ?? "",
          });
        } catch {
          return Option.none<ArtifactAppShortcutReadBack>();
        }
      }),
    trashItem: (path) =>
      Effect.tryPromise({
        try: () => Electron.shell.trashItem(path),
        catch: (cause) => new ArtifactAppTrashError({ path, cause }),
      }),
    // A page's own app is the active one when its menu asks for Finder, and macOS does not let
    // a background app bring Finder forward: Finder would select the launcher behind the page.
    // `open -R` asks Launch Services, which does bring it forward.
    showItemInFolder: (path) =>
      environment.platform === "darwin"
        ? runCommand("open", ["-R", path], "/usr/bin/open").pipe(
            Effect.catch(() => Effect.sync(() => Electron.shell.showItemInFolder(path))),
          )
        : Effect.sync(() => Electron.shell.showItemInFolder(path)),
  });
});

/** The installer's host backed by Electron, the app's assets and the system's commands. */
export const layerElectronHost = Layer.effect(ArtifactAppInstallerHost, makeElectronHost);
