// @effect-diagnostics nodeBuiltinImport:off -- The guard wraps node:fs itself, before Effect loads.
// @effect-diagnostics globalDate:off -- Throttles plain stat calls, outside any Effect.
/**
 * Keeps this process from opening its own live SQLite database outside SQLite.
 *
 * SQLite coordinates processes with POSIX advisory locks on the database file
 * and on its `-shm` index. Those locks belong to the process, not to a file
 * descriptor: closing ANY descriptor this process holds for one of those
 * files drops every lock the process has on it, including the locks SQLite
 * took for the service's own connection. Other processes then see a database
 * nobody uses. The next one to open it, even read-only, believes it is the
 * first: it truncates and rebuilds `-shm` under this process's memory map,
 * which dies with SIGBUS in `walFindFrame` (M4, October 16 2026). A
 * read-write opener that closes it believes it is the last: it checkpoints
 * and deletes `-wal` and `-shm` while this process still writes to them, and
 * those writes are lost (M4, October 15 2026).
 *
 * `install` wraps the node:fs calls that open, replace or delete a file, and
 * `register` names the database the process has open. A registered file (the
 * database, `-wal`, `-shm` or `-journal`) is then refused with EACCES, as is a
 * recursive copy, move or delete of a folder that holds it, and the refusal
 * is written to stderr with the caller's stack. Names compare without case,
 * because macOS and Windows volumes are case-insensitive by default, and the
 * macOS `/System/Volumes/Data` spelling of a path counts as the path itself.
 * `/dev/fd/N` is matched by the file the descriptor holds, and so is any
 * path while one of the files has a second hard link.
 *
 * Names miss a symlink to one of the files or a hard link made after
 * registration, so the guard also checks by file identity where the lock is
 * actually lost: at close. `close`, `closeSync` and the native FileHandle
 * close `fstat` the descriptor first, and a descriptor for the database,
 * `-wal` or `-shm` is left open on purpose. The descriptor leaks, the locks
 * stay, and the refusal goes to stderr with the caller's stack. After the
 * first such refusal every path is checked by identity when it is opened, so
 * a caller that keeps reaching the file through another name is refused
 * there instead of leaking a descriptor each time. Calls that close natively
 * (`readFile`, `readFileSync` and `writeFileSync` with utf8, `copyFile`, `cp`,
 * `openAsBlob`, `watch`) never reach the close guard, so they always `stat`
 * their path while a database is registered. The asynchronous ones use an
 * asynchronous `stat` before the call starts, so a path on a stalled mount
 * holds a pool thread rather than the event loop. A walk inside a folder, as a
 * recursive `cp` does, is matched by folder name only: callers that copy
 * folders from elsewhere should `realpath` them first. SQLite opens its files
 * natively, so its own connections are unaffected; `stat`, `access` and
 * `realpath` do not open the file and stay allowed.
 *
 * Effect's file system captures node:fs functions when its module loads, so
 * `install` must run before that: the CLI entry calls it before it imports
 * the rest of the program. The registry lives on `globalThis` so the entry
 * and the persistence layer share it whichever chunks bundling puts them in.
 */
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export const LIVE_DATABASE_SUFFIXES = ["", "-wal", "-shm", "-journal"] as const;
// The files SQLite keeps open while in WAL mode: the ones whose locks matter.
const IDENTITY_SUFFIXES = ["", "-wal", "-shm"] as const;

interface RegisteredDatabase {
  readonly dbPath: string;
  readonly directories: ReadonlySet<string>;
  readonly names: ReadonlySet<string>;
  /** The database, `-wal` and `-shm`, looked up again now and then. */
  readonly files: ReadonlyArray<string>;
  /** `dev:ino` of each of `files` that exists, to its path. */
  readonly identities: Map<string, string>;
  checkedAt: number;
  /** Set once a file is known to have another name: every path is then checked by identity. */
  checkEveryPath: boolean;
}

