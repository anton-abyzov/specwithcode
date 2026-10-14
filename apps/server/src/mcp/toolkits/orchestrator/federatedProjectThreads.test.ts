import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  EnvironmentId,
  OrchestratorMcpFailure,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type LogicalProject,
  type LogicalProjectMember,
  type OrchestrationV2ThreadShell,
  type OrchestratorMcpThreadListInput,
  type OrchestratorMcpThreadListItem,
  type OrchestratorMcpThreadListResult,
  type Project,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as RemoteWorkers from "../../../fleet/RemoteWorkers.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import { projectFixture } from "../../../project/ProjectWorkspace.testkit.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import { listProjectThreadInventory } from "../../OrchestratorMcpThreadList.ts";
import { collectMemberThreads, listFederatedProjectThreads } from "./federatedProjectThreads.ts";
import * as Handlers from "./handlers.ts";
import { OrchestratorToolkit } from "./tools.ts";

const provider = ProviderInstanceId.make("codex");
const member = (machine: string, project = machine): LogicalProjectMember => ({
  environmentId: EnvironmentId.make(`env-${machine}`),
  projectId: ProjectId.make(`project-${project}`),
  coordinatorThreadId: ThreadId.make(`coordinator-${project}`),
});
const local = member("m4");
const m1 = member("m1");
const m3 = member("m3");
const machineOf = (binding: LogicalProjectMember) => ({
  id: binding.environmentId.replace("env-", ""),
  label: binding.environmentId,
  environmentId: binding.environmentId,
});
const thread = (id: string, minute = 1): OrchestratorMcpThreadListItem => ({
  threadId: ThreadId.make(id),
  title: id,
  threadLink: `[${id}](studio://thread/${id})`,
  createdBy: "agent",
  creationSource: "mcp",
  status: "completed",
  latestRunId: null,
  providerInstanceId: provider,
  model: "gpt-6.1-sol",
  runtimeMode: "auto",
  interactionMode: "default",
  linkedPullRequest: null,
  settled: true,
  settledAt: null,
  parentThreadId: null,
  relationshipToParent: null,
  itemCount: 2,
  archived: false,
  createdAt: "2026-10-13T00:00:00Z",
  updatedAt: new Date(1791849600000 + minute * 60_000).toISOString(),
});
const pageOf = (
  binding: LogicalProjectMember,
  threads: readonly OrchestratorMcpThreadListItem[],
  input: OrchestratorMcpThreadListInput,
): OrchestratorMcpThreadListResult => {
  const cursor = input.cursor ?? 0;
  const end = cursor + (input.limit ?? 50);
  return {
    projectId: binding.projectId,
    currentThreadId: null,
    includeArchived: input.includeArchived === true,
    threads: threads.slice(cursor, end),
    total: threads.length,
    nextCursor: end < threads.length ? end : null,
  };
};

