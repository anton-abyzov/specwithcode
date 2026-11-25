// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - operation-owned immutable pack reads use no-follow descriptors; retries pause between tries; file stamps are compared with the wall clock.
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as Path from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import { privateDirectory, writeJson } from "./durable.ts";
import { CHUNK_SIZE, forEachLimited, type ManifestEntry } from "./manifest.ts";
import { isSafeRelativePath } from "./paths.ts";
import { sha256Hex } from "./wire.ts";
import {
  CaptureFilesystemRefused,
  sourceFilesystemAdmission,
  admitAncestorDevices,
} from "./sourceCaptureFilesystem.ts";
import {
  linkFromRoot,
  pinSourceRoot,
  reachedFromRoot,
  type RootAnchor,
  type ScannedRoot,
} from "./sourceCaptureAnchor.ts";
import {
  MAX_CONTENT_PROBE_BYTES,
  capturedContentIsSecret,
  contentProbeEligible,
} from "./secretContent.ts";

export interface CapturedSource {
  readonly version: 1;
  readonly capturedAt: number;
  readonly packHash: string;
  readonly indexHash: string;
  readonly manifestHash: string;
}
/** A captured file's identity when its bytes were read, as decimal strings, for later drift checks. */
export interface CapturedStat {
  readonly size: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
  readonly ino: string;
  readonly dev: string;
}
/**
 * A file whose change or modification time is this close to when it was read may have
 * been rewritten within the same clock tick: Linux before multigrain timestamps and
 * NTFS stamp files from a coarse clock. Such a stat is never trusted to skip a read.
 */
const RACY_SLACK_NS = 2_000_000_000n;
/** Whether a stat is old enough, against `readAtNs`, to stand for the bytes read with it. */
export function settledStat(
  stat: Pick<CapturedStat, "mtimeNs" | "ctimeNs">,
  readAtNs: bigint,
): boolean {
  return (
    BigInt(stat.mtimeNs) < readAtNs - RACY_SLACK_NS &&
    BigInt(stat.ctimeNs) < readAtNs - RACY_SLACK_NS
  );
}
export type CapturedIndex = Readonly<
  Record<string, { readonly offset: number; readonly size: number }>
>;
const BUFFER = 1024 * 1024;
/** Files read and hashed at once while the capture runs. */
export const CAPTURE_CONCURRENCY = 12;
/** Files up to one chunk are read whole into memory, so up to 12 x 8 MiB at once. */
const BUFFERED_FILE_MAX = CHUNK_SIZE;
/**
 * A busy machine changes folders above the project (the home folder, agent
 * ledgers) for moments at a time. Each try still needs one unchanged window;
 * waiting longer between tries only lets that window come around.
 */
export const STABLE_ATTEMPTS = 12;
/** All the pauses for one file together, so one restless file cannot stall the capture. */
const FILE_WAIT_MS = 15_000;
const stableDelay = (attempt: number) => Math.min(25 * 2 ** attempt, 2000);
const sleep = (ms: number) => NodeTimersPromises.setTimeout(ms);
const invalid = () => new Error("The captured copy files are missing or changed. Compare again.");

class SourceDirectoryChanged extends Error {}
/** Test seam: runs between the steps of opening one source file, to stage filesystem races. */
export interface CaptureRaceHooks {
  /** After the ancestors were observed, before the file is opened. */
  readonly afterAncestors?: (absolute: string) => Promise<void>;
  /** After the file was opened and named, before its identity is compared. */
  readonly beforeRecheck?: (absolute: string) => Promise<void>;
}
/** Too little room on the source to capture: a moving copy falls back to live checks. */
export class CaptureSpaceRefused extends CaptureFilesystemRefused {}

