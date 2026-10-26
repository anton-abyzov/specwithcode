import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  type ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ProjectEnrichmentService from "./ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "./ProjectFaviconResolver.ts";
import * as ProjectService from "./ProjectService.ts";
import * as Normalizer from "./ProjectSettingsNormalizer.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

const opus = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" };
const sonnet = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-sonnet-5-5" };

const codex = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" };

const makeFixture = Effect.sync(() => {
  let settings: ServerSettings = DEFAULT_SERVER_SETTINGS;
  // Runs once, the next time the normaliser reads settings, i.e. mid-pass.
  let beforeNextSettingsRead: Effect.Effect<void> | null = null;
  const shells = new Map<ThreadId, OrchestrationV2ThreadShell>();
  const mocks = Layer.mergeAll(
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadShell: (threadId) => Effect.sync(() => shells.get(threadId) ?? null),
    }),
    Layer.mock(ServerSettingsService.ServerSettingsService)({
      getSettings: Effect.suspend(() => {
        const hook = beforeNextSettingsRead;
        beforeNextSettingsRead = null;
        return (hook ?? Effect.void).pipe(Effect.as(settings));
      }),
    }),
  );
  const layer = Layer.mergeAll(RuntimeLayer.layerProjectService, ProjectStore.layer, mocks).pipe(
    Layer.provideMerge(ProjectEnrichmentService.layer),
    Layer.provideMerge(
      Layer.succeed(WorkspacePaths.WorkspacePaths, {
        normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
        resolveRelativePathWithinRoot: ({ workspaceRoot, relativePath }) =>
          Effect.succeed({ absolutePath: `${workspaceRoot}/${relativePath}`, relativePath }),
      }),
    ),
    Layer.provideMerge(
      Layer.merge(
        Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
          resolve: () => Effect.succeed(null),
        }),
        Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
          resolvePath: () => Effect.succeed(null),
        }),
      ),
    ),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "project-settings-normalizer-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  return {
    layer,
    shells,
    setSettings: (next: ServerSettings) => {
      settings = next;
    },
    beforeNextSettingsRead: (hook: Effect.Effect<void>) => {
      beforeNextSettingsRead = hook;
    },
  };
});

const ids = {
  legacy: ProjectId.make("legacy-null-settings"),
  bound: ProjectId.make("legacy-bound-coordinator"),
  instructions: ProjectId.make("legacy-instructions-saved"),
  assistant: ProjectId.make("assistant"),
  scratch: ProjectId.make("scratch"),
  deleted: ProjectId.make("deleted"),
};
const boundThread = ThreadId.make("project-coordinator:legacy-bound-coordinator");

/**
 * The shapes found on a long-lived host: a project created before projects had
 * settings (no row at all), one whose first coordinator launch bound a thread
 * but never saved its model, one whose only save was its instructions, one with
 * a saved model, the scratch folder, and a deleted project.
 */
const seedLegacyProjects = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const create = (projectId: ProjectId, workspaceRoot: string) =>
    projects.create({
      projectId,
      commandId: CommandId.make(`create:${projectId}`),
      title: projectId,
      workspaceRoot,
    });
  yield* create(ids.legacy, "/work/legacy");
  yield* create(ids.bound, "/work/bound");
  yield* create(ids.instructions, "/work/instructions");
  yield* create(ids.assistant, "/work/assistant");
  yield* create(ids.scratch, path.resolve(config.baseDir, "scratch"));
  yield* create(ids.deleted, "/work/deleted");
  // Before 10-10 a created project had no settings row; reproduce that exactly.
  yield* sql`UPDATE projection_projects SET workspace_settings_json = NULL
    WHERE project_id IN (${ids.legacy}, ${ids.scratch}, ${ids.deleted})`;
  yield* projects.update({
    projectId: ids.bound,
    commandId: CommandId.make("bound:goal"),
    workspaceSettings: { expectedRevision: 0, goal: "Ship the release" },
  });
  yield* projects.update({
    projectId: ids.bound,
    commandId: CommandId.make("bound:bind"),
    coordinatorThreadId: boundThread,
  });
  yield* projects.update({
    projectId: ids.instructions,
    commandId: CommandId.make("instructions:save"),
    workspaceSettings: {
      expectedRevision: 0,
      instructions: "Keep answers short.",
      coordinatorModelSelection: null,
    },
  });
  yield* projects.update({
    projectId: ids.assistant,
    commandId: CommandId.make("assistant:model"),
    workspaceSettings: { expectedRevision: 0, coordinatorModelSelection: sonnet },
  });
  yield* projects.update({
    projectId: ids.assistant,
    commandId: CommandId.make("assistant:goal"),
    workspaceSettings: { expectedRevision: 1, goal: "Help at home" },
  });
  yield* projects.delete({
    projectId: ids.deleted,
    commandId: CommandId.make("deleted:delete"),
    confirmationTitle: ids.deleted,
  });
});