interface GuardState {
  readonly databases: Map<number, RegisteredDatabase>;
  /** Descriptors and FileHandles left open on purpose, so nothing closes them later. */
  readonly kept: Array<unknown>;
  nextId: number;
  reports: number;
  uninstall: (() => void) | undefined;
  restoreFileHandleClose: (() => void) | undefined;
}

const STATE_KEY = Symbol.for("specweave-studio.liveDatabaseGuard");
const MAX_REPORTS = 25;
const IDENTITY_RECHECK_MS = 1000;

const state = (): GuardState => {
  const holder = globalThis as { [STATE_KEY]?: GuardState };
  holder[STATE_KEY] ??= {
    databases: new Map(),
    kept: [],
    nextId: 1,
    reports: 0,
    uninstall: undefined,
    restoreFileHandleClose: undefined,
  };
  return holder[STATE_KEY];
};

const report = (message: string, stack: string | undefined): void => {
  const guard = state();
  if (guard.reports >= MAX_REPORTS) return;
  guard.reports += 1;
  // stderr reaches the service log even when Effect logging is not running.
  process.stderr.write(`[live-database-guard] ${message}\n${stack ?? ""}\n`);
};

const realDirectory = (directory: string): string => {
  try {
    return NodeFS.realpathSync.native(directory);
  } catch {
    return directory;
  }
};

const FIRMLINK_ROOT = "/system/volumes/data/";

// On macOS the data volume is also reachable under /System/Volumes/Data.
const withoutFirmlink = (path: string): string =>
  process.platform === "darwin" && path.toLowerCase().startsWith(FIRMLINK_ROOT)
    ? path.slice(FIRMLINK_ROOT.length - 1)
    : path;

const pathOf = (value: unknown): string | undefined => {
  if (typeof value === "string") return withoutFirmlink(value);
  if (value instanceof URL)
    return value.protocol === "file:" ? withoutFirmlink(NodeURL.fileURLToPath(value)) : undefined;
  if (Buffer.isBuffer(value)) return withoutFirmlink(value.toString());
  return undefined;
};

const DESCRIPTOR_PATH = /^\/(?:dev|proc\/self)\/fd\/(\d+)$/;

const identityOf = (stats: NodeFS.BigIntStats): string => `${stats.dev}:${stats.ino}`;

const statOf = (file: string): NodeFS.BigIntStats | undefined => {
  try {
    return NodeFS.statSync(file, { bigint: true, throwIfNoEntry: false });
  } catch {
    return undefined;
  }
};

// Rebuilt rather than added to: a file deleted and created again gets a new
// inode, and the old one may be reused by an unrelated file.
const recordIdentities = (database: RegisteredDatabase): void => {
  database.checkedAt = Date.now();
  database.identities.clear();
  for (const file of database.files) {
    const stats = statOf(file);
    if (stats === undefined) continue;
    database.identities.set(identityOf(stats), file);
    if (stats.nlink > 1n && !database.checkEveryPath) {
      database.checkEveryPath = true;
      report(
        `'${file}' has ${stats.nlink} hard links. Any other name for it reaches the live ` +
          "SpecWithCode database, so every path opened through node:fs is now checked by file identity.",
        undefined,
      );
    }
  }
};

/** The registered live file with this identity, if any. */
const liveIdentity = (stats: NodeFS.BigIntStats): string | undefined => {
  const key = identityOf(stats);
  for (const database of state().databases.values()) {
    if (Date.now() - database.checkedAt >= IDENTITY_RECHECK_MS) recordIdentities(database);
    const file = database.identities.get(key);
    if (file !== undefined) return file;
  }
  return undefined;
};

/** The registered live file descriptor `fd` holds open, if it holds one. */
export function liveDatabaseDescriptor(fd: unknown): string | undefined {
  if (state().databases.size === 0 || typeof fd !== "number") return undefined;
  try {
    return liveIdentity(NodeFS.fstatSync(fd, { bigint: true }));
  } catch {
    return undefined;
  }
}

