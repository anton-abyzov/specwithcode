// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native filesystem fixtures verify real path resolution.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native filesystem fixtures verify real path resolution.
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import { HostProcessEnvironment, HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import * as Effect from "effect/Effect";
import { afterAll, describe, expect, it } from "vite-plus/test";

import {
  CommandResolutionCache,
  isVolatilePathEntry,
  lastingPathEntriesFirst,
  lastingReplacementForCommand,
  mergePathEntries,
  resolveCommandPath,
  resolveKnownPosixCliDirs,
  resolveSpawnCommand,
} from "./shell.ts";

const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lasting-path-"));
afterAll(() => NodeFS.rmSync(root, { recursive: true, force: true }));

function executable(folder: string, name: string) {
  NodeFS.mkdirSync(folder, { recursive: true });
  const file = NodePath.join(folder, name);
  NodeFS.writeFileSync(file, "#!/bin/sh\nexit 0\n");
  NodeFS.chmodSync(file, 0o755);
  return file;
}

const shellFolder = NodePath.join(root, "run/fnm_multishells/665561_1795096049920/bin");
const goneShellFolder = NodePath.join(root, "run/fnm_multishells/111_222/bin");
const aliasFolder = NodePath.join(root, "fnm/aliases/default/bin");
const perShell = executable(shellFolder, "codex");
const lasting = executable(aliasFolder, "codex");
const env = { PATH: [goneShellFolder, shellFolder, aliasFolder, "/usr/bin"].join(":") };

describe("per-shell PATH folders", () => {
  it("knows fnm's per-shell folders and nothing else", () => {
    expect(isVolatilePathEntry("/run/user/1000/fnm_multishells/665561_1795096049920/bin")).toBe(
      true,
    );
    expect(isVolatilePathEntry("C:\\Users\\me\\AppData\\Local\\fnm_multishells\\123\\")).toBe(true);
    expect(isVolatilePathEntry("/home/me/.local/share/fnm/aliases/default/bin")).toBe(false);
    expect(isVolatilePathEntry("/usr/local/bin")).toBe(false);
  });

  it("puts every lasting folder first and keeps each group's order", () => {
    expect(
      lastingPathEntriesFirst(["/a/fnm_multishells/1/bin", "/b", "/c/fnm_multishells/2/bin", "/d"]),
    ).toEqual(["/b", "/d", "/a/fnm_multishells/1/bin", "/c/fnm_multishells/2/bin"]);
  });

  it("merges a login shell PATH with its per-shell folder last", () => {
    expect(
      mergePathEntries(
        "/run/user/1000/fnm_multishells/9_9/bin:/usr/bin",
        "/home/me/.local/bin",
        "linux",
      ),
    ).toBe("/usr/bin:/home/me/.local/bin:/run/user/1000/fnm_multishells/9_9/bin");
  });

  it("lists fnm's default alias folder among the known folders", () => {
    const dirs = resolveKnownPosixCliDirs({ HOME: "/home/me" }, "linux", () => []);
    expect(dirs).toContain("/home/me/.local/share/fnm/aliases/default/bin");
    expect(
      resolveKnownPosixCliDirs({ HOME: "/h", FNM_DIR: "/opt/fnm" }, "linux", () => []),
    ).toContain("/opt/fnm/aliases/default/bin");
  });
});

describe("saved command paths", () => {
  it("swaps a per-shell path for the same command in a lasting folder", () => {
    expect(lastingReplacementForCommand(perShell, "linux", env)).toBe(lasting);
  });

  it("swaps a path that is gone", () => {
    expect(
      lastingReplacementForCommand(NodePath.join(goneShellFolder, "codex"), "linux", env),
    ).toBe(lasting);
    expect(
      lastingReplacementForCommand(NodePath.join(root, "old/node/v20/bin/codex"), "linux", env),
    ).toBe(lasting);
  });

  it("never swaps a configured path outside a Node version folder for another binary", () => {
    expect(
      lastingReplacementForCommand(NodePath.join(root, "bin/codex"), "linux", env),
    ).toBeUndefined();
    expect(lastingReplacementForCommand("/opt/tools/codex", "linux", env)).toBeUndefined();
  });

  it("keeps a lasting path that exists, and a bare name", () => {
    expect(lastingReplacementForCommand(lasting, "linux", env)).toBeUndefined();
    expect(lastingReplacementForCommand("codex", "linux", env)).toBeUndefined();
  });

  it("keeps a per-shell path when nothing lasting has the command", () => {
    expect(lastingReplacementForCommand(perShell, "linux", { PATH: shellFolder })).toBeUndefined();
  });

  effectIt.effect("gives up on a Windows path read on Linux instead of looking it up forever", () =>
    Effect.gen(function* () {
      const result = yield* resolveCommandPath("C:\\Tools\\codex.exe", { env }).pipe(
        Effect.provideService(HostProcessPlatform, "linux"),
        Effect.provideService(HostProcessEnvironment, env),
        Effect.provideService(CommandResolutionCache, new Map()),
        Effect.provide(NodeServices.layer),
        Effect.timeoutOption(2_000),
        Effect.flip,
        Effect.option,
      );
      expect(result._tag).toBe("Some");
      expect(lastingReplacementForCommand("C:\\Tools\\codex.exe", "linux", env)).toBeUndefined();
    }),
  );

  effectIt.effect("never remembers a per-shell hit", () =>
    Effect.gen(function* () {
      const cache = new Map();
      const only = { PATH: shellFolder };
      const found = yield* resolveCommandPath("codex", { env: only }).pipe(
        Effect.provideService(HostProcessPlatform, "linux"),
        Effect.provideService(HostProcessEnvironment, only),
        Effect.provideService(CommandResolutionCache, cache),
        Effect.provide(NodeServices.layer),
      );
      expect(found).toBe(perShell);
      expect(cache.size).toBe(0);
    }),
  );

  effectIt.effect("spawns a gone or per-shell path from the lasting folder", () =>
    Effect.gen(function* () {
      const spawnFrom = (command: string) =>
        resolveSpawnCommand(command, ["app-server"]).pipe(
          Effect.provideService(HostProcessPlatform, "linux"),
          Effect.provideService(HostProcessEnvironment, env),
          Effect.provideService(CommandResolutionCache, new Map()),
        );
      expect((yield* spawnFrom(perShell)).command).toBe(lasting);
      expect((yield* spawnFrom(NodePath.join(goneShellFolder, "codex"))).command).toBe(lasting);
      expect((yield* spawnFrom(lasting)).command).toBe(lasting);
      expect((yield* spawnFrom("codex")).command).toBe("codex");
    }),
  );

  effectIt.effect("resolves a bare name to the lasting folder ahead of a per-shell one", () =>
    Effect.gen(function* () {
      const resolve = (command: string) =>
        resolveCommandPath(command, { env }).pipe(
          Effect.provideService(HostProcessPlatform, "linux"),
          Effect.provideService(HostProcessEnvironment, env),
          Effect.provideService(CommandResolutionCache, new Map()),
          Effect.provide(NodeServices.layer),
        );
      expect(yield* resolve("codex")).toBe(lasting);
      expect(yield* resolve(perShell)).toBe(lasting);
      expect(yield* resolve(NodePath.join(goneShellFolder, "codex"))).toBe(lasting);
    }),
  );
});