function setup(
  options: {
    members?: readonly LogicalProjectMember[];
    rows?: Record<string, readonly OrchestratorMcpThreadListItem[]>;
    outside?: boolean;
    worker?: boolean;
    offline?: string;
    revoked?: string;
    alien?: string;
    duplicateRemoteMember?: boolean;
    oldServer?: boolean;
    wrongRowProject?: boolean;
  } = {},
) {
  const logical: LogicalProject = {
    id: "logical-one",
    title: "SpecWeave",
    coordinatorId: "one-coordinator",
    members: options.members ?? [local, m1],
  };
  const project = (binding: LogicalProjectMember): Project =>
    projectFixture(binding.projectId, {
      workspaceSettings: {
        ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
        coordinatorThreadId: binding.coordinatorThreadId,
        logicalProject: logical,
      },
    });
  const caller = {
    id: options.worker ? ThreadId.make("worker") : local.coordinatorThreadId,
    projectId: local.projectId,
    providerInstanceId: provider,
    modelSelection: { instanceId: provider, model: "gpt-6.1-sol" },
    runtimeMode: "auto",
    interactionMode: "default",
    activeRunId: "run",
    archivedAt: null,
    deletedAt: null,
  } as OrchestrationV2ThreadShell;
  const requests: Array<{
    tool: string;
    projectId?: unknown;
    machine?: unknown;
    includeArchived?: unknown;
  }> = [];
  const localRequests: OrchestratorMcpThreadListInput[] = [];
  const rows = options.rows ?? {
    [local.projectId]: [thread("same-id", 1)],
    [m1.projectId]: [{ ...thread("same-id", 2), archived: true }],
  };
  const remote: RemoteWorkers.RemoteWorkersShape = {
    ...RemoteWorkers.RemoteWorkers.defaultValue(),
    enabled: true,
    resolveMachine: (target) =>
      target === undefined || target === "local"
        ? Effect.succeed({ kind: "local" })
        : Effect.succeed({
            kind: "remote",
            machine: machineOf(
              logical.members.find((binding) => binding.environmentId === target)!,
            ),
          }),
    proxy: ({ machine, tool, arguments: args }) =>
      Effect.gen(function* () {
        requests.push({ tool, ...args });
        if (options.offline === machine.environmentId || options.revoked === machine.environmentId)
          return yield* new OrchestratorMcpFailure({
            code: options.revoked ? "machine_not_authorized" : "machine_unreachable",
            message: "Machine unavailable",
          });
        const binding = logical.members.find(
          (candidate) => candidate.projectId === args.projectId,
        )!;
        if (tool === "studio_project_read") {
          const result = project(binding);
          if (options.duplicateRemoteMember)
            return {
              ...result,
              workspaceSettings: {
                ...result.workspaceSettings,
                logicalProject: { ...logical, members: [...logical.members, binding] },
              },
            };
          return options.alien === machine.environmentId
            ? {
                ...result,
                workspaceSettings: {
                  ...result.workspaceSettings,
                  logicalProject: { ...logical, id: "unrelated-same-repository" },
                },
              }
            : { ...result };
        }
        const result = pageOf(
          binding,
          rows[binding.projectId] ?? [],
          args as OrchestratorMcpThreadListInput,
        );
        if (options.wrongRowProject)
          return {
            ...result,
            threads: result.threads.map((row) => ({ ...row, projectId: "unrelated" })),
          };
        return options.oldServer ? { ...result, includeArchived: undefined } : { ...result };
      }),
  };
  const layer = Layer.mergeAll(
    Layer.succeed(RemoteWorkers.RemoteWorkers, remote),
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: local.environmentId,
      requestNamespace: "session",
      issuedAt: 0,
      thread: options.outside
        ? undefined
        : { threadId: caller.id, providerSessionId: "session", providerInstanceId: provider },
      client: options.outside
        ? { sessionId: "outside", label: "External client", access: "read-only" }
        : undefined,
      capabilities: new Set(["orchestration" as const]),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: () => Effect.succeed(caller),
    }),
    Layer.mock(ProjectService.ProjectService)({
      getById: (id) =>
        Effect.succeed(
          Option.some(
            project(logical.members.find((binding) => binding.projectId === id) ?? local),
          ),
        ),
    }),
    Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({
      listThreads: (_scope, input) =>
        Effect.sync(() => {
          localRequests.push(input);
          const binding =
            logical.members.find((candidate) => candidate.projectId === input.projectId) ?? local;
          return pageOf(binding, rows[binding.projectId] ?? [], input);
        }),
    }),
  );
  const list = (input: OrchestratorMcpThreadListInput = {}) =>
    listFederatedProjectThreads(input).pipe(Effect.provide(layer));
  const viaToolkit = (input: OrchestratorMcpThreadListInput = {}) =>
    OrchestratorToolkit.pipe(
      Effect.provide(McpToolAccess.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(layer))),
      Effect.flatMap((toolkit) =>
        toolkit
          .handle("studio_thread_list", input)
          .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layer)),
      ),
      Effect.map((results) => results.at(-1)!.result as OrchestratorMcpThreadListResult),
    );
  return { list, viaToolkit, requests, localRequests };
}

