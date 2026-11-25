// @effect-diagnostics nodeBuiltinImport:off
/**
 * WorkspaceFileSystem - Effect service contract for workspace file mutations.
 *
 * Owns workspace-root-relative file read/write operations and their associated
 * safety checks and cache invalidation hooks. Reads also accept absolute host
 * paths so clients can show files an agent left outside the workspace; writes
 * never leave the root. No read or write touches a credential or app state file
 * (see WorkspaceSensitivePaths), whichever way the path reaches it.
 *
 * @module WorkspaceFileSystem
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import {
  SHEET_ARTIFACT_SUFFIX,
  SHEET_LIMITS,
  sheetContentRevision,
} from "@specweave-studio/shared/officeSheet";
import { WHITEBOARD_LIMITS, isWhiteboardPath } from "@specweave-studio/shared/officeWhiteboard";
import { writeSheetFileCompareAndSet } from "../project/OfficeArtifacts.ts";
import * as NodePath from "node:path";

import type {
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
import * as WorkspaceSensitivePaths from "./WorkspaceSensitivePaths.ts";

const PROJECT_READ_FILE_MAX_BYTES = 1024 * 1024;

export class WorkspaceFileSystemOperationError extends Schema.TaggedError<WorkspaceFileSystemOperationError>()(
  "WorkspaceFileSystemOperationError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
    operationPath: Schema.String,
    operation: Schema.Literals([
      "realpath-workspace-root",
      "realpath-target",
      "open",
      "stat",
      "read",
      "close",
      "make-directory",
      "write-file",
    ]),
    /** `protected`: a credential or app state file the guard refuses. */
    reason: Schema.optional(Schema.Literal("protected")),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Workspace file operation '${this.operation}' failed at '${this.operationPath}' for resolved path '${this.resolvedPath}' (requested as '${this.relativePath}' in '${this.workspaceRoot}').`;
  }
}

export class WorkspaceFilePathEscapeError extends Schema.TaggedError<WorkspaceFilePathEscapeError>()(
  "WorkspaceFilePathEscapeError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedWorkspaceRoot: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace file '${this.relativePath}' resolves outside workspace root '${this.workspaceRoot}': ${this.resolvedPath}`;
  }
}

export class WorkspacePathNotFileError extends Schema.TaggedError<WorkspacePathNotFileError>()(
  "WorkspacePathNotFileError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace path '${this.relativePath}' in '${this.workspaceRoot}' is not a file: ${this.resolvedPath}`;
  }
}

export class WorkspaceBinaryFileError extends Schema.TaggedError<WorkspaceBinaryFileError>()(
  "WorkspaceBinaryFileError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace file '${this.relativePath}' in '${this.workspaceRoot}' is binary or not UTF-8 text and cannot be opened as text.`;
  }
}

export const WorkspaceFileSystemError = Schema.Union([
  WorkspaceFileSystemOperationError,
  WorkspaceFilePathEscapeError,
  WorkspacePathNotFileError,
  WorkspaceBinaryFileError,
]);
export type WorkspaceFileSystemError = typeof WorkspaceFileSystemError.Type;

/** Service tag for workspace file operations. */
export class WorkspaceFileSystem extends Context.Service<
  WorkspaceFileSystem,
  {
    /**
     * Read a UTF-8 text file relative to the workspace root, or any host file by
     * absolute path.
     */
    readonly readFile: (
      input: ProjectReadFileInput,
    ) => Effect.Effect<
      ProjectReadFileResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
    /**
     * Write a file relative to the workspace root.
     *
     * Creates parent directories as needed and rejects paths that escape the
     * workspace root.
     */
    readonly writeFile: (
      input: ProjectWriteFileInput,
      /** `destination`: the real file the caller means; a path that leads elsewhere now is not written. */
      options?: { readonly destination?: string },
    ) => Effect.Effect<
      ProjectWriteFileResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
  }
>()("specweave-studio/workspace/WorkspaceFileSystem") {}

const isMissingPathError = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};

