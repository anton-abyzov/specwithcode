// @effect-diagnostics nodeBuiltinImport:off - operation-owned immutable pack reads use no-follow descriptors.
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as Path from "node:path";
import { privateDirectory, writeJson } from "./durable.ts";
import { CHUNK_SIZE, type ManifestEntry } from "./manifest.ts";
import { isSafeRelativePath } from "./paths.ts";
import { sha256Hex } from "./wire.ts";
import { sourceFilesystemAdmission, admitAncestorDevices } from "./sourceCaptureFilesystem.ts";

export interface CapturedSource {
  readonly version: 1;
  readonly capturedAt: number;
  readonly packHash: string;
  readonly indexHash: string;
  readonly manifestHash: string;
}
export type CapturedIndex = Readonly<
  Record<string, { readonly offset: number; readonly size: number }>
>;
const BUFFER = 1024 * 1024;
const invalid = () =>
  new Error("The captured copy files are missing or changed. Measure and compare again.");

class SourceDirectoryChanged extends Error {}

/**
 * Observe ancestors top-down before opening and bottom-up afterwards. Including
 * ancestors above the selected root catches that root being moved too. Nanosecond
 * change times detect a replaced-and-restored directory on local filesystems;
 * cached/coarse network metadata is not an openat-equivalent security boundary.
 */
async function sourceAncestors(
  parent: string,
  admit: ReturnType<typeof sourceFilesystemAdmission>,
) {
  const paths = [parent];
  while (Path.dirname(paths[0]!) !== paths[0]) paths.unshift(Path.dirname(paths[0]!));
  const before: Array<{ path: string; stat: FS.BigIntStats }> = [];
  for (const path of paths) {
    const stat = await FSP.lstat(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid();
    before.push({ path, stat });
  }
  await admitAncestorDevices(before, admit);
  return before;
}
async function unchangedAncestors(before: Awaited<ReturnType<typeof sourceAncestors>>) {
  for (let index = before.length - 1; index >= 0; index--) {
    const { path, stat } = before[index]!;
    const after = await FSP.lstat(path, { bigint: true });
    if (
      !after.isDirectory() ||
      after.isSymbolicLink() ||
      after.dev !== stat.dev ||
      after.ino !== stat.ino ||
      after.ctimeNs !== stat.ctimeNs ||
      after.mtimeNs !== stat.mtimeNs
    )
      throw new SourceDirectoryChanged(
        "The source folder changed while a file was being captured. Try a new comparison.",
      );
  }
}
async function openStableSource(
  root: string,
  relative: string,
  stop: () => void,
  admit: ReturnType<typeof sourceFilesystemAdmission>,
) {
  for (let attempt = 0; ; attempt++) {
    stop();
    try {
      return await openContained(root, relative, admit);
    } catch (cause) {
      if (!(cause instanceof SourceDirectoryChanged) || attempt >= 2) throw cause;
    }
  }
}

/** Check containment again after opening, so a swapped parent cannot redirect the descriptor. */
async function openContained(
  root: string,
  relative: string,
  stableSource?: ReturnType<typeof sourceFilesystemAdmission>,
) {
  if (!isSafeRelativePath(relative)) throw invalid();
  const absolute = Path.join(root, relative);
  const parent = Path.dirname(absolute);
  const ancestors = stableSource ? await sourceAncestors(parent, stableSource) : null;
  if ((await FSP.realpath(parent)) !== parent) throw invalid();
  const file = await FSP.open(absolute, FS.constants.O_RDONLY | FS.constants.O_NOFOLLOW);
  try {
    const [opened, named, real] = await Promise.all([
      file.stat({ bigint: true }),
      FSP.lstat(absolute, { bigint: true }),
      FSP.realpath(parent),
    ]);
    if (
      !opened.isFile() ||
      !named.isFile() ||
      real !== parent ||
      opened.dev !== named.dev ||
      opened.ino !== named.ino
    )
      throw invalid();
    if (ancestors) await unchangedAncestors(ancestors);
    return file;
  } catch (cause) {
    await file.close();
    throw cause;
  }
}

async function digestFile(root: string, name: string, stop: () => void = () => {}) {
  const file = await openContained(root, name);
  try {
    const hash = Crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(BUFFER);
    let position = 0;
    for (;;) {
      stop();
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
      if (!bytesRead) return hash.digest("hex");
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await file.close();
  }
}

/** Persist new directory entries where the platform supports directory fsync. */
export async function syncCapturedDirectory(root: string): Promise<void> {
  let directory: FSP.FileHandle | undefined;
  try {
    directory = await FSP.open(root, "r");
    await directory.sync();
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (
      process.platform !== "win32" ||
      !["EPERM", "EISDIR", "EINVAL", "EBADF", "EACCES"].includes(code ?? "")
    )
      throw cause;
    // Windows does not expose directory fsync; the pack/index/record file handles were synced.
  } finally {
    await directory?.close();
  }
}

/** Cleanup each generated backing even when another directory is temporarily busy. */
export async function removeSourceBackings(paths: ReadonlyArray<string>): Promise<void> {
  const results = await Promise.allSettled(
    paths.map((path) =>
      FSP.rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }),
    ),
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length)
    throw new AggregateError(failures, "Temporary copy snapshot cleanup is pending");
}

