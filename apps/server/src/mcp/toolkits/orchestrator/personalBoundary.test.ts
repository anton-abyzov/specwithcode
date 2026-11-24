import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  EnvironmentId,
  OrchestratorMcpFailure,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type OrchestratorMcpThreadListInput,
  type OrchestratorMcpThreadListResult,
  type Project,
} from "@specweave-studio/contracts";
import { PERSONAL_ASSISTANT_PRIVATE_MESSAGE } from "@specweave-studio/shared/personalAssistant";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as GitWorkflow from "../../../git/GitWorkflowService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import { ProjectOperationError } from "../../../project/ProjectService.ts";
import { projectFixture } from "../../../project/ProjectWorkspace.testkit.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import { assertPersonalThreadReadable } from "../../threadAccess.ts";
import * as ProjectHandlers from "../project/handlers.ts";
import { ProjectToolkit } from "../project/tools.ts";
import * as WorktreeHandlers from "../worktree/handlers.ts";
import { WorktreeToolkit } from "../worktree/tools.ts";
import * as Handlers from "./handlers.ts";
import { OrchestratorToolkit } from "./tools.ts";

const provider = ProviderInstanceId.make("codex");
const environmentId = EnvironmentId.make("env-here");
const personal = ProjectId.make("project-percy");
const code = ProjectId.make("project-code");
const broken = ProjectId.make("project-unreadable");

const projectOf = (id: ProjectId): Project =>
  projectFixture(id, {
    workspaceSettings: {
      ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
      ...(id === personal ? { kind: "personal" as const } : {}),
    },
  });

const projectsLayer = Layer.mock(ProjectService.ProjectService)({
  getById: (id) =>
    id === broken
      ? Effect.fail(
          new ProjectOperationError({
            operation: "read-project",
            projectId: id,
            cause: "storage down",
          }),
        )
      : Effect.succeed(Option.some(projectOf(id))),
});

const refusal = (reason: "capability_denied" | "outside_grant_scope") =>
  expect.objectContaining({
    _tag: "OrchestratorMcpFailure",
    code: reason,
    message: expect.stringContaining(PERSONAL_ASSISTANT_PRIVATE_MESSAGE),
  });

describe("assertPersonalThreadReadable", () => {
  const check = (
    callerProjectId: ProjectId | undefined,
    targetProjectId: ProjectId,
    isRemoteCoordinator: boolean,
  ) =>
    assertPersonalThreadReadable(callerProjectId, targetProjectId, isRemoteCoordinator).pipe(
      Effect.provide(projectsLayer),
    );

  it.effect("lets a local caller read its own personal project", () =>
    Effect.gen(function* () {
      yield* check(personal, personal, false);
    }),
  );

  it.effect("lets a local caller without a calling project read the personal project", () =>
    Effect.gen(function* () {
      yield* check(undefined, personal, false);
    }),
  );

  it.effect("refuses another project's thread reading the personal project", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(check(code, personal, false));
      expect(error).toBeInstanceOf(OrchestratorMcpFailure);
      expect(error).toEqual(refusal("capability_denied"));
    }),
  );

  it.effect("refuses a remote coordinator, even naming the personal project as its own", () =>
    Effect.gen(function* () {
      expect(yield* Effect.flip(check(personal, personal, true))).toEqual(
        refusal("outside_grant_scope"),
      );
      expect(yield* Effect.flip(check(undefined, personal, true))).toEqual(
        refusal("outside_grant_scope"),
      );
    }),
  );

  it.effect("fails closed when the target project cannot be read on a cross-project read", () =>
    Effect.gen(function* () {
      expect(yield* Effect.flip(check(code, broken, false))).toEqual(refusal("capability_denied"));
      expect(yield* Effect.flip(check(undefined, broken, true))).toEqual(
        refusal("outside_grant_scope"),
      );
    }),
  );

  it.effect("does not consult the project store for a same-project local read", () =>
    Effect.gen(function* () {
      // Same project: no lookup, so even an unreadable store does not refuse.
      yield* check(broken, broken, false);
    }),
  );

  it.effect("allows cross-project and remote reads of a non-personal project", () =>
    Effect.gen(function* () {
      yield* check(personal, code, false);
      yield* check(undefined, code, true);
    }),
  );
});

