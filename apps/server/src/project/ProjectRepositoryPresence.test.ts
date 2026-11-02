// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ProjectId,
  type ProjectNestedRepository,
  type RepositoryIdentity,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import { it } from "@effect/vitest";
import { afterEach, beforeEach, describe, expect } from "vite-plus/test";

import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import {
  checkProjectRepositories,
  credentialFreeRemoteUrl,
  readProjectRepositories,
} from "./ProjectRepositoryPresence.ts";
import * as ProjectService from "./ProjectService.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

let base = "";
let home = "";
let copy = "";
/** The remote each checkout reports, by real folder. */
const remotes = new Map<string, string>();
const clones: string[] = [];
const discarded: string[] = [];
let cloneFails: string | null = null;
/** When set, a clone waits for it before finishing. */
let cloneGate: Promise<void> | null = null;

const identityOf = (remoteUrl: string, rootPath: string): RepositoryIdentity => {
  const repository = remoteUrl.replace(/^.*github\.com[:/]/u, "").replace(/\.git$/u, "");
  return {
    canonicalKey: `github.com/${repository.toLowerCase()}`,
    locator: { source: "git-remote", remoteName: "origin", remoteUrl },
    rootPath,
    displayName: repository.toLowerCase(),
  };
};

const checkout = async (root: string, path: string, remoteUrl?: string) => {
  const folder = NodePath.join(root, ...path.split("/"));
  await NodeFSP.mkdir(NodePath.join(folder, ".git"), { recursive: true });
  if (remoteUrl !== undefined) remotes.set(await NodeFSP.realpath(folder), remoteUrl);
};

const PROJECT_HERE = ProjectId.make("project-here");
const PROJECT_COPY = ProjectId.make("project-copy");

const provide = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | ProjectService.ProjectService
    | RepositoryIdentityResolver.RepositoryIdentityResolver
    | SourceControlRepositoryService.SourceControlRepositoryService
  >,
) =>
  effect.pipe(
    Effect.provideService(ProjectService.ProjectService, {
      getById: (projectId: ProjectId) =>
        Effect.succeed(
          projectId === PROJECT_HERE || projectId === PROJECT_COPY
            ? Option.some({
                id: projectId,
                workspaceRoot: projectId === PROJECT_HERE ? home : copy,
                deletedAt: null,
              })
            : Option.none(),
        ),
    } as never),
    Effect.provideService(RepositoryIdentityResolver.RepositoryIdentityResolver, {
      resolve: (cwd: string) =>
        Effect.promise(async () => {
          const real = await NodeFSP.realpath(cwd).catch(() => cwd);
          const remote = remotes.get(real);
          return remote === undefined ? null : identityOf(remote, real);
        }),
    }),
    Effect.provideService(SourceControlRepositoryService.SourceControlRepositoryService, {
      cloneRepository: (input: { remoteUrl?: string; destinationPath: string }) =>
        Effect.tryPromise({
          try: async () => {
            clones.push(input.destinationPath);
            // Git makes the .git folder before it fetches anything.
            await NodeFSP.mkdir(NodePath.join(input.destinationPath, ".git"), {
              recursive: true,
            });
            if (cloneGate !== null) await cloneGate;
            if (cloneFails !== null) throw new Error(cloneFails);
            remotes.set(await NodeFSP.realpath(input.destinationPath), input.remoteUrl!);
            return { cwd: input.destinationPath, remoteUrl: input.remoteUrl!, repository: null };
          },
          catch: (cause) => ({ detail: (cause as Error).message }),
        }),
      discardClone: (destinationPath: string) =>
        Effect.promise(async () => {
          discarded.push(destinationPath);
          await NodeFSP.rm(destinationPath, { recursive: true, force: true });
        }),
    } as never),
  );

beforeEach(async () => {
  base = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "studio-repo-presence-")),
  );
  home = NodePath.join(base, "here");
  copy = NodePath.join(base, "copy");
  await NodeFSP.mkdir(home, { recursive: true });
  await NodeFSP.mkdir(copy, { recursive: true });
  remotes.clear();
  clones.length = 0;
  discarded.length = 0;
  cloneFails = null;
  cloneGate = null;
});
afterEach(async () => {
  await NodeFSP.rm(base, { recursive: true, force: true });
});

