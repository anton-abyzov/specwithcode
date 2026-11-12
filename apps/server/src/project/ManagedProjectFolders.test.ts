import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  GitCommandError,
  PERSONAL_ASSISTANT_PROJECT_ICON,
  ProjectId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/process";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The denied ~/.ssh is under the real home.
import { homedir } from "node:os";

import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { GIT_SPAWN_FAILURE_DETAIL } from "../vcs/GitVcsDriverCore.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ProjectEnrichmentService from "./ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "./ProjectFaviconResolver.ts";
import * as ProjectService from "./ProjectService.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";
import * as ManagedProjectFolders from "./ManagedProjectFolders.ts";
import * as SpecweaveSetup from "./SpecweaveSetup.ts";

// Real repository detection: the service only asks the Git workflow whether
// the data dir is inside a checkout.
const layerGitWorkflow = Layer.unwrap(
  Effect.gen(function* () {
    const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
    return Layer.mock(GitWorkflow.GitWorkflowService)({
      isRepository: (cwd) =>
        registry.detect({ cwd }).pipe(
          Effect.map((handle) => handle?.kind === "git"),
          Effect.orDie,
        ),
    });
  }),
).pipe(Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))));

const layerEnrichment = ProjectEnrichmentService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
        resolve: () => Effect.succeed(null),
      }),
      Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
        resolvePath: () => Effect.succeed(null),
      }),
    ),
  ),
);

const layerRealGit = GitVcsDriver.layer.pipe(Layer.provide(VcsProcess.layer));

interface HarnessOptions {
  /** A Git workflow for detection failures real git cannot produce on demand. */
  readonly gitWorkflow?: Layer.Layer<GitWorkflow.GitWorkflowService>;
  /** A git driver for failures real git cannot produce on demand. */
  readonly git?: Layer.Layer<GitVcsDriver.GitVcsDriver>;
  /** Wraps the real ProjectService, for failures it cannot produce on demand. */
  readonly projects?: (
    real: ProjectService.ProjectService["Service"],
  ) => ProjectService.ProjectService["Service"];
  /** Stands in for `specweave init`; without it SpecWeave setup is unavailable. */
  readonly specweave?: Layer.Layer<SpecweaveSetup.SpecweaveSetup>;
}

/**
 * The service over a real ProjectService and real git, with its data dir at
 * `baseDir`.
 */
const layer = (baseDir: string, options?: HarnessOptions) =>
  ManagedProjectFolders.layer.pipe(
    Layer.provide(options?.specweave ?? Layer.empty),
    Layer.provide(
      options?.projects === undefined
        ? Layer.empty
        : Layer.effect(
            ProjectService.ProjectService,
            ProjectService.ProjectService.pipe(Effect.map(options.projects)),
          ),
    ),
    Layer.provideMerge(RuntimeLayer.layerProjectService),
    Layer.provideMerge(layerEnrichment),
    Layer.provideMerge(WorkspacePaths.layer),
    Layer.provideMerge(options?.gitWorkflow ?? layerGitWorkflow),
    Layer.provideMerge(options?.git ?? layerRealGit),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(ServerConfig.layerTest(baseDir, baseDir)),
    Layer.provideMerge(NodeServices.layer),
  );

