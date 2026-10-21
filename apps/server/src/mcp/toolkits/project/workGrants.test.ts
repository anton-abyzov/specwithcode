import { projectFixture } from "../../../project/ProjectWorkspace.testkit.ts";
import { describe, expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  EnvironmentId,
  type ModelSelection,
  OrchestratorMcpFailure,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as EnvironmentAuth from "../../../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../../../config.ts";
import * as RemoteWorkers from "../../../fleet/RemoteWorkers.ts";
import * as WorkGrants from "../../../fleet/WorkGrants.ts";
import { workerClientName } from "../../../fleet/workerGrantMint.ts";
import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import * as OrchestratorHandlers from "../orchestrator/handlers.ts";
import { OrchestratorToolkit } from "../orchestrator/tools.ts";
import * as ProjectHandlers from "./handlers.ts";
import { ProjectToolkit } from "./tools.ts";
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as ProjectPlans from "../../../project/ProjectPlanService.ts";
import * as ProjectWorkspace from "../../../project/ProjectWorkspaceService.ts";
import * as ScheduledTasks from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as ProjectMemoryHandlers from "../projectMemory/handlers.ts";
import { ProjectMemoryToolkit } from "../projectMemory/tools.ts";
import * as ProjectPlanHandlers from "../projectPlan/handlers.ts";
import { ProjectPlanToolkit } from "../projectPlan/tools.ts";
import * as ThreadHandlers from "../thread/handlers.ts";
import { ThreadToolkit } from "../thread/tools.ts";
import { PERSONAL_ASSISTANT_PRIVATE_MESSAGE } from "@specweave-studio/shared/personalAssistant";

/**
 * The worker side of a grant: M4MAX (the coordinator) launches on this
 * machine (M3) through its worker grant, and the threads it starts here act
 * under the same grant.
 */
const HERE = EnvironmentId.make("env-m3");
const M4 = EnvironmentId.make("env-m4");
const M1 = EnvironmentId.make("env-m1");
const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claude");
const linkedProject = ProjectId.make("linked");
const otherProject = ProjectId.make("unlinked");
const householdProject = ProjectId.make("example-household");
const selection = (instanceId: ProviderInstanceId): ModelSelection =>
  ({ instanceId, model: "model" }) as ModelSelection;

const projects = new Map([
  [
    linkedProject as string,
    projectFixture(linkedProject, {
      title: "Linked",
      defaultModelSelection: selection(codex),
      workspaceSettings: {
        ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
        logicalProject: {
          id: "shared",
          title: "Shared",
          coordinatorId: "coordinator",
          members: [
            {
              environmentId: M4,
              projectId: ProjectId.make("m4-project"),
              coordinatorThreadId: ThreadId.make("c"),
            },
            {
              environmentId: HERE,
              projectId: linkedProject,
              coordinatorThreadId: ThreadId.make("c"),
            },
          ],
        },
      },
    }),
  ],
  [
    otherProject as string,
    projectFixture(otherProject, { title: "Private", defaultModelSelection: selection(codex) }),
  ],
  [
    householdProject as string,
    projectFixture(householdProject, {
      title: "Example Household",
      workspaceRoot: "/fixtures/example-household",
      defaultModelSelection: selection(codex),
      workspaceSettings: { ...DEFAULT_PROJECT_WORKSPACE_SETTINGS, kind: "personal" },
    }),
  ],
]);

const workerSession = (coordinator: EnvironmentId) => ({
  sessionId: AuthSessionId.make(`session-${coordinator}`),
  subject: EnvironmentAuth.MCP_CLIENT_SUBJECT,
  client: { label: workerClientName(coordinator), deviceType: "bot" },
});

const setup = (input: {
  readonly prefix: string;
  /** Coordinators whose grants already existed when this version first ran. */
  readonly legacy?: ReadonlyArray<EnvironmentId>;
}) => {
  const shells = new Map<string, OrchestrationV2ThreadShell>();
  const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
  const revoked: Array<string> = [];
  const reached: Array<string> = [];
  const reach = (threadId: string) =>
    Effect.sync(() => reached.push(threadId)).pipe(
      Effect.andThen(
        Effect.fail(new OrchestratorMcpFailure({ code: "invalid_request", message: "reached" })),
      ),
    );
  const live = [...(input.legacy ?? [])].map(workerSession);
  const config = ServerConfig.layerTest(process.cwd(), { prefix: input.prefix }).pipe(
    Layer.provide(NodeServices.layer),
  );
  const base = Layer.mergeAll(
    NodeCrypto.layer,
    NodeServices.layer,
    config,
    Layer.mock(EnvironmentAuth.EnvironmentAuth)({
      listSessions: () => Effect.succeed(live as never),
      revokeSession: (sessionId) =>
        Effect.sync(() => revoked.push(sessionId)).pipe(Effect.as(true)),
    }),
  );
  const layer = WorkGrants.layer.pipe(Layer.provideMerge(base));
  const services = (
    scope: McpInvocationContext.McpInvocationScope,
    grants: WorkGrants.WorkGrantsShape,
    serverConfig: ServerConfig.ServerConfig["Service"],
  ) =>
    Layer.mergeAll(
      NodeCrypto.layer,
      NodeServices.layer,
      Layer.succeed(ServerConfig.ServerConfig, serverConfig),
      Layer.succeed(WorkGrants.WorkGrants, grants),
      Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (id) => Effect.succeed(shells.get(id) ?? null),
        getProjectThreadRecords: ({ threadId }) => reach(threadId) as never,
      }),
      Layer.mock(ThreadSearch.ThreadSearch)({
        search: () =>
          Effect.succeed({
            matches: [...shells.values()].map((shell) => ({
              threadId: shell.id,
              projectId: shell.projectId,
              source: "user" as const,
              snippet: "groceries",
              messageCreatedAt: null,
            })),
          } as never),
      }),
      Layer.mock(ProjectWorkspace.ProjectWorkspaceService)({
        readMemory: ({ projectId }) => reach(`memory:${projectId}`) as never,
      }),
      Layer.mock(ProjectPlans.ProjectPlanService)({
        read: ({ projectId }) => reach(`plan:${projectId}`) as never,
      }),
      Layer.mock(ScheduledTasks.ScheduledTaskService)({}),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({
        launch: (launch) => {
          launched.push(launch);
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
        getById: (id) => Effect.succeed(Option.fromNullishOr(projects.get(id))),
        snapshot: Effect.succeed({
          projects: [...projects.values()],
          updatedAt: "2026-10-09T00:00:00Z",
        }),
      }),
      // A call the guards let through reaches the service, which records it.
      Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({
        readThread: (_scope, input) => reach(input.threadId),
        sendToThread: (_scope, input) => reach(input.threadId),
        interruptThread: (_scope, input) => reach(input.threadId),
      }),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
      Layer.mock(GitVcsDriver.GitVcsDriver)({}),
      Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
      Layer.succeed(RemoteWorkers.RemoteWorkers, {
        ...(RemoteWorkers.RemoteWorkers.defaultValue() as RemoteWorkers.RemoteWorkersShape),
        machineLabels: Effect.succeed(new Map([[M4 as string, "M4MAX"]])),
      }),
    );
  const clientScope = (coordinator: EnvironmentId): McpInvocationContext.McpInvocationScope => ({
    environmentId: HERE,
    requestNamespace: `client:${coordinator}`,
    thread: undefined,
    client: {
      sessionId: `session-${coordinator}`,
      label: workerClientName(coordinator),
      access: "full-access",
    },
    issuedAt: 0,
    capabilities: new Set(["orchestration" as const]),
  });
  const threadScope = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
    environmentId: HERE,
    requestNamespace: `thread:${threadId}`,
    thread: { threadId, providerSessionId: "session", providerInstanceId: codex },
    client: undefined,
    issuedAt: 0,
    capabilities: new Set(["orchestration" as const]),
  });
  const call = (
    tool: string,
    scope: McpInvocationContext.McpInvocationScope,
    params: Record<string, unknown>,
  ) =>
    Effect.gen(function* () {
      const deps = services(scope, yield* WorkGrants.WorkGrants, yield* ServerConfig.ServerConfig);
      const toolkit = yield* ProjectToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(deps)),
        ),
      );
      const result = yield* toolkit
        .handle(tool as never, params as never)
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(deps));
      return result.at(-1)?.result as unknown as Record<string, unknown>;
    });
  const launch = (
    scope: McpInvocationContext.McpInvocationScope,
    params: Record<string, unknown>,
  ) => call("studio_thread_launch", scope, params);
  const callThread = (
    tool: "studio_thread_read" | "studio_thread_send" | "studio_thread_interrupt",
    scope: McpInvocationContext.McpInvocationScope,
    params: Record<string, unknown>,
  ) =>
    Effect.gen(function* () {
      const deps = services(scope, yield* WorkGrants.WorkGrants, yield* ServerConfig.ServerConfig);
      const toolkit = yield* OrchestratorToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(OrchestratorHandlers.layer).pipe(Layer.provide(deps)),
        ),
      );
      const result = yield* toolkit
        .handle(tool, params as never)
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(deps));
      return result.at(-1)?.result as unknown as Record<string, unknown>;
    });
  // Any other toolkit's tool, through the same declared access.
  const callTool = (
    which: "thread" | "memory" | "plan",
    tool: string,
    scope: McpInvocationContext.McpInvocationScope,
    params: Record<string, unknown>,
  ) =>
    Effect.gen(function* () {
      const deps = services(scope, yield* WorkGrants.WorkGrants, yield* ServerConfig.ServerConfig);
      const handled =
        which === "thread"
          ? ThreadToolkit.pipe(
              Effect.provide(
                McpToolAccess.HandlersLayer.layer(ThreadHandlers.layer).pipe(Layer.provide(deps)),
              ),
              Effect.map((toolkit) => toolkit.handle(tool as never, params as never)),
            )
          : which === "memory"
            ? ProjectMemoryToolkit.pipe(
                Effect.provide(
                  McpToolAccess.HandlersLayer.layer(ProjectMemoryHandlers.layer).pipe(
                    Layer.provide(deps),
                  ),
                ),
                Effect.map((toolkit) => toolkit.handle(tool as never, params as never)),
              )
            : ProjectPlanToolkit.pipe(
                Effect.provide(
                  McpToolAccess.HandlersLayer.layer(ProjectPlanHandlers.layer).pipe(
                    Layer.provide(deps),
                  ),
                ),
                Effect.map((toolkit) => toolkit.handle(tool as never, params as never)),
              );
      const result = yield* (yield* handled).pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.provide(deps),
      );
      return result.at(-1)?.result as unknown as Record<string, unknown>;
    });
  const origins = WorkGrants.WorkGrants.pipe(Effect.flatMap((service) => service.origins));
  const workGrants = <A, E>(use: (service: WorkGrants.WorkGrantsShape) => Effect.Effect<A, E>) =>
    WorkGrants.WorkGrants.pipe(Effect.flatMap(use));
  const addThread = (id: ThreadId, projectId: ProjectId, instanceId: ProviderInstanceId) =>
    shells.set(id, {
      id,
      projectId,
      providerInstanceId: instanceId,
      modelSelection: selection(instanceId),
      runtimeMode: "full-access",
      interactionMode: "default",
      activeRunId: "run",
      archivedAt: null,
      deletedAt: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    } as unknown as OrchestrationV2ThreadShell);
  return {
    layer,
    call,
    launch,
    callThread,
    callTool,
    clientScope,
    threadScope,
    launched,
    reached,
    revoked,
    origins,
    workGrants,
    addThread,
  };
};