describe("orchestrator thread tools guard the personal assistant", () => {
  const shellOf = (id: string, projectId: ProjectId) =>
    ({
      id: ThreadId.make(id),
      projectId,
      providerInstanceId: provider,
      modelSelection: { instanceId: provider, model: "gpt-6.1-sol" },
      runtimeMode: "auto",
      interactionMode: "default",
      activeRunId: "run",
      archivedAt: null,
      deletedAt: null,
    }) as unknown as OrchestrationV2ThreadShell;
  const shells: Record<string, OrchestrationV2ThreadShell> = {
    "caller-code": shellOf("caller-code", code),
    "caller-percy": shellOf("caller-percy", personal),
    "percy-thread": shellOf("percy-thread", personal),
    "code-thread": shellOf("code-thread", code),
  };

  function setup(
    caller: { readonly thread: string } | { readonly client: "local" | "coordinator" },
    /** The project the local list reports, when it differs from the one asked for. */
    listedProjectId?: ProjectId,
  ) {
    const reads: string[] = [];
    const lists: OrchestratorMcpThreadListInput[] = [];
    const callerShell = "thread" in caller ? shells[caller.thread]! : undefined;
    const layer = Layer.mergeAll(
      projectsLayer,
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getDescriptor: Effect.succeed({ environmentId, label: "Here" } as never),
      }),
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId,
        requestNamespace: "session",
        issuedAt: 0,
        thread:
          callerShell === undefined
            ? undefined
            : {
                threadId: callerShell.id,
                providerSessionId: "session",
                providerInstanceId: provider,
              },
        client:
          "client" in caller
            ? {
                sessionId: "outside",
                label: "External client",
                access: "read-only",
                ...(caller.client === "coordinator"
                  ? {
                      principal: {
                        kind: "coordinator" as const,
                        environmentId: EnvironmentId.make("env-other"),
                      },
                    }
                  : {}),
              }
            : undefined,
        capabilities: new Set(["orchestration" as const]),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (id) => Effect.succeed(shells[id] ?? null),
      }),
      Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({
        listThreads: (_scope, input) =>
          Effect.sync(() => {
            lists.push(input);
            return {
              projectId: listedProjectId ?? input.projectId ?? callerShell?.projectId ?? code,
              currentThreadId: null,
              includeArchived: false,
              threads: [],
              total: 0,
              nextCursor: null,
            } as OrchestratorMcpThreadListResult;
          }),
        // The guard passed: the read itself answers with a marker failure.
        readThread: (_scope, input) =>
          Effect.suspend(() => {
            reads.push(input.threadId);
            return Effect.fail(
              new OrchestratorMcpFailure({ code: "invalid_request", message: "read reached" }),
            );
          }),
      }),
    );
    const call = (tool: "studio_thread_list" | "studio_thread_read", input: object) =>
      OrchestratorToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(layer)),
        ),
        Effect.flatMap((toolkit) =>
          toolkit
            .handle(tool, input as never)
            .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layer)),
        ),
        Effect.map((results) => results.at(-1)!),
      );
    /** Tools return failures as results (failureMode "return"). */
    const refused = (tool: "studio_thread_list" | "studio_thread_read", input: object) =>
      call(tool, input).pipe(
        Effect.map((last) => {
          expect(last.isFailure).toBe(true);
          return last.result;
        }),
      );
    const allowed = (tool: "studio_thread_list" | "studio_thread_read", input: object) =>
      call(tool, input).pipe(
        Effect.map((last) => {
          if (tool === "studio_thread_read") {
            expect(last.result).toMatchObject({ code: "invalid_request", message: "read reached" });
          } else {
            expect(last.isFailure).toBe(false);
          }
        }),
      );
    return { refused, allowed, reads, lists };
  }

  it.effect("studio_thread_read refuses another project's thread reading Percy's thread", () =>
    Effect.gen(function* () {
      const fixture = setup({ thread: "caller-code" });
      const error = yield* fixture.refused("studio_thread_read", { threadId: "percy-thread" });
      expect(error).toEqual(refusal("capability_denied"));
      expect(fixture.reads).toEqual([]);
    }),
  );

  it.effect("studio_thread_read refuses a remote coordinator client", () =>
    Effect.gen(function* () {
      const fixture = setup({ client: "coordinator" });
      const error = yield* fixture.refused("studio_thread_read", { threadId: "percy-thread" });
      expect(error).toEqual(refusal("outside_grant_scope"));
      expect(fixture.reads).toEqual([]);
    }),
  );

  it.effect("studio_thread_read lets Percy's own thread and a local client read it", () =>
    Effect.gen(function* () {
      const own = setup({ thread: "caller-percy" });
      yield* own.allowed("studio_thread_read", { threadId: "percy-thread" });
      expect(own.reads).toEqual(["percy-thread"]);
      const local = setup({ client: "local" });
      yield* local.allowed("studio_thread_read", { threadId: "percy-thread" });
      expect(local.reads).toEqual(["percy-thread"]);
    }),
  );

  it.effect("studio_thread_read lets Percy read an ordinary project's thread", () =>
    Effect.gen(function* () {
      const fixture = setup({ thread: "caller-percy" });
      yield* fixture.allowed("studio_thread_read", { threadId: "code-thread" });
      expect(fixture.reads).toEqual(["code-thread"]);
    }),
  );

  it.effect("studio_thread_list refuses another project listing Percy before listing", () =>
    Effect.gen(function* () {
      const fixture = setup({ thread: "caller-code" });
      const error = yield* fixture.refused("studio_thread_list", {
        projectId: personal,
        machine: "local",
      });
      expect(error).toEqual(refusal("capability_denied"));
      expect(fixture.lists).toEqual([]);
    }),
  );

  it.effect("studio_thread_list refuses a remote coordinator listing Percy", () =>
    Effect.gen(function* () {
      const fixture = setup({ client: "coordinator" });
      const error = yield* fixture.refused("studio_thread_list", {
        projectId: personal,
        machine: "local",
      });
      expect(error).toEqual(refusal("outside_grant_scope"));
      expect(fixture.lists).toEqual([]);
    }),
  );

  it.effect("studio_thread_list refuses a list that resolves to Percy's project", () =>
    Effect.gen(function* () {
      // No projectId: the pre-list guard passes, the listed project is checked after.
      const fixture = setup({ thread: "caller-code" }, personal);
      const error = yield* fixture.refused("studio_thread_list", { machine: "local" });
      expect(error).toEqual(refusal("capability_denied"));
      expect(fixture.lists).toHaveLength(1);
    }),
  );

  it.effect("studio_thread_list allows Percy's own list and an ordinary project's list", () =>
    Effect.gen(function* () {
      const own = setup({ thread: "caller-percy" });
      yield* own.allowed("studio_thread_list", { machine: "local" });
      expect(own.lists).toHaveLength(1);
      const other = setup({ thread: "caller-code" });
      yield* other.allowed("studio_thread_list", { projectId: code, machine: "local" });
      expect(other.lists).toHaveLength(1);
      const remote = setup({ client: "coordinator" });
      yield* remote.allowed("studio_thread_list", { projectId: code, machine: "local" });
      expect(remote.lists).toHaveLength(1);
    }),
  );
});

