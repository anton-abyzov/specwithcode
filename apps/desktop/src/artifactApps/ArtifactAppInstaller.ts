// @effect-diagnostics nodeBuiltinImport:off - Launcher paths follow the target platform's rules (path.posix or path.win32), so tests can install for any OS in a private temp home.
/**
 * Installs a published page as an app: asks the person, writes the launcher
 * the operating system shows (a macOS app bundle, Windows shortcuts or a
 * Linux desktop entry), records the install and opens its window. Uninstall
 * and reveal find the launcher again from the record through the same
 * generators, never by joining a recorded name into a path by hand.
 */
import * as NodePath from "node:path";

import type {
  DesktopArtifactApp,
  DesktopArtifactAppInstallInput,
  DesktopArtifactAppInstallResult,
} from "@specweave-studio/contracts";
import { HostProcessEnvironment } from "@specweave-studio/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Electron from "electron";

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import { getDesktopScheme } from "../electron/ElectronProtocol.ts";
import {
  artifactAppInstallFolders,
  linuxArtifactAppDesktopEntry,
  macArtifactAppBundle,
  windowsArtifactAppShortcut,
  type LauncherFile,
} from "./ArtifactAppLaunchers.ts";
import { resolveArtifactAppName } from "./ArtifactAppName.ts";
import * as ArtifactAppGrants from "./ArtifactAppGrants.ts";
import * as ArtifactAppRecords from "./ArtifactAppRecords.ts";
import {
  artifactAppLaunchUrl,
  artifactAppUserModelId,
  isArtifactAppInstallId,
  newArtifactAppInstallId,
} from "./ArtifactAppUrl.ts";
import * as ArtifactAppWindows from "./ArtifactAppWindows.ts";

const { logInfo, logWarning } = makeComponentLogger("desktop-artifact-app-installer");

const FOLDER_MODE = 0o755;
const LINUX_ENTRY_MODE = 0o644;
const ICON_MODE = 0o644;
const COMMAND_TIMEOUT = "20 seconds";
// oxlint-disable-next-line no-control-regex -- Arguments written into a shortcut must not carry quotes or control characters.
const UNSAFE_SHORTCUT_ARGUMENT = /["\u0000-\u001f\u007f]/u;

class ArtifactAppInstallFolderUnsafeError extends Schema.TaggedError<ArtifactAppInstallFolderUnsafeError>()(
  "ArtifactAppInstallFolderUnsafeError",
  {
    path: Schema.String,
    reason: Schema.Literals(["symbolic-link", "not-a-folder"]),
  },
) {
  override get message(): string {
    return `The installed pages folder at ${this.path} is a ${this.reason === "symbolic-link" ? "symbolic link" : "file, not a folder"}.`;
  }
}

class ArtifactAppNameUnavailableError extends Schema.TaggedError<ArtifactAppNameUnavailableError>()(
  "ArtifactAppNameUnavailableError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "No free app name is left for this page title.";
  }
}