/**
 * Names `dbPath` as a database this process has open, until the returned
 * function runs. `:memory:` has no files and registers nothing.
 */
export function registerLiveDatabase(dbPath: string): () => void {
  if (dbPath === ":memory:" || dbPath.trim() === "") return () => undefined;
  const absolute = withoutFirmlink(NodePath.resolve(dbPath));
  const directory = NodePath.dirname(absolute);
  const base = NodePath.basename(absolute);
  const guard = state();
  const id = guard.nextId++;
  const database: RegisteredDatabase = {
    dbPath: absolute,
    directories: new Set([directory, realDirectory(directory)]),
    names: new Set(LIVE_DATABASE_SUFFIXES.map((suffix) => `${base}${suffix}`.toLowerCase())),
    files: IDENTITY_SUFFIXES.map((suffix) => `${absolute}${suffix}`),
    identities: new Map(),
    checkedAt: 0,
    checkEveryPath: false,
  };
  recordIdentities(database);
  guard.databases.set(id, database);
  return () => {
    guard.databases.delete(id);
  };
}

type NameCheck = { readonly file: string | undefined } | { readonly identity: string };

// What the name of `target` says. It touches the disk only for a name that
// matches a live file or a descriptor path; anything else that still needs a
// check comes back as the path to `stat` for its identity.
const checkName = (target: unknown, byIdentity: boolean): NameCheck => {
  const guard = state();
  if (guard.databases.size === 0) return { file: undefined };
  const raw = pathOf(target);
  if (raw === undefined) return { file: undefined };
  const name = NodePath.basename(raw);
  for (const database of guard.databases.values()) {
    if (!database.names.has(name.toLowerCase())) continue;
    const directory = NodePath.dirname(NodePath.resolve(raw));
    if (database.directories.has(directory) || database.directories.has(realDirectory(directory))) {
      return { file: NodePath.join(NodePath.dirname(database.dbPath), name) };
    }
  }
  // Opening /dev/fd/N duplicates or reopens descriptor N, and closing that drops the locks too.
  const descriptor = DESCRIPTOR_PATH.exec(raw);
  if (descriptor !== null) return { file: liveDatabaseDescriptor(Number(descriptor[1])) };
  if (!byIdentity && ![...guard.databases.values()].some((database) => database.checkEveryPath)) {
    return { file: undefined };
  }
  return { identity: raw };
};

/**
 * The registered live database file `target` names, if it names one. With
 * `byIdentity`, or once a live file is known to have another name, any path
 * to the same file counts, as a symlink does.
 */
export function liveDatabaseFile(target: unknown, byIdentity = false): string | undefined {
  const named = checkName(target, byIdentity);
  if ("file" in named) return named.file;
  const stats = statOf(named.identity);
  return stats === undefined ? undefined : liveIdentity(stats);
}

// The identity half of `liveDatabaseFile`, through an asynchronous stat: an
// unanswered stat on a stalled mount then holds a pool thread, not the event loop.
const liveIdentityOf = async (path: string): Promise<string | undefined> => {
  const stats = await NodeFS.promises.stat(path, { bigint: true }).catch(() => undefined);
  return stats === undefined ? undefined : liveIdentity(stats);
};

/** The registered live database a recursive walk of `target` would reach. */
export function liveDatabaseInside(target: unknown): string | undefined {
  const guard = state();
  if (guard.databases.size === 0) return undefined;
  const raw = pathOf(target);
  if (raw === undefined) return undefined;
  const roots = new Set([NodePath.resolve(raw), realDirectory(NodePath.resolve(raw))]);
  for (const database of guard.databases.values()) {
    for (const directory of database.directories) {
      for (const root of roots) {
        const relative = NodePath.relative(root, directory);
        if (relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative))) {
          return database.dbPath;
        }
      }
    }
  }
  return undefined;
}

