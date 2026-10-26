// @effect-diagnostics nodeBuiltinImport:off - Increment fixtures and a temporary HOME on disk.
import * as Ref from "effect/Ref";
import { applyServerSettingsPatch } from "@specweave-studio/shared/serverSettings";
import { projectFixture } from "../../../project/ProjectWorkspace.testkit.ts";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type Project as ProjectRecord,
  type ServerProvider,
  type TaskRoutingSettings,
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_TASK_ROUTING_SETTINGS,
} from "@specweave-studio/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ServerConfig from "../../../config.ts";
import * as ProjectActionRequests from "../../../project/ProjectActionRequests.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../../vcs/VcsProcess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ProjectHandlers from "./handlers.ts";
import { ProjectToolkit } from "./tools.ts";

it.effect("attributes a launched thread's first message to the calling thread", () =>
  Effect.gen(function* () {
    const sourceThreadId = ThreadId.make("source-thread");
    const projectId = ProjectId.make("project");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const modelSelection = { instanceId: providerInstanceId, model: "gpt-5" };
    const caller = {
      id: sourceThreadId,
      projectId,
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      activeRunId: "active-run",
      archivedAt: null,
      deletedAt: null,
    } as OrchestrationV2ThreadShell;
    let launchedSender: ThreadId | undefined;
    let personalProjectId: ProjectId | undefined;
    let launchCount = 0;
    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        requestNamespace: "session",
        thread: {
          threadId: sourceThreadId,
          providerSessionId: "session",
          providerInstanceId,
        },
        client: undefined,
        issuedAt: 0,
        capabilities: new Set(["orchestration" as const]),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(caller),
      }),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({
        launch: (input) => {
          launchCount += 1;
          launchedSender = input.initialMessage?.senderThreadId;
          return Effect.succeed({
            threadId: input.threadId,
            projection: {
              thread: { id: input.threadId, projectId, modelSelection },
              runs: [],
            },
            resumed: false,
          } as unknown as ThreadLaunch.ThreadLaunchResult);
        },
      }),
      Layer.mock(Project.ProjectService)({
        getById: (id) =>
          Effect.succeed(
            Option.some({
              ...projectFixture(id),
              workspaceSettings: {
                ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
                kind: id === personalProjectId ? "personal" : "code",
              },
            }),
          ),
      }),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
      Layer.mock(GitVcsDriver.GitVcsDriver)({}),
      Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
      NodeServices.layer,
      ServerConfig.layerTest(process.cwd(), { prefix: "studio-source-link-" }).pipe(
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
    const result = yield* toolkit
      .handle("studio_thread_launch", { title: "Audit", message: "Review the change" })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies));
    const launchedResult = result.at(-1)?.result as { threadId: string; threadLink: string };
    expect(launchedResult).toMatchObject({ projectId, modelSelection });
    // A ready-made link the coordinator copies verbatim: decoding the ID once gives it back.
    expect(launchedResult.threadLink).toBe(
      `[Audit](studio://thread/${encodeURIComponent(launchedResult.threadId)})`,
    );
    expect(launchedSender).toBe(sourceThreadId);
    const foreignId = ProjectId.make("foreign-project");
    for (const personalId of [projectId, foreignId]) {
      personalProjectId = personalId;
      const refused = yield* toolkit
        .handle("studio_thread_launch", {
          projectId: foreignId,
          title: "Unrequested work",
          message: "Push a project report",
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies));
      expect(refused.at(-1)?.result).toMatchObject({ code: "capability_denied" });
    }
    expect(launchCount).toBe(1);
  }),
);

