import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, assert, beforeEach, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import * as GitHubApi from "../sourceControl/GitHubApi.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { cascadeRebaseStack } from "./githubStackRebase.ts";

const layer = Layer.mergeAll(
  Layer.mock(GitHubApi.GitHubApi)({
    credential: () => Effect.succeed({ token: Redacted.make("token"), fingerprint: "fp" }),
  }),
  VcsProcess.layer,
).pipe(Layer.provideMerge(NodeServices.layer));

// The cascade commits as the machine's own git identity, so the suite supplies one and keeps
// the developer's ~/.gitconfig out of it.
beforeEach(() => {
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("GIT_COMMITTER_NAME", "Stack Owner");
  vi.stubEnv("GIT_COMMITTER_EMAIL", "owner@example.com");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * A bare "GitHub" holding the live-run stack: `main` moved ahead after the stack was cut, and a
 * second layer sits on the first. Returns each branch's head.
 */
const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const process = yield* VcsProcess.VcsProcess;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "studio-cascade-test-" });
  const remote = `${root}/remote.git`;
  const work = `${root}/work`;
  const git = (cwd: string, ...args: string[]) =>
    process
      .run({
        operation: "test",
        command: "git",
        args,
        cwd,
        env: {
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t",
        },
      })
      .pipe(Effect.map((out) => out.stdout.trim()));
  const write = (path: string, text: string) => fs.writeFileString(`${work}/${path}`, text);
  yield* git(root, "init", "--quiet", "--bare", "-b", "main", remote);
  yield* git(root, "clone", "--quiet", remote, work);
  yield* write("index.ts", "export const answer = 41;\n");
  yield* git(work, "add", "-A");
  yield* git(work, "commit", "--quiet", "-m", "Initial");
  yield* git(work, "switch", "--quiet", "-c", "feat/answer-42");
  yield* write("index.ts", "export const answer = 42;\n");
  yield* git(work, "commit", "--quiet", "-am", "A: set the answer to 42");
  yield* git(work, "switch", "--quiet", "-c", "feat/answer-doc");
  yield* write("index.ts", "/** The answer. */\nexport const answer = 42;\n");
  yield* git(work, "commit", "--quiet", "-am", "B: document the answer");
  yield* git(work, "switch", "--quiet", "main");
  yield* write("README.md", "main moved ahead\n");
  yield* git(work, "add", "-A");
  yield* git(work, "commit", "--quiet", "-m", "Docs");
  yield* git(work, "push", "--quiet", "origin", "main", "feat/answer-42", "feat/answer-doc");
  const head = (branch: string) => git(remote, "rev-parse", `refs/heads/${branch}`);
  return {
    remote,
    head,
    git: (...args: string[]) => git(remote, ...args),
    layers: [
      { number: 1, headBranch: "feat/answer-42", headSha: yield* head("feat/answer-42") },
      { number: 2, headBranch: "feat/answer-doc", headSha: yield* head("feat/answer-doc") },
    ],
  };
});

