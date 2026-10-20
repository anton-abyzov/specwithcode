// @effect-diagnostics nodeBuiltinImport:off - staging writes chunk ranges and clones local copies.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { CHUNK_SIZE, forEachLimited, hashFile, type ManifestEntry } from "./manifest.ts";
import { isSafeRelativePath } from "./paths.ts";
import type { SourceClient } from "./sourceClient.ts";
import { CHUNK_CHANGED, CHUNK_OK, MAX_BATCH_BYTES, MAX_BATCH_CHUNKS, sha256Hex } from "./wire.ts";

/** One file the destination needs, with a local copy to reuse when it has one. */
export interface PullFile {
  path: string;
  sha256: string;
  chunks: Array<string>;
  size: number;
  mode: number;
  mtimeMs: number;
  /** An absolute path on the destination already holding these exact bytes. */
  localSource: string | null;
}

export interface PullProgress {
  readonly filesDone: number;
  readonly filesTotal: number;
  readonly bytesDone: number;
  readonly bytesTotal: number;
  /** Bytes that came from files already on this machine instead of the network. */
  readonly bytesLocal: number;
}

export interface PullResult {
  /** Files whose source kept changing; they are left out and reported. */
  readonly unstable: ReadonlyArray<string>;
  /** Files the source no longer has. */
  readonly vanished: ReadonlyArray<string>;
  /** Manifest entries replaced after a refresh, keyed by path. */
  readonly refreshed: ReadonlyMap<string, ManifestEntry>;
}

const BATCH_CONCURRENCY = 4;
const MAX_REFRESH_ROUNDS = 3;

/** Path in staging for a manifest path; staging never holds links, so no escape is possible. */
export function stagedPath(stagingRoot: string, relative: string): string {
  if (!isSafeRelativePath(relative)) throw new Error("Unsafe path in the received manifest.");
  return NodePath.join(stagingRoot, ...relative.split("/"));
}

async function ensureParent(stagingRoot: string, file: string) {
  const parent = NodePath.dirname(file);
  await NodeFSP.mkdir(parent, { recursive: true, mode: 0o700 });
  const real = await NodeFSP.realpath(parent);
  if (
    real !== parent ||
    !(real === stagingRoot || real.startsWith(`${stagingRoot}${NodePath.sep}`))
  )
    throw new Error("Staging folder resolves outside staging.");
}

/** Hash of each 8 MiB range already written, so a restart keeps verified pieces. */
async function verifiedChunks(
  file: string,
  expected: ReadonlyArray<string>,
  size: number,
): Promise<Set<number>> {
  const done = new Set<number>();
  const handle = await NodeFSP.open(
    file,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
  ).catch(() => null);
  if (!handle) return done;
  try {
    const stat = await handle.stat();
    if (stat.size !== size) return done;
    const buffer = Buffer.allocUnsafe(Math.min(CHUNK_SIZE, Math.max(size, 1)));
    for (let index = 0; index < expected.length; index += 1) {
      const length = Math.min(CHUNK_SIZE, size - index * CHUNK_SIZE);
      const { bytesRead } = await handle.read(buffer, 0, length, index * CHUNK_SIZE);
      if (bytesRead === length && sha256Hex(buffer.subarray(0, length)) === expected[index])
        done.add(index);
    }
  } finally {
    await handle.close();
  }
  return done;
}

async function finishFile(file: string, entry: PullFile) {
  await NodeFSP.chmod(file, entry.mode & 0o777);
  const seconds = entry.mtimeMs / 1000;
  await NodeFSP.utimes(file, seconds, seconds);
}

/**
 * Pulls every listed file into staging. Chunks already present (from an earlier
 * run, another file, or a local file with the same content) are never fetched
 * again; every network chunk is verified by SHA-256 before it is written.
 */