/** Runs `body` with a data dir in a fresh temp folder, outside any checkout. */
const withScratch = <A, E>(
  body: (input: {
    readonly baseDir: string;
  }) => Effect.Effect<
    A,
    E,
    | ManagedProjectFolders.ManagedProjectFolders
    | ProjectService.ProjectService
    | ServerConfig.ServerConfig
    | NodeServices.NodeServices
    | Scope.Scope
  >,
  options?: HarnessOptions,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "studio-managed-folders-",
    });
    return yield* body({ baseDir }).pipe(Effect.provide(layer(baseDir, options)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const git = (cwd: string, args: ReadonlyArray<string>) =>
  ProcessRunner.ProcessRunner.pipe(
    Effect.flatMap((runner) => runner.run({ command: "git", args: ["-C", cwd, ...args] })),
    Effect.provide(ProcessRunner.layer),
  );

const requireRoot = Effect.gen(function* () {
  const scratch = yield* ManagedProjectFolders.ManagedProjectFolders;
  return Option.getOrThrow(yield* scratch.scratchRoot);
});

it.effect("offers a Scratch folder under the data dir when it is outside a checkout", () =>
  withScratch(({ baseDir }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      assert.equal(yield* requireRoot, path.resolve(baseDir, "scratch"));
    }),
  ),
);

it.effect("offers nothing when the data dir sits inside a Git checkout", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const checkout = yield* fileSystem.makeTempDirectoryScoped({ prefix: "studio-scratch-repo-" });
    yield* git(checkout, ["init", "--quiet"]);
    const baseDir = path.join(checkout, ".specweave-studio");
    yield* fileSystem.makeDirectory(baseDir);
    yield* Effect.gen(function* () {
      const scratch = yield* ManagedProjectFolders.ManagedProjectFolders;
      assert.isTrue(Option.isNone(yield* scratch.scratchRoot));
      const failure = yield* Effect.flip(scratch.ensureScratchProject);
      assert.equal(failure._tag, "ScratchUnavailableError");
    }).pipe(Effect.provide(layer(baseDir)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// A fresh Linux desktop without Git: the probe cannot run at all.
const layerGitMissing = Layer.mock(GitWorkflow.GitWorkflowService)({
  isRepository: (cwd) =>
    Effect.fail(
      new GitCommandError({
        operation: "GitWorkflowService.isRepository",
        command: "git rev-parse --is-inside-work-tree",
        cwd,
        detail: "spawn git ENOENT",
      }),
    ),
});

it.effect("offers a Scratch folder when Git cannot run and no parent holds .git", () =>
  withScratch(
    ({ baseDir }) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        assert.equal(yield* requireRoot, path.resolve(baseDir, "scratch"));
        yield* (yield* ManagedProjectFolders.ManagedProjectFolders).ensureScratchProject;
      }),
    { gitWorkflow: layerGitMissing },
  ),
);

it.effect("offers nothing when Git cannot run and a parent holds .git", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const checkout = yield* fileSystem.makeTempDirectoryScoped({ prefix: "studio-scratch-nogit-" });
    yield* fileSystem.makeDirectory(path.join(checkout, ".git"));
    const baseDir = path.join(checkout, "home", ".specwithcode");
    yield* fileSystem.makeDirectory(baseDir, { recursive: true });
    yield* Effect.gen(function* () {
      const scratch = yield* ManagedProjectFolders.ManagedProjectFolders;
      assert.isTrue(Option.isNone(yield* scratch.scratchRoot));
    }).pipe(Effect.provide(layer(baseDir, { gitWorkflow: layerGitMissing })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("offers nothing when Git cannot run and the data dir links into a checkout", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dotfiles = yield* fileSystem.makeTempDirectoryScoped({ prefix: "studio-scratch-dots-" });
    yield* fileSystem.makeDirectory(path.join(dotfiles, ".git"));
    const target = path.join(dotfiles, "specwithcode");
    yield* fileSystem.makeDirectory(target);
    const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "studio-scratch-home-" });
    const baseDir = path.join(home, ".specwithcode");
    yield* fileSystem.symlink(target, baseDir);
    yield* Effect.gen(function* () {
      const scratch = yield* ManagedProjectFolders.ManagedProjectFolders;
      assert.isTrue(Option.isNone(yield* scratch.scratchRoot));
    }).pipe(Effect.provide(layer(baseDir, { gitWorkflow: layerGitMissing })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("creates one Scratch project, even for concurrent first requests", () =>
  withScratch(() =>
    Effect.gen(function* () {
      const scratch = yield* ManagedProjectFolders.ManagedProjectFolders;
      const projects = yield* ProjectService.ProjectService;
      // Without handling the losing creates' conflicts, eight racers fail.
      const racers = yield* Effect.all(
        Array.from({ length: 8 }, () => scratch.ensureScratchProject),
        { concurrency: "unbounded" },
      );
      const again = yield* scratch.ensureScratchProject;
      assert.deepEqual(
        new Set(racers.map((result) => result.projectId)),
        new Set([again.projectId]),
      );

      const snapshot = yield* projects.snapshot;
      const root = yield* requireRoot;
      const scratchProjects = snapshot.projects.filter((project) => project.workspaceRoot === root);
      assert.lengthOf(scratchProjects, 1);
      assert.equal(scratchProjects[0]?.title, "No project");
      assert.deepEqual(scratchProjects[0]?.projectIcon, {
        kind: "lucide",
        name: "message-square-dashed",
        color: "gray",
      });
    }),
  ),
);

it.effect("recreates the Scratch folder after it is deleted", () =>
  withScratch(() =>
    Effect.gen(function* () {
      const scratch = yield* ManagedProjectFolders.ManagedProjectFolders;
      const fileSystem = yield* FileSystem.FileSystem;
      const { projectId } = yield* scratch.ensureScratchProject;
      const root = yield* requireRoot;
      yield* fileSystem.remove(root, { recursive: true });

      assert.equal((yield* scratch.ensureScratchProject).projectId, projectId);
      assert.isTrue(yield* fileSystem.exists(root));

      yield* fileSystem.remove(root, { recursive: true });
      const folder = yield* scratch.folderForThread({
        projectId,
        threadId: ThreadId.make("thread-after-delete"),
        text: "Still works",
      });
      assert.isTrue(yield* fileSystem.exists(Option.getOrThrow(folder)));
    }),
  ),
);

it.effect("gives each Scratch thread its own folder, named from its message", () =>
  withScratch(() =>
    Effect.gen(function* () {
      const scratch = yield* ManagedProjectFolders.ManagedProjectFolders;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { projectId } = yield* scratch.ensureScratchProject;
      const root = yield* requireRoot;
      const text = "Convert these PNGs to WebP, please!";
      // Two ids with the same tail would collide on the short name.
      const first = Option.getOrThrow(
        yield* scratch.folderForThread({
          projectId,
          threadId: ThreadId.make("thread:a:0123456789abcdef"),
          text,
        }),
      );
      const second = Option.getOrThrow(
        yield* scratch.folderForThread({
          projectId,
          threadId: ThreadId.make("thread:b:0123456789abcdef"),
          text,
        }),
      );

      // Ids that normalize to the same characters take both of its names.
      const third = Option.getOrThrow(
        yield* scratch.folderForThread({
          projectId,
          threadId: ThreadId.make("thread:b0123456789abcdef"),
          text,
        }),
      );

      assert.equal(new Set([first, second, third]).size, 3);
      for (const folder of [first, second, third]) {
        assert.equal(path.dirname(folder), root);
        assert.match(path.basename(folder), /^\d{4}-\d{2}-\d{2}-convert-these-pngs-to-webp-/);
        assert.isTrue(yield* fileSystem.exists(folder));
      }

      const pasted = Option.getOrThrow(
        yield* scratch.folderForThread({
          projectId,
          threadId: ThreadId.make("thread-pasted"),
          text: `${"word ".repeat(10_000)}../../etc`,
        }),
      );
      assert.equal(path.dirname(pasted), root);
      assert.isAtMost(path.basename(pasted).length, 80);
    }),
  ),
);

it.effect("leaves threads in other projects alone", () =>
  withScratch(({ baseDir }) =>
    Effect.gen(function* () {
      const scratch = yield* ManagedProjectFolders.ManagedProjectFolders;
      const projects = yield* ProjectService.ProjectService;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* scratch.ensureScratchProject;
      const other = yield* projects.create({
        commandId: CommandId.make("command:other"),
        projectId: ProjectId.make("project:other"),
        title: "Other",
        workspaceRoot: path.join(baseDir, "other"),
        createWorkspaceRootIfMissing: true,
      });

      const folder = yield* scratch.folderForThread({
        projectId: other.id,
        threadId: ThreadId.make("thread-other"),
        text: "Hello",
      });
      assert.isTrue(Option.isNone(folder));
      assert.deepEqual(yield* fileSystem.readDirectory(yield* requireRoot), []);
    }),
  ),
);

const GIT_IDENTITY_KEYS = [
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "EMAIL",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
] as const;

/**
 * Runs `effect` with git reading only an empty global config plus `env`, so
 * the developer's own identity and signing settings stay out of the test. The
 * suite's pinned settings (gitConfig.setup.ts) still apply.
 */
const withGitEnv = <A, E, R>(
  env: Partial<Record<(typeof GIT_IDENTITY_KEYS)[number], string>>,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const emptyConfig = yield* fileSystem.makeTempFileScoped({ prefix: "studio-gitconfig-" });
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const saved = GIT_IDENTITY_KEYS.map((key) => [key, process.env[key]] as const);
        for (const key of GIT_IDENTITY_KEYS) delete process.env[key];
        Object.assign(process.env, {
          GIT_CONFIG_GLOBAL: emptyConfig,
          GIT_CONFIG_NOSYSTEM: "1",
          ...env,
        });
        return saved;
      }),
      () => effect,
      (saved) =>
        Effect.sync(() => {
          for (const [key, value] of saved) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
          }
        }),
    );
  });

const TEST_IDENTITY = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

const gitOutput = (cwd: string, args: ReadonlyArray<string>) =>
  git(cwd, args).pipe(Effect.map((result) => result.stdout.trim()));

it.effect("starts a named project as a committed repository, and suffixes a taken name", () =>
  withScratch(({ baseDir }) =>
    withGitEnv(
      TEST_IDENTITY,
      Effect.gen(function* () {
        const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
        const projects = yield* ProjectService.ProjectService;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = path.resolve(baseDir, "projects");
        assert.equal(folders.namedProjectsRoot, root);

        const first = yield* folders.createNamedProject({ name: "Pinball Stats" });
        const second = yield* folders.createNamedProject({ name: "pinball stats" });

        assert.equal(first.workspaceRoot, path.join(root, "pinball-stats"));
        assert.equal(second.workspaceRoot, path.join(root, "pinball-stats-2"));
        assert.isUndefined(first.commitError);
        const project = Option.getOrThrow(yield* projects.getById(first.projectId));
        assert.equal(project.title, "Pinball Stats");
        assert.equal(project.workspaceRoot, first.workspaceRoot);

        const readme = yield* fileSystem.readFileString(
          path.join(first.workspaceRoot, "README.md"),
        );
        assert.include(readme, "# Pinball Stats");
        assert.include(readme, `src="assets/icon.svg"`);
        const icon = yield* fileSystem.readFileString(
          path.join(first.workspaceRoot, "assets", "icon.svg"),
        );
        assert.include(icon, ">PS</text>");
        assert.equal(
          yield* gitOutput(first.workspaceRoot, ["log", "--format=%s"]),
          "Initial commit",
        );
        assert.equal(
          yield* gitOutput(first.workspaceRoot, ["rev-parse", "--abbrev-ref", "HEAD"]),
          "main",
        );
        assert.equal(yield* gitOutput(first.workspaceRoot, ["status", "--porcelain"]), "");
      }),
    ),
  ),
);

it.effect("gives concurrent named projects with the same name distinct folders", () =>
  withScratch(() =>
    withGitEnv(
      TEST_IDENTITY,
      Effect.gen(function* () {
        const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
        const projects = yield* ProjectService.ProjectService;
        const created = yield* Effect.all(
          Array.from({ length: 4 }, () => folders.createNamedProject({ name: "Race" })),
          { concurrency: "unbounded" },
        );

        assert.equal(new Set(created.map((result) => result.workspaceRoot)).size, 4);
        assert.equal(new Set(created.map((result) => result.projectId)).size, 4);
        const snapshot = yield* projects.snapshot;
        for (const result of created) {
          assert.isTrue(
            snapshot.projects.some((project) => project.workspaceRoot === result.workspaceRoot),
          );
        }
      }),
    ),
  ),
);

it.effect("keeps a named project and reports why when Git cannot commit", () =>
  withScratch(({ baseDir }) =>
    // No identity anywhere, and Git may not guess one from the host name.
    withGitEnv(
      {},
      Effect.gen(function* () {
        const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
        const projects = yield* ProjectService.ProjectService;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.writeFileString(
          path.join(baseDir, "no-identity.gitconfig"),
          "[user]\n\tuseConfigOnly = true\n",
        );
        process.env.GIT_CONFIG_GLOBAL = path.join(baseDir, "no-identity.gitconfig");

        const result = yield* folders.createNamedProject({ name: "No Identity" });

        assert.include(result.commitError ?? "", "no name or email");
        assert.include(result.commitError ?? "", "git config --global user.email");
        assert.isTrue(Option.isSome(yield* projects.getById(result.projectId)));
        assert.isTrue(yield* fileSystem.exists(path.join(result.workspaceRoot, "README.md")));
        assert.isTrue(yield* fileSystem.exists(path.join(result.workspaceRoot, ".git")));
      }),
    ),
  ),
);

// Writes what `specweave init` writes that matters here, as the real CLI would.
const fakeSpecweaveInit = Layer.effect(
  SpecweaveSetup.SpecweaveSetup,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return SpecweaveSetup.SpecweaveSetup.of({
      setUp: (cwd) =>
        Effect.gen(function* () {
          yield* fileSystem.makeDirectory(path.join(cwd, ".specweave", "state"), {
            recursive: true,
          });
          yield* fileSystem.writeFileString(path.join(cwd, ".specweave", "config.json"), "{}\n");
          yield* fileSystem.writeFileString(path.join(cwd, ".specweave", "state", "x.json"), "{}");
          yield* fileSystem.writeFileString(path.join(cwd, ".gitignore"), ".specweave/state/\n");
          yield* fileSystem.writeFileString(path.join(cwd, "AGENTS.md"), "# Agents\n");
          return { ok: true, alreadySetUp: false } as const;
        }).pipe(Effect.orDie),
    });
  }),
).pipe(Layer.provide(NodeServices.layer));

