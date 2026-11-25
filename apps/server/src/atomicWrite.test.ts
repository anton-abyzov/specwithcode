import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";

import { writeFileStringAtomically } from "./atomicWrite.ts";

it.layer(NodeServices.layer)("writeFileStringAtomically", (it) => {
  it.effect("keeps a symlinked file linked and rewrites its destination", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "studio-atomic-write-" });
      const destination = path.join(root, "dotfiles", "settings.json");
      const link = path.join(root, "home", "settings.json");
      yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
      yield* fs.makeDirectory(path.dirname(link), { recursive: true });
      yield* fs.writeFileString(destination, "before");
      yield* fs.symlink(destination, link);

      yield* writeFileStringAtomically({ filePath: link, contents: "after" });

      assert.strictEqual(yield* fs.readLink(link), destination);
      assert.strictEqual(yield* fs.readFileString(destination), "after");
    }),
  );

  it.effect("keeps a dangling symlink linked and creates its destination", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "studio-atomic-write-" });
      const destination = path.join(root, "dotfiles", "settings.json");
      const link = path.join(root, "home", "settings.json");
      yield* fs.makeDirectory(path.dirname(link), { recursive: true });
      yield* fs.symlink(destination, link);

      yield* writeFileStringAtomically({ filePath: link, contents: "fresh" });

      assert.strictEqual(yield* fs.readLink(link), destination);
      assert.strictEqual(yield* fs.readFileString(destination), "fresh");
    }),
  );

  it.effect("fails on a symlink cycle without replacing either link", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "studio-atomic-write-" });
      const first = path.join(root, "first.json");
      const second = path.join(root, "second.json");
      yield* fs.symlink(second, first);
      yield* fs.symlink(first, second);

      const result = yield* Effect.exit(
        writeFileStringAtomically({ filePath: first, contents: "after" }),
      );

      assert.isTrue(Exit.isFailure(result));
      assert.strictEqual(yield* fs.readLink(first), second);
      assert.strictEqual(yield* fs.readLink(second), first);
    }),
  );

  it.effect("resolves a relative link through a symlinked parent directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "studio-atomic-write-" });
      const destination = path.join(root, "dotfiles", "config", "settings.json");
      const linkedState = path.join(root, "dotfiles", "state");
      const home = path.join(root, "home");
      const link = path.join(home, "state", "settings.json");
      yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
      yield* fs.makeDirectory(linkedState, { recursive: true });
      yield* fs.makeDirectory(home, { recursive: true });
      yield* fs.symlink(linkedState, path.join(home, "state"));
      yield* fs.writeFileString(destination, "before");
      yield* fs.symlink("../config/settings.json", link);

      yield* writeFileStringAtomically({ filePath: link, contents: "after" });

      // Windows stores a relative link target with backslashes.
      assert.strictEqual(yield* fs.readLink(link), path.normalize("../config/settings.json"));
      assert.strictEqual(yield* fs.readFileString(destination), "after");
    }),
  );

  it.effect("creates a missing file and its directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "studio-atomic-write-" });
      const filePath = path.join(root, "nested", "settings.json");

      yield* writeFileStringAtomically({ filePath, contents: "fresh" });

      assert.strictEqual(yield* fs.readFileString(filePath), "fresh");
    }),
  );

  it.effect("waits out a Windows scanner holding the target, then replaces it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "studio-atomic-write-" });
      const filePath = path.join(root, "settings.json");
      yield* fs.writeFileString(filePath, "before");
      const firstAttempt = yield* Deferred.make<void>();
      let attempts = 0;
      const lockedTwice = FileSystem.make({
        ...fs,
        rename: (from, to) =>
          Effect.suspend(() => {
            attempts += 1;
            return attempts <= 2
              ? Deferred.succeed(firstAttempt, undefined).pipe(
                  Effect.andThen(Effect.fail(renameError("EBUSY", to))),
                )
              : fs.rename(from, to);
          }),
      });

      const writing = yield* writeFileStringAtomically({ filePath, contents: "after" }).pipe(
        Effect.provideService(FileSystem.FileSystem, lockedTwice),
        Effect.provideService(HostProcessPlatform, "win32"),
        Effect.forkChild,
      );
      yield* Deferred.await(firstAttempt);
      yield* advanceUntilDone(writing);

      assert.strictEqual(attempts, 3);
      assert.strictEqual(yield* fs.readFileString(filePath), "after");
      assert.deepStrictEqual(yield* fs.readDirectory(root), ["settings.json"]);
    }),
  );

  it.effect("gives up on a Windows lock that does not clear and keeps the old contents", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "studio-atomic-write-" });
      const filePath = path.join(root, "settings.json");
      yield* fs.writeFileString(filePath, "before");
      const firstAttempt = yield* Deferred.make<void>();
      let attempts = 0;
      const locked = FileSystem.make({
        ...fs,
        rename: (_from, to) =>
          Effect.suspend(() => {
            attempts += 1;
            return Deferred.succeed(firstAttempt, undefined).pipe(
              Effect.andThen(Effect.fail(renameError("EPERM", to))),
            );
          }),
      });

      const writing = yield* writeFileStringAtomically({ filePath, contents: "after" }).pipe(
        Effect.provideService(FileSystem.FileSystem, locked),
        Effect.provideService(HostProcessPlatform, "win32"),
        Effect.exit,
        Effect.forkChild,
      );
      yield* Deferred.await(firstAttempt);

      assert.isTrue(Exit.isFailure(yield* advanceUntilDone(writing)));
      assert.isAbove(attempts, 1);
      assert.strictEqual(yield* fs.readFileString(filePath), "before");
      assert.deepStrictEqual(yield* fs.readDirectory(root), ["settings.json"]);
    }),
  );

  it.effect("does not replace a newer save that landed while the lock was held", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "studio-atomic-write-" });
      const filePath = path.join(root, "settings.json");
      yield* fs.writeFileString(filePath, "before");
      const firstAttempt = yield* Deferred.make<void>();
      let attempts = 0;
      const lockedOnce = FileSystem.make({
        ...fs,
        rename: (from, to) =>
          Effect.suspend(() => {
            attempts += 1;
            return attempts === 1
              ? Deferred.succeed(firstAttempt, undefined).pipe(
                  Effect.andThen(Effect.fail(renameError("EBUSY", to))),
                )
              : fs.rename(from, to);
          }),
      });

      const stale = yield* writeFileStringAtomically({ filePath, contents: "stale" }).pipe(
        Effect.provideService(FileSystem.FileSystem, lockedOnce),
        Effect.provideService(HostProcessPlatform, "win32"),
        Effect.exit,
        Effect.forkChild,
      );
      yield* Deferred.await(firstAttempt);
      // Another process saves once the lock clears, before the waiting write retries.
      yield* writeFileStringAtomically({ filePath, contents: "newer" });

      assert.isTrue(Exit.isFailure(yield* advanceUntilDone(stale)));
      assert.strictEqual(yield* fs.readFileString(filePath), "newer");
      assert.deepStrictEqual(yield* fs.readDirectory(root), ["settings.json"]);
    }),
  );

  it.effect("fails at once on a read-only Windows target", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "studio-atomic-write-" });
      const filePath = path.join(root, "settings.json");
      yield* fs.writeFileString(filePath, "before");
      yield* Effect.acquireRelease(fs.chmod(filePath, 0o444), () =>
        fs.chmod(filePath, 0o644).pipe(Effect.ignore),
      );
      let attempts = 0;
      const denied = FileSystem.make({
        ...fs,
        rename: (_from, to) =>
          Effect.suspend(() => {
            attempts += 1;
            return Effect.fail(renameError("EPERM", to));
          }),
      });

      const writing = yield* writeFileStringAtomically({ filePath, contents: "after" }).pipe(
        Effect.provideService(FileSystem.FileSystem, denied),
        Effect.provideService(HostProcessPlatform, "win32"),
        Effect.exit,
        Effect.forkChild,
      );
      assert.isTrue(Exit.isFailure(yield* advanceUntilDone(writing)));
      assert.strictEqual(attempts, 1);
      assert.strictEqual(yield* fs.readFileString(filePath), "before");
    }),
  );

  it.effect("does not retry a refused rename off Windows", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "studio-atomic-write-" });
      const filePath = path.join(root, "settings.json");
      yield* fs.writeFileString(filePath, "before");
      let attempts = 0;
      const busy = FileSystem.make({
        ...fs,
        rename: (_from, to) =>
          Effect.suspend(() => {
            attempts += 1;
            return Effect.fail(renameError("EBUSY", to));
          }),
      });

      const result = yield* writeFileStringAtomically({ filePath, contents: "after" }).pipe(
        Effect.provideService(FileSystem.FileSystem, busy),
        Effect.provideService(HostProcessPlatform, "linux"),
        Effect.exit,
      );

      assert.isTrue(Exit.isFailure(result));
      assert.strictEqual(attempts, 1);
      assert.strictEqual(yield* fs.readFileString(filePath), "before");
    }),
  );
});

