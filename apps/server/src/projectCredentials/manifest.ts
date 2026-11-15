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

/** True when the open file is the one lstat saw: not swapped for a link in between. */
const sameFile = (seen: NodeFS.Stats, opened: NodeFS.Stats) =>
  // A file system that reports no file id (0) cannot be compared; the lstat check stands alone.
  seen.ino === 0 || opened.ino === 0 || (seen.ino === opened.ino && seen.dev === opened.dev);

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
  if ((await NodeFSP.realpath(current)) !== current)
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
  const seen = await NodeFSP.lstat(path).catch(() => null);
  if (seen === null) return null;
  if (!seen.isFile()) return { ok: false, problem: "The saved list is a link or not a file." };
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
    const stat = await handle.stat();
    if (!stat.isFile() || !sameFile(seen, stat))
      return { ok: false, problem: "The saved list is a link or not a file." };
    if (stat.size > MAX_MANIFEST_BYTES)
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
  const existing = await NodeFSP.lstat(final).catch(() => null);
  if (existing !== null && !existing.isFile())
    throw new ManifestRefusal(
      "credentials.json in the project is a link or a folder; nothing was saved.",
    );
  const partial = NodePath.join(folder, `.credentials.${NodeCrypto.randomUUID()}.tmp`);
  const handle = await NodeFSP.open(
    partial,
    NodeFS.constants.O_CREAT | NodeFS.constants.O_EXCL | NodeFS.constants.O_WRONLY | NO_FOLLOW,
    0o644,
  );
  try {
    await handle.writeFile(formatProjectCredentialsManifest(checked.manifest));
    await handle.sync();
    await handle.close();
    await NodeFSP.rename(partial, final);
  } catch (cause) {
    await handle.close().catch(() => undefined);
    await NodeFSP.rm(partial, { force: true });
    throw cause;
  }
  return PROJECT_CREDENTIALS_MANIFEST_PATH;
}
