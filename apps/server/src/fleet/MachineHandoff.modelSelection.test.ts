import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MachineHandoffError,
  type MachineHandoffBundle,
  type ModelSelection,
  ProjectId,
  ProjectWorkspaceError,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ServerSettingsError,
  ThreadId,
} from "@specweave-studio/contracts";
import { defaultWorkerModelSelection } from "@specweave-studio/shared/coordinatorDefault";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProjectCoordinatorService from "../project/ProjectCoordinatorService.ts";
import { projectDelegationTarget } from "../project/ProjectDelegation.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectWorkspaceService from "../project/ProjectWorkspaceService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as HandoffGit from "./handoffGit.ts";
import * as MachineHandoff from "./MachineHandoff.ts";
import * as MachineHandoffStore from "./MachineHandoffStore.ts";

const operationId = "22222222-2222-4222-8222-222222222222";
const destinationId = ProjectId.make("destination-project");
const isolatedId = ProjectId.make(`machine-handoff:${operationId}`);
const coordinatorId = ThreadId.make(`project-coordinator:${isolatedId}`);
const codex: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6-astra",
};
const opus: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5-5",
};
const laterChoice: ModelSelection = { ...codex, model: "gpt-6.1-sol" };
const providers: ReadonlyArray<ServerProvider> = [
  {
    instanceId: opus.instanceId,
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-13T00:00:00.000Z",
    version: "test-only",
    models: [
      {
        slug: opus.model,
        name: "Claude Opus 5.5",
        isCustom: false,
        isDefault: true,
        capabilities: null,
      },
    ],
    slashCommands: [],
    skills: [],
  },
  {
    instanceId: codex.instanceId,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-13T00:00:00.000Z",
    version: "test-only",
    models: [codex.model, laterChoice.model].map((slug) => ({
      slug,
      name: slug,
      isCustom: false,
      isDefault: slug === codex.model,
      capabilities: null,
    })),
    slashCommands: [],
    skills: [],
  },
];
const bundleContent = {
  logicalProject: {
    id: "logical:source",
    title: "Source",
    coordinatorId: "coordinator:logical:source",
    members: [
      {
        environmentId: EnvironmentId.make("source-environment"),
        projectId: ProjectId.make("source-project"),
        coordinatorThreadId: ThreadId.make("source-coordinator"),
      },
      {
        environmentId: EnvironmentId.make("destination-environment"),
        projectId: destinationId,
        coordinatorThreadId: ThreadId.make(`project-coordinator:${destinationId}`),
      },
      {
        environmentId: EnvironmentId.make("destination-environment"),
        projectId: isolatedId,
        coordinatorThreadId: coordinatorId,
      },
    ],
  },
  destination: {
    environmentId: EnvironmentId.make("destination-environment"),
    projectId: destinationId,
    logicalProjectId: "logical:destination",
    joinExistingProject: true,
  },
  coordinatorBinding: {
    epoch: 0,
    state: "transferring" as const,
    operationId,
    successor: {
      environmentId: EnvironmentId.make("destination-environment"),
      projectId: isolatedId,
      coordinatorThreadId: coordinatorId,
    },
  },
  manifest: {
    version: 1 as const,
    operationId,
    repositories: [
      {
        relativePath: ".",
        identity: "github.com/owner/repository",
        head: "a".repeat(40),
        ref: `refs/heads/codex/handoff/${operationId}/${"a".repeat(40)}`,
      },
    ],
  },
  sourceEnvironmentId: EnvironmentId.make("source-environment"),
  sourceProjectId: ProjectId.make("source-project"),
  sourceThreadId: ThreadId.make("source-coordinator"),
  createdAt: "2026-10-13T00:00:00.000Z",
  context: {
    goal: "Finish the pending change",
    instructions: "Preserve unrelated work",
    notes: [],
    threads: [
      {
        threadId: ThreadId.make("source-coordinator"),
        title: "Source coordinator",
        branch: "main",
        worktreePath: null,
        kind: "coordinator" as const,
        messages: [
          {
            id: "source-request",
            role: "user" as const,
            text: "Finish and test the pending change.",
            createdAt: "2026-10-13T00:00:00.000Z",
          },
        ],
      },
    ],
  },
};
const bundle: MachineHandoffBundle = {
  ...bundleContent,
  digest: MachineHandoff.machineHandoffDigest(bundleContent),
};
const input = { projectId: destinationId, operationId, bundle, mode: "start" as const };

