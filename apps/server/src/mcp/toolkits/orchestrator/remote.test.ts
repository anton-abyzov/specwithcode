import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ProjectService from "../../../project/ProjectService.ts";
import * as RemoteWorkers from "../../../fleet/RemoteWorkers.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import * as ThreadMetadataMcpService from "../../ThreadMetadataMcpService.ts";
import * as OrchestratorHandlers from "./handlers.ts";
import { OrchestratorToolkit } from "./tools.ts";

const callerId = ThreadId.make("coordinator");
const localOnly = new OrchestratorMcpFailure({ code: "invalid_request", message: "local" });
const providerInstanceId = ProviderInstanceId.make("codex");
const M1 = { id: "m1", label: "M1", environmentId: EnvironmentId.make("env-m1") };

const remoteThread = {
  threadId: "b-thread",
  projectId: "remote-project",
  title: "Worker",
  createdBy: "agent",
  creationSource: "mcp",
  status: "completed",
  latestRunId: "b-run",
  activeRunId: null,
  providerInstanceId: "codex",
  model: "gpt-5.5",
  runtimeMode: "auto",
  interactionMode: "default",
  linkedPullRequest: null,
  titleRegeneration: null,
  branch: null,
  worktreePath: null,
  parentThreadId: null,
  relationshipToParent: null,
  runCount: 1,
  itemCount: 2,
  pendingRequestCount: 0,
  archived: false,
  settled: true,
  settledAt: null,
  createdAt: "2026-10-12T00:00:00.000Z",
  updatedAt: "2026-10-12T00:00:00.000Z",
};