it.effect("sets a new project up with SpecWeave only when asked, inside the first commit", () =>
  withScratch(
    () =>
      withGitEnv(
        TEST_IDENTITY,
        Effect.gen(function* () {
          const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;

          const plain = yield* folders.createNamedProject({ name: "Plain" });
          assert.isFalse(yield* fileSystem.exists(path.join(plain.workspaceRoot, ".specweave")));

          const tracked = yield* folders.createNamedProject({ name: "Tracked", specweave: true });
          assert.isUndefined(tracked.specweaveError);
          assert.isUndefined(tracked.commitError);
          assert.equal(
            yield* gitOutput(tracked.workspaceRoot, ["log", "--format=%s"]),
            "Initial commit",
          );
          const committed = (yield* gitOutput(tracked.workspaceRoot, [
            "ls-tree",
            "-r",
            "--name-only",
            "HEAD",
          ])).split("\n");
          assert.includeMembers(committed, [
            ".gitignore",
            ".specweave/config.json",
            "AGENTS.md",
            "README.md",
            "assets/icon.svg",
          ]);
          assert.notInclude(committed, ".specweave/state/x.json");
          assert.equal(yield* gitOutput(tracked.workspaceRoot, ["status", "--porcelain"]), "");

          const personal = yield* folders.createNamedProject({
            name: "Me",
            kind: "personal",
            specweave: true,
          });
          assert.isFalse(yield* fileSystem.exists(path.join(personal.workspaceRoot, ".specweave")));
        }),
      ),
    { specweave: fakeSpecweaveInit },
  ),
);

