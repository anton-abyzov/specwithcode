// @effect-diagnostics-next-line nodeBuiltinImport:off -- Synchronous profile-root selection runs before Effect services are constructed.
import { existsSync, lstatSync } from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Synchronous profile-root selection runs before Effect services are constructed.
import { join, sep } from "node:path";

export const STUDIO_NAME = "SpecWithCode";
export const STUDIO_CLI = "specweave-studio";
export const STUDIO_DEFAULT_PORT = 8319;
export const STUDIO_HOME_DIRECTORY = ".specwithcode";
export const LEGACY_STUDIO_HOME_DIRECTORY = ".specweave-studio";
/** Releases, the update agent and toolchains: `<root>/install`, formerly `~/.local/share/specweave-studio`. */
export const STUDIO_INSTALL_DIRECTORY = "install";
export const LEGACY_STUDIO_INSTALL_DIRECTORY = join(".local", "share", "specweave-studio");

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * The one SpecWithCode root on this machine: `~/.specwithcode`. A legacy
 * `~/.specweave-studio` is used only until `migrate_home` moves it; after that it is a
 * compatibility link to the branded root and is never returned. The caller supplies its
 * user's home; an upstream home variable is never consulted.
 */
export function studioRootDirectory(userHome: string): string {
  const legacy = join(userHome, LEGACY_STUDIO_HOME_DIRECTORY);
  const branded = join(userHome, STUDIO_HOME_DIRECTORY);
  if (isLink(legacy)) return branded;
  // Direct state belongs to a legacy standalone profile; identity children belong
  // to managed services and must not displace an existing branded profile.
  if (existsSync(join(legacy, "userdata")) || existsSync(join(legacy, "dev"))) return legacy;
  if (existsSync(branded)) return branded;
  return existsSync(legacy) ? legacy : branded;
}

/** The default home of a standalone (desktop or `specwithcode start`) profile. */
export function studioDefaultHome(userHome: string): string {
  return studioRootDirectory(userHome);
}

/** Where releases, the update agent and toolchains live, beside the identity homes. */
export function studioInstallDirectory(userHome: string): string {
  const legacy = join(userHome, LEGACY_STUDIO_INSTALL_DIRECTORY);
  const branded = join(userHome, STUDIO_HOME_DIRECTORY, STUDIO_INSTALL_DIRECTORY);
  if (isLink(legacy) || existsSync(branded)) return branded;
  return existsSync(legacy) ? legacy : branded;
}

/**
 * The home of one managed service identity (m1, m4, ...). Resolved per identity, so a
 * fresh branded profile on the same machine never hides an unmigrated legacy service.
 */
export function studioIdentityHome(userHome: string, identity: string): string {
  const legacyRoot = join(userHome, LEGACY_STUDIO_HOME_DIRECTORY);
  const branded = join(userHome, STUDIO_HOME_DIRECTORY, identity);
  if (isLink(legacyRoot) || existsSync(branded)) return branded;
  const legacy = join(legacyRoot, identity);
  return existsSync(legacy) ? legacy : branded;
}

/**
 * A stored absolute path under a migrated legacy root, rewritten to the branded root.
 * Paths recorded before the move (projects, worktrees, receipts) stay valid through the
 * compatibility link; comparisons and new writes use this canonical form.
 */
export function canonicalStudioPath(path: string, userHome: string): string {
  const pairs: ReadonlyArray<readonly [string, string]> = [
    [
      join(userHome, LEGACY_STUDIO_INSTALL_DIRECTORY),
      join(userHome, STUDIO_HOME_DIRECTORY, STUDIO_INSTALL_DIRECTORY),
    ],
    [join(userHome, LEGACY_STUDIO_HOME_DIRECTORY), join(userHome, STUDIO_HOME_DIRECTORY)],
  ];
  for (const [legacy, branded] of pairs) {
    if ((path === legacy || path.startsWith(legacy + sep)) && isLink(legacy)) {
      return branded + path.slice(legacy.length);
    }
  }
  return path;
}
