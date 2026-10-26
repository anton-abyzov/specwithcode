import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  GitCommandError,
  ThreadId,
  type VcsCreateWorktreeInput,
} from "@specweave-studio/contracts";
import * as NodeSqliteClient from "@specweave-studio/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitManager from "../git/GitManager.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadWorkspaceRestore from "./ThreadWorkspaceRestore.ts";

const threadId = ThreadId.make("thread-workspace-restore");

const driverLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "studio-restore-test-" })),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);

/**
 * The real workflow service with its VCS routing, so a folder that holds no
 * repository fails the way it does in production; the rest is not under test.
 */
const gitWorkflowLayer = GitWorkflowService.layer.pipe(
  Layer.provide(
    VcsDriverRegistry.layer.pipe(
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "studio-restore-test-" })),
      Layer.provide(VcsProcess.layer),
    ),
  ),
  Layer.provide(
    Layer.effect(
      GitManager.GitManager,
      Effect.map(GitVcsDriver.GitVcsDriver, (git) =>
        GitManager.GitManager.of({
          createWorktree: (input: VcsCreateWorktreeInput) => git.createWorktree(input),
        } as unknown as GitManager.GitManager["Service"]),
      ),
    ),
  ),
  Layer.provide(Layer.mock(TerminalManager.TerminalManager)({})),
);

const testLayer = Layer.provideMerge(gitWorkflowLayer, driverLayer);

/**
 * root/repos/{specweave,studio} are separate repositories; studio has the
 * branch `fix/design` and a worktree at root/worktrees/studio/other.
 */
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "studio-restore-" }));
  const run = (cwd: string, args: ReadonlyArray<string>) =>
    git.execute({ operation: "test", cwd, args });
  const makeRepo = Effect.fn(function* (name: string) {
    const repo = path.join(root, "repos", name);
    yield* fs.makeDirectory(repo, { recursive: true });
    yield* run(repo, ["init", "-b", "main"]);
    yield* run(repo, ["config", "user.name", "Restore test"]);
    yield* run(repo, ["config", "user.email", "test@example.invalid"]);
    yield* fs.writeFileString(path.join(repo, "file.txt"), `${name}\n`);
    yield* run(repo, ["add", "."]);
    yield* run(repo, ["commit", "-m", "fixture"]);
    return repo;
  });
  const specweave = yield* makeRepo("specweave");
  const studio = yield* makeRepo("studio");
  yield* run(studio, ["branch", "fix/design"]);
  yield* run(studio, ["branch", "other"]);
  const worktrees = path.join(root, "worktrees", "studio");
  yield* fs.makeDirectory(worktrees, { recursive: true });
  yield* run(studio, ["worktree", "add", path.join(worktrees, "other"), "other"]);
  return { fs, path, run, root, specweave, studio, worktrees };
});

describe("worktreeRepositoryCandidates", () => {
  it.layer(testLayer)((it) => {
    it.effect("puts the repository of the folders next to it before the project", () =>
      Effect.gen(function* () {
        const { path, specweave, studio, worktrees } = yield* fixture;
        const candidates = yield* ThreadWorkspaceRestore.worktreeRepositoryCandidates({
          worktreePath: path.join(worktrees, "fix-design"),
          workspaceRoot: specweave,
        });
        // repos/studio is also the project's sibling named like the parent folder: listed once.
        expect(candidates).toEqual([studio, specweave]);
      }).pipe(Effect.scoped),
    );

    it.effect("ranks the project first in a folder shared by several repositories", () =>
      Effect.gen(function* () {
        const { fs, path, run, root, specweave, studio } = yield* fixture;
        const shared = path.join(root, "worktrees");
        yield* run(studio, ["branch", "second"]);
        yield* run(studio, ["worktree", "add", path.join(shared, "studio-second"), "second"]);
        yield* run(specweave, ["branch", "third"]);
        yield* run(specweave, ["worktree", "add", path.join(shared, "specweave-third"), "third"]);
        const project = path.join(root, "repos", "project");
        yield* fs.makeDirectory(project);
        const candidates = yield* ThreadWorkspaceRestore.worktreeRepositoryCandidates({
          worktreePath: path.join(shared, "missing"),
          workspaceRoot: project,
        });
        expect(candidates[0]).toBe(project);
        expect(candidates.slice(1).toSorted()).toEqual([specweave, studio].toSorted());
      }).pipe(Effect.scoped),
    );

    it.effect("leaves out a repository that was moved or deleted", () =>
      Effect.gen(function* () {
        const { fs, path, run, root, specweave, studio } = yield* fixture;
        const moved = path.join(root, "worktrees", "moved");
        const gone = path.join(root, "repos", "gone");
        yield* fs.makeDirectory(gone);
        yield* run(gone, ["init", "-b", "main"]);
        yield* fs.makeDirectory(moved);
        // A checkout whose repository is no longer there still points at it.
        yield* fs.makeDirectory(path.join(moved, "old"));
        yield* fs.writeFileString(
          path.join(moved, "old", ".git"),
          `gitdir: ${path.join(gone, ".git", "worktrees", "old")}\n`,
        );
        yield* fs.remove(gone, { recursive: true });
        const candidates = yield* ThreadWorkspaceRestore.worktreeRepositoryCandidates({
          worktreePath: path.join(moved, "fix-design"),
          workspaceRoot: specweave,
        });
        expect(candidates).toEqual([specweave]);
        expect(candidates).not.toContain(studio);
      }).pipe(Effect.scoped),
    );
  });
});

