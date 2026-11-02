// @effect-diagnostics nodeBuiltinImport:off - secret files are opened with no-follow descriptors.
/**
 * Where the source reads a secret file the person ticked: inside the copied
 * folder, or a `~/` file in the home folder (`secretLocations`). Paths and sizes
 * are all the records keep.
 *
 * @module sourceSecrets
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  isSecretLikeProjectPath,
  isUntrackedSecretConfigPath,
} from "../../workspace/WorkspaceSensitivePaths.ts";
import { isSafeRelativePath } from "./paths.ts";
import {
  homeSecretRelative,
  isDotnetUserSecretsFile,
  isHomeSecretPath,
  platformHomePath,
} from "./secretLocations.ts";
import { MAX_SECRET_FILE_BYTES } from "./secrets.ts";

export interface SecretRoots {
  readonly folder: string;
  readonly home: string;
  readonly platform?: NodeJS.Platform;
}

/** The folder and relative path a secret is read from, or null for a refused path. */
function secretPlace(
  roots: SecretRoots,
  path: string,
): { readonly root: string; readonly relative: string } | null {
  if (isHomeSecretPath(path)) {
    const relative = homeSecretRelative(path);
    return relative === null || !isDotnetUserSecretsFile(relative)
      ? null
      : {
          root: roots.home,
          relative: platformHomePath(relative, roots.platform ?? process.platform),
        };
  }
  return isSafeRelativePath(path) && !path.split("/").includes(".git")
    ? { root: roots.folder, relative: path }
    : null;
}

/** Opens a secret file without following a link on its path; throws when it changed. */
async function openSecret(roots: SecretRoots, path: string): Promise<NodeFSP.FileHandle> {
  const place = secretPlace(roots, path);
  if (!place) throw new Error("unsafe secret path");
  // The root as itself (a linked /home), so only links inside it are refused.
  const root = await NodeFSP.realpath(place.root);
  const absolute = NodePath.join(root, place.relative);
  const parent = NodePath.dirname(absolute);
  if ((await NodeFSP.realpath(parent)) !== parent) throw new Error("changed");
  return NodeFSP.open(absolute, NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW);
}

/**
 * The measured secret files plus any ticked folder path the summary lacks that
 * is still a secret-like regular file, by the built-in list or the project's
 * patterns. A `~/` file must be one the scan offered. The dialog can list a file from a later scan (a
 * refreshed check, a build that listed the folder again) than the one the record
 * kept; refusing it would fail the whole copy for a file the person may send.
 */
export async function liveSecretFiles(
  roots: SecretRoots,
  offered: ReadonlyArray<{ readonly path: string; readonly size: number }>,
  paths: ReadonlyArray<string>,
  secretPattern: (relative: string) => boolean,
): Promise<Array<{ path: string; size: number }>> {
  const known = new Set(offered.map((file) => file.path));
  const result = [...offered];
  for (const path of new Set(paths)) {
    // A home file is sent only when the scan offered it.
    if (known.has(path) || isHomeSecretPath(path) || !secretPlace(roots, path)) continue;
    if (
      !isSecretLikeProjectPath(path) &&
      !isUntrackedSecretConfigPath(path) &&
      !secretPattern(path)
    )
      continue;
    let handle: NodeFSP.FileHandle | null = null;
    try {
      handle = await openSecret(roots, path);
      const stat = await handle.stat();
      if (stat.isFile()) result.push({ path, size: stat.size });
    } catch {
      // Gone, a link, or behind a link: it stays refused.
    } finally {
      await handle?.close();
    }
  }
  return result;
}

/** The bytes of one approved secret file; null when it changed into a link, a folder or a large file. */
export async function readSecretBytes(roots: SecretRoots, path: string): Promise<Buffer | null> {
  try {
    const handle = await openSecret(roots, path);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_SECRET_FILE_BYTES) return null;
      const bytes = await handle.readFile();
      return bytes.byteLength > MAX_SECRET_FILE_BYTES ? null : bytes;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}