it.effect("keeps the project and says why when SpecWeave cannot be set up", () =>
  withScratch(
    () =>
      withGitEnv(
        TEST_IDENTITY,
        Effect.gen(function* () {
          const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
          const projects = yield* ProjectService.ProjectService;
          const result = yield* folders.createNamedProject({ name: "No CLI", specweave: true });
          assert.include(result.specweaveError ?? "", "neither specweave nor npx");
          assert.isTrue(Option.isSome(yield* projects.getById(result.projectId)));
          assert.equal(
            yield* gitOutput(result.workspaceRoot, ["log", "--format=%s"]),
            "Initial commit",
          );
        }),
      ),
    {
      specweave: Layer.succeed(SpecweaveSetup.SpecweaveSetup, {
        setUp: () =>
          Effect.succeed({
            ok: false,
            reason: "unavailable",
            detail: SpecweaveSetup.specweaveUnavailableDetail("linux"),
          } as const),
      }),
    },
  ),
);

it.effect("keeps a folder that another project owns when the create conflicts", () =>
  withScratch(({ baseDir }) =>
    withGitEnv(
      TEST_IDENTITY,
      Effect.gen(function* () {
        const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
        const projects = yield* ProjectService.ProjectService;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const taken = path.join(folders.namedProjectsRoot, "taken");
        // A project registered at this path some other way (by hand, or a
        // client that predates the claim) owns the folder the create claims.
        yield* projects.create({
          commandId: CommandId.make("command:owner"),
          projectId: ProjectId.make("project:owner"),
          title: "Owner",
          workspaceRoot: taken,
          createWorkspaceRootIfMissing: true,
        });
        yield* fileSystem.remove(taken, { recursive: true });

        const failure = yield* Effect.flip(folders.createNamedProject({ name: "Taken" }));

        assert.equal(failure._tag, "NamedProjectCreateError");
        assert.equal(failure.message, "Failed to create the project.");
        assert.isTrue(yield* fileSystem.exists(path.join(taken, "README.md")));
        const owner = yield* projects.getByWorkspaceRoot(taken);
        assert.equal(Option.getOrThrow(owner).id, ProjectId.make("project:owner"));
        assert.deepEqual(yield* fileSystem.readDirectory(path.resolve(baseDir, "projects")), [
          "taken",
        ]);
      }),
    ),
  ),
);

it.effect("removes the folder when the project create is rejected for another reason", () =>
  withScratch(
    ({ baseDir }) =>
      withGitEnv(
        TEST_IDENTITY,
        Effect.gen(function* () {
          const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;

          const failure = yield* Effect.flip(folders.createNamedProject({ name: "Rejected" }));

          assert.equal(failure._tag, "NamedProjectCreateError");
          assert.deepEqual(yield* fileSystem.readDirectory(path.resolve(baseDir, "projects")), []);
        }),
      ),
    {
      // The project store failing the create is not something a real
      // ProjectService can be made to do on demand.
      projects: (real) =>
        ProjectService.ProjectService.of({
          ...real,
          create: (input) =>
            Effect.fail(
              new ProjectService.ProjectOperationError({
                operation: "dispatch-project-command",
                projectId: input.projectId,
                cause: "store unavailable",
              }),
            ),
        }),
    },
  ),
);

it.effect("removes the folder when the create is cancelled before the project exists", () =>
  Effect.gen(function* () {
    const scaffolding = yield* Deferred.make<void>();
    yield* withScratch(
      ({ baseDir }) =>
        Effect.gen(function* () {
          const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
          const projects = yield* ProjectService.ProjectService;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;

          const fiber = yield* folders
            .createNamedProject({ name: "Cancelled" })
            .pipe(Effect.forkChild);
          yield* Deferred.await(scaffolding);
          assert.deepEqual(yield* fileSystem.readDirectory(path.resolve(baseDir, "projects")), [
            "cancelled",
          ]);
          yield* Fiber.interrupt(fiber);

          assert.deepEqual(yield* fileSystem.readDirectory(path.resolve(baseDir, "projects")), []);
          assert.deepEqual((yield* projects.snapshot).projects, []);
        }),
      {
        // Holds `git init` open so the create can be interrupted mid-scaffold.
        git: Layer.mock(GitVcsDriver.GitVcsDriver)({
          readConfigValue: () => Effect.succeed(null),
          execute: () =>
            Deferred.succeed(scaffolding, undefined).pipe(Effect.andThen(Effect.never)),
        }),
      },
    );
  }),
);

it.effect("removes the folder when the repository cannot be made", () =>
  withScratch(
    ({ baseDir }) =>
      Effect.gen(function* () {
        const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
        const projects = yield* ProjectService.ProjectService;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        const failure = yield* Effect.flip(folders.createNamedProject({ name: "Broken" }));

        assert.equal(failure._tag, "NamedProjectFolderError");
        assert.equal(failure.message, "Failed to create the project folder.");
        assert.deepEqual(yield* fileSystem.readDirectory(path.resolve(baseDir, "projects")), []);
        assert.deepEqual((yield* projects.snapshot).projects, []);
      }),
    {
      // git init itself failing (a missing or broken git) is not something a
      // real git can be made to do on demand.
      git: Layer.mock(GitVcsDriver.GitVcsDriver)({
        readConfigValue: () => Effect.succeed(null),
        execute: (input) =>
          Effect.fail(
            new GitCommandError({
              operation: input.operation,
              command: "git",
              cwd: input.cwd,
              detail: "git is broken",
            }),
          ),
      }),
    },
  ),
);

