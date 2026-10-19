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
    return `Workspace file '${this.relativePath}' in '${this.workspaceRoot}' is binary and cannot be previewed as text.`;
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
    return resolveWriteDestination(
      NodePath.resolve(NodePath.dirname(absolute), link),
      realpath,
      depth + 1,
    );
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
          const bytesToRead = Math.min(size, PROJECT_READ_FILE_MAX_BYTES);
          const buffer = Buffer.alloc(bytesToRead);
          const { bytesRead } = yield* Effect.tryPromise({
            try: () => handle.read(buffer, 0, bytesToRead, 0),
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
          if (fileBytes.includes(0)) {
            return yield* new WorkspaceBinaryFileError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: realTargetPath,
            });
          }

          return {
            relativePath: target.relativePath,
            contents: new TextDecoder("utf-8").decode(fileBytes),
            byteLength: size,
            truncated: size > PROJECT_READ_FILE_MAX_BYTES,
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
  )(function* (input) {
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
    if (
      destination === null ||
      sensitivePaths.isDenied(destination, "write") ||
      (yield* Effect.promise(() =>
        sensitivePaths.matchesProtectedIdentity(destination, new Map(), "write"),
      ))
    ) {
      return yield* sensitivePathError(input, target.absolutePath, "write-file");
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
    yield* fileSystem.writeFileString(target.absolutePath, input.contents).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: target.absolutePath,
            operationPath: target.absolutePath,
            operation: "write-file",
            cause,
          }),
      ),
    );
    yield* workspaceEntries.refresh(input.cwd);
    return { relativePath: target.relativePath };
  });

  return WorkspaceFileSystem.of({ readFile, writeFile });
});

export const layer = Layer.effect(WorkspaceFileSystem, make);