// Retries stat the real target between waits, and that I/O finishes outside the
// test clock, so the clock moves one wait at a time until the write settles.
const advanceUntilDone = <A, E>(fiber: Fiber.Fiber<A, E>) =>
  Effect.gen(function* () {
    while (fiber.pollUnsafe() === undefined) {
      yield* TestClock.adjust("100 millis");
      yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
    }
    return yield* Fiber.join(fiber);
  });

const renameError = (code: string, path: string) =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "FileSystem",
    method: "rename",
    pathOrDescriptor: path,
    cause: Object.assign(new Error(`${code}, rename`), { code }),
  });

it.effect("surfaces an unreadable link instead of writing over it", () =>
  Effect.gen(function* () {
    const readLinkFailure = PlatformError.systemError({
      _tag: "Unknown",
      module: "FileSystem",
      method: "readLink",
      pathOrDescriptor: "/home/settings.json",
    });

    const result = yield* Effect.exit(
      writeFileStringAtomically({ filePath: "/home/settings.json", contents: "after" }),
    );

    assert.deepStrictEqual(result, Exit.fail(readLinkFailure));
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Path.layer,
        FileSystem.layerNoop({
          readLink: () =>
            Effect.fail(
              PlatformError.systemError({
                _tag: "Unknown",
                module: "FileSystem",
                method: "readLink",
                pathOrDescriptor: "/home/settings.json",
              }),
            ),
          rename: () => Effect.die("an unreadable link must not be replaced"),
        }),
      ),
    ),
  ),
);

