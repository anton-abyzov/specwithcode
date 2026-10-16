import {
  canonicalStudioPath,
  LEGACY_STUDIO_HOME_DIRECTORY,
  STUDIO_HOME_DIRECTORY,
} from "@specweave-studio/shared/studioIdentity";
import type * as Path from "effect/Path";

import { expandHomePathWith } from "./pathExpansion.ts";

/**
 * Directory new worktrees are created under: the `worktreesDirectory`
 * setting, or `defaultDir` (`<Studio home>/worktrees`) when it is empty. Null when
 * the setting is not an absolute path on this machine, such as `D:\worktrees`
 * configured for a Windows server and synced to a Linux one, or when it is a
 * filesystem root, which would make every path on that drive look managed.
 */
export function resolveWorktreesDirectory(
  setting: string,
  defaultDir: string,
  path: Path.Path,
): string | null {
  if (setting === "") return defaultDir;
  const expanded = expandHomePathWith(setting, path);
  if (!path.isAbsolute(expanded)) return null;
  const resolved = path.resolve(expanded);
  return isFilesystemRoot(resolved, path) ? null : resolved;
}

/** Callers re-check after resolving symlinks: a link can point at a root. */
export function isFilesystemRoot(directory: string, path: Path.Path): boolean {
  return path.dirname(directory) === directory;
}

/**
 * `directory` as it was recorded before the SpecWithCode root moved: the same path under
 * the legacy `~/.specweave-studio`, when that legacy root is now a link to the branded
 * one. Null otherwise, so a real legacy root beside a fresh profile is never claimed.
 */
export function legacyStudioPathAlias(directory: string, path: Path.Path): string | null {
  const marker = `${path.sep}${STUDIO_HOME_DIRECTORY}${path.sep}`;
  const index = directory.lastIndexOf(marker);
  if (index <= 0) return null;
  const home = directory.slice(0, index);
  const legacy = `${home}${path.sep}${LEGACY_STUDIO_HOME_DIRECTORY}${directory.slice(index + marker.length - 1)}`;
  return canonicalStudioPath(legacy, home) === directory ? legacy : null;
}

/**
 * Every directory that holds Studio-managed worktrees on this machine, including the
 * pre-migration spelling of the default directory, under which older worktrees were
 * recorded.
 */
export function managedWorktreesDirectories(
  settings: {
    readonly worktreesDirectory: string;
    readonly previousWorktreesDirectories: ReadonlyArray<string>;
  },
  defaultDir: string,
  path: Path.Path,
): ReadonlyArray<string> {
  const directories = new Set([defaultDir]);
  const legacyDefault = legacyStudioPathAlias(defaultDir, path);
  if (legacyDefault !== null) directories.add(legacyDefault);
  for (const setting of [settings.worktreesDirectory, ...settings.previousWorktreesDirectories]) {
    const directory = resolveWorktreesDirectory(setting, defaultDir, path);
    if (directory !== null) directories.add(directory);
  }
  return [...directories];
}