describe("restoreMissingWorktree", () => {
  it.layer(testLayer)((it) => {
    it.effect("recreates a sibling repository's deleted folder at its exact path", () =>
      Effect.gen(function* () {
        const { fs, path, run, specweave, studio, worktrees } = yield* fixture;
        const worktreePath = path.join(worktrees, "fix-design");
        yield* run(studio, ["worktree", "add", worktreePath, "fix/design"]);
        // Removed outside the app: git still lists it until a prune.
        yield* fs.remove(worktreePath, { recursive: true });

        const restored = yield* ThreadWorkspaceRestore.restoreMissingWorktree({
          threadId,
          worktreePath,
          branch: "fix/design",
          workspaceRoot: specweave,
        });

        expect(restored).toEqual({ _tag: "Restored", repository: studio });
        const head = yield* run(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]);
        expect(head.stdout.trim()).toBe("fix/design");
      }).pipe(Effect.scoped),
    );

    it.effect("moves past a repository without the branch to the next one", () =>
      Effect.gen(function* () {
        const { fs, path, root, specweave, studio } = yield* fixture;
        // No checkouts next to it: the project, then its sibling named "studio".
        const parent = path.join(root, "elsewhere", "studio");
        yield* fs.makeDirectory(parent, { recursive: true });
        const worktreePath = path.join(parent, "fix-design");

        const restored = yield* ThreadWorkspaceRestore.restoreMissingWorktree({
          threadId,
          worktreePath,
          branch: "fix/design",
          workspaceRoot: specweave,
        });

        expect(restored).toEqual({ _tag: "Restored", repository: studio });
        expect(yield* fs.exists(path.join(worktreePath, "file.txt"))).toBe(true);
      }).pipe(Effect.scoped),
    );

    it.effect("moves past a project folder that holds no repository", () =>
      Effect.gen(function* () {
        const { fs, path, run, root, specweave, studio } = yield* fixture;
        const shared = path.join(root, "worktrees");
        yield* run(studio, ["branch", "second"]);
        yield* run(studio, ["worktree", "add", path.join(shared, "studio-second"), "second"]);
        yield* run(specweave, ["branch", "third"]);
        yield* run(specweave, ["worktree", "add", path.join(shared, "specweave-third"), "third"]);
        // A plain folder ranks first in a folder shared by several repositories.
        const project = path.join(root, "repos", "project");
        yield* fs.makeDirectory(project);
        const worktreePath = path.join(shared, "fix-design");

        const restored = yield* ThreadWorkspaceRestore.restoreMissingWorktree({
          threadId,
          worktreePath,
          branch: "fix/design",
          workspaceRoot: project,
        });

        expect(restored).toEqual({ _tag: "Restored", repository: studio });
      }).pipe(Effect.scoped),
    );

    it.effect("stops at a refusal other than a missing branch", () =>
      Effect.gen(function* () {
        const { fs, path, specweave, studio, worktrees } = yield* fixture;
        // `other` is already checked out next to it, so git refuses a second checkout.
        const worktreePath = path.join(worktrees, "fix-other");

        const restored = yield* ThreadWorkspaceRestore.restoreMissingWorktree({
          threadId,
          worktreePath,
          branch: "other",
          workspaceRoot: specweave,
        });

        expect(restored._tag).toBe("Failed");
        expect(restored._tag === "Failed" ? restored.repository : undefined).toBe(studio);
        expect(yield* fs.exists(worktreePath)).toBe(false);
      }).pipe(Effect.scoped),
    );

    it.effect("reports a branch no candidate has, and whose folder it is", () =>
      Effect.gen(function* () {
        const { fs, path, specweave, studio, worktrees } = yield* fixture;
        const worktreePath = path.join(worktrees, "gone-branch");

        const restored = yield* ThreadWorkspaceRestore.restoreMissingWorktree({
          threadId,
          worktreePath,
          branch: "gone/branch",
          workspaceRoot: specweave,
        });

        expect(restored).toEqual({
          _tag: "BranchMissing",
          checkedRepositories: [studio, specweave],
          ownedFolder: true,
        });
        expect(yield* fs.exists(worktreePath)).toBe(false);
      }).pipe(Effect.scoped),
    );
  });
});

