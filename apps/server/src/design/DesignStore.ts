// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off globalRandom:off - Plain promises over the owner's files, like ProjectLibrary.
/**
 * Files of designs and design systems under one owner's design root: a
 * project's `<checkout>/.specweave/design`, or the Playground's
 * `<app home>/design/playground`. Callers resolve the root from the owner
 * (`DesignService`); nothing here accepts a path from a client.
 *
 *   <designId>/design.json                 the head document
 *   <designId>/assets/<sha256>.<ext>       images, named by content hash
 *   <designId>/.history/<revision>.json    autosave revisions, last 100 (git-ignored)
 *   <designId>/.history/index.json         who saved each kept revision, and when
 *   <designId>/versions/<revision>-<slug>.json  named versions, committed with the project
 *   systems/<systemId>/system.json         design systems, with the same history layout
 *
 * Every write is compare-and-set on `revision` under `.history/.lock` (an
 * exclusive file, so two server processes serialize too) and lands by an
 * atomic rename. A stale write fails with `conflict` and the revision on
 * disk; it never overwrites.
 *
 * Design-system API (the design-systems lane persists through these):
 *
 *   listDesignSystems(root)
 *     -> { systems: DesignSystem[], problems: { id, detail }[] }, newest first.
 *   readDesignSystem(root, systemId, revision?)
 *     -> DesignSystem; `revision` reads a kept autosave revision. Throws not_found.
 *   writeDesignSystem(root, system, { expectedRevision, actor, now? })
 *     -> the stored DesignSystem. `expectedRevision: null` creates it (conflict
 *        when the id exists) at revision 0; a number must equal the revision
 *        on disk and stores revision + 1. `updatedAt` is set here; `id` must
 *        match an existing system. The input is validated against
 *        `DesignSystem` before anything is written.
 *   deleteDesignSystem(root, systemId, expectedRevision?)
 *     -> true when removed, false when already gone; `conflict` on a stale revision.
 *   designSystemHistory(root, systemId) -> DesignHistoryEntry[], newest first.
 *
 * Failures are `DesignStoreProblem` with a `DesignError` code.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  DESIGN_AUTOSAVE_REVISIONS_KEPT,
  DesignDocument,
  DesignSystem,
  type DesignActor,
  type DesignHistoryEntry,
} from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";

export type DesignStoreCode =
  | "not_found"
  | "invalid"
  | "conflict"
  | "forbidden"
  | "too_large"
  | "operation_failed";

export class DesignStoreProblem extends Error {
  readonly code: DesignStoreCode;
  /** Conflicts only: the revision now on disk. */
  readonly currentRevision: number | undefined;
  constructor(code: DesignStoreCode, message: string, currentRevision?: number) {
    super(message);
    this.code = code;
    this.currentRevision = currentRevision;
  }
}

export const DESIGN_FILE = "design.json";
export const DESIGN_SYSTEM_FILE = "system.json";
export const DESIGN_SYSTEMS_DIR = "systems";
export const DESIGN_ASSETS_DIR = "assets";
export const DESIGN_HISTORY_DIR = ".history";
export const DESIGN_VERSIONS_DIR = "versions";
const LOCK_FILE = ".lock";
const INDEX_FILE = "index.json";
const MAX_RECORD_BYTES = 64 * 1024 * 1024;
const MAX_ASSET_BYTES = 10 * 1024 * 1024;
const LOCK_WAIT_MS = 10_000;
/** A lock older than this was left by a process that died mid-write. */
const LOCK_STALE_MS = 30_000;

const ID = /^[A-Za-z0-9_-]{1,80}$/;
const ASSET = /^[a-f0-9]{64}\.(png|jpe?g|gif|webp|svg)$/;

interface StoredRecord {
  readonly id: string;
  readonly revision: number;
  readonly updatedAt: string;
}

interface RecordKind<T extends StoredRecord> {
  readonly file: string;
  readonly label: string;
  readonly decode: (value: unknown) => T;
}

const DESIGN: RecordKind<DesignDocument> = {
  file: DESIGN_FILE,
  label: "design",
  decode: Schema.decodeUnknownSync(DesignDocument) as (value: unknown) => DesignDocument,
};
const SYSTEM: RecordKind<DesignSystem> = {
  file: DESIGN_SYSTEM_FILE,
  label: "design system",
  decode: Schema.decodeUnknownSync(DesignSystem) as (value: unknown) => DesignSystem,
};

interface IndexEntry {
  readonly revision: number;
  readonly savedAt: string;
  readonly actor: DesignActor;
}