describe("project and worktree tools guard the personal assistant", () => {
  const shellOf = (id: string, projectId: ProjectId) =>
    ({
      id: ThreadId.make(id),
      projectId,
      providerInstanceId: provider,
      modelSelection: { instanceId: provider, model: "gpt-6.1-sol" },
      runtimeMode: "auto",
      interactionMode: "default",
      activeRunId: "run",
      archivedAt: null,
      deletedAt: null,
      worktreePath: null,
    }) as unknown as OrchestrationV2ThreadShell;
  const shells: Record<string, OrchestrationV2ThreadShell> = {
    "caller-code": shellOf("caller-code", code),
    "caller-percy": shellOf("caller-percy", personal),
    "percy-thread": shellOf("percy-thread", personal),
    "code-thread": shellOf("code-thread", code),
  };

  function setup(
    caller: { readonly thread: string } | { readonly client: "local" | "coordinator" },
  ) {
    const gitCalls: string[] = [];
    const callerShell = "thread" in caller ? shells[caller.thread]! : undefined;
    const layer = Layer.mergeAll(
      projectsLayer,
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId,
        requestNamespace: "session",
        issuedAt: 0,
        thread:
          callerShell === undefined
            ? undefined
            : {
                threadId: callerShell.id,
                providerSessionId: "session",
                providerInstanceId: provider,
              },
        client:
          "client" in caller
            ? {
                sessionId: "outside",
                label: "External client",
                access: "read-only",
                ...(caller.client === "coordinator"
                  ? {
                      principal: {
                        kind: "coordinator" as const,
                        environmentId: EnvironmentId.make("env-other"),
                      },
                    }
                  : {}),
              }
            : undefined,
        capabilities: new Set(["orchestration" as const, "worktree" as const]),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (id) => Effect.succeed(shells[id] ?? null),
        getProjectThreadRecords: (input) =>
          Effect.succeed({ thread: shells[input.threadId]! } as never),
      }),
      Layer.mock(GitWorkflow.GitWorkflowService)({
        listRefs: (input) =>
          Effect.sync(() => {
            gitCalls.push(input.cwd);
            return {
              refs: [],
              isRepo: true,
              hasPrimaryRemote: false,
              nextCursor: null,
              totalCount: 0,
            };
          }),
      }),
    );
    const worktreeList = (threadId: string) =>
      WorktreeToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(WorktreeHandlers.layer).pipe(Layer.provide(layer)),
        ),
        Effect.flatMap((toolkit) =>
          toolkit
            .handle("studio_worktree_list", { threadId } as never)
            .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layer)),
        ),
        Effect.map((results) => results.at(-1)!),
      );
    const projectRead = (projectId: ProjectId) =>
      ProjectToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(layer)),
        ),
        Effect.flatMap((toolkit) =>
          toolkit
            .handle("studio_project_read", { projectId } as never)
            .pipe(
              Stream.unwrap,
              Stream.runCollect,
              Effect.provide(layer),
              Effect.provide(NodeCrypto.layer),
            ),
        ),
        Effect.map((results) => results.at(-1)!),
      );
    return { worktreeList, projectRead, gitCalls };
  }

  it.effect("studio_worktree_list refuses another project's thread naming Percy's thread", () =>
    Effect.gen(function* () {
      const fixture = setup({ thread: "caller-code" });
      const last = yield* fixture.worktreeList("percy-thread");
      expect(last.isFailure).toBe(true);
      expect(last.result).toEqual(refusal("capability_denied"));
      expect(fixture.gitCalls).toEqual([]);
    }),
  );

  it.effect("studio_worktree_list refuses a remote coordinator naming Percy's thread", () =>
    Effect.gen(function* () {
      const fixture = setup({ client: "coordinator" });
      const last = yield* fixture.worktreeList("percy-thread");
      expect(last.isFailure).toBe(true);
      expect(last.result).toEqual(refusal("outside_grant_scope"));
      expect(fixture.gitCalls).toEqual([]);
    }),
  );

  it.effect(
    "studio_worktree_list serves Percy's own thread, a local client and other projects",
    () =>
      Effect.gen(function* () {
        const own = setup({ thread: "caller-percy" });
        expect((yield* own.worktreeList("percy-thread")).isFailure).toBe(false);
        expect(own.gitCalls).toHaveLength(1);
        const local = setup({ client: "local" });
        expect((yield* local.worktreeList("percy-thread")).isFailure).toBe(false);
        expect(local.gitCalls).toHaveLength(1);
        const percyReadsCode = setup({ thread: "caller-percy" });
        expect((yield* percyReadsCode.worktreeList("code-thread")).isFailure).toBe(false);
        expect(percyReadsCode.gitCalls).toHaveLength(1);
      }),
  );

  it.effect("studio_project_read refuses another project's thread reading Percy's project", () =>
    Effect.gen(function* () {
      const last = yield* setup({ thread: "caller-code" }).projectRead(personal);
      expect(last.isFailure).toBe(true);
      expect(last.result).toEqual(refusal("capability_denied"));
    }),
  );

  it.effect("studio_project_read refuses a remote coordinator reading Percy's project", () =>
    Effect.gen(function* () {
      const last = yield* setup({ client: "coordinator" }).projectRead(personal);
      expect(last.isFailure).toBe(true);
      expect(last.result).toEqual(refusal("outside_grant_scope"));
    }),
  );

  it.effect("studio_project_read serves Percy's own thread, a local client and code projects", () =>
    Effect.gen(function* () {
      const own = yield* setup({ thread: "caller-percy" }).projectRead(personal);
      expect(own.isFailure).toBe(false);
      expect(own.result).toMatchObject({ id: personal });
      const local = yield* setup({ client: "local" }).projectRead(personal);
      expect(local.isFailure).toBe(false);
      const other = yield* setup({ thread: "caller-code" }).projectRead(code);
      expect(other.isFailure).toBe(false);
      expect(other.result).toMatchObject({ id: code });
    }),
  );
});