it.effect("reuses one Personal assistant for concurrent requests without invoking Git", () =>
  withScratch(
    () =>
      Effect.gen(function* () {
        const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
        const projects = yield* ProjectService.ProjectService;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const created = yield* Effect.all(
          [0, 1].map(() => folders.createNamedProject({ name: "Personal", kind: "personal" })),
          { concurrency: 2 },
        );
        assert.equal(created[0]!.workspaceRoot, created[1]!.workspaceRoot);
        assert.equal(created[0]!.projectId, created[1]!.projectId);
        assert.equal((yield* projects.snapshot).projects.length, 1);
        for (const result of created) {
          assert.isUndefined(result.commitError);
          assert.isFalse(yield* fs.exists(path.join(result.workspaceRoot, ".git")));
          assert.deepEqual(yield* fs.readDirectory(result.workspaceRoot), []);
          const project = Option.getOrThrow(yield* projects.getById(result.projectId));
          assert.equal(project.workspaceSettings?.kind, "personal");
          assert.deepEqual(project.projectIcon, PERSONAL_ASSISTANT_PROJECT_ICON);
          assert.isNull(project.repositoryIdentity);
          assert.isTrue(result.workspaceRoot.startsWith(folders.namedProjectsRoot + path.sep));
        }
      }),
    {
      git: Layer.mock(GitVcsDriver.GitVcsDriver)({
        readConfigValue: () => Effect.die("Personal must not read Git config"),
        execute: () => Effect.die("Personal must not execute Git"),
      }),
    },
  ),
);

it.effect("refuses a new Personal assistant while Aide is off, leaving no folder", () =>
  withScratch(() =>
    Effect.gen(function* () {
      const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
      const projects = yield* ProjectService.ProjectService;
      const fs = yield* FileSystem.FileSystem;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({ aideEnabled: false });
      const refused = yield* folders
        .createNamedProject({ name: "Aide", kind: "personal" })
        .pipe(Effect.flip);
      assert.equal(refused._tag, "PersonalAssistantDisabledError");
      assert.equal(
        refused.message,
        "The personal assistant is turned off. Turn it on in Settings > General.",
      );
      assert.equal((yield* projects.snapshot).projects.length, 0);
      const root = folders.namedProjectsRoot;
      assert.deepEqual((yield* fs.exists(root)) ? yield* fs.readDirectory(root) : [], []);
    }).pipe(Effect.provide(ServerSettings.layerTest())),
  ),
);

it.effect("still opens an existing Personal assistant while Aide is off", () =>
  withScratch(() =>
    Effect.gen(function* () {
      const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({ aideEnabled: true });
      const created = yield* folders.createNamedProject({ name: "Aide", kind: "personal" });
      yield* settings.updateSettings({ aideEnabled: false });
      const reopened = yield* folders.createNamedProject({ name: "Aide", kind: "personal" });
      assert.equal(reopened.projectId, created.projectId);
      assert.equal(reopened.workspaceRoot, created.workspaceRoot);
    }).pipe(Effect.provide(ServerSettings.layerTest())),
  ),
);

it.effect("creates in the chosen parent and preserves existing folders on collision", () =>
  withScratch(({ baseDir }) =>
    withGitEnv(
      TEST_IDENTITY,
      Effect.gen(function* () {
        const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parentPath = path.join(baseDir, "chosen");
        yield* fs.makeDirectory(path.join(parentPath, "example"), { recursive: true });
        yield* fs.writeFileString(path.join(parentPath, "example", "keep.txt"), "untouched");
        const result = yield* folders.createNamedProject({ name: "Example", parentPath });
        assert.equal(result.workspaceRoot, path.join(parentPath, "example-2"));
        assert.equal(
          yield* fs.readFileString(path.join(parentPath, "example", "keep.txt")),
          "untouched",
        );
        assert.equal(
          yield* gitOutput(result.workspaceRoot, ["log", "--format=%s"]),
          "Initial commit",
        );
      }),
    ),
  ),
);
it.effect("rejects relative, missing and file parents without creating them", () =>
  withScratch(({ baseDir }) =>
    Effect.gen(function* () {
      const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const file = path.join(baseDir, "keep.txt");
      yield* fs.writeFileString(file, "untouched");
      for (const parentPath of ["relative", "~/Projects", path.join(baseDir, "missing"), file]) {
        const result = yield* folders
          .createNamedProject({ name: "Example", parentPath })
          .pipe(Effect.result);
        assert.equal(result._tag, "Failure");
      }
      assert.isFalse(yield* fs.exists(path.join(baseDir, "missing")));
      assert.equal(yield* fs.readFileString(file), "untouched");
    }),
  ),
);
it.effect(
  "makes the advertised projects folder at start and accepts it as an explicit parent",
  () =>
    withScratch(() =>
      Effect.gen(function* () {
        const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // Browsing the advertised default must never hit a missing folder.
        assert.isTrue(yield* fs.exists(folders.namedProjectsRoot));
        yield* fs.remove(folders.namedProjectsRoot, { recursive: true });
        const result = yield* folders.createNamedProject({
          name: "Example",
          parentPath: `${folders.namedProjectsRoot}${path.sep}`,
        });
        assert.equal(result.workspaceRoot, path.join(folders.namedProjectsRoot, "example"));
      }),
    ),
);
it.effect("keeps Personal storage managed even when a parent is supplied", () =>
  withScratch(() =>
    Effect.gen(function* () {
      const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
      const path = yield* Path.Path;
      const result = yield* folders.createNamedProject({
        name: "Personal",
        kind: "personal",
        parentPath: "/nonexistent-parent",
      });
      assert.isTrue(result.workspaceRoot.startsWith(folders.namedProjectsRoot + path.sep));
    }),
  ),
);