it.effect("succeeds when the write lands but its temp directory cannot be removed", () =>
  Effect.gen(function* () {
    const renamed: Array<string> = [];
    const removed: Array<string> = [];
    const fileSystem = FileSystem.layerNoop({
      // The target does not exist yet, so it is written in place.
      readLink: (path) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "NotFound",
            module: "FileSystem",
            method: "readLink",
            pathOrDescriptor: path,
          }),
        ),
      makeDirectory: () => Effect.void,
      makeTempDirectory: () => Effect.succeed("/home/settings.json.abc123"),
      stat: (path) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "NotFound",
            module: "FileSystem",
            method: "stat",
            pathOrDescriptor: path,
          }),
        ),
      chmod: () => Effect.void,
      open: () =>
        Effect.succeed({
          writeAll: () => Effect.void,
          sync: Effect.void,
        } as unknown as FileSystem.File),
      rename: (_from, to) => Effect.sync(() => void renamed.push(to)),
      remove: (path) =>
        Effect.sync(() => void removed.push(path)).pipe(
          Effect.andThen(
            Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "remove",
                pathOrDescriptor: path,
              }),
            ),
          ),
        ),
    });

    const result = yield* Effect.exit(
      writeFileStringAtomically({ filePath: "/home/settings.json", contents: "after" }).pipe(
        Effect.provide(Layer.mergeAll(Path.layer, fileSystem)),
      ),
    );

    assert.deepStrictEqual(result, Exit.void);
    assert.deepStrictEqual(renamed, ["/home/settings.json"]);
    assert.deepStrictEqual(removed, ["/home/settings.json.abc123"]);
  }),
);

