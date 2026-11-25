// @effect-diagnostics nodeBuiltinImport:off globalDate:off - the destination scan probes case sensitivity and hashes candidates.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { exists, lstatOrNull } from "./durable.ts";
import { runGit } from "./git.ts";
import {
  forEachLimited,
  hashFile,
  type ManifestEntry,
  type RepositoryInfo,
  scanFolder,
} from "./manifest.ts";
import { foldedPathKey } from "./paths.ts";
import type { DestinationFile, DestinationRepository, Relation } from "./reconcile.ts";

/** A repository's place and who it is, enough to tell whether it is the same one. */
interface SourceRepository {
  readonly path: string;
  readonly identity: string | null;
}

export interface DestinationState {
  readonly exists: boolean;
  readonly files: Array<DestinationFile>;
  readonly repositories: Array<DestinationRepository>;
  readonly caseInsensitive: boolean;
  readonly fingerprint?: string;
}

/** How the name rules of a volume are read; tests stand in a volume here. */
export interface VolumeReader {
  readonly lstat: (
    path: string,
  ) => Promise<{ readonly dev: bigint; readonly ino: bigint; isDirectory: () => boolean } | null>;
  /** Names in a folder; a few are enough. */
  readonly names: (folder: string) => Promise<ReadonlyArray<string>>;
}

const NAMES_READ = 4096;

const volumeReader: VolumeReader = {
  lstat: (path) =>
    NodeFSP.lstat(path, { bigint: true }).catch((cause: unknown) => {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return null;
      throw cause;
    }),
  names: async (folder) => {
    const names: Array<string> = [];
    const open = await NodeFSP.opendir(folder);
    try {
      for (
        let entry = await open.read();
        entry && names.length < NAMES_READ;
        entry = await open.read()
      )
        names.push(entry.name);
    } finally {
      await open.close();
    }
    return names;
  },
};

/**
 * Whether the volume a copy into `target` lands on treats `A` and `a` as one
 * name. Read from an entry that exists, never tested by writing: nothing is
 * created or removed. The entry comes from the target itself, or, for a target
 * not made yet, from the folder it will be made in. A folder above an existing
 * target is never asked: rules can differ at a mount point and per folder.
 * When no entry can tell, or a read fails, the rules are unknown and the answer
 * is the strict one: names that differ only by case are treated as one.
 */
export async function volumeNameRules(
  target: string,
  reader: Partial<VolumeReader> = {},
): Promise<{ readonly known: boolean; readonly caseInsensitive: boolean }> {
  const { lstat, names } = { ...volumeReader, ...reader };
  const unknown = { known: false, caseInsensitive: true };
  try {
    // The target's own entries when it exists. A target not made yet takes the
    // rules of the folder it will be made in, which a new folder inherits.
    let folder = target;
    let stat = await lstat(folder);
    while (!stat) {
      const parent = NodePath.dirname(folder);
      if (parent === folder) return unknown;
      folder = parent;
      stat = await lstat(folder);
    }
    if (!stat.isDirectory()) return unknown;
    for (const name of await names(folder)) {
      const other = name === name.toUpperCase() ? name.toLowerCase() : name.toUpperCase();
      if (other === name) continue;
      const one = await lstat(NodePath.join(folder, name));
      if (!one) continue;
      const same = await lstat(NodePath.join(folder, other));
      return {
        known: true,
        caseInsensitive: same !== null && same.dev === one.dev && same.ino === one.ino,
      };
    }
    // No entry there can tell. A folder above may follow other rules, even on one volume.
    return unknown;
  } catch {
    return unknown;
  }
}

/** True when the volume a copy into `directory` lands on treats `A` and `a` as one name, or cannot tell. */
export async function caseInsensitiveAt(directory: string): Promise<boolean> {
  return (await volumeNameRules(directory)).caseInsensitive;
}