const readSettings = (projectId: ProjectId) =>
  Effect.gen(function* () {
    const store = yield* ProjectStore.ProjectStoreV2;
    const row = yield* store.get(projectId, { includeDeleted: true });
    return Option.getOrThrow(row).workspaceSettings ?? null;
  });

const modelOf = (projectId: ProjectId) =>
  readSettings(projectId).pipe(
    Effect.map((settings): ModelSelection | null => settings?.coordinatorModelSelection ?? null),
  );

it.effect("saves the model a legacy project names and leaves the rest to the host default", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    fixture.shells.set(boundThread, {
      ...liveThreadShell(boundThread, { activeRunId: null }),
      projectId: ids.bound,
      modelSelection: opus,
    });
    yield* Effect.gen(function* () {
      yield* seedLegacyProjects;
      assert.isNull(yield* readSettings(ids.legacy));
      const before = yield* readSettings(ids.bound);
      assert.equal(before?.revision, 2);
      assert.isNull(before?.coordinatorModelSelection);

      const first = yield* Normalizer.normalizeProjects();
      assert.deepEqual(first, {
        normalized: 1,
        unchanged: 1,
        hostDefault: 3,
        conflict: 0,
        failed: 0,
      });
      // The bound coordinator's own model is saved.
      assert.deepEqual(yield* modelOf(ids.bound), opus);
      assert.equal((yield* readSettings(ids.bound))?.revision, 3);
      // Nothing of their own names a model: no write, the host default applies live and
      // the first coordinator launch saves it.
      assert.isNull(yield* readSettings(ids.legacy));
      assert.isNull(yield* readSettings(ids.scratch));
      assert.isNull(yield* modelOf(ids.instructions));
      assert.equal((yield* readSettings(ids.instructions))?.revision, 1);
      // A saved choice and a deleted project are left alone.
      assert.deepEqual(yield* modelOf(ids.assistant), sonnet);
      assert.equal((yield* readSettings(ids.assistant))?.revision, 2);
      assert.isNull(yield* readSettings(ids.deleted));

      // A second run writes nothing.
      const again = yield* Normalizer.normalizeProjects();
      assert.deepEqual(again, {
        normalized: 0,
        unchanged: 2,
        hostDefault: 3,
        conflict: 0,
        failed: 0,
      });
      assert.equal((yield* readSettings(ids.bound))?.revision, 3);
    }).pipe(Effect.provide(fixture.layer));
  }),
);

it.effect("saves the project's own defaults with the settings a new project has", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    fixture.setSettings({
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: { [ids.legacy]: { defaultModelSelection: codex } },
    } as ServerSettings);
    yield* Effect.gen(function* () {
      yield* seedLegacyProjects;
      const projects = yield* ProjectService.ProjectService;
      yield* projects.update({
        projectId: ids.instructions,
        commandId: CommandId.make("instructions:worker"),
        defaultModelSelection: sonnet,
      });
      const summary = yield* Normalizer.normalizeProjects();
      assert.equal(summary.normalized, 2);
      // The project without settings now has exactly what a new project has, plus its model.
      assert.deepEqual(yield* readSettings(ids.legacy), {
        ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
        revision: 1,
        coordinatorModelSelection: codex,
      });
      // A project created with settings also carries the fleet identity its
      // creation assigned; normalizing keeps it untouched.
      const { logicalProject, coordinatorBinding, ...instructions } = (yield* readSettings(
        ids.instructions,
      ))!;
      assert.deepEqual(instructions, {
        ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
        instructions: "Keep answers short.",
        revision: 2,
        coordinatorModelSelection: sonnet,
      });
      assert.equal(logicalProject?.title, ids.instructions);
      assert.deepEqual(coordinatorBinding, { epoch: 0, state: "active" });
    }).pipe(Effect.provide(fixture.layer));
  }),
);