it.effect("binds a launched thread to the increment it names, and refuses a bad one", () =>
  Effect.gen(function* () {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "launch-increment-root-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
    );
    const folder = NodePath.join(root, ".specweave/increments/0996-connect");
    NodeFS.mkdirSync(folder, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(folder, "spec.md"), "# Connect\n");
    NodeFS.writeFileSync(
      NodePath.join(root, ".specweave/config.json"),
      JSON.stringify({ planning: { requireIncrement: "enforce" } }),
    );
    const specPath = NodePath.join(folder, "spec.md");
    const sourceThreadId = ThreadId.make("coordinator-thread");
    const projectId = ProjectId.make("project");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const modelSelection = { instanceId: providerInstanceId, model: "gpt-5" };
    const caller = {
      id: sourceThreadId,
      projectId,
      title: "Coordinator",
      branch: null,
      worktreePath: null,
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      activeRunId: "active-run",
      archivedAt: null,
      deletedAt: null,
    } as unknown as OrchestrationV2ThreadShell;
    const launched: ThreadLaunch.ThreadLaunchInput[] = [];
    let callerWorktree: string | null = null;
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
        getThreadShell: () => Effect.succeed({ ...caller, worktreePath: callerWorktree }),
      }),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({
        launch: (input) => {
          launched.push(input);
          return Effect.succeed({
            threadId: input.threadId,
            projection: { thread: { id: input.threadId, projectId, modelSelection }, runs: [] },
            resumed: false,
          } as unknown as ThreadLaunch.ThreadLaunchResult);
        },
      }),
      Layer.mock(Project.ProjectService)({
        getById: (id) =>
          Effect.succeed(
            Option.some(
              projectFixture(id, {
                workspaceRoot: root,
                workspaceSettings: {
                  ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
                  coordinatorThreadId: sourceThreadId,
                },
              }),
            ),
          ),
      }),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
      Layer.mock(GitVcsDriver.GitVcsDriver)({}),
      Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
      NodeServices.layer,
      ServerConfig.layerTest(process.cwd(), { prefix: "studio-launch-increment-" }).pipe(
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
    const handle = (params: Parameters<typeof toolkit.handle<"studio_thread_launch">>[1]) =>
      toolkit
        .handle("studio_thread_launch", params)
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies));
    const base = { title: "Connect", message: "Wire it up", modelSelection } as const;

    // Under enforce the coordinator names an increment; a bad one launches nothing.
    const missing = yield* handle(base);
    expect(missing.at(-1)?.result).toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining("requires an increment for each worker"),
    });
    const bad = yield* handle({ ...base, increment: "0999" });
    expect(bad.at(-1)?.result).toMatchObject({ code: "invalid_request" });
    expect(launched).toHaveLength(0);

    const result = yield* handle({ ...base, increment: "0996" });
    expect(result.at(-1)?.result).toMatchObject({
      increment: { incrementId: "0996-connect", title: "Connect", specPath },
    });
    expect(launched[0]?.increment).toEqual({ root, incrementId: "0996-connect" });
    expect(launched[0]?.initialMessage?.text).toBe(
      `Wire it up\n\nIncrement 0996-connect ([spec](${specPath})): run \`specweave pickup 0996-connect\` first.`,
    );

    // "new" seeds nothing and asks the worker to plan first.
    yield* handle({ ...base, increment: "new" });
    expect(launched[1]?.increment).toBeUndefined();
    expect(launched[1]?.initialMessage?.text).toContain('`specweave create-increment "Connect"`');

    // An increment only on the caller's branch resolves in its worktree for a new worktree.
    const callerTree = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "launch-increment-tree-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(callerTree, { recursive: true, force: true })),
    );
    NodeFS.mkdirSync(NodePath.join(callerTree, ".specweave/increments/1001-feature"), {
      recursive: true,
    });
    const onBranch = { ...base, increment: "1001" } as const;
    const newWorktree = { type: "worktree", baseRef: "feat/x" } as const;
    const unseen = yield* handle({ ...onBranch, workspaceStrategy: newWorktree });
    expect(unseen.at(-1)?.result).toMatchObject({ code: "invalid_request" });
    callerWorktree = callerTree;
    const fromBranch = yield* handle({ ...onBranch, workspaceStrategy: newWorktree });
    expect(fromBranch.at(-1)?.result).toMatchObject({
      increment: { incrementId: "1001-feature" },
      warning: expect.stringContaining("only if its base branch does"),
    });
    expect(launched[2]?.increment).toEqual({ root: callerTree, incrementId: "1001-feature" });
    // A thread in the project root does not look there.
    const inRoot = yield* handle(onBranch);
    expect(inRoot.at(-1)?.result).toMatchObject({ code: "invalid_request" });
    expect(launched).toHaveLength(3);
  }).pipe(Effect.scoped),
);

