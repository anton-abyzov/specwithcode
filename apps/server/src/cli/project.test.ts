import * as OtelEnvironment from "@specweave-studio/shared/otelEnvironment";
import { DEFAULT_SIGNAL_EXPORT } from "@specweave-studio/shared/observability";
// @effect-diagnostics nodeBuiltinImport:off - CLI integration uses temporary Node paths.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentInternalError,
  EnvironmentRequestInvalidError,
  EventId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AppThread,
  type ProjectFolderCheck,
  ProjectId,
} from "@specweave-studio/contracts";
import * as NetService from "@specweave-studio/shared/Net";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as References from "effect/References";
import * as Stream from "effect/Stream";
import { Command } from "effect/cli";

import { cli } from "../binCli.ts";
import * as ServerConfig from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as StudioProjectFileLoader from "../project/StudioProjectFileLoader.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import {
  formatFolderCheck,
  ProjectLiveServerDeclaredResponseError,
  ProjectLiveServerRequestError,
  ProjectMoveRefusedError,
  ProjectRemoveConfirmationError,
  projectCommandErrorFromLiveServerRequest,
} from "./project.ts";

const layerCliRuntime = Layer.mergeAll(NodeServices.layer, NetService.layer);
const runCli = (args: ReadonlyArray<string>) =>
  Command.runWith(cli, { version: "0.0.0" })(args).pipe(Effect.provide(layerCliRuntime));

const makeConfig = (baseDir: string) =>
  Effect.gen(function* () {
    const derivedPaths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
    return {
      logLevel: "Info",
      traceMinLevel: "Info",
      traceTimingEnabled: true,
      traceBatchWindowMs: 200,
      traceMaxBytes: 10 * 1024 * 1024,
      traceMaxFiles: 10,
      otelEnvironment: OtelEnvironment.none,
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
      otlpLogsUrl: undefined,
      otlpTracesExport: DEFAULT_SIGNAL_EXPORT,
      otlpMetricsExport: DEFAULT_SIGNAL_EXPORT,
      otlpLogsExport: DEFAULT_SIGNAL_EXPORT,
      mode: "web",
      port: 0,
      host: "127.0.0.1",
      cwd: process.cwd(),
      baseDir,
      ...derivedPaths,
      staticDir: undefined,
      devUrl: undefined,
      devAllowedOrigins: [],
      noBrowser: true,
      startupPresentation: "browser",
      desktopBootstrapToken: undefined,
      autoBootstrapProjectFromCwd: false,
      logWebSocketEvents: false,
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
    } satisfies ServerConfig.ServerConfig["Service"];
  });

const readProjects = (baseDir: string) =>
  Effect.gen(function* () {
    const config = yield* makeConfig(baseDir);
    const layer = RuntimeLayer.layerProjectService.pipe(
      Layer.provideMerge(ProjectEnrichmentService.layer),
      Layer.provideMerge(RepositoryIdentityResolver.layer),
      Layer.provideMerge(ProjectFaviconResolver.layer),
      Layer.provideMerge(StudioProjectFileLoader.layer),
      Layer.provideMerge(WorkspacePaths.layer),
      Layer.provideMerge(SqlitePersistence.layerConfig),
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(ServerConfig.layer(config)),
      Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
    );
    return yield* ProjectService.ProjectService.pipe(
      Effect.flatMap((projects) => projects.snapshot),
      Effect.provide(layer),
    );
  });

it("maps declared server failures into structural project command errors", () => {
  const cause = new EnvironmentInternalError({
    code: "internal_error",
    reason: "access_token_issuance_failed",
    traceId: "trace-123",
  });

  const error = projectCommandErrorFromLiveServerRequest(cause);

  assert.instanceOf(error, ProjectLiveServerDeclaredResponseError);
  assert.strictEqual(error.operation, "callLiveServer");
  assert.strictEqual(error.code, "internal_error");
  assert.strictEqual(error.traceId, "trace-123");
  assert.strictEqual(error.message, "Server request failed (internal_error, trace trace-123).");
  assert.strictEqual(error.cause, cause);
});

it("keeps the server's reason when it refuses a folder change", () => {
  const error = projectCommandErrorFromLiveServerRequest(
    new EnvironmentRequestInvalidError({
      code: "invalid_request",
      reason: "project_folder_change_refused",
      traceId: "trace-9",
      detail: "Stop the running work first.",
    }),
  );
  assert.strictEqual(
    error.message,
    "Stop the running work first. (invalid_request, trace trace-9)",
  );
});

