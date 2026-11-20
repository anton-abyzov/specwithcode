import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  FIRST_FEATURE_SAMPLE,
  ProjectId,
  type ProjectWorkspacePatch,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";

import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as FirstFeatureSample from "./firstFeatureSample.ts";
import * as ManagedProjectFolders from "./ManagedProjectFolders.ts";
import * as ProjectEnrichmentService from "./ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "./ProjectFaviconResolver.ts";
import * as ProjectService from "./ProjectService.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

const NOW = "2026-11-18T20:00:00.000Z";

describe("firstFeatureSampleName", () => {
  it("is First feature, numbered when taken in any case", () => {
    assert.equal(FirstFeatureSample.firstFeatureSampleName([]), "First feature");
    assert.equal(FirstFeatureSample.firstFeatureSampleName(["Pinball"]), "First feature");
    assert.equal(
      FirstFeatureSample.firstFeatureSampleName(["first FEATURE ", "First feature 3"]),
      "First feature 2",
    );
    assert.equal(
      FirstFeatureSample.firstFeatureSampleName(["First feature", "First feature 2"]),
      "First feature 3",
    );
  });
});

const candidate = (
  id: string,
  settings: { sample?: string; firstFeatureGuide?: { started?: string; ended?: string } },
  deletedAt: string | null = null,
) => ({
  id: ProjectId.make(id),
  workspaceRoot: `/projects/${id}`,
  deletedAt,
  workspaceSettings: { ...DEFAULT_PROJECT_WORKSPACE_SETTINGS, ...settings },
});

describe("activeFirstFeatureSample", () => {
  it("is the live sample whose guide has not ended, newest start first", () => {
    const projects = [
      candidate("plain", {}),
      candidate("left", { sample: "first-feature", firstFeatureGuide: { ended: "left" } }),
      candidate("finished", {
        sample: "first-feature",
        firstFeatureGuide: { started: NOW, ended: "finished" },
      }),
      candidate("removed", { sample: "first-feature", firstFeatureGuide: { started: NOW } }, NOW),
      candidate("older", {
        sample: "first-feature",
        firstFeatureGuide: { started: "2026-11-17T10:00:00.000Z" },
      }),
      candidate("newer", { sample: "first-feature", firstFeatureGuide: { started: NOW } }),
      candidate("other-sample", { sample: "something-else", firstFeatureGuide: { started: NOW } }),
    ];
    assert.equal(FirstFeatureSample.activeFirstFeatureSample(projects)?.id, "newer");
    assert.isUndefined(FirstFeatureSample.activeFirstFeatureSample(projects.slice(0, 4)));
  });

  it("counts an end this version does not know as no end", () => {
    const unknownEnd = candidate("x", {
      sample: "first-feature",
      firstFeatureGuide: { ended: "paused" },
    });
    assert.equal(FirstFeatureSample.activeFirstFeatureSample([unknownEnd])?.id, "x");
  });
});

describe("firstFeatureGuideFinishedIn", () => {
  it("is true for a finished sample, removed or not, and for nothing else", () => {
    const finished = { sample: "first-feature", firstFeatureGuide: { ended: "finished" } };
    const finishedIn = FirstFeatureSample.firstFeatureGuideFinishedIn;
    assert.isTrue(finishedIn([candidate("removed", finished, NOW)]));
    assert.isTrue(finishedIn([candidate("plain", {}), candidate("live", finished)]));
    assert.isFalse(
      finishedIn([
        candidate("left", { sample: "first-feature", firstFeatureGuide: { ended: "left" } }),
        candidate("running", { sample: "first-feature", firstFeatureGuide: { started: NOW } }),
        candidate("not-a-sample", { firstFeatureGuide: { ended: "finished" } }),
        candidate("unknown-end", { sample: "first-feature", firstFeatureGuide: { ended: "x" } }),
      ]),
    );
    assert.isFalse(finishedIn([]));
  });
});

describe("firstFeatureGuideAfterMark", () => {
  const after = FirstFeatureSample.firstFeatureGuideAfterMark;
  it("ends the guide as left or finished and keeps its start", () => {
    assert.deepEqual(after({ started: NOW }, "left", "later"), { started: NOW, ended: "left" });
    assert.deepEqual(after({ started: NOW }, "finished", "later"), {
      started: NOW,
      ended: "finished",
    });
    assert.deepEqual(after(undefined, "left", "later"), { ended: "left" });
  });

  it("starts a left guide again with a new start and no end", () => {
    assert.deepEqual(after({ started: NOW, ended: "left" }, "started", "later"), {
      started: "later",
    });
    assert.deepEqual(after(undefined, "started", "later"), { started: "later" });
  });

  it("changes nothing when a running guide is started again", () => {
    assert.deepEqual(after({ started: NOW }, "started", "later"), { started: NOW });
  });

  it("keeps a finished guide finished", () => {
    const finished = { started: NOW, ended: "finished" };
    assert.deepEqual(after(finished, "started", "later"), finished);
    assert.deepEqual(after(finished, "left", "later"), finished);
  });
});