// Projects, project commands, event receipts, projections, admission and SQLite
// migrations are real. Only external catalogs, Git and provider execution are
// boundaries: no live provider or repository is accessed by this fixture.
const projectLayer = Layer.mergeAll(
  RuntimeLayer.layerProjectService,
  RuntimeLayer.layerEventSink,
  ProjectStore.layer,
  ProjectionStore.layer,
  ProjectWorkspaceService.layer.pipe(Layer.provide(ProjectStore.layer)),
).pipe(
  Layer.provideMerge(ProjectEnrichmentService.layer),
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.succeed(WorkspacePaths.WorkspacePaths, {
        normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
        resolveRelativePathWithinRoot: ({ workspaceRoot, relativePath }) =>
          Effect.succeed({ absolutePath: `${workspaceRoot}/${relativePath}`, relativePath }),
      }),
      Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
        resolve: () => Effect.succeed(null),
      }),
      Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
        resolvePath: () => Effect.succeed(null),
      }),
    ),
  ),
);
const fixtureLayer = Layer.mergeAll(
  projectLayer,
  MachineHandoffStore.layer,
  ServerSettings.layerTest({ projectSettingsFolded: true, defaultModelSelection: null }),
  Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed(providers) }),
  Layer.succeed(ServerEnvironment.ServerEnvironment, {
    getEnvironmentId: Effect.succeed(EnvironmentId.make("destination-environment")),
    getDescriptor: Effect.die("The regression must not discover a live environment"),
  }),
).pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "handoff-model-regression-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const fixture = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const destinationRoot = path.join(config.baseDir, "destination");
  const isolatedRoot = path.join(config.baseDir, "isolated");
  yield* fs.makeDirectory(destinationRoot);
  yield* fs.makeDirectory(isolatedRoot);
  const created = yield* projects.create({
    commandId: CommandId.make("test:create-destination"),
    projectId: destinationId,
    initialLogicalProject: {
      id: "logical:destination",
      title: "Destination",
      coordinatorId: "coordinator:destination",
      members: [],
    },
    title: "Destination",
    workspaceRoot: destinationRoot,
  });
  // Prove the host really exercises the competing automatic-Claude path.
  assert.deepEqual(created.defaultModelSelection, opus);
  yield* projects.update({
    commandId: CommandId.make("test:explicit-destination-worker"),
    projectId: destinationId,
    defaultModelSelection: codex,
    workspaceSettings: { expectedRevision: 0, coordinatorModelSelection: opus },
  });
  const state = {
    sends: 0,
    failLaunch: false,
    selections: [] as Array<ReturnType<typeof projectDelegationTarget>>,
  };
  const coordinator = ProjectCoordinatorService.ProjectCoordinatorService.of({
    start: () => Effect.die("Machine handoff must call send"),
    nextTurnModel: () => Effect.succeed(undefined),
    send: (request) =>
      Effect.gen(function* () {
        state.sends++;
        // Match ensure's ordinary, durable coordinator reservation without
        // launching a provider. Resolution reads the real persisted project.
        yield* projects.update({
          commandId: CommandId.make(`test:bind:${request.projectId}`),
          projectId: request.projectId,
          coordinatorThreadId: coordinatorId,
        });
        const isolated = Option.getOrThrow(yield* projects.getById(request.projectId));
        state.selections.push(
          projectDelegationTarget(
            isolated,
            coordinatorId,
            undefined,
            defaultWorkerModelSelection(providers),
          ),
        );
        if (state.failLaunch)
          return yield* new ProjectWorkspaceError({
            projectId: request.projectId,
            code: "operation_failed",
          });
        return { threadId: coordinatorId, created: true };
      }).pipe(
        Effect.mapError(
          () =>
            new ProjectWorkspaceError({
              projectId: request.projectId,
              code: "operation_failed",
            }),
        ),
      ),
  });
  const git = HandoffGit.HandoffGit.of({
    inspect: () => Effect.die("Destination receive must not inspect the source"),
    publish: () => Effect.die("Destination receive must not publish the source"),
    verifyWorkerCheckpoints: () =>
      Effect.die("Destination receive must not inspect source workers"),
    preflight: () => Effect.void,
    materialize: () =>
      Effect.succeed({
        operationId,
        workspaceRoot: isolatedRoot,
        repositories: [],
        manifestSha256: "b".repeat(64),
      }),
  });
  const receive = (
    store?: MachineHandoffStore.MachineHandoffStore["Service"],
    settings?: ServerSettings.ServerSettingsService["Service"],
  ) => {
    let run = Effect.gen(function* () {
      return yield* (yield* MachineHandoff.MachineHandoff).receive(input);
    }).pipe(
      Effect.provide(Layer.fresh(MachineHandoff.layer)),
      Effect.provideService(ProjectCoordinatorService.ProjectCoordinatorService, coordinator),
      Effect.provideService(HandoffGit.HandoffGit, git),
    );
    if (settings)
      run = run.pipe(Effect.provideService(ServerSettings.ServerSettingsService, settings));
    return store
      ? run.pipe(Effect.provideService(MachineHandoffStore.MachineHandoffStore, store))
      : run;
  };
  const selectLater = () =>
    projects.update({
      commandId: CommandId.make("test:later-human-choice"),
      projectId: isolatedId,
      defaultModelSelection: laterChoice,
    });
  const read = () => projects.getById(isolatedId).pipe(Effect.map(Option.getOrThrow));
  return { projects, state, receive, selectLater, read };
});