it("preserves unexpected server failures without deriving the message from them", () => {
  const cause = new Error("credential abc123 was rejected");

  const error = projectCommandErrorFromLiveServerRequest(cause);

  assert.instanceOf(error, ProjectLiveServerRequestError);
  assert.strictEqual(error.operation, "callLiveServer");
  assert.strictEqual(error.message, "Failed to call the running server.");
  assert.strictEqual(error.cause, cause);
});

it.effect("adds, renames, and removes projects through the V2 project CLI domain", () =>
  Effect.gen(function* () {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-v2-project-cli-"));
    const workspaceRoot = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "studio-v2-project-workspace-"),
    );

    yield* runCli(["project", "add", workspaceRoot, "--title", "Alpha", "--base-dir", baseDir]);
    const added = (yield* readProjects(baseDir)).projects[0];
    assert.equal(added?.title, "Alpha");
    assert.equal(added?.workspaceRoot, workspaceRoot);

    yield* runCli(["project", "rename", workspaceRoot, "Beta", "--base-dir", baseDir]);
    assert.equal((yield* readProjects(baseDir)).projects[0]?.title, "Beta");

    // A script that names only the project removes nothing.
    const unconfirmed = yield* runCli([
      "project",
      "remove",
      added?.id ?? "",
      "--base-dir",
      baseDir,
    ]).pipe(Effect.flip);
    assert.instanceOf(unconfirmed, ProjectRemoveConfirmationError);
    assert.strictEqual(
      unconfirmed.message,
      'Nothing was removed. Removing a project deletes its threads, memory, plans and routines. Confirm with --confirm "Beta".',
    );
    const mistyped = yield* runCli([
      "project",
      "remove",
      added?.id ?? "",
      "--confirm",
      "Alpha",
      "--base-dir",
      baseDir,
    ]).pipe(Effect.flip);
    assert.strictEqual(
      mistyped.message,
      'Nothing was removed: "Alpha" is not the project\'s title. Confirm with --confirm "Beta".',
    );
    assert.equal((yield* readProjects(baseDir)).projects.length, 1);

    yield* runCli([
      "project",
      "remove",
      added?.id ?? "",
      "--confirm",
      "Beta",
      "--base-dir",
      baseDir,
    ]);
    assert.deepEqual((yield* readProjects(baseDir)).projects, []);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("archives and restores a project, keeping it and its folder", () =>
  Effect.gen(function* () {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-v2-project-cli-"));
    const workspaceRoot = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "studio-v2-project-workspace-"),
    );
    yield* runCli(["project", "add", workspaceRoot, "--title", "Samples", "--base-dir", baseDir]);
    const added = (yield* readProjects(baseDir)).projects[0];
    assert.isDefined(added);

    yield* runCli(["project", "archive", added!.id, "--base-dir", baseDir]);
    const archived = (yield* readProjects(baseDir)).projects;
    assert.equal(archived.length, 1);
    assert.equal(archived[0]?.id, added!.id);
    assert.isNull(archived[0]?.deletedAt);
    assert.isTrue(archived[0]?.workspaceSettings?.archived);
    const archivedRevision = archived[0]?.workspaceSettings?.revision ?? -1;

    // A second archive changes nothing, so the revision stays put.
    yield* runCli(["project", "archive", workspaceRoot, "--base-dir", baseDir]);
    assert.equal(
      (yield* readProjects(baseDir)).projects[0]?.workspaceSettings?.revision,
      archivedRevision,
    );

    yield* runCli(["project", "unarchive", workspaceRoot, "--base-dir", baseDir]);
    const restored = (yield* readProjects(baseDir)).projects[0];
    assert.isFalse(restored?.workspaceSettings?.archived);
    assert.equal(restored?.workspaceSettings?.revision, archivedRevision + 1);
    assert.isTrue(NodeFS.existsSync(workspaceRoot));
  }).pipe(Effect.provide(NodeServices.layer)),
);

const makeProjectLookupFixture = Effect.fn("ProjectCliTest.makeProjectLookupFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "studio-v2-project-lookup-" });
  const baseDir = NodePath.join(root, "state");
  const workspaceRoot = NodePath.join(root, "workspace");
  yield* fs.makeDirectory(workspaceRoot);
  yield* runCli(["project", "add", workspaceRoot, "--base-dir", baseDir]);
  const project = (yield* readProjects(baseDir)).projects[0];
  assert.isDefined(project);
  return { baseDir, workspaceRoot, project: project! };
});

