import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const processRunner = yield* ProcessRunner.ProcessRunner;
    return yield* processRunner.run({ command: "git", args: ["-C", cwd, ...args] });
  }).pipe(Effect.provide(ProcessRunner.layer));

const strictWith = <R>(layerProcessRunner: Layer.Layer<ProcessRunner.ProcessRunner, never, R>) =>
  Effect.gen(function* () {
    const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
    return resolver.resolveStrict!;
  }).pipe(
    Effect.provide(
      Layer.effect(
        RepositoryIdentityResolver.RepositoryIdentityResolver,
        RepositoryIdentityResolver.make(),
      ).pipe(Layer.provide(layerProcessRunner)),
    ),
  );

const output = (
  patch: Partial<ProcessRunner.ProcessRunOutput>,
): ProcessRunner.ProcessRunOutput => ({
  stdout: "",
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
  ...patch,
});

it.layer(NodeServices.layer)("RepositoryIdentityResolver.resolveStrict", (it) => {
  it.effect("tells a folder without a repository or remote from one with a remote", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "strict-" }));
        const plain = `${root}/plain`;
        const local = `${root}/local`;
        const remote = `${root}/remote`;
        for (const folder of [plain, local, remote]) yield* fs.makeDirectory(folder);
        yield* git(local, ["init", "-q"]);
        yield* git(remote, ["init", "-q"]);
        yield* git(remote, ["remote", "add", "origin", "git@github.com:acme/api.git"]);
        const strict = yield* strictWith(ProcessRunner.layer);
        expect(yield* strict(plain)).toBeNull();
        expect(yield* strict(local)).toBeNull();
        expect((yield* strict(remote))?.canonicalKey).toBe("github.com/acme/api");
      }),
    ),
  );

  it.effect("fails when git fails or times out, and reads a missing git as no repository", () =>
    Effect.gen(function* () {
      let answer: () => Effect.Effect<
        ProcessRunner.ProcessRunOutput,
        ProcessRunner.ProcessRunError
      > = () =>
        Effect.succeed(
          output({
            code: ChildProcessSpawner.ExitCode(128),
            stderr: "fatal: detected dubious ownership in repository at '/repo'\n",
          }),
        );
      const strict = yield* strictWith(
        Layer.succeed(ProcessRunner.ProcessRunner, { run: () => answer() }),
      );
      const dubious = yield* strict("/repo").pipe(Effect.flip);
      expect(dubious).toMatchObject({
        _tag: "RepositoryIdentityReadError",
        cwd: "/repo",
        detail: "fatal: detected dubious ownership in repository at '/repo'",
      });

      answer = () => Effect.succeed(output({ code: null, timedOut: true }));
      expect((yield* strict("/repo").pipe(Effect.flip)).detail).toBe("git timed out");

      answer = () =>
        Effect.succeed(
          output({
            code: ChildProcessSpawner.ExitCode(128),
            stderr: "fatal: not a git repository (or any of the parent directories): .git\n",
          }),
        );
      expect(yield* strict("/plain")).toBeNull();

      answer = () =>
        Effect.fail(
          new ProcessRunner.ProcessSpawnError({
            command: "git",
            argumentCount: 4,
            cause: Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }),
          }),
        );
      expect(yield* strict("/repo")).toBeNull();
    }),
  );
});