interface VersionFile<T> {
  readonly name: string;
  readonly revision: number;
  readonly savedAt: string;
  readonly actor: DesignActor;
  readonly document: T;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function checkId(id: string, label: string): string {
  if (!ID.test(id) || id === DESIGN_SYSTEMS_DIR) {
    throw new DesignStoreProblem("invalid", `${id} is not a valid ${label} id.`);
  }
  return id;
}

/** A record's folder and the design root it lies under; every folder between them is checked. */
interface Place {
  readonly root: string;
  readonly dir: string;
}

const designDir = (root: string, designId: string) =>
  NodePath.join(root, checkId(designId, "design"));
const designPlace = (root: string, designId: string): Place => ({
  root,
  dir: designDir(root, designId),
});
const systemPlace = (root: string, systemId: string): Place => ({
  root,
  dir: NodePath.join(root, DESIGN_SYSTEMS_DIR, checkId(systemId, "design system")),
});

const revisionFile = (revision: number) => `${String(revision).padStart(9, "0")}.json`;

const isMissing = (error: unknown) =>
  (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

/**
 * The design root `relative` below `base`, refusing a symlink anywhere along
 * the way so a checkout cannot point design writes outside itself. With
 * `create` it makes the missing folders; without, a missing root is `null`.
 */
export async function resolveDesignRoot(
  base: string,
  relative: string,
  options: { readonly create: boolean; readonly mode?: number },
): Promise<string | null> {
  const realBase = await NodeFSP.realpath(base).catch((error: unknown) => {
    if (isMissing(error)) throw new DesignStoreProblem("not_found", "The folder is missing.");
    throw error;
  });
  let current = realBase;
  for (const segment of relative.split("/").filter(Boolean)) {
    current = NodePath.join(current, segment);
    const stat = await NodeFSP.lstat(current).catch((error: unknown) => {
      if (isMissing(error)) return null;
      throw error;
    });
    if (stat === null) {
      if (!options.create) return null;
      await NodeFSP.mkdir(current, { mode: options.mode ?? 0o755 }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      });
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new DesignStoreProblem(
        "invalid",
        `${NodePath.relative(realBase, current)} must be a folder, not a link or a file.`,
      );
    }
  }
  return current;
}

/**
 * Where the design root `relative` below `base` is, or would be, and whether it
 * exists. Checks the folders like `resolveDesignRoot` but never creates one, so
 * reads and scans leave a checkout untouched.
 */
export async function locateDesignRoot(
  base: string,
  relative: string,
): Promise<{ readonly root: string; readonly exists: boolean }> {
  const found = await resolveDesignRoot(base, relative, { create: false });
  return found !== null
    ? { root: found, exists: true }
    : { root: NodePath.join(await NodeFSP.realpath(base), relative), exists: false };
}

const lstatOrNull = (path: string) =>
  NodeFSP.lstat(path).catch((error: unknown) => {
    if (isMissing(error)) return null;
    throw error;
  });

const notPlain = (root: string, path: string) =>
  new DesignStoreProblem(
    "invalid",
    `${NodePath.relative(root, path) || "."} must be a folder, not a link or a file.`,
  );

/**
 * Checks every folder from the design root down to `path` with lstat: a link or
 * a file anywhere on the way is refused, so a checkout that ships
 * `systems -> /elsewhere` cannot move reads or writes outside it. False at the
 * first missing folder; with `create`, missing folders are made one at a time.
 */
async function plainFolders(root: string, path: string, create = false): Promise<boolean> {
  const relative = NodePath.relative(root, path);
  if (relative.startsWith("..") || NodePath.isAbsolute(relative)) throw notPlain(root, path);
  let current = root;
  for (const segment of relative.split(NodePath.sep).filter(Boolean)) {
    current = NodePath.join(current, segment);
    let stat = await lstatOrNull(current);
    if (stat === null) {
      if (!create) return false;
      await NodeFSP.mkdir(current).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      });
      stat = await lstatOrNull(current);
    }
    if (stat === null || stat.isSymbolicLink() || !stat.isDirectory()) {
      throw notPlain(root, current);
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Reading and writing files
// ---------------------------------------------------------------------------

async function readJson(file: string): Promise<unknown> {
  let handle: NodeFSP.FileHandle;
  try {
    // O_NOFOLLOW: a record file that is a symlink is refused, not followed.
    handle = await NodeFSP.open(file, NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW);
  } catch (error) {
    if (isMissing(error)) throw new DesignStoreProblem("not_found", "Not found.");
    if ((error as NodeJS.ErrnoException).code === "ELOOP")
      throw new DesignStoreProblem("invalid", `${NodePath.basename(file)} is a link.`);
    throw error;
  }
  try {
    const { size } = await handle.stat();
    if (size > MAX_RECORD_BYTES) {
      throw new DesignStoreProblem("too_large", `${NodePath.basename(file)} is over 64 MiB.`);
    }
    const text = await handle.readFile("utf8");
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new DesignStoreProblem("invalid", `${NodePath.basename(file)} is not valid JSON.`);
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function decode<T extends StoredRecord>(kind: RecordKind<T>, value: unknown, where: string): T {
  try {
    return kind.decode(value);
  } catch (error) {
    throw new DesignStoreProblem(
      "invalid",
      `The ${kind.label} at ${where} does not match its schema: ${firstLine(error)}`,
    );
  }
}

const firstLine = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).split("\n").slice(0, 3).join(" ");

async function writeAtomic(file: string, data: string | Uint8Array, mode = 0o644) {
  const temp = `${file}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    await NodeFSP.writeFile(temp, data, { flag: "wx", mode });
    await NodeFSP.rename(temp, file);
  } finally {
    await NodeFSP.rm(temp, { force: true }).catch(() => undefined);
  }
}

const serialize = (value: unknown) => {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(text) > MAX_RECORD_BYTES) {
    throw new DesignStoreProblem("too_large", "The document would be over 64 MiB.");
  }
  return text;
};

async function ensureHistoryDir(place: Place): Promise<string> {
  const history = NodePath.join(place.dir, DESIGN_HISTORY_DIR);
  await plainFolders(place.root, history, true);
  const ignore = NodePath.join(history, ".gitignore");
  // Autosave revisions are local; named versions travel with the repository.
  await NodeFSP.writeFile(ignore, "*\n", { flag: "wx" }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
  return history;
}

// ---------------------------------------------------------------------------
// Locking
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Writers in this process queue here, so only writers from other processes spin on the file. */
const queues = new Map<string, Promise<void>>();

/** The token a lock file holds, or null when it is missing or unreadable. */
async function lockToken(lock: string): Promise<string | null> {
  const text = await NodeFSP.readFile(lock, "utf8").catch(() => null);
  if (text === null) return null;
  try {
    const token = (JSON.parse(text) as { token?: unknown }).token;
    return typeof token === "string" ? token : null;
  } catch {
    return null;
  }
}

/**
 * Removes the lock only while it still holds `token`. The file is moved aside
 * first, so a lock another writer took in between is put back, not deleted.
 */
async function removeLockIf(lock: string, token: string | null): Promise<void> {
  const aside = `${lock}.${NodeCrypto.randomUUID()}.release`;
  try {
    await NodeFSP.rename(lock, aside);
  } catch {
    return;
  }
  try {
    if ((await lockToken(aside)) !== token) {
      await NodeFSP.link(aside, lock).catch(() => undefined);
    }
  } finally {
    await NodeFSP.rm(aside, { force: true }).catch(() => undefined);
  }
}

async function acquireFileLock(lock: string): Promise<string> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  const token = NodeCrypto.randomUUID();
  for (;;) {
    try {
      const handle = await NodeFSP.open(lock, "wx", 0o600);
      try {
        await handle.writeFile(
          JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token }),
        );
      } finally {
        await handle.close().catch(() => undefined);
      }
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    // Stale means the same holder for longer than a write can take, judged by its token.
    const held = await lockToken(lock);
    const stat = await NodeFSP.lstat(lock).catch(() => null);
    if (stat !== null && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
      await removeLockIf(lock, held);
      continue;
    }
    if (Date.now() > deadline) {
      throw new DesignStoreProblem(
        "conflict",
        "This design is being saved elsewhere. Try again in a moment.",
      );
    }
    await sleep(20 + Math.floor(Math.random() * 60));
  }
}

/**
 * Runs `run` holding the record's lock. The record's folder must already exist
 * as a plain folder, so an unknown or linked id never leaves a `.history` behind.
 */
async function withLock<A>(place: Place, run: () => Promise<A>): Promise<A> {
  if (!(await plainFolders(place.root, place.dir))) {
    throw new DesignStoreProblem("not_found", `No ${NodePath.basename(place.dir)}.`);
  }
  const history = await ensureHistoryDir(place);
  const lock = NodePath.join(history, LOCK_FILE);
  const previous = queues.get(lock) ?? Promise.resolve();
  let release = () => {};
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => mine);
  queues.set(lock, tail);
  await previous;
  try {
    const token = await acquireFileLock(lock);
    try {
      return await run();
    } finally {
      await removeLockIf(lock, token);
    }
  } finally {
    release();
    if (queues.get(lock) === tail) queues.delete(lock);
  }
}

// ---------------------------------------------------------------------------
// Generic records (designs and systems)
// ---------------------------------------------------------------------------

async function readHead<T extends StoredRecord>(kind: RecordKind<T>, place: Place): Promise<T> {
  const { dir } = place;
  if (!(await plainFolders(place.root, dir))) {
    throw new DesignStoreProblem("not_found", `No ${kind.label} ${NodePath.basename(dir)}.`);
  }
  let raw: unknown;
  try {
    raw = await readJson(NodePath.join(dir, kind.file));
  } catch (error) {
    if (error instanceof DesignStoreProblem && error.code === "not_found") {
      throw new DesignStoreProblem("not_found", `No ${kind.label} ${NodePath.basename(dir)}.`);
    }
    throw error;
  }
  const record = decode(kind, raw, kind.file);
  if (record.id !== NodePath.basename(dir)) {
    throw new DesignStoreProblem(
      "invalid",
      `${kind.file} names ${record.id}, but its folder is ${NodePath.basename(dir)}.`,
    );
  }
  return record;
}

const revisionOf = (name: string) => {
  const match = /^(\d{9})\.json$/.exec(name);
  return match ? Number(match[1]) : null;
};

const isIndexEntry = (value: unknown): value is IndexEntry => {
  const entry = value as Partial<IndexEntry> | null;
  return (
    typeof entry === "object" &&
    entry !== null &&
    Number.isInteger(entry.revision) &&
    typeof entry.savedAt === "string" &&
    typeof entry.actor === "object" &&
    entry.actor !== null
  );
};

/**
 * The kept revisions. `trusted` is false when the index is unreadable, or
 * missing while older revisions exist: then nothing may be pruned on its word.
 */
async function readIndex(
  place: Place,
  writing?: number,
): Promise<{ readonly entries: IndexEntry[]; readonly trusted: boolean }> {
  const history = NodePath.join(place.dir, DESIGN_HISTORY_DIR);
  if (!(await plainFolders(place.root, history))) return { entries: [], trusted: true };
  try {
    const raw = await readJson(NodePath.join(history, INDEX_FILE));
    return Array.isArray(raw) && raw.every(isIndexEntry)
      ? { entries: raw, trusted: true }
      : { entries: [], trusted: false };
  } catch (error) {
    if (!(error instanceof DesignStoreProblem)) throw error;
    if (error.code !== "not_found") return { entries: [], trusted: false };
  }
  const older = (await NodeFSP.readdir(history)).some((name) => {
    const revision = revisionOf(name);
    return revision !== null && (writing === undefined || revision < writing);
  });
  return { entries: [], trusted: !older };
}

/** Reported once per folder; the history keeps every revision until the index is fixed. */
const warnedIndexes = new Set<string>();
const warnUntrustedIndex = (history: string) => {
  if (warnedIndexes.has(history)) return;
  warnedIndexes.add(history);
  process.emitWarning(
    `${NodePath.join(history, INDEX_FILE)} is unreadable or missing; autosave revisions are kept and not pruned.`,
    { code: "STUDIO_DESIGN_HISTORY_INDEX" },
  );
};

/** Writes `next` as the head and as an autosave revision, keeping the newest 100. */
async function commit<T extends StoredRecord>(
  kind: RecordKind<T>,
  place: Place,
  next: T,
  actor: DesignActor,
): Promise<T> {
  const { dir } = place;
  const valid = decode(kind, next, kind.file);
  const text = serialize(valid);
  const history = NodePath.join(dir, DESIGN_HISTORY_DIR);
  const read = await readIndex(place, valid.revision);
  await writeAtomic(NodePath.join(history, revisionFile(valid.revision)), text);
  if (!read.trusted) {
    // Never prune, or overwrite the index, on an index we cannot read.
    await writeAtomic(NodePath.join(dir, kind.file), text);
    warnUntrustedIndex(history);
    return valid;
  }
  const index = read.entries.filter((entry) => entry.revision !== valid.revision);
  index.push({ revision: valid.revision, savedAt: valid.updatedAt, actor });
  index.sort((left, right) => left.revision - right.revision);
  const dropped = index.splice(0, Math.max(0, index.length - DESIGN_AUTOSAVE_REVISIONS_KEPT));
  await writeAtomic(NodePath.join(dir, kind.file), text);
  await writeAtomic(NodePath.join(history, INDEX_FILE), serialize(index));
  await pruneHistory(history, new Set(index.map((entry) => entry.revision)), dropped);
  return valid;
}

async function pruneHistory(
  history: string,
  kept: ReadonlySet<number>,
  dropped: readonly IndexEntry[],
) {
  for (const entry of dropped) {
    await NodeFSP.rm(NodePath.join(history, revisionFile(entry.revision)), { force: true });
  }
  // Revisions written by a writer that died before updating the index.
  for (const name of await NodeFSP.readdir(history).catch(() => [] as string[])) {
    const revision = revisionOf(name);
    if (revision !== null && !kept.has(revision)) {
      await NodeFSP.rm(NodePath.join(history, name), { force: true });
    }
  }
}

async function createRecord<T extends StoredRecord>(
  kind: RecordKind<T>,
  place: Place,
  record: T,
  actor: DesignActor,
): Promise<T> {
  const { dir } = place;
  await plainFolders(place.root, NodePath.dirname(dir), true);
  try {
    await NodeFSP.mkdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new DesignStoreProblem("conflict", `A ${kind.label} ${record.id} already exists.`);
    }
    throw error;
  }
  try {
    return await withLock(place, () => commit(kind, place, { ...record, revision: 0 }, actor));
  } catch (error) {
    await NodeFSP.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function updateRecord<T extends StoredRecord>(
  kind: RecordKind<T>,
  place: Place,
  input: {
    readonly expectedRevision: number;
    readonly actor: DesignActor;
    readonly now: string;
    readonly change: (current: T) => T | Promise<T>;
  },
): Promise<T> {
  return withLock(place, async () => {
    const current = await readHead(kind, place);
    if (current.revision !== input.expectedRevision) {
      throw new DesignStoreProblem(
        "conflict",
        `The ${kind.label} is at revision ${current.revision}, not ${input.expectedRevision}. Read it again and reapply the change.`,
        current.revision,
      );
    }
    const changed = await input.change(current);
    return commit(
      kind,
      place,
      { ...changed, id: current.id, revision: current.revision + 1, updatedAt: input.now },
      input.actor,
    );
  });
}

async function readVersions<T extends StoredRecord>(
  kind: RecordKind<T>,
  place: Place,
): Promise<Array<VersionFile<T> & { readonly file: string }>> {
  const folder = NodePath.join(place.dir, DESIGN_VERSIONS_DIR);
  if (!(await plainFolders(place.root, folder))) return [];
  const out: Array<VersionFile<T> & { readonly file: string }> = [];
  for (const name of await NodeFSP.readdir(folder)) {
    if (!/^\d{9}-[a-z0-9-]+\.json$/.test(name)) continue;
    const raw = (await readJson(NodePath.join(folder, name)).catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (raw === null || typeof raw.name !== "string" || typeof raw.savedAt !== "string") continue;
    try {
      const document = decode(kind, raw.document, `${DESIGN_VERSIONS_DIR}/${name}`);
      out.push({
        file: name,
        name: raw.name,
        revision: document.revision,
        savedAt: raw.savedAt,
        actor: raw.actor as DesignActor,
        document,
      });
    } catch {
      // A version someone edited by hand is skipped, not fatal to the history.
    }
  }
  return out;
}

async function readRevision<T extends StoredRecord>(
  kind: RecordKind<T>,
  place: Place,
  revision: number,
): Promise<T> {
  const head = await readHead(kind, place);
  if (head.revision === revision) return head;
  const history = NodePath.join(place.dir, DESIGN_HISTORY_DIR);
  if (await plainFolders(place.root, history)) {
    try {
      const raw = await readJson(NodePath.join(history, revisionFile(revision)));
      return decode(kind, raw, `${DESIGN_HISTORY_DIR}/${revisionFile(revision)}`);
    } catch (error) {
      if (!(error instanceof DesignStoreProblem) || error.code !== "not_found") throw error;
    }
  }
  const version = (await readVersions(kind, place)).find((entry) => entry.revision === revision);
  if (version) return version.document;
  throw new DesignStoreProblem(
    "not_found",
    `Revision ${revision} is no longer kept. Autosave keeps the last ${DESIGN_AUTOSAVE_REVISIONS_KEPT}; named versions are kept for good.`,
  );
}

async function recordHistory<T extends StoredRecord>(
  kind: RecordKind<T>,
  place: Place,
): Promise<DesignHistoryEntry[]> {
  await readHead(kind, place);
  const revisions: DesignHistoryEntry[] = (await readIndex(place)).entries.map((entry) => ({
    kind: "revision",
    revision: entry.revision,
    name: null,
    savedAt: entry.savedAt,
    actor: entry.actor,
  }));
  const versions: DesignHistoryEntry[] = (await readVersions(kind, place)).map((entry) => ({
    kind: "version",
    revision: entry.revision,
    name: entry.name,
    savedAt: entry.savedAt,
    actor: entry.actor,
  }));
  return [...revisions, ...versions].sort(
    (left, right) =>
      right.savedAt.localeCompare(left.savedAt) ||
      right.revision - left.revision ||
      (left.kind === "version" ? -1 : 1),
  );
}

const versionSlug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "") || "version";

/** Suffixes tried after the plain slug when another name at the same revision has it. */
const MAX_SLUG_SUFFIX = 50;

async function saveVersion<T extends StoredRecord>(
  kind: RecordKind<T>,
  place: Place,
  input: {
    readonly name: string;
    readonly actor: DesignActor;
    readonly now: string;
    /** Runs on the head under the lock before anything is written; throw to refuse. */
    readonly check?: ((head: T) => void) | undefined;
  },
): Promise<void> {
  const name = input.name.trim();
  if (!name) throw new DesignStoreProblem("invalid", "Give the version a name.");
  await withLock(place, async () => {
    const head = await readHead(kind, place);
    input.check?.(head);
    const folder = NodePath.join(place.dir, DESIGN_VERSIONS_DIR);
    await plainFolders(place.root, folder, true);
    const body = serialize({
      name,
      revision: head.revision,
      savedAt: input.now,
      actor: input.actor,
      document: head,
    } satisfies VersionFile<T>);
    const prefix = `${revisionFile(head.revision).slice(0, 9)}-${versionSlug(name)}`;
    // Versions are immutable: the same name at the same revision again is a no-op, and another
    // name that slugs the same ("Final", "final!") gets the next free suffix.
    for (let attempt = 1; attempt <= MAX_SLUG_SUFFIX; attempt++) {
      const file = NodePath.join(folder, `${prefix}${attempt === 1 ? "" : `-${attempt}`}.json`);
      const temp = `${file}.${NodeCrypto.randomUUID()}.tmp`;
      try {
        await NodeFSP.writeFile(temp, body, { flag: "wx", mode: 0o644 });
        const linked = await NodeFSP.link(temp, file).then(
          () => true,
          (error: unknown) => {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            return false;
          },
        );
        if (linked) return;
      } finally {
        await NodeFSP.rm(temp, { force: true }).catch(() => undefined);
      }
      const existing = (await readJson(file).catch(() => null)) as { name?: unknown } | null;
      if (existing?.name === name) return;
    }
    throw new DesignStoreProblem(
      "conflict",
      `Too many versions named like "${name}" at revision ${head.revision}. Pick another name.`,
    );
  });
}

async function listRecords<T extends StoredRecord>(
  kind: RecordKind<T>,
  parent: string,
  skip: ReadonlySet<string>,
  root: string,
): Promise<{ records: T[]; problems: Array<{ id: string; detail: string }> }> {
  if (!(await plainFolders(root, parent))) return { records: [], problems: [] };
  const records: T[] = [];
  const problems: Array<{ id: string; detail: string }> = [];
  for (const entry of await NodeFSP.readdir(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || skip.has(entry.name) || !ID.test(entry.name)) continue;
    try {
      records.push(await readHead(kind, { root, dir: NodePath.join(parent, entry.name) }));
    } catch (error) {
      if (error instanceof DesignStoreProblem && error.code === "not_found") continue;
      problems.push({ id: entry.name, detail: firstLine(error) });
    }
  }
  records.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return { records, problems };
}

// ---------------------------------------------------------------------------
// Designs
// ---------------------------------------------------------------------------

const now = () => new Date().toISOString();

export async function listDesigns(root: string) {
  const { records, problems } = await listRecords(
    DESIGN,
    root,
    new Set([DESIGN_SYSTEMS_DIR]),
    root,
  );
  return { documents: records, problems };
}

/** The head, or a kept revision or named version when `revision` is given. */
export async function readDesign(root: string, designId: string, revision?: number) {
  const place = designPlace(root, designId);
  return revision === undefined ? readHead(DESIGN, place) : readRevision(DESIGN, place, revision);
}

/** Stores a new design at revision 0; `conflict` when its id is taken. */
export async function createDesign(root: string, document: DesignDocument, actor: DesignActor) {
  return createRecord(DESIGN, designPlace(root, document.id), document, actor);
}

/**
 * Compare-and-set: `change` sees the head at `expectedRevision` and returns
 * the next document, which is stored at revision + 1.
 */
export async function updateDesign(
  root: string,
  designId: string,
  input: {
    readonly expectedRevision: number;
    readonly actor: DesignActor;
    readonly change: (current: DesignDocument) => DesignDocument | Promise<DesignDocument>;
    readonly now?: string;
  },
) {
  return updateRecord(DESIGN, designPlace(root, designId), { ...input, now: input.now ?? now() });
}

/** A new revision with the content of any kept revision or named version. */
export async function restoreDesign(
  root: string,
  designId: string,
  input: {
    readonly revision: number;
    readonly expectedRevision: number;
    readonly actor: DesignActor;
    readonly now?: string;
    /** Runs on the head under the lock before anything changes; throw to refuse. */
    readonly check?: (current: DesignDocument) => void;
  },
) {
  const place = designPlace(root, designId);
  return updateRecord(DESIGN, place, {
    expectedRevision: input.expectedRevision,
    actor: input.actor,
    now: input.now ?? now(),
    change: async (current) => {
      input.check?.(current);
      const {
        thread: _thread,
        access: _access,
        ...source
      } = await readRevision(DESIGN, place, input.revision);
      // Content comes back; who owns it, its thread and its access stay as they are now.
      return {
        ...source,
        id: current.id,
        createdAt: current.createdAt,
        createdBy: current.createdBy,
        copiedFrom: current.copiedFrom,
        ...(current.thread === undefined ? {} : { thread: current.thread }),
        ...(current.access === undefined ? {} : { access: current.access }),
      };
    },
  });
}

export async function designHistory(root: string, designId: string) {
  return recordHistory(DESIGN, designPlace(root, designId));
}

/** Saves the head as a named, immutable version under `versions/`. */
export async function saveDesignVersion(
  root: string,
  designId: string,
  input: {
    readonly name: string;
    readonly actor: DesignActor;
    readonly now?: string;
    /** Runs on the head under the lock; throw to refuse. */
    readonly check?: (current: DesignDocument) => void;
  },
) {
  return saveVersion(DESIGN, designPlace(root, designId), { ...input, now: input.now ?? now() });
}

export async function deleteDesign(
  root: string,
  designId: string,
  check?: (current: DesignDocument) => void,
): Promise<boolean> {
  const place = designPlace(root, designId);
  const { dir } = place;
  if (!(await plainFolders(root, dir))) return false;
  await withLock(place, async () => {
    check?.(await readHead(DESIGN, place));
    // Renamed first, so a reader never sees half a design.
    const trash = NodePath.join(root, `.deleted-${designId}-${NodeCrypto.randomUUID()}`);
    await NodeFSP.rename(dir, trash);
    await NodeFSP.rm(trash, { recursive: true, force: true });
  }).catch((error: unknown) => {
    // The lock file went with the folder.
    if (!isMissing(error)) throw error;
  });
  return true;
}

const ASSET_EXTENSIONS = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
} as const;
export type DesignAssetMimeType = keyof typeof ASSET_EXTENSIONS;

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

/** Stores image bytes as `assets/<sha256>.<ext>` and returns that file name. */
export async function putDesignAsset(
  root: string,
  designId: string,
  bytes: Uint8Array,
  mimeType: DesignAssetMimeType,
  /** Runs on the head under the lock before the file is written; throw to refuse. */
  check?: (current: DesignDocument) => void,
): Promise<string> {
  if (bytes.byteLength > MAX_ASSET_BYTES) {
    throw new DesignStoreProblem("too_large", "An image may be at most 10 MiB.");
  }
  const place = designPlace(root, designId);
  const name = `${NodeCrypto.createHash("sha256").update(bytes).digest("hex")}.${ASSET_EXTENSIONS[mimeType]}`;
  return withLock(place, async () => {
    check?.(await readHead(DESIGN, place));
    const folder = NodePath.join(place.dir, DESIGN_ASSETS_DIR);
    await plainFolders(root, folder, true);
    const file = NodePath.join(folder, name);
    const exists = await NodeFSP.lstat(file).then(
      (stat) => stat.isFile(),
      () => false,
    );
    if (!exists) await writeAtomic(file, bytes);
    return name;
  });
}

/** An asset's bytes and type, or null when the file is missing. */
export async function readDesignAsset(
  root: string,
  designId: string,
  asset: string,
): Promise<{ readonly bytes: Buffer; readonly mimeType: string } | null> {
  if (!ASSET.test(asset)) throw new DesignStoreProblem("invalid", `${asset} is not an asset name.`);
  const folder = NodePath.join(designDir(root, designId), DESIGN_ASSETS_DIR);
  if (!(await plainFolders(root, folder))) return null;
  const file = NodePath.join(folder, asset);
  try {
    const handle = await NodeFSP.open(
      file,
      NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
    );
    try {
      if ((await handle.stat()).size > MAX_ASSET_BYTES) return null;
      return {
        bytes: await handle.readFile(),
        mimeType: MIME_BY_EXTENSION[asset.split(".").pop() ?? ""] ?? "application/octet-stream",
      };
    } finally {
      await handle.close().catch(() => undefined);
    }
  } catch {
    return null;
  }
}

/** The path of an asset that exists as a regular file (not a link) within the size cap. */
export async function designAssetFile(root: string, designId: string, asset: string) {
  if (!ASSET.test(asset)) throw new DesignStoreProblem("invalid", `${asset} is not an asset name.`);
  const folder = NodePath.join(designDir(root, designId), DESIGN_ASSETS_DIR);
  const file = NodePath.join(folder, asset);
  // A linked design or assets folder is refused like everywhere else.
  const info = (await plainFolders(root, folder))
    ? await NodeFSP.lstat(file).catch(() => null)
    : null;
  if (info === null || !info.isFile() || info.size > MAX_ASSET_BYTES) {
    throw new DesignStoreProblem("not_found", `The design has no image ${asset}.`);
  }
  return file;
}

/** Copies the named assets between designs (the copy keeps its images). Missing ones are skipped. */
export async function copyDesignAssets(
  from: { readonly root: string; readonly designId: string },
  to: { readonly root: string; readonly designId: string },
  assets: Iterable<string>,
): Promise<void> {
  for (const asset of new Set(assets)) {
    const read = await readDesignAsset(from.root, from.designId, asset);
    if (read === null) continue;
    await putDesignAsset(to.root, to.designId, read.bytes, read.mimeType as DesignAssetMimeType);
  }
}

/** The folder a watcher observes; `design.json` is replaced by rename inside it. */
export const designFolder = designDir;

// ---------------------------------------------------------------------------
// Design systems (see the API summary at the top of this file)
// ---------------------------------------------------------------------------

export async function listDesignSystems(root: string) {
  const { records, problems } = await listRecords(
    SYSTEM,
    NodePath.join(root, DESIGN_SYSTEMS_DIR),
    new Set(),
    root,
  );
  return { systems: records, problems };
}

export async function readDesignSystem(root: string, systemId: string, revision?: number) {
  const place = systemPlace(root, systemId);
  return revision === undefined ? readHead(SYSTEM, place) : readRevision(SYSTEM, place, revision);
}

export async function writeDesignSystem(
  root: string,
  system: DesignSystem,
  input: {
    readonly expectedRevision: number | null;
    readonly actor: DesignActor;
    readonly now?: string;
  },
): Promise<DesignSystem> {
  const at = input.now ?? now();
  const place = systemPlace(root, system.id);
  if (input.expectedRevision === null) {
    return createRecord(SYSTEM, place, { ...system, updatedAt: at }, input.actor);
  }
  return updateRecord(SYSTEM, place, {
    expectedRevision: input.expectedRevision,
    actor: input.actor,
    now: at,
    change: () => system,
  });
}

/**
 * Removes a system with its history. With `expectedRevision`, a head at
 * another revision is a `conflict` and nothing is removed. False when the
 * system's folder is already gone.
 */
export async function deleteDesignSystem(
  root: string,
  systemId: string,
  expectedRevision?: number,
): Promise<boolean> {
  const place = systemPlace(root, systemId);
  const { dir } = place;
  if (!(await plainFolders(root, dir))) return false;
  await withLock(place, async () => {
    const current = await readHead(SYSTEM, place);
    if (expectedRevision !== undefined && current.revision !== expectedRevision) {
      throw new DesignStoreProblem(
        "conflict",
        `The design system is at revision ${current.revision}, not ${expectedRevision}. Read it again first.`,
        current.revision,
      );
    }
    // Renamed first, so a reader never sees half a system; a dotted name is never listed.
    const trash = NodePath.join(
      NodePath.dirname(dir),
      `.deleted-${systemId}-${NodeCrypto.randomUUID()}`,
    );
    await NodeFSP.rename(dir, trash);
    await NodeFSP.rm(trash, { recursive: true, force: true });
  }).catch((error: unknown) => {
    // The lock file went with the folder.
    if (!isMissing(error)) throw error;
  });
  return true;
}

export async function designSystemHistory(root: string, systemId: string) {
  return recordHistory(SYSTEM, systemPlace(root, systemId));
}