const makeThreadPersistenceLayer = Effect.fn("ProjectCliTest.makeThreadPersistenceLayer")(
  function* (baseDir: string) {
    const config = yield* makeConfig(baseDir);
    return Layer.mergeAll(
      RuntimeLayer.layerEventSink,
      ProjectionStore.layer,
      EventStore.layer,
    ).pipe(
      Layer.provideMerge(SqlitePersistence.layerConfig),
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(ServerConfig.layer(config)),
      Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
    );
  },
);

const seedNativeThreads = Effect.fn("ProjectCliTest.seedNativeThreads")(function* (
  baseDir: string,
  threads: ReadonlyArray<{
    readonly id: ThreadId;
    readonly projectId: ProjectId;
    readonly archived: boolean;
  }>,
) {
  const layer = yield* makeThreadPersistenceLayer(baseDir);
  const createdAt = DateTime.makeUnsafe("2026-09-04T12:00:00.000Z");
  const providerInstanceId = ProviderInstanceId.make("codex");
  yield* Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    yield* eventSink.write({
      commandId: CommandId.make("project-cli-seed-threads"),
      events: threads.map(({ id, projectId, archived }) => {
        const payload: OrchestrationV2AppThread = {
          createdBy: "user",
          creationSource: "web",
          id,
          projectId,
          title: id,
          providerInstanceId,
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
          forkedFrom: null,
          createdAt,
          updatedAt: createdAt,
          archivedAt: archived ? createdAt : null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        };
        return {
          id: EventId.make(`project-cli-create-${id}`),
          type: "thread.created" as const,
          threadId: id,
          providerInstanceId,
          occurredAt: createdAt,
          payload,
        };
      }),
    });
  }).pipe(Effect.provide(layer));
});

const readNativeThreadState = Effect.fn("ProjectCliTest.readNativeThreadState")(function* (
  baseDir: string,
  threadId: ThreadId,
) {
  const layer = yield* makeThreadPersistenceLayer(baseDir);
  return yield* Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const events = yield* EventStore.EventStoreV2;
    return {
      thread: yield* projections.getThread(threadId),
      events: yield* events.read({ threadId }).pipe(Stream.runCollect),
    };
  }).pipe(Effect.provide(layer));
});

it.layer(NodeServices.layer)("project deletion with native V2 threads", (it) => {
  it.effect.each([
    { label: "an active thread", archived: false, missing: false },
    { label: "an archived thread", archived: true, missing: false },
    {
      label: "an active thread after its workspace disappears",
      archived: false,
      missing: true,
    },
    {
      label: "an archived thread after its workspace disappears",
      archived: true,
      missing: true,
    },
  ])("rejects unforced removal of a project with $label", ({ archived, missing }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { baseDir, workspaceRoot, project } = yield* makeProjectLookupFixture();
      const threadId = ThreadId.make("project-cli-preserved-thread");
      yield* seedNativeThreads(baseDir, [{ id: threadId, projectId: project.id, archived }]);
      const before = yield* readNativeThreadState(baseDir, threadId);
      if (missing) yield* fs.rename(workspaceRoot, `${workspaceRoot}-removed`);

      const error = yield* runCli([
        "project",
        "remove",
        missing ? workspaceRoot : project.id,
        "--confirm",
        project.title,
        "--base-dir",
        baseDir,
      ]).pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: () => assert.fail("Removing a nonempty project must require --force."),
        }),
      );

      assert.include(error.message, "still has threads");
      assert.deepEqual(
        (yield* readProjects(baseDir)).projects.map((entry) => entry.id),
        [project.id],
      );
      assert.deepEqual(yield* readNativeThreadState(baseDir, threadId), before);
      assert.equal(yield* fs.exists(workspaceRoot), !missing);
    }),
  );

  it.effect.each(["present", "missing"] as const)(
    "force-removes active and archived V2 threads with the workspace %s, preserving unrelated projects",
    (workspace) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { baseDir, workspaceRoot, project } = yield* makeProjectLookupFixture();
        const otherWorkspace = `${workspaceRoot}-other`;
        yield* fs.makeDirectory(otherWorkspace);
        yield* runCli(["project", "add", otherWorkspace, "--base-dir", baseDir]);
        const otherProject = (yield* readProjects(baseDir)).projects.find(
          (entry) => entry.workspaceRoot === otherWorkspace,
        );
        assert.isDefined(otherProject);
        const activeId = ThreadId.make("project-cli-deleted-active");
        const archivedId = ThreadId.make("project-cli-deleted-archived");
        const unrelatedId = ThreadId.make("project-cli-unrelated-thread");
        yield* seedNativeThreads(baseDir, [
          { id: activeId, projectId: project.id, archived: false },
          { id: archivedId, projectId: project.id, archived: true },
          { id: unrelatedId, projectId: otherProject!.id, archived: false },
        ]);
        const unrelatedBefore = yield* readNativeThreadState(baseDir, unrelatedId);
        if (workspace === "missing") {
          yield* fs.rename(workspaceRoot, `${workspaceRoot}-removed`);
        }

        yield* runCli([
          "project",
          "remove",
          workspace === "missing" ? workspaceRoot : project.id,
          "--force",
          "--confirm",
          project.title,
          "--base-dir",
          baseDir,
        ]);

        assert.deepEqual(
          (yield* readProjects(baseDir)).projects.map((entry) => entry.id),
          [otherProject!.id],
        );
        for (const threadId of [activeId, archivedId]) {
          const state = yield* readNativeThreadState(baseDir, threadId);
          assert.isNotNull(state.thread.deletedAt);
          assert.lengthOf(
            state.events.filter((record) => record.event.type === "thread.deleted"),
            1,
          );
        }
        assert.deepEqual(yield* readNativeThreadState(baseDir, unrelatedId), unrelatedBefore);
        assert.equal(yield* fs.exists(workspaceRoot), workspace === "present");
        assert.isTrue(yield* fs.exists(otherWorkspace));
      }),
  );
});