describe("firstFeatureSampleFiles", () => {
  it("holds one page, its stylesheet, a node --test package, one test and a README", () => {
    const files = FirstFeatureSample.firstFeatureSampleFiles("First <feature> 2");
    assert.deepEqual(
      files.map((file) => file.path),
      ["README.md", "index.html", "style.css", "package.json", "page.test.js"],
    );
    const pkg = JSON.parse(files.find((file) => file.path === "package.json")!.contents);
    assert.equal(pkg.scripts.test, "node --test");
    const page = files.find((file) => file.path === "index.html")!.contents;
    assert.include(page, "<h1>First &lt;feature&gt; 2</h1>");
    assert.include(page, '<link rel="stylesheet" href="style.css">');
  });
});

// The service over a real ProjectService, real git and in-memory settings.
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

const layer = (baseDir: string) =>
  ManagedProjectFolders.layer.pipe(
    Layer.provideMerge(RuntimeLayer.layerProjectService),
    Layer.provideMerge(layerEnrichment),
    Layer.provideMerge(WorkspacePaths.layer),
    Layer.provideMerge(layerGitWorkflow),
    Layer.provideMerge(GitVcsDriver.layer.pipe(Layer.provide(VcsProcess.layer))),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(ServerConfig.layerTest(baseDir, baseDir)),
    Layer.provideMerge(NodeServices.layer),
  );

const GIT_ENV_KEYS = [
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "EMAIL",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
] as const;

/** A data dir in a fresh temp folder, a Git identity of its own and no global Git config. */
const withSample = <A, E>(
  body: (input: {
    readonly baseDir: string;
  }) => Effect.Effect<
    A,
    E,
    | ManagedProjectFolders.ManagedProjectFolders
    | ProjectService.ProjectService
    | ServerSettings.ServerSettingsService
    | NodeServices.NodeServices
    | Scope.Scope
  >,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "studio-first-feature-" });
    const emptyConfig = yield* fileSystem.makeTempFileScoped({ prefix: "studio-gitconfig-" });
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const saved = GIT_ENV_KEYS.map((key) => [key, process.env[key]] as const);
        for (const key of GIT_ENV_KEYS) delete process.env[key];
        Object.assign(process.env, {
          GIT_CONFIG_GLOBAL: emptyConfig,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_AUTHOR_NAME: "Test",
          GIT_AUTHOR_EMAIL: "test@test.com",
          GIT_COMMITTER_NAME: "Test",
          GIT_COMMITTER_EMAIL: "test@test.com",
        });
        return saved;
      }),
      () =>
        body({ baseDir }).pipe(
          Effect.provide(Layer.merge(ServerSettings.layerTest(), layer(baseDir))),
        ),
      (saved) =>
        Effect.sync(() => {
          for (const [key, value] of saved) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
          }
        }),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const run = (cwd: string, command: string, args: ReadonlyArray<string>) =>
  ProcessRunner.ProcessRunner.pipe(
    Effect.flatMap((runner) => runner.run({ command, args, cwd, timeout: "60 seconds" })),
    Effect.provide(ProcessRunner.layer),
  );

const autoReviewOverride = (projectId: ProjectId) =>
  ServerSettings.ServerSettingsService.pipe(
    Effect.flatMap((settings) => settings.getSettings),
    Effect.map(
      (settings) =>
        settings.projectSettingsOverrides[projectId]?.adversarialReview?.autoOnFeatureComplete,
    ),
  );

