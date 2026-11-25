// @effect-diagnostics nodeBuiltinImport:off - worktree fixtures on disk.
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ProjectHandlers from "./handlers.ts";
import { clientLaunchHarness } from "./handlers.testkit.ts";
import { ProjectToolkit } from "./tools.ts";

it.effect("a launch binds only an existing checkout that is one of the project's worktrees", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // Git registers resolved paths, and a launch starts in the registered one.
    const root = yield* fileSystem.realPath(
      yield* fileSystem.makeTempDirectoryScoped({ prefix: "studio-launch-worktree-" }),
    );
    const repo = path.join(root, "repo");
    const worktree = path.join(root, "feature");
    const outside = path.join(root, "outside");
    yield* fileSystem.makeDirectory(repo);
    yield* fileSystem.makeDirectory(outside);

    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto",
      launched,
      workspaceRoot: repo,
    });
    const git = yield* GitVcsDriver.GitVcsDriver.pipe(Effect.provide(dependencies));
    for (const args of [
      ["init", "-b", "main"],
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"],
      ["worktree", "add", "-b", "feature", worktree],
    ]) {
      yield* git.execute({ operation: "test.setupRepo", cwd: repo, args });
    }
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const launchInto = (worktreePath: string) =>
      toolkit
        .handle("studio_thread_launch", {
          title: "Fix",
          projectId,
          workspaceStrategy: { type: "existing_worktree", worktreePath },
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    expect((yield* launchInto(worktree)).at(-1)?.result).toMatchObject({ projectId });
    expect((yield* launchInto(repo)).at(-1)?.result).toMatchObject({ projectId });
    // Through a link to it, the thread still starts in the registered worktree.
    const alias = path.join(root, "alias");
    yield* fileSystem.symlink(worktree, alias);
    expect((yield* launchInto(alias)).at(-1)?.result).toMatchObject({ projectId });
    for (const elsewhere of [outside, path.join(worktree, "..", "outside"), "/"]) {
      expect((yield* launchInto(elsewhere)).at(-1)?.result).toMatchObject({
        code: "invalid_request",
      });
    }
    expect(launched.map((launch) => launch.workspaceStrategy)).toEqual([
      { type: "existing_worktree", worktreePath: worktree },
      { type: "existing_worktree", worktreePath: repo },
      { type: "existing_worktree", worktreePath: worktree },
    ]);

    // A removed worktree stays listed as prunable until `git worktree prune`;
    // whatever directory is later made at its path is not one of the project's.
    yield* fileSystem.remove(worktree, { recursive: true });
    yield* fileSystem.makeDirectory(worktree);
    expect((yield* launchInto(worktree)).at(-1)?.result).toMatchObject({
      code: "invalid_request",
    });

    // A locked worktree is never prunable: git lists it after its folder is
    // removed, and a folder made there later is still not one of the project's.
    const locked = path.join(root, "locked");
    yield* git.execute({
      operation: "test.setupRepo",
      cwd: repo,
      args: ["worktree", "add", "--lock", "-b", "locked", locked],
    });
    expect((yield* launchInto(locked)).at(-1)?.result).toMatchObject({ projectId });
    yield* fileSystem.remove(locked, { recursive: true });
    yield* fileSystem.makeDirectory(locked);
    expect((yield* git.listWorktreePaths(repo)).includes(locked)).toBe(true);
    expect((yield* launchInto(locked)).at(-1)?.result).toMatchObject({
      code: "invalid_request",
    });
    // So is another repository made at that path.
    yield* git.execute({ operation: "test.setupRepo", cwd: locked, args: ["init", "-b", "main"] });
    expect((yield* launchInto(locked)).at(-1)?.result).toMatchObject({
      code: "invalid_request",
    });
    // And so is a checkout of this repository that belongs to a different
    // worktree: its .git file was copied from that worktree.
    const other = path.join(root, "other");
    yield* git.execute({
      operation: "test.setupRepo",
      cwd: repo,
      args: ["worktree", "add", "-b", "other", other],
    });
    yield* fileSystem.remove(locked, { recursive: true });
    yield* fileSystem.makeDirectory(locked);
    yield* fileSystem.copyFile(path.join(other, ".git"), path.join(locked, ".git"));
    expect((yield* launchInto(locked)).at(-1)?.result).toMatchObject({
      code: "invalid_request",
    });
    expect((yield* launchInto(other)).at(-1)?.result).toMatchObject({ projectId });
    // A .git file naming the repository's own git folder, or a link to the
    // other worktree's .git file, is not this checkout either.
    yield* fileSystem.remove(path.join(locked, ".git"));
    yield* fileSystem.writeFileString(path.join(locked, ".git"), `gitdir: ${repo}/.git\n`);
    expect((yield* launchInto(locked)).at(-1)?.result).toMatchObject({
      code: "invalid_request",
    });
    yield* fileSystem.remove(path.join(locked, ".git"));
    yield* fileSystem.symlink(path.join(other, ".git"), path.join(locked, ".git"));
    expect((yield* launchInto(locked)).at(-1)?.result).toMatchObject({
      code: "invalid_request",
    });
    // Nor is worktree metadata kept outside the repository's worktrees folder,
    // even when it shares the repository and names this path back.
    yield* fileSystem.remove(path.join(locked, ".git"));
    const stray = path.join(root, "stray-admin");
    yield* fileSystem.makeDirectory(stray);
    yield* fileSystem.writeFileString(path.join(stray, "commondir"), `${repo}/.git\n`);
    yield* fileSystem.writeFileString(path.join(stray, "HEAD"), "ref: refs/heads/main\n");
    yield* fileSystem.writeFileString(path.join(stray, "gitdir"), `${locked}/.git\n`);
    yield* fileSystem.writeFileString(path.join(locked, ".git"), `gitdir: ${stray}\n`);
    expect((yield* launchInto(locked)).at(-1)?.result).toMatchObject({
      code: "invalid_request",
    });
    // Nor does another worktree's record name this path through a link: its
    // own .git is made a link to this path's .git, which holds a copy of it.
    yield* fileSystem.remove(path.join(locked, ".git"));
    const linked = path.join(root, "linked");
    yield* git.execute({
      operation: "test.setupRepo",
      cwd: repo,
      args: ["worktree", "add", "-b", "linked", linked],
    });
    yield* fileSystem.copyFile(path.join(linked, ".git"), path.join(locked, ".git"));
    yield* fileSystem.remove(path.join(linked, ".git"));
    yield* fileSystem.symlink(path.join(locked, ".git"), path.join(linked, ".git"));
    expect((yield* launchInto(locked)).at(-1)?.result).toMatchObject({
      code: "invalid_request",
    });
    // Git reads the slot's record and the `.git` line byte for byte, so a
    // record with leading spaces, one that reaches this path through a link
    // and `..`, or a `.git` line naming a slot with a trailing space is not
    // the registration at this path either.
    const spare = path.join(root, "spare");
    yield* git.execute({
      operation: "test.setupRepo",
      cwd: repo,
      args: ["worktree", "add", "-b", "spare", spare],
    });
    const spareSlot = path.join(repo, ".git", "worktrees", "spare");
    yield* fileSystem.remove(path.join(locked, ".git"));
    yield* fileSystem.writeFileString(path.join(locked, ".git"), `gitdir: ${spareSlot}\n`);
    yield* fileSystem.writeFileString(path.join(spareSlot, "gitdir"), `  ${locked}/.git\n`);
    expect((yield* launchInto(locked)).at(-1)?.result).toMatchObject({
      code: "invalid_request",
    });
    const deep = path.join(root, "deep", "down");
    yield* fileSystem.makeDirectory(deep, { recursive: true });
    yield* fileSystem.symlink(deep, path.join(root, "hop"));
    yield* fileSystem.writeFileString(
      path.join(spareSlot, "gitdir"),
      `${root}/hop/../locked/.git\n`,
    );
    expect((yield* launchInto(locked)).at(-1)?.result).toMatchObject({
      code: "invalid_request",
    });
    // Git writes records with `/` on every platform.
    const gitLocked = locked.replaceAll("\\", "/");
    yield* fileSystem.writeFileString(path.join(spareSlot, "gitdir"), `${gitLocked}/.git\n`);
    yield* fileSystem.writeFileString(path.join(locked, ".git"), `gitdir: ${spareSlot} \n`);
    expect((yield* launchInto(locked)).at(-1)?.result).toMatchObject({
      code: "invalid_request",
    });
    // A path two slots name is not one registration, as Git looks it up in
    // the first: the spare slot is restored and a copy of it names it too.
    yield* fileSystem.writeFileString(path.join(locked, ".git"), `gitdir: ${spareSlot}\n`);
    // The locked path's own slot is pointed elsewhere first, so the spare
    // slot is the one registration and the launch binds.
    yield* fileSystem.writeFileString(
      path.join(repo, ".git", "worktrees", "locked", "gitdir"),
      `${root}/gone/.git\n`,
    );
    expect((yield* launchInto(locked)).at(-1)?.result).toMatchObject({ projectId });
    const twin = path.join(repo, ".git", "worktrees", "spare-twin");
    yield* fileSystem.copy(spareSlot, twin);
    expect((yield* launchInto(locked)).at(-1)?.result).toMatchObject({
      code: "invalid_request",
    });
    // Git trims a record's line ending and resolves its path before the
    // lookup, so a twin spelled with CRLF or through a link counts too.
    // It also stops reading at a NUL byte, and on a case-insensitive disk
    // matches paths regardless of case.
    for (const spelling of [
      `${gitLocked}/.git\r\n`,
      `${root}/hop/../../locked/.git\n`,
      `${gitLocked}\0/.git\n`,
      `${gitLocked.toUpperCase()}/.git\n`,
      // Outside Windows a `\\` is part of a folder name, not a separator.
      ...(process.platform === "win32" ? [] : [`${root}/odd\\name/../locked/.git\n`]),
    ]) {
      yield* fileSystem.writeFileString(path.join(twin, "gitdir"), spelling);
      expect((yield* launchInto(locked)).at(-1)?.result).toMatchObject({
        code: "invalid_request",
      });
    }
    yield* fileSystem.remove(twin, { recursive: true });
    // A slot Git would not read (no HEAD) stays refused even when this
    // server's own environment names the repository for git.
    yield* fileSystem.remove(path.join(spareSlot, "HEAD"));
    const inherited = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
    const refused = yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        process.env.GIT_DIR = path.join(repo, ".git");
        process.env.GIT_WORK_TREE = ".";
      }),
      () => launchInto(locked),
      () =>
        Effect.sync(() => {
          for (const [key, value] of Object.entries(inherited)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
          }
        }),
    );
    expect(refused.at(-1)?.result).toMatchObject({ code: "invalid_request" });
    // The project's own checkout and its worktrees still launch.
    expect((yield* launchInto(repo)).at(-1)?.result).toMatchObject({ projectId });
    expect((yield* launchInto(other)).at(-1)?.result).toMatchObject({ projectId });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// Wherever the main checkout keeps its git folder, its worktrees launch. A
