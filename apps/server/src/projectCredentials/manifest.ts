// @effect-diagnostics nodeBuiltinImport:off - no-follow opens, exclusive create and rename inside one project folder.
/**
 * The project's saved list of credentials, `.specweave/project/credentials.json`.
 * It is a file in a repository, so it is read as hostile: strictly parsed,
 * small, never through a link. Saving never writes through a link either, so
 * the file cannot land outside the project.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  formatProjectCredentialsManifest,
  MAX_MANIFEST_BYTES,
  parseProjectCredentialsManifest,
  PROJECT_CREDENTIALS_MANIFEST_PATH,
  type ProjectCredentialsManifest,
  type ProjectCredentialsManifestResult,
} from "@specweave-studio/contracts";

/**
 * Windows has no O_NOFOLLOW, so an open there follows a link. Every read and
 * write below therefore checks the name with lstat first, on every system, and
 * the flag is the second guard where it exists.
 */
const NO_FOLLOW = NodeFS.constants.O_NOFOLLOW ?? 0;

/** File ids are compared as bigint: a 64-bit id rounded to a number can match another file's. */
const lstatId = (path: string) => NodeFSP.lstat(path, { bigint: true });

/**
 * A file system that reports no file id (0). Where O_NOFOLLOW guards the name
 * the lstat checks stand without it; on Windows nothing would, so it is refused.
 */
const unprovable = (...stats: ReadonlyArray<NodeFS.BigIntStats>) =>
  NO_FOLLOW === 0 && stats.some((stat) => stat.ino === 0n);

/** True when the open file is the one lstat saw: not swapped for a link in between. */
const sameFile = (seen: NodeFS.BigIntStats, opened: NodeFS.BigIntStats) =>
  seen.ino === 0n || opened.ino === 0n || (seen.ino === opened.ino && seen.dev === opened.dev);

/** Only these errors mean the file is not there; any other failure is reported. */
const isMissing = (cause: unknown) => {
  const code = (cause as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
};

/** The folder is still a real folder reached without a link: none on the way was swapped for one. */
const folderUnmoved = async (folder: string) =>
  (await NodeFSP.lstat(folder).catch(() => null))?.isDirectory() === true &&
  (await NodeFSP.realpath(folder).catch(() => null)) === folder;

export class ManifestRefusal extends Error {}

const SEGMENTS = PROJECT_CREDENTIALS_MANIFEST_PATH.split("/");

/**
 * Walks from the project root to the manifest's folder. Every step must be a
 * real folder, not a link; missing ones are created when `create` is set.
 * Returns null when a folder is missing and nothing may be created.
 */
async function manifestFolder(root: string, create: boolean): Promise<string | null> {
  const realRoot = await NodeFSP.realpath(root);
  let current = realRoot;
  for (const segment of SEGMENTS.slice(0, -1)) {
    current = NodePath.join(current, segment);
    const stat = await NodeFSP.lstat(current).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return null;
      throw cause;
    });
    if (stat === null) {
      if (!create) return null;
      await NodeFSP.mkdir(current);
      continue;
    }
    if (!stat.isDirectory())
      throw new ManifestRefusal(
        `${segment} in the project is a link or a file, so the list was not ${create ? "saved" : "read"}.`,
      );
  }
  // A folder swapped for a link between the checks and now would show here.
  if (!(await folderUnmoved(current)))
    throw new ManifestRefusal("The project's .specweave folder changed while it was read.");
  return current;
}

/** The saved manifest, `null` when the project has none, or why it cannot be used. */
export async function readManifest(root: string): Promise<ProjectCredentialsManifestResult | null> {
  let folder: string | null;
  try {
    folder = await manifestFolder(root, false);
  } catch (cause) {
    if (cause instanceof ManifestRefusal) return { ok: false, problem: cause.message };
    throw cause;
  }
  if (folder === null) return null;
  const path = NodePath.join(folder, SEGMENTS.at(-1)!);
  // A save elsewhere replaces the file by rename; a read that meets one starts again.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await readOnce(folder, path);
    if (result !== REPLACED) return result;
  }
  return { ok: false, problem: "The saved list kept changing while it was read." };
}

const REPLACED = Symbol("replaced");
const LINKED = { ok: false, problem: "The saved list is a link or not a file." } as const;