it.effect(
  "makes the sample as a committed repository with SpecWeave and its own review off",
  () =>
    withSample(({ baseDir }) =>
      Effect.gen(function* () {
        const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
        const projects = yield* ProjectService.ProjectService;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        // The name sent is ignored and `specweave` cannot turn SpecWeave on for the sample.
        const created = yield* folders.createNamedProject({
          name: "Anything",
          specweave: true,
          sample: "first-feature",
        });
        assert.equal(created.workspaceRoot, path.resolve(baseDir, "projects", "first-feature"));
        assert.isUndefined(created.commitError);
        assert.isUndefined(created.existing);
        assert.isUndefined(created.specweaveError);
        assert.isFalse(yield* fileSystem.exists(path.join(created.workspaceRoot, ".specweave")));

        const project = Option.getOrThrow(yield* projects.getById(created.projectId));
        assert.equal(project.title, "First feature");
        assert.equal(project.workspaceSettings?.sample, FIRST_FEATURE_SAMPLE);
        assert.isString(project.workspaceSettings?.firstFeatureGuide?.started);
        assert.isUndefined(project.workspaceSettings?.firstFeatureGuide?.ended);

        const committed = (yield* run(created.workspaceRoot, "git", [
          "ls-tree",
          "-r",
          "--name-only",
          "HEAD",
        ])).stdout
          .trim()
          .split("\n")
          .toSorted();
        assert.deepEqual(committed, [
          "README.md",
          "assets/icon.svg",
          "index.html",
          "package.json",
          "page.test.js",
          "style.css",
        ]);
        const log = yield* run(created.workspaceRoot, "git", ["log", "--format=%s"]);
        assert.equal(log.stdout.trim(), "Initial commit");
        const status = yield* run(created.workspaceRoot, "git", ["status", "--porcelain"]);
        assert.equal(status.stdout.trim(), "");

        // The test passes as made, with nothing to install.
        const test = yield* run(created.workspaceRoot, process.execPath, ["--test"]);
        assert.equal(test.code, 0, test.stdout + test.stderr);
        assert.match(test.stdout, /# pass 1/);

        assert.isFalse(yield* autoReviewOverride(created.projectId));
      }),
    ),
  60_000,
);

it.effect(
  "keeps one sample per machine until its guide ends, then numbers the next",
  () =>
    withSample(({ baseDir }) =>
      Effect.gen(function* () {
        const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
        const projects = yield* ProjectService.ProjectService;
        const path = yield* Path.Path;

        const first = yield* folders.createNamedProject({
          name: "First feature",
          sample: "first-feature",
        });
        // Renaming it changes nothing: it is still the sample.
        yield* projects.update({
          commandId: CommandId.make("rename-sample"),
          projectId: first.projectId,
          title: "My page",
        });
        const again = yield* folders.createNamedProject({
          name: "First feature",
          sample: "first-feature",
        });
        assert.deepEqual(again, {
          projectId: first.projectId,
          workspaceRoot: first.workspaceRoot,
          existing: true,
        });

        const left = yield* FirstFeatureSample.markFirstFeatureGuide(
          projects,
          { projectId: first.projectId, mark: "left" },
          NOW,
        );
        assert.deepEqual(
          "firstFeatureGuide" in left ? left.firstFeatureGuide.ended : left.refused,
          "left",
        );
        // An ordinary project named like the sample takes the plain name.
        yield* folders.createNamedProject({ name: "First feature" });
        const next = yield* folders.createNamedProject({
          name: "First feature",
          sample: "first-feature",
        });
        assert.notEqual(next.projectId, first.projectId);
        const project = Option.getOrThrow(yield* projects.getById(next.projectId));
        assert.equal(project.title, "First feature 2");
        assert.notEqual(next.workspaceRoot, first.workspaceRoot);
        assert.equal(path.dirname(next.workspaceRoot), path.resolve(baseDir, "projects"));
      }),
    ),
  60_000,
);

it.effect(
  "never takes a removed sample's folder back, and removing drops its review override",
  () =>
    withSample(() =>
      Effect.gen(function* () {
        const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
        const projects = yield* ProjectService.ProjectService;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parentPath = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "studio-first-feature-parent-",
        });

        const first = yield* folders.createNamedProject({
          name: "First feature",
          parentPath,
          sample: "first-feature",
        });
        assert.equal(first.workspaceRoot, path.join(parentPath, "first-feature"));
        assert.isFalse(yield* autoReviewOverride(first.projectId));
        yield* projects.delete({
          commandId: CommandId.make("remove-sample"),
          projectId: first.projectId,
        });
        // The folder stays on disk; the override goes.
        assert.isTrue(yield* fileSystem.exists(path.join(first.workspaceRoot, ".git")));
        assert.isUndefined(yield* autoReviewOverride(first.projectId));

        const next = yield* folders.createNamedProject({
          name: "First feature",
          parentPath,
          sample: "first-feature",
        });
        assert.isUndefined(next.existing);
        assert.equal(next.workspaceRoot, path.join(parentPath, "first-feature-2"));
        const project = Option.getOrThrow(yield* projects.getById(next.projectId));
        assert.equal(project.title, "First feature");
      }),
    ),
  60_000,
);