describe("ThreadWorkspaceRestore.restore", () => {
  const serviceLayer = (
    thread: {
      readonly worktreePath: string | null;
      readonly branch: string | null;
      readonly workspaceRoot: string;
    },
    git?: Partial<GitWorkflowService.GitWorkflowService["Service"]>,
  ) => {
    const restoreLayer = ThreadWorkspaceRestore.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThread: () =>
              Effect.succeed({
                id: threadId,
                projectId: "project-restore",
                worktreePath: thread.worktreePath,
                branch: thread.branch,
                deletedAt: null,
              } as never),
          }),
          Layer.mock(ProjectService.ProjectService)({
            getById: () =>
              Effect.succeed(Option.some({ workspaceRoot: thread.workspaceRoot } as never)),
          }),
        ),
      ),
    );
    return git === undefined
      ? restoreLayer
      : restoreLayer.pipe(Layer.provide(Layer.mock(GitWorkflowService.GitWorkflowService)(git)));
  };

  it.layer(testLayer)((it) => {
    it.effect("restores the folder and names the repository", () =>
      Effect.gen(function* () {
        const { path, specweave, studio, worktrees } = yield* fixture;
        const worktreePath = path.join(worktrees, "fix-design");
        const result = yield* ThreadWorkspaceRestore.ThreadWorkspaceRestore.pipe(
          Effect.flatMap((service) => service.restore({ threadId })),
          Effect.provide(
            serviceLayer({ worktreePath, branch: "fix/design", workspaceRoot: specweave }),
          ),
        );
        expect(result).toEqual({
          status: "restored",
          repository: studio,
          worktreePath,
          message: "Folder restored from fix/design.",
        });
        const again = yield* ThreadWorkspaceRestore.ThreadWorkspaceRestore.pipe(
          Effect.flatMap((service) => service.restore({ threadId })),
          Effect.provide(
            serviceLayer({ worktreePath, branch: "fix/design", workspaceRoot: specweave }),
          ),
        );
        expect(again.status).toBe("already-present");
      }).pipe(Effect.scoped),
    );

    it.effect("refuses a thread without a folder or branch, and a deleted branch", () =>
      Effect.gen(function* () {
        const { path, specweave, worktrees } = yield* fixture;
        const restoreWith = (thread: Parameters<typeof serviceLayer>[0]) =>
          ThreadWorkspaceRestore.ThreadWorkspaceRestore.pipe(
            Effect.flatMap((service) => service.restore({ threadId })),
            Effect.provide(serviceLayer(thread)),
          );
        expect(
          (yield* restoreWith({ worktreePath: null, branch: "x", workspaceRoot: specweave }))
            .status,
        ).toBe("not-restorable");
        expect(
          (yield* restoreWith({
            worktreePath: path.join(worktrees, "x"),
            branch: null,
            workspaceRoot: specweave,
          })).status,
        ).toBe("not-restorable");
        const missing = yield* restoreWith({
          worktreePath: path.join(worktrees, "gone"),
          branch: "gone",
          workspaceRoot: specweave,
        });
        expect(missing.status).toBe("branch-missing");
        expect(missing.message).toContain("Branch gone no longer exists");
      }).pipe(Effect.scoped),
    );

    it.effect("does not take a file at the folder's path for the folder", () =>
      Effect.gen(function* () {
        const { fs, path, specweave, worktrees } = yield* fixture;
        const worktreePath = path.join(worktrees, "fix-design");
        yield* fs.writeFileString(worktreePath, "not a folder\n");
        const result = yield* ThreadWorkspaceRestore.ThreadWorkspaceRestore.pipe(
          Effect.flatMap((service) => service.restore({ threadId })),
          Effect.provide(
            serviceLayer({ worktreePath, branch: "fix/design", workspaceRoot: specweave }),
          ),
        );
        expect(result).toEqual({
          status: "not-restorable",
          worktreePath,
          message: "Something else is at the thread folder's path. Move it, then try again.",
        });
      }).pipe(Effect.scoped),
    );

    it.effect("reports a folder another restore added meanwhile as present", () =>
      Effect.gen(function* () {
        const { fs, path, specweave, worktrees } = yield* fixture;
        const worktreePath = path.join(worktrees, "fix-design");
        const result = yield* ThreadWorkspaceRestore.ThreadWorkspaceRestore.pipe(
          Effect.flatMap((service) => service.restore({ threadId })),
          Effect.provide(
            serviceLayer(
              { worktreePath, branch: "fix/design", workspaceRoot: specweave },
              {
                pruneWorktrees: () => Effect.void,
                // The other restore wins the race; git refuses this one.
                createWorktree: (input) =>
                  fs.makeDirectory(input.path ?? worktreePath).pipe(
                    Effect.orDie,
                    Effect.andThen(
                      Effect.fail(
                        new GitCommandError({
                          operation: "test",
                          command: "git worktree add",
                          cwd: input.cwd,
                          reason: "path_already_exists",
                          detail: "already exists",
                        }),
                      ),
                    ),
                  ),
              },
            ),
          ),
        );
        expect(result).toEqual({
          status: "already-present",
          worktreePath,
          message: "The thread folder is already there.",
        });
      }).pipe(Effect.scoped),
    );
  });
});