/**
 * Where a write to `target` would really land: follows a symlinked file (dangling
 * ones too, since writing creates their target) and resolves the longest existing
 * folder prefix. Null when that cannot be known: a path that exists but has no
 * realpath (macOS `/.vol/<device>/<inode>` names, an unreadable folder) or a link
 * chain too long to follow. Only a path that does not exist is skipped over.
 */
async function resolveWriteDestination(
  target: string,
  realpath: (target: string) => Promise<string>,
  depth = 0,
): Promise<string | null> {
  const absolute = NodePath.resolve(target);
  if (depth > 32) return null;
  const link = await NodeFSP.readlink(absolute).catch(() => null);
  if (link !== null) {
    // The system reads a link's target from the link's real folder, so a `..`
    // in it climbs out of that folder, not out of the path as written.
    const folder = await realpath(NodePath.dirname(absolute)).catch(() => null);
    if (folder === null) return null;
    return resolveWriteDestination(NodePath.resolve(folder, link), realpath, depth + 1);
  }
  const missing: Array<string> = [];
  let current = absolute;
  for (;;) {
    const real = await realpath(current).catch(() => null);
    if (real !== null) return NodePath.join(real, ...[...missing].reverse());
    const absent = await NodeFSP.lstat(current).then(
      () => false,
      (error: unknown) => (isMissingPathError(error) ? true : null),
    );
    // There (or not knowably absent), yet unresolvable: refuse rather than guess.
    if (absent !== true) return null;
    const parent = NodePath.dirname(current);
    if (parent === current) return null;
    missing.push(NodePath.basename(current));
    current = parent;
  }
}

const UTF8_BOM = "\uFEFF";

/**
 * Whether bytes are text the editor can round-trip: no NUL byte and valid UTF-8.
 * A lossy decode would turn other encodings into U+FFFD and a save would keep it.
 * `partial` allows a character the read limit split at the end.
 */
function decodeEditableText(bytes: Uint8Array, partial: boolean): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: partial });
  } catch {
    return null;
  }
}

/** How many byte order marks a decoded text starts with. */
function countLeadingBoms(text: string): number {
  let count = 0;
  while (count < text.length && text.charCodeAt(count) === 0xfeff) count++;
  return count;
}

/** What a save finds in the file it would replace. */
type ExistingFile =
  | { readonly kind: "missing" }
  | {
      readonly kind: "text";
      readonly leadingBoms: number;
      readonly handle: NodeFSP.FileHandle;
      /** The file as the scan found it, so a later change to it can be seen. */
      readonly scanned: NodeFS.BigIntStats;
    }
  | { readonly kind: "not-text" }
  | { readonly kind: "not-file" }
  | { readonly kind: "changed" }
  | {
      readonly kind: "failed";
      readonly operation: "open" | "stat" | "read";
      readonly cause: unknown;
    };

const EXISTING_FILE_CHUNK_BYTES = 64 * 1024;

/** Whether a file still has the size and times it had, so its bytes are the ones read. */
const unchangedSince = (before: NodeFS.BigIntStats, after: NodeFS.BigIntStats) =>
  before.dev === after.dev &&
  before.ino === after.ino &&
  before.size === after.size &&
  before.mtimeNs === after.mtimeNs &&
  before.ctimeNs === after.ctimeNs;

/**
 * Checks the whole file a save would replace, in bounded chunks, so a file that
 * is not UTF-8 text anywhere in it is never overwritten. Only a path that does not
 * exist allows a create: any other failure refuses the save, since a file the
 * check could not read may be exactly the one it protects. `checkedStat` is what
 * the protected-path check saw; an open file that differs from it was swapped.
 * A text file comes back with its handle still open for writing, so the save
 * replaces the very file this check read, not one swapped in after it.
 */
