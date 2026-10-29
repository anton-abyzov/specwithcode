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
import * as WorkGrants from "../../../fleet/WorkGrants.ts";
import { unscopedGrant } from "../../../fleet/workGrantPolicy.ts";
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

const AUDIT = ThreadId.make(
  "thread:delegated-task:command%3Amcp%3Ad25698a7-ed07-4574-a0b9-f1d8a6122b58%3Adelegate-task%3Aeasychamp-full-handoff-audit-20261022",
);
const missing = (threadId: string) =>
  new OrchestratorMcpFailure({
    code: "thread_not_found",
    message: `Thread ${threadId} was not found.`,
  });

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
    /** The outside client's approved access, read-only unless given. */
    readonly outsideAccess?: "read-only" | "approval-required" | "auto" | "full-access";
    /** The outside client is another machine's own credential (a worker grant here). */
    readonly machineCredential?: boolean;
    /** The outside client signs in as another machine, with grants off: by principal or label. */
    readonly otherMachine?: "principal" | "label";
    /** Resolve thread links the way a server without a fleet does. */
    readonly realResolve?: boolean;
    /** The caller runs in this machine's personal assistant. */
    readonly personal?: boolean;
    /** The caller runs another machine's work: the path that work came by. */
    readonly grantPath?: ReadonlyArray<string>;
    /** Threads on M1 the caller itself launched there. */
    readonly launched?: ReadonlyArray<string>;
    /** That work's grant was kept from before grants were scoped (the owner's own machine). */
    readonly legacy?: boolean;
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
    launchedBy: (input) =>
      Effect.succeed(
        input.launchedBy?.kind === "thread" &&
          input.launchedBy.threadId === callerId &&
          input.machineId === M1.id &&
          (options.launched ?? []).includes(input.remoteThreadId),
      ),
    coordinatorWorkerMachine: () =>
      Effect.succeed(
        options.workerMachine
          ? { machineId: "m1", environmentId: M1.environmentId, projectId: null }
          : null,
      ),
  };
  const grantPath = options.grantPath?.map((entry) => EnvironmentId.make(entry));
  const grants: WorkGrants.WorkGrantsShape = {
    ...(WorkGrants.WorkGrants.defaultValue() as WorkGrants.WorkGrantsShape),
    enabled: grantPath !== undefined || options.machineCredential === true,
    forClient: () =>
      Effect.succeed(
        options.machineCredential === true ? unscopedGrant(EnvironmentId.make("env-a")) : undefined,
      ),
    originOf: (thread) =>
      Effect.succeed(
        grantPath !== undefined && thread.id === callerId
          ? { coordinatorEnvironmentId: grantPath[0]!, path: grantPath, hops: grantPath.length }
          : undefined,
      ),
    forCoordinator: (environmentId) =>
      Effect.succeed(
        options.legacy === true
          ? { ...unscopedGrant(environmentId), legacy: true }
          : unscopedGrant(environmentId),
      ),
  };
  const layerDependencies = Layer.mergeAll(
    Layer.succeed(RemoteWorkers.RemoteWorkers, remote),
    Layer.succeed(WorkGrants.WorkGrants, grants),
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("env-m4"),
      requestNamespace: "session",
      thread: options.outside
        ? undefined
        : { threadId: callerId, providerSessionId: "session", providerInstanceId },
      client: options.outside
        ? {
            sessionId: "s",
            label:
              options.otherMachine === "label" ? "SpecWithCode workers · env-a" : "Outside agent",
            access: options.outsideAccess ?? "read-only",
            ...(options.otherMachine === "principal"
              ? {
                  principal: {
                    kind: "coordinator" as const,
                    environmentId: EnvironmentId.make("env-a"),
                  },
                }
              : {}),
          }
        : undefined,
      issuedAt: 0,
      capabilities: new Set(["orchestration" as const]),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (id) =>
        Effect.succeed(
          id === callerId
            ? caller
            : id === AUDIT
              ? ({ ...caller, id: AUDIT, activeRunId: "audit-run" } as OrchestrationV2ThreadShell)
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
          // Only the caller's own and "hot" exist; the real service reports any other as missing.
          return Effect.fail(
            input.threadId === callerId || input.threadId === "hot"
              ? localOnly
              : missing(input.threadId),
          );
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
        launchedBy: { kind: "thread", threadId: "coordinator" },
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

it.effect("refuses to send run-together words to another machine", () => {
  const { call, proxied } = setup();
  return Effect.gen(function* () {
    const refused = yield* call("studio_thread_send", {
      machine: "m1",
      threadId: "b-thread",
      message:
        "Owneranswersresolvedidentity; no renewedquestion. Neednormalreviewedmerge/deploythenactualall7livePASS; notclaimingcomplete yet.",
    });
    expect(refused).toMatchObject({ code: "invalid_request" });
    expect(String(refused.message)).toContain("a space between every word");
    expect(proxied).toEqual([]);
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

it.effect("lets a read-only outside client read, wait on and list threads elsewhere", () => {
  const { call, proxied, finished } = setup({ outside: true });
  return Effect.gen(function* () {
    expect(
      yield* call("studio_thread_read", { machine: "m1", threadId: "b-thread" }),
    ).toMatchObject({ machine: M1, thread: { threadId: "b-thread" } });
    expect(
      yield* call("studio_thread_list", { machine: "m1", projectId: "remote-project" }),
    ).toMatchObject({ machine: M1, threads: [{ threadId: "b-thread" }] });
    expect(
      yield* call("studio_thread_wait", { machine: "m1", threadId: "b-thread" }),
    ).toMatchObject({ status: "completed" });
    expect(proxied.map((entry) => entry.tool)).toEqual([
      "studio_thread_read",
      "studio_thread_list",
      "studio_thread_wait",
    ]);
    // What it saw finish is noted against its own launches only, never a coordinator's.
    expect(finished).toEqual([
      expect.objectContaining({
        launchedBy: { kind: "client", sessionId: "s", label: "Outside agent" },
      }),
    ]);
    expect(finished[0]).not.toHaveProperty("callerThreadId");
  });
});

it.effect("refuses a read-only outside client every change on another machine", () => {
  const { call, proxied } = setup({ outside: true });
  return Effect.gen(function* () {
    for (const [tool, params] of [
      ["studio_thread_send", { machine: "m1", threadId: "b-thread", message: "More" }],
      ["studio_thread_interrupt", { machine: "m1", threadId: "b-thread" }],
    ] as const)
      expect(yield* call(tool, params), tool).toMatchObject({ code: "capability_denied" });
    expect(proxied).toEqual([]);
  });
});

it.effect("lets an outside client steer threads there only within its own access", () => {
  const full = setup({ outside: true, outsideAccess: "full-access" });
  const low = setup({ outside: true, outsideAccess: "approval-required" });
  return Effect.gen(function* () {
    expect(
      yield* full.call("studio_thread_send", {
        machine: "m1",
        threadId: "b-thread",
        message: "More",
      }),
    ).toMatchObject({ runId: "b-run-2", threadLink: "[Worker](studio://thread/env-m1/b-thread)" });
    // The thread there runs auto, above this client's approval.
    expect(
      yield* low.call("studio_thread_send", {
        machine: "m1",
        threadId: "b-thread",
        message: "More",
      }),
    ).toMatchObject({ code: "runtime_mode_escalation_denied" });
    expect(low.proxied.map((entry) => entry.tool)).toEqual(["studio_thread_read"]);
  });
});

it.effect("keeps another machine's own credential from hopping on to a third machine", () => {
  const { call, proxied } = setup({ outside: true, machineCredential: true });
  return Effect.gen(function* () {
    for (const [tool, params] of [
      ["studio_thread_read", { machine: "m1", threadId: "b-thread" }],
      ["studio_thread_list", { machine: "m1", projectId: "remote-project" }],
      ["studio_thread_wait", { machine: "m1", threadId: "b-thread" }],
    ] as const)
      expect(yield* call(tool, params), tool).toMatchObject({ code: "capability_denied" });
    expect(proxied).toEqual([]);
  });
});

it.effect("knows another machine's own credential with grants off", () => {
  return Effect.gen(function* () {
    for (const otherMachine of ["principal", "label"] as const) {
      const { call, proxied } = setup({
        outside: true,
        outsideAccess: "full-access",
        otherMachine,
      });
      for (const [tool, params] of [
        ["studio_thread_read", { machine: "m1", threadId: "b-thread" }],
        ["studio_thread_send", { machine: "m1", threadId: "b-thread", message: "go" }],
      ] as const)
        expect(yield* call(tool, params), `${otherMachine} ${tool}`).toMatchObject({
          code: "capability_denied",
        });
      expect(proxied).toEqual([]);
    }
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

it.effect(
  "names the thread an agent meant when it drops the thread: prefix or decodes the ID",
  () => {
    const { call, local } = setup({ realResolve: true });
    return Effect.gen(function* () {
      // The three forms the DCFC dues worker tried on October 23, 2026.
      const tried = [
        AUDIT.slice("thread:".length),
        decodeURIComponent(AUDIT).slice("thread:".length),
        "mcp:d25698a7-ed07-4574-a0b9-f1d8a6122b58",
      ];
      const answers = [];
      for (const threadId of tried)
        answers.push(yield* call("studio_thread_send", { threadId, message: "Hold renewed" }));
      expect(answers[0]).toMatchObject({ code: "thread_not_found" });
      expect(String(answers[0]!.message)).toContain(`Did you mean ${AUDIT}?`);
      expect(String(answers[1]!.message)).toContain(`Did you mean ${AUDIT}?`);
      // A bare command ID cannot be rebuilt into the thread's ID: point to the search tools.
      expect(String(answers[2]!.message)).not.toContain("Did you mean");
      expect(String(answers[2]!.message)).toContain("studio_thread_search");
      // Nothing is sent to a guessed thread: each call acted only on the ID it was given.
      expect(local).toEqual(tried.map((threadId) => `send:${threadId}`));
    });
  },
);

// Review round 3: a thread here running machine A's work under A's grant
// reaches threads on M1 only along the path its own launches may take, and
// only threads it launched there. M1 sees this machine's coordinator, not A.
it.effect("keeps another machine's work off threads elsewhere it did not launch", () => {
  const { call, proxied, finished } = setup({ grantPath: ["env-a"], launched: ["b-thread"] });
  return Effect.gen(function* () {
    for (const [tool, params] of [
      ["studio_thread_read", { threadId: "studio://thread/env-m1/other-thread" }],
      ["studio_thread_send", { machine: "m1", threadId: "other-thread", message: "Stop" }],
      ["studio_thread_interrupt", { machine: "m1", threadId: "other-thread" }],
      ["studio_thread_wait", { machine: "m1", threadId: "other-thread" }],
      ["studio_thread_list", { machine: "m1", projectId: "remote-project" }],
    ] as const)
      expect(yield* call(tool, params), tool).toMatchObject({ code: "outside_grant_scope" });
    expect(proxied).toEqual([]);
    expect(finished).toEqual([]);
    // The worker it launched there stays its to read, steer and wait on.
    expect(
      yield* call("studio_thread_read", { machine: "m1", threadId: "b-thread" }),
    ).toMatchObject({ thread: { threadId: "b-thread" } });
    expect(
      yield* call("studio_thread_send", { machine: "m1", threadId: "b-thread", message: "More" }),
    ).toMatchObject({ runId: "b-run-2" });
    expect(
      yield* call("studio_thread_wait", { machine: "m1", threadId: "b-thread" }),
    ).toMatchObject({ status: "completed" });
  });
});

it.effect("never lets another machine's work steer a thread back on the path it came by", () => {
  const { call, proxied } = setup({ grantPath: ["env-m1"], launched: ["b-thread"] });
  return Effect.gen(function* () {
    for (const [tool, params] of [
      ["studio_thread_read", { machine: "m1", threadId: "b-thread" }],
      ["studio_thread_send", { machine: "m1", threadId: "b-thread", message: "Loop" }],
      ["studio_thread_interrupt", { machine: "m1", threadId: "b-thread" }],
      ["studio_thread_wait", { machine: "m1", threadId: "b-thread" }],
    ] as const)
      expect(yield* call(tool, params), tool).toMatchObject({ code: "delegation_cycle" });
    expect(proxied).toEqual([]);
  });
});

// Review round 3: this machine's own threads record no origin, so steering one
// would run work outside the grant's routines, sign-ins and revocation.
it.effect("keeps another machine's work off this machine's own threads", () => {
  const { call, local } = setup({ grantPath: ["env-a"], realResolve: true });
  return Effect.gen(function* () {
    expect(yield* call("studio_thread_send", { threadId: "hot", message: "x" })).toMatchObject({
      code: "outside_grant_scope",
    });
    expect(yield* call("studio_thread_interrupt", { threadId: "hot" })).toMatchObject({
      code: "outside_grant_scope",
    });
    expect(local).toEqual([]);
  });
});

// Review round 4: the owner's own machines, kept as legacy grants on update,
// keep reaching threads as they did before grants existed; only the path and
// hop limit their launches already kept still apply.
it.effect("lets a legacy grant's work reach and steer threads as before", () => {
  const here = setup({ grantPath: ["env-a"], legacy: true, realResolve: true });
  const elsewhere = setup({ grantPath: ["env-a"], legacy: true });
  return Effect.gen(function* () {
    yield* here.call("studio_thread_send", { threadId: "hot", message: "x" });
    expect(here.local).toEqual(["send:hot"]);
    expect(
      yield* elsewhere.call("studio_thread_read", { machine: "m1", threadId: "other-thread" }),
    ).not.toMatchObject({ code: "outside_grant_scope" });
    expect(elsewhere.proxied.map((entry) => entry.tool)).toEqual(["studio_thread_read"]);
  });
});

// Review round 5: reading, waiting on or listing threads on the origin starts
// no work, so a legacy grant keeps it as before grants; only acting on a
// thread back along the path it came by is refused.
it.effect("lets a legacy grant's work read its origin but not steer back along the path", () => {
  const { call, proxied } = setup({ grantPath: ["env-m1"], legacy: true });
  return Effect.gen(function* () {
    for (const [tool, params] of [
      ["studio_thread_send", { machine: "m1", threadId: "other-thread", message: "Loop" }],
      ["studio_thread_interrupt", { machine: "m1", threadId: "other-thread" }],
    ] as const)
      expect(yield* call(tool, params), tool).toMatchObject({ code: "delegation_cycle" });
    expect(proxied).toEqual([]);
    for (const [tool, params] of [
      ["studio_thread_read", { machine: "m1", threadId: "other-thread" }],
      ["studio_thread_wait", { machine: "m1", threadId: "other-thread" }],
    ] as const)
      expect(yield* call(tool, params), tool).not.toHaveProperty("code");
    expect(proxied.map((entry) => entry.tool)).toEqual([
      "studio_thread_read",
      "studio_thread_wait",
    ]);
  });
});
