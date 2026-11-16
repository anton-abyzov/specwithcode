import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";

import {
  commandCandidates,
  commandFolders,
  commandMark,
  commandWatchFolders,
  folderOf,
  watchCommandFolders,
} from "./commandWatch.ts";

/** A name no real folder on the machine running the tests holds. */
const AGENT = "swc-test-agent-1369";

describe("commandCandidates", () => {
  it("looks for a bare name in each PATH folder, then in the usual installer folders", () => {
    const environment = { PATH: "/opt/tools/bin:/usr/bin::/opt/tools/bin", HOME: "/home/dev" };
    const candidates = commandCandidates({ command: AGENT, environment }, "linux");
    assert.deepStrictEqual(candidates.slice(0, 2), [
      `/opt/tools/bin/${AGENT}`,
      `/usr/bin/${AGENT}`,
    ]);
    // Installers put agents here whether or not the shell's PATH names it.
    assert.include(candidates, `/home/dev/.local/bin/${AGENT}`);
    assert.strictEqual(new Set(candidates).size, candidates.length);
  });

  it("takes a saved path as that one file, with the home folder spelled out", () => {
    const environment = { PATH: "/usr/bin", HOME: "/home/dev" };
    assert.deepStrictEqual(
      commandCandidates({ command: "/opt/agent/bin/agent", environment }, "linux"),
      ["/opt/agent/bin/agent"],
    );
    assert.deepStrictEqual(
      commandCandidates({ command: "~/.local/bin/agent", environment }, "darwin"),
      ["/home/dev/.local/bin/agent"],
    );
    assert.deepStrictEqual(commandCandidates({ command: "  ", environment }, "linux"), []);
  });

  it("tries each runnable extension on Windows", () => {
    const environment = {
      Path: "C:\\Tools;C:\\Windows",
      PATHEXT: ".EXE;.CMD",
      USERPROFILE: "C:\\Users\\dev",
    };
    const candidates = commandCandidates({ command: "agent", environment }, "win32");
    assert.deepStrictEqual(candidates.slice(0, 4), [
      "C:\\Tools\\agent.exe",
      "C:\\Tools\\agent.cmd",
      "C:\\Windows\\agent.exe",
      "C:\\Windows\\agent.cmd",
    ]);
    assert.include(candidates, "C:\\Users\\dev\\.local\\bin\\agent.exe");
    assert.deepStrictEqual(
      commandCandidates({ command: "C:\\Tools\\agent.cmd", environment }, "win32"),
      ["C:\\Tools\\agent.cmd"],
    );
  });

  it("names a drive's root as a folder, not the drive alone", () => {
    assert.strictEqual(folderOf("C:\\agent.exe", "win32"), "C:\\");
    assert.strictEqual(folderOf("C:\\Tools\\agent.exe", "win32"), "C:\\Tools");
    assert.strictEqual(folderOf("/agent", "linux"), "/");
    assert.strictEqual(folderOf("/opt/bin/agent", "linux"), "/opt/bin");
  });

  it("does not walk a runaway PATH whole", () => {
    const PATH = Array.from({ length: 500 }, (_, index) => `/p/${index}`).join(":");
    assert.isAtMost(commandFolders({ PATH, HOME: "/home/dev" }, "linux").length, 64);
  });
});