async function readOnce(
  folder: string,
  path: string,
): Promise<ProjectCredentialsManifestResult | null | typeof REPLACED> {
  let seen: NodeFS.BigIntStats;
  try {
    seen = await lstatId(path);
  } catch (cause) {
    if (isMissing(cause)) return null;
    return { ok: false, problem: "The saved list cannot be read." };
  }
  if (!seen.isFile()) return LINKED;
  let handle: NodeFSP.FileHandle;
  try {
    handle = await NodeFSP.open(path, NodeFS.constants.O_RDONLY | NO_FOLLOW);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    // ELOOP: the file is a link.
    return { ok: false, problem: "The saved list is a link or cannot be opened." };
  }
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile()) return LINKED;
    if (unprovable(seen, stat))
      return {
        ok: false,
        problem: "This drive reports no file ids, so the saved list cannot be checked for links.",
      };
    // Another file now: a save replaced it (read again), or a link took its place.
    if (!sameFile(seen, stat)) return REPLACED;
    // Without O_NOFOLLOW the open itself may have gone through a link put there after
    // the check: the name must still be this file, and its folder still in the project.
    const after = await lstatId(path).catch(() => null);
    if (after === null || !after.isFile() || !sameFile(after, stat)) return REPLACED;
    if (!(await folderUnmoved(folder)))
      return { ok: false, problem: "The project's .specweave folder changed while it was read." };
    if (stat.size > BigInt(MAX_MANIFEST_BYTES))
      return { ok: false, problem: "The saved list is too large." };
    let parsed: unknown;
    try {
      parsed = JSON.parse((await handle.readFile()).toString("utf8"));
    } catch {
      return { ok: false, problem: "The saved list is not valid JSON." };
    }
    return parseProjectCredentialsManifest(parsed);
  } finally {
    await handle.close();
  }
}

/**
 * Saves the manifest: validated first, written to a new file beside the final
 * name, then renamed over it. A final name that is a link is refused.
 */
export async function writeManifest(
  root: string,
  manifest: ProjectCredentialsManifest,
): Promise<string> {
  const checked = parseProjectCredentialsManifest({
    version: 1,
    credentials: manifest.credentials.map((entry) => ({ ...entry })),
  });
  if (!checked.ok) throw new ManifestRefusal(checked.problem);
  const folder = await manifestFolder(root, true);
  if (folder === null) throw new ManifestRefusal("The project folder is gone.");
  const final = NodePath.join(folder, SEGMENTS.at(-1)!);
  const existing = await NodeFSP.lstat(final).catch((cause: unknown) => {
    if (isMissing(cause)) return null;
    throw cause;
  });
  if (existing !== null && !existing.isFile())
    throw new ManifestRefusal(
      "credentials.json in the project is a link or a folder; nothing was saved.",
    );
  const moved = () =>
    new ManifestRefusal("The project's .specweave folder changed; nothing was saved.");
  const partial = NodePath.join(folder, `.credentials.${NodeCrypto.randomUUID()}.tmp`);
  // Checked again as the last step before the file is made, so a swapped folder gets no file.
  if (!(await folderUnmoved(folder))) throw moved();
  const handle = await NodeFSP.open(
    partial,
    NodeFS.constants.O_CREAT | NodeFS.constants.O_EXCL | NodeFS.constants.O_WRONLY | NO_FOLLOW,
    0o644,
  );
  try {
    // The new file must be the one at its name in the project's own folder; nothing is written
    // into a file a swap in between carried elsewhere.
    const made = await handle.stat({ bigint: true });
    const named = await lstatId(partial).catch(() => null);
    if (named === null || !named.isFile() || !sameFile(named, made) || unprovable(named, made))
      throw moved();
    if (!(await folderUnmoved(folder))) throw moved();
    await handle.writeFile(formatProjectCredentialsManifest(checked.manifest));
    await handle.sync();
    await handle.close();
    // A folder above swapped for a link since the walk would carry the save out of the project.
    if (!(await folderUnmoved(folder))) throw moved();
    await NodeFSP.rename(partial, final);
  } catch (cause) {
    await handle.close().catch(() => undefined);
    await NodeFSP.rm(partial, { force: true });
    throw cause;
  }
  return PROJECT_CREDENTIALS_MANIFEST_PATH;
}