it.effect(
  "preserves the explicit destination worker model through real project creation and omitted-target delegation",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.receive();
      const isolated = yield* f.read();
      assert.deepEqual(isolated.workspaceSettings?.coordinatorModelSelection, opus);
      assert.deepEqual(
        Option.getOrThrow(yield* f.projects.getById(destinationId)).defaultModelSelection,
        codex,
      );
      assert.deepEqual(f.state.selections[0], {
        providerInstanceId: codex.instanceId,
        model: codex.model,
      });
      assert.deepEqual(isolated.defaultModelSelection, codex);
    }).pipe(Effect.provide(fixtureLayer)),
);

for (const choice of [laterChoice, null])
  it.effect(
    `keeps a later worker ${choice === null ? "clear" : "choice"} after settings fail before the policy commit`,
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const settings = yield* ServerSettings.ServerSettingsService;
        let failSettings = true;
        const interrupted = ServerSettings.ServerSettingsService.of({
          ...settings,
          updateSettings: (patch) => {
            // A new project's finish-action seed is best effort and must not use up
            // the one failure meant for the handoff's own settings write.
            const seedsFinishActionOnly =
              Object.keys(patch).length === 1 &&
              patch.projectSettingsOverrides !== undefined &&
              Object.values(patch.projectSettingsOverrides).every(
                (entry) => entry != null && "threadFinishAction" in entry,
              );
            if (failSettings && !seedsFinishActionOnly) {
              failSettings = false;
              return Effect.fail(
                new ServerSettingsError({
                  settingsPath: "test-only-settings",
                  operation: "write-file",
                }),
              );
            }
            return settings.updateSettings(patch);
          },
        });
        assert.equal(
          (yield* Effect.flip(f.receive(undefined, interrupted))).code,
          "storage_failed",
        );
        assert.equal(f.state.sends, 0);
        const before = yield* f.read();
        const events = yield* EventSink.EventSinkV2;
        assert.equal(
          (yield* events
            .readByCommandId({
              commandId: CommandId.make(`machine-handoff-policy:${operationId}`),
            })
            .pipe(Stream.runCollect)).length,
          0,
        );
        // Match a UI save: worker selection and revision-checked workspace policy
        // are updated together, rather than a worker-only fixture shortcut.
        yield* f.projects.update({
          commandId: CommandId.make("test:later-ui-choice"),
          projectId: isolatedId,
          defaultModelSelection: choice,
          workspaceSettings: {
            expectedRevision: before.workspaceSettings?.revision ?? 0,
            coordinatorModelSelection: opus,
          },
        });
        yield* f.receive(undefined, interrupted);
        assert.deepEqual((yield* f.read()).defaultModelSelection, choice);
        const expected = choice ?? defaultWorkerModelSelection(providers);
        assert.isNotNull(expected);
        assert.deepEqual(f.state.selections[0], {
          providerInstanceId: expected!.instanceId,
          model: expected!.model,
        });
        assert.equal(f.state.sends, 1);
      }).pipe(Effect.provide(fixtureLayer)),
  );

it.effect("keeps a later explicit worker choice when replaying a completed handoff", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.receive();
    yield* f.selectLater();
    assert.isTrue((yield* f.receive()).replayed);
    assert.deepEqual((yield* f.read()).defaultModelSelection, laterChoice);
    assert.equal(f.state.sends, 1);
  }).pipe(Effect.provide(fixtureLayer)),
);

it.effect("keeps a later explicit worker choice after a configured launch failure", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.state.failLaunch = true;
    assert.equal((yield* Effect.flip(f.receive())).code, "launch_failed");
    yield* f.selectLater();
    f.state.failLaunch = false;
    yield* f.receive();
    assert.deepEqual((yield* f.read()).defaultModelSelection, laterChoice);
    assert.deepEqual(f.state.selections.at(-1), {
      providerInstanceId: laterChoice.instanceId,
      model: laterChoice.model,
    });
    assert.equal(f.state.sends, 2);
  }).pipe(Effect.provide(fixtureLayer)),
);

it.effect(
  "replays the committed policy without overwriting a later choice after a lost configuration write",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const store = yield* MachineHandoffStore.MachineHandoffStore;
      let failConfiguration = true;
      const interrupted = MachineHandoffStore.MachineHandoffStore.of({
        ...store,
        write: (key, value) => {
          if (
            failConfiguration &&
            key === `destination-${operationId}` &&
            typeof value === "object" &&
            value !== null &&
            "configured" in value &&
            value.configured === true
          ) {
            failConfiguration = false;
            return Effect.fail(new MachineHandoffError({ code: "storage_failed" }));
          }
          return store.write(key, value);
        },
      });
      assert.equal((yield* Effect.flip(f.receive(interrupted))).code, "storage_failed");
      assert.equal(f.state.sends, 0);
      yield* f.selectLater();
      yield* f.receive(interrupted);
      assert.deepEqual((yield* f.read()).defaultModelSelection, laterChoice);
      assert.deepEqual(f.state.selections[0], {
        providerInstanceId: laterChoice.instanceId,
        model: laterChoice.model,
      });
      assert.equal(f.state.sends, 1);
    }).pipe(Effect.provide(fixtureLayer)),
);