/** EACCES, so Effect's file system reports it as PermissionDenied. */
export class LiveDatabaseFileAccessError extends Error {
  readonly code = "EACCES";
  readonly errno = -13;
  readonly syscall: string;
  readonly path: string;

  constructor(operation: string, path: string) {
    super(
      `EACCES: ${operation} refused for '${path}': it is the live SpecWithCode database. ` +
        "Opening it outside SQLite drops the service's SQLite locks. " +
        "Use `specweave-studio db snapshot` or `specweave-studio db query` instead.",
    );
    this.name = "LiveDatabaseFileAccessError";
    this.syscall = operation;
    this.path = path;
  }
}

const refusal = (
  operation: string,
  path: string,
  stack?: string | undefined,
): LiveDatabaseFileAccessError => {
  const error = new LiveDatabaseFileAccessError(operation, path);
  report(error.message, stack ?? error.stack);
  return error;
};

// Closing the descriptor would drop every lock this process holds on the
// file, so it stays open. A native FileHandle is kept reachable, because one
// that is garbage collected gets closed. Whatever opened it reached the file
// by a name the path checks missed, so from now on every path is checked by
// identity at open, and a caller that repeats it is refused there instead of
// leaking another descriptor.
const keepOpen = (operation: string, path: string, fd: number, handle?: object): void => {
  const guard = state();
  if (handle !== undefined) guard.kept.push(handle);
  for (const database of guard.databases.values()) database.checkEveryPath = true;
  const error = new Error(
    `${operation} refused for '${path}' (descriptor ${fd}): it is the live SpecWithCode database. ` +
      "Closing it would drop the service's SQLite locks, so the descriptor stays open, and every " +
      "path opened through node:fs is now checked by file identity. " +
      "Use `specweave-studio db snapshot` or `specweave-studio db query` instead.",
  );
  report(error.message, error.stack);
};

/**
 * The arguments a call checks: paths by name, paths by file identity too
 * (calls that close the file natively, out of the close guard's reach), and a
 * folder a recursive walk would enter.
 */
interface Check {
  readonly names?: ReadonlyArray<number>;
  readonly identities?: ReadonlyArray<number>;
  readonly folder?: number;
}

const firstPath: Check = { names: [0] };
const identityPath: Check = { identities: [0] };
const identityPaths: Check = { identities: [0, 1] };
// A copy or move: either end, or a source folder that holds the database.
const transferPaths: Check = { names: [0, 1], folder: 0 };
const copyPaths: Check = { identities: [0, 1], folder: 0 };
const removePath: Check = { names: [0], folder: 0 };

const pathChecks = (check: Check): ReadonlyArray<readonly [index: number, byIdentity: boolean]> => [
  ...(check.names ?? []).map((index) => [index, false] as const),
  ...(check.identities ?? []).map((index) => [index, true] as const),
];

type AnyFunction = (...args: Array<any>) => any;
type Mode = "callback" | "sync" | "promise";