async function readExistingText(
  filePath: string,
  checkedStat: NodeFS.BigIntStats | null,
): Promise<ExistingFile> {
  let handle: NodeFSP.FileHandle;
  try {
    // Non-blocking so a FIFO cannot hang the save. No-follow, since the
    // destination names no link. Windows lacks both.
    handle = await NodeFSP.open(
      filePath,
      NodeFS.constants.O_RDWR |
        (NodeFS.constants.O_NONBLOCK ?? 0) |
        (NodeFS.constants.O_NOFOLLOW ?? 0),
    );
  } catch (cause) {
    if (isMissingPathError(cause)) return { kind: "missing" };
    // A folder cannot be opened for writing.
    if ((cause as NodeJS.ErrnoException | null)?.code === "EISDIR") return { kind: "not-file" };
    return { kind: "failed", operation: "open", cause };
  }
  let operation: "stat" | "read" = "stat";
  let keepOpen = false;
  try {
    const stat = await handle.stat({ bigint: true });
    if (checkedStat === null || checkedStat.dev !== stat.dev || checkedStat.ino !== stat.ino) {
      return { kind: "changed" };
    }
    if (!stat.isFile()) return { kind: "not-file" };
    operation = "read";
    // The marks stay in the decoded text so they can be counted.
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const buffer = Buffer.alloc(EXISTING_FILE_CHUNK_BYTES);
    let leadingBoms = 0;
    let countingBoms = true;
    const take = (text: string) => {
      if (!countingBoms) return;
      const count = countLeadingBoms(text);
      leadingBoms += count;
      if (count < text.length) countingBoms = false;
    };
    // Only the size found at open is read: a file still growing is refused
    // below, not followed for as long as it grows.
    for (let position = 0n; position < stat.size;) {
      const length = Number(
        stat.size - position < BigInt(buffer.length) ? stat.size - position : buffer.length,
      );
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead === 0) break;
      position += BigInt(bytesRead);
      const chunk = buffer.subarray(0, bytesRead);
      if (chunk.includes(0)) return { kind: "not-text" };
      try {
        take(decoder.decode(chunk, { stream: true }));
      } catch {
        return { kind: "not-text" };
      }
    }
    operation = "stat";
    if (!unchangedSince(stat, await handle.stat({ bigint: true }))) return { kind: "changed" };
    operation = "read";
    try {
      take(decoder.decode());
    } catch {
      return { kind: "not-text" };
    }
    keepOpen = true;
    return { kind: "text", leadingBoms, handle, scanned: stat };
  } catch (cause) {
    return { kind: "failed", operation, cause };
  } finally {
    if (!keepOpen) await handle.close().catch(() => undefined);
  }
}

const fileChangedError = () =>
  Object.assign(new Error("The file changed while it was being saved."), { code: "EAGAIN" });

/**
 * The revision of the text the scan checked, read again through its handle. A
 * sheet save that names no revision is pinned to it, so a file swapped in after
 * the scan is refused by the compare-and-set instead of overwritten. A canonical
 * artifact is checked by its own locked writer instead.
 */
async function scannedRevision(handle: NodeFSP.FileHandle, scanned: NodeFS.BigIntStats) {
  const buffer = Buffer.alloc(Number(scanned.size));
  let position = 0;
  while (position < buffer.length) {
    const { bytesRead } = await handle.read(buffer, position, buffer.length - position, position);
    if (bytesRead === 0) break;
    position += bytesRead;
  }
  if (!unchangedSince(scanned, await handle.stat({ bigint: true }))) throw fileChangedError();
  return sheetContentRevision(buffer.subarray(0, position).toString("utf8"));
}

/**
 * Replaces the checked file through its open handle. The requested path, through
 * any link, must still name it, and it must be unchanged since the scan: a file
 * swapped in, retargeted to or rewritten since the check is left alone and the
 * save refused.
 */
async function replaceCheckedFile(
  existing: Extract<ExistingFile, { readonly kind: "text" }>,
  requestedPath: string,
  bytes: Uint8Array,
): Promise<void> {
  const { handle, scanned } = existing;
  const [opened, current] = await Promise.all([
    handle.stat({ bigint: true }),
    NodeFSP.stat(requestedPath, { bigint: true }),
  ]);
  const sameFile = opened.dev === current.dev && opened.ino === current.ino;
  if (!sameFile || !unchangedSince(scanned, opened)) throw fileChangedError();
  await handle.truncate(0);
  await writeAll(handle, bytes);
}