describe("canonical project thread inventory", () => {
  it.effect(
    "federates the coordinator tool by explicit bindings with compound identities and archived history",
    () =>
      Effect.gen(function* () {
        const fixture = setup();
        const result = yield* fixture.viaToolkit();
        expect(result).toMatchObject({
          logicalProjectId: "logical-one",
          total: 2,
          partial: false,
          includeArchived: true,
        });
        expect(
          result.threads.map((row) => [row.threadId, row.environmentId, row.archived]),
        ).toEqual([
          ["same-id", "env-m1", true],
          ["same-id", "env-m4", false],
        ]);
        expect(result.threads[0]!.threadRef).toBe("studio://thread/env-m1/same-id");
        expect(fixture.requests).toMatchObject([
          { tool: "studio_project_read", projectId: m1.projectId },
          {
            tool: "studio_thread_list",
            projectId: m1.projectId,
            machine: "local",
            includeArchived: true,
          },
        ]);
      }),
  );

  it.effect("retains reachable results and names offline and revoked members as unavailable", () =>
    Effect.gen(function* () {
      for (const blocked of [{ offline: m3.environmentId }, { revoked: m3.environmentId }]) {
        const result = yield* setup({ members: [local, m1, m3], ...blocked }).list();
        expect(result).toMatchObject({ total: 2, partial: true });
        expect(
          result.members?.find((binding) => binding.environmentId === m3.environmentId),
        ).toMatchObject({ status: "unavailable" });
        expect(result.threads).toHaveLength(2);
      }
    }),
  );

  it.effect("refuses an unrelated logical project before requesting any threads", () =>
    Effect.gen(function* () {
      const fixture = setup({ alien: m1.environmentId });
      const result = yield* fixture.list();
      expect(result).toMatchObject({ partial: true, total: 1 });
      expect(fixture.requests.map((request) => request.tool)).toEqual(["studio_project_read"]);
      expect(result.members?.[1]).toMatchObject({ status: "unavailable", code: "invalid_request" });
    }),
  );

  it.effect("never federates outside clients, ordinary workers or explicit local calls", () =>
    Effect.gen(function* () {
      for (const options of [{ outside: true }, { worker: true }, {}]) {
        const fixture = setup(options);
        const result = yield* fixture.list(
          options.outside || options.worker ? {} : { machine: "local" },
        );
        expect(fixture.requests).toEqual([]);
        expect(result.logicalProjectId).toBeUndefined();
        expect(fixture.localRequests).toHaveLength(1);
      }
    }),
  );

  it.effect("keeps every distinct binding on a repeated machine transfer", () =>
    Effect.gen(function* () {
      const previous = member("m4", "previous");
      const fixture = setup({
        members: [local, m1, previous],
        rows: {
          [local.projectId]: [thread("new")],
          [m1.projectId]: [thread("middle")],
          [previous.projectId]: [thread("old")],
        },
      });
      const result = yield* fixture.list();
      expect(result).toMatchObject({ total: 3, partial: false });
      expect(result.members).toHaveLength(3);
      expect(new Set(result.threads.map((row) => row.projectId))).toEqual(
        new Set([local.projectId, m1.projectId, previous.projectId]),
      );
      expect(
        fixture.requests.filter((request) => request.tool === "studio_thread_list"),
      ).toHaveLength(1);
    }),
  );

  it.effect("rejects malformed remote metadata with duplicate project bindings", () =>
    Effect.gen(function* () {
      const fixture = setup({ duplicateRemoteMember: true });
      const result = yield* fixture.list();
      expect(result).toMatchObject({ total: 1, partial: true });
      expect(result.members?.[1]).toMatchObject({
        environmentId: m1.environmentId,
        projectId: m1.projectId,
        status: "unavailable",
        code: "invalid_request",
      });
      expect(fixture.requests.map((request) => request.tool)).toEqual(["studio_project_read"]);
    }),
  );

  it.effect("paginates the globally sorted inventory past a remote page boundary", () =>
    Effect.gen(function* () {
      const rows = {
        [local.projectId]: Array.from({ length: 140 }, (_, i) => thread(`local-${i}`, 300 - i * 2)),
        [m1.projectId]: Array.from({ length: 140 }, (_, i) => thread(`remote-${i}`, 299 - i * 2)),
      };
      const result = yield* setup({ rows }).list({ cursor: 220, limit: 10 });
      expect(result).toMatchObject({ total: 280, nextCursor: 230, partial: false });
      expect(result.threads.map((row) => row.threadId)).toEqual(
        Array.from(
          { length: 10 },
          (_, i) => `${i % 2 === 0 ? "local" : "remote"}-${110 + Math.floor(i / 2)}`,
        ),
      );
    }),
  );

  it.effect("explicitly reports old archive support and rejects rows from another binding", () =>
    Effect.gen(function* () {
      const old = yield* setup({ oldServer: true }).list();
      expect(old).toMatchObject({ partial: true });
      expect(old.members?.[1]).toMatchObject({
        status: "partial",
        code: "archive_inventory_unsupported",
      });
      const bad = yield* setup({ wrongRowProject: true }).list();
      expect(bad).toMatchObject({ partial: true, total: 1 });
      expect(bad.members?.[1]?.status).toBe("unavailable");
    }),
  );

  it.effect("reports bounded pagination instead of silently claiming complete inventory", () =>
    Effect.gen(function* () {
      let pages = 0;
      const result = yield* collectMemberThreads({
        member: m1,
        machine: machineOf(m1),
        input: { cursor: 2050 },
        fetchPage: (input) =>
          Effect.sync(() => {
            pages++;
            const cursor = input.cursor ?? 0;
            return {
              projectId: m1.projectId,
              currentThreadId: null,
              threads: Array.from({ length: 100 }, (_, i) => thread(`thread-${cursor + i}`)),
              total: 5000,
              nextCursor: cursor + 100,
            };
          }),
      });
      expect(pages).toBe(20);
      expect(result.member).toMatchObject({ status: "partial", code: "inventory_page_limit" });
    }),
  );

  it.effect("reads archived shells only in the requested project and preserves filters", () =>
    Effect.gen(function* () {
      const shell = (id: string, changes: Partial<OrchestrationV2ThreadShell> = {}) =>
        ({
          id: ThreadId.make(id),
          projectId: local.projectId,
          title: id,
          status: "idle",
          activityRunStatus: null,
          latestRunId: null,
          modelSelection: { instanceId: provider, model: "gpt-6.1-sol" },
          runtimeMode: "auto",
          interactionMode: "default",
          createdBy: "agent",
          creationSource: "mcp",
          settledOverride: "settled",
          settledAt: null,
          lineage: { parentThreadId: null, relationshipToParent: null },
          visibleItemCount: 0,
          createdAt: DateTime.makeUnsafe("2026-10-13T00:00:00Z"),
          updatedAt: DateTime.makeUnsafe("2026-10-13T00:00:00Z"),
          archivedAt: DateTime.makeUnsafe("2026-10-13T00:00:00Z"),
          deletedAt: null,
          ...changes,
        }) as OrchestrationV2ThreadShell;
      const result = yield* listProjectThreadInventory({
        projectId: local.projectId,
        currentThreadId: local.coordinatorThreadId,
        input: { includeArchived: true, includeSubagents: false, settled: true },
        threadManagement: {
          listProjectThreads: () => Effect.succeed([shell("active", { archivedAt: null })]),
          getShellSnapshot: () =>
            Effect.succeed({
              threads: [
                shell("archive"),
                shell("other", { projectId: m1.projectId }),
                shell("deleted", { deletedAt: DateTime.makeUnsafe("2026-10-13T00:00:00Z") }),
                shell("subagent", {
                  lineage: {
                    parentThreadId: local.coordinatorThreadId,
                    relationshipToParent: "subagent",
                  } as OrchestrationV2ThreadShell["lineage"],
                }),
              ],
            } as never),
        },
      });
      expect(result).toMatchObject({ total: 2, includeArchived: true });
      expect(result.threads.map((row) => [row.threadId, row.archived])).toEqual([
        ["archive", true],
        ["active", false],
      ]);
    }),
  );
});
