import { compareSemverVersions, parseSemver } from "@specweave-studio/shared/semver";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";

import * as DesktopObservability from "../app/DesktopObservability.ts";

/**
 * The app release electron-updater downloaded on an earlier launch, read from
 * its cache (<cache>/<updaterCacheDirName>/pending/update-info.json). An
 * Update now run made before this launch's first check names that release
 * for its app half instead of none (DesktopUpdates.appTargetForRun). Once
 * the app runs that release, the download is removed.
 */

export interface PendingAppDownload {
  readonly version: string;
  readonly fileName: string;
}

const { logInfo, logWarning } = DesktopObservability.makeComponentLogger("desktop-updater");

/** The pending folder's own file, beside the download it describes. */
const PENDING_UPDATE_INFO_FILE = "update-info.json";
/** MacUpdater's copy of each download, the base of its differential downloads. */
const MAC_DIFFERENTIAL_BASE_FILE = "update.zip";

// update-info.json holds {fileName, sha512, isAdminRightsRequired} and no
// version: it is read from the download's name, which the build gives as
// SpecWithCode-${version}-${arch}.${ext} (scripts/build-desktop-artifact.ts).
const DOWNLOAD_NAME =
  /^.+?-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+?)?)-(?:arm64|x64|x86_64|universal|ia32|armv7l|aarch64|amd64)\.[0-9A-Za-z]+$/;

export interface UpdaterCacheLocation {
  readonly platform: NodeJS.Platform;
  readonly homeDirectory: string;
  readonly localAppData: string | undefined;
  readonly xdgCacheHome: string | undefined;
  readonly updaterCacheDirName: string | undefined;
  readonly join: (...parts: ReadonlyArray<string>) => string;
}

/**
 * electron-updater's cache folder: its base cache folder (AppAdapter's
 * getAppCacheDir), then app-update.yml's updaterCacheDirName. Null without
 * that name.
 */
export function updaterCacheDir(input: UpdaterCacheLocation): string | null {
  const { homeDirectory, join } = input;
  if (input.updaterCacheDirName === undefined) return null;
  const base =
    input.platform === "win32"
      ? (input.localAppData ?? join(homeDirectory, "AppData", "Local"))
      : input.platform === "darwin"
        ? join(homeDirectory, "Library", "Caches")
        : (input.xdgCacheHome ?? join(homeDirectory, ".cache"));
  return join(base, input.updaterCacheDirName);
}

/** electron-updater's downloads folder, pending/ in its cache folder. */
export function updaterPendingDir(input: UpdaterCacheLocation): string | null {
  const cacheDir = updaterCacheDir(input);
  return cacheDir === null ? null : input.join(cacheDir, "pending");
}

/** The download update-info.json names, or null for anything electron-updater would not write. */
export function parsePendingUpdateInfo(raw: string): PendingAppDownload | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { fileName, sha512 } = value as Record<string, unknown>;
  if (typeof fileName !== "string" || typeof sha512 !== "string" || sha512.length === 0) {
    return null;
  }
  // A base name in the pending folder, never a path out of it.
  if (fileName.includes("/") || fileName.includes("\\") || fileName.startsWith(".")) return null;
  const version = DOWNLOAD_NAME.exec(fileName)?.[1];
  return version !== undefined && parseSemver(version) !== null ? { version, fileName } : null;
}

/** Whether `version` is a release newer than the running app. */
export function isNewerRelease(version: string | null, runningVersion: string): version is string {
  return (
    version !== null &&
    parseSemver(version) !== null &&
    parseSemver(runningVersion) !== null &&
    compareSemverVersions(version, runningVersion) > 0
  );
}

/** The newest of `versions` that is newer than the running app, or null. */
export function newestRelease(
  versions: ReadonlyArray<string | null>,
  runningVersion: string,
): string | null {
  let newest: string | null = null;
  for (const version of versions) {
    if (!isNewerRelease(version, runningVersion)) continue;
    if (newest === null || compareSemverVersions(version, newest) > 0) newest = version;
  }
  return newest;
}

const readPendingUpdateInfo = (
  fileSystem: FileSystem.FileSystem,
  join: (...parts: ReadonlyArray<string>) => string,
  pendingDir: string,
) =>
  fileSystem.readFileString(join(pendingDir, PENDING_UPDATE_INFO_FILE), "utf-8").pipe(
    Effect.map(parsePendingUpdateInfo),
    Effect.orElseSucceed(() => null),
  );

/** The download `pendingDir` holds, when update-info.json is sound and its file is there. */
export const readPendingAppDownload = (
  fileSystem: FileSystem.FileSystem,
  join: (...parts: ReadonlyArray<string>) => string,
  pendingDir: string | null,
): Effect.Effect<PendingAppDownload | null> =>
  Effect.gen(function* () {
    if (pendingDir === null) return null;
    const download = yield* readPendingUpdateInfo(fileSystem, join, pendingDir);
    if (download === null) return null;
    const present = yield* fileSystem
      .exists(join(pendingDir, download.fileName))
      .pipe(Effect.orElseSucceed(() => false));
    return present ? download : null;
  });

/**
 * Removes the download in `cacheDir` once the app runs its release or a newer
 * one: pending/ (150 MB on macOS) and MacUpdater's update.zip copy beside it.
 * A newer release's download stays, and so does one whose release cannot be
 * told. The removed download's version, else null; a removal that fails is
 * logged, never raised.
 */
export const removeInstalledAppDownload = (
  fileSystem: FileSystem.FileSystem,
  join: (...parts: ReadonlyArray<string>) => string,
  cacheDir: string | null,
  runningVersion: string,
): Effect.Effect<string | null> =>
  Effect.gen(function* () {
    if (cacheDir === null || parseSemver(runningVersion) === null) return null;
    const pendingDir = join(cacheDir, "pending");
    const download = yield* readPendingUpdateInfo(fileSystem, join, pendingDir);
    if (download === null || compareSemverVersions(download.version, runningVersion) > 0) {
      return null;
    }
    yield* fileSystem.remove(join(cacheDir, MAC_DIFFERENTIAL_BASE_FILE), { force: true });
    yield* fileSystem.remove(pendingDir, { recursive: true, force: true });
    yield* logInfo("removed the installed release's download", { version: download.version });
    return download.version;
  }).pipe(
    Effect.catch((error) =>
      logWarning("Could not remove the installed release's download.", {
        errorTag: error._tag,
      }).pipe(Effect.as(null)),
    ),
    Effect.withSpan("desktop.updates.removeInstalledAppDownload"),
  );