/**
 * One digest of every destination folder replacing could move to the backup whole: one at a
 * path where the source sends something other than a folder, and one where a source
 * repository lands on a folder that is not that same repository here. Every such folder
 * counts, whatever the decision on it, so the digest moves only when the destination does.
 * Null when there is none.
 */
async function replaceableTrees(
  root: string,
  files: ReadonlyArray<DestinationFile>,
  sourceEntries: ReadonlyArray<ManifestEntry>,
  key: (path: string) => string,
  repositories: { readonly source: ReadonlyArray<SourceRepository>; readonly here: ReadonlyArray<SourceRepository> },
): Promise<string | null> {
  const replaced = new Set(
    sourceEntries.filter((entry) => entry.type !== "directory").map((entry) => key(entry.path)),
  );
  const folderHere = new Set(
    files.filter((file) => file.type === "directory").map((file) => key(file.path)),
  );
  const hereAt = new Map(repositories.here.map((repo) => [key(repo.path), repo]));
  const repositoryFolders = repositories.source
    .filter((repo) => {
      const there = hereAt.get(key(repo.path));
      return (
        there === undefined ||
        (repo.identity !== null && there.identity !== null && repo.identity !== there.identity)
      );
    })
    .map((repo) => repo.path)
    .filter((path) => path === "." || folderHere.has(key(path)));
  const folders = [
    ...new Set([
      ...files
        .filter((file) => file.type === "directory" && replaced.has(key(file.path)))
        .map((file) => file.path),
      ...repositoryFolders,
    ]),
  ].sort();
  if (folders.length === 0) return null;
  const hash = NodeCrypto.createHash("sha256");
  // A part this scan cannot read could change unseen, so its name never matches another.
  const unseen = (path: string) => hash.update(`\0unseen\0${path}\0${NodeCrypto.randomUUID()}`);
  const walk = async (absolute: string, relative: string): Promise<void> => {
    const names = await NodeFSP.readdir(absolute).catch(() => null);
    if (!names) {
      unseen(relative);
      return;
    }
    for (const name of names.sort()) {
      const location = NodePath.join(absolute, name);
      const path = `${relative}/${name}`;
      const stat = await NodeFSP.lstat(location, { bigint: true }).catch(() => null);
      if (!stat) {
        unseen(path);
        continue;
      }
      const kind = stat.isDirectory() ? "d" : stat.isSymbolicLink() ? "l" : "f";
      hash.update(
        `\0${path}\0${kind}\0${stat.size}\0${stat.mtimeNs}\0${stat.ctimeNs}\0${stat.ino}`,
      );
      if (kind === "l") {
        const target = await NodeFSP.readlink(location).catch(() => null);
        if (target === null) unseen(path);
        else hash.update(target);
      }
      if (kind === "d") await walk(location, path);
    }
  };
  for (const folder of folders) await walk(NodePath.join(root, folder), folder);
  return hash.digest("hex");
}

/**
 * Lists the target folder and hashes only what the plan can use: files at a path
 * the source also sends with the same size, and files whose size matches a file
 * the source sends (so its bytes can be reused instead of moved).
 */