const wrap = (
  operation: string,
  original: AnyFunction,
  check: Check,
  mode: Mode,
  opened?: (handle: unknown) => void,
): AnyFunction => {
  const paths = pathChecks(check);
  const call = (self: unknown, args: Array<any>) => {
    const result = original.apply(self, args);
    return opened === undefined
      ? result
      : (result as Promise<unknown>).then((handle) => {
          opened(handle);
          return handle;
        });
  };
  const guarded = function (this: unknown, ...args: Array<any>) {
    const callback = args.at(-1);
    // Without a callback the original throws its own argument error.
    const deferrable =
      mode === "promise" || (mode === "callback" && typeof callback === "function");
    let hit: string | undefined;
    const pending: Array<string> = [];
    for (const [index, byIdentity] of paths) {
      if (!deferrable) {
        hit = liveDatabaseFile(args[index], byIdentity);
      } else {
        const named = checkName(args[index], byIdentity);
        if ("file" in named) hit = named.file;
        else pending.push(named.identity);
      }
      if (hit !== undefined) break;
    }
    if (hit === undefined && check.folder !== undefined)
      hit = liveDatabaseInside(args[check.folder]);
    if (hit === undefined && pending.length === 0) return call(this, args);
    if (hit !== undefined) {
      const error = refusal(operation, hit);
      if (mode === "promise") return Promise.reject(error);
      if (mode === "callback" && typeof callback === "function") {
        process.nextTick(callback, error);
        return undefined;
      }
      throw error;
    }
    // Asynchronous calls learn a path's identity before they start, without blocking the event loop.
    const site: { stack?: string } = {};
    Error.captureStackTrace(site, guarded);
    const checked = Promise.all(pending.map(liveIdentityOf)).then((files) =>
      files.find((file) => file !== undefined),
    );
    if (mode === "promise") {
      return checked.then((file) =>
        file === undefined
          ? call(this, args)
          : Promise.reject(refusal(operation, file, site.stack)),
      );
    }
    void checked.then((file) => {
      if (file !== undefined) {
        process.nextTick(callback, refusal(operation, file, site.stack));
        return;
      }
      try {
        call(this, args);
      } catch (error) {
        process.nextTick(callback, error);
      }
    });
    return undefined;
  };
  Object.defineProperty(guarded, "name", { value: original.name });
  return guarded;
};

const guardedCloseSync = (original: AnyFunction): AnyFunction =>
  function closeSync(this: unknown, ...args: Array<any>) {
    const path = liveDatabaseDescriptor(args[0]);
    if (path === undefined) return original.apply(this, args);
    keepOpen("closeSync", path, args[0]);
    return undefined;
  };

const guardedClose = (original: AnyFunction): AnyFunction =>
  function close(this: unknown, ...args: Array<any>) {
    const path = liveDatabaseDescriptor(args[0]);
    if (path === undefined) return original.apply(this, args);
    keepOpen("close", path, args[0]);
    const callback = args[1];
    if (typeof callback === "function") process.nextTick(callback, null);
    return undefined;
  };

/**
 * A FileHandle's `close` is an own arrow function that calls `close` on the
 * native handle it wraps, and every FileHandle (also the ones fs.promises
 * opens internally) shares that native prototype. No public API reaches it,
 * so it is found through the first FileHandle opened after install.
 */
const guardFileHandles = (handle: unknown): void => {
  const guard = state();
  if (guard.uninstall === undefined || guard.restoreFileHandleClose !== undefined) return;
  if (typeof handle !== "object" || handle === null) return;
  const key = Object.getOwnPropertySymbols(handle).find(
    (symbol) => symbol.description === "kHandle",
  );
  const native = key === undefined ? undefined : (handle as Record<symbol, unknown>)[key];
  if (typeof native !== "object" || native === null) return;
  const prototype = Object.getPrototypeOf(native) as Record<string, unknown>;
  const original = prototype.close;
  if (typeof original !== "function") return;
  prototype.close = function close(this: { readonly fd: number }) {
    const fd = this.fd;
    const path = liveDatabaseDescriptor(fd);
    if (path === undefined) return original.call(this);
    keepOpen("FileHandle.close", path, fd, this);
    return Promise.resolve();
  };
  guard.restoreFileHandleClose = () => {
    prototype.close = original;
    guard.restoreFileHandleClose = undefined;
  };
};

type Patch = readonly [target: object, key: string, check: Check, mode: Mode];