it.effect("a coordinator's launch falls back to the host's worker model like delegate_task", () =>
  Effect.gen(function* () {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "launch-host-default-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
    );
    const sourceThreadId = ThreadId.make("coordinator-thread");
    const projectId = ProjectId.make("project");
    const claude = ProviderInstanceId.make("claude");
    const coordinatorModel = { instanceId: claude, model: "claude-opus" };
    const ready = {
      instanceId: claude,
      driver: "claudeAgent",
      enabled: true,
      installed: true,
      status: "ready",
      auth: { status: "authenticated" },
      models: [
        { slug: "claude-opus", name: "Claude Opus 5.5", isCustom: false, capabilities: null },
      ],
    } as unknown as ServerProvider;
    const caller = {
      id: sourceThreadId,
      projectId,
      title: "Coordinator",
      branch: null,
      worktreePath: null,
      providerInstanceId: claude,
      modelSelection: coordinatorModel,
      runtimeMode: "full-access",
      interactionMode: "default",
      activeRunId: "active-run",
      archivedAt: null,
      deletedAt: null,
    } as unknown as OrchestrationV2ThreadShell;
    const launched: ThreadLaunch.ThreadLaunchInput[] = [];
    const layerDependencies = (providers: ReadonlyArray<ServerProvider>) =>
      Layer.mergeAll(
        NodeCrypto.layer,
        Layer.succeed(McpInvocationContext.McpInvocationContext, {
          environmentId: EnvironmentId.make("environment"),
          requestNamespace: "session",
          thread: {
            threadId: sourceThreadId,
            providerSessionId: "session",
            providerInstanceId: claude,
          },
          client: undefined,
          issuedAt: 0,
          capabilities: new Set(["orchestration" as const]),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(caller),
        }),
        Layer.mock(ThreadLaunch.ThreadLaunchService)({
          launch: (input) => {
            launched.push(input);
            return Effect.succeed({
              threadId: input.threadId,
              projection: {
                thread: { id: input.threadId, projectId, modelSelection: input.modelSelection },
                runs: [],
              },
              resumed: false,
            } as unknown as ThreadLaunch.ThreadLaunchResult);
          },
        }),
        Layer.mock(Project.ProjectService)({
          getById: (id) =>
            Effect.succeed(
              Option.some(
                projectFixture(id, {
                  workspaceRoot: root,
                  defaultModelSelection: null,
                  workspaceSettings: {
                    ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
                    coordinatorThreadId: sourceThreadId,
                  },
                }),
              ),
            ),
        }),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
        Layer.mock(GitVcsDriver.GitVcsDriver)({}),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed(providers) }),
        NodeServices.layer,
        ServerConfig.layerTest(process.cwd(), { prefix: "studio-launch-host-default-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      );
    const launch = (providers: ReadonlyArray<ServerProvider>) =>
      Effect.gen(function* () {
        const dependencies = layerDependencies(providers);
        const toolkit = yield* ProjectToolkit.pipe(
          Effect.provide(
            McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
              Layer.provide(dependencies),
            ),
          ),
        );
        return yield* toolkit
          .handle("studio_thread_launch", { title: "Docs", message: "Update the docs." })
          .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      });

    // No project worker model: the host's default worker model is used, not a refusal.
    yield* launch([ready]);
    expect(launched[0]?.modelSelection).toMatchObject({ instanceId: claude, model: "claude-opus" });
    // With no usable provider either, the coordinator is asked to name one.
    const refused = yield* launch([]);
    expect(refused.at(-1)?.result).toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining("Pass modelSelection"),
    });
    expect(launched).toHaveLength(1);
  }).pipe(Effect.scoped),
);

it.effect("launches a scratch thread into the Scratch project", () =>
  Effect.gen(function* () {
    const sourceThreadId = ThreadId.make("source-thread");
    const scratchProjectId = ProjectId.make("project:scratch");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const modelSelection = { instanceId: providerInstanceId, model: "gpt-5" };
    const caller = {
      id: sourceThreadId,
      projectId: ProjectId.make("project:caller"),
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      activeRunId: "active-run",
      archivedAt: null,
      deletedAt: null,
    } as OrchestrationV2ThreadShell;
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        requestNamespace: "session",
        thread: {
          threadId: sourceThreadId,
          providerSessionId: "session",
          providerInstanceId,
        },
        client: undefined,
        issuedAt: 0,
        capabilities: new Set(["orchestration" as const]),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(caller),
      }),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({
        launch: (input) => {
          launched.push(input);
          return Effect.succeed({
            threadId: input.threadId,
            projection: {
              thread: { id: input.threadId, projectId: input.projectId, modelSelection },
              runs: [],
            },
            resumed: false,
          } as unknown as ThreadLaunch.ThreadLaunchResult);
        },
      }),
      Layer.mock(Project.ProjectService)({
        getById: (id) => Effect.succeed(Option.some(projectFixture(id))),
      }),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        ensureScratchProject: Effect.succeed({ projectId: scratchProjectId }),
      }),
      Layer.mock(GitVcsDriver.GitVcsDriver)({}),
      Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
      NodeServices.layer,
      ServerConfig.layerTest(process.cwd(), { prefix: "studio-scratch-launch-" }).pipe(
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
    const handle = (params: Parameters<typeof toolkit.handle<"studio_thread_launch">>[1]) =>
      toolkit
        .handle("studio_thread_launch", params)
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies));

    // Asked for in a project, the work stays there unless the user wanted no project.
    const kept = yield* handle({ title: "Notes", scratch: true, message: "Draft a list" });
    expect(kept.at(-1)?.result).toMatchObject({ code: "invalid_request" });
    expect(String((kept.at(-1)?.result as { message: string }).message)).toContain(
      "the threads it starts stay there",
    );
    expect(launched).toHaveLength(0);
    // With a machine too, the refusal still names the project, not its id.
    const keptOnMachine = yield* handle({
      title: "Notes",
      scratch: true,
      machine: "local",
      message: "Draft a list",
    });
    expect(String((keptOnMachine.at(-1)?.result as { message: string }).message)).toContain(
      'project "Fixture"',
    );
    expect(launched).toHaveLength(0);

    const result = yield* handle({
      title: "Notes",
      scratch: true,
      projectless: true,
      message: "Draft a list",
    });
    expect(result.at(-1)?.result).toMatchObject({ projectId: scratchProjectId });
    expect(launched.map((input) => [input.projectId, input.workspaceStrategy])).toEqual([
      [scratchProjectId, { type: "root" }],
    ]);

    const rejected = yield* handle({
      title: "Notes",
      scratch: true,
      projectId: caller.projectId,
    });
    expect(rejected.at(-1)?.result).toMatchObject({ code: "invalid_request" });
    expect(launched).toHaveLength(1);

    // A chat outside any project may start more of them.
    Object.assign(caller, { projectId: scratchProjectId });
    yield* handle({ title: "More notes", scratch: true, message: "Draft another" });
    expect(launched).toHaveLength(2);
  }),
);