// A git driver that fails the test if a create touches Git at all.
const noGitDriver = Layer.mock(GitVcsDriver.GitVcsDriver)({
  readConfigValue: () => Effect.die("An existing folder must not read Git config"),
  execute: () => Effect.die("An existing folder must not run Git"),
});

it.effect("binds a chosen existing repository as-is instead of nesting a new one", () =>
  withScratch(
    ({ baseDir }) =>
      Effect.gen(function* () {
        const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
        const projects = yield* ProjectService.ProjectService;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const repo = path.join(baseDir, "sw-easychamp");
        yield* fs.makeDirectory(path.join(repo, ".git"), { recursive: true });
        yield* fs.writeFileString(path.join(repo, "keep.txt"), "untouched");
        const result = yield* folders.createNamedProject({ name: "EasyChamp", parentPath: repo });
        assert.equal(result.workspaceRoot, repo);
        assert.isTrue(result.existing);
        assert.isFalse(yield* fs.exists(path.join(repo, "easychamp")));
        assert.isFalse(yield* fs.exists(path.join(repo, "README.md")));
        assert.deepEqual((yield* fs.readDirectory(repo)).toSorted(), [".git", "keep.txt"]);
        const project = Option.getOrThrow(yield* projects.getById(result.projectId));
        assert.equal(project.workspaceRoot, repo);
        assert.equal(project.title, "EasyChamp");

        const again = yield* folders.createNamedProject({
          name: "EasyChamp",
          parentPath: `${repo}/`,
        });
        assert.equal(again.projectId, result.projectId);
        assert.isTrue(again.existing);
      }),
    { git: noGitDriver },
  ),
);

it.effect("keeps a real repository's branches and remote when binding it", () =>
  withScratch(({ baseDir }) =>
    withGitEnv(
      TEST_IDENTITY,
      Effect.gen(function* () {
        const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const repo = path.join(baseDir, "existing-repo");
        yield* fs.makeDirectory(repo);
        yield* git(repo, ["init", "--quiet", "--initial-branch=develop"]);
        yield* git(repo, ["commit", "--quiet", "--allow-empty", "-m", "Start"]);
        yield* git(repo, ["remote", "add", "origin", "https://example.invalid/repo.git"]);
        const result = yield* folders.createNamedProject({ name: "Other Name", parentPath: repo });
        assert.equal(result.workspaceRoot, repo);
        assert.isTrue(result.existing);
        assert.equal(yield* gitOutput(repo, ["branch", "--show-current"]), "develop");
        assert.equal(yield* gitOutput(repo, ["log", "--format=%s"]), "Start");
        assert.equal(
          yield* gitOutput(repo, ["remote", "get-url", "origin"]),
          "https://example.invalid/repo.git",
        );
        assert.isFalse(yield* fs.exists(path.join(repo, "other-name")));
      }),
    ),
  ),
);

it.effect(
  "binds a chosen folder with files named like the project, or an existing child repository",
  () =>
    withScratch(
      ({ baseDir }) =>
        Effect.gen(function* () {
          const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const named = path.join(baseDir, "pinball-stats");
          yield* fs.makeDirectory(named);
          yield* fs.writeFileString(path.join(named, "notes.txt"), "mine");
          const byName = yield* folders.createNamedProject({
            name: "Pinball Stats",
            parentPath: named,
          });
          assert.equal(byName.workspaceRoot, named);
          assert.isTrue(byName.existing);
          assert.deepEqual(yield* fs.readDirectory(named), ["notes.txt"]);

          const parent = path.join(baseDir, "code");
          const child = path.join(parent, "scores");
          yield* fs.makeDirectory(path.join(child, ".specweave"), { recursive: true });
          const byChild = yield* folders.createNamedProject({ name: "Scores", parentPath: parent });
          assert.equal(byChild.workspaceRoot, child);
          assert.isTrue(byChild.existing);
          assert.isFalse(yield* fs.exists(path.join(parent, "scores-2")));
        }),
      { git: noGitDriver },
    ),
);

it.effect("starts a full project in an empty folder named like it", () =>
  withScratch(
    ({ baseDir }) =>
      withGitEnv(
        TEST_IDENTITY,
        Effect.gen(function* () {
          const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const empty = path.join(baseDir, "carbon-test");
          yield* fs.makeDirectory(empty);
          const result = yield* folders.createNamedProject({
            name: "carbon-test",
            parentPath: empty,
            specweave: true,
          });
          assert.equal(result.workspaceRoot, empty);
          assert.isUndefined(result.existing);
          assert.isUndefined(result.specweaveError);
          assert.isUndefined(result.commitError);
          for (const file of [".git", "README.md", ".specweave/config.json"]) {
            assert.isTrue(yield* fs.exists(path.join(empty, file)), file);
          }
          assert.equal(yield* gitOutput(empty, ["status", "--porcelain"]), "");

          // The same folder again is now a project and is opened, not rebuilt.
          const again = yield* folders.createNamedProject({
            name: "carbon-test",
            parentPath: empty,
          });
          assert.equal(again.projectId, result.projectId);
          assert.isTrue(again.existing);
        }),
      ),
    { specweave: fakeSpecweaveInit },
  ),
);