// folder whose `.git` names that git folder at a worktree's path is refused,
// with a message that says git still lists the path.
const separateGitDirLaunches = (useSeparateGitDir: boolean) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.realPath(
      yield* fileSystem.makeTempDirectoryScoped({ prefix: "studio-launch-separate-" }),
    );
    const repo = path.join(root, "repo");
    const gitDir = path.join(root, "repo.git");
    const feature = path.join(root, "feature");
    yield* fileSystem.makeDirectory(repo);
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto",
      launched,
      workspaceRoot: repo,
    });
    const git = yield* GitVcsDriver.GitVcsDriver.pipe(Effect.provide(dependencies));
    for (const args of [
      useSeparateGitDir
        ? ["init", "-b", "main", "--separate-git-dir", gitDir]
        : ["init", "-b", "main"],
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"],
      ["worktree", "add", "--lock", "-b", "feature", feature],
    ]) {
      yield* git.execute({ operation: "test.setupRepo", cwd: repo, args });
    }
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const launchInto = (worktreePath: string) =>
      toolkit
        .handle("studio_thread_launch", {
          title: "Fix",
          projectId,
          workspaceStrategy: { type: "existing_worktree", worktreePath },
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    // git lists a separate-git-dir main checkout under its git folder's path,
    // so only the in-place one is launched by its folder.
    if (!useSeparateGitDir) {
      expect((yield* launchInto(repo)).at(-1)?.result).toMatchObject({ projectId });
    }
    expect((yield* launchInto(feature)).at(-1)?.result).toMatchObject({ projectId });
    // The locked worktree's folder is replaced by one whose .git names the
    // repository's git folder: git still lists it, and the refusal says so.
    const common = useSeparateGitDir ? gitDir : path.join(repo, ".git");
    yield* fileSystem.remove(feature, { recursive: true });
    yield* fileSystem.makeDirectory(feature);
    yield* fileSystem.writeFileString(path.join(feature, ".git"), `gitdir: ${common}\n`);
    expect((yield* launchInto(feature)).at(-1)?.result).toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining("no longer that worktree"),
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect("a locked worktree replaced by a .git naming the git folder is refused", () =>
  separateGitDirLaunches(false),
);
it.effect("a worktree of a separate-git-dir checkout launches", () => separateGitDirLaunches(true));