const patches = (): ReadonlyArray<Patch> => {
  // The CommonJS exports object: the ESM namespace of node:fs is read-only, and
  // `syncBuiltinESMExports` copies these properties into it.
  const mutable = process.getBuiltinModule("node:fs");
  const fs = mutable as unknown as object;
  const promises = mutable.promises as unknown as object;
  return [
    [fs, "open", firstPath, "callback"],
    [fs, "openSync", firstPath, "sync"],
    [fs, "readFile", identityPath, "callback"],
    [fs, "readFileSync", identityPath, "sync"],
    [fs, "writeFile", firstPath, "callback"],
    [fs, "writeFileSync", identityPath, "sync"],
    [fs, "appendFile", firstPath, "callback"],
    [fs, "appendFileSync", identityPath, "sync"],
    [fs, "createReadStream", firstPath, "sync"],
    [fs, "createWriteStream", firstPath, "sync"],
    // Starting a watch opens the path natively on the main thread anyway, so its stat runs there too.
    [fs, "watch", identityPath, "sync"],
    [fs, "openAsBlob", identityPath, "promise"],
    [fs, "truncate", firstPath, "callback"],
    [fs, "truncateSync", firstPath, "sync"],
    [fs, "copyFile", identityPaths, "callback"],
    [fs, "copyFileSync", identityPaths, "sync"],
    [fs, "cp", copyPaths, "callback"],
    [fs, "cpSync", copyPaths, "sync"],
    [fs, "rename", transferPaths, "callback"],
    [fs, "renameSync", transferPaths, "sync"],
    [fs, "unlink", firstPath, "callback"],
    [fs, "unlinkSync", firstPath, "sync"],
    [fs, "rm", removePath, "callback"],
    [fs, "rmSync", removePath, "sync"],
    [promises, "open", firstPath, "promise"],
    [promises, "readFile", firstPath, "promise"],
    [promises, "writeFile", firstPath, "promise"],
    [promises, "appendFile", firstPath, "promise"],
    [promises, "truncate", firstPath, "promise"],
    [promises, "watch", identityPath, "sync"],
    [promises, "copyFile", identityPaths, "promise"],
    [promises, "cp", copyPaths, "promise"],
    [promises, "rename", transferPaths, "promise"],
    [promises, "unlink", firstPath, "promise"],
    [promises, "rm", removePath, "promise"],
  ];
};

/**
 * Wraps node:fs once for this process and returns a function that restores
 * it. Safe to call more than once.
 */
export function installLiveDatabaseGuard(): () => void {
  const guard = state();
  if (guard.uninstall !== undefined) return guard.uninstall;
  const restore: Array<() => void> = [];
  const mutable = process.getBuiltinModule("node:fs");
  const replace = (target: object, key: string, make: (original: AnyFunction) => AnyFunction) => {
    const record = target as Record<string, unknown>;
    const original = record[key];
    if (typeof original !== "function") return;
    record[key] = make(original as AnyFunction);
    restore.push(() => {
      record[key] = original;
    });
  };
  for (const [target, key, check, mode] of patches()) {
    const opened = target === mutable.promises && key === "open" ? guardFileHandles : undefined;
    replace(target, key, (original) => wrap(key, original, check, mode, opened));
  }
  replace(mutable, "closeSync", guardedCloseSync);
  replace(mutable, "close", guardedClose);
  NodeModule.syncBuiltinESMExports();
  guard.uninstall = () => {
    for (const undo of restore) undo();
    guard.restoreFileHandleClose?.();
    NodeModule.syncBuiltinESMExports();
    guard.uninstall = undefined;
  };
  // Finds the native FileHandle prototype before anything else opens one.
  const unguarded = (reason: string) => {
    if (guard.uninstall === undefined || guard.restoreFileHandleClose !== undefined) return;
    report(`FileHandle closes are not guarded: ${reason}.`, undefined);
  };
  mutable.promises
    .open(process.execPath, "r")
    .then((handle) => {
      unguarded("the native FileHandle close was not found");
      return handle.close();
    })
    .catch((error: unknown) => unguarded(`opening a probe FileHandle failed (${String(error)})`));
  return guard.uninstall;
}
