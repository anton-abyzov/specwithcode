// @effect-diagnostics-next-line nodeBuiltinImport:off -- a shell read and a folder watch are real work; the test clock cannot wait for them.
import { setTimeout as wait } from "node:timers/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { HostProcessEnvironment, HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { TestClock } from "effect/testing";

import {
  LoginShellPath,
  mergeServerPath,
  noteServerPathRead,
  parseRegistryPath,
  readWindowsRegistryPath,
  refreshServerPath,
  startupFilesMark,
} from "./serverPath.ts";

const layerTest = Layer.mergeAll(NodeServices.layer, TestClock.layer());

/** A private home and environment, and a login shell that answers `shellPath`. */
const withServer = <A, E>(
  run: (server: {
    readonly home: string;
    readonly environment: NodeJS.ProcessEnv;
    readonly shell: {
      path: string | undefined;
      reads: number;
      fail: boolean;
      hold?: Promise<void>;
    };
  }) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
  platform: NodeJS.Platform = "darwin",
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      const environment: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", HOME: home };
      const shell: {
        path: string | undefined;
        reads: number;
        fail: boolean;
        hold?: Promise<void>;
      } = { path: "/usr/bin:/bin", reads: 0, fail: false };
      return yield* run({ home, environment, shell }).pipe(
        Effect.provideService(HostProcessEnvironment, environment),
        Effect.provideService(HostProcessPlatform, platform),
        Effect.provideService(LoginShellPath, async () => {
          shell.reads += 1;
          if (shell.hold) await shell.hold;
          if (shell.fail) throw new Error("the shell did not answer");
          return shell.path;
        }),
      );
    }),
  ).pipe(Effect.provide(layerTest));

const folders = (environment: NodeJS.ProcessEnv) => (environment.PATH ?? "").split(":");

describe("refreshServerPath", () => {
  it.effect("adds the usual installer folders without asking the shell", () =>
    withServer(({ home, environment, shell }) =>
      Effect.gen(function* () {
        yield* refreshServerPath({ force: false });
        assert.strictEqual(shell.reads, 0);
        assert.deepStrictEqual(folders(environment).slice(0, 2), ["/usr/bin", "/bin"]);
        assert.include(folders(environment), `${home}/.local/bin`);
      }),
    ),
  );

  it.effect("asks the shell again once a startup file changed, and not before", () =>
    withServer(({ home, environment, shell }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* refreshServerPath({ force: false });
        yield* TestClock.adjust("3 seconds");
        yield* refreshServerPath({ force: false });
        assert.strictEqual(shell.reads, 0);

        // An installer adds its folder to the profile.
        yield* fs.writeFileString(`${home}/.zshrc`, 'export PATH="$HOME/.agent/bin:$PATH"\n');
        shell.path = `${home}/.agent/bin:/usr/bin:/bin`;
        // Looked at no more often than every two seconds.
        yield* refreshServerPath({ force: false });
        assert.strictEqual(shell.reads, 0);
        yield* TestClock.adjust("3 seconds");
        yield* refreshServerPath({ force: false });
        assert.strictEqual(shell.reads, 1);
        // The shell's own order comes first, as it does at server start.
        assert.strictEqual(folders(environment)[0], `${home}/.agent/bin`);

        yield* TestClock.adjust("3 seconds");
        yield* refreshServerPath({ force: false });
        assert.strictEqual(shell.reads, 1);
      }),
    ),
  );

  it.effect("asks the shell when a person insists, one read for callers that overlap", () =>
    withServer(({ home, environment, shell }) =>
      Effect.gen(function* () {
        let release = () => {};
        shell.hold = new Promise<void>((resolve) => {
          release = resolve;
        });
        shell.path = `${home}/tools:/usr/bin`;
        const first = yield* refreshServerPath({ force: true }).pipe(Effect.forkChild);
        const second = yield* refreshServerPath({ force: true }).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Effect.promise(() => wait(20));
        release();
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        assert.strictEqual(shell.reads, 1);
        assert.strictEqual(folders(environment)[0], `${home}/tools`);

        // A read that just finished answers the next click too.
        delete shell.hold;
        yield* refreshServerPath({ force: true });
        assert.strictEqual(shell.reads, 1);
        yield* TestClock.adjust("3 seconds");
        yield* refreshServerPath({ force: true });
        assert.strictEqual(shell.reads, 2);
      }),
    ),
  );

  it.effect("keeps every folder it had, and the PATH itself when the shell fails", () =>
    withServer(({ home, environment, shell }) =>
      Effect.gen(function* () {
        environment.PATH = `/managed/tools:/usr/bin:/bin`;
        shell.path = "/usr/bin";
        yield* refreshServerPath({ force: true });
        assert.include(folders(environment), "/managed/tools");
        assert.include(folders(environment), "/bin");

        const before = environment.PATH;
        shell.fail = true;
        yield* TestClock.adjust("3 seconds");
        yield* refreshServerPath({ force: true });
        assert.strictEqual(environment.PATH, before);
        assert.include(folders(environment), `${home}/.local/bin`);
      }),
    ),
  );

  it.effect("measures a change from server start, before anyone has looked", () =>
    withServer(({ home, environment, shell }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* noteServerPathRead;
        // An installer runs before the first provider is ever looked at.
        yield* fs.writeFileString(`${home}/.zprofile`, 'export PATH="$HOME/.agent/bin:$PATH"\n');
        shell.path = `${home}/.agent/bin:/usr/bin:/bin`;
        yield* refreshServerPath({ force: false });
        assert.strictEqual(shell.reads, 1);
        assert.strictEqual(folders(environment)[0], `${home}/.agent/bin`);
      }),
    ),
  );

  it.effect("asks a shell that failed again, a minute later or at a person's click", () =>
    withServer(({ home, environment, shell }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* noteServerPathRead;
        yield* fs.writeFileString(`${home}/.zshrc`, 'export PATH="$HOME/.agent/bin:$PATH"\n');
        shell.path = `${home}/.agent/bin:/usr/bin:/bin`;
        shell.fail = true;
        yield* refreshServerPath({ force: false });
        assert.strictEqual(shell.reads, 1);
        // Not every few seconds: a shell that hangs costs seconds each time.
        yield* TestClock.adjust("10 seconds");
        yield* refreshServerPath({ force: false });
        assert.strictEqual(shell.reads, 1);

        shell.fail = false;
        yield* TestClock.adjust("60 seconds");
        yield* refreshServerPath({ force: false });
        assert.strictEqual(shell.reads, 2);
        assert.strictEqual(folders(environment)[0], `${home}/.agent/bin`);
        // The change is settled: nothing more to read.
        yield* TestClock.adjust("60 seconds");
        yield* refreshServerPath({ force: false });
        assert.strictEqual(shell.reads, 2);

        shell.fail = true;
        yield* refreshServerPath({ force: true });
        yield* TestClock.adjust("3 seconds");
        shell.fail = false;
        yield* refreshServerPath({ force: true });
        assert.strictEqual(shell.reads, 4);
      }),
    ),
  );

  it.effect("asks the Windows registry on a timer, there being no file to watch", () =>
    withServer(
      ({ environment, shell }) =>
        Effect.gen(function* () {
          environment.PATH = "C:\\Windows";
          shell.path = "C:\\Windows;C:\\Users\\dev\\.agent\\bin";
          yield* refreshServerPath({ force: false });
          assert.strictEqual(shell.reads, 1);
          // What was there keeps its place; what is new is added.
          assert.deepStrictEqual((environment.PATH ?? "").split(";").slice(0, 2), [
            "C:\\Windows",
            "C:\\Users\\dev\\.agent\\bin",
          ]);
          yield* TestClock.adjust("10 seconds");
          yield* refreshServerPath({ force: false });
          assert.strictEqual(shell.reads, 1);
          yield* TestClock.adjust("30 seconds");
          yield* refreshServerPath({ force: false });
          assert.strictEqual(shell.reads, 2);
        }),
      "win32",
    ),
  );
});