it.effect("takes back only its starter files when a create in a person's folder fails", () =>
  withScratch(
    ({ baseDir }) =>
      withGitEnv(
        TEST_IDENTITY,
        Effect.gen(function* () {
          const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const empty = path.join(baseDir, "carbon-test");
          yield* fs.makeDirectory(empty);

          const failure = yield* Effect.flip(
            folders.createNamedProject({ name: "carbon-test", parentPath: empty, specweave: true }),
          );

          assert.equal(failure._tag, "NamedProjectCreateError");
          // The folder is still there, with everything that was not a starter file.
          assert.deepEqual((yield* fs.readDirectory(empty)).toSorted(), [
            ".gitignore",
            ".specweave",
            "AGENTS.md",
            "assets",
          ]);
          assert.deepEqual(yield* fs.readDirectory(path.join(empty, "assets")), ["notes.txt"]);
        }),
      ),
    {
      // Stands in for files that appear in the folder while the project is made.
      specweave: Layer.effect(
        SpecweaveSetup.SpecweaveSetup,
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          return SpecweaveSetup.SpecweaveSetup.of({
            setUp: (cwd) =>
              Effect.gen(function* () {
                yield* fileSystem.makeDirectory(path.join(cwd, ".specweave"));
                yield* fileSystem.writeFileString(path.join(cwd, ".gitignore"), "\n");
                yield* fileSystem.writeFileString(path.join(cwd, "AGENTS.md"), "# Agents\n");
                yield* fileSystem.writeFileString(path.join(cwd, "assets", "notes.txt"), "mine");
                return { ok: true, alreadySetUp: false } as const;
              }).pipe(Effect.orDie),
          });
        }),
      ).pipe(Layer.provide(NodeServices.layer)),
      projects: (real) =>
        ProjectService.ProjectService.of({
          ...real,
          create: (input) =>
            Effect.fail(
              new ProjectService.ProjectOperationError({
                operation: "dispatch-project-command",
                projectId: input.projectId,
                cause: "store unavailable",
              }),
            ),
        }),
    },
  ),
);

it.effect("makes one project when the same empty folder is asked for twice at once", () =>
  withScratch(({ baseDir }) =>
    withGitEnv(
      TEST_IDENTITY,
      Effect.gen(function* () {
        const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
        const projects = yield* ProjectService.ProjectService;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const empty = path.join(baseDir, "twice");
        yield* fs.makeDirectory(empty);
        const create = folders.createNamedProject({ name: "twice", parentPath: empty });

        const [first, second] = yield* Effect.all([create, create], { concurrency: 2 });

        assert.equal(first.projectId, second.projectId);
        assert.deepEqual([first.existing, second.existing].toSorted(), [true, undefined]);
        assert.lengthOf((yield* projects.snapshot).projects, 1);
        assert.equal(yield* gitOutput(empty, ["log", "--format=%s"]), "Initial commit");
        assert.isTrue(yield* fs.exists(path.join(empty, "assets", "icon.svg")));
      }),
    ),
  ),
);

it.effect("adds SpecWeave to an existing folder that has none when asked", () =>
  withScratch(
    ({ baseDir }) =>
      Effect.gen(function* () {
        const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const repo = path.join(baseDir, "existing");
        yield* fs.makeDirectory(path.join(repo, ".git"), { recursive: true });
        yield* fs.writeFileString(path.join(repo, "keep.txt"), "untouched");

        const plain = yield* folders.createNamedProject({ name: "Other", parentPath: repo });
        assert.isTrue(plain.existing);
        assert.isUndefined(plain.specweaveAdded);
        assert.isFalse(yield* fs.exists(path.join(repo, ".specweave")));

        const added = yield* folders.createNamedProject({
          name: "Other",
          parentPath: repo,
          specweave: true,
        });
        assert.equal(added.projectId, plain.projectId);
        assert.isTrue(added.existing);
        assert.isTrue(added.specweaveAdded);
        assert.isTrue(yield* fs.exists(path.join(repo, ".specweave", "config.json")));
        assert.equal(yield* fs.readFileString(path.join(repo, "keep.txt")), "untouched");

        const already = yield* folders.createNamedProject({
          name: "Other",
          parentPath: repo,
          specweave: true,
        });
        assert.isUndefined(already.specweaveAdded);
        assert.isUndefined(already.specweaveError);
      }),
    { git: noGitDriver, specweave: fakeSpecweaveInit },
  ),
);

it.effect("says why SpecWeave could not be added to an existing folder", () =>
  withScratch(
    ({ baseDir }) =>
      Effect.gen(function* () {
        const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const repo = path.join(baseDir, "existing");
        yield* fs.makeDirectory(path.join(repo, ".git"), { recursive: true });
        const result = yield* folders.createNamedProject({
          name: "Other",
          parentPath: repo,
          specweave: true,
        });
        assert.isTrue(result.existing);
        assert.equal(result.specweaveError, "SpecWeave setup is not available on this machine.");
      }),
    { git: noGitDriver },
  ),
);

// A failed create says why, as a typed reason the client words for its machine.
const createFailure = (input: { readonly name: string; readonly parentPath?: string }) =>
  Effect.gen(function* () {
    const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
    const failure = yield* Effect.flip(folders.createNamedProject(input));
    return {
      failure,
      wire: ManagedProjectFolders.projectCreateFailureOf(failure).projectCreateFailure,
    };
  });

const previewFor = (input: { readonly name: string; readonly parentPath: string }) =>
  Effect.gen(function* () {
    const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
    return yield* folders.previewNamedProject(input);
  });

it.effect("says the parent folder is missing, naming it", () =>
  withScratch(({ baseDir }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const parentPath = path.join(baseDir, "gone");
      const { failure, wire } = yield* createFailure({ name: "Example", parentPath });
      assert.deepEqual(wire, { reason: "parent_missing", folder: parentPath });
      assert.equal(failure.message, `The folder '${parentPath}' does not exist on this machine.`);
    }),
  ),
);

it.effect("says the server may not write in the parent folder", () =>
  withScratch(({ baseDir }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // Root may write anywhere, so there is no refusal to see.
      if (process.getuid?.() === 0) return;
      const parentPath = path.join(baseDir, "locked");
      yield* fs.makeDirectory(parentPath);
      yield* fs.chmod(parentPath, 0o555);
      const { failure, wire } = yield* createFailure({ name: "Example", parentPath }).pipe(
        Effect.ensuring(fs.chmod(parentPath, 0o755).pipe(Effect.ignore)),
      );
      assert.deepEqual(wire, { reason: "permission_denied", folder: parentPath });
      assert.equal(
        failure.message,
        `This machine does not allow making a folder in '${parentPath}'.`,
      );
    }),
  ),
);