describe("work started here by another machine", () => {
  it.live("refuses a launch whose path already passed through this machine", () => {
    const world = setup({ prefix: "studio-work-grant-cycle-" });
    return Effect.gen(function* () {
      const refused = yield* world.launch(world.clientScope(M4), {
        title: "Loop",
        projectId: linkedProject,
        message: "go",
        delegation: { path: [HERE, M4], hops: 2 },
      });
      expect(refused).toMatchObject({ code: "delegation_cycle" });
      expect(String(refused.message)).toContain("this machine → M4MAX → this machine");
      expect(world.launched).toHaveLength(0);
    }).pipe(Effect.provide(world.layer));
  });

  it.live("starts linked work, records where it came from, and passes it to its threads", () => {
    const world = setup({ prefix: "studio-work-grant-origin-" });
    return Effect.gen(function* () {
      const started = yield* world.launch(world.clientScope(M4), {
        title: "Fix",
        projectId: linkedProject,
        message: "go",
        delegation: { path: [M4], hops: 1 },
      });
      expect(started).toMatchObject({ projectId: linkedProject, delegationChecked: true });
      const workerThread = ThreadId.make(String(started.threadId));
      expect(yield* world.origins).toMatchObject([
        { threadId: workerThread, coordinatorEnvironmentId: M4, path: [M4], hops: 1 },
      ]);

      // A thread started by M4MAX's work launches here: same grant, same origin.
      world.addThread(workerThread, linkedProject, codex);
      const child = yield* world.launch(world.threadScope(workerThread), {
        title: "Child",
        projectId: linkedProject,
        message: "go",
      });
      expect(child).toMatchObject({ projectId: linkedProject });
      expect((yield* world.origins).map((origin) => origin.threadId)).toContain(child.threadId);
      // ...but never in a project outside that grant.
      const outside = yield* world.launch(world.threadScope(workerThread), {
        title: "Elsewhere",
        projectId: otherProject,
        message: "go",
      });
      expect(outside).toMatchObject({ code: "outside_grant_scope" });
    }).pipe(Effect.provide(world.layer));
  });

  it.live("keeps a new coordinator to linked projects and the sign-ins it may use", () => {
    const world = setup({ prefix: "studio-work-grant-scope-" });
    return Effect.gen(function* () {
      const outside = yield* world.launch(world.clientScope(M4), {
        title: "Fix",
        projectId: otherProject,
        message: "go",
      });
      expect(outside).toMatchObject({ code: "outside_grant_scope" });
      expect(String(outside.message)).toContain("not linked to M4MAX");

      yield* world.workGrants((grants) =>
        grants.update({
          coordinatorEnvironmentId: M4,
          accounts: { kind: "listed", instanceIds: [claude] },
        }),
      );
      const wrongAccount = yield* world.launch(world.clientScope(M4), {
        title: "Fix",
        projectId: linkedProject,
        message: "go",
      });
      expect(wrongAccount).toMatchObject({ code: "account_not_allowed" });
      expect(String(wrongAccount.message)).toContain("claude");
      const rightAccount = yield* world.launch(world.clientScope(M4), {
        title: "Fix",
        projectId: linkedProject,
        message: "go",
        modelSelection: selection(claude),
      });
      expect(rightAccount).toMatchObject({ projectId: linkedProject });

      yield* world.workGrants((grants) =>
        grants.update({ coordinatorEnvironmentId: M4, owner: "other" }),
      );
      const otherPerson = yield* world.launch(world.clientScope(M4), {
        title: "Fix",
        projectId: linkedProject,
        message: "go",
        modelSelection: selection(claude),
      });
      // Marking it another person's machine withdraws every sign-in.
      expect(otherPerson).toMatchObject({ code: "account_not_allowed" });
      expect(world.launched).toHaveLength(1);
    }).pipe(Effect.provide(world.layer));
  });

  it.live("lets a grant from before scopes keep working unchanged", () => {
    const world = setup({ prefix: "studio-work-grant-legacy-", legacy: [M4] });
    return Effect.gen(function* () {
      const started = yield* world.launch(world.clientScope(M4), {
        title: "Fix",
        projectId: otherProject,
        message: "go",
      });
      expect(started).toMatchObject({ projectId: otherProject });
      // A machine allowed after the update starts scoped to linked projects.
      const fresh = yield* world.launch(world.clientScope(M1), {
        title: "Fix",
        projectId: otherProject,
        message: "go",
      });
      expect(fresh).toMatchObject({ code: "outside_grant_scope" });
    }).pipe(Effect.provide(world.layer));
  });

  it.live("refuses more hops than another person's grant allows", () => {
    const world = setup({ prefix: "studio-work-grant-hops-" });
    return Effect.gen(function* () {
      yield* world.launch(world.clientScope(M4), { title: "Seed", projectId: linkedProject });
      yield* world.workGrants((grants) =>
        grants.update({ coordinatorEnvironmentId: M4, owner: "other", accounts: { kind: "all" } }),
      );
      const refused = yield* world.launch(world.clientScope(M4), {
        title: "Fix",
        projectId: linkedProject,
        message: "go",
        delegation: { path: [M1, M4], hops: 2 },
      });
      expect(refused).toMatchObject({ code: "delegation_limit" });
      expect(String(refused.message)).toContain("env-m1 → M4MAX");
    }).pipe(Effect.provide(world.layer));
  });

  it.live("revokes at once and keeps the revoke when the machine allows itself again", () => {
    const world = setup({ prefix: "studio-work-grant-revoke-", legacy: [M4] });
    return Effect.gen(function* () {
      const revoked = yield* world.workGrants((grants) => grants.revoke(M4));
      expect(revoked.revokedAt).not.toBeNull();
      expect(Date.parse(revoked.interruptAt!) - Date.parse(revoked.revokedAt!)).toBe(120_000);
      expect(world.revoked).toEqual([`session-${M4}`]);
      // A grant minted after the revoke is refused too, until this machine restores it.
      const refused = yield* world.launch(world.clientScope(M4), {
        title: "Fix",
        projectId: otherProject,
        message: "go",
      });
      expect(refused).toMatchObject({ code: "machine_not_authorized" });
      yield* world.workGrants((grants) => grants.restore(M4));
      const again = yield* world.launch(world.clientScope(M4), {
        title: "Fix",
        projectId: otherProject,
        message: "go",
      });
      expect(again).toMatchObject({ projectId: otherProject });
    }).pipe(Effect.provide(world.layer));
  });
});

