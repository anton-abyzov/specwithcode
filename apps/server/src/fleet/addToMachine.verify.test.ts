// @effect-diagnostics nodeBuiltinImport:off - disposable real Git fixtures only.
/**
 * Server side of "Run on: add a project to another machine" between two
 * isolated stacks. M4MAX holds the project; MINI is where it is added. Each
 * has its own home, state folder, Git driver, repository service and clone
 * tracker, and a local bare repository stands in for the hosted origin, so
 * nothing reaches the network. Covers MINI's pre-checks (can it read the
 * remote, what is already at the folder) and the clone it then runs. Moving an
 * out-of-sync folder between machines is covered by
 * folderTransfer/twoServer.verify.test.ts.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProjectId } from "@specweave-studio/contracts";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

const stackLayer = (root: string) =>
  ProjectCloneTracker.layer.pipe(
    Layer.provideMerge(SourceControlRepositoryService.layer),
    Layer.provide(GitVcsDriver.layer),
    Layer.provide(
      Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
        resolveLink: () => undefined,
      }),
    ),
    Layer.provideMerge(ServerConfig.layerTest(`${root}/home`, `${root}/state`)),
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(NodeServices.layer),
  );

/** One machine's server-side stack, built on its own and torn down with the test. */
const machine = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(`${root}/home`, { recursive: true });
    yield* fs.makeDirectory(`${root}/state`, { recursive: true });
    const context = yield* Layer.build(stackLayer(root));
    return yield* Effect.gen(function* () {
      return {
        config: yield* ServerConfig.ServerConfig,
        tracker: yield* ProjectCloneTracker.ProjectCloneTracker,
        // What `sourceControl.checkRemoteAccess` and `sourceControl.inspectDestination` serve.
        checkRemoteAccess: yield* SourceControlRepositoryService.checkRemoteAccessHandler,
        inspectDestination: yield* SourceControlRepositoryService.inspectDestinationHandler,
      };
    }).pipe(Effect.provideContext(context));
  });

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const base = yield* fs
    .makeTempDirectoryScoped({ prefix: "swc-add-to-machine-" })
    .pipe(Effect.flatMap(fs.realPath));
  const git = (cwd: string, ...args: ReadonlyArray<string>) =>
    execFileSync("git", args, {
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: base,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
      stdio: "pipe",
      encoding: "utf8",
    }).trim();
  /** A bare repository with one commit, standing in for a hosted origin. */
  const origin = (name: string, readme: string) =>
    Effect.gen(function* () {
      const seed = `${base}/seed-${name}`;
      yield* fs.makeDirectory(seed, { recursive: true });
      yield* fs.writeFileString(`${seed}/README.md`, readme);
      const bare = `${base}/origins/${name}.git`;
      yield* Effect.sync(() => {
        git(seed, "-c", "init.defaultBranch=main", "init", "-q");
        git(seed, "add", "README.md");
        git(
          seed,
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "commit",
          "-qm",
          `Seed ${name}`,
        );
        git(base, "clone", "-q", "--bare", seed, bare);
      });
      return bare;
    });
  const app = yield* origin("app", "app\n");
  const other = yield* origin("other", "other\n");
  const m4max = yield* machine(`${base}/m4max`);
  const mini = yield* machine(`${base}/mini`);
  // The project as it lives on the source machine: a checkout of the origin.
  const sourceProject = path.join(m4max.config.cwd, "projects", "app");
  yield* fs.makeDirectory(`${m4max.config.cwd}/projects`, { recursive: true });
  yield* Effect.sync(() => git(base, "clone", "-q", app, sourceProject));
  /** The origin key a local bare repository canonicalizes to: its file URL. */
  const originKey = (bare: string) => decodeURIComponent(pathToFileURL(bare).href);
  return { fs, path, base, git, app, other, m4max, mini, sourceProject, originKey };
});

