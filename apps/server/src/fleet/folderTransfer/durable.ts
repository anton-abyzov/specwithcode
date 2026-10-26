// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - private 0600 records need exclusive create, fsync and rename (retried on Windows locks).
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

/** Creates a private folder (0700) and refuses one that resolves somewhere else. */
export async function privateDirectory(directory: string): Promise<string> {
  await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  const real = await NodeFSP.realpath(directory);
  if (real !== NodePath.resolve(directory)) throw new Error("Private folder resolves elsewhere.");
  await NodeFSP.chmod(directory, 0o700);
  return real;
}

/** Writes a JSON record atomically with mode 0600. */
export async function writeJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${NodeCrypto.randomUUID()}.tmp`;
  const handle = await NodeFSP.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await renameOverReader(temporary, file);
}

// About 2 seconds, like atomicWrite.ts: a status read of the record can hold it
// open while an update replaces it, and Windows refuses that rename until it closes.
const LOCKED_RENAME_RETRIES = 20;
const LOCKED_RENAME_RETRY_MS = 100;

async function renameOverReader(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await NodeFSP.rename(from, to);
      return;
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      const locked = code === "EBUSY" || code === "EPERM" || code === "EACCES";
      if (process.platform !== "win32" || !locked || attempt >= LOCKED_RENAME_RETRIES) {
        await NodeFSP.rm(from, { force: true }).catch(() => undefined);
        throw cause;
      }
      await new Promise((resolve) => setTimeout(resolve, LOCKED_RENAME_RETRY_MS));
    }
  }
}

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await NodeFSP.readFile(file, "utf8")) as T;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
}

/**
 * An append-only log of JSON lines, synced on demand. A torn last line from a
 * crash is ignored on read, so replay sees exactly the steps that were recorded.
 */
export class JsonLog<T> {
  private handle: NodeFSP.FileHandle | null = null;
  private pending = 0;
  readonly file: string;
  constructor(file: string) {
    this.file = file;
  }

  async read(): Promise<Array<T>> {
    let text: string;
    try {
      text = await NodeFSP.readFile(this.file, "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw cause;
    }
    const lines = text.split("\n");
    const result: Array<T> = [];
    for (const line of lines) {
      if (!line) continue;
      try {
        result.push(JSON.parse(line) as T);
      } catch {
        break;
      }
    }
    return result;
  }

  async append(value: T, sync = false): Promise<void> {
    this.handle ??= await NodeFSP.open(this.file, "a", 0o600);
    await this.handle.appendFile(`${JSON.stringify(value)}\n`);
    this.pending += 1;
    if (sync) await this.sync();
  }

  async sync(): Promise<void> {
    if (this.handle && this.pending > 0) {
      await this.handle.sync();
      this.pending = 0;
    }
  }

  async close(): Promise<void> {
    await this.sync();
    await this.handle?.close();
    this.handle = null;
  }
}

export const exists = (file: string) =>
  NodeFSP.lstat(file).then(
    () => true,
    () => false,
  );

export const lstatOrNull = (file: string) => NodeFSP.lstat(file).catch(() => null);

/** Free bytes for unprivileged writes on the volume holding `location`. */
export async function freeBytes(location: string): Promise<number> {
  let probe = location;
  while (!(await exists(probe))) {
    const parent = NodePath.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const stats = await NodeFSP.statfs(probe);
  return Number(stats.bavail) * Number(stats.bsize);
}

/** Device id of the volume holding `location` (or its nearest existing ancestor). */
export async function deviceOf(location: string): Promise<number> {
  let probe = location;
  while (!(await exists(probe))) {
    const parent = NodePath.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  return (await NodeFSP.stat(probe)).dev;
}

export { NodeFS };