export async function scanDestination(
  target: string,
  sourceEntries: ReadonlyArray<ManifestEntry>,
  sourceRepositories: ReadonlyArray<SourceRepository> = [],
): Promise<DestinationState> {
  const caseInsensitive = await caseInsensitiveAt(target);
  const stat = await lstatOrNull(target);
  if (!stat)
    return { exists: false, files: [], repositories: [], caseInsensitive, fingerprint: "absent" };
  if (!stat.isDirectory()) throw new Error("The destination path is not a folder.");
  const scan = await scanFolder(target);
  const key = (path: string) => (caseInsensitive ? foldedPathKey(path) : path);
  const sourceSize = new Map(
    sourceEntries
      .filter((entry) => entry.type === "file")
      .map((entry) => [key(entry.path), entry.size]),
  );
  const wantedSizes = new Set(
    sourceEntries
      .filter((entry) => entry.type === "file" && entry.size > 0)
      .map((entry) => entry.size),
  );
  const files: Array<DestinationFile> = [];
  const toHash: Array<{ index: number; path: string }> = [];
  for (const entry of scan.entries) {
    if (entry.collapsed) continue;
    const file: DestinationFile = {
      path: entry.path,
      type: entry.type,
      size: entry.size,
      sha256: null,
      class: entry.class,
      repo: entry.repo,
      ...(entry.target !== undefined ? { target: entry.target } : {}),
    };
    if (entry.type === "file" && (sourceSize.has(key(entry.path)) || wantedSizes.has(entry.size)))
      toHash.push({ index: files.length, path: entry.path });
    files.push(file);
  }
  await forEachLimited(toHash, 8, async ({ index, path }) => {
    try {
      const hashed = await hashFile(NodePath.join(scan.root, path), false);
      files[index] = { ...files[index]!, sha256: hashed.sha256, size: hashed.size };
    } catch {
      // Unreadable here: compared as different, never reused.
    }
  });
  // Folders a source entry of another kind would replace, walked whole below, so a change in
  // a part the scan does not open (dependencies, build output) still names them anew.
  const replaceable = await replaceableTrees(scan.root, files, sourceEntries, key, {
    source: sourceRepositories,
    here: scan.repositories,
  });
  const fingerprint = NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify({
        ...(replaceable !== null ? { replaceable } : {}),
        entries: scan.entries
          .filter((entry) => entry.class !== "repository")
          .map(({ path, type, mode, size, mtimeMs, target }) => ({
            path,
            type,
            mode,
            ...(type !== "directory" ? { size, mtimeMs } : {}),
            target,
          })),
        files,
        repositories: scan.repositories,
      }),
    )
    .digest("hex");
  return {
    fingerprint,
    exists: true,
    files,
    repositories: scan.repositories.map((repo) => ({
      path: repo.path,
      kind: repo.kind,
      head: repo.head,
      branch: repo.branch,
      branches: repo.branches,
      identity: repo.identity,
      status: repo.status,
    })),
    caseInsensitive,
  };
}

export type AncestryLookup = (
  repository: string,
  commits: ReadonlyArray<string>,
) => Promise<ReadonlyArray<{ commit: string; present: boolean; ancestorOfHead: boolean }>>;

/**
 * Destination HEAD against source HEAD. What the destination has decides "ahead";
 * the source answers whether the destination's HEAD is in its history ("behind").
 */
export async function repositoryRelations(
  target: string,
  sourceRepositories: ReadonlyArray<RepositoryInfo>,
  destination: ReadonlyArray<DestinationRepository>,
  ancestry: AncestryLookup,
): Promise<Record<string, Relation>> {
  const relations: Record<string, Relation> = {};
  const here = new Map(destination.map((repo) => [repo.path, repo]));
  for (const source of sourceRepositories) {
    const mine = here.get(source.path);
    if (!mine) continue;
    if (!source.head || !mine.head) {
      relations[source.path] = source.head === mine.head ? "same" : "unknown";
      continue;
    }
    if (source.head === mine.head) {
      relations[source.path] = "same";
      continue;
    }
    const cwd = source.path === "." ? target : NodePath.join(target, ...source.path.split("/"));
    const hasSource =
      (await runGit(cwd, ["cat-file", "-e", `${source.head}^{commit}`], { allowFailure: true }))
        .code === 0;
    if (
      hasSource &&
      (
        await runGit(cwd, ["merge-base", "--is-ancestor", source.head, "HEAD"], {
          allowFailure: true,
        })
      ).code === 0
    ) {
      relations[source.path] = "destination-ahead";
      continue;
    }
    try {
      const [answer] = await ancestry(source.path, [mine.head]);
      relations[source.path] =
        answer?.present && answer.ancestorOfHead ? "destination-behind" : "diverged";
    } catch {
      relations[source.path] = "unknown";
    }
  }
  return relations;
}