it.effect("starts a project from just a title when workspaceRoot is omitted", () =>
  Effect.gen(function* () {
    const sourceThreadId = ThreadId.make("source-thread");
    const createdProjectId = ProjectId.make("project:named");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const caller = {
      id: sourceThreadId,
      projectId: ProjectId.make("project:caller"),
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      activeRunId: "active-run",
      archivedAt: null,
      deletedAt: null,
    } as OrchestrationV2ThreadShell;
    const named: Array<string> = [];
    const kinds: Array<"code" | "personal" | undefined> = [];
    const registered: Array<string> = [];
    const createdProject = {
      id: createdProjectId,
      title: "Pinball Stats",
      workspaceRoot: "/projects/pinball-stats",
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      deletedAt: null,
    };
    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        requestNamespace: "session",
        thread: {
          threadId: sourceThreadId,
          providerSessionId: "session",
          providerInstanceId,
        },
        client: undefined,
        issuedAt: 0,
        capabilities: new Set(["orchestration" as const]),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(caller),
      }),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
      Layer.mock(Project.ProjectService)({
        create: (input) =>
          Effect.sync(() => {
            registered.push(input.workspaceRoot);
            return { ...createdProject, id: input.projectId, workspaceRoot: input.workspaceRoot };
          }),
        getById: (projectId) =>
          Effect.succeed(
            projectId === createdProjectId ? Option.some(createdProject) : Option.none(),
          ),
      }),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        createNamedProject: (input) =>
          Effect.sync(() => {
            named.push(input.name);
            kinds.push(input.kind);
            return {
              projectId: createdProjectId,
              workspaceRoot: createdProject.workspaceRoot,
              commitError: "Git has no name or email on this machine.",
            };
          }),
      }),
      Layer.mock(GitVcsDriver.GitVcsDriver)({}),
      Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
      NodeServices.layer,
      ServerConfig.layerTest(process.cwd(), { prefix: "studio-named-project-" }).pipe(
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
    const handle = (params: Parameters<typeof toolkit.handle<"studio_project_create">>[1]) =>
      toolkit
        .handle("studio_project_create", params)
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies));

    const result = yield* handle({ title: "Pinball Stats" });
    expect(result.at(-1)?.result).toMatchObject({
      id: createdProjectId,
      workspaceRoot: "/projects/pinball-stats",
      commitError: "Git has no name or email on this machine.",
    });
    expect(named).toEqual(["Pinball Stats"]);
    expect(kinds).toEqual([undefined]);

    // A personal one keeps its kind, so this machine's assistant is returned, not a code project.
    yield* handle({ title: "Second Aide", kind: "personal" });
    expect(kinds).toEqual([undefined, "personal"]);
    named.pop();

    // A path still registers that folder, and never makes a named project.
    yield* handle({ title: "Existing", workspaceRoot: "/work/existing" });
    expect(registered).toEqual(["/work/existing"]);

    // Fields this mode cannot apply are rejected, not dropped.
    for (const extra of [
      { scripts: [] },
      { defaultModelSelection: { instanceId: providerInstanceId, model: "gpt-5" } },
      // A check brings its own folder; it never gets a new repository from a title.
      { origin: "automated" as const },
    ]) {
      const rejected = yield* handle({ title: "Configured", ...extra });
      expect(rejected.at(-1)?.result).toMatchObject({ code: "invalid_request" });
    }
    expect(named).toEqual(["Pinball Stats"]);
  }),
);