it.layer(NodeServices.layer)("writeFileStringAtomically file modes", (it) => {
  it.effect.skipIf(process.platform === "win32")(
    "keeps the replaced file's mode and creates a new file owner-only",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "studio-atomic-mode-" });
        const secret = path.join(root, "secret.json");
        const shared = path.join(root, "shared.json");
        const fresh = path.join(root, "fresh.json");
        const locked = path.join(root, "locked.json");
        yield* fs.writeFileString(locked, "before");
        yield* fs.chmod(locked, 0o000);
        yield* fs.writeFileString(secret, "before");
        yield* fs.chmod(secret, 0o600);
        yield* fs.writeFileString(shared, "before");
        yield* fs.chmod(shared, 0o644);

        for (const filePath of [secret, shared, fresh, locked]) {
          yield* writeFileStringAtomically({ filePath, contents: "after" });
          assert.equal(yield* fs.readFileString(filePath), "after");
        }
        const mode = (filePath: string) =>
          fs.stat(filePath).pipe(Effect.map((info) => info.mode & 0o777));
        assert.equal(yield* mode(secret), 0o600);
        assert.equal(yield* mode(shared), 0o644);
        assert.equal(yield* mode(fresh), 0o600);
        // The owner keeps read and write, so a save repairs a file it could not read.
        assert.equal(yield* mode(locked), 0o600);
      }).pipe(Effect.scoped, Effect.provideService(HostProcessPlatform, process.platform)),
  );
});

it.effect(
  "syncs the data before the rename and the folder after, ignoring a folder sync that fails",
  () =>
    Effect.gen(function* () {
      const events: Array<string> = [];
      // A folder that opens but cannot be synced, as on Windows.
      const unsyncable = {
        writeAll: () => Effect.void,
        sync: Effect.fail(
          PlatformError.systemError({
            _tag: "BadResource",
            module: "FileSystem",
            method: "sync",
            pathOrDescriptor: "/home",
            cause: Object.assign(new Error("EBADF"), { code: "EBADF" }),
          }),
        ),
      } as unknown as FileSystem.File;
      const file = (name: string) =>
        ({
          writeAll: () => Effect.sync(() => void events.push(`write ${name}`)),
          sync: Effect.sync(() => void events.push(`sync ${name}`)),
        }) as unknown as FileSystem.File;
      const fileSystem = (folderOpen: "ok" | "refused" | "unsyncable") =>
        FileSystem.layerNoop({
          readLink: (path) =>
            Effect.fail(
              PlatformError.systemError({
                _tag: "NotFound",
                module: "FileSystem",
                method: "readLink",
                pathOrDescriptor: path,
              }),
            ),
          makeDirectory: () => Effect.void,
          makeTempDirectory: () => Effect.succeed("/home/settings.json.abc123"),
          stat: () => Effect.succeed({ mode: 0o100600 } as unknown as FileSystem.File.Info),
          chmod: (_path, mode) => Effect.sync(() => void events.push(`chmod ${mode.toString(8)}`)),
          open: (path) =>
            path === "/home" && folderOpen === "refused"
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "open",
                    pathOrDescriptor: path,
                  }),
                )
              : path === "/home" && folderOpen === "unsyncable"
                ? Effect.succeed(unsyncable)
                : Effect.succeed(file(path === "/home" ? "folder" : "temp")),
          rename: () => Effect.sync(() => void events.push("rename")),
          remove: () => Effect.void,
        });
      const save = (folderOpen: "ok" | "refused" | "unsyncable") =>
        Effect.exit(
          writeFileStringAtomically({ filePath: "/home/settings.json", contents: "after" }).pipe(
            Effect.provide(Layer.mergeAll(Path.layer, fileSystem(folderOpen))),
            Effect.provideService(HostProcessPlatform, "linux"),
          ),
        );

      assert.deepStrictEqual(yield* save("ok"), Exit.void);
      assert.deepStrictEqual(events, [
        "write temp",
        "chmod 600",
        "sync temp",
        "rename",
        "sync folder",
      ]);
      events.length = 0;
      assert.deepStrictEqual(yield* save("refused"), Exit.void);
      assert.deepStrictEqual(events, ["write temp", "chmod 600", "sync temp", "rename"]);
      // The rename has landed by then, so the save stands.
      events.length = 0;
      assert.deepStrictEqual(yield* save("unsyncable"), Exit.void);
      assert.deepStrictEqual(events, ["write temp", "chmod 600", "sync temp", "rename"]);
    }),
);