it.layer(NodeServices.layer)("project lookup with unavailable workspaces", (it) => {
  it.effect.each(["id", "stored path"] as const)(
    "removes an empty project by %s after its directory is gone",
    (identifier) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { baseDir, workspaceRoot, project } = yield* makeProjectLookupFixture();
        yield* fs.rename(workspaceRoot, `${workspaceRoot}-removed`);
        yield* runCli([
          "project",
          "remove",
          identifier === "id" ? project.id : workspaceRoot,
          "--confirm",
          project.title,
          "--base-dir",
          baseDir,
        ]);
        assert.deepEqual((yield* readProjects(baseDir)).projects, []);
        assert.isFalse(yield* fs.exists(workspaceRoot));
      }),
  );

  it.effect("renames by ID and stored path after the directory is gone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { baseDir, workspaceRoot, project } = yield* makeProjectLookupFixture();
      yield* fs.rename(workspaceRoot, `${workspaceRoot}-removed`);
      for (const [identifier, title] of [
        [project.id, "Renamed by ID"],
        [workspaceRoot, "Renamed by stored path"],
      ] as const) {
        yield* runCli(["project", "rename", identifier, title, "--base-dir", baseDir]);
        assert.equal((yield* readProjects(baseDir)).projects[0]?.title, title);
      }
      assert.isFalse(yield* fs.exists(workspaceRoot));
    }),
  );

  it.effect("does not resolve another environment's project ID in an empty database", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { baseDir, workspaceRoot, project } = yield* makeProjectLookupFixture();
      yield* fs.rename(workspaceRoot, `${workspaceRoot}-removed`);
      const replacementDir = yield* fs.makeTempDirectoryScoped({
        prefix: "studio-v2-project-empty-",
      });
      const error = yield* runCli([
        "project",
        "remove",
        project.id,
        "--force",
        "--base-dir",
        replacementDir,
      ]).pipe(Effect.flip);
      assert.include(error.message, "No active project found");
      assert.deepEqual(
        (yield* readProjects(baseDir)).projects.map((entry) => entry.id),
        [project.id],
      );
      assert.deepEqual((yield* readProjects(replacementDir)).projects, []);
    }),
  );

  it.effect("normalizes existing paths without conflating separately registered symlinks", () =>
    Effect.gen(function* () {
      const { baseDir, workspaceRoot, project } = yield* makeProjectLookupFixture();
      yield* runCli([
        "project",
        "rename",
        `${workspaceRoot}${NodePath.sep}.`,
        "Normalized",
        "--base-dir",
        baseDir,
      ]);
      assert.equal((yield* readProjects(baseDir)).projects[0]?.title, "Normalized");
      const aliasPath = `${workspaceRoot}-alias`;
      NodeFS.symlinkSync(workspaceRoot, aliasPath, "junction");
      const unknownAlias = yield* runCli([
        "project",
        "remove",
        aliasPath,
        "--base-dir",
        baseDir,
      ]).pipe(Effect.flip);
      assert.include(unknownAlias.message, "No active project found");
      yield* runCli(["project", "add", aliasPath, "--base-dir", baseDir]);
      const added = (yield* readProjects(baseDir)).projects;
      assert.equal(added.length, 2);
      const aliasProject = added.find((entry) => entry.workspaceRoot === aliasPath);
      assert.isDefined(aliasProject);
      assert.notEqual(aliasProject?.id, project.id);
      yield* runCli([
        "project",
        "remove",
        `${aliasPath}${NodePath.sep}.`,
        "--confirm",
        aliasProject!.title,
        "--base-dir",
        baseDir,
      ]);
      assert.deepEqual(
        (yield* readProjects(baseDir)).projects.map((entry) => entry.id),
        [project.id],
      );
      assert.isTrue(NodeFS.existsSync(workspaceRoot));
    }),
  );
});