describe("commandMark", () => {
  const inFolder = <A, E>(
    run: (folder: {
      readonly dir: string;
      readonly file: string;
      readonly environment: NodeJS.ProcessEnv;
    }) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped();
        const environment = { PATH: path.join(dir, "bin"), HOME: path.join(dir, "home") };
        yield* fs.makeDirectory(path.join(dir, "bin"));
        return yield* run({ dir, file: path.join(dir, "bin", AGENT), environment });
      }),
    ).pipe(Effect.provide(NodeServices.layer));

  it.live("changes when the command appears, changes and goes", () =>
    inFolder(({ file, environment }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const probe = { command: AGENT, environment };
        const absent = yield* commandMark(probe);
        assert.deepStrictEqual(absent, { mark: "none", path: undefined });

        yield* fs.writeFileString(file, "#!/bin/sh\n");
        const present = yield* commandMark(probe);
        assert.strictEqual(present.path, file);
        assert.notStrictEqual(present.mark, absent.mark);
        assert.deepStrictEqual(yield* commandMark(probe), present);

        // A repair that only makes it runnable is a change too.
        yield* fs.chmod(file, 0o755);
        const runnable = yield* commandMark(probe);
        assert.notStrictEqual(runnable.mark, present.mark);

        yield* fs.writeFileString(file, "#!/bin/sh\nexit 0\n");
        assert.notStrictEqual((yield* commandMark(probe)).mark, runnable.mark);

        yield* fs.remove(file);
        assert.deepStrictEqual(yield* commandMark(probe), absent);
      }),
    ),
  );

  it.live("follows the files a driver names beside the command", () =>
    inFolder(({ dir, file, environment }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const probe = { command: AGENT, environment, beside: [".agent-version"] };
        yield* fs.writeFileString(file, "#!/bin/sh\n");
        const launcherOnly = yield* commandMark(probe);
        // The launcher is untouched; its program landed beside it.
        yield* fs.writeFileString(path.join(dir, "bin", ".agent-version"), "1.2.3-R4\n");
        const withProgram = yield* commandMark(probe);
        assert.notStrictEqual(withProgram.mark, launcherOnly.mark);
        assert.strictEqual(withProgram.path, file);
      }),
    ),
  );

  it.live("does not take a folder of that name for the command", () =>
    inFolder(({ file, environment }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(file);
        assert.deepStrictEqual(yield* commandMark({ command: AGENT, environment }), {
          mark: "none",
          path: undefined,
        });
      }),
    ),
  );

  it.live("opens no file and lists no folder through the file system it is given", () =>
    inFolder(({ dir, file, environment }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.writeFileString(file, "secret-looking contents\n");
        yield* fs.writeFileString(path.join(dir, "bin", ".agent-version"), "1.0.0\n");
        const refuse = () => Effect.die("the mark must not read");
        const statOnly: FileSystem.FileSystem = {
          ...fs,
          readFile: refuse,
          readFileString: refuse,
          readDirectory: refuse,
          open: refuse,
          stream: () => {
            throw new Error("the mark must not read");
          },
        };
        const marked = yield* commandMark({
          command: AGENT,
          environment,
          beside: [".agent-version"],
        }).pipe(Effect.provideService(FileSystem.FileSystem, statOnly));
        assert.strictEqual(marked.path, file);
        assert.notInclude(marked.mark, "secret");
      }),
    ),
  );

  it.live("reads Windows names through the platform it is told", () =>
    inFolder(({ dir, environment }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const folder = `${dir}/bin`;
        yield* fs.writeFileString(`${folder}/agent.cmd`, "@echo off\n");
        // A Windows path on the machine running the tests: the folder is given whole.
        const candidates = commandCandidates(
          { command: `${folder}/agent`, environment: { ...environment, PATHEXT: ".EXE;.CMD" } },
          "win32",
        );
        assert.deepStrictEqual(candidates, [`${folder}/agent.exe`, `${folder}/agent.cmd`]);
        const marked = yield* commandMark({
          command: `${folder}/agent`,
          environment: { ...environment, PATHEXT: ".EXE;.CMD" },
        }).pipe(Effect.provideService(HostProcessPlatform, "win32"));
        assert.strictEqual(marked.path, `${folder}/agent.cmd`);
      }),
    ),
  );
});

describe("watchCommandFolders", () => {
  it.live("tells when something lands in a folder that exists, and skips ones that do not", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped();
        const bin = path.join(dir, "bin");
        yield* fs.makeDirectory(bin);
        const environment = { PATH: `${bin}:${path.join(dir, "not-made-yet")}`, HOME: dir };
        const folders = yield* commandWatchFolders({ command: AGENT, environment });
        assert.include(folders, bin);
        assert.notInclude(folders, path.join(dir, "not-made-yet"));

        const changes = yield* Queue.unbounded<void>();
        yield* watchCommandFolders({
          folders: [...folders, path.join(dir, "not-made-yet")],
          onChange: Queue.offer(changes, undefined).pipe(Effect.asVoid),
          debounce: "50 millis",
        }).pipe(Effect.forkScoped);
        // A folder made a moment ago can still report its own making; that is
        // harmless, since the caller reads the mark. Let it pass, then write.
        yield* Effect.sleep("300 millis");
        yield* Queue.clear(changes);

        yield* fs.writeFileString(path.join(bin, AGENT), "#!/bin/sh\n");
        yield* Queue.take(changes).pipe(Effect.timeout("3 seconds"));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("is nothing at all with no folder to watch", () =>
    watchCommandFolders({ folders: [], onChange: Effect.die("must not run") }).pipe(
      Effect.provide(NodeServices.layer),
    ),
  );
});