const setup = (
  options: {
    readonly workerMachine?: boolean;
    readonly callerMode?: string;
    /** An outside MCP client approved here (read-only), not a Studio thread. */
    readonly outside?: boolean;
    /** Resolve thread links the way a server without a fleet does. */
    readonly realResolve?: boolean;
    /** The caller runs in this machine's personal assistant. */
    readonly personal?: boolean;
  } = {},
) => {
  const caller = {
    id: callerId,
    projectId: ProjectId.make("project"),
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
    runtimeMode: options.callerMode ?? "full-access",
    interactionMode: "default",
    activeRunId: "active-run",
    archivedAt: null,
    deletedAt: null,
  } as OrchestrationV2ThreadShell;
  const proxied: Array<{ tool: string; arguments: Record<string, unknown> }> = [];
  const local: string[] = [];
  const finished: unknown[] = [];
  const remote: RemoteWorkers.RemoteWorkersShape = {
    ...RemoteWorkers.RemoteWorkers.defaultValue(),
    enabled: true,
    resolveMachine: (target) =>
      target === undefined || target === "local"
        ? Effect.succeed({ kind: "local" })
        : Effect.succeed({ kind: "remote", machine: M1 }),
    resolveThread: options.realResolve
      ? RemoteWorkers.RemoteWorkers.defaultValue().resolveThread
      : ({ machine, threadId }) =>
          Effect.succeed(
            machine === "m1" || threadId.startsWith("studio://thread/env-m1/")
              ? {
                  target: { kind: "remote", machine: M1 },
                  threadId: ThreadId.make(threadId.replace("studio://thread/env-m1/", "")),
                }
              : { target: { kind: "local" }, threadId: ThreadId.make(threadId) },
          ),
    proxy: (input) =>
      Effect.sync(() => {
        proxied.push({ tool: input.tool, arguments: input.arguments });
        const answers: Record<string, Record<string, unknown>> = {
          studio_thread_read: {
            thread: remoteThread,
            recentRuns: [],
            items: [],
            nextPosition: null,
            hasMore: false,
          },
          studio_thread_wait: {
            threadId: "b-thread",
            runId: "b-run",
            status: "completed",
            timedOut: false,
          },
          studio_thread_list: {
            projectId: "remote-project",
            currentThreadId: null,
            threads: [
              {
                threadId: "b-thread",
                title: "Worker",
                // A link the other machine made names a thread there, not here.
                threadLink: "[Worker](studio://thread/b-thread)",
                createdBy: "agent",
                creationSource: "mcp",
                status: "idle",
                latestRunId: null,
                providerInstanceId: "codex",
                model: "gpt-5.5",
                runtimeMode: "auto",
                interactionMode: "default",
                linkedPullRequest: null,
                settled: true,
                settledAt: null,
                parentThreadId: null,
                relationshipToParent: null,
                itemCount: 0,
                createdAt: "2026-10-12T00:00:00.000Z",
                updatedAt: "2026-10-12T00:00:00.000Z",
              },
            ],
            nextCursor: null,
            total: 1,
          },
          studio_thread_send: {
            threadId: "b-thread",
            threadLink: "[Worker](studio://thread/b-thread)",
            messageId: "message",
            runId: "b-run-2",
            status: "queued",
            delivery: "queued",
          },
        };
        return { ...answers[input.tool], machine: input.machine };
      }),
    noteFinished: (input) =>
      Effect.sync(() => {
        finished.push(input);
      }),
    coordinatorWorkerMachine: () =>
      Effect.succeed(
        options.workerMachine
          ? { machineId: "m1", environmentId: M1.environmentId, projectId: null }
          : null,
      ),
  };
  const layerDependencies = Layer.mergeAll(
    Layer.succeed(RemoteWorkers.RemoteWorkers, remote),
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("env-m4"),
      requestNamespace: "session",
      thread: options.outside
        ? undefined
        : { threadId: callerId, providerSessionId: "session", providerInstanceId },
      client: options.outside
        ? { sessionId: "s", label: "Outside agent", access: "read-only" }
        : undefined,
      issuedAt: 0,
      capabilities: new Set(["orchestration" as const]),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (id) =>
        Effect.succeed(
          id === callerId
            ? caller
            : id === "hot"
              ? ({
                  ...caller,
                  id: ThreadId.make("hot"),
                  runtimeMode: "full-access",
                  activeRunId: null,
                } as OrchestrationV2ThreadShell)
              : null,
        ),
    }),
    Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({
      // Recorded, then refused, so the test needs no full local results.
      readThread: (_scope, input) =>
        Effect.suspend(() => {
          local.push(`read:${input.threadId}`);
          return Effect.fail(localOnly);
        }),
      sendToThread: (_scope, input) =>
        Effect.suspend(() => {
          local.push(`send:${input.threadId}`);
          return Effect.fail(localOnly);
        }),
      delegateTask: (_scope, input) =>
        Effect.suspend(() => {
          local.push(`delegate:${"machine" in input}`);
          return Effect.fail(localOnly);
        }),
    }),
    Layer.mock(ThreadMetadataMcpService.ThreadMetadataMcpService)({}),
    Layer.mock(ProjectService.ProjectService)({
      getById: (id) =>
        Effect.succeed(
          Option.some({
            id,
            title: options.personal ? "Aide" : "App",
            workspaceSettings: { kind: options.personal ? "personal" : "code" },
          } as never),
        ),
    }),
  );
  const call = (tool: string, params: Record<string, unknown>) =>
    OrchestratorToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(OrchestratorHandlers.layer).pipe(
          Layer.provide(layerDependencies),
        ),
      ),
      Effect.flatMap((toolkit) =>
        toolkit
          .handle(tool as never, params as never)
          .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies)),
      ),
      Effect.map((results) => results.at(-1)?.result as unknown as Record<string, unknown>),
    );
  return { call, proxied, local, finished };
};

it.effect("reads and waits on a thread on another machine by machine or link", () => {
  const { call, proxied, local, finished } = setup();
  return Effect.gen(function* () {
    const read = yield* call("studio_thread_read", { threadId: "studio://thread/env-m1/b-thread" });
    expect(read).toMatchObject({ machine: M1, thread: { threadId: "b-thread" } });
    expect(proxied[0]).toEqual({ tool: "studio_thread_read", arguments: { threadId: "b-thread" } });
    const waited = yield* call("studio_thread_wait", { machine: "m1", threadId: "b-thread" });
    expect(waited).toMatchObject({ machine: M1, status: "completed" });
    expect(proxied[1]?.arguments).toMatchObject({ threadId: "b-thread", timeoutMs: 600_000 });
    expect(finished).toEqual([
      {
        callerThreadId: "coordinator",
        machineId: "m1",
        remoteThreadId: "b-thread",
        runId: "b-run",
        status: "completed",
      },
    ]);
    yield* call("studio_thread_read", { threadId: "local-thread" });
    expect(local).toEqual(["read:local-thread"]);
  });
});