export async function pullFiles(input: {
  readonly client: SourceClient;
  readonly stagingRoot: string;
  readonly files: Array<PullFile>;
  readonly directories: ReadonlyArray<string>;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: PullProgress) => void;
}): Promise<PullResult> {
  const stagingRoot = await NodeFSP.realpath(input.stagingRoot);
  for (const directory of input.directories) {
    const absolute = stagedPath(stagingRoot, directory);
    await ensureParent(stagingRoot, NodePath.join(absolute, "x"));
  }
  const byPath = new Map(input.files.map((file) => [file.path, file]));
  const refreshed = new Map<string, ManifestEntry>();
  const unstable: Array<string> = [];
  const vanished: Array<string> = [];
  const bytesTotal = input.files.reduce((sum, file) => sum + file.size, 0);
  let bytesDone = 0;
  let bytesLocal = 0;
  let filesDone = 0;
  const report = () =>
    input.onProgress?.({
      filesDone,
      filesTotal: input.files.length,
      bytesDone: Math.min(bytesDone, bytesTotal),
      bytesTotal,
      bytesLocal,
    });

  let pending = [...input.files];
  for (let round = 0; pending.length > 0; round += 1) {
    const changed = new Set<string>();
    const needed = new Map<string, Array<{ file: PullFile; index: number }>>();
    // Local work first: resumed pieces and local copies cost no network.
    await forEachLimited(pending, 8, async (file) => {
      input.signal?.throwIfAborted();
      const target = stagedPath(stagingRoot, file.path);
      await ensureParent(stagingRoot, target);
      if (file.localSource) {
        try {
          await NodeFSP.copyFile(file.localSource, target, NodeFS.constants.COPYFILE_FICLONE);
          const copied = await hashFile(target, false);
          if (copied.sha256 === file.sha256 && copied.size === file.size) {
            await finishFile(target, file);
            bytesDone += file.size;
            bytesLocal += file.size;
            filesDone += 1;
            report();
            return;
          }
        } catch {
          // The local copy moved or changed since the preview; fetch it instead.
        }
      }
      const present = await verifiedChunks(target, file.chunks, file.size);
      if (present.size === file.chunks.length) {
        await finishFile(target, file);
        bytesDone += file.size;
        filesDone += 1;
        report();
        return;
      }
      const handle = await NodeFSP.open(
        target,
        NodeFS.constants.O_RDWR | NodeFS.constants.O_CREAT | NodeFS.constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.truncate(file.size);
      } finally {
        await handle.close();
      }
      for (const index of present)
        bytesDone += Math.min(CHUNK_SIZE, file.size - index * CHUNK_SIZE);
      file.chunks.forEach((sha, index) => {
        if (present.has(index)) return;
        const list = needed.get(sha) ?? [];
        list.push({ file, index });
        needed.set(sha, list);
      });
    });
    report();

    const remaining = new Map<PullFile, number>();
    for (const targets of needed.values())
      for (const { file } of targets) remaining.set(file, (remaining.get(file) ?? 0) + 1);
    const batches: Array<Array<string>> = [];
    let batch: Array<string> = [];
    let batchBytes = 0;
    for (const [sha, targets] of needed) {
      const first = targets[0]!;
      const length = Math.min(CHUNK_SIZE, first.file.size - first.index * CHUNK_SIZE);
      if (batch.length >= MAX_BATCH_CHUNKS || batchBytes + length > MAX_BATCH_BYTES) {
        batches.push(batch);
        batch = [];
        batchBytes = 0;
      }
      batch.push(sha);
      batchBytes += length;
    }
    if (batch.length) batches.push(batch);

    await forEachLimited(batches, BATCH_CONCURRENCY, async (hashes) => {
      input.signal?.throwIfAborted();
      const frames = await input.client.chunks(hashes);
      const seen = new Set<string>();
      for (const frame of frames) {
        input.signal?.throwIfAborted();
        const targets = needed.get(frame.sha256);
        if (!targets || seen.has(frame.sha256)) continue;
        seen.add(frame.sha256);
        if (frame.status !== CHUNK_OK || sha256Hex(frame.data) !== frame.sha256) {
          for (const { file } of targets) changed.add(file.path);
          continue;
        }
        for (const { file, index } of targets) {
          if (changed.has(file.path)) continue;
          const handle = await NodeFSP.open(
            stagedPath(stagingRoot, file.path),
            NodeFS.constants.O_WRONLY | NodeFS.constants.O_NOFOLLOW,
          );
          try {
            await handle.write(frame.data, 0, frame.data.length, index * CHUNK_SIZE);
          } finally {
            await handle.close();
          }
          bytesDone += frame.data.length;
          const left = (remaining.get(file) ?? 1) - 1;
          remaining.set(file, left);
          if (left === 0) {
            await finishFile(stagedPath(stagingRoot, file.path), file);
            filesDone += 1;
          }
        }
        report();
      }
      for (const sha of hashes)
        if (!seen.has(sha)) for (const { file } of needed.get(sha) ?? []) changed.add(file.path);
    });

    if (changed.size === 0) break;
    if (round >= MAX_REFRESH_ROUNDS) {
      unstable.push(...changed);
      break;
    }
    // The source re-reads what changed; only those files are pulled again.
    const updates = await input.client.refresh([...changed]);
    pending = [];
    for (const update of updates) {
      const file = byPath.get(update.path);
      if (!file) continue;
      if ("missing" in update) {
        vanished.push(update.path);
        continue;
      }
      if (update.type !== "file" || !update.sha256 || !update.chunks) continue;
      refreshed.set(update.path, update);
      Object.assign(file, {
        sha256: update.sha256,
        chunks: update.chunks,
        size: update.size,
        mode: update.mode,
        mtimeMs: update.mtimeMs,
        localSource: null,
      });
      pending.push(file);
    }
  }
  return { unstable, vanished, refreshed };
}

