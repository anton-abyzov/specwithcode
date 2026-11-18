import { expect, it } from "@effect/vitest";
import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type ServerProvider,
} from "@specweave-studio/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ServerConfig from "../../../config.ts";
import * as ProjectActionRequests from "../../../project/ProjectActionRequests.ts";
import * as Project from "../../../project/ProjectService.ts";
import { projectFixture } from "../../../project/ProjectWorkspace.testkit.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ProjectHandlers from "./handlers.ts";
import { ProjectToolkit } from "./tools.ts";

it.effect("an agent cannot replace a project's saved models, only ask the user", () =>
  Effect.gen(function* () {
    const sourceThreadId = ThreadId.make("worker-thread");
    const projectId = ProjectId.make("project");
    const emptyProjectId = ProjectId.make("new-project");
    const overriddenProjectId = ProjectId.make("settings-project");
    const noModelProjectId = ProjectId.make("no-model-project");
    const tracksProjectId = ProjectId.make("tracks-project");
    const providerInstanceId = ProviderInstanceId.make("claudeAgent");
    const caller = {
      id: sourceThreadId,
      projectId,
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "claude-opus-5-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      activeRunId: "active-run",
      archivedAt: null,
      deletedAt: null,
    } as OrchestrationV2ThreadShell;
    // What the person saved: Fable 5.2 with Ultracode for threads, Opus 5.5 for the coordinator.
    const threadsModel = {
      instanceId: providerInstanceId,
      model: "claude-fable-5-2",
      options: [
        { id: "contextWindow", value: "1m" },
        { id: "effort", value: "high" },
        { id: "ultracode", value: true },
        { id: "thinking", value: true },
      ],
    };
    const coordinatorModel = {
      instanceId: providerInstanceId,
      model: "claude-opus-5-5",
      options: [
        { id: "effort", value: "medium" },
        { id: "thinking", value: true },
      ],
    };
    const opus = {
      instanceId: providerInstanceId,
      model: "claude-opus-5-5",
      options: [
        { id: "effort", value: "high" },
        { id: "thinking", value: true },
      ],
    };
    const saved = projectFixture(projectId, {
      title: "specweave",
      defaultModelSelection: threadsModel,
      workspaceSettings: {
        ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
        revision: 45,
        coordinatorModelSelection: coordinatorModel,
      },
    });
    // This machine's model list, as the approval service checks the selection against it.
    const catalog = [
      {
        instanceId: providerInstanceId,
        displayName: "Claude Code",
        models: [{ slug: "claude-opus-5-5", name: "Claude Opus 5.5", isCustom: false }],
      },
    ] as unknown as ReadonlyArray<ServerProvider>;
    const updates: Array<Project.ProjectUpdateInput> = [];
    const creates: Array<Project.ProjectCreateInput> = [];
    const requested: Array<ProjectActionRequests.ProjectActionRequestInput> = [];
    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        requestNamespace: "session",
        thread: { threadId: sourceThreadId, providerSessionId: "session", providerInstanceId },
        client: undefined,
        issuedAt: 0,
        capabilities: new Set(["orchestration" as const]),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(caller),
      }),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
      Layer.mock(Project.ProjectService)({
        getById: (id) => Effect.succeed(Option.some(id === projectId ? saved : projectFixture(id))),
        update: (input) => {
          updates.push(input);
          return Effect.succeed(projectFixture(input.projectId));
        },
        create: (input) => {
          creates.push(input);
          return Effect.succeed(projectFixture(input.projectId));
        },
      }),
      // Project settings (Settings scoped to a project) hold a thread model too: one
      // project has Fable saved there, another has "no model" saved there.
      ServerSettings.layerTest({
        projectSettingsOverrides: {
          [overriddenProjectId]: { defaultModelSelection: threadsModel },
          [noModelProjectId]: { defaultModelSelection: null },
          [tracksProjectId]: { threadModelMode: "tracks" },
        },
      }),
      Layer.mock(ProjectActionRequests.ProjectActionRequests)({
        request: (input) => {
          requested.push(input);
          return Effect.succeed({ requestId: RuntimeRequestId.make("project-action:1") });
        },
      }),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
      Layer.mock(GitVcsDriver.GitVcsDriver)({}),
      Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed(catalog) }),
      NodeServices.layer,
      ServerConfig.layerTest(process.cwd(), { prefix: "studio-project-model-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    );
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
          Layer.provide(layerDependencies),
        ),
      ),
    );
    const update = (input: Record<string, unknown>) =>
      toolkit
        .handle("studio_project_update", input as never)
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies), Effect.exit);

    // The write that reset the saved Fable 5.2 + Ultracode choice: refused, nothing saved.
    const threads = yield* update({ projectId, defaultModelSelection: opus });
    expect(JSON.stringify(threads)).toContain("studio_project_request with action change_model");
    expect(JSON.stringify(threads)).toContain("The model new threads start on");
    const coordinator = yield* update({
      projectId,
      workspaceSettings: {
        expectedRevision: 45,
        coordinatorModelSelection: { instanceId: providerInstanceId, model: "claude-fable-5-2" },
      },
    });
    expect(JSON.stringify(coordinator)).toContain("change_model");
    expect(JSON.stringify(coordinator)).toContain("The coordinator model");
    // Dropping one option, or clearing the model, replaces the person's choice too.
    const withoutUltracode = yield* update({
      projectId,
      defaultModelSelection: {
        ...threadsModel,
        options: threadsModel.options.filter((option) => option.id !== "ultracode"),
      },
    });
    expect(JSON.stringify(withoutUltracode)).toContain("change_model");
    const cleared = yield* update({ projectId, defaultModelSelection: null });
    expect(JSON.stringify(cleared)).toContain("change_model");
    // A model change is refused even beside a field an agent may set.
    const mixed = yield* update({
      projectId,
      defaultModelSelection: opus,
      workspaceSettings: { expectedRevision: 45, goal: "Ship." },
    });
    expect(JSON.stringify(mixed)).toContain("change_model");
    expect(updates).toHaveLength(0);

    // The same models again (in any option order), other fields, and a first model all save.
    yield* update({
      projectId,
      defaultModelSelection: { ...threadsModel, options: threadsModel.options.toReversed() },
      workspaceSettings: { expectedRevision: 45, coordinatorModelSelection: coordinatorModel },
    });
    yield* update({ projectId, workspaceSettings: { expectedRevision: 45, goal: "Ship." } });
    yield* update({
      projectId: emptyProjectId,
      defaultModelSelection: opus,
      workspaceSettings: { expectedRevision: 0, coordinatorModelSelection: coordinatorModel },
    });
    expect(updates.map((entry) => entry.projectId)).toEqual([projectId, projectId, emptyProjectId]);

    // A model saved in Project settings outranks the project's own (empty) field, and a
    // write to the field would remove it: refused the same way, "no model" included.
    for (const id of [overriddenProjectId, noModelProjectId]) {
      const overridden = yield* update({ projectId: id, defaultModelSelection: opus });
      expect(JSON.stringify(overridden), id).toContain(
        "studio_project_request with action change_model",
      );
    }
    yield* update({ projectId: overriddenProjectId, defaultModelSelection: threadsModel });
    // On Tracks no single model applies, so there is none to set and no card to ask with.
    const onTracks = yield* update({ projectId: tracksProjectId, defaultModelSelection: opus });
    expect(JSON.stringify(onTracks)).toContain("start from its model tracks");
    expect(JSON.stringify(onTracks)).not.toContain("change_model");
    // A first model names each option once: a repeated one would save an unclear choice.
    const repeated = yield* update({
      projectId: emptyProjectId,
      defaultModelSelection: {
        ...opus,
        options: [
          { id: "effort", value: "high" },
          { id: "effort", value: "medium" },
        ],
      },
    });
    expect(JSON.stringify(repeated)).toContain("effort is repeated");
    expect(updates.map((entry) => entry.projectId)).toEqual([
      projectId,
      projectId,
      emptyProjectId,
      overriddenProjectId,
    ]);
    updates.length = 3;

    // A project registered with a model starts on it: saved with the creation, so
    // nothing is seeded over it and no update (which would now be refused) is needed.
    yield* toolkit
      .handle("studio_project_create", {
        title: "Widgets",
        workspaceRoot: process.cwd(),
        defaultModelSelection: opus,
      } as never)
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies));
    expect(creates).toHaveLength(1);
    expect(creates[0]?.initialWorkerModelSelection).toEqual(opus);
    const titleOnly = yield* toolkit
      .handle("studio_project_create", { title: "Gadgets", defaultModelSelection: opus } as never)
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies), Effect.exit);
    expect(JSON.stringify(titleOnly)).toContain("workspaceRoot and defaultModelSelection");
    expect(creates).toHaveLength(1);

    // The way to change it: the request reaches the approval service with the exact selection.
    const asked = yield* toolkit
      .handle("studio_project_request", {
        action: "change_model",
        role: "threads",
        modelSelection: opus,
        reason: "Opus 5.5 is the main model for regular work.",
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies));
    expect(asked.at(-1)?.result).toMatchObject({ status: "awaiting_user" });
    expect(requested).toEqual([
      {
        threadId: sourceThreadId,
        projectId,
        action: "change_model",
        modelRole: "threads",
        modelSelection: opus,
        providers: catalog,
        reason: "Opus 5.5 is the main model for regular work.",
      },
    ]);
    expect(updates).toHaveLength(3);
  }),
);