/** Creates a file that did not exist at the check; one that appeared since is refused. */
async function createCheckedFile(filePath: string, bytes: Uint8Array): Promise<void> {
  const handle = await NodeFSP.open(
    filePath,
    NodeFS.constants.O_WRONLY |
      NodeFS.constants.O_CREAT |
      NodeFS.constants.O_EXCL |
      (NodeFS.constants.O_NOFOLLOW ?? 0),
  );
  try {
    await writeAll(handle, bytes);
  } finally {
    await handle.close();
  }
}

async function writeAll(handle: NodeFSP.FileHandle, bytes: Uint8Array): Promise<void> {
  for (let offset = 0; offset < bytes.length;) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
    offset += bytesWritten;
  }
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
  const sensitivePaths = yield* WorkspaceSensitivePaths.sensitivePathGuard;

  /**
   * Refuses a credential file as an access failure, the same answer a missing or
   * unreadable file gets, so the client learns nothing about what is there. It
   * names the path as the client asked for it, never where a link led.
   */
  const sensitivePathError = (
    input: { readonly cwd: string; readonly relativePath: string },
    requestedPath: string,
    operation: "open" | "write-file",
  ) =>
    new WorkspaceFileSystemOperationError({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
      resolvedPath: requestedPath,
      operationPath: requestedPath,
      operation,
      reason: "protected",
      cause: Object.assign(new Error("Credential and app state files are protected."), {
        code: "EACCES",
      }),
    });

  /** Checks the path as requested, before any realpath, so a later symlink cannot hide it. */
  const refuseSensitiveRequest = (input: ProjectReadFileInput, requestedAbsolutePath: string) =>
    sensitivePaths.isDenied(requestedAbsolutePath)
      ? Effect.fail(sensitivePathError(input, requestedAbsolutePath, "open"))
      : Effect.void;

  /**
   * Checks where the path really leads (its on-disk spelling), so a symlink into a
   * protected path, another spelling of one, or a hard link to a protected file is
   * refused. Returns the stat the check saw, which the open must match.
   */
  const refuseSensitiveTarget = Effect.fn("WorkspaceFileSystem.refuseSensitiveTarget")(function* (
    input: ProjectReadFileInput,
    target: {
      readonly relativePath: string;
      readonly requestedPath: string;
      readonly realTargetPath: string;
    },
  ) {
    const statCache: WorkspaceSensitivePaths.IdentityStatCache = new Map();
    if (
      sensitivePaths.isDenied(target.realTargetPath) ||
      (yield* Effect.promise(() =>
        sensitivePaths.matchesProtectedIdentity(target.realTargetPath, statCache),
      ))
    ) {
      return yield* sensitivePathError(input, target.requestedPath, "open");
    }
    const checkedStat = yield* Effect.promise(
      () =>
        statCache.get(WorkspaceSensitivePaths.identityStatCacheKey(target.realTargetPath)) ??
        Promise.resolve(null),
    );
    return { ...target, checkedStat };
  });

  /**
   * Resolves the file a read targets. Workspace-relative paths must stay inside the
   * root, symlinks included. An absolute path reads a host file in place, such as a
   * report an agent wrote to a temp directory; it gets no root check. Either way
   * neither the requested path nor its realpath may be a protected file.
   */
  const resolveReadTarget = Effect.fn("WorkspaceFileSystem.resolveReadTarget")(function* (
    input: ProjectReadFileInput,
  ) {
    const requestedPath = input.relativePath.trim();
    if (path.isAbsolute(requestedPath)) {
      yield* refuseSensitiveRequest(input, path.resolve(requestedPath));
      const realTargetPath = yield* Effect.tryPromise({
        try: () => WorkspaceSensitivePaths.realpathNative(requestedPath),
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: requestedPath,
            operationPath: requestedPath,
            operation: "realpath-target",
            cause,
          }),
      });
      return yield* refuseSensitiveTarget(input, {
        relativePath: requestedPath,
        requestedPath: path.resolve(requestedPath),
        realTargetPath,
      });
    }

    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });
    yield* refuseSensitiveRequest(input, target.absolutePath);

    const realWorkspaceRoot = yield* Effect.tryPromise({
      try: () => WorkspaceSensitivePaths.realpathNative(input.cwd),
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: target.absolutePath,
          operationPath: input.cwd,
          operation: "realpath-workspace-root",
          cause,
        }),
    });
    const realTargetPath = yield* Effect.tryPromise({
      try: () => WorkspaceSensitivePaths.realpathNative(target.absolutePath),
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: target.absolutePath,
          operationPath: target.absolutePath,
          operation: "realpath-target",
          cause,
        }),
    });
    // A link to a protected file gets the plain refusal, not an escape error that
    // would name where it leads.
    const checked = yield* refuseSensitiveTarget(input, {
      relativePath: target.relativePath,
      requestedPath: target.absolutePath,
      realTargetPath,
    });
    const relativeRealPath = path.relative(realWorkspaceRoot, realTargetPath);
    if (
      relativeRealPath.startsWith(`..${path.sep}`) ||
      relativeRealPath === ".." ||
      path.isAbsolute(relativeRealPath)
    ) {
      return yield* new WorkspaceFilePathEscapeError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedWorkspaceRoot: realWorkspaceRoot,
        resolvedPath: realTargetPath,
      });
    }
    return checked;
  });

  /** Marks a file replaced between the check and the open by one that is not protected. */
  const FILE_CHANGED = { changed: true } as const;

  const readCheckedFile = Effect.fn("WorkspaceFileSystem.readCheckedFile")(function* (
    input: ProjectReadFileInput,
  ) {
    const target = yield* resolveReadTarget(input);
    const realTargetPath = target.realTargetPath;

    return yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        // Non-blocking so a FIFO cannot hang the open; the stat below rejects
        // it. Regular files ignore the flag. No-follow, since the realpath names
        // no link. Windows lacks both.
        try: () =>
          NodeFSP.open(
            realTargetPath,
            NodeFS.constants.O_RDONLY |
              (NodeFS.constants.O_NONBLOCK ?? 0) |
              (NodeFS.constants.O_NOFOLLOW ?? 0),
          ),
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: realTargetPath,
            operationPath: realTargetPath,
            operation: "open",
            cause,
          }),
      }),
      (handle) =>
        Effect.gen(function* () {
          const stat = yield* Effect.tryPromise({
            try: () => handle.stat({ bigint: true }),
            catch: (cause) =>
              new WorkspaceFileSystemOperationError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                resolvedPath: realTargetPath,
                operationPath: realTargetPath,
                operation: "stat",
                cause,
              }),
          });
          // The path can change between the check and the open (a file swapped for
          // a hard link to a secret, a folder for a symlink): the open file must not
          // be a protected file, and must be the one the check saw. An ordinary
          // replacement, such as an editor's atomic save, is checked again.
          if (yield* Effect.promise(() => sensitivePaths.isProtectedFileIdentity(stat))) {
            return yield* sensitivePathError(input, target.requestedPath, "open");
          }
          const checked = target.checkedStat;
          if (checked === null || checked.dev !== stat.dev || checked.ino !== stat.ino) {
            return FILE_CHANGED;
          }
          if (!stat.isFile()) {
            return yield* new WorkspacePathNotFileError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: realTargetPath,
            });
          }

          const size = Number(stat.size);
          // Whiteboards carry their images inline, so they may be larger than other text.
          // A sheet may be saved up to its own limit, so it is read up to it too.
          const cap = isWhiteboardPath(input.relativePath)
            ? WHITEBOARD_LIMITS.bytes
            : input.relativePath.toLowerCase().endsWith(SHEET_ARTIFACT_SUFFIX)
              ? Math.max(SHEET_LIMITS.bytes, PROJECT_READ_FILE_MAX_BYTES)
              : PROJECT_READ_FILE_MAX_BYTES;
          const limit = Math.min(input.maxBytes ?? Infinity, cap);
          const bytesToRead = Math.min(size, limit);
          const buffer = Buffer.alloc(bytesToRead);
          // A read can return fewer bytes than asked; keep reading to the end.
          const bytesRead = yield* Effect.tryPromise({
            try: async () => {
              let offset = 0;
              while (offset < bytesToRead) {
                const read = await handle.read(buffer, offset, bytesToRead - offset, offset);
                if (read.bytesRead === 0) break;
                offset += read.bytesRead;
              }
              return offset;
            },
            catch: (cause) =>
              new WorkspaceFileSystemOperationError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                resolvedPath: realTargetPath,
                operationPath: realTargetPath,
                operation: "read",
                cause,
              }),
          });
          const fileBytes = buffer.subarray(0, bytesRead);
          // A file that shrank while it was read ends early: partial, like a cut at
          // the limit, not invalid text.
          const truncated = size > limit || bytesRead < bytesToRead;
          // A file that is not UTF-8 text is refused, since a save of its lossy
          // decode would corrupt it. A character the limit split is dropped.
          const contents = decodeEditableText(fileBytes, truncated);
          if (contents === null) {
            return yield* new WorkspaceBinaryFileError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: realTargetPath,
            });
          }

          return {
            relativePath: target.relativePath,
            contents,
            byteLength: size,
            truncated,
          };
        }),
      (handle) =>
        Effect.tryPromise({
          try: () => handle.close(),
          catch: (cause) =>
            new WorkspaceFileSystemOperationError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: realTargetPath,
              operationPath: realTargetPath,
              operation: "close",
              cause,
            }),
        }),
    );
  });

  const readFile: WorkspaceFileSystem["Service"]["readFile"] = Effect.fn(
    "WorkspaceFileSystem.readFile",
  )(function* (input) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = yield* readCheckedFile(input);
      if (!("changed" in result)) return result;
    }
    // Replaced again while it was checked: a plain, retryable failure.
    const requestedPath = path.resolve(input.cwd, input.relativePath.trim());
    return yield* new WorkspaceFileSystemOperationError({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
      resolvedPath: requestedPath,
      operationPath: requestedPath,
      operation: "open",
      cause: Object.assign(new Error("The file changed while it was being opened."), {
        code: "EAGAIN",
      }),
    });
  });

  const writeFile: WorkspaceFileSystem["Service"]["writeFile"] = Effect.fn(
    "WorkspaceFileSystem.writeFile",
  )(function* (input, options) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });
    // A client names the workspace root, so a write could otherwise land in
    // ~/.ssh/authorized_keys or the app's own settings. Check the path as given
    // and where it would really be written, through symlinked folders or a
    // symlinked (even dangling) file.
    if (sensitivePaths.isDenied(target.absolutePath, "write")) {
      return yield* sensitivePathError(input, target.absolutePath, "write-file");
    }
    // Write-only locations (login items, launchers, provider config files) are
    // checked by identity too, through the destination and every folder above it.
    const realpath = yield* WorkspaceSensitivePaths.SensitivePathsRealpath;
    const destination = yield* Effect.promise(() =>
      resolveWriteDestination(target.absolutePath, realpath),
    );
    const statCache: WorkspaceSensitivePaths.IdentityStatCache = new Map();
    if (
      destination === null ||
      sensitivePaths.isDenied(destination, "write") ||
      (yield* Effect.promise(() =>
        sensitivePaths.matchesProtectedIdentity(destination, statCache, "write"),
      ))
    ) {
      return yield* sensitivePathError(input, target.absolutePath, "write-file");
    }
    // The caller holds one file open (a live session): a link on the way that was pointed at
    // another file since is caught here, on the destination this write goes to.
    if (options?.destination !== undefined && options.destination !== destination) {
      return yield* new WorkspaceFileSystemOperationError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedPath: target.absolutePath,
        operationPath: destination,
        operation: "open",
        cause: Object.assign(new Error("The path now leads to another file."), { code: "EXDEV" }),
      });
    }
    const checkedStat = yield* Effect.promise(
      () =>
        statCache.get(WorkspaceSensitivePaths.identityStatCacheKey(destination)) ??
        NodeFSP.stat(destination, { bigint: true }).catch(() => null),
    );
    // A file that is not UTF-8 text is never overwritten through this call,
    // whoever asks: its contents could not have come from a read here.
    return yield* Effect.acquireUseRelease(
      Effect.promise(() => readExistingText(destination, checkedStat)),
      (existing) => saveChecked(input, target, destination, existing),
      (existing) =>
        existing.kind === "text"
          ? Effect.promise(() => existing.handle.close().catch(() => undefined))
          : Effect.void,
    );
  });

  const saveChecked = Effect.fn("WorkspaceFileSystem.saveChecked")(function* (
    input: Parameters<WorkspaceFileSystem["Service"]["writeFile"]>[0],
    target: { readonly absolutePath: string; readonly relativePath: string },
    destination: string,
    existing: ExistingFile,
  ) {
    switch (existing.kind) {
      case "not-text":
        return yield* new WorkspaceBinaryFileError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: destination,
        });
      case "not-file":
        return yield* new WorkspacePathNotFileError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: destination,
        });
      case "changed":
      case "failed":
        return yield* new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: destination,
          operationPath: destination,
          operation: existing.kind === "failed" ? existing.operation : "open",
          cause: existing.kind === "failed" ? existing.cause : fileChangedError(),
        });
    }
    // The read drops one leading byte order mark, so a marked file always gets
    // it back: a read-then-save keeps every byte, and a U+FEFF typed at the start
    // stays text. New contents saved over a marked file inherit its mark too, as
    // the file's own encoding choice.
    const contents =
      existing.kind === "text" && existing.leadingBoms > 0
        ? UTF8_BOM + input.contents
        : input.contents;
    const bytes = new TextEncoder().encode(contents);

    // Sheets and whiteboards are saved by the locked compare-and-set writer, so an
    // editor's autosave never overwrites a change made on disk since it read the file.
    if (
      target.relativePath.toLowerCase().endsWith(SHEET_ARTIFACT_SUFFIX) ||
      destination.toLowerCase().endsWith(SHEET_ARTIFACT_SUFFIX) ||
      isWhiteboardPath(target.relativePath) ||
      isWhiteboardPath(destination)
    ) {
      yield* Effect.tryPromise({
        try: async () => {
          const pinned =
            input.expectedRevision === undefined && existing.kind === "text"
              ? await scannedRevision(existing.handle, existing.scanned)
              : undefined;
          // The sheet writer renames over the file, which Windows refuses while
          // the scan still holds it open.
          if (existing.kind === "text") await existing.handle.close();
          // A whiteboard stays inside the project, also through a symlinked
          // folder: the editor opens only files that resolve inside it.
          if (isWhiteboardPath(target.relativePath)) {
            const realRoot = await NodeFSP.realpath(input.cwd);
            const inside = NodePath.relative(realRoot, destination);
            if (inside.startsWith("..") || NodePath.isAbsolute(inside)) {
              throw new Error(`${target.relativePath} leads outside the project.`);
            }
          }
          // A new whiteboard may be the first file in its folder.
          if (existing.kind === "missing") {
            await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
          }
          await writeSheetFileCompareAndSet(
            input.cwd,
            target.relativePath,
            contents,
            input.expectedRevision,
            destination,
            pinned,
          );
        },
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: target.absolutePath,
            operationPath: target.absolutePath,
            operation: "write-file",
            cause,
          }),
      });
      if (existing.kind === "missing") yield* workspaceEntries.refresh(input.cwd);
      return {
        relativePath: target.relativePath,
      };
    }

    yield* fileSystem.makeDirectory(path.dirname(target.absolutePath), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: target.absolutePath,
            operationPath: path.dirname(target.absolutePath),
            operation: "make-directory",
            cause,
          }),
      ),
    );
    // Uninterruptible, so the handle closes only once the write settles and an
    // interrupted save cannot leave the file truncated.
    yield* Effect.tryPromise({
      try: () =>
        existing.kind === "text"
          ? replaceCheckedFile(existing, target.absolutePath, bytes)
          : createCheckedFile(destination, bytes),
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: target.absolutePath,
          operationPath: target.absolutePath,
          operation: "write-file",
          cause,
        }),
    }).pipe(Effect.uninterruptible);
    yield* workspaceEntries.refresh(input.cwd);
    return { relativePath: target.relativePath };
  });

  return WorkspaceFileSystem.of({ readFile, writeFile });
});

export const layer = Layer.effect(WorkspaceFileSystem, make);
