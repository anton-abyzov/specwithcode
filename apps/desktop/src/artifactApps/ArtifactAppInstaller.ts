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
import * as Electron from "electron";

import { makeComponentLogger } from "../app/DesktopObservability.ts";
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
import * as ArtifactAppShimRecords from "./ArtifactAppShimRecords.ts";
import {
  artifactAppLaunchUrl,
  artifactAppUserModelId,
  isArtifactAppInstallId,
  newArtifactAppInstallId,
} from "./ArtifactAppUrl.ts";
import {
  ArtifactAppInstallerHost,
  type ArtifactAppHostFolders,
  type ArtifactAppHostIcons,
} from "./ArtifactAppInstallerHost.ts";
import * as ArtifactAppWindows from "./ArtifactAppWindows.ts";

export {
  ArtifactAppInstallerHost,
  layerElectronHost,
  type ArtifactAppHostFolders,
  type ArtifactAppHostIcons,
  type ArtifactAppShimConfig,
  type ArtifactAppShortcutReadBack,
} from "./ArtifactAppInstallerHost.ts";

const { logInfo, logWarning } = makeComponentLogger("desktop-artifact-app-installer");

const FOLDER_MODE = 0o755;
const LINUX_ENTRY_MODE = 0o644;
const ICON_MODE = 0o644;
const LOADER_MODE = 0o755;
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
      "copy-loader",
    ]),
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Installed page launcher step ${this.operation} failed at ${this.path}.`;
  }
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
    /**
     * The install whose shim launcher is at `bundlePath`, with the code hash it was
     * signed with; none for any other bundle or one that is no longer this install's.
     */
    readonly shimInstallFor: (
      bundlePath: string,
    ) => Effect.Effect<Option.Option<{ readonly installId: string; readonly cdHash: string }>>;
    /**
     * Opens an install the way its launcher does: a shim install starts its app,
     * which connects back; any other opens its window here.
     */
    readonly launch: (installId: string) => Effect.Effect<boolean>;
    /**
     * Rebuilds every owned macOS launcher that is not a shim for the running app as one.
     * Gives, per install it rebuilt from an older shim, that shim's code hash: a shim
     * started before the upgrade still runs it.
     */
    readonly upgradeLaunchers: Effect.Effect<ReadonlyMap<string, string>>;
    /** New installs get script launchers from now on: the shim server did not start. */
    readonly disableShims: Effect.Effect<void>;
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

type LauncherLocationShim = Option.Option<
  Omit<ArtifactAppShimRecords.ArtifactAppShimRecord, "cdHash">
>;

type LauncherLocation =
  | {
      readonly kind: "mac-bundle";
      readonly folder: string;
      readonly path: string;
      readonly files: ReadonlyArray<LauncherFile>;
      /** The shim the bundle was built for; none for a script launcher. */
      readonly shim: LauncherLocationShim;
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

// Lines left out when an entry on disk is compared with this install's: neither
// changes what the entry runs. The icon can move between versions, and entries
// written before page windows had their own identity have no StartupWMClass.
function withoutVolatileLines(entry: string): string {
  return entry
    .split("\n")
    .filter((line) => !line.startsWith("Icon=") && !line.startsWith("StartupWMClass="))
    .join("\n");
}

const make = Effect.gen(function* () {
  const host = yield* ArtifactAppInstallerHost;
  const fileSystem = yield* FileSystem.FileSystem;
  const records = yield* ArtifactAppRecords.ArtifactAppRecords;
  const shimRecords = yield* ArtifactAppShimRecords.ArtifactAppShimRecords;
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

  // What a new macOS launcher is built for now: the running app's shim, when it has one.
  let shimsEnabled = true;
  const shimConfig = Option.map(host.appShim, (config) => ({
    hostAppPath: config.hostAppPath,
    hostBundleId: config.hostBundleId,
    serverName: config.serverName,
    minimumSystemVersion: config.minimumSystemVersion,
  }));
  const currentShim = () => (shimsEnabled ? shimConfig : Option.none());

  // Throws when the name or id is not one a generator accepts (a hand-edited record).
  // A macOS launcher is rebuilt from `shim`, the one it was written for, so an owned
  // bundle is recognised exactly; none means a script launcher.
  const locateLauncher = (
    app: Pick<DesktopArtifactApp, "installId" | "name">,
    context: LauncherContext,
    shim: LauncherLocationShim = Option.none(),
  ): LauncherLocation => {
    const launchUrl = artifactAppLaunchUrl(host.scheme, app.installId);
    if (context.platform === "darwin") {
      const folder = appsFolders(context).primary;
      const bundle = macArtifactAppBundle({
        installId: app.installId,
        name: app.name,
        launchUrl,
        bundleIdPrefix: host.bundleIdPrefix,
        ...Option.match(shim, {
          onNone: () => ({}),
          onSome: (value) => ({
            minimumSystemVersion: value.minimumSystemVersion,
            shim: {
              hostAppPath: value.hostAppPath,
              hostBundleId: value.hostBundleId,
              serverName: value.serverName,
            },
          }),
        }),
      });
      return {
        kind: "mac-bundle",
        folder,
        path: rules.join(folder, bundle.bundleName),
        files: bundle.files,
        shim,
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

  // The shim an install's launcher was written for, from the private shim record.
  const recordedShim = (installId: string) =>
    shimRecords
      .get(installId)
      .pipe(
        Effect.map((record): LauncherLocationShim =>
          Option.map(record, ({ cdHash: _cdHash, ...shim }) => shim),
        ),
      );

  const locateRecorded = (app: DesktopArtifactApp, context: LauncherContext) =>
    Effect.flatMap(recordedShim(app.installId), (shim) => {
      try {
        return Effect.succeedSome(locateLauncher(app, context, shim));
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
        // not it. The Icon and StartupWMClass lines are left out (see
        // withoutVolatileLines) while the entry stays this install's.
        const onDisk = yield* fileSystem.readFileString(path).pipe(readOrMissing(path));
        return (
          onDisk !== null &&
          withoutVolatileLines(onDisk) === withoutVolatileLines(location.contents)
        );
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

  // A private staging folder beside the apps folder, so Finder never shows a half-written app.
  const stagingFolder = (location: { readonly folder: string }, installId: string) =>
    rules.join(rules.dirname(location.folder), `.${host.displayName} Apps staging ${installId}`);

  /**
   * Builds the bundle in `staging` and signs it. A shim bundle must be signed, and
   * its code hash is returned so a connecting shim can be checked against it; a
   * script launcher that could not be signed still opens.
   */
  const buildMacBundle = Effect.fn("desktop.artifactApps.buildMacBundle")(function* (
    location: Extract<LauncherLocation, { kind: "mac-bundle" }>,
    staging: string,
    icons: ArtifactAppHostIcons,
  ) {
    const stagedBundle = rules.join(staging, rules.basename(location.path));
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
      } else if (file.kind === "shim-loader") {
        const loader = Option.map(host.appShim, (config) => config.loaderPath);
        if (Option.isNone(loader)) {
          return yield* new ArtifactAppLauncherWriteError({
            operation: "copy-loader",
            path: target,
            cause: new Error("This build has no app shim loader."),
          });
        }
        yield* fileSystem
          .copyFile(loader.value, target)
          .pipe(
            Effect.andThen(fileSystem.chmod(target, LOADER_MODE)),
            Effect.mapError(writeError("copy-loader", target)),
          );
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
    if (Option.isSome(location.shim)) {
      // The hash covers the plist and the loader; SpecWithCode trusts only a process with it.
      yield* host.codesign(stagedBundle);
      return { stagedBundle, cdHash: Option.some(yield* host.readCdHash(stagedBundle)) };
    }
    // Ad-hoc signing keeps Gatekeeper from calling the bundle damaged; an unsigned one still opens.
    yield* host.codesign(stagedBundle).pipe(
      Effect.catchTags({
        ArtifactAppHostCommandError: (error) =>
          logWarning("installed page bundle was not signed", { error: error.message }),
      }),
    );
    return { stagedBundle, cdHash: Option.none<string>() };
  });

  const writeMacBundle = Effect.fn("desktop.artifactApps.writeMacBundle")(function* (
    location: Extract<LauncherLocation, { kind: "mac-bundle" }>,
    installId: string,
    icons: ArtifactAppHostIcons,
  ) {
    yield* ensureOwnedFolder(location.folder);
    yield* refuseExisting(location.path);
    const staging = stagingFolder(location, installId);
    return yield* Effect.gen(function* () {
      const built = yield* buildMacBundle(location, staging, icons);
      yield* fileSystem
        .rename(built.stagedBundle, location.path)
        .pipe(Effect.mapError(writeError("move-into-place", location.path)));
      return built.cdHash;
    }).pipe(
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
        return writeWindowsShortcuts(location).pipe(Effect.as(Option.none<string>()));
      case "linux-entry":
        return writeLinuxEntry(location).pipe(Effect.as(Option.none<string>()));
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
          // Copies only an upgrade makes go first, so a stop part way through never leaves
          // one behind with nothing at the launcher path for the next start to fill.
          yield* trashUpgradeLeftovers(location, installId);
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

  // A shim install opens by starting its app, so its window is the app's; a window
  // opened here instead would stay SpecWithCode's.
  const openInstall = Effect.fn("desktop.artifactApps.openInstall")(function* (
    installId: string,
    location: LauncherLocation,
  ) {
    if (location.kind === "mac-bundle" && Option.isSome(location.shim)) {
      // Launch Services runs whatever executable the bundle has, so it must still be the
      // one that was signed and recorded.
      const recorded = yield* shimRecords.get(installId);
      const onDisk = yield* host.readCdHash(location.path).pipe(Effect.option);
      if (
        Option.isNone(recorded) ||
        Option.isNone(onDisk) ||
        onDisk.value !== recorded.value.cdHash
      ) {
        yield* logWarning("installed page app does not match its signed launcher; not opened", {
          installId,
        });
        return false;
      }
      yield* host.openApp(location.path);
      return true;
    }
    const opened = yield* windows.open(installId);
    if (opened !== "opened" && opened !== "focused") {
      yield* logWarning("installed page window did not open", { installId, result: opened });
    }
    return true;
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
        // A launcher that cannot be verified, changed or the check timed out, is never
        // started; say so, with a retry first.
        if (!(yield* openInstall(existing.installId, location.value))) {
          return failed(
            "This page's app could not be confirmed as the one SpecWithCode installed, so it was not opened. Try again; if it keeps failing, uninstall it and install it again.",
          );
        }
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
    const location = locateLauncher({ installId, name }, context, currentShim());
    const cdHash = yield* writeLauncher(location, installId, context.icons);
    // A shim launcher without its hash would be turned away, so it is taken back when the
    // hash cannot be kept.
    if (location.kind === "mac-bundle" && Option.isSome(location.shim)) {
      if (Option.isNone(cdHash)) {
        yield* removeLauncher(location, installId).pipe(Effect.ignore);
        return failed(GENERIC_FAILURE);
      }
      yield* shimRecords
        .set(installId, { ...location.shim.value, cdHash: cdHash.value })
        .pipe(Effect.tapError(() => removeLauncher(location, installId).pipe(Effect.ignore)));
    }
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
      .pipe(
        Effect.tapError(() =>
          removeLauncher(location, installId).pipe(
            Effect.andThen(shimRecords.remove(installId)),
            Effect.ignore,
          ),
        ),
      );
    yield* logInfo("installed page", {
      installId,
      platform: host.platform,
      shim: location.kind === "mac-bundle" && Option.isSome(location.shim),
    });
    yield* openInstall(installId, location);
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
    // Without its hash, no shim can connect for this install again.
    yield* shimRecords.remove(installId).pipe(
      Effect.catchCause((cause) =>
        logWarning("installed page shim record could not be forgotten", {
          installId,
          cause: Cause.pretty(cause),
        }),
      ),
    );
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

  // Paths compared as the system resolves them; a path that cannot be resolved is kept as is.
  const resolvedPath = (path: string) =>
    fileSystem.realPath(path).pipe(Effect.orElseSucceed(() => path));

  const shimInstallFor = Effect.fn("desktop.artifactApps.shimInstallFor")(function* (
    bundlePath: string,
  ) {
    if (host.platform !== "darwin") return Option.none();
    const context = yield* launcherContext;
    const wanted = yield* resolvedPath(bundlePath);
    for (const app of yield* records.list) {
      const shim = yield* shimRecords.get(app.installId);
      if (Option.isNone(shim)) continue;
      const location = yield* locateRecorded(app, context);
      if (Option.isNone(location) || location.value.kind !== "mac-bundle") continue;
      if ((yield* resolvedPath(location.value.path)) !== wanted) continue;
      // A bundle whose plist was changed is not this install's any more, whatever it is called.
      if (!(yield* launcherPathOwned(location.value, location.value.path, app.installId))) {
        return Option.none();
      }
      return Option.some({ installId: app.installId, cdHash: shim.value.cdHash });
    }
    return Option.none();
  });

  const launch = Effect.fn("desktop.artifactApps.launch")(function* (installId: string) {
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
    return yield* openInstall(installId, location.value);
  });

  const sameShim = (
    recorded: LauncherLocationShim,
    wanted: Omit<ArtifactAppShimRecords.ArtifactAppShimRecord, "cdHash">,
  ) =>
    Option.isSome(recorded) &&
    recorded.value.hostAppPath === wanted.hostAppPath &&
    recorded.value.hostBundleId === wanted.hostBundleId &&
    recorded.value.serverName === wanted.serverName &&
    recorded.value.minimumSystemVersion === wanted.minimumSystemVersion;

  /**
   * Replaces one owned launcher with a shim for the running app. The new bundle is
   * built and signed aside first; the old one moves to a private removal name, the
   * new one takes its place, and then the hash is recorded and the old one trashed.
   * Any failure puts the old launcher back. A start after a crash part way through
   * finishes the job: a launcher left under its removal name goes back first, and a
   * new bundle swapped in without its record is rebuilt (never trusted as found).
   */
  const upgradeOne = Effect.fn("desktop.artifactApps.upgradeLauncher")(function* (
    app: DesktopArtifactApp,
    wanted: Omit<ArtifactAppShimRecords.ArtifactAppShimRecord, "cdHash">,
    context: LauncherContext,
  ) {
    const next = locateLauncher(app, context, Option.some(wanted));
    if (next.kind !== "mac-bundle") return Option.none<string>();
    const current = yield* locateRecorded(app, context);
    if (Option.isNone(current) || current.value.kind !== "mac-bundle") return Option.none<string>();
    yield* restoreInterruptedLauncher(current.value, app.installId);
    const ownedNow = yield* launcherPathOwned(current.value, current.value.path, app.installId);
    if (ownedNow && sameShim(current.value.shim, wanted)) {
      // Already current, so any copy under the upgrade name is stale: one left by an
      // upgrade that stopped after its record was saved goes now, before an uninstall
      // could leave the path empty for the next start to fill with it.
      yield* trashUpgradeLeftovers(next, app.installId);
      return Option.none<string>();
    }
    const from = ownedNow
      ? current.value
      : (yield* launcherPathOwned(next, next.path, app.installId))
        ? next
        : undefined;
    if (from === undefined) {
      yield* logInfo("left a launcher that is not this page's own; not upgraded", {
        installId: app.installId,
      });
      return Option.none<string>();
    }
    const staging = stagingFolder(next, app.installId);
    return yield* Effect.gen(function* () {
      const built = yield* buildMacBundle(next, staging, context.icons);
      if (Option.isNone(built.cdHash)) return Option.none<string>();
      const previous = yield* shimRecords.get(app.installId);
      // Its own private name, apart from uninstall's: a copy uninstall could not trash
      // must never be put back by the next start.
      const claimed = rules.join(
        next.folder,
        `${upgradePrefix(next, app.installId)}${newArtifactAppInstallId()}`,
      );
      const putBack = fileSystem.rename(claimed, from.path).pipe(
        Effect.catchCause((cause) =>
          logWarning("old launcher could not be put back", {
            installId: app.installId,
            cause: Cause.pretty(cause),
          }),
        ),
      );
      yield* fileSystem
        .rename(from.path, claimed)
        .pipe(Effect.mapError(writeError("remove-launcher", from.path)));
      // Nothing took the old launcher's place yet, so it goes back.
      yield* fileSystem.rename(built.stagedBundle, next.path).pipe(
        Effect.mapError(writeError("move-into-place", next.path)),
        Effect.tapError(() => putBack),
      );
      // Without its hash the new bundle would be turned away, so the old one comes back.
      yield* shimRecords
        .set(app.installId, { ...wanted, cdHash: built.cdHash.value })
        .pipe(
          Effect.tapError(() =>
            fileSystem
              .remove(next.path, { recursive: true, force: true })
              .pipe(Effect.ignore, Effect.andThen(putBack)),
          ),
        );
      // The old copy must not stay under a removal name: it is no longer what uninstall
      // recognises, so it would hold every later uninstall back.
      // Every copy under the upgrade name goes, including one an earlier upgrade that
      // stopped part way left behind: only an upgrade makes them, and the Trash keeps them.
      yield* trashUpgradeLeftovers(next, app.installId);
      yield* logInfo("upgraded installed page launcher to an app shim", {
        installId: app.installId,
      });
      return Option.map(previous, (record) => record.cdHash);
    }).pipe(
      Effect.ensuring(
        fileSystem.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore),
      ),
    );
  });

  const upgradePrefix = (location: { readonly path: string }, installId: string) =>
    `.${rules.basename(location.path)}.upgrading-${installId}.`;

  // Copies an upgrade moved aside: exactly `.<name>.app.upgrading-<installId>.<32 hex>`.
  const upgradeLeftovers = (
    location: Extract<LauncherLocation, { kind: "mac-bundle" }>,
    installId: string,
  ) =>
    fileSystem.readDirectory(location.folder).pipe(
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
      Effect.map((entries) => {
        const prefix = upgradePrefix(location, installId);
        return entries
          .filter(
            (entry) =>
              entry.startsWith(prefix) && /^[0-9a-f]{32}$/.test(entry.slice(prefix.length)),
          )
          .map((entry) => rules.join(location.folder, entry));
      }),
    );

  const trashUpgradeLeftovers = (
    location: Extract<LauncherLocation, { kind: "mac-bundle" }>,
    installId: string,
  ) =>
    Effect.gen(function* () {
      // Through a linked folder they could be anything; they are left alone.
      if (yield* isSymbolicLink(location.folder)) return;
      for (const left of yield* upgradeLeftovers(location, installId)) {
        yield* host
          .trashItem(left)
          .pipe(
            Effect.catchCause(() =>
              fileSystem.remove(left, { recursive: true, force: true }).pipe(Effect.ignore),
            ),
          );
      }
    });

  // An upgrade stopped between its two renames leaves the launcher under its upgrade
  // name and nothing in its place; it goes back before anything else looks at it. Only
  // a copy that is exactly the launcher the install's records describe goes back: the
  // records change only after the swap, so a copy left from before a saved record never
  // matches them. An empty path with an uninstall's copy beside it is an uninstall the
  // Trash refused, never an upgrade to finish, so nothing is put back then.
  const restoreInterruptedLauncher = Effect.fn("desktop.artifactApps.restoreInterruptedLauncher")(
    function* (location: Extract<LauncherLocation, { kind: "mac-bundle" }>, installId: string) {
      if (yield* fileSystem.exists(location.path).pipe(Effect.orElseSucceed(() => true))) return;
      const removing = yield* pendingRemovals(location, installId).pipe(
        Effect.orElseSucceed((): ReadonlyArray<string> => ["unknown"]),
      );
      if (removing.length > 0) return;
      // A shim must also still be the signed bundle whose hash is recorded.
      const recordedHash = Option.isSome(location.shim)
        ? Option.map(yield* shimRecords.get(installId), (record) => record.cdHash)
        : Option.none<string>();
      if (Option.isSome(location.shim) && Option.isNone(recordedHash)) return;
      let left: string | undefined;
      for (const candidate of yield* upgradeLeftovers(location, installId)) {
        const owned = yield* launcherPathOwned(location, candidate, installId).pipe(
          Effect.orElseSucceed(() => false),
        );
        const matches =
          owned &&
          (Option.isNone(recordedHash) ||
            Option.getOrUndefined(yield* host.readCdHash(candidate).pipe(Effect.option)) ===
              recordedHash.value);
        if (matches) {
          left = candidate;
          break;
        }
      }
      if (left === undefined) return;
      yield* fileSystem.rename(left, location.path).pipe(Effect.ignore);
      yield* logInfo("put back a launcher an interrupted upgrade left aside", { installId });
    },
  );

  const upgradeLaunchers = Effect.gen(function* () {
    const replaced = new Map<string, string>();
    const shim = currentShim();
    if (host.platform !== "darwin" || Option.isNone(shim)) return replaced;
    const context = yield* launcherContext;
    for (const app of yield* records.list) {
      const previous = yield* installLock
        .withPermits(1)(upgradeOne(app, shim.value, context))
        .pipe(
          Effect.catchCause((cause) =>
            logWarning("installed page launcher was not upgraded", {
              installId: app.installId,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as(Option.none<string>())),
          ),
        );
      if (Option.isSome(previous)) replaced.set(app.installId, previous.value);
    }
    return replaced;
  }).pipe(Effect.withSpan("desktop.artifactApps.upgradeLaunchers"));

  const quietly =
    <A>(label: string, fallback: A) =>
    <E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          logWarning(label, { cause: Cause.pretty(cause) }).pipe(Effect.as(fallback)),
        ),
      );

  return ArtifactAppInstaller.of({
    shimInstallFor: (bundlePath) =>
      shimInstallFor(bundlePath).pipe(
        quietly(
          "installed page shim lookup failed",
          Option.none<{ readonly installId: string; readonly cdHash: string }>(),
        ),
      ),
    launch: (installId) => launch(installId).pipe(quietly("installed page launch failed", false)),
    upgradeLaunchers,
    disableShims: Effect.sync(() => {
      shimsEnabled = false;
    }),
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