const clientLaunchHarness = (input: {
  readonly runtimeModeCeiling: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
  readonly launched: Array<ThreadLaunch.ThreadLaunchInput>;
  readonly workspaceRoot?: string;
  readonly providers?: ReadonlyArray<ServerProvider>;
  readonly taskRouting?: Partial<TaskRoutingSettings>;
}) => {
  const projectId = ProjectId.make("project:client-target");
  const modelSelection = { instanceId: ProviderInstanceId.make("claude"), model: "claude-opus" };
  const layerDependencies = Layer.mergeAll(
    NodeCrypto.layer,
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment"),
      requestNamespace: "client:session-1",
      thread: undefined,
      client: {
        sessionId: "session-1",
        label: "Claude Code",
        access: input.runtimeModeCeiling,
      },
      issuedAt: 0,
      capabilities: new Set(["orchestration" as const]),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({}),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      launch: (launch) => {
        input.launched.push(launch);
        return Effect.succeed({
          threadId: launch.threadId,
          projection: {
            thread: {
              id: launch.threadId,
              projectId: launch.projectId,
              modelSelection: launch.modelSelection,
            },
            runs: [],
          },
          resumed: false,
        } as unknown as ThreadLaunch.ThreadLaunchResult);
      },
    }),
    Layer.mock(Project.ProjectService)({
      getById: (id) =>
        Effect.succeed(
          id === projectId
            ? Option.some({
                id,
                workspaceRoot: input.workspaceRoot ?? "/projects/client-target",
                defaultModelSelection: modelSelection,
              } as unknown as ProjectRecord)
            : Option.none(),
        ),
    }),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
    Layer.mock(ServerSettings.ServerSettingsService)({
      getSettings: Effect.succeed({
        ...DEFAULT_SERVER_SETTINGS,
        taskRouting: { ...DEFAULT_TASK_ROUTING_SETTINGS, ...input.taskRouting },
      }),
    }),
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed(
        input.providers ?? [
          {
            instanceId: modelSelection.instanceId,
            models: [
              {
                slug: modelSelection.model,
                capabilities: {
                  optionDescriptors: [
                    {
                      id: "effort",
                      label: "Reasoning",
                      type: "select",
                      options: ["low", "medium", "high", "max"].map((id) => ({ id, label: id })),
                    },
                  ],
                },
              },
            ],
          } as unknown as ServerProvider,
        ],
      ),
    }),
    NodeServices.layer,
  ).pipe(
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "studio-client-launch-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  return { projectId, modelSelection, dependencies: layerDependencies };
};

it.effect("a client launches at its ceiling with the project's default model", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, modelSelection, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto-accept-edits",
      launched,
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const handle = (params: Parameters<typeof toolkit.handle<"studio_thread_launch">>[1]) =>
      toolkit
        .handle("studio_thread_launch", params)
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    const result = yield* handle({ title: "Fix", projectId, message: "Fix the bug" });
    expect(result.at(-1)?.result).toMatchObject({ projectId, modelSelection });
    expect(launched[0]?.runtimeMode).toBe("auto-accept-edits");
    expect(launched[0]?.initialMessage?.senderThreadId).toBeUndefined();

    const escalated = yield* handle({ title: "Fix", projectId, runtimeMode: "full-access" });
    expect(escalated.at(-1)?.result).toMatchObject({ code: "runtime_mode_escalation_denied" });

    const untargeted = yield* handle({ title: "Fix" });
    expect(untargeted.at(-1)?.result).toMatchObject({ code: "target_required" });
    expect(launched).toHaveLength(1);
  }),
);

it.effect("a launch runs at the requested effort, or the nearest level the model offers", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto-accept-edits",
      launched,
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const handle = (params: Parameters<typeof toolkit.handle<"studio_thread_launch">>[1]) =>
      toolkit
        .handle("studio_thread_launch", params)
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    const result = yield* handle({ title: "Research", projectId, effort: "extra high" });
    expect(result.at(-1)?.result).toMatchObject({ effort: "max" });
    expect(launched[0]?.modelSelection.options).toEqual([{ id: "effort", value: "max" }]);

    const unknown = yield* handle({ title: "Research", projectId, effort: "turbo" });
    expect(unknown.at(-1)?.result).toMatchObject({ code: "invalid_request" });
    expect(launched).toHaveLength(1);
  }),
);

it.effect("a launch with a task class routes under Auto and keeps the decision on the thread", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const claude = ProviderInstanceId.make("claude");
    const ready = {
      instanceId: claude,
      driver: "claudeAgent",
      enabled: true,
      installed: true,
      status: "ready",
      auth: { status: "authenticated" },
      models: [
        { slug: "claude-opus", name: "Claude Opus 5.5", isCustom: false, capabilities: null },
        {
          slug: "claude-sonnet-5-5",
          name: "Claude Sonnet 5.5",
          isCustom: false,
          capabilities: null,
        },
      ],
    } as unknown as ServerProvider;
    const run = (taskRouting: Partial<TaskRoutingSettings>) =>
      Effect.gen(function* () {
        const { projectId, dependencies } = clientLaunchHarness({
          runtimeModeCeiling: "auto-accept-edits",
          launched,
          providers: [ready],
          taskRouting,
        });
        const toolkit = yield* ProjectToolkit.pipe(
          Effect.provide(
            McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
              Layer.provide(dependencies),
            ),
          ),
        );
        return yield* toolkit
          .handle("studio_thread_launch", {
            title: "Spanish docs",
            projectId,
            taskClass: "translation",
            message: "Translate docs/guide.md into Spanish.",
          })
          .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      });

    const routed = yield* run({ mode: "auto" });
    expect(launched[0]?.modelSelection).toEqual({ instanceId: claude, model: "claude-sonnet-5-5" });
    expect(launched[0]?.routing).toMatchObject({ taskClass: "translation", moved: true });
    expect(routed.at(-1)?.result).toMatchObject({ routing: { taskClass: "translation" } });

    yield* run({ mode: "off" });
    expect(launched[1]?.modelSelection.model).toBe("claude-opus");
    expect(launched[1]?.routing).toBeUndefined();
  }),
);