const api: ProjectNestedRepository = {
  path: "repositories/acme/api",
  remoteUrl: "git@github.com:acme/api.git",
  key: "github.com/acme/api",
  name: "acme/api",
};

describe("readProjectRepositories", () => {
  it.effect("lists every separate clone in the folder, in any layout, by its remote", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        checkout(home, "repositories/acme/api", "git@github.com:acme/api.git"),
      );
      yield* Effect.promise(() =>
        checkout(home, "tools/cli", "https://token:x-oauth@github.com/Acme/CLI.git"),
      );
      yield* Effect.promise(() => checkout(home, "scratch/local-only"));
      // A worktree or submodule (a .git file) comes with its own repository.
      yield* Effect.promise(() =>
        NodeFSP.mkdir(NodePath.join(home, "linked"), { recursive: true }),
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(home, "linked/.git"), "gitdir: ../elsewhere\n"),
      );
      const result = yield* provide(readProjectRepositories(PROJECT_HERE));
      expect(result.repositories).toEqual([
        api,
        {
          path: "tools/cli",
          remoteUrl: "https://github.com/Acme/CLI.git",
          key: "github.com/acme/cli",
          name: "acme/cli",
        },
      ]);
      expect(result.withoutRemote).toEqual(["scratch/local-only"]);
      expect(result.truncated).toBe(false);
    }),
  );
});