describe("startupFilesMark", () => {
  it.effect("changes when a startup file is written, and reads none of them", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped();
        const refuse = () => Effect.die("the mark must not read");
        const statOnly: FileSystem.FileSystem = {
          ...fs,
          readFile: refuse,
          readFileString: refuse,
          readDirectory: refuse,
          open: refuse,
        };
        const mark = startupFilesMark({ HOME: home }, "linux").pipe(
          Effect.provideService(FileSystem.FileSystem, statOnly),
        );
        const before = yield* mark;
        yield* fs.writeFileString(`${home}/.bashrc`, "export PATH=$HOME/bin:$PATH\n");
        const after = yield* mark;
        assert.notStrictEqual(after, before);
        assert.notInclude(after, "export");
        assert.strictEqual(yield* startupFilesMark({ HOME: home }, "win32"), "registry");
      }),
    ).pipe(Effect.provide(layerTest)),
  );
});

describe("Windows registry PATH", () => {
  const user = [
    "",
    "HKEY_CURRENT_USER\\Environment",
    "    Path    REG_EXPAND_SZ    %USERPROFILE%\\.local\\bin;%LOCALAPPDATA%\\Programs\\agent;%UNSET%\\x",
    "",
  ].join("\r\n");
  const environment = {
    USERPROFILE: "C:\\Users\\dev",
    LocalAppData: "C:\\Users\\dev\\AppData\\Local",
  };

  it("fills in the names Windows fills in, and leaves the ones it cannot", () => {
    assert.strictEqual(
      parseRegistryPath(user, environment),
      "C:\\Users\\dev\\.local\\bin;C:\\Users\\dev\\AppData\\Local\\Programs\\agent;%UNSET%\\x",
    );
    assert.strictEqual(parseRegistryPath("ERROR: The system was unable to find", {}), undefined);
  });

  it("reads the machine's folders, then the person's, and survives a key it cannot read", async () => {
    const asked: string[] = [];
    const path = await readWindowsRegistryPath(environment, async (file, args) => {
      asked.push(`${file} ${args.join(" ")}`);
      if (args[1]?.startsWith("HKLM")) return "    Path    REG_SZ    C:\\Windows\\system32\r\n";
      return user;
    });
    assert.strictEqual(asked.length, 2);
    assert.isTrue(path?.startsWith("C:\\Windows\\system32;C:\\Users\\dev\\.local\\bin"));

    const partial = await readWindowsRegistryPath(environment, async (_file, args) => {
      if (args[1]?.startsWith("HKLM")) throw new Error("access denied");
      return user;
    });
    assert.isTrue(partial?.startsWith("C:\\Users\\dev\\.local\\bin"));
    assert.strictEqual(
      await readWindowsRegistryPath(environment, async () => {
        throw new Error("no reg.exe");
      }),
      undefined,
    );
  });

  it("writes back under the name the environment already uses", () => {
    const windows: NodeJS.ProcessEnv = { Path: "C:\\Windows", USERPROFILE: "C:\\Users\\dev" };
    mergeServerPath(windows, "win32", "C:\\Tools;c:\\windows");
    assert.deepStrictEqual(
      Object.keys(windows).filter((key) => key.toUpperCase() === "PATH"),
      ["Path"],
    );
    assert.deepStrictEqual((windows.Path ?? "").split(";").slice(0, 2), [
      "C:\\Windows",
      "C:\\Tools",
    ]);
  });
});