it.effect("ignores a coordinator thread that belongs to another project", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    fixture.shells.set(boundThread, {
      ...liveThreadShell(boundThread, { activeRunId: null }),
      projectId: ids.assistant,
      modelSelection: opus,
    });
    yield* Effect.gen(function* () {
      yield* seedLegacyProjects;
      const summary = yield* Normalizer.normalizeProjects();
      assert.equal(summary.normalized, 0);
      assert.isNull(yield* modelOf(ids.bound));
    }).pipe(Effect.provide(fixture.layer));
  }),
);

it.effect("keeps a save made at the same moment and settles that project next time", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    fixture.setSettings({
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: { [ids.legacy]: { defaultModelSelection: codex } },
    } as ServerSettings);
    yield* Effect.gen(function* () {
      yield* seedLegacyProjects;
      const projects = yield* ProjectService.ProjectService;
      // The person saves the goal after the pass read the project, before it writes.
      fixture.beforeNextSettingsRead(
        projects
          .update({
            projectId: ids.legacy,
            commandId: CommandId.make("legacy:user-save"),
            workspaceSettings: { expectedRevision: 0, goal: "Theirs" },
          })
          .pipe(Effect.orDie, Effect.asVoid),
      );
      const first = yield* Normalizer.normalizeProjects();
      assert.equal(first.conflict, 1);
      assert.equal(first.failed, 0);
      const kept = yield* readSettings(ids.legacy);
      assert.equal(kept?.goal, "Theirs");
      assert.isNull(kept?.coordinatorModelSelection);
      const second = yield* Normalizer.normalizeProjects();
      assert.equal(second.normalized, 1);
      const settings = yield* readSettings(ids.legacy);
      assert.equal(settings?.goal, "Theirs");
      assert.deepEqual(settings?.coordinatorModelSelection, codex);
      assert.equal(settings?.revision, 2);
    }).pipe(Effect.provide(fixture.layer));
  }),
);

const opusDescriptors = {
  optionDescriptors: [
    {
      id: "effort",
      label: "Effort",
      type: "select" as const,
      options: [
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium", isDefault: true },
      ],
    },
    { id: "thinking", label: "Thinking", type: "boolean" as const, currentValue: true },
  ],
};
const claudeProvider: ServerProvider = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-12T12:00:00.000Z",
  version: "2.1.296",
  models: [
    {
      slug: "claude-sonnet-5-5",
      name: "Claude Sonnet 5.5",
      isCustom: false,
      isDefault: true,
      capabilities: opusDescriptors,
    },
    {
      slug: "claude-opus-5-5",
      name: "Claude Opus 5.5",
      isCustom: false,
      isDefault: false,
      capabilities: opusDescriptors,
    },
  ],
  slashCommands: [],
  skills: [],
};
const opusThinking = { ...opus, options: [{ id: "thinking", value: true }] };
// The coordinator was saved from the project default (Thinking on), then given Medium effort.
const coordinatorOpus = {
  ...opus,
  options: [
    { id: "thinking", value: true },
    { id: "effort", value: "medium" },
  ],
};

const defaultOf = (projectId: ProjectId) =>
  Effect.gen(function* () {
    const store = yield* ProjectStore.ProjectStoreV2;
    return Option.getOrThrow(yield* store.get(projectId, { includeDeleted: true }))
      .defaultModelSelection;
  });