describe("checkProjectRepositories", () => {
  it.effect("finds a checkout of the same repository by remote, not by folder name", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        checkout(copy, "repositories/acme/api", "https://github.com/acme/api"),
      );
      const result = yield* provide(
        checkProjectRepositories({ projectId: PROJECT_COPY, repositories: [api], clone: false }),
      );
      expect(result.results).toEqual([
        { path: "repositories/acme/api", status: "present", detail: null },
      ]);
    }),
  );

  it.effect("finds the repository wherever the copy keeps it", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => checkout(copy, "code/api", "https://github.com/acme/api.git"));
      const result = yield* provide(
        checkProjectRepositories({ projectId: PROJECT_COPY, repositories: [api], clone: true }),
      );
      expect(result.results).toEqual([
        { path: "repositories/acme/api", status: "present", detail: null, foundAt: "code/api" },
      ]);
      expect(clones).toEqual([]);
    }),
  );

  it.effect("reports a missing checkout without cloning unless asked", () =>
    Effect.gen(function* () {
      const result = yield* provide(
        checkProjectRepositories({ projectId: PROJECT_COPY, repositories: [api], clone: false }),
      );
      expect(result.results[0]?.status).toBe("missing");
      expect(clones).toEqual([]);
    }),
  );

  it.effect("clones a missing checkout into the copy's own folder", () =>
    Effect.gen(function* () {
      const result = yield* provide(
        checkProjectRepositories({ projectId: PROJECT_COPY, repositories: [api], clone: true }),
      );
      expect(result.results[0]?.status).toBe("cloned");
      expect(clones).toEqual([NodePath.join(copy, "repositories/acme/api")]);
    }),
  );

  it.effect("leaves another repository or a plain folder at the path alone", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        checkout(copy, "repositories/acme/api", "git@github.com:other/thing.git"),
      );
      yield* Effect.promise(() =>
        NodeFSP.mkdir(NodePath.join(copy, "apps/web"), { recursive: true }),
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(copy, "apps/web/notes.txt"), "mine\n"),
      );
      const web = { ...api, path: "apps/web", key: "github.com/acme/web", name: "acme/web" };
      const result = yield* provide(
        checkProjectRepositories({
          projectId: PROJECT_COPY,
          repositories: [api, web],
          clone: true,
        }),
      );
      expect(result.results.map((entry) => entry.status)).toEqual(["different", "different"]);
      expect(result.results[0]?.detail).toContain("other/thing");
      expect(clones).toEqual([]);
    }),
  );

  it.effect("never clones through a link that leads out of the project folder", () =>
    Effect.gen(function* () {
      const outside = NodePath.join(base, "outside");
      yield* Effect.promise(() => NodeFSP.mkdir(outside, { recursive: true }));
      yield* Effect.promise(() => NodeFSP.symlink(outside, NodePath.join(copy, "repositories")));
      const result = yield* provide(
        checkProjectRepositories({ projectId: PROJECT_COPY, repositories: [api], clone: true }),
      );
      expect(result.results[0]?.status).toBe("different");
      expect(clones).toEqual([]);
    }),
  );

  it.effect("reports a failed clone and removes what it left", () =>
    Effect.gen(function* () {
      cloneFails = "Permission denied (publickey).";
      const result = yield* provide(
        checkProjectRepositories({ projectId: PROJECT_COPY, repositories: [api], clone: true }),
      );
      expect(result.results[0]).toEqual({
        path: "repositories/acme/api",
        status: "failed",
        detail: "Permission denied (publickey).",
      });
      const folder = NodePath.join(copy, "repositories/acme/api");
      expect(discarded).toEqual([folder]);
      // The next check finds it missing, not a broken checkout.
      cloneFails = null;
      const again = yield* provide(
        checkProjectRepositories({ projectId: PROJECT_COPY, repositories: [api], clone: false }),
      );
      expect(again.results[0]?.status).toBe("missing");
    }),
  );

  it.effect("counts an empty folder as missing and clones into it", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        NodeFSP.mkdir(NodePath.join(copy, "repositories/acme/api"), { recursive: true }),
      );
      const result = yield* provide(
        checkProjectRepositories({ projectId: PROJECT_COPY, repositories: [api], clone: true }),
      );
      expect(result.results[0]?.status).toBe("cloned");
    }),
  );

  it.effect("tells a fork from the repository it forked", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        checkout(copy, "repositories/acme/api", "git@github.com:someone/api.git"),
      );
      const result = yield* provide(
        checkProjectRepositories({ projectId: PROJECT_COPY, repositories: [api], clone: true }),
      );
      expect(result.results[0]?.status).toBe("different");
      expect(clones).toEqual([]);
    }),
  );

  it.effect("never clones a local path or file URL", () =>
    Effect.gen(function* () {
      const local = [
        { ...api, remoteUrl: "/Users/someone/secret" },
        { ...api, path: "b", remoteUrl: "file:///etc" },
      ];
      const result = yield* provide(
        checkProjectRepositories({ projectId: PROJECT_COPY, repositories: local, clone: true }),
      );
      expect(result.results.map((entry) => entry.status)).toEqual(["failed", "failed"]);
      expect(clones).toEqual([]);
    }),
  );

  it.effect("leaves a destination alone while another clone into it runs", () =>
    Effect.gen(function* () {
      let release = () => {};
      cloneGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first = yield* provide(
        checkProjectRepositories({ projectId: PROJECT_COPY, repositories: [api], clone: true }),
      ).pipe(Effect.forkChild);
      yield* Effect.promise(async () => {
        while (clones.length === 0) await new Promise((resolve) => setImmediate(resolve));
      });
      const second = yield* provide(
        checkProjectRepositories({ projectId: PROJECT_COPY, repositories: [api], clone: true }),
      );
      expect(second.results[0]?.status).toBe("failed");
      expect(second.results[0]?.detail).toContain("still running");
      release();
      const done = yield* Fiber.join(first);
      expect(done.results[0]?.status).toBe("cloned");
      expect(clones).toHaveLength(1);
    }),
  );
});

describe("credentialFreeRemoteUrl", () => {
  it("drops tokens from HTTPS remotes and keeps SSH users", () => {
    expect(credentialFreeRemoteUrl("https://user:token@github.com/a/b.git?x=1")).toBe(
      "https://github.com/a/b.git",
    );
    expect(credentialFreeRemoteUrl("ssh://git@github.com/a/b.git")).toBe(
      "ssh://git@github.com/a/b.git",
    );
    expect(credentialFreeRemoteUrl("git@github.com:a/b.git")).toBe("git@github.com:a/b.git");
  });
});

describe("paths a check accepts", () => {
  it("refuses paths that leave the folder or reach into hidden folders", async () => {
    const { isProjectRelativePath } = await import("@specweave-studio/contracts");
    expect(isProjectRelativePath("repositories/acme/api")).toBe(true);
    for (const path of ["../api", "/abs", ".git/hooks", "a/../b", "a\\b", "C:/x", "a//b"])
      expect(isProjectRelativePath(path)).toBe(false);
  });
});