it.effect("removing an ordinary project leaves its review override alone", () =>
  withSample(() =>
    Effect.gen(function* () {
      const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
      const projects = yield* ProjectService.ProjectService;
      const settings = yield* ServerSettings.ServerSettingsService;
      const plain = yield* folders.createNamedProject({ name: "Plain" });
      yield* settings.updateSettings({
        projectSettingsOverrideChanges: {
          [plain.projectId]: { set: { adversarialReview: { autoOnFeatureComplete: true } } },
        },
      });
      yield* projects.delete({
        commandId: CommandId.make("remove-plain"),
        projectId: plain.projectId,
      });
      assert.isTrue(yield* autoReviewOverride(plain.projectId));
    }),
  ),
);

it.effect("no settings patch can set or clear the sample or its guide", () =>
  withSample(() =>
    Effect.gen(function* () {
      const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
      const projects = yield* ProjectService.ProjectService;
      const plain = yield* folders.createNamedProject({ name: "Plain" });
      const sample = yield* folders.createNamedProject({
        name: "First feature",
        sample: "first-feature",
      });
      const forge = (projectId: ProjectId, label: string) =>
        Effect.gen(function* () {
          const current = Option.getOrThrow(yield* projects.getById(projectId));
          // Forged extras, as an internal caller that skips wire decoding could send them.
          const patch = {
            expectedRevision: current.workspaceSettings?.revision ?? 0,
            goal: `Forged ${label}`,
            sample: "first-feature",
            firstFeatureGuide: { ended: "finished" },
          } as unknown as ProjectWorkspacePatch;
          yield* projects.update({
            commandId: CommandId.make(`forge-${label}`),
            projectId,
            workspaceSettings: patch,
          });
          return Option.getOrThrow(yield* projects.getById(projectId));
        });
      const forgedPlain = yield* forge(plain.projectId, "plain");
      assert.equal(forgedPlain.workspaceSettings?.goal, "Forged plain");
      assert.isUndefined(forgedPlain.workspaceSettings?.sample);
      assert.isUndefined(forgedPlain.workspaceSettings?.firstFeatureGuide);

      const forgedSample = yield* forge(sample.projectId, "sample");
      assert.equal(forgedSample.workspaceSettings?.sample, FIRST_FEATURE_SAMPLE);
      assert.isUndefined(forgedSample.workspaceSettings?.firstFeatureGuide?.ended);
    }),
  ),
);

it.effect("records guide marks on the sample only", () =>
  withSample(() =>
    Effect.gen(function* () {
      const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
      const projects = yield* ProjectService.ProjectService;
      const plain = yield* folders.createNamedProject({ name: "Plain" });
      const sample = yield* folders.createNamedProject({
        name: "First feature",
        sample: "first-feature",
      });
      const mark = (projectId: ProjectId, mark: "started" | "left" | "finished", now = NOW) =>
        FirstFeatureSample.markFirstFeatureGuide(projects, { projectId, mark }, now);

      assert.deepEqual(yield* mark(plain.projectId, "left"), { refused: "not_sample" });
      assert.deepEqual(yield* mark(ProjectId.make("missing"), "left"), { refused: "not_found" });

      const started = Option.getOrThrow(yield* projects.getById(sample.projectId)).workspaceSettings
        ?.firstFeatureGuide?.started;
      assert.isString(started);
      assert.deepEqual(yield* mark(sample.projectId, "left"), {
        firstFeatureGuide: { started: started!, ended: "left" },
      });
      assert.deepEqual(yield* mark(sample.projectId, "started", "2026-11-19T09:00:00.000Z"), {
        firstFeatureGuide: { started: "2026-11-19T09:00:00.000Z" },
      });
      yield* mark(sample.projectId, "finished");
      const revision = Option.getOrThrow(yield* projects.getById(sample.projectId))
        .workspaceSettings?.revision;
      // A finished guide stays finished, and a mark that changes nothing writes nothing.
      assert.deepEqual(yield* mark(sample.projectId, "started", "2026-11-20T09:00:00.000Z"), {
        firstFeatureGuide: { started: "2026-11-19T09:00:00.000Z", ended: "finished" },
      });
      const stored = Option.getOrThrow(yield* projects.getById(sample.projectId));
      assert.equal(stored.workspaceSettings?.revision, revision);
      assert.deepEqual(stored.workspaceSettings?.firstFeatureGuide, {
        started: "2026-11-19T09:00:00.000Z",
        ended: "finished",
      });
    }),
  ),
);