it.effect("a launch binds only an existing checkout that is one of the project's worktrees", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "studio-launch-worktree-" });
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
    for (const elsewhere of [outside, path.join(worktree, "..", "outside"), "/"]) {
      expect((yield* launchInto(elsewhere)).at(-1)?.result).toMatchObject({
        code: "invalid_request",
      });
    }
    expect(launched.map((launch) => launch.workspaceStrategy)).toEqual([
      { type: "existing_worktree", worktreePath: worktree },
      { type: "existing_worktree", worktreePath: repo },
    ]);

    // A removed worktree stays listed as prunable until `git worktree prune`;
    // whatever directory is later made at its path is not one of the project's.
    yield* fileSystem.remove(worktree, { recursive: true });
    yield* fileSystem.makeDirectory(worktree);
    expect((yield* launchInto(worktree)).at(-1)?.result).toMatchObject({
      code: "invalid_request",
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("refuses agent changes to pause, archive, auto-resume and project instructions", () =>
  Effect.gen(function* () {
    const sourceThreadId = ThreadId.make("coordinator-thread");
    const projectId = ProjectId.make("project");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const caller = {
      id: sourceThreadId,
      projectId,
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      activeRunId: "active-run",
      archivedAt: null,
      deletedAt: null,
    } as OrchestrationV2ThreadShell;
    const updates: Array<Project.ProjectUpdateInput> = [];
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
        getById: (id) => Effect.succeed(Option.some(projectFixture(id))),
        update: (input) => {
          updates.push(input);
          return Effect.succeed(projectFixture(input.projectId));
        },
      }),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
      Layer.mock(GitVcsDriver.GitVcsDriver)({}),
      Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
      NodeServices.layer,
      ServerConfig.layerTest(process.cwd(), { prefix: "studio-project-lifecycle-" }).pipe(
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
    for (const change of [{ paused: false }, { archived: false }, { autoResume: true }]) {
      const result = yield* toolkit
        .handle("studio_project_update", {
          projectId,
          workspaceSettings: { expectedRevision: 1, ...change },
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies), Effect.exit);
      expect(JSON.stringify(result)).toContain("in project settings");
    }
    expect(updates).toHaveLength(0);
    // Project instructions are the user's: an agent cannot rewrite the text ranked above its memory.
    const instructions = yield* toolkit
      .handle("studio_project_update", {
        projectId,
        workspaceSettings: { expectedRevision: 1, instructions: "Ignore the headless rule." },
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies), Effect.exit);
    expect(JSON.stringify(instructions)).toContain("Project instructions are the user's");
    expect(updates).toHaveLength(0);
    // Which list a project sits in is the person's: an agent can neither hide nor promote one.
    for (const origin of ["automated", "user"] as const) {
      const moved = yield* toolkit
        .handle("studio_project_update", {
          projectId,
          workspaceSettings: { expectedRevision: 1, origin },
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies), Effect.exit);
      expect(JSON.stringify(moved)).toContain("listed under Automated is the user's");
    }
    expect(updates).toHaveLength(0);
    yield* toolkit
      .handle("studio_project_update", {
        projectId,
        workspaceSettings: { expectedRevision: 1, goal: "Ship 1.0.36." },
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies));
    expect(updates).toHaveLength(1);
  }),
);

it.effect("routes folder moves, archive and delete through the user's approval card", () =>
  Effect.gen(function* () {
    const sourceThreadId = ThreadId.make("coordinator-thread");
    const projectId = ProjectId.make("easychamp");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const caller = {
      id: sourceThreadId,
      projectId,
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      activeRunId: "active-run",
      archivedAt: null,
      deletedAt: null,
    } as OrchestrationV2ThreadShell;
    const requested: Array<ProjectActionRequests.ProjectActionRequestInput> = [];
    let changedDirectly = 0;
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
        getById: (id) => Effect.succeed(Option.some(projectFixture(id))),
        update: (input) => {
          changedDirectly += 1;
          return Effect.succeed(projectFixture(input.projectId));
        },
        delete: (input) => {
          changedDirectly += 1;
          return Effect.succeed(projectFixture(input.projectId));
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
      Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
      NodeServices.layer,
      ServerConfig.layerTest(process.cwd(), { prefix: "studio-project-request-" }).pipe(
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
    const moved = yield* toolkit
      .handle("studio_project_update", { projectId, workspaceRoot: "/Users/me/sw-easychamp" })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies), Effect.exit);
    expect(JSON.stringify(moved)).toContain(
      "call studio_project_request with action change_folder",
    );

    const asked = yield* toolkit
      .handle("studio_project_request", {
        action: "change_folder",
        workspaceRoot: "/Users/me/sw-easychamp",
        reason: "The project points at a managed stub.",
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies));
    expect(asked.at(-1)?.result).toMatchObject({
      requestId: "project-action:1",
      status: "awaiting_user",
    });

    yield* toolkit
      .handle("studio_project_delete", { projectId, reason: "Wrong project." })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies));
    expect(requested).toEqual([
      {
        threadId: sourceThreadId,
        projectId,
        action: "change_folder",
        workspaceRoot: "/Users/me/sw-easychamp",
        reason: "The project points at a managed stub.",
      },
      { threadId: sourceThreadId, projectId, action: "delete", reason: "Wrong project." },
    ]);
    expect(changedDirectly).toBe(0);
  }),
);

