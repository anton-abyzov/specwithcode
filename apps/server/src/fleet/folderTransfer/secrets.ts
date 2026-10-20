// @effect-diagnostics nodeBuiltinImport:off - secret files are written with exclusive create, no-follow and mode 0600.
/**
 * The opt-in secret step of a folder copy. Secret-like files (the list behind
 * `isSecretLikeProjectPath`, plus `.env*`) never travel with the folder; the
 * person ticks the ones the other machine needs, on the source, one file at a
 * time. Records on both machines keep paths, sizes and times, never contents.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { JsonLog, lstatOrNull } from "./durable.ts";
import { isSafeRelativePath } from "./paths.ts";

export const MAX_SECRET_FILE_BYTES = 1024 * 1024;
export const MAX_SECRET_TOTAL_BYTES = 16 * 1024 * 1024;
export const MAX_SECRET_FILES = 500;
export const SECRETS_SENT_FILE = "secrets-sent.ndjson";

export interface SecretFile {
  readonly path: string;
  readonly size: number;
}

export interface SecretApproval {
  readonly files: ReadonlyArray<SecretFile>;
  readonly approvedAt: number;
  /** The destination's name as the person saw it when confirming. */
  readonly destinationLabel: string;
}

export class SecretStepError extends Error {
  readonly code: "not_offered" | "too_many" | "too_large" | "duplicate";
  constructor(code: SecretStepError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Checks the ticked paths against the secret files the scan found. Only those
 * can be sent, each at most once, within the size limits.
 */
export function selectSecretFiles(
  offered: ReadonlyArray<SecretFile>,
  paths: ReadonlyArray<string>,
): Array<SecretFile> {
  if (paths.length > MAX_SECRET_FILES)
    throw new SecretStepError("too_many", `Send at most ${MAX_SECRET_FILES} secret files at once.`);
  const byPath = new Map(offered.map((file) => [file.path, file]));
  const seen = new Set<string>();
  const result: Array<SecretFile> = [];
  let total = 0;
  for (const path of paths) {
    if (seen.has(path)) throw new SecretStepError("duplicate", "A secret file is listed twice.");
    seen.add(path);
    const file = byPath.get(path);
    if (!file || !isSafeRelativePath(path))
      throw new SecretStepError(
        "not_offered",
        "Only secret files found in the folder can be sent.",
      );
    if (file.size > MAX_SECRET_FILE_BYTES)
      throw new SecretStepError("too_large", `${path} is larger than 1 MB; copy it by hand.`);
    total += file.size;
    if (total > MAX_SECRET_TOTAL_BYTES)
      throw new SecretStepError("too_large", "The ticked secret files exceed 16 MB together.");
    result.push(file);
  }
  return result;
}

export interface SentSecret {
  readonly operationId: string;
  readonly destinationEnvironmentId: string;
  readonly destinationLabel: string;
  /** The project folder the file came from. */
  readonly folder: string;
  readonly path: string;
  readonly size: number;
  readonly sentAt: string;
}

/**
 * Which secret files this machine sent to which machine, and when. One line per
 * file and operation; a retried pull of the same file is not listed twice.
 */
export class SentSecretsLedger {
  private readonly log: JsonLog<SentSecret>;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(stateRoot: string) {
    this.log = new JsonLog(NodePath.join(stateRoot, SECRETS_SENT_FILE));
  }

  record(entry: SentSecret): Promise<void> {
    const next = this.queue.then(async () => {
      const existing = await this.log.read();
      if (
        existing.some((item) => item.operationId === entry.operationId && item.path === entry.path)
      )
        return;
      await this.log.append(entry, true);
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  async list(destinationEnvironmentId?: string): Promise<Array<SentSecret>> {
    const entries = await this.log.read();
    return entries.filter(
      (entry) =>
        destinationEnvironmentId === undefined ||
        entry.destinationEnvironmentId === destinationEnvironmentId,
    );
  }

  close(): Promise<void> {
    return this.log.close();
  }
}

export interface ReceivedSecret {
  readonly path: string;
  /** Where the file landed: the same path, or `<path>.from-<machine>` beside a different one. */
  readonly writtenAs: string;
  readonly size: number;
  readonly state: "written" | "unchanged" | "beside";
  /** Set when this copy created the file, so Undo can remove it again if it was not edited. */
  readonly created: { readonly mtimeMs: number; readonly size: number } | null;
}

/** Creates the folders above `relative`, refusing any step that is a link or a file. */
async function ensureParents(root: string, relative: string) {
  let current = root;
  for (const part of relative.split("/").slice(0, -1)) {
    current = NodePath.join(current, part);
    const stat = await lstatOrNull(current);
    if (stat?.isSymbolicLink() || (stat && !stat.isDirectory()))
      throw new Error(`A folder on the path of ${relative} is a link or a file.`);
    if (!stat) await NodeFSP.mkdir(current, { mode: 0o700 });
  }
}

async function sameContent(absolute: string, bytes: Uint8Array): Promise<boolean> {
  const handle = await NodeFSP.open(
    absolute,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== bytes.byteLength) return false;
    const current = await handle.readFile();
    return Buffer.compare(current, Buffer.from(bytes)) === 0;
  } finally {
    await handle.close();
  }
}

/** First `<name>`, `<name>-2`, ... that does not exist yet, so an earlier file is never replaced. */
async function freeBesideName(targetRoot: string, name: string): Promise<string> {
  for (let attempt = 1; attempt <= 100; attempt += 1) {
    const candidate = attempt === 1 ? name : `${name}-${attempt}`;
    if (!(await lstatOrNull(NodePath.join(targetRoot, candidate)))) return candidate;
  }
  throw new Error(`${name} and 99 numbered copies already exist.`);
}

/** Writes through a private temporary file and renames it into place; never follows a link. */
async function writePrivate(absolute: string, bytes: Uint8Array, exclusive: boolean) {
  const temporary = NodePath.join(
    NodePath.dirname(absolute),
    `.swc-secret-${NodeCrypto.randomUUID()}.tmp`,
  );
  const handle = await NodeFSP.open(
    temporary,
    NodeFS.constants.O_WRONLY |
      NodeFS.constants.O_CREAT |
      NodeFS.constants.O_EXCL |
      NodeFS.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (exclusive && (await lstatOrNull(absolute))) throw new Error("exists");
    await NodeFSP.rename(temporary, absolute);
  } catch (cause) {
    await NodeFSP.rm(temporary, { force: true });
    throw cause;
  }
}

/**
 * Writes one received secret file inside the copied folder with mode 0600. A
 * different file already at the path is kept; the received one goes beside it.
 */
export async function writeSecretFile(input: {
  readonly targetRoot: string;
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly sourceMachine: string;
}): Promise<ReceivedSecret> {
  if (!isSafeRelativePath(input.path)) throw new Error("A received secret file path is unsafe.");
  if (input.bytes.byteLength > MAX_SECRET_FILE_BYTES)
    throw new Error(`${input.path} is larger than the secret file limit.`);
  await ensureParents(input.targetRoot, input.path);
  const absolute = NodePath.join(input.targetRoot, input.path);
  const existing = await lstatOrNull(absolute);
  let writtenAs = input.path;
  let state: ReceivedSecret["state"] = "written";
  if (existing) {
    if (existing.isFile() && (await sameContent(absolute, input.bytes)))
      return {
        path: input.path,
        writtenAs: input.path,
        size: input.bytes.byteLength,
        state: "unchanged",
        created: null,
      };
    state = "beside";
    writtenAs = await freeBesideName(input.targetRoot, `${input.path}.from-${input.sourceMachine}`);
    await writePrivate(NodePath.join(input.targetRoot, writtenAs), input.bytes, true);
  } else {
    await writePrivate(absolute, input.bytes, true);
  }
  const written = await NodeFSP.lstat(NodePath.join(input.targetRoot, writtenAs));
  return {
    path: input.path,
    writtenAs,
    size: input.bytes.byteLength,
    state,
    created: { mtimeMs: written.mtimeMs, size: written.size },
  };
}

/**
 * Removes the secret files a copy created, unless they changed since. Returns
 * the paths kept because they were edited.
 */
export async function removeReceivedSecrets(
  targetRoot: string,
  received: ReadonlyArray<ReceivedSecret>,
): Promise<Array<string>> {
  const kept: Array<string> = [];
  for (const file of received) {
    if (!file.created || !isSafeRelativePath(file.writtenAs)) continue;
    const absolute = NodePath.join(targetRoot, file.writtenAs);
    const stat = await lstatOrNull(absolute);
    if (!stat) continue;
    if (
      !stat.isFile() ||
      stat.size !== file.created.size ||
      stat.mtimeMs !== file.created.mtimeMs
    ) {
      kept.push(file.writtenAs);
      continue;
    }
    await NodeFSP.rm(absolute, { force: true });
  }
  return kept;
}