/**
 * The final consistency pass: anything whose size or mtime differs on the source
 * now is refreshed and pulled again, up to three rounds; what still moves is flagged.
 */
export async function finalPass(input: {
  readonly client: SourceClient;
  readonly stagingRoot: string;
  readonly files: Array<PullFile>;
  readonly links: ReadonlyArray<{ path: string; target: string }>;
  readonly signal?: AbortSignal;
}): Promise<
  PullResult & { readonly linkChanges: ReadonlyArray<{ path: string; target: string | null }> }
> {
  const byPath = new Map(input.files.map((file) => [file.path, file]));
  const refreshed = new Map<string, ManifestEntry>();
  const unstable = new Set<string>();
  const vanished = new Set<string>();
  const linkChanges: Array<{ path: string; target: string | null }> = [];
  const linkTargets = new Map(input.links.map((link) => [link.path, link.target]));
  const paths = [...byPath.keys(), ...linkTargets.keys()];
  for (let round = 0; round <= MAX_REFRESH_ROUNDS; round += 1) {
    const changed: Array<string> = [];
    for (let start = 0; start < paths.length; start += 5000) {
      input.signal?.throwIfAborted();
      for (const now of await input.client.stat(paths.slice(start, start + 5000))) {
        const file = byPath.get(now.path);
        if (now.missing) {
          if (file) vanished.add(now.path);
          else linkChanges.push({ path: now.path, target: null });
          continue;
        }
        if (file && (now.type !== "file" || now.size !== file.size || now.mtimeMs !== file.mtimeMs))
          changed.push(now.path);
        if (!file && now.target !== linkTargets.get(now.path)) {
          linkChanges.push({ path: now.path, target: now.target ?? null });
          linkTargets.set(now.path, now.target ?? "");
        }
      }
    }
    if (changed.length === 0) break;
    if (round === MAX_REFRESH_ROUNDS) {
      for (const path of changed) unstable.add(path);
      break;
    }
    const again = changed.map((path) => byPath.get(path)!).filter(Boolean);
    const updates = await input.client.refresh(changed);
    for (const update of updates) {
      const file = byPath.get(update.path);
      if (!file) continue;
      if ("missing" in update) {
        vanished.add(update.path);
        continue;
      }
      if (update.type !== "file" || !update.sha256 || !update.chunks) continue;
      refreshed.set(update.path, update);
      Object.assign(file, {
        sha256: update.sha256,
        chunks: update.chunks,
        size: update.size,
        mode: update.mode,
        mtimeMs: update.mtimeMs,
        localSource: null,
      });
    }
    const pulled = await pullFiles({
      client: input.client,
      stagingRoot: input.stagingRoot,
      files: again.filter((file) => !vanished.has(file.path)),
      directories: [],
      ...(input.signal ? { signal: input.signal } : {}),
    });
    for (const path of pulled.unstable) unstable.add(path);
    for (const path of pulled.vanished) vanished.add(path);
    for (const [path, entry] of pulled.refreshed) refreshed.set(path, entry);
  }
  return { unstable: [...unstable], vanished: [...vanished], refreshed, linkChanges };
}

export const randomId = () => NodeCrypto.randomUUID();