it.effect("manages learned model preferences for a project via studio_model_preference", () =>
  Effect.gen(function* () {
    const sourceThreadId = ThreadId.make("source-thread");
    const projectId = ProjectId.make("project");
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

    const settingsRef = yield* Ref.make({
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: {},
    });

    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        requestNamespace: "session",
        thread: {
          threadId: sourceThreadId,
          providerSessionId: "session",
          providerInstanceId,
        },
        client: undefined,
        issuedAt: 0,
        capabilities: new Set(["orchestration" as const]),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(caller),
      }),
      Layer.mock(Project.ProjectService)({
        getById: (id) =>
          Effect.succeed(
            id === projectId
              ? Option.some({
                  id,
                  workspaceRoot: "/projects/test",
                } as unknown as ProjectRecord)
              : Option.none(),
          ),
      }),
      Layer.mock(ServerSettings.ServerSettingsService)({
        getSettings: Ref.get(settingsRef),
        updateSettings: (patch) =>
          Ref.updateAndGet(settingsRef, (current) => applyServerSettingsPatch(current, patch)),
      }),
      NodeServices.layer,
      ServerConfig.layerTest(process.cwd(), { prefix: "studio-model-pref-" }).pipe(
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

    // 1. Initial list is empty
    const initial = yield* toolkit
      .handle("studio_model_preference", { action: "list" })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies));
    expect(initial.at(-1)?.result).toMatchObject({
      action: "list",
      projectId,
      preferences: [],
    });

    // 2. Record a rule
    const recorded = yield* toolkit
      .handle("studio_model_preference", {
        action: "record",
        keywords: ["database", "migration"],
        preference: {
          kind: "prefer",
          model: { instanceId: providerInstanceId, model: "claude-opus-5-5" },
        },
        note: "Use Opus for DB tasks",
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies));
    const recordResult = recorded.at(-1)?.result as any;
    expect(recordResult.action).toBe("record");
    expect(recordResult.recorded).toMatchObject({
      keywords: ["database", "migration"],
      action: {
        kind: "prefer",
        model: { instanceId: providerInstanceId, model: "claude-opus-5-5" },
      },
      note: "Use Opus for DB tasks",
    });
    const ruleId = recordResult.recorded.id;
    expect(ruleId).toMatch(/^pref-/);

    // 3. List contains recorded rule
    const afterRecord = yield* toolkit
      .handle("studio_model_preference", { action: "list" })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies));
    expect((afterRecord.at(-1)?.result as any).preferences).toHaveLength(1);

    // 4. Delete the rule
    const deleted = yield* toolkit
      .handle("studio_model_preference", { action: "delete", id: ruleId })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies));
    expect((deleted.at(-1)?.result as any).deleted).toBe(true);

    // 5. List is empty again
    const finalList = yield* toolkit
      .handle("studio_model_preference", { action: "list" })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies));
    expect((finalList.at(-1)?.result as any).preferences).toHaveLength(0);
  }),
);