it.effect("says Git is not installed when it cannot start, and leaves no folder", () =>
  withScratch(
    ({ baseDir }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parentPath = path.join(baseDir, "parent");
        yield* fs.makeDirectory(parentPath);
        const { failure, wire } = yield* createFailure({ name: "Example", parentPath });
        assert.deepEqual(wire, {
          reason: "git_missing",
          folder: path.join(parentPath, "example"),
        });
        assert.include(failure.message, "Git is not installed on this machine");
        assert.deepEqual(yield* fs.readDirectory(parentPath), []);
      }),
    {
      git: Layer.mock(GitVcsDriver.GitVcsDriver)({
        readConfigValue: () => Effect.succeed(null),
        execute: (input) =>
          Effect.fail(
            new GitCommandError({
              operation: input.operation,
              command: "git",
              cwd: input.cwd,
              detail: GIT_SPAWN_FAILURE_DETAIL,
            }),
          ),
      }),
    },
  ),
);

it.effect("passes git's own message through when git init fails", () =>
  withScratch(
    ({ baseDir }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parentPath = path.join(baseDir, "parent");
        yield* fs.makeDirectory(parentPath);
        const { failure, wire } = yield* createFailure({ name: "Example", parentPath });
        const folder = path.join(parentPath, "example");
        assert.deepEqual(wire, {
          reason: "git_init_failed",
          folder,
          detail: "fatal: invalid initial branch name: 'bad..name'",
        });
        assert.equal(
          failure.message,
          `git init failed in '${folder}': fatal: invalid initial branch name: 'bad..name'`,
        );
        assert.deepEqual(yield* fs.readDirectory(parentPath), []);
      }),
    {
      git: Layer.mock(GitVcsDriver.GitVcsDriver)({
        readConfigValue: () => Effect.succeed(null),
        execute: () =>
          Effect.succeed({
            exitCode: ChildProcessSpawner.ExitCode(128),
            stdout: "",
            stderr: "\nfatal: invalid initial branch name: 'bad..name'\n",
            stdoutTruncated: false,
            stderrTruncated: false,
          }),
      }),
    },
  ),
);

it.effect("says every folder name was taken after 100 tries", () =>
  withScratch(({ baseDir }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parentPath = path.join(baseDir, "full");
      yield* fs.makeDirectory(path.join(parentPath, "example"), { recursive: true });
      for (let attempt = 2; attempt <= 100; attempt++) {
        yield* fs.makeDirectory(path.join(parentPath, `example-${attempt}`));
      }
      const { failure, wire } = yield* createFailure({ name: "Example", parentPath });
      assert.deepEqual(wire, { reason: "name_exhausted", folder: parentPath, detail: "example" });
      assert.include(failure.message, `Every folder name for "example" in '${parentPath}'`);
    }),
  ),
);

it.effect("refuses denied parents with New folder's words, links to them included", () =>
  withScratch(({ baseDir }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      yield* fs.makeDirectory(config.stateDir, { recursive: true });
      for (const parentPath of [path.join(homedir(), ".ssh"), config.stateDir]) {
        const { failure, wire } = yield* createFailure({ name: "Example", parentPath });
        assert.deepEqual(wire, { reason: "refused", folder: parentPath });
        assert.equal(failure.message, `SpecWithCode does not make folders in '${parentPath}'.`);
        // The picker's footer agrees: no "Creates" for a parent the create refuses.
        assert.isTrue(Option.isNone(yield* previewFor({ name: "Example", parentPath })));
      }
      // A link to the state folder is refused by where it leads.
      const link = path.join(baseDir, "shortcut");
      yield* fs.symlink(config.stateDir, link);
      const { wire } = yield* createFailure({ name: "Example", parentPath: link });
      assert.deepEqual(wire, { reason: "refused", folder: link });
      assert.isTrue(Option.isNone(yield* previewFor({ name: "Example", parentPath: link })));
      assert.isFalse(yield* fs.exists(path.join(config.stateDir, "example")));
    }),
  ),
);

// The picker's "Creates" or "Uses" comes from the same rules the create runs.
it.effect("previews what the create does, and the create agrees", () =>
  withScratch(({ baseDir }) =>
    withGitEnv(
      TEST_IDENTITY,
      Effect.gen(function* () {
        const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = (name: string) => path.join(baseDir, name);
        // A worktree or submodule holds a .git file, not a folder.
        yield* fs.makeDirectory(parent("worktree"));
        yield* fs.writeFileString(path.join(parent("worktree"), ".git"), "gitdir: /elsewhere\n");
        // A child named like the project that already uses SpecWeave.
        yield* fs.makeDirectory(path.join(parent("specweave"), "example", ".specweave"), {
          recursive: true,
        });
        // The child sorts past the first 200 folders a listing marks.
        yield* fs.makeDirectory(parent("crowded"));
        for (let index = 0; index < 205; index++) {
          yield* fs.makeDirectory(
            path.join(parent("crowded"), `a${String(index).padStart(3, "0")}`),
          );
        }
        yield* fs.makeDirectory(path.join(parent("crowded"), "example", ".git"), {
          recursive: true,
        });
        // A plain folder of the project's name: the new one is numbered.
        yield* fs.makeDirectory(path.join(parent("taken"), "example"), { recursive: true });
        yield* fs.makeDirectory(parent("empty"));

        const cases = [
          ["worktree", { kind: "uses", path: parent("worktree"), because: "repository" }],
          [
            "specweave",
            { kind: "uses", path: path.join(parent("specweave"), "example"), because: "specweave" },
          ],
          [
            "crowded",
            { kind: "uses", path: path.join(parent("crowded"), "example"), because: "repository" },
          ],
          [
            "taken",
            {
              kind: "creates",
              path: path.join(parent("taken"), "example-2"),
              because: "name_taken",
            },
          ],
          ["empty", { kind: "creates", path: path.join(parent("empty"), "example") }],
        ] as const;
        for (const [folder, expected] of cases) {
          const preview = yield* folders.previewNamedProject({
            name: "Example",
            parentPath: parent(folder),
          });
          assert.deepEqual(Option.getOrNull(preview), expected);
          const created = yield* folders.createNamedProject({
            name: "Example",
            parentPath: parent(folder),
          });
          assert.equal(created.workspaceRoot, expected.path);
          assert.equal(created.existing === true, expected.kind === "uses");
        }
        assert.isTrue(
          Option.isNone(
            yield* folders.previewNamedProject({ name: "Example", parentPath: parent("missing") }),
          ),
        );
      }),
    ),
  ),
);