it.effect("keeps a project model saved after the startup normalizer reads its shell", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    yield* Effect.gen(function* () {
      yield* seedLegacyProjects;
      const projects = yield* ProjectService.ProjectService;
      fixture.beforeNextSettingsRead(
        projects
          .update({
            projectId: ids.legacy,
            commandId: CommandId.make("legacy:concurrent-model"),
            defaultModelSelection: codex,
          })
          .pipe(Effect.asVoid, Effect.orDie),
      );
      const summary = yield* Normalizer.normalizeProjectModelDefaults([claudeProvider]);
      assert.deepEqual(yield* defaultOf(ids.legacy), codex);
      assert.equal(summary.conflict, 1);
      assert.equal(summary.failed, 0);
      // Clearing the user's choice later must not turn a rejected automatic
      // command into a successful one when its stable receipt is replayed.
      yield* projects.update({
        projectId: ids.legacy,
        commandId: CommandId.make("legacy:clear-concurrent-model"),
        defaultModelSelection: null,
      });
      const replay = yield* Normalizer.normalizeProjectModelDefaults([claudeProvider]);
      assert.equal(replay.conflict, 1);
      assert.equal(replay.failed, 0);
      assert.isNull(yield* defaultOf(ids.legacy));
    }).pipe(Effect.provide(fixture.layer));
  }),
);

it.effect("keeps a model saved while a new project's automatic default is resolving", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const registry = Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed([claudeProvider]),
    });
    yield* Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      const projectId = ProjectId.make("concurrent-create-model");
      fixture.beforeNextSettingsRead(
        projects
          .update({
            projectId,
            commandId: CommandId.make("fresh:concurrent-model"),
            defaultModelSelection: codex,
          })
          .pipe(Effect.asVoid, Effect.orDie),
      );
      const created = yield* projects.create({
        projectId,
        commandId: CommandId.make("create:concurrent-model"),
        title: "Concurrent model",
        workspaceRoot: "/work/concurrent-model",
      });
      assert.deepEqual(created.defaultModelSelection, codex);
    }).pipe(Effect.provide(Layer.merge(fixture.layer, registry)));
  }),
);

it.effect("gives every project Opus 5.5 with Thinking on and keeps what was chosen", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    yield* Effect.gen(function* () {
      yield* seedLegacyProjects;
      const projects = yield* ProjectService.ProjectService;
      // Someone chose Sonnet as the instructions project's default model.
      yield* projects.update({
        projectId: ids.instructions,
        commandId: CommandId.make("instructions:worker"),
        defaultModelSelection: sonnet,
      });
      const summary = yield* Normalizer.normalizeProjectModelDefaults([claudeProvider]);
      // legacy, bound, assistant and scratch had none; the deleted project is skipped.
      assert.equal(summary.defaultModel, 4);
      assert.equal(summary.failed, 0);
      assert.deepEqual(yield* defaultOf(ids.legacy), opusThinking);
      assert.deepEqual(yield* defaultOf(ids.scratch), opusThinking);
      assert.deepEqual(yield* defaultOf(ids.instructions), sonnet);
      assert.isNull(yield* defaultOf(ids.deleted));
      // The assistant's saved Sonnet coordinator keeps its model and gains Thinking only:
      // Medium effort is the Opus 5.5 coordinator default.
      assert.deepEqual(yield* modelOf(ids.assistant), {
        ...sonnet,
        options: [{ id: "thinking", value: true }],
      });
      assert.equal(summary.coordinatorOptions, 1);

      // Clearing a default afterwards is a choice too: the next start keeps it.
      yield* projects.update({
        projectId: ids.legacy,
        commandId: CommandId.make("legacy:clear-default"),
        defaultModelSelection: null,
      });
      const again = yield* Normalizer.normalizeProjectModelDefaults([claudeProvider]);
      assert.deepEqual(again, { defaultModel: 0, coordinatorOptions: 0, conflict: 0, failed: 0 });
      assert.isNull(yield* defaultOf(ids.legacy));
    }).pipe(Effect.provide(fixture.layer));
  }),
);

it.effect("writes no default model without a signed-in Claude subscription", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    yield* Effect.gen(function* () {
      yield* seedLegacyProjects;
      const signedOut = { ...claudeProvider, auth: { status: "unauthenticated" as const } };
      const paid = {
        ...claudeProvider,
        auth: { status: "authenticated" as const, apiKeyBilling: true },
      };
      for (const providers of [[], [signedOut], [paid]]) {
        const summary = yield* Normalizer.normalizeProjectModelDefaults(providers);
        assert.equal(summary.defaultModel, 0);
      }
      assert.isNull(yield* defaultOf(ids.legacy));
    }).pipe(Effect.provide(fixture.layer));
  }),
);

