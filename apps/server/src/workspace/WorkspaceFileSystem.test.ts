// @effect-diagnostics nodeBuiltinImport:off - FileSystem cannot create a FIFO or change a file mode.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import { symlinksSupported } from "@specweave-studio/shared/testing/symlinks";

const layerProject = WorkspaceFileSystem.layer.pipe(
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
);

const layerTest = Layer.empty.pipe(
  Layer.provideMerge(layerProject),
  Layer.provideMerge(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
  Layer.provide(
    ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "studio-workspace-files-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "studio-workspace-files-",
  });
});

const writeTextFile = Effect.fn("writeTextFile")(function* (
  cwd: string,
  relativePath: string,
  contents = "",
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem
    .makeDirectory(path.dirname(absolutePath), { recursive: true })
    .pipe(Effect.orDie);
  yield* fileSystem.writeFileString(absolutePath, contents).pipe(Effect.orDie);
});

/** The prototype every open file handle shares, so a test can stand in for one of its calls. */
const fileHandlePrototype = Effect.promise(async () => {
  const handle = await NodeFSP.open(process.execPath, "r");
  try {
    return Object.getPrototypeOf(handle) as NodeFSP.FileHandle;
  } finally {
    await handle.close();
  }
});

/** Reads that return at most `firstBytes` on the first call for a `length`-byte request. */
const shortenFirstRead = Effect.fn("shortenFirstRead")(function* (
  length: number,
  firstBytes: number,
  afterwards: "continue" | "end",
) {
  const prototype = yield* fileHandlePrototype;
  const original: (
    this: NodeFSP.FileHandle,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => Promise<{ readonly bytesRead: number; readonly buffer: Buffer }> = prototype.read;
  let calls = 0;
  return vi.spyOn(prototype, "read").mockImplementation(function (
    this: NodeFSP.FileHandle,
    buffer: Buffer,
    offset: number,
    requested: number,
    position: number,
  ) {
    if (requested === length && calls === 0) {
      calls += 1;
      return original.call(this, buffer, offset, firstBytes, position);
    }
    if (calls > 0 && afterwards === "end") {
      return Promise.resolve({ bytesRead: 0, buffer });
    }
    return original.call(this, buffer, offset, requested, position);
  } as unknown as typeof prototype.read);
});

const isWindows = HostProcessPlatform.defaultValue() === "win32";

it.layer(layerTest, { excludeTestServices: true })("WorkspaceFileSystemLive", (it) => {
  describe("readFile", () => {
    it.effect("reads UTF-8 files relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/index.ts", "export const answer = 42;\n");

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "src/index.ts",
        });

        expect(result).toEqual({
          relativePath: "src/index.ts",
          contents: "export const answer = 42;\n",
          byteLength: 26,
          truncated: false,
        });
      }),
    );

    it.effect("reads only the start of a file when a preview asks for it", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "long.md", "# Title\n\nA long report.\n");

        const start = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "long.md",
          maxBytes: 7,
        });
        expect(start.contents).toBe("# Title");
        expect(start.byteLength).toBe(24);
        expect(start.truncated).toBe(true);

        const whole = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "long.md",
          maxBytes: 1024,
        });
        expect(whole.contents).toBe("# Title\n\nA long report.\n");
        expect(whole.truncated).toBe(false);
      }),
    );

    it.effect("drops a character the read limit splits instead of corrupting it", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "menu.md", "café au lait\n");

        const start = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "menu.md",
          maxBytes: 4,
        });
        expect(start.contents).toBe("caf");
        expect(start.truncated).toBe(true);
      }),
    );

    it.effect("keeps reading after a short read instead of calling the file binary", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        // 14 bytes; the first read stops inside the two-byte "é".
        yield* writeTextFile(cwd, "menu.md", "café au lait\n");
        const spy = yield* shortenFirstRead(14, 4, "continue");

        const read = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "menu.md" })
          .pipe(Effect.ensuring(Effect.sync(() => spy.mockRestore())));

        expect(read).toMatchObject({ contents: "café au lait\n", truncated: false });
      }),
    );

    it.effect("reports a file that shrank during the read as partial, not binary", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "menu.md", "café au lait\n");
        const spy = yield* shortenFirstRead(14, 4, "end");

        const read = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "menu.md" })
          .pipe(Effect.ensuring(Effect.sync(() => spy.mockRestore())));

        expect(read).toMatchObject({ contents: "caf", truncated: true });
      }),
    );

    it.effect("reads host files outside the workspace root by absolute path", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outsideDir = yield* makeTempDir;
        yield* writeTextFile(outsideDir, "cleanup-report.md", "# Report\n");
        const absolutePath = path.join(outsideDir, "cleanup-report.md");

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: absolutePath,
        });

        expect(result).toEqual({
          relativePath: absolutePath,
          contents: "# Report\n",
          byteLength: 9,
          truncated: false,
        });
      }),
    );

    // Needs mkfifo; Windows has no FIFOs to reject.
    it.effect.skipIf(HostProcessPlatform.defaultValue() === "win32")(
      "rejects a FIFO without blocking on open",
      () =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const path = yield* Path.Path;
          const cwd = yield* makeTempDir;
          const outsideDir = yield* makeTempDir;
          const fifoPath = path.join(outsideDir, "pipe");
          yield* Effect.promise(
            () =>
              new Promise<void>((resolve, reject) =>
                NodeChildProcess.execFile("mkfifo", [fifoPath], (error) =>
                  error ? reject(error) : resolve(),
                ),
              ),
          );

          const error = yield* workspaceFileSystem
            .readFile({ cwd, relativePath: fifoPath })
            .pipe(Effect.flip);

          expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspacePathNotFileError);
        }),
    );

    it.effect("rejects reads outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "../escape.md" })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.md",
        );
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "rejects symlinks that resolve outside the workspace root",
      () =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* makeTempDir;
          const outsideDir = yield* makeTempDir;
          yield* writeTextFile(outsideDir, "secret.txt", "outside\n");
          yield* fileSystem.symlink(
            path.join(outsideDir, "secret.txt"),
            path.join(cwd, "linked-secret.txt"),
          );

          const error = yield* workspaceFileSystem
            .readFile({ cwd, relativePath: "linked-secret.txt" })
            .pipe(Effect.flip);
          const resolvedWorkspaceRoot = yield* fileSystem.realPath(cwd);
          const resolvedPath = yield* fileSystem.realPath(path.join(outsideDir, "secret.txt"));

          expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFilePathEscapeError);
          expect(error).toMatchObject({
            workspaceRoot: cwd,
            relativePath: "linked-secret.txt",
            resolvedWorkspaceRoot,
            resolvedPath,
          });
          expect("cause" in error).toBe(false);
        }),
    );

    it.effect("rejects directories without manufacturing an I/O cause", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* fileSystem.makeDirectory(path.join(cwd, "src"));

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "src" })
          .pipe(Effect.flip);
        const resolvedPath = yield* fileSystem.realPath(path.join(cwd, "src"));

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspacePathNotFileError);
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: "src",
          resolvedPath,
        });
        expect("cause" in error).toBe(false);
      }),
    );

    it.effect.each([
      { name: "a NUL byte", bytes: [0x61, 0, 0x62] },
      // "café" saved as Latin-1.
      { name: "invalid UTF-8", bytes: [0x63, 0x61, 0x66, 0xe9] },
      // "hi" saved as UTF-16 LE with its byte order mark.
      { name: "UTF-16 text", bytes: [0xff, 0xfe, 0x68, 0x00, 0x69, 0x00] },
    ])("rejects files with $name without leaking their contents into the error", ({ bytes }) =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const absolutePath = path.join(cwd, "asset.bin");
        yield* fileSystem.writeFile(absolutePath, Uint8Array.from(bytes));

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "asset.bin" })
          .pipe(Effect.flip);
        const resolvedPath = yield* fileSystem.realPath(absolutePath);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceBinaryFileError);
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: "asset.bin",
          resolvedPath,
        });
        expect("cause" in error).toBe(false);
        expect("contents" in error).toBe(false);
      }),
    );

    // October 20, 2026: a report linked `~/.specwithcode/audits/2026-10-20/findings-{B,C,D,E}.md`.
    // The real files under an app home read; the shorthand is not a file; state stays refused.
    it.effect("reads report files under an app home and refuses its state", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const home = yield* makeTempDir;
        const audit = path.join(home, ".specwithcode", "audits", "2026-10-20");
        yield* writeTextFile(audit, "findings-B.md", "# Batch B\n");
        yield* writeTextFile(path.join(home, ".specwithcode", "userdata"), "state.md", "secret");

        const found = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: path.join(audit, "findings-B.md"),
        });
        expect(found.contents).toBe("# Batch B\n");

        const brace = path.join(audit, "findings-{B,C,D,E}.md");
        const missing = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: brace })
          .pipe(Effect.flip);
        expect(missing).toMatchObject({ operation: "realpath-target", resolvedPath: brace });
        expect((missing as { cause: NodeJS.ErrnoException }).cause.code).toBe("ENOENT");

        const refused = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: path.join(home, ".specwithcode", "userdata", "state.md") })
          .pipe(Effect.flip);
        expect(refused).toMatchObject({ reason: "protected" });
      }),
    );

    it.effect("preserves the real cause and path for I/O failures", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const resolvedPath = path.join(cwd, "missing.txt");

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "missing.txt" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileSystemOperationError);
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: "missing.txt",
          resolvedPath,
          operationPath: resolvedPath,
          operation: "realpath-target",
        });
        expect(error.cause).toBeInstanceOf(Error);
        expect((error.cause as NodeJS.ErrnoException).code).toBe("ENOENT");
      }),
    );
  });

  describe("writeFile", () => {
    it.effect("writes files relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
        });
        const saved = yield* fileSystem
          .readFileString(path.join(cwd, "plans/effect-rpc.md"))
          .pipe(Effect.orDie);

        expect(result).toEqual({ relativePath: "plans/effect-rpc.md" });
        expect(saved).toBe("# Plan\n");
      }),
    );

    it.effect("keeps a UTF-8 byte order mark when an edited file is saved", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const bomContents = "\uFEFFexport const answer = 42;\n";
        yield* writeTextFile(cwd, "bom.ts", bomContents);

        const read = yield* workspaceFileSystem.readFile({ cwd, relativePath: "bom.ts" });
        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "bom.ts",
          contents: read.contents.replace("42", "43"),
        });
        const saved = yield* fileSystem.readFile(path.join(cwd, "bom.ts")).pipe(Effect.orDie);

        expect([...saved]).toEqual([...new TextEncoder().encode(bomContents.replace("42", "43"))]);
        expect([...saved.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      }),
    );

    it.effect("keeps a U+FEFF typed at the start of a file with a byte order mark", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const absolutePath = path.join(cwd, "mark.txt");
        yield* fileSystem.writeFile(absolutePath, Uint8Array.from([0xef, 0xbb, 0xbf, 0x78]));

        const read = yield* workspaceFileSystem.readFile({ cwd, relativePath: "mark.txt" });
        expect(read.contents).toBe("x");
        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "mark.txt",
          contents: "\uFEFF" + read.contents,
        });
        const saved = yield* fileSystem.readFile(absolutePath).pipe(Effect.orDie);
        const reread = yield* workspaceFileSystem.readFile({ cwd, relativePath: "mark.txt" });

        expect([...saved]).toEqual([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, 0x78]);
        expect(reread.contents).toBe("\uFEFFx");
      }),
    );

    it.effect("refuses to overwrite a file that is not UTF-8 text", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const absolutePath = path.join(cwd, "legacy.txt");
        // "café" saved as Latin-1; a lossy decode would show "caf\uFFFD".
        const latin1 = Uint8Array.from([0x63, 0x61, 0x66, 0xe9, 0x0a]);
        yield* fileSystem.writeFile(absolutePath, latin1);

        const error = yield* workspaceFileSystem
          .writeFile({ cwd, relativePath: "legacy.txt", contents: "caf\uFFFD edited\n" })
          .pipe(Effect.flip);
        const saved = yield* fileSystem.readFile(absolutePath).pipe(Effect.orDie);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceBinaryFileError);
        expect(error).toMatchObject({ workspaceRoot: cwd, relativePath: "legacy.txt" });
        expect([...saved]).toEqual([...latin1]);
      }),
    );

    it.effect("saves a file that starts with two byte order marks unchanged", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const absolutePath = path.join(cwd, "marks.txt");
        const original = Uint8Array.from([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, 0x78]);
        yield* fileSystem.writeFile(absolutePath, original);

        // The read drops one mark and shows the other as text.
        const read = yield* workspaceFileSystem.readFile({ cwd, relativePath: "marks.txt" });
        expect(read.contents).toBe("\uFEFFx");
        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "marks.txt",
          contents: read.contents,
        });
        const saved = yield* fileSystem.readFile(absolutePath).pipe(Effect.orDie);

        expect([...saved]).toEqual([...original]);
      }),
    );

    it.effect.each([
      { name: "an invalid UTF-8 byte", byte: 0xe9 },
      { name: "a NUL byte", byte: 0x00 },
    ])("refuses to overwrite a file with $name past the read limit", ({ byte }) =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const absolutePath = path.join(cwd, "large.log");
        const large = new Uint8Array(2 * 1024 * 1024).fill(0x61);
        large[1024 * 1024 + 5] = byte;
        yield* fileSystem.writeFile(absolutePath, large);

        const error = yield* workspaceFileSystem
          .writeFile({ cwd, relativePath: "large.log", contents: "replaced\n" })
          .pipe(Effect.flip);
        const saved = yield* fileSystem.readFile(absolutePath).pipe(Effect.orDie);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceBinaryFileError);
        expect(saved.byteLength).toBe(large.byteLength);
        expect(saved[1024 * 1024 + 5]).toBe(byte);
      }),
    );

    // Windows has no write-only file mode, and root reads any file.
    it.effect.skipIf(isWindows || process.getuid?.() === 0)(
      "refuses to overwrite a file it cannot read to check",
      () =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* makeTempDir;
          const absolutePath = path.join(cwd, "legacy.txt");
          const latin1 = Uint8Array.from([0x63, 0x61, 0x66, 0xe9, 0x0a]);
          yield* fileSystem.writeFile(absolutePath, latin1);
          yield* Effect.promise(() => NodeFSP.chmod(absolutePath, 0o200));

          const error = yield* workspaceFileSystem
            .writeFile({ cwd, relativePath: "legacy.txt", contents: "edited\n" })
            .pipe(Effect.flip);
          yield* Effect.promise(() => NodeFSP.chmod(absolutePath, 0o600));
          const saved = yield* fileSystem.readFile(absolutePath).pipe(Effect.orDie);

          expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileSystemOperationError);
          expect(error).toMatchObject({ relativePath: "legacy.txt", operation: "open" });
          expect([...saved]).toEqual([...latin1]);
        }),
    );

    // Windows may refuse to open a folder at all; elsewhere it opens and is not a file.
    it.effect.skipIf(isWindows)("refuses to write over a path that is not a regular file", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* fileSystem.makeDirectory(path.join(cwd, "notes"));

        const error = yield* workspaceFileSystem
          .writeFile({ cwd, relativePath: "notes", contents: "text\n" })
          .pipe(Effect.flip);
        const info = yield* fileSystem.stat(path.join(cwd, "notes")).pipe(Effect.orDie);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspacePathNotFileError);
        expect(info.type).toBe("Directory");
      }),
    );

    it.effect("refuses to save when the file changed between the check and the probe", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const absolutePath = path.join(cwd, "notes.md");
        yield* writeTextFile(cwd, "notes.md", "before\n");
        // The opened file reports another inode, as if the path was swapped after the check.
        const prototype = yield* fileHandlePrototype;
        const original: (
          this: NodeFSP.FileHandle,
          options?: { readonly bigint?: boolean },
        ) => Promise<{ readonly ino: number | bigint }> = prototype.stat;
        const spy = vi.spyOn(prototype, "stat").mockImplementation(async function (
          this: NodeFSP.FileHandle,
          options?: { readonly bigint?: boolean },
        ) {
          const stat = await original.call(this, options);
          Object.defineProperty(stat, "ino", {
            value: typeof stat.ino === "bigint" ? stat.ino + 1n : stat.ino + 1,
          });
          return stat;
        } as unknown as typeof prototype.stat);

        const error = yield* workspaceFileSystem
          .writeFile({ cwd, relativePath: "notes.md", contents: "after\n" })
          .pipe(Effect.flip, Effect.ensuring(Effect.sync(() => spy.mockRestore())));
        const saved = yield* fileSystem.readFileString(absolutePath).pipe(Effect.orDie);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileSystemOperationError);
        expect(error).toMatchObject({ relativePath: "notes.md", operation: "open" });
        expect(saved).toBe("before\n");
      }),
    );

    it.effect("leaves a file swapped in after the check alone", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const absolutePath = path.join(cwd, "notes.md");
        yield* writeTextFile(cwd, "notes.md", "before\n");
        // Once the check has read the UTF-8 file, a Latin-1 copy replaces it.
        const latin1 = Uint8Array.from([0x63, 0x61, 0x66, 0xe9, 0x0a]);
        const prototype = yield* fileHandlePrototype;
        const original: (
          this: NodeFSP.FileHandle,
          buffer: Buffer,
          offset: number,
          length: number,
          position: number,
        ) => Promise<{ readonly bytesRead: number; readonly buffer: Buffer }> = prototype.read;
        let swapped = false;
        const spy = vi.spyOn(prototype, "read").mockImplementation(async function (
          this: NodeFSP.FileHandle,
          buffer: Buffer,
          offset: number,
          length: number,
          position: number,
        ) {
          const result = await original.call(this, buffer, offset, length, position);
          if (!swapped) {
            swapped = true;
            const copy = path.join(cwd, "notes.latin1");
            await NodeFSP.writeFile(copy, latin1);
            await NodeFSP.rename(copy, absolutePath);
          }
          return result;
        } as unknown as typeof prototype.read);

        const error = yield* workspaceFileSystem
          .writeFile({ cwd, relativePath: "notes.md", contents: "after\n" })
          .pipe(Effect.flip, Effect.ensuring(Effect.sync(() => spy.mockRestore())));
        const saved = yield* fileSystem.readFile(absolutePath).pipe(Effect.orDie);

        expect(swapped).toBe(true);
        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileSystemOperationError);
        expect(error).toMatchObject({ relativePath: "notes.md", operation: "write-file" });
        expect([...saved]).toEqual([...latin1]);
      }),
    );

    it.effect("rejects writes by absolute path", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outsideDir = yield* makeTempDir;
        const absolutePath = path.join(outsideDir, "cleanup-report.md");

        const error = yield* workspaceFileSystem
          .writeFile({ cwd, relativePath: absolutePath, contents: "# Edited\n" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspacePaths.WorkspacePathOutsideRootError);
      }),
    );

    it.effect("invalidates workspace entry search cache after writes", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/existing.ts", "export {};\n");

        const beforeWrite = yield* workspaceEntries.list({ cwd });
        expect(beforeWrite.entries.some((entry) => entry.path === "plans/effect-rpc.md")).toBe(
          false,
        );

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
        });

        const afterWrite = yield* workspaceEntries.list({ cwd });
        expect(afterWrite.entries).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: "plans/effect-rpc.md" })]),
        );
        expect(afterWrite.truncated).toBe(false);
      }),
    );

    it.effect("rejects writes outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "../escape.md",
            contents: "# nope\n",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.md",
        );

        const escapedPath = path.resolve(cwd, "..", "escape.md");
        const escapedStat = yield* fileSystem
          .stat(escapedPath)
          .pipe(Effect.orElseSucceed(() => null));
        expect(escapedStat).toBeNull();
      }),
    );
  });
});