const checkFixture: ProjectFolderCheck = {
  projectId: ProjectId.make("project:move"),
  currentRoot: "/work/site",
  targetRoot: "/work",
  unchanged: false,
  targetExists: true,
  currentRepository: "github.com/acme/site",
  targetRepository: "github.com/acme/umbrella",
  sameRepository: false,
  conflictingProject: null,
  activeThreads: [],
  threadCount: 5,
  reboundWorktreeCount: 0,
  keptInPlaceCount: 3,
  specweaveWorkspace: true,
  layout: {
    kind: "umbrella",
    rootIsRepository: true,
    repositories: ["site", "api"],
    repositoryCount: 2,
    truncated: false,
  },
  nestedProjects: [
    {
      id: ProjectId.make("project:api"),
      title: "API",
      workspaceRoot: "/work/api",
      relation: "inside",
      deleted: false,
    },
  ],
};

it("prints a folder check without changing anything", () => {
  const project = { id: checkFixture.projectId, title: "Site" };
  assert.strictEqual(
    formatFolderCheck(project, checkFixture),
    [
      "Folder check for project project:move (Site). Nothing changed.",
      "  Current folder: /work/site",
      "  New folder: /work",
      "  Repository: different: the current folder is github.com/acme/site, the new one is github.com/acme/umbrella",
      "  Threads: 5, 3 kept in place, 0 rebound to the new folder",
      "    3 threads will keep running in /work/site, which stays a checkout of its own repository. The coordinator and new threads will use /work. Threads on their own checkouts will keep them.",
      "  Layout: umbrella, 2 repositories (site, api)",
      "  Planning: unchanged",
      '  Other projects: Other projects sit inside or around /work: "API" (/work/api). They keep their own folders and threads.',
      "  Result: Needs --confirm-different-repository. /work is a checkout of github.com/acme/umbrella, and the current folder is a checkout of github.com/acme/site. Confirm that this is the right folder to use it.",
    ].join("\n"),
  );
  // With the repository confirmed, nothing else stands in the way.
  assert.include(
    formatFolderCheck(project, checkFixture, { differentRepository: true, planningImpact: false }),
    "  Result: Ready to move.",
  );
  assert.include(
    formatFolderCheck(project, {
      ...checkFixture,
      refusal: { reason: "folder_protected", detail: "/work is a protected folder." },
    }),
    "  Result: Refused: /work is a protected folder.",
  );
});

it.effect("move and its check need the running app and change nothing offline", () =>
  Effect.gen(function* () {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-v2-project-cli-"));
    const workspaceRoot = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "studio-v2-project-workspace-"),
    );
    const target = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-v2-project-target-"));
    yield* runCli(["project", "add", workspaceRoot, "--title", "Site", "--base-dir", baseDir]);
    for (const extra of [[], ["--check"]]) {
      const refused = yield* runCli([
        "project",
        "move",
        workspaceRoot,
        target,
        ...extra,
        "--base-dir",
        baseDir,
      ]).pipe(Effect.flip);
      assert.instanceOf(refused, ProjectMoveRefusedError);
      assert.include(refused.message, "Start the app first");
    }
    assert.equal((yield* readProjects(baseDir)).projects[0]?.workspaceRoot, workspaceRoot);
  }).pipe(Effect.provide(NodeServices.layer)),
);