describe("a personal assistant here, seen by another machine's work", () => {
  const localScope: McpInvocationContext.McpInvocationScope = {
    environmentId: HERE,
    requestNamespace: "client:example-desktop",
    thread: undefined,
    client: {
      sessionId: "session-example-desktop",
      label: "Example Desktop",
      access: "full-access",
    },
    issuedAt: 0,
    capabilities: new Set(["orchestration" as const]),
  };

  it.live("hides it from a grant covering every project and refuses reading it", () => {
    // A grant from before scopes covers every project here.
    const world = setup({ prefix: "studio-work-grant-personal-project-", legacy: [M4] });
    return Effect.gen(function* () {
      const listed = yield* world.call("studio_project_list", world.clientScope(M4), {});
      const ids = (listed.projects as ReadonlyArray<{ id: string }>).map((project) => project.id);
      expect(ids).toEqual(expect.arrayContaining([linkedProject, otherProject]));
      expect(ids).not.toContain(householdProject);
      const read = yield* world.call("studio_project_read", world.clientScope(M4), {
        projectId: householdProject,
      });
      expect(read).toMatchObject({ code: "outside_grant_scope" });
      expect(String(read.message)).toContain(PERSONAL_ASSISTANT_PRIVATE_MESSAGE);
      expect(String(read.message)).toContain("M4MAX cannot reach this machine's assistant.");
      expect(
        yield* world.call("studio_project_read", world.clientScope(M4), {
          projectId: otherProject,
        }),
      ).toMatchObject({ id: otherProject });
      const launched = yield* world.launch(world.clientScope(M4), {
        title: "Errands",
        projectId: householdProject,
        message: "go",
      });
      expect(launched).toMatchObject({ code: "outside_grant_scope" });
      expect(world.launched).toHaveLength(0);
    }).pipe(Effect.provide(world.layer));
  });

  it.live("refuses reading, sending to and interrupting its threads", () => {
    const world = setup({ prefix: "studio-work-grant-personal-thread-", legacy: [M4] });
    const errands = ThreadId.make("household-errands");
    const fix = ThreadId.make("unlinked-fix");
    world.addThread(errands, householdProject, codex);
    world.addThread(fix, otherProject, codex);
    return Effect.gen(function* () {
      for (const [tool, params] of [
        ["studio_thread_read", {}],
        ["studio_thread_send", { message: "hello" }],
        ["studio_thread_interrupt", {}],
      ] as const) {
        const refused = yield* world.callThread(tool, world.clientScope(M4), {
          threadId: errands,
          ...params,
        });
        expect(refused, tool).toMatchObject({ code: "outside_grant_scope" });
        expect(String(refused.message), tool).toContain(PERSONAL_ASSISTANT_PRIVATE_MESSAGE);
        // The same grant still reaches a code project's thread.
        yield* world.callThread(tool, world.clientScope(M4), { threadId: fix, ...params });
      }
      expect(world.reached).toEqual([fix, fix, fix]);
    }).pipe(Effect.provide(world.layer));
  });

  it.live("refuses its queue, requests, forks, memory and plan, and hides it from search", () => {
    const world = setup({ prefix: "studio-work-grant-personal-tools-", legacy: [M4] });
    const errands = ThreadId.make("household-errands");
    const fix = ThreadId.make("unlinked-fix");
    world.addThread(errands, householdProject, codex);
    world.addThread(fix, otherProject, codex);
    return Effect.gen(function* () {
      for (const [tool, params] of [
        ["studio_queue_list", {}],
        ["studio_thread_configuration", {}],
        ["studio_pending_request_list", {}],
        ["studio_thread_fork", { sourcePoint: { type: "latest_stable" } }],
      ] as const) {
        const refused = yield* world.callTool("thread", tool, world.clientScope(M4), {
          threadId: errands,
          ...params,
        });
        expect(refused, tool).toMatchObject({ code: "outside_grant_scope" });
        expect(String(refused.message), tool).toContain(PERSONAL_ASSISTANT_PRIVATE_MESSAGE);
      }
      // The same grant still reaches a code project's thread.
      yield* world.callTool("thread", "studio_queue_list", world.clientScope(M4), {
        threadId: fix,
      });
      expect(world.reached).toEqual([fix]);

      const found = yield* world.callTool("thread", "studio_thread_search", world.clientScope(M4), {
        query: "groceries",
      });
      expect(
        (found.matches as ReadonlyArray<{ projectId: string }>).map((match) => match.projectId),
      ).toEqual([otherProject]);
      expect(
        yield* world.callTool("thread", "studio_thread_search", world.clientScope(M4), {
          query: "groceries",
          projectId: householdProject,
        }),
      ).toMatchObject({ code: "outside_grant_scope" });

      for (const [which, tool] of [
        ["memory", "studio_project_memory_read"],
        ["plan", "studio_project_plan_read"],
      ] as const) {
        const refused = yield* world.callTool(which, tool, world.clientScope(M4), {
          projectId: householdProject,
          name: "MEMORY.md",
        });
        expect(refused, tool).toMatchObject({ code: "outside_grant_scope" });
      }
      expect(world.reached).toEqual([fix]);

      // A caller on this machine without a grant still searches and reads it.
      const local = yield* world.callTool("thread", "studio_thread_search", localScope, {
        query: "groceries",
      });
      expect(
        (local.matches as ReadonlyArray<{ projectId: string }>).map((match) => match.projectId),
      ).toContain(householdProject);
      yield* world.callTool("memory", "studio_project_memory_read", localScope, {
        projectId: householdProject,
        name: "MEMORY.md",
      });
      expect(world.reached).toEqual([fix, `memory:${householdProject}`]);
    }).pipe(Effect.provide(world.layer));
  });

  it.live("still shows it to a caller on this machine without a grant", () => {
    const world = setup({ prefix: "studio-work-grant-personal-local-", legacy: [M4] });
    const errands = ThreadId.make("household-errands");
    world.addThread(errands, householdProject, codex);
    return Effect.gen(function* () {
      const listed = yield* world.call("studio_project_list", localScope, {});
      expect(
        (listed.projects as ReadonlyArray<{ id: string }>).map((project) => project.id),
      ).toContain(householdProject);
      expect(
        yield* world.call("studio_project_read", localScope, { projectId: householdProject }),
      ).toMatchObject({ id: householdProject, title: "Example Household" });
      yield* world.callThread("studio_thread_read", localScope, { threadId: errands });
      expect(world.reached).toEqual([errands]);
    }).pipe(Effect.provide(world.layer));
  });
});
