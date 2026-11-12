import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type { VcsCreateWorktreeInput } from "@specweave-studio/contracts";
import * as NodeSqliteClient from "@specweave-studio/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { readWorktreeSet, worktreeSetManifestPath } from "../worktreeSet.ts";
import * as GitManager from "./GitManager.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import {
  addWorktreeSetMember,
  createWorktreeSet,
  removeWorktreeSetMembers,
  resolveWorktreeSetRepositories,
  restoreWorktreeSet,
} from "./worktreeSetGit.ts";

const driverLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "studio-set-test-" })),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);

const gitWorkflowLayer = GitWorkflowService.layer.pipe(
  Layer.provide(
    VcsDriverRegistry.layer.pipe(
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "studio-set-test-" })),
      Layer.provide(VcsProcess.layer),
    ),
  ),
  Layer.provide(
    Layer.effect(
      GitManager.GitManager,
      Effect.map(GitVcsDriver.GitVcsDriver, (git) =>
        GitManager.GitManager.of({
          createWorktree: (input: VcsCreateWorktreeInput) => git.createWorktree(input),
          localStatus: (input: { cwd: string }) =>
            git
              .statusDetailsLocal(input.cwd)
              .pipe(Effect.map((status) => ({ refName: status.branch }))),
        } as unknown as GitManager.GitManager["Service"]),
      ),
    ),
  ),
  // No terminals: the removal guard needs a snapshot to prove it.
  Layer.provide(
    Layer.mock(TerminalManager.TerminalManager)({
      subscribeMetadata: (listener) =>
        listener({ type: "snapshot", terminals: [] }).pipe(Effect.as(() => {})),
    }),
  ),
);

const testLayer = Layer.provideMerge(gitWorkflowLayer, driverLayer);

/**
 * An umbrella folder `project/` with its own repository, a child clone at
 * `project/repositories/acme/api`, and an environment repository outside it
 * at `outside/web`.
 */
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const base = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "studio-set-" }));
  const run = (cwd: string, args: ReadonlyArray<string>) =>
    git.execute({ operation: "test", cwd, args });
  const makeRepo = Effect.fn(function* (repo: string) {
    yield* fs.makeDirectory(repo, { recursive: true });
    yield* run(repo, ["init", "-b", "main"]);
    yield* run(repo, ["config", "user.name", "Set test"]);
    yield* run(repo, ["config", "user.email", "test@example.invalid"]);
    yield* fs.writeFileString(path.join(repo, "file.txt"), `${path.basename(repo)}\n`);
    yield* run(repo, ["add", "file.txt"]);
    yield* run(repo, ["commit", "-m", "fixture"]);
    return repo;
  });
  const project = yield* makeRepo(path.join(base, "project"));
  yield* fs.writeFileString(path.join(project, ".gitignore"), "repositories/\n");
  const api = yield* makeRepo(path.join(project, "repositories", "acme", "api"));
  const web = yield* makeRepo(path.join(base, "outside", "web"));
  yield* fs.makeDirectory(path.join(project, "notes"));
  return { fs, path, run, base, project, api, web };
});