class ArtifactAppLauncherWriteError extends Schema.TaggedError<ArtifactAppLauncherWriteError>()(
  "ArtifactAppLauncherWriteError",
  {
    operation: Schema.Literals([
      "read-folder",
      "create-folder",
      "target-exists",
      "write-file",
      "copy-icon",
      "set-mode",
      "move-into-place",
      "write-shortcut",
      "remove-launcher",
      "read-launcher",
    ]),
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Installed page launcher step ${this.operation} failed at ${this.path}.`;
  }
}

class ArtifactAppHostCommandError extends Schema.TaggedError<ArtifactAppHostCommandError>()(
  "ArtifactAppHostCommandError",
  {
    command: Schema.Literals(["codesign", "update-desktop-database"]),
    exitCode: Schema.optionalKey(Schema.Number),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    const exit = this.exitCode === undefined ? "" : ` with exit code ${this.exitCode}`;
    return `${this.command} failed${exit}.`;
  }
}

const isHostCommandError = Schema.is(ArtifactAppHostCommandError);

class ArtifactAppTrashError extends Schema.TaggedError<ArtifactAppTrashError>()(
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
>()("@specweave-studio/desktop/artifactApps/ArtifactAppInstaller/ArtifactAppInstallerHost") {}

/** The fields of a Windows shortcut that decide what it starts. */
export interface ArtifactAppShortcutReadBack {
  readonly target: string;
  readonly args: string;
  readonly appUserModelId: string;
}

export interface ArtifactAppInstallOptions {
  /** The window that asked; the confirmation is attached to it. */
  readonly owner?: Option.Option<Electron.BrowserWindow>;
}

export class ArtifactAppInstaller extends Context.Service<
  ArtifactAppInstaller,
  {
    readonly install: (
      input: DesktopArtifactAppInstallInput,
      options?: ArtifactAppInstallOptions,
    ) => Effect.Effect<DesktopArtifactAppInstallResult>;
    /** Removes the launcher, forgets the install and closes its window; false when nothing was removed. */
    readonly uninstall: (installId: string) => Effect.Effect<boolean>;
    /** Shows the launcher in the file manager; false when it is gone. */
    readonly reveal: (installId: string) => Effect.Effect<boolean>;
  }
>()("@specweave-studio/desktop/artifactApps/ArtifactAppInstaller") {}

/** The native confirmation; Cancel is the default and the answer to Escape. */
export function artifactAppInstallConfirmation(name: string): Electron.MessageBoxOptions {
  return {
    type: "question",
    message: `Install ${name} as an app?`,
    detail:
      "It gets its own icon and window and always shows the newest version of this page. It can't reach your files or run programs.",
    buttons: ["Install", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
}

const GENERIC_FAILURE = "SpecWithCode could not install this page as an app. Try again.";

type LauncherLocation =
  | {
      readonly kind: "mac-bundle";
      readonly folder: string;
      readonly path: string;
      readonly files: ReadonlyArray<LauncherFile>;
    }
  | {
      readonly kind: "windows-shortcuts";
      readonly folder: string;
      readonly path: string;
      readonly desktopPath: string | null;
      readonly options: Electron.ShortcutDetails;
    }
  | {
      readonly kind: "linux-entry";
      readonly folder: string;
      readonly path: string;
      readonly contents: string;
    };

interface LauncherContext {
  readonly platform: NodeJS.Platform;
  readonly folders: ArtifactAppHostFolders;
  readonly icons: ArtifactAppHostIcons;
}

function pathRules(platform: NodeJS.Platform): NodePath.PlatformPath {
  return platform === "win32" ? NodePath.win32 : NodePath.posix;
}

function withoutIconLine(entry: string): string {
  return entry
    .split("\n")
    .filter((line) => !line.startsWith("Icon="))
    .join("\n");
}

const make = Effect.gen(function* () {
  const host = yield* ArtifactAppInstallerHost;
  const fileSystem = yield* FileSystem.FileSystem;
  const records = yield* ArtifactAppRecords.ArtifactAppRecords;
  const grants = yield* ArtifactAppGrants.ArtifactAppGrants;
  const windows = yield* ArtifactAppWindows.ArtifactAppWindows;
  // One install at a time, so the same page asked twice cannot be installed twice.
  const installLock = yield* Semaphore.make(1);
  const rules = pathRules(host.platform);

  const launcherContext = Effect.gen(function* () {
    return {
      platform: host.platform,
      folders: yield* host.folders,
      icons: yield* host.icons,
    } satisfies LauncherContext;
  });

  const appsFolders = (context: LauncherContext) =>
    artifactAppInstallFolders({
      platform: context.platform,
      homeDir: context.folders.home,
      appDataDir: context.folders.appData,
      desktopDir: context.folders.desktop,
      displayName: host.displayName,
    });

  // Throws when the name or id is not one a generator accepts (a hand-edited record).
  const locateLauncher = (
    app: Pick<DesktopArtifactApp, "installId" | "name">,
    context: LauncherContext,
  ): LauncherLocation => {
    const launchUrl = artifactAppLaunchUrl(host.scheme, app.installId);
    if (context.platform === "darwin") {
      const folder = appsFolders(context).primary;
      const bundle = macArtifactAppBundle({
        installId: app.installId,
        name: app.name,
        launchUrl,
        bundleIdPrefix: host.bundleIdPrefix,
      });
      return {
        kind: "mac-bundle",
        folder,
        path: rules.join(folder, bundle.bundleName),
        files: bundle.files,
      };
    }
    if (context.platform === "win32") {
      const folders = appsFolders(context);
      const shortcut = windowsArtifactAppShortcut({
        installId: app.installId,
        name: app.name,
        launchUrl,
        executablePath: host.windowsExecutable.path,
        iconPath: Option.getOrNull(context.icons.windowsIcon),
        appUserModelId: artifactAppUserModelId(host.appUserModelId, app.installId),
      });
      for (const argument of host.windowsExecutable.leadingArgs) {
        if (UNSAFE_SHORTCUT_ARGUMENT.test(argument)) {
          throw new Error("Invalid shortcut argument.");
        }
      }
      const args = [
        ...host.windowsExecutable.leadingArgs.map((argument) => `"${argument}"`),
        shortcut.options.args,
      ].join(" ");
      return {
        kind: "windows-shortcuts",
        folder: folders.primary,
        path: rules.join(folders.primary, shortcut.fileName),
        desktopPath:
          folders.desktop === null ? null : rules.join(folders.desktop, shortcut.fileName),
        options: { ...shortcut.options, args },
      };
    }
    const entry = linuxArtifactAppDesktopEntry({
      installId: app.installId,
      name: app.name,
      launchUrl,
      iconPath: Option.getOrNull(context.icons.linuxIcon),
    });
    return {
      kind: "linux-entry",
      folder: host.linuxApplicationsDir,
      path: rules.join(host.linuxApplicationsDir, entry.fileName),
      contents: entry.contents,
    };
  };

  const locateRecorded = (app: DesktopArtifactApp, context: LauncherContext) =>
    Effect.suspend(() => {
      try {
        return Effect.succeedSome(locateLauncher(app, context));
      } catch {
        return logWarning("installed page record does not name a valid launcher", {
          installId: app.installId,
        }).pipe(Effect.as(Option.none<LauncherLocation>()));
      }
    });

  const writeError =
    (operation: ArtifactAppLauncherWriteError["operation"], path: string) => (cause: unknown) =>
      new ArtifactAppLauncherWriteError({ operation, path, cause });

  const isNotFound = (error: { readonly reason: { readonly _tag: string } }) =>
    error.reason._tag === "NotFound";

  // A missing file reads as null (not this install's); any other read error
  // fails, so a file that cannot be read is never taken for someone else's.
  const readOrMissing =
    (path: string) =>
    <A>(read: Effect.Effect<A, PlatformError.PlatformError>) =>
      read.pipe(
        Effect.catchTags({
          PlatformError: (error) => (isNotFound(error) ? Effect.succeed(null) : Effect.fail(error)),
        }),
        Effect.mapError(writeError("read-launcher", path)),
      );

  // Only a missing path is absent: a folder that cannot be searched fails, so a
  // launcher behind it is never taken for gone.
  const exists = (path: string) =>
    fileSystem.exists(path).pipe(Effect.mapError(writeError("read-launcher", path)));

  const isSymbolicLink = (path: string) =>
    fileSystem.readLink(path).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );

  /**
   * Whether the file at a launcher path is this install's own launcher: not a
   * link, in a folder that is not a link, and naming the install's random id.
   * Uninstall and reveal act only on such a file, so a file that took the
   * launcher's place (another app, a moved folder) is never touched.
   */
  const launcherPathOwned = Effect.fn("desktop.artifactApps.launcherPathOwned")(function* (
    location: LauncherLocation,
    path: string,
    installId: string,
  ) {
    // The folder this path is in: the Start menu and the Desktop shortcut each have their own.
    if (yield* isSymbolicLink(rules.dirname(path))) return false;
    if (yield* isSymbolicLink(path)) return false;
    if (!(yield* exists(path))) return false;
    switch (location.kind) {
      case "mac-bundle": {
        // The bundle is this install's only while every text file it wrote
        // (the Info.plist naming the executable, the launcher script) is still
        // exactly what was written, and nothing inside it is a link. A bundle
        // pointed at another program or through a linked folder is left alone.
        const texts = location.files.filter((file) => file.kind === "text");
        if (!texts.some((file) => file.contents.includes(installId))) return false;
        for (const file of texts) {
          const parts = file.relativePath.split("/");
          let current = path;
          for (const part of parts) {
            current = rules.join(current, part);
            if (yield* isSymbolicLink(current)) return false;
          }
          const onDisk = yield* fileSystem.readFileString(current).pipe(readOrMissing(current));
          if (onDisk !== file.contents) return false;
        }
        return true;
      }
      case "windows-shortcuts":
        // It must still start this app with this install's URL and identity.
        return Option.match(yield* host.readShortcut(path), {
          onNone: () => false,
          onSome: (shortcut) =>
            shortcut.target.toLowerCase() === location.options.target.toLowerCase() &&
            shortcut.args === (location.options.args ?? "") &&
            shortcut.appUserModelId === (location.options.appUserModelId ?? ""),
        });
      case "linux-entry": {
        // Exactly the entry this install wrote, so an Exec pointed elsewhere is
        // not it. The Icon line is left out: the app's icon can move between
        // versions while the entry stays this install's.
        const onDisk = yield* fileSystem.readFileString(path).pipe(readOrMissing(path));
        return onDisk !== null && withoutIconLine(onDisk) === withoutIconLine(location.contents);
      }
    }
  });

  // Names already used in a folder, so a new launcher never replaces someone's file.
  const namesInFolder = (folder: string | null, extension: string) =>
    folder === null
      ? Effect.succeed<ReadonlyArray<string>>([])
      : fileSystem.readDirectory(folder).pipe(
          Effect.map((entries) =>
            entries
              .filter((entry) => entry.toLowerCase().endsWith(extension))
              .map((entry) => entry.slice(0, -extension.length)),
          ),
          Effect.orElseSucceed((): ReadonlyArray<string> => []),
        );

  const takenNamesOnDisk = (context: LauncherContext) => {
    if (context.platform === "darwin") return namesInFolder(appsFolders(context).primary, ".app");
    if (context.platform === "win32") {
      const folders = appsFolders(context);
      return Effect.all([
        namesInFolder(folders.primary, ".lnk"),
        namesInFolder(folders.desktop, ".lnk"),
      ]).pipe(Effect.map(([start, desktop]) => [...start, ...desktop]));
    }
    return Effect.succeed<ReadonlyArray<string>>([]);
  };

  // The folder this app owns: created 0755 when missing, refused when it is a link or a file.
  const ensureOwnedFolder = Effect.fn("desktop.artifactApps.ensureFolder")(function* (
    folder: string,
  ) {
    const isLink = yield* fileSystem.readLink(folder).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (isLink) {
      return yield* new ArtifactAppInstallFolderUnsafeError({
        path: folder,
        reason: "symbolic-link",
      });
    }
    if (yield* exists(folder)) {
      const info = yield* fileSystem
        .stat(folder)
        .pipe(Effect.mapError(writeError("read-folder", folder)));
      if (info.type !== "Directory") {
        return yield* new ArtifactAppInstallFolderUnsafeError({
          path: folder,
          reason: "not-a-folder",
        });
      }
      return;
    }
    yield* fileSystem
      .makeDirectory(folder, { recursive: true, mode: FOLDER_MODE })
      .pipe(
        Effect.andThen(fileSystem.chmod(folder, FOLDER_MODE)),
        Effect.mapError(writeError("create-folder", folder)),
      );
  });

  const refuseExisting = (path: string) =>
    Effect.gen(function* () {
      if (yield* exists(path)) {
        return yield* new ArtifactAppLauncherWriteError({
          operation: "target-exists",
          path,
          cause: new Error("A file with the launcher's name already exists."),
        });
      }
    });

  const writeMacBundle = Effect.fn("desktop.artifactApps.writeMacBundle")(function* (
    location: Extract<LauncherLocation, { kind: "mac-bundle" }>,
    installId: string,
    icons: ArtifactAppHostIcons,
  ) {
    yield* ensureOwnedFolder(location.folder);
    yield* refuseExisting(location.path);
    // Built beside the folder and moved in whole, so Finder never shows a half-written app.
    const staging = rules.join(
      rules.dirname(location.folder),
      `.${host.displayName} Apps staging ${installId}`,
    );
    const stagedBundle = rules.join(staging, rules.basename(location.path));
    const build = Effect.gen(function* () {
      yield* fileSystem
        .makeDirectory(stagedBundle, { recursive: true, mode: FOLDER_MODE })
        .pipe(Effect.mapError(writeError("create-folder", stagedBundle)));
      const directories = new Set<string>([stagedBundle]);
      for (const file of location.files) {
        const target = rules.join(stagedBundle, file.relativePath);
        const directory = rules.dirname(target);
        directories.add(directory);
        yield* fileSystem
          .makeDirectory(directory, { recursive: true, mode: FOLDER_MODE })
          .pipe(Effect.mapError(writeError("create-folder", directory)));
        if (file.kind === "text") {
          yield* fileSystem
            .writeFileString(target, file.contents, { mode: file.mode })
            .pipe(Effect.mapError(writeError("write-file", target)));
          // The create mode is masked by the umask; the launcher must end up executable.
          yield* fileSystem
            .chmod(target, file.mode)
            .pipe(Effect.mapError(writeError("set-mode", target)));
        } else if (Option.isSome(icons.macIcns)) {
          yield* fileSystem
            .copyFile(icons.macIcns.value, target)
            .pipe(
              Effect.andThen(fileSystem.chmod(target, ICON_MODE)),
              Effect.mapError(writeError("copy-icon", target)),
            );
        }
      }
      for (const directory of directories) {
        yield* fileSystem
          .chmod(directory, FOLDER_MODE)
          .pipe(Effect.mapError(writeError("set-mode", directory)));
      }
      // Ad-hoc signing keeps Gatekeeper from calling the bundle damaged; an unsigned one still opens.
      yield* host.codesign(stagedBundle).pipe(
        Effect.catchTags({
          ArtifactAppHostCommandError: (error) =>
            logWarning("installed page bundle was not signed", { error: error.message }),
        }),
      );
      yield* fileSystem
        .rename(stagedBundle, location.path)
        .pipe(Effect.mapError(writeError("move-into-place", location.path)));
    });
    yield* build.pipe(
      Effect.ensuring(
        fileSystem.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore),
      ),
    );
  });

  const writeWindowsShortcuts = Effect.fn("desktop.artifactApps.writeWindowsShortcuts")(function* (
    location: Extract<LauncherLocation, { kind: "windows-shortcuts" }>,
  ) {
    yield* ensureOwnedFolder(location.folder);
    // writeShortcutLink replaces an existing file, so a taken name is refused first.
    yield* refuseExisting(location.path);
    if (location.desktopPath !== null) yield* refuseExisting(location.desktopPath);
    if (!(yield* host.writeShortcutLink(location.path, location.options))) {
      return yield* new ArtifactAppLauncherWriteError({
        operation: "write-shortcut",
        path: location.path,
        cause: new Error("Windows did not create the shortcut."),
      });
    }
    if (
      location.desktopPath !== null &&
      !(yield* host.writeShortcutLink(location.desktopPath, location.options))
    ) {
      // The Start menu shortcut is the launcher; the Desktop copy is a convenience.
      yield* logWarning("installed page Desktop shortcut was not created");
    }
  });

  const refreshLinux = (directory: string) =>
    host.refreshLinuxApplications(directory).pipe(
      Effect.catchTags({
        ArtifactAppHostCommandError: (error) =>
          logInfo("desktop entry cache was not refreshed", { error: error.message }),
      }),
    );

  const writeLinuxEntry = Effect.fn("desktop.artifactApps.writeLinuxEntry")(function* (
    location: Extract<LauncherLocation, { kind: "linux-entry" }>,
  ) {
    yield* fileSystem
      .makeDirectory(location.folder, { recursive: true })
      .pipe(Effect.mapError(writeError("create-folder", location.folder)));
    yield* refuseExisting(location.path);
    // Written under another name and renamed, so a launcher menu never reads half an entry.
    const temporary = `${location.path}.tmp`;
    yield* fileSystem
      .writeFileString(temporary, location.contents, { mode: LINUX_ENTRY_MODE })
      .pipe(
        Effect.andThen(fileSystem.chmod(temporary, LINUX_ENTRY_MODE)),
        Effect.andThen(fileSystem.rename(temporary, location.path)),
        Effect.mapError(writeError("write-file", location.path)),
        Effect.tapError(() => fileSystem.remove(temporary, { force: true }).pipe(Effect.ignore)),
      );
    yield* refreshLinux(location.folder);
  });

  const writeLauncher = (
    location: LauncherLocation,
    installId: string,
    icons: ArtifactAppHostIcons,
  ) => {
    switch (location.kind) {
      case "mac-bundle":
        return writeMacBundle(location, installId, icons);
      case "windows-shortcuts":
        return writeWindowsShortcuts(location);
      case "linux-entry":
        return writeLinuxEntry(location);
    }
  };

  const removeFile = (path: string) =>
    fileSystem.remove(path).pipe(
      Effect.catchTags({
        PlatformError: (error) => (isNotFound(error) ? Effect.void : Effect.fail(error)),
      }),
      Effect.mapError(writeError("remove-launcher", path)),
    );

  /**
   * Copies of a macOS bundle a failed Trash left under a private removal name:
   * exactly `.<name>.app.removing-<installId>.<32 hex>`, nothing looser, so another
   * install's copies never block this one. A folder that
   * cannot be listed fails, so a pending removal is never mistaken for none.
   */
  const pendingRemovals = (location: LauncherLocation, installId: string) =>
    Effect.gen(function* () {
      if (location.kind !== "mac-bundle") return [] as ReadonlyArray<string>;
      const prefix = `.${rules.basename(location.path)}.removing-${installId}.`;
      const entries = yield* fileSystem.readDirectory(location.folder).pipe(
        Effect.catchTags({
          PlatformError: (error) =>
            isNotFound(error) ? Effect.succeed<ReadonlyArray<string>>([]) : Effect.fail(error),
        }),
        Effect.mapError(writeError("remove-launcher", location.folder)),
      );
      return entries
        .filter(
          (entry) => entry.startsWith(prefix) && /^[0-9a-f]{32}$/.test(entry.slice(prefix.length)),
        )
        .map((entry) => rules.join(location.folder, entry));
    });

  // Removes only what is still this install's launcher; anything else at the path is left alone.
  const removeLauncher = (location: LauncherLocation, installId: string) =>
    Effect.gen(function* () {
      const owned = (path: string) =>
        launcherPathOwned(location, path, installId).pipe(
          Effect.tap((isOwned) =>
            isOwned
              ? Effect.void
              : logInfo("left a file that is not this page's launcher", { installId }),
          ),
        );
      switch (location.kind) {
        case "mac-bundle": {
          // A bundle is moved to a private name, checked again there and
          // trashed from there, so nothing can take its place in between. It
          // is never moved back: whatever appears at the old path is left
          // alone. A copy a failed Trash left under a private name is found
          // and trashed by the next uninstall, and its record stays until then.
          const prefix = `.${rules.basename(location.path)}.removing-${installId}.`;
          const candidates = [...(yield* pendingRemovals(location, installId))];
          if (yield* owned(location.path)) {
            const claimed = rules.join(location.folder, `${prefix}${newArtifactAppInstallId()}`);
            // A random name nothing uses yet: a rename over an empty folder would replace it.
            if (yield* exists(claimed)) {
              return yield* new ArtifactAppLauncherWriteError({
                operation: "remove-launcher",
                path: claimed,
                cause: new Error("The private name for removal is taken."),
              });
            }
            yield* fileSystem
              .rename(location.path, claimed)
              .pipe(Effect.mapError(writeError("remove-launcher", location.path)));
            candidates.push(claimed);
          }
          for (const candidate of candidates) {
            // Anything under the private name that is not exactly this install's bundle stays.
            if (yield* launcherPathOwned(location, candidate, installId)) {
              yield* host.trashItem(candidate);
            }
          }
          return;
        }
        case "windows-shortcuts":
          if (yield* owned(location.path)) yield* removeFile(location.path);
          if (location.desktopPath !== null && (yield* owned(location.desktopPath))) {
            yield* removeFile(location.desktopPath);
          }
          return;
        case "linux-entry":
          if (yield* owned(location.path)) {
            yield* removeFile(location.path);
            yield* refreshLinux(location.folder);
          }
          return;
      }
    });

  const sameInstall = (app: DesktopArtifactApp, input: DesktopArtifactAppInstallInput) =>
    app.environmentId === input.environmentId &&
    app.threadId === input.threadId &&
    app.title === input.title;

  const installUnlocked = Effect.fn("desktop.artifactApps.install")(function* (
    input: DesktopArtifactAppInstallInput,
    owner: Option.Option<Electron.BrowserWindow>,
  ) {
    const context = yield* launcherContext;
    const existing = (yield* records.list).find((app) => sameInstall(app, input));
    if (existing !== undefined) {
      const location = yield* locateRecorded(existing, context);
      if (
        Option.isSome(location) &&
        (yield* launcherPathOwned(location.value, location.value.path, existing.installId))
      ) {
        yield* windows.open(existing.installId);
        return { status: "already-installed", app: existing } as const;
      }
      // A removal a failed Trash left pending is finished first; when it cannot
      // be, the install fails and the record stays for uninstall to retry.
      if (
        Option.isSome(location) &&
        (yield* pendingRemovals(location.value, existing.installId)).length > 0
      ) {
        yield* removeLauncher(location.value, existing.installId);
        if ((yield* pendingRemovals(location.value, existing.installId)).length > 0) {
          return failed("This page's earlier app is still being removed. Try again.");
        }
      }
      // The launcher was deleted or replaced by hand: forget the stale record and install again.
      yield* logInfo("forgetting an install whose launcher is gone", {
        installId: existing.installId,
      });
      yield* records.remove(existing.installId);
      yield* windows.close(existing.installId);
    }

    const takenNames = [
      ...(yield* records.list).map((app) => app.name),
      ...(yield* takenNamesOnDisk(context)),
    ];
    const reservedNames = yield* host.installedAppNames;
    const name = yield* Effect.try({
      try: () => resolveArtifactAppName({ title: input.title, reservedNames, takenNames }),
      catch: (cause) => new ArtifactAppNameUnavailableError({ cause }),
    });
    const choice = yield* host.showMessageBox(owner, artifactAppInstallConfirmation(name));
    if (choice !== 0) return { status: "cancelled" } as const;

    const installId = newArtifactAppInstallId();
    const location = locateLauncher({ installId, name }, context);
    yield* writeLauncher(location, installId, context.icons);
    const app: DesktopArtifactApp = {
      installId,
      name,
      environmentId: input.environmentId,
      threadId: input.threadId,
      attachmentId: input.attachmentId,
      title: input.title,
      installedAt: DateTime.formatIso(yield* DateTime.now),
    };
    // A launcher without a record opens nothing, so it is taken back when the record fails.
    yield* records
      .add(app)
      .pipe(Effect.tapError(() => removeLauncher(location, installId).pipe(Effect.ignore)));
    yield* logInfo("installed page", { installId, platform: host.platform });
    const opened = yield* windows.open(installId);
    if (opened !== "opened" && opened !== "focused") {
      yield* logWarning("installed page window did not open", { installId, result: opened });
    }
    return { status: "installed", app } as const;
  });

  const failed = (message: string) => ({ status: "failed", message }) as const;

  const install: ArtifactAppInstaller["Service"]["install"] = (input, options) =>
    installLock
      .withPermits(1)(installUnlocked(input, options?.owner ?? Option.none()))
      .pipe(
        Effect.catchTags({
          ArtifactAppInstallFolderUnsafeError: (error) =>
            logWarning("installed pages folder is not a plain folder", {
              reason: error.reason,
            }).pipe(
              Effect.as(
                failed(
                  `The ${host.displayName} Apps folder is a link or a file, so the page was not installed.`,
                ),
              ),
            ),
          ArtifactAppNameUnavailableError: () =>
            Effect.succeed(
              failed(
                "Too many installed pages already use this name. Uninstall one or rename the page, then try again.",
              ),
            ),
        }),
        Effect.catchCause((cause) =>
          logWarning("installed page install failed", { cause: Cause.pretty(cause) }).pipe(
            Effect.as(failed(GENERIC_FAILURE)),
          ),
        ),
      );

  const uninstall = Effect.fn("desktop.artifactApps.uninstall")(function* (installId: string) {
    if (!isArtifactAppInstallId(installId)) return false;
    const app = yield* records.get(installId);
    if (Option.isNone(app)) return false;
    const location = yield* locateRecorded(app.value, yield* launcherContext);
    if (Option.isSome(location)) {
      // A launcher that could not be removed keeps its record, so uninstall can be tried again.
      yield* removeLauncher(location.value, installId);
      // A copy still under a private removal name (one this pass could not
      // read or trash) keeps the record too: the install is not gone yet.
      if ((yield* pendingRemovals(location.value, installId)).length > 0) {
        yield* logWarning("installed page removal is still pending", { installId });
        return false;
      }
    }
    yield* records.remove(installId);
    // The install is gone and its id is never used again; its answers go with it. A failure
    // here leaves answers nothing can use: every power needs a recorded install.
    yield* grants.forget(installId).pipe(
      Effect.catchCause((cause) =>
        logWarning("installed page grants could not be forgotten", {
          installId,
          cause: Cause.pretty(cause),
        }),
      ),
    );
    yield* windows.close(installId);
    yield* logInfo("uninstalled page", { installId });
    return true;
  });

  const reveal = Effect.fn("desktop.artifactApps.reveal")(function* (installId: string) {
    if (!isArtifactAppInstallId(installId)) return false;
    const app = yield* records.get(installId);
    if (Option.isNone(app)) return false;
    const location = yield* locateRecorded(app.value, yield* launcherContext);
    if (
      Option.isNone(location) ||
      !(yield* launcherPathOwned(location.value, location.value.path, installId))
    ) {
      return false;
    }
    yield* host.showItemInFolder(location.value.path);
    return true;
  });

  return ArtifactAppInstaller.of({
    install,
    // One install or uninstall at a time, so two never race over one launcher.
    uninstall: (installId) =>
      installLock
        .withPermits(1)(uninstall(installId))
        .pipe(
          Effect.catchCause((cause) =>
            logWarning("installed page uninstall failed", { cause: Cause.pretty(cause) }).pipe(
              Effect.as(false),
            ),
          ),
        ),
    reveal: (installId) =>
      reveal(installId).pipe(
        Effect.catchCause((cause) =>
          logWarning("installed page reveal failed", { cause: Cause.pretty(cause) }).pipe(
            Effect.as(false),
          ),
        ),
      ),
  });
});

export const layer = Layer.effect(ArtifactAppInstaller, make);

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
    showItemInFolder: (path) => Effect.sync(() => Electron.shell.showItemInFolder(path)),
  });
});

/** The installer's host backed by Electron, the app's assets and the system's commands. */
export const layerElectronHost = Layer.effect(ArtifactAppInstallerHost, makeElectronHost);