/** Persist error codes only, never private paths or raw filesystem error text. */
export function sourceCleanupCodes(cause: unknown): Array<string> {
  const errors = cause instanceof AggregateError ? cause.errors : [cause];
  return [
    ...new Set(
      errors.map((error: unknown) => {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        return typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? code : "UNKNOWN";
      }),
    ),
  ];
}

/** A single fsynced pack avoids one fsync per project file. Source files are never linked or written. */
export async function captureSourceFiles(input: {
  readonly root: string;
  readonly entries: ReadonlyArray<ManifestEntry>;
  readonly sourceRoot: (entry: ManifestEntry) => string;
  readonly stop: () => void;
  readonly progress?: (value: { files: number; bytes: number }) => void;
  readonly freeBytes?: () => Promise<number>;
}): Promise<Omit<CapturedSource, "capturedAt" | "manifestHash">> {
  await privateDirectory(input.root);
  const admit = sourceFilesystemAdmission();
  await admit(input.root, (await FSP.stat(input.root, { bigint: true })).dev);
  input.stop();
  const files = input.entries.filter((entry) => entry.type === "file" && entry.class !== "secret");
  const needed = files.reduce((sum, file) => sum + file.size, 0) + 4096 + files.length * 512;
  const fs = await FSP.statfs(input.root);
  const free = input.freeBytes ? await input.freeBytes() : Number(fs.bavail) * Number(fs.bsize);
  if (needed > free)
    throw new Error(
      `Capturing this copy needs ${needed} bytes free on the source; ${free} are available.`,
    );
  // A previous interrupted build has no published capability and may safely be replaced.
  await FSP.rm(Path.join(input.root, "files.pack"), { force: true });
  await FSP.rm(Path.join(input.root, "index.json"), { force: true });
  const output = await FSP.open(Path.join(input.root, "files.pack"), "wx", 0o600);
  const index: Record<string, { offset: number; size: number }> = Object.create(null);
  let offset = 0;
  let completed = 0;
  try {
    for (const entry of files) {
      input.stop();
      for (let attempt = 0; ; attempt++) {
        const source = await openStableSource(
          input.sourceRoot(entry),
          entry.path,
          input.stop,
          admit,
        );
        try {
          const before = await source.stat();
          await admit(input.sourceRoot(entry), BigInt(before.dev));
          const whole = Crypto.createHash("sha256");
          let chunk = Crypto.createHash("sha256");
          const chunks: string[] = [];
          let inChunk = 0;
          let position = 0;
          const buffer = Buffer.allocUnsafe(BUFFER);
          while (position < before.size) {
            input.stop();
            const want = Math.min(buffer.length, CHUNK_SIZE - inChunk, before.size - position);
            const { bytesRead } = await source.read(buffer, 0, want, position);
            if (!bytesRead) break;
            const bytes = buffer.subarray(0, bytesRead);
            whole.update(bytes);
            chunk.update(bytes);
            let written = 0;
            while (written < bytesRead) {
              const result = await output.write(
                bytes,
                written,
                bytesRead - written,
                offset + position + written,
              );
              if (!result.bytesWritten) throw new Error("Could not write the captured copy.");
              written += result.bytesWritten;
            }
            position += bytesRead;
            inChunk += bytesRead;
            if (inChunk === CHUNK_SIZE) {
              chunks.push(chunk.digest("hex"));
              chunk = Crypto.createHash("sha256");
              inChunk = 0;
            }
          }
          const after = await source.stat();
          if (
            position !== before.size ||
            after.size !== before.size ||
            after.mtimeMs !== before.mtimeMs ||
            after.ctimeMs !== before.ctimeMs
          ) {
            await output.truncate(offset);
            if (attempt < 2) continue;
            throw new Error(
              `The file kept changing while being captured: ${entry.path}. Try a new comparison.`,
            );
          }
          if (inChunk > 0 || chunks.length === 0) chunks.push(chunk.digest("hex"));
          entry.sha256 = whole.digest("hex");
          entry.chunks = chunks;
          entry.size = position;
          entry.mtimeMs = Math.trunc(before.mtimeMs);
          index[entry.path] = { offset, size: position };
          offset += position;
          completed++;
          input.progress?.({ files: completed, bytes: offset });
          break;
        } finally {
          await source.close();
        }
      }
    }
    input.stop();
    await output.truncate(offset);
    await output.sync();
  } finally {
    await output.close();
  }
  const packHash = await digestFile(input.root, "files.pack", input.stop);
  await writeJson(Path.join(input.root, "index.json"), index);
  const indexHash = await digestFile(input.root, "index.json", input.stop);
  await syncCapturedDirectory(input.root);
  return { version: 1, packHash, indexHash };
}