describe("worktree sets", () => {
  it.layer(testLayer)("as one unit", (it) => {
    it.effect("creates a thread folder with no member, and removes it with its manifest", () =>
      Effect.gen(function* () {
        const { fs, path, base, project } = yield* fixture;
        const folder = path.join(base, "worktrees", "project", "empty");
        yield* createWorktreeSet({
          folder,
          members: [],
          branch: "thread/empty",
          projectRoot: project,
          baseRef: "HEAD",
          startFromOrigin: false,
          submodules: null,
        });
        expect(yield* fs.readDirectory(folder)).toEqual([]);
        // A manifest with no members marks the folder as the thread's own, not a plain worktree.
        expect((yield* readWorktreeSet(folder))?.members).toEqual([]);
        expect(yield* removeWorktreeSetMembers({ folder, members: [] })).toEqual([]);
        expect(yield* fs.exists(folder)).toBe(false);
        expect(yield* readWorktreeSet(folder)).toBeNull();
      }),
    );
    it.effect("creates one folder with a worktree of each repository on one branch", () =>
      Effect.gen(function* () {
        const { fs, path, run, base, project, api, web } = yield* fixture;
        const members = yield* resolveWorktreeSetRepositories(
          project,
          [{ id: "web", path: web }],
          [".", "repositories/acme/api", "web"],
        );
        expect(members.map((member) => member.relativePath)).toEqual([
          "",
          path.join("repositories", "acme", "api"),
          "web",
        ]);
        const folder = path.join(base, "worktrees", "project", "feature-x");
        yield* createWorktreeSet({
          folder,
          members,
          branch: "feature/x",
          projectRoot: project,
          baseRef: "main",
          startFromOrigin: false,
          submodules: null,
        });
        for (const [checkout, file] of [
          [folder, "project"],
          [path.join(folder, "repositories", "acme", "api"), "api"],
          [path.join(folder, "web"), "web"],
        ] as const) {
          expect(yield* fs.readFileString(path.join(checkout, "file.txt"))).toBe(`${file}\n`);
          const head = yield* run(checkout, ["symbolic-ref", "--short", "HEAD"]);
          expect(head.stdout.trim()).toBe("feature/x");
        }
        // Each member belongs to its own repository, not to the folder holding it.
        const apiCommon = yield* run(path.join(folder, "repositories", "acme", "api"), [
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ]);
        // Git prints forward slashes on Windows; resolve gives the native form.
        expect(path.resolve(apiCommon.stdout.trim())).toBe(path.join(api, ".git"));
        // The nested outside member is ignored locally by the root's repository.
        const status = yield* run(folder, ["status", "--porcelain"]);
        expect(status.stdout.trim()).toBe("");
        expect((yield* readWorktreeSet(folder))?.members).toHaveLength(3);
        const exclude = path.join(project, ".git", "info", "exclude");
        expect(yield* fs.readFileString(exclude)).toContain(
          `# SpecWithCode worktree set ${folder}`,
        );

        // A set whose folder is gone but whose manifest stays is not overwritten.
        yield* fs.remove(folder, { recursive: true });
        const refused = yield* createWorktreeSet({
          folder,
          members,
          branch: "feature/x2",
          projectRoot: project,
          baseRef: "main",
          startFromOrigin: false,
          submodules: null,
        }).pipe(Effect.flip);
        expect(String(refused)).toContain("belongs to another worktree set");
        expect((yield* readWorktreeSet(folder))?.members).toHaveLength(3);

        // Restoring then removing the set takes its exclude rules with it.
        expect((yield* restoreWorktreeSet({ folder, members, branch: "feature/x" }))._tag).toBe(
          "Restored",
        );
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* run(project, ["worktree", "prune"]);
        const kept = yield* removeWorktreeSetMembers({ folder, members }).pipe(
          Effect.provideService(GitWorkflowService.GitWorkflowService, {
            ...workflow,
            removeWorktree: (input) => driver.removeWorktree(input),
          }),
        );
        expect(kept).toEqual([]);
        expect(yield* fs.readFileString(exclude)).not.toContain(folder);
      }),
    );

    it.effect("adds a repository to a plain worktree, then to the set it became", () =>
      Effect.gen(function* () {
        const { fs, path, run, base, project, api, web } = yield* fixture;
        const folder = path.join(base, "worktrees", "project", "feature-add");
        yield* run(project, ["worktree", "add", "-b", "feature/add", folder, "main"]);
        const add = (
          entry: string,
          existing: ReadonlyArray<{ repository: string; relativePath: string }>,
        ) =>
          addWorktreeSetMember({
            folder,
            existing,
            entry,
            checkouts: [{ id: "web", path: web }],
            projectRoot: project,
            branch: "feature/add",
            startFromOrigin: false,
            submodules: null,
          });
        const first = yield* add("repositories/acme/api", []);
        expect(first.map((member) => member.relativePath)).toEqual([
          "",
          path.join("repositories", "acme", "api"),
        ]);
        // The web repository already has the branch: it is checked out, not made.
        yield* run(web, ["branch", "feature/add"]);
        const second = yield* add("web", first);
        expect(second.at(-1)).toMatchObject({ id: "web", relativePath: "web" });
        for (const checkout of [
          path.join(folder, "repositories", "acme", "api"),
          path.join(folder, "web"),
        ]) {
          const head = yield* run(checkout, ["symbolic-ref", "--short", "HEAD"]);
          expect(head.stdout.trim()).toBe("feature/add");
        }
        expect((yield* readWorktreeSet(folder))?.members).toHaveLength(3);
        expect((yield* run(folder, ["status", "--porcelain"])).stdout.trim()).toBe("");
        const again = yield* add("web", second).pipe(Effect.flip);
        expect(again).toContain("already in this thread's worktree");
        expect((yield* readWorktreeSet(folder))?.members).toHaveLength(3);
        void api;
        void fs;
      }),
    );

    it.effect("leaves a plain worktree plain when the repository cannot be added", () =>
      Effect.gen(function* () {
        const { fs, path, run, base, project, web } = yield* fixture;
        const folder = path.join(base, "worktrees", "project", "feature-busy");
        yield* run(project, ["worktree", "add", "-b", "feature/busy", folder, "main"]);
        // The branch is already checked out in another worktree of web.
        yield* run(web, ["branch", "feature/busy"]);
        yield* run(web, ["worktree", "add", path.join(base, "busy"), "feature/busy"]);
        const error = yield* addWorktreeSetMember({
          folder,
          existing: [],
          entry: "web",
          checkouts: [{ id: "web", path: web }],
          projectRoot: project,
          branch: "feature/busy",
          startFromOrigin: false,
          submodules: null,
        }).pipe(Effect.flip);
        expect(String(error)).toContain("Could not create the worktree");
        expect(yield* fs.exists(worktreeSetManifestPath(folder, path))).toBe(false);
      }),
    );

    it.effect("refuses a folder inside a repository and a path outside the project", () =>
      Effect.gen(function* () {
        const { project, web } = yield* fixture;
        const inside = yield* resolveWorktreeSetRepositories(project, [], ["notes"]).pipe(
          Effect.flip,
        );
        expect(inside).toContain("has no git checkout");
        const outside = yield* resolveWorktreeSetRepositories(project, [], ["../outside/web"]).pipe(
          Effect.flip,
        );
        expect(outside).toContain("outside the project folder");
        const absolute = yield* resolveWorktreeSetRepositories(project, [], [web]).pipe(
          Effect.flip,
        );
        expect(absolute).toContain("environment repository id");
      }),
    );

    it.effect("recreates every member of a deleted set folder from the branch", () =>
      Effect.gen(function* () {
        const { fs, path, run, base, project, web } = yield* fixture;
        const members = yield* resolveWorktreeSetRepositories(
          project,
          [{ id: "web", path: web }],
          [".", "web"],
        );
        const folder = path.join(base, "worktrees", "project", "feature-y");
        yield* createWorktreeSet({
          folder,
          members,
          branch: "feature/y",
          projectRoot: project,
          baseRef: "main",
          startFromOrigin: false,
          submodules: null,
        });
        yield* fs.remove(folder, { recursive: true });
        expect(yield* fs.exists(worktreeSetManifestPath(folder, path))).toBe(true);
        const outcome = yield* restoreWorktreeSet({ folder, members, branch: "feature/y" });
        expect(outcome._tag).toBe("Restored");
        const head = yield* run(path.join(folder, "web"), ["symbolic-ref", "--short", "HEAD"]);
        expect(head.stdout.trim()).toBe("feature/y");
        const missing = yield* restoreWorktreeSet({ folder, members, branch: "gone" });
        expect(missing._tag).toBe("Restored");
        // An empty folder where a member belongs is recreated, not taken as the member.
        yield* fs.remove(path.join(folder, "web"), { recursive: true });
        yield* run(web, ["worktree", "prune"]);
        yield* fs.makeDirectory(path.join(folder, "web"));
        const refilled = yield* restoreWorktreeSet({ folder, members, branch: "feature/y" });
        expect(refilled._tag).toBe("Restored");
        expect(yield* fs.exists(path.join(folder, "web", ".git"))).toBe(true);
        yield* fs.remove(path.join(folder, "web"), { recursive: true });
        const branchGone = yield* restoreWorktreeSet({ folder, members, branch: "gone" });
        expect(branchGone._tag).toBe("BranchMissing");
      }),
    );

    it.effect("undoes the members it made when one cannot be created", () =>
      Effect.gen(function* () {
        const { fs, path, base, project, web, run } = yield* fixture;
        yield* run(web, ["branch", "feature/z"]);
        yield* run(web, ["worktree", "add", path.join(base, "elsewhere"), "feature/z"]);
        const members = yield* resolveWorktreeSetRepositories(
          project,
          [{ id: "web", path: web }],
          [".", "web"],
        );
        const folder = path.join(base, "worktrees", "project", "feature-z");
        // The removal guard reads thread ownership from a store this test does
        // not have; the driver's own removal stands in for it.
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const error = yield* createWorktreeSet({
          folder,
          members,
          branch: "feature/z",
          projectRoot: project,
          baseRef: "main",
          startFromOrigin: false,
          submodules: null,
        }).pipe(
          Effect.provideService(GitWorkflowService.GitWorkflowService, {
            ...workflow,
            removeWorktree: (input) => driver.removeWorktree(input),
          }),
          Effect.flip,
        );
        expect(String(error)).toContain("web");
        const listed = yield* run(project, ["worktree", "list", "--porcelain"]);
        expect(listed.stdout).not.toContain(folder);
        expect(yield* fs.exists(worktreeSetManifestPath(folder, path))).toBe(false);
      }),
    );
  });

  it.effect("removes members deepest first and keeps the manifest while one stays", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = yield* fs.makeTempDirectoryScoped({ prefix: "studio-set-remove-" });
      const folder = path.join(base, "set");
      yield* fs.makeDirectory(folder);
      yield* fs.writeFileString(
        worktreeSetManifestPath(folder, path),
        JSON.stringify({ version: 1, members: [] }),
      );
      const removed: Array<string> = [];
      const members = [
        { repository: "/repos/root", relativePath: "" },
        { repository: "/repos/api", relativePath: path.join("repositories", "api") },
      ];
      const git = (refuse: string | null) =>
        GitWorkflowService.GitWorkflowService.of({
          removeWorktree: (input: { cwd: string; path: string }) =>
            input.cwd === refuse
              ? Effect.fail({ detail: "It has local changes." })
              : Effect.sync(() => void removed.push(input.path)),
        } as unknown as GitWorkflowService.GitWorkflowService["Service"]);
      const kept = yield* removeWorktreeSetMembers({ folder, members }).pipe(
        Effect.provideService(GitWorkflowService.GitWorkflowService, git("/repos/api")),
      );
      // The root holds the kept member, so it stays too.
      expect(kept.map((entry) => entry.reason)).toEqual([
        "It has local changes.",
        "It holds /repos/api, which stays.",
      ]);
      expect(removed).toEqual([]);
      expect(yield* fs.exists(worktreeSetManifestPath(folder, path))).toBe(true);
      removed.length = 0;
      const none = yield* removeWorktreeSetMembers({ folder, members }).pipe(
        Effect.provideService(GitWorkflowService.GitWorkflowService, git(null)),
      );
      expect(none).toEqual([]);
      expect(removed).toEqual([path.join(folder, "repositories", "api"), folder]);
      expect(yield* fs.exists(worktreeSetManifestPath(folder, path))).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