it.effect(
  "two sample creates at once make one sample",
  () =>
    withSample(() =>
      Effect.gen(function* () {
        const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
        const projects = yield* ProjectService.ProjectService;
        const [left, right] = yield* Effect.all(
          [0, 1].map(() =>
            folders.createNamedProject({ name: "First feature", sample: "first-feature" }),
          ),
          { concurrency: "unbounded" },
        );
        assert.equal(left!.projectId, right!.projectId);
        assert.equal([left!.existing, right!.existing].filter(Boolean).length, 1);
        const samples = (yield* projects.snapshot).projects.filter(
          FirstFeatureSample.isFirstFeatureSample,
        );
        assert.equal(samples.length, 1);
      }),
    ),
  60_000,
);

it.effect("racing marks never reopen a finished guide", () =>
  withSample(() =>
    Effect.gen(function* () {
      const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
      const projects = yield* ProjectService.ProjectService;
      const sample = yield* folders.createNamedProject({
        name: "First feature",
        sample: "first-feature",
      });
      // A stale window marks left and started while another device finishes the guide.
      yield* Effect.all(
        (["left", "finished", "started", "left"] as const).map((mark, index) =>
          FirstFeatureSample.markFirstFeatureGuide(
            projects,
            { projectId: sample.projectId, mark },
            `2026-11-19T09:00:0${index}.000Z`,
          ),
        ),
        { concurrency: "unbounded" },
      );
      const stored = Option.getOrThrow(yield* projects.getById(sample.projectId));
      assert.equal(stored.workspaceSettings?.firstFeatureGuide?.ended, "finished");
    }),
  ),
);

it.effect("the guide RPC says a missing project and a project that is not the sample", () =>
  withSample(() =>
    Effect.gen(function* () {
      const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
      const projects = yield* ProjectService.ProjectService;
      const plain = yield* folders.createNamedProject({ name: "Plain" });
      const sample = yield* folders.createNamedProject({
        name: "First feature",
        sample: "first-feature",
      });
      const call = (projectId: ProjectId) =>
        FirstFeatureSample.firstFeatureGuideRpc(projects, { projectId, mark: "left" }, NOW);
      const notSample = yield* Effect.flip(call(plain.projectId));
      assert.equal(notSample._tag, "ProjectWorkspaceError");
      assert.equal(notSample.code, "invalid");
      assert.equal((yield* Effect.flip(call(ProjectId.make("missing")))).code, "not_found");
      assert.equal((yield* call(sample.projectId)).firstFeatureGuide.ended, "left");
    }),
  ),
);

it.effect("refuses a personal sample", () =>
  withSample(() =>
    Effect.gen(function* () {
      const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
      const projects = yield* ProjectService.ProjectService;
      const refused = yield* Effect.flip(
        folders.createNamedProject({ name: "Percy", kind: "personal", sample: "first-feature" }),
      );
      assert.equal(refused._tag, "NamedProjectFolderError");
      assert.equal((yield* projects.snapshot).projects.length, 0);

      const made = yield* folders.createNamedProject({
        name: "First feature",
        sample: "first-feature",
      });
      assert.isUndefined(made.sampleAutoReviewError);
    }),
  ),
);

it.effect("says when the sample's review could not be turned off", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("sample");
    // No settings service on this host.
    assert.equal(
      yield* FirstFeatureSample.turnOffSampleAutoReview(projectId),
      FirstFeatureSample.SAMPLE_AUTO_REVIEW_ERROR,
    );
    // A settings store that cannot write.
    const failing = Layer.effect(
      ServerSettings.ServerSettingsService,
      ServerSettings.ServerSettingsService.pipe(
        Effect.map((real) => ({ ...real, updateSettings: () => Effect.die("disk full") })),
      ),
    ).pipe(Layer.provide(ServerSettings.layerTest()));
    assert.equal(
      yield* FirstFeatureSample.turnOffSampleAutoReview(projectId).pipe(Effect.provide(failing)),
      FirstFeatureSample.SAMPLE_AUTO_REVIEW_ERROR,
    );
    assert.isUndefined(
      yield* FirstFeatureSample.turnOffSampleAutoReview(projectId).pipe(
        Effect.provide(ServerSettings.layerTest()),
      ),
    );
  }),
);