it.effect("refuses a learned preference that would send workers to API credits", () =>
  Effect.gen(function* () {
    const sourceThreadId = ThreadId.make("source-thread");
    const projectId = ProjectId.make("project");
    const claudeMax = ProviderInstanceId.make("claudeAgent");
    const claudeApi = ProviderInstanceId.make("claude-api");
    const caller = {
      id: sourceThreadId,
      projectId,
      providerInstanceId: claudeMax,
      modelSelection: { instanceId: claudeMax, model: "claude-opus-5-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      activeRunId: "active-run",
      archivedAt: null,
      deletedAt: null,
    } as OrchestrationV2ThreadShell;
    const instance = (
      instanceId: ProviderInstanceId,
      auth: ServerProvider["auth"],
    ): ServerProvider => ({
      instanceId,
      driver: "claudeAgent" as ServerProvider["driver"],
      enabled: true,
      installed: true,
      version: "test",
      status: "ready",
      auth,
      checkedAt: "2026-10-25T00:00:00.000Z",
      models: [
        { slug: "claude-opus-5-5", name: "Claude Opus 5.5", isCustom: false, capabilities: null },
        {
          slug: "claude-sonnet-5-5",
          name: "Claude Sonnet 5.5",
          isCustom: false,
          capabilities: null,
        },
      ],
      slashCommands: [],
      skills: [],
    });
    // Pi signs in as `pi`; its OpenCode Go models report flat-rate billing.
    const pi = ProviderInstanceId.make("pi");
    const goModel = "opencode-go/kimi-k3";
    const providers = [
      instance(claudeMax, { status: "authenticated", type: "max" }),
      instance(claudeApi, { status: "authenticated", type: "apiKey", apiKeyBilling: true }),
      {
        ...instance(pi, { status: "authenticated", type: "pi" }),
        driver: "pi" as ServerProvider["driver"],
        models: [
          {
            slug: goModel,
            name: "Kimi K3",
            isCustom: false,
            capabilities: null,
            billing: "subscription" as const,
          },
        ],
      },
    ];
    const settingsRef = yield* Ref.make({
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: {},
    });
    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        requestNamespace: "session",
        thread: {
          threadId: sourceThreadId,
          providerSessionId: "session",
          providerInstanceId: claudeMax,
        },
        client: undefined,
        issuedAt: 0,
        capabilities: new Set(["orchestration" as const]),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(caller),
      }),
      Layer.mock(Project.ProjectService)({
        getById: (id) =>
          Effect.succeed(
            id === projectId
              ? Option.some({ id, workspaceRoot: "/projects/test" } as unknown as ProjectRecord)
              : Option.none(),
          ),
      }),
      Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed(providers) }),
      Layer.mock(ServerSettings.ServerSettingsService)({
        getSettings: Ref.get(settingsRef),
        updateSettings: (patch) =>
          Ref.updateAndGet(settingsRef, (current) => applyServerSettingsPatch(current, patch)),
      }),
      NodeServices.layer,
      ServerConfig.layerTest(process.cwd(), { prefix: "studio-model-pref-paid-" }).pipe(
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
    const record = (instanceId: ProviderInstanceId, model = "claude-opus-5-5") =>
      toolkit
        .handle("studio_model_preference", {
          action: "record",
          lane: "routine",
          preference: { kind: "prefer", model: { instanceId, model } },
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies));

    const refused = yield* record(claudeApi);
    expect(refused.at(-1)?.result).toMatchObject({ code: "invalid_request" });
    expect((refused.at(-1)?.result as { message: string }).message).toContain("billed per token");
    const stored = yield* Ref.get(settingsRef);
    expect(
      (
        stored.projectSettingsOverrides as Record<
          string,
          { readonly learnedModelPreferences?: ReadonlyArray<unknown> }
        >
      )[projectId]?.learnedModelPreferences ?? [],
    ).toEqual([]);

    // The subscription stays a preference the coordinator may record, and the
    // rule says who made it so routing checks it again when used.
    const recorded = yield* record(claudeMax);
    expect((recorded.at(-1)?.result as { action: string }).action).toBe("record");
    const kept = yield* Ref.get(settingsRef);
    expect(
      (
        kept.projectSettingsOverrides as Record<
          string,
          { readonly learnedModelPreferences?: ReadonlyArray<{ readonly recordedBy?: string }> }
        >
      )[projectId]?.learnedModelPreferences?.map((rule) => rule.recordedBy),
    ).toEqual(["coordinator"]);

    // A paid-API setting left over after Auto was turned off is hidden in
    // Settings and has no effect, so it does not let Sonnet on the key in.
    const withRouting = (mode: "off" | "auto") =>
      Ref.update(settingsRef, (current) => ({
        ...current,
        taskRouting: { ...DEFAULT_TASK_ROUTING_SETTINGS, mode, paidApi: "standard" as const },
      }));
    yield* withRouting("off");
    const flatRate = yield* record(pi, goModel);
    expect((flatRate.at(-1)?.result as { action: string }).action).toBe("record");
    const leftover = yield* record(claudeApi, "claude-sonnet-5-5");
    expect(leftover.at(-1)?.result).toMatchObject({ code: "invalid_request" });
    yield* withRouting("auto");
    const allowed = yield* record(claudeApi, "claude-sonnet-5-5");
    expect((allowed.at(-1)?.result as { action: string }).action).toBe("record");
  }),
);