it.layer(layer)("cascadeRebaseStack", (it) => {
  it.effect("moves each layer's own commits onto the rebased layer below it", () =>
    Effect.gen(function* () {
      const repo = yield* setup;
      const completed = yield* cascadeRebaseStack({
        host: "github.com",
        repository: "acme/web",
        base: "main",
        layers: repo.layers,
        remote: repo.remote,
      });
      assert.strictEqual(completed, 2);

      const main = yield* repo.head("main");
      const bottom = yield* repo.head("feat/answer-42");
      const top = yield* repo.head("feat/answer-doc");
      // Bottom sits on the new main; top sits on the new bottom with only its own commit.
      expect(yield* repo.git("rev-parse", `${bottom}~1`)).toBe(main);
      expect(yield* repo.git("rev-parse", `${top}~1`)).toBe(bottom);
      expect(yield* repo.git("log", "--format=%s", `${bottom}..${top}`)).toBe(
        "B: document the answer",
      );
      // The author is untouched; the committer is whoever ran the rebase.
      expect(yield* repo.git("log", "-1", "--format=%an <%ae> / %cn <%ce>", top)).toBe(
        "t <t@t> / Stack Owner <owner@example.com>",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("rebases as a neutral committer when git has no identity", () =>
    Effect.gen(function* () {
      const repo = yield* setup;
      vi.stubEnv("GIT_COMMITTER_NAME", undefined);
      vi.stubEnv("GIT_COMMITTER_EMAIL", undefined);
      vi.stubEnv("GIT_AUTHOR_NAME", undefined);
      vi.stubEnv("GIT_AUTHOR_EMAIL", undefined);
      vi.stubEnv("EMAIL", undefined);
      const completed = yield* cascadeRebaseStack({
        host: "github.com",
        repository: "acme/web",
        base: "main",
        layers: repo.layers,
        remote: repo.remote,
      });
      assert.strictEqual(completed, 2);

      const main = yield* repo.head("main");
      const bottom = yield* repo.head("feat/answer-42");
      const top = yield* repo.head("feat/answer-doc");
      expect(yield* repo.git("rev-parse", `${bottom}~1`)).toBe(main);
      expect(yield* repo.git("rev-parse", `${top}~1`)).toBe(bottom);
      // The author is untouched; the committer is attributable to nobody.
      for (const head of [bottom, top]) {
        expect(yield* repo.git("log", "-1", "--format=%an <%ae> / %cn <%ce>", head)).toBe(
          "t <t@t> / SpecWithCode <noreply@specweave-studio.invalid>",
        );
      }
    }).pipe(Effect.scoped),
  );

  it.effect("refuses to overwrite a layer pushed after it was reviewed", () =>
    Effect.gen(function* () {
      const repo = yield* setup;
      const stale = [
        repo.layers[0]!,
        // Reviewed at the bottom layer's head, but the branch is really at its own commit.
        { ...repo.layers[1]!, headSha: repo.layers[0]!.headSha },
      ];
      const error = yield* Effect.flip(
        cascadeRebaseStack({
          host: "github.com",
          repository: "acme/web",
          base: "main",
          layers: stale,
          remote: repo.remote,
        }),
      );
      expect(error).toMatchObject({ _tag: "GitHubStackRebaseGitError", number: 2, completed: 1 });
      expect(yield* repo.head("feat/answer-doc")).toBe(repo.layers[1]!.headSha);
    }).pipe(Effect.scoped),
  );

  it.effect("stops at a conflicting layer and leaves it untouched", () =>
    Effect.gen(function* () {
      const repo = yield* setup;
      // Make main conflict with the bottom layer's change to the same line.
      const fs = yield* FileSystem.FileSystem;
      const process = yield* VcsProcess.VcsProcess;
      const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "studio-cascade-conflict-" });
      const run = (...args: string[]) =>
        process.run({
          operation: "test",
          command: "git",
          args,
          cwd: scratch,
          env: {
            GIT_AUTHOR_NAME: "t",
            GIT_AUTHOR_EMAIL: "t@t",
            GIT_COMMITTER_NAME: "t",
            GIT_COMMITTER_EMAIL: "t@t",
          },
        });
      yield* run("clone", "--quiet", repo.remote, ".");
      yield* fs.writeFileString(`${scratch}/index.ts`, "export const answer = 43;\n");
      yield* run("commit", "--quiet", "-am", "Conflict");
      yield* run("push", "--quiet", "origin", "main");

      const error = yield* Effect.flip(
        cascadeRebaseStack({
          host: "github.com",
          repository: "acme/web",
          base: "main",
          layers: repo.layers,
          remote: repo.remote,
        }),
      );
      expect(error).toMatchObject({
        _tag: "GitHubStackRebaseConflictError",
        number: 1,
        completed: 0,
      });
      expect(yield* repo.head("feat/answer-42")).toBe(repo.layers[0]!.headSha);
    }).pipe(Effect.scoped),
  );
});
