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
 * created or removed. The entry comes from the target itself, or from a folder
 * above it on the same volume, so a mount point is judged by its own volume.
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
    let folder = target;
    let stat = await lstat(folder);
    while (!stat) {
      const parent = NodePath.dirname(folder);
      if (parent === folder) return unknown;
      folder = parent;
      stat = await lstat(folder);
    }
    if (!stat.isDirectory()) return unknown;
    const volume = stat.dev;
    for (;;) {
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
      const parent = NodePath.dirname(folder);
      if (parent === folder) return unknown;
      const above = await lstat(parent);
      if (!above || above.dev !== volume) return unknown;
      folder = parent;
    }
  } catch {
    return unknown;
  }
}

/** True when the volume a copy into `directory` lands on treats `A` and `a` as one name, or cannot tell. */
export async function caseInsensitiveAt(directory: string): Promise<boolean> {
  return (await volumeNameRules(directory)).caseInsensitive;
}

/**
 * Lists the target folder and hashes only what the plan can use: files at a path
 * the source also sends with the same size, and files whose size matches a file
 * the source sends (so its bytes can be reused instead of moved).
 */
export async function scanDestination(
  target: string,
  sourceEntries: ReadonlyArray<ManifestEntry>,
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
  const fingerprint = NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify({
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