describe("add a project to another machine, server side", () => {
  it.effect("the two stacks are isolated and the source reports the project's origin", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      expect(f.m4max.config.baseDir).not.toBe(f.mini.config.baseDir);
      expect(f.m4max.config.cwd).not.toBe(f.mini.config.cwd);
      expect(f.m4max.tracker).not.toBe(f.mini.tracker);
      const source = yield* f.m4max.inspectDestination({
        path: f.sourceProject,
        remoteUrl: f.app,
      });
      expect(source).toEqual({
        path: f.sourceProject,
        state: "repository",
        originKey: f.originKey(f.app),
        sameRepository: true,
        checkedOut: true,
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("the destination checks it can read the origin before cloning", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      expect(yield* f.mini.checkRemoteAccess({ remoteUrl: f.app })).toEqual({
        status: "ok",
        detail: null,
      });
      const missing = yield* f.mini.checkRemoteAccess({ remoteUrl: `${f.base}/origins/gone.git` });
      expect(["no-access", "error"]).toContain(missing.status);
      expect(missing.detail).not.toBeNull();
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("the destination classifies what is already at the chosen folder", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const projects = f.path.join(f.mini.config.cwd, "projects");
      yield* f.fs.makeDirectory(projects, { recursive: true });
      const sameClone = f.path.join(projects, "app-existing");
      const otherClone = f.path.join(projects, "other");
      const plain = f.path.join(projects, "notes");
      yield* Effect.sync(() => {
        f.git(f.base, "clone", "-q", f.app, sameClone);
        f.git(f.base, "clone", "-q", f.other, otherClone);
      });
      yield* f.fs.makeDirectory(plain);
      yield* f.fs.writeFileString(`${plain}/todo.txt`, "mine\n");

      const fresh = yield* f.mini.inspectDestination({
        path: `${projects}/app`,
        remoteUrl: f.app,
      });
      expect(fresh).toMatchObject({ state: "missing", sameRepository: false });
      expect(yield* f.mini.inspectDestination({ path: sameClone, remoteUrl: f.app })).toMatchObject(
        {
          state: "repository",
          originKey: f.originKey(f.app),
          sameRepository: true,
          checkedOut: true,
        },
      );
      expect(
        yield* f.mini.inspectDestination({ path: otherClone, remoteUrl: f.app }),
      ).toMatchObject({
        state: "repository",
        originKey: f.originKey(f.other),
        sameRepository: false,
      });
      expect(yield* f.mini.inspectDestination({ path: plain, remoteUrl: f.app })).toMatchObject({
        state: "not-repository",
        sameRepository: false,
      });
      expect(yield* f.fs.readFileString(`${plain}/todo.txt`)).toBe("mine\n");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("the destination clones into the missing folder with the same origin", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const projectId = ProjectId.make("add-to-machine-app");
      const destination = f.path.join(f.mini.config.cwd, "projects", "app");
      const created: Array<string> = [];
      const cloned: Array<string> = [];
      const hooks: ProjectCloneTracker.ProjectCloneHooks = {
        createProject: ({ workspaceRoot }) => Effect.sync(() => void created.push(workspaceRoot)),
        onCloned: ({ workspaceRoot }) => Effect.sync(() => void cloned.push(workspaceRoot)),
      };
      const result = yield* f.mini.tracker.start(
        {
          projectId,
          title: "app",
          createdAt: "2026-10-20T00:00:00.000Z",
          remoteUrl: f.app,
          destinationPath: destination,
        },
        hooks,
      );
      expect(result).toMatchObject({ projectId, cwd: destination, remoteUrl: f.app });
      expect(created).toEqual([destination]);

      let phase: string | undefined;
      for (let attempt = 0; attempt < 1000 && phase !== "done"; attempt += 1) {
        phase = (yield* f.mini.tracker.get(projectId))?.phase;
        if (phase === "failed") break;
        if (phase !== "done") yield* Effect.promise(() => Effect.runPromise(Effect.sleep(10)));
      }
      expect(yield* f.mini.tracker.get(projectId)).toMatchObject({ phase: "done", error: null });
      expect(cloned).toEqual([destination]);
      // Only MINI ran a clone; M4MAX's tracker never heard of the project.
      expect(yield* f.m4max.tracker.get(projectId)).toBeNull();

      expect(f.git(destination, "remote", "get-url", "origin")).toBe(f.app);
      expect(f.git(destination, "rev-parse", "HEAD")).toBe(f.git(f.app, "rev-parse", "HEAD"));
      expect(f.git(destination, "rev-parse", "HEAD")).toBe(
        f.git(f.sourceProject, "rev-parse", "HEAD"),
      );
      expect(yield* f.fs.readFileString(`${destination}/README.md`)).toBe("app\n");
      expect(
        yield* f.mini.inspectDestination({ path: destination, remoteUrl: f.app }),
      ).toMatchObject({ state: "repository", sameRepository: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
