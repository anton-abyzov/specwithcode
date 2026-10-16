// @effect-diagnostics nodeBuiltinImport:off -- The guard wraps node:fs itself, before Effect loads.
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
 * because macOS and Windows volumes are case-insensitive by default. A
 * symlink or hard link under another name is not recognized, so readers of
 * paths from outside resolve them with `realpath` first, as the workspace
 * reader does. SQLite opens its files natively, so its own connections are
 * unaffected; `stat`, `access` and `realpath` do not open the file and stay
 * allowed.
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

interface RegisteredDatabase {
  readonly dbPath: string;
  readonly directories: ReadonlySet<string>;
  readonly names: ReadonlySet<string>;
}

interface GuardState {
  readonly databases: Map<number, RegisteredDatabase>;
  nextId: number;
  reports: number;
  uninstall: (() => void) | undefined;
}

const STATE_KEY = Symbol.for("specweave-studio.liveDatabaseGuard");
const MAX_REPORTS = 25;

const state = (): GuardState => {
  const holder = globalThis as { [STATE_KEY]?: GuardState };
  holder[STATE_KEY] ??= { databases: new Map(), nextId: 1, reports: 0, uninstall: undefined };
  return holder[STATE_KEY];
};

const realDirectory = (directory: string): string => {
  try {
    return NodeFS.realpathSync.native(directory);
  } catch {
    return directory;
  }
};

const pathOf = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  if (value instanceof URL)
    return value.protocol === "file:" ? NodeURL.fileURLToPath(value) : undefined;
  if (Buffer.isBuffer(value)) return value.toString();
  return undefined;
};

/**
 * Names `dbPath` as a database this process has open, until the returned
 * function runs. `:memory:` has no files and registers nothing.
 */
export function registerLiveDatabase(dbPath: string): () => void {
  if (dbPath === ":memory:" || dbPath.trim() === "") return () => undefined;
  const absolute = NodePath.resolve(dbPath);
  const directory = NodePath.dirname(absolute);
  const base = NodePath.basename(absolute);
  const guard = state();
  const id = guard.nextId++;
  guard.databases.set(id, {
    dbPath: absolute,
    directories: new Set([directory, realDirectory(directory)]),
    names: new Set(LIVE_DATABASE_SUFFIXES.map((suffix) => `${base}${suffix}`.toLowerCase())),
  });
  return () => {
    guard.databases.delete(id);
  };
}

/** The registered live database file `target` names, if it names one. */
export function liveDatabaseFile(target: unknown): string | undefined {
  const guard = state();
  if (guard.databases.size === 0) return undefined;
  const raw = pathOf(target);
  if (raw === undefined) return undefined;
  const name = NodePath.basename(raw);
  for (const database of guard.databases.values()) {
    if (!database.names.has(name.toLowerCase())) continue;
    const directory = NodePath.dirname(NodePath.resolve(raw));
    if (database.directories.has(directory) || database.directories.has(realDirectory(directory))) {
      return NodePath.join(NodePath.dirname(database.dbPath), name);
    }
  }
  return undefined;
}

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

const refusal = (operation: string, path: string): LiveDatabaseFileAccessError => {
  const error = new LiveDatabaseFileAccessError(operation, path);
  const guard = state();
  if (guard.reports < MAX_REPORTS) {
    guard.reports += 1;
    // stderr reaches the service log even when Effect logging is not running.
    process.stderr.write(`[live-database-guard] ${error.message}\n${error.stack ?? ""}\n`);
  }
  return error;
};

type Check = (args: ReadonlyArray<unknown>) => string | undefined;

const firstPath: Check = (args) => liveDatabaseFile(args[0]);
const eitherPath: Check = (args) => liveDatabaseFile(args[0]) ?? liveDatabaseFile(args[1]);
// A copy or move: either end, or a source folder that holds the database.
const transferPaths: Check = (args) =>
  liveDatabaseFile(args[0]) ?? liveDatabaseFile(args[1]) ?? liveDatabaseInside(args[0]);
const removePath: Check = (args) => liveDatabaseFile(args[0]) ?? liveDatabaseInside(args[0]);

type AnyFunction = (...args: Array<any>) => any;
type Mode = "callback" | "sync" | "promise";

const wrap = (operation: string, original: AnyFunction, check: Check, mode: Mode): AnyFunction => {
  const guarded = function (this: unknown, ...args: Array<any>) {
    const hit = check(args);
    if (hit === undefined) return original.apply(this, args);
    const error = refusal(operation, hit);
    if (mode === "promise") return Promise.reject(error);
    const callback = args.at(-1);
    if (mode === "callback" && typeof callback === "function") {
      process.nextTick(callback, error);
      return undefined;
    }
    throw error;
  };
  Object.defineProperty(guarded, "name", { value: original.name });
  return guarded;
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
    [fs, "readFile", firstPath, "callback"],
    [fs, "readFileSync", firstPath, "sync"],
    [fs, "writeFile", firstPath, "callback"],
    [fs, "writeFileSync", firstPath, "sync"],
    [fs, "appendFile", firstPath, "callback"],
    [fs, "appendFileSync", firstPath, "sync"],
    [fs, "createReadStream", firstPath, "sync"],
    [fs, "createWriteStream", firstPath, "sync"],
    [fs, "watch", firstPath, "sync"],
    [fs, "openAsBlob", firstPath, "promise"],
    [fs, "truncate", firstPath, "callback"],
    [fs, "truncateSync", firstPath, "sync"],
    [fs, "copyFile", eitherPath, "callback"],
    [fs, "copyFileSync", eitherPath, "sync"],
    [fs, "cp", transferPaths, "callback"],
    [fs, "cpSync", transferPaths, "sync"],
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
    [promises, "watch", firstPath, "sync"],
    [promises, "copyFile", eitherPath, "promise"],
    [promises, "cp", transferPaths, "promise"],
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
  for (const [target, key, check, mode] of patches()) {
    const record = target as Record<string, unknown>;
    const original = record[key];
    if (typeof original !== "function") continue;
    record[key] = wrap(key, original as AnyFunction, check, mode);
    restore.push(() => {
      record[key] = original;
    });
  }
  NodeModule.syncBuiltinESMExports();
  guard.uninstall = () => {
    for (const undo of restore) undo();
    NodeModule.syncBuiltinESMExports();
    guard.uninstall = undefined;
  };
  return guard.uninstall;
}