it.effect("lists another machine's threads with links that name that machine", () => {
  const { call } = setup();
  return Effect.gen(function* () {
    const listed = yield* call("studio_thread_list", {
      machine: "m1",
      projectId: "remote-project",
    });
    expect(listed).toMatchObject({
      machine: M1,
      threads: [{ threadId: "b-thread", threadLink: "[Worker](studio://thread/env-m1/b-thread)" }],
    });
  });
});

it.effect("sends to another machine's thread with a link that names that machine", () => {
  const { call } = setup();
  return Effect.gen(function* () {
    const sent = yield* call("studio_thread_send", {
      machine: "m1",
      threadId: "b-thread",
      message: "More",
    });
    expect(sent).toMatchObject({
      machine: M1,
      threadLink: "[Worker](studio://thread/env-m1/b-thread)",
    });
  });
});

it.effect("never sends a personal assistant's words to another machine", () => {
  const { call, proxied } = setup({ personal: true });
  return Effect.gen(function* () {
    const refused = yield* call("studio_thread_send", {
      machine: "m1",
      threadId: "b-thread",
      message: "Here is the household budget",
    });
    expect(refused).toMatchObject({ code: "invalid_request" });
    expect(String(refused.message)).toContain("private to its machine");
    expect(proxied.map((entry) => entry.tool)).not.toContain("studio_thread_send");
  });
});

it.effect("never sends to a remote thread running with broader modes than the caller", () => {
  const { call, proxied } = setup({ callerMode: "approval-required" });
  return Effect.gen(function* () {
    const refused = yield* call("studio_thread_send", {
      machine: "m1",
      threadId: "b-thread",
      message: "More",
    });
    expect(refused).toMatchObject({ code: "runtime_mode_escalation_denied" });
    expect(proxied.map((entry) => entry.tool)).toEqual(["studio_thread_read"]);
  });
});

it.effect("keeps delegate_task on this machine and asks a routed coordinator to choose", () => {
  const plain = setup();
  const routed = setup({ workerMachine: true });
  return Effect.gen(function* () {
    expect(yield* plain.call("delegate_task", { task: "x", machine: "m1" })).toMatchObject({
      code: "delegation_is_local",
    });
    expect(yield* routed.call("delegate_task", { task: "x" })).toMatchObject({
      code: "worker_machine_set",
    });
    yield* routed.call("delegate_task", { task: "x", machine: "local" });
    expect(routed.local).toEqual(["delegate:false"]);
  });
});

it.effect("keeps outside clients approved here away from the other machine", () => {
  const { call, proxied, finished } = setup({ outside: true });
  return Effect.gen(function* () {
    for (const [tool, params] of [
      ["studio_thread_read", { machine: "m1", threadId: "any-thread-there" }],
      ["studio_thread_list", { machine: "m1", projectId: "unrelated-project" }],
      ["studio_thread_wait", { machine: "m1", threadId: "b-thread" }],
    ] as const)
      expect(yield* call(tool, params)).toMatchObject({ code: "capability_denied" });
    expect(proxied).toEqual([]);
    // Nor can such a caller mark a coordinator's worker as seen and drop its wake.
    expect(finished).toEqual([]);
  });
});

it.effect("checks the thread a link names before sending to it here", () => {
  const { call, local } = setup({ callerMode: "approval-required", realResolve: true });
  return Effect.gen(function* () {
    for (const threadId of ["hot", "studio://thread/hot"])
      expect(yield* call("studio_thread_send", { threadId, message: "x" })).toMatchObject({
        code: "runtime_mode_escalation_denied",
      });
    expect(local).toEqual([]);
  });
});
