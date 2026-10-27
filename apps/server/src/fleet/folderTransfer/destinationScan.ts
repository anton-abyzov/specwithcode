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

/**
 * True when the volume holding `directory` treats `A` and `a` as one name. The
 * probe file goes in the folder's parent, so the target itself is never touched.
 */
export async function caseInsensitiveAt(directory: string): Promise<boolean> {
  let probe = NodePath.dirname(directory);
  while (!(await exists(probe))) {
    const parent = NodePath.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const name = `.swc-case-probe-${process.pid}-${Date.now()}`;
  const file = NodePath.join(probe, name);
  try {
    await NodeFSP.writeFile(file, "", { flag: "wx" });
    return await exists(NodePath.join(probe, name.toUpperCase()));
  } catch {
    return process.platform === "darwin" || process.platform === "win32";
  } finally {
    await NodeFSP.rm(file, { force: true });
  }
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