/**
 * Observe ancestors top-down before opening and bottom-up afterwards. Including
 * ancestors above the selected root catches that root being moved too. Nanosecond
 * change times detect a replaced-and-restored directory on local filesystems;
 * cached/coarse network metadata is not an openat-equivalent security boundary.
 *
 * Folders above the copy root (the home folder, `/Users`) are checked by identity
 * only: the same directory on the same device. Their times change whenever anything
 * beside the project changes, which on a busy machine is all the time, and a
 * replaced folder there still shows as a new identity or a failed realpath check.
 */
async function sourceAncestors(
  root: string,
  parent: string,
  admit: ReturnType<typeof sourceFilesystemAdmission>,
) {
  const paths = [parent];
  while (Path.dirname(paths[0]!) !== paths[0]) paths.unshift(Path.dirname(paths[0]!));
  const before: Array<{ path: string; stat: FS.BigIntStats; identityOnly: boolean }> = [];
  for (const path of paths) {
    const stat = await FSP.lstat(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid();
    before.push({ path, stat, identityOnly: aboveRoot(root, path) });
  }
  await admitAncestorDevices(before, admit);
  return before;
}
/** True for a strict ancestor of the copy root. */
const aboveRoot = (root: string, path: string) => {
  const base = Path.resolve(root);
  return path !== base && (path === Path.parse(base).root || base.startsWith(`${path}${Path.sep}`));
};
async function unchangedAncestors(before: Awaited<ReturnType<typeof sourceAncestors>>) {
  for (let index = before.length - 1; index >= 0; index--) {
    const { path, stat, identityOnly } = before[index]!;
    const after = await FSP.lstat(path, { bigint: true });
    if (
      !after.isDirectory() ||
      after.isSymbolicLink() ||
      after.dev !== stat.dev ||
      after.ino !== stat.ino ||
      (!identityOnly && (after.ctimeNs !== stat.ctimeNs || after.mtimeNs !== stat.mtimeNs))
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
  wait: (attempt: number) => Promise<void>,
  anchor: RootAnchor,
  hooks?: CaptureRaceHooks,
) {
  for (let attempt = 0; ; attempt++) {
    stop();
    try {
      return await openContained(root, relative, admit, anchor, hooks);
    } catch (cause) {
      if (!(cause instanceof SourceDirectoryChanged) || attempt >= STABLE_ATTEMPTS - 1) throw cause;
    }
    await wait(attempt);
  }
}

/** Check containment again after opening, so a swapped parent cannot redirect the descriptor. */
async function openContained(
  root: string,
  relative: string,
  stableSource?: ReturnType<typeof sourceFilesystemAdmission>,
  anchor?: RootAnchor,
  hooks?: CaptureRaceHooks,
) {
  if (!isSafeRelativePath(relative)) throw invalid();
  const absolute = Path.join(root, relative);
  const parent = Path.dirname(absolute);
  const ancestors = stableSource ? await sourceAncestors(root, parent, stableSource) : null;
  await hooks?.afterAncestors?.(absolute);
  if ((await FSP.realpath(parent)) !== parent) throw invalid();
  // Non-blocking, so a FIFO put in a file's place cannot hold the open (and a cancel) forever.
  const file = await FSP.open(
    absolute,
    FS.constants.O_RDONLY | FS.constants.O_NOFOLLOW | (FS.constants.O_NONBLOCK ?? 0),
  );
  try {
    const [opened, named, real] = await Promise.all([
      file.stat({ bigint: true }),
      FSP.lstat(absolute, { bigint: true }),
      FSP.realpath(parent),
    ]);
    await hooks?.beforeRecheck?.(absolute);
    if (
      !opened.isFile() ||
      !named.isFile() ||
      real !== parent ||
      opened.dev !== named.dev ||
      opened.ino !== named.ino
    )
      throw invalid();
    // A folder above the root swapped and put back is invisible to the path checks.
    if (anchor && !(await reachedFromRoot(anchor, relative, opened)))
      throw new SourceDirectoryChanged(
        "The source folder changed while a file was being captured. Try a new comparison.",
      );
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
  /** The pause before another try at a file or folder that changed; tests skip it. */
  readonly retryWait?: (attempt: number) => Promise<void>;
  /**
   * A file that changes on every try: "fail" refuses the capture; "keep-last" keeps
   * its last read, whose hashes match the packed bytes, and lists it in `changing`.
   */
  readonly onChanging?: "fail" | "keep-last";
  /** Proves the source filesystem; defaults to the native check. */
  readonly verifyFilesystem?: (root: string) => Promise<void>;
  /** Wall-clock milliseconds, compared with file stamps; tests pin it. */
  readonly now?: () => number;
  /** Test seam for filesystem races while a file is opened. */
  readonly raceHooks?: CaptureRaceHooks;
  /**
   * Files the scan classified by reading them (`.envrc`, small config files). Their
   * captured bytes are checked again, so one that gained a secret since is refused.
   */
  readonly contentProbed?: ReadonlySet<string> | undefined;
  /** Each source root's identity when it was scanned; the capture refuses another folder there. */
  readonly scannedRoots?: ReadonlyMap<string, ScannedRoot>;
}): Promise<
  Omit<CapturedSource, "capturedAt" | "manifestHash"> & {
    /** Each steadily read file's identity at capture; files in `changing` have none. */
    readonly stats: Record<string, CapturedStat>;
    readonly changing: ReadonlyArray<string>;
  }
> {
  const pause = input.retryWait ?? ((attempt: number) => sleep(stableDelay(attempt)));
  const now = input.now ?? (() => Date.now());
  const keepLast = input.onChanging === "keep-last";
  await privateDirectory(input.root);
  const admit = sourceFilesystemAdmission(input.verifyFilesystem);
  await admit(input.root, (await FSP.stat(input.root, { bigint: true })).dev);
  input.stop();
  const files = input.entries.filter((entry) => entry.type === "file" && entry.class !== "secret");
  const needed = files.reduce((sum, file) => sum + file.size, 0) + 4096 + files.length * 512;
  const fs = await FSP.statfs(input.root);
  const free = input.freeBytes ? await input.freeBytes() : Number(fs.bavail) * Number(fs.bsize);
  if (needed > free)
    throw new CaptureSpaceRefused(
      `Capturing this copy needs ${needed} bytes free on the source; ${free} are available.`,
    );
  // A previous interrupted build has no published capability and may safely be replaced.
  await FSP.rm(Path.join(input.root, "files.pack"), { force: true });
  await FSP.rm(Path.join(input.root, "index.json"), { force: true });
  const anchors = new Map<string, RootAnchor>();
  const closeAnchors = () => Promise.all([...anchors.values()].map((anchor) => anchor.close()));
  const links = input.entries.filter((entry) => entry.type === "symlink");
  try {
    for (const root of new Set([...files, ...links].map(input.sourceRoot)))
      anchors.set(root, await pinSourceRoot(root, process.platform, input.scannedRoots?.get(root)));
    // The scan walked paths: a tree swapped in while it walked, and put back since, could
    // have named a link the pinned tree does not hold. Links travel as named, so check them.
    for (const link of links) {
      input.stop();
      const held = await linkFromRoot(anchors.get(input.sourceRoot(link))!, link.path);
      if (held !== undefined && held !== link.target)
        throw new Error(
          `${link.path} changed after this folder was measured. Try a new comparison.`,
        );
    }
  } catch (cause) {
    await closeAnchors();
    throw cause;
  }
  /**
   * A file the scan judged by its content must still hold no secret (null bytes: too big to
   * judge). So must one it would have judged had it been small then: the scan may have seen
   * another file at that path.
   */
  const assertStillPlain = (entry: ManifestEntry, bytes: Buffer | null, size: number) => {
    const probed = input.contentProbed;
    const judged =
      probed?.has(entry.path) ||
      (probed !== undefined &&
        entry.size > MAX_CONTENT_PROBE_BYTES &&
        size <= MAX_CONTENT_PROBE_BYTES &&
        contentProbeEligible(entry.path, entry.class));
    if (judged && capturedContentIsSecret(entry.path, bytes, size))
      throw new Error(
        `${entry.path} changed since this folder was measured and may now hold a secret. Compare again, then approve secrets separately.`,
      );
  };
  const output = await FSP.open(Path.join(input.root, "files.pack"), "wx", 0o600).catch(
    async (cause: unknown) => {
      await closeAnchors();
      throw cause;
    },
  );
  const index: Record<string, { offset: number; size: number }> = Object.create(null);
  const stats: Record<string, CapturedStat> = Object.create(null);
  const changing: Array<string> = [];
  let offset = 0;
  let completed = 0;
  // Appends to the pack one at a time; several files are read and hashed meanwhile.
  let packTail: Promise<unknown> = Promise.resolve();
  const withPack = <T>(work: () => Promise<T>): Promise<T> => {
    const run = packTail.then(work);
    packTail = run.catch(() => undefined);
    return run;
  };
  const writeAt = async (bytes: Buffer, at: number) => {
    let written = 0;
    while (written < bytes.length) {
      const result = await output.write(bytes, written, bytes.length - written, at + written);
      if (!result.bytesWritten) throw new Error("Could not write the captured copy.");
      written += result.bytesWritten;
    }
  };
  /**
   * Reads one file until a try sees it unchanged. A buffered read (files up to one chunk)
   * keeps the bytes in memory and appends them afterwards; a streamed read holds the pack
   * and writes straight into it at `offset`. Undefined asks for the other route: the file
   * grew past the buffered size, or shrank to it since a buffered try saw it bigger.
   */
  const readStable = async (entry: ManifestEntry, streamed: boolean) => {
    let waited = 0;
    const wait = async (attempt: number) => {
      waited += stableDelay(attempt);
      if (waited > FILE_WAIT_MS)
        throw new Error(
          `The source kept changing while ${entry.path} was being captured. Try a new comparison.`,
        );
      await pause(attempt);
    };
    for (let attempt = 0; ; attempt++) {
      let changed = false;
      const source = await openStableSource(
        input.sourceRoot(entry),
        entry.path,
        input.stop,
        admit,
        wait,
        anchors.get(input.sourceRoot(entry))!,
        input.raceHooks,
      );
      try {
        const before = await source.stat({ bigint: true });
        // Stamped as the read starts: a streamed read writes the pack as it goes, and a slow
        // writer must not age the file past the racy-stamp guard. The earliest moment is the
        // one the bytes can be trusted from.
        const readAtNs = BigInt(Math.trunc(now())) * 1_000_000n;
        await admit(input.sourceRoot(entry), before.dev);
        const size = Number(before.size);
        // The wrong route for the size found now: read it again on the other one.
        if (streamed !== size > BUFFERED_FILE_MAX) return undefined;
        const kept = streamed ? null : Buffer.allocUnsafe(size);
        const whole = Crypto.createHash("sha256");
        let chunk = Crypto.createHash("sha256");
        const chunks: string[] = [];
        let inChunk = 0;
        let position = 0;
        const buffer = streamed ? Buffer.allocUnsafe(BUFFER) : null;
        while (position < size) {
          input.stop();
          const want = Math.min(BUFFER, CHUNK_SIZE - inChunk, size - position);
          const target = kept ?? buffer!;
          const at = kept ? position : 0;
          const { bytesRead } = await source.read(target, at, want, kept ? position : position);
          if (!bytesRead) break;
          const bytes = target.subarray(at, at + bytesRead);
          whole.update(bytes);
          chunk.update(bytes);
          if (!kept) await writeAt(bytes, offset + position);
          position += bytesRead;
          inChunk += bytesRead;
          if (inChunk === CHUNK_SIZE) {
            chunks.push(chunk.digest("hex"));
            chunk = Crypto.createHash("sha256");
            inChunk = 0;
          }
        }
        const after = await source.stat({ bigint: true });
        const moved =
          position !== size ||
          after.size !== before.size ||
          after.mtimeNs !== before.mtimeNs ||
          after.ctimeNs !== before.ctimeNs;
        // With keep-last, the try before the wait budget runs out is the last one.
        const lastTry =
          attempt >= STABLE_ATTEMPTS - 1 ||
          (keepLast && waited + stableDelay(attempt) > FILE_WAIT_MS);
        if (moved && !(keepLast && lastTry)) {
          if (streamed) await output.truncate(offset);
          if (attempt < STABLE_ATTEMPTS - 1) {
            changed = true;
            continue;
          }
          throw new Error(
            `The file kept changing while being captured: ${entry.path}. Try a new comparison.`,
          );
        }
        // A kept last try that came out small was never content-checked: read it whole.
        if (streamed && position <= BUFFERED_FILE_MAX) {
          await output.truncate(offset);
          return undefined;
        }
        if (inChunk > 0 || chunks.length === 0) chunks.push(chunk.digest("hex"));
        return {
          before,
          readAtNs,
          moved,
          position,
          chunks,
          sha256: whole.digest("hex"),
          bytes: kept ? kept.subarray(0, position) : null,
        };
      } finally {
        await source.close();
        // Pause with the file closed, then try it again.
        if (changed) await wait(attempt);
      }
    }
  };
  /** Records a file read at `at` in the pack. Runs inside the pack lane. */
  const record = (
    entry: ManifestEntry,
    read: NonNullable<Awaited<ReturnType<typeof readStable>>>,
  ) => {
    const { before, moved, position, readAtNs } = read;
    const stat = {
      size: String(before.size),
      mtimeNs: String(before.mtimeNs),
      ctimeNs: String(before.ctimeNs),
      ino: String(before.ino),
      dev: String(before.dev),
    };
    if (moved) changing.push(entry.path);
    // A file stamped within a tick of its read could change again unseen: no stat.
    else if (settledStat(stat, readAtNs)) stats[entry.path] = stat;
    entry.sha256 = read.sha256;
    entry.chunks = read.chunks;
    entry.size = position;
    entry.mtimeMs = Number(before.mtimeMs);
    index[entry.path] = { offset, size: position };
    offset += position;
    completed++;
    input.progress?.({ files: completed, bytes: offset });
  };
  /** True once streamed; false when the file shrank to the buffered size before it opened. */
  const captureStreamed = (entry: ManifestEntry) =>
    withPack(async () => {
      // Streamed files are past the probe limit: a probed one grew too big to judge.
      assertStillPlain(entry, null, Number.MAX_SAFE_INTEGER);
      const read = await readStable(entry, true);
      if (!read) return false;
      record(entry, read);
      return true;
    });
  const captureOne = async (entry: ManifestEntry) => {
    // Routed by the size found at each open, not the scan's: a file small when it is read
    // is read whole and its content checked, however it is routed first.
    for (let route = 0; route < STABLE_ATTEMPTS; route++) {
      input.stop();
      const read = await readStable(entry, false);
      if (!read) {
        if (await captureStreamed(entry)) return;
        continue;
      }
      assertStillPlain(entry, read.bytes, read.position);
      await withPack(async () => {
        input.stop();
        await writeAt(read.bytes!, offset);
        record(entry, read);
      });
      return;
    }
    throw new Error(
      `The file kept changing while being captured: ${entry.path}. Try a new comparison.`,
    );
  };
  try {
    await forEachLimited(files, CAPTURE_CONCURRENCY, captureOne);
    await packTail;
    input.stop();
    await output.truncate(offset);
    await output.sync();
  } finally {
    await packTail;
    try {
      await output.close();
    } finally {
      await closeAnchors();
    }
  }
  const packHash = await digestFile(input.root, "files.pack", input.stop);
  await writeJson(Path.join(input.root, "index.json"), index);
  const indexHash = await digestFile(input.root, "index.json", input.stop);
  await syncCapturedDirectory(input.root);
  return { version: 1, packHash, indexHash, stats, changing };
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