export async function loadCapturedIndex(
  root: string,
  captured: CapturedSource,
): Promise<CapturedIndex> {
  const file = await openContained(root, "index.json");
  try {
    const bytes = await file.readFile();
    if (sha256Hex(bytes) !== captured.indexHash) throw invalid();
    const value = JSON.parse(bytes.toString("utf8")) as CapturedIndex;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
    for (const [path, entry] of Object.entries(value)) {
      if (
        !isSafeRelativePath(path) ||
        !entry ||
        !Number.isSafeInteger(entry.offset) ||
        entry.offset < 0 ||
        !Number.isSafeInteger(entry.size) ||
        entry.size < 0
      )
        throw invalid();
    }
    return value;
  } finally {
    await file.close();
  }
}

export async function validateCapturedSource(
  root: string,
  captured: CapturedSource,
  manifest: Buffer,
) {
  if (captured.version !== 1 || sha256Hex(manifest) !== captured.manifestHash) throw invalid();
  await loadCapturedIndex(root, captured);
  if ((await digestFile(root, "files.pack")) !== captured.packHash) throw invalid();
}

export async function capturedRange(
  root: string,
  index: CapturedIndex,
  path: string,
  offset: number,
  length: number,
) {
  const place = Object.hasOwn(index, path) ? index[path] : undefined;
  if (!place || offset < 0 || length < 0 || offset + length > place.size) throw invalid();
  const file = await openContained(root, "files.pack");
  try {
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const { bytesRead } = await file.read(
        buffer,
        read,
        length - read,
        place.offset + offset + read,
      );
      if (!bytesRead) throw invalid();
      read += bytesRead;
    }
    return buffer;
  } finally {
    await file.close();
  }
}