it.effect("waits for providers, then saves Opus 5.5 as coordinator with Medium effort", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    let reads = 0;
    const checking = {
      ...claudeProvider,
      installed: false,
      version: null,
      status: "warning" as const,
      auth: { status: "unknown" as const },
    };
    const registry = Layer.mock(ProviderRegistry.ProviderRegistry)({
      // The first read still shows the pre-check placeholder.
      getProviders: Effect.sync(() => (reads++ === 0 ? [checking] : [claudeProvider])),
    });
    yield* Effect.gen(function* () {
      // Projects from before this release: created without a default model.
      yield* seedLegacyProjects;
      const fiber = yield* Normalizer.normalizeProjectModelDefaultsWhenReady("1 minute").pipe(
        Effect.provide(registry),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust("3 seconds");
      const summary = yield* Fiber.join(fiber);
      assert.isAtLeast(reads, 2);
      // Every active project: here nobody chose a default model.
      assert.equal(summary?.defaultModel, 5);
      // A project whose coordinator named nothing now runs Opus 5.5, Medium effort, Thinking on.
      assert.deepEqual(yield* defaultOf(ids.legacy), opusThinking);
      assert.deepEqual(yield* modelOf(ids.legacy), coordinatorOpus);
      assert.deepEqual(yield* modelOf(ids.scratch), coordinatorOpus);
    }).pipe(Effect.provide(fixture.layer));
  }),
);

it.effect("leaves projects alone when providers never settle", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const registry = Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed([]),
    });
    yield* Effect.gen(function* () {
      yield* seedLegacyProjects;
      const fiber = yield* Normalizer.normalizeProjectModelDefaultsWhenReady("10 seconds").pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust("11 seconds");
      assert.isNull(yield* Fiber.join(fiber));
      assert.isNull(yield* defaultOf(ids.legacy));
    }).pipe(Effect.provide(Layer.merge(fixture.layer, registry)));
  }),
);

it.effect("creates a new project on Opus 5.5 with Thinking on when Claude offers it", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const registry = Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed([claudeProvider]),
    });
    yield* Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      const fresh = ProjectId.make("fresh");
      const input = {
        projectId: fresh,
        commandId: CommandId.make("create:fresh"),
        title: "Fresh",
        workspaceRoot: "/work/fresh",
      };
      const created = yield* projects.create(input);
      assert.deepEqual(created.defaultModelSelection, opusThinking);
      // A retried create replays both receipts and changes nothing.
      const again = yield* projects.create(input);
      assert.deepEqual(again.defaultModelSelection, opusThinking);
    }).pipe(Effect.provide(Layer.merge(fixture.layer, registry)));
  }),
);

it.effect("keeps a default model chosen in Settings, for every project or for one", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const registry = Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed([claudeProvider]),
    });
    yield* Effect.gen(function* () {
      yield* seedLegacyProjects;
      // A default chosen for one project in Settings stays that project's model.
      fixture.setSettings({
        ...DEFAULT_SERVER_SETTINGS,
        projectSettingsOverrides: { [ids.legacy]: { defaultModelSelection: codex } },
      } as ServerSettings);
      const summary = yield* Normalizer.normalizeProjectModelDefaults([claudeProvider]);
      assert.deepEqual(summary, { defaultModel: 4, coordinatorOptions: 1, conflict: 0, failed: 0 });
      assert.isNull(yield* defaultOf(ids.legacy));
      assert.deepEqual(yield* defaultOf(ids.scratch), opusThinking);

      // A default chosen for every project leaves new projects on it too.
      fixture.setSettings({
        ...DEFAULT_SERVER_SETTINGS,
        defaultModelSelection: sonnet,
      } as ServerSettings);
      const projects = yield* ProjectService.ProjectService;
      const created = yield* projects
        .create({
          projectId: ProjectId.make("fresh"),
          commandId: CommandId.make("create:fresh"),
          title: "Fresh",
          workspaceRoot: "/work/fresh",
        })
        .pipe(Effect.provide(registry));
      assert.isNull(created.defaultModelSelection);
    }).pipe(Effect.provide(fixture.layer));
  }),
);
