import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  type OrchestrationV2ThreadShell,
  type OrchestratorMcpThreadReadResult,
  type OrchestratorMcpThreadWaitResult,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as EnvironmentAuth from "../../../auth/EnvironmentAuth.ts";
import * as RemoteWorkers from "../../../fleet/RemoteWorkers.ts";
import { unscopedGrant } from "../../../fleet/workGrantPolicy.ts";
import * as WorkGrants from "../../../fleet/WorkGrants.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import * as ThreadMetadataMcpService from "../../ThreadMetadataMcpService.ts";
import * as OrchestratorHandlers from "./handlers.ts";
import {
  LAST_REPLY_EXCERPT_CHARS,
  ThreadsWaitInput,
  type ThreadsWaitOps,
  WAIT_CHUNK_MS,
  waitThreads,
} from "./threadsWait.ts";
import { OrchestratorToolkit } from "./tools.ts";

const M1 = { id: "m1", label: "M1", environmentId: EnvironmentId.make("env-m1") };

const detail = (threadId: string, itemCount: number) =>
  ({
    threadId,
    projectId: "project",
    title: "Worker",
    createdBy: "agent",
    creationSource: "mcp",
    status: "completed",
    latestRunId: "run",
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
    itemCount,
    pendingRequestCount: 0,
    archived: false,
    settled: true,
    settledAt: null,
    createdAt: "2026-10-12T00:00:00.000Z",
    updatedAt: "2026-10-12T00:00:00.000Z",
  }) as const;

const item = (position: number, type: string, text: string, textTruncated = false) => ({
  position,
  visibility: "local",
  sourceThreadId: "t",
  itemId: `item-${position}`,
  runId: null,
  messageId: null,
  createdBy: null,
  creationSource: null,
  type,
  status: "completed",
  title: null,
  text,
  textTruncated,
  updatedAt: "2026-10-12T00:00:00.000Z",
});

const readResult = (threadId: string, items: ReadonlyArray<ReturnType<typeof item>>) =>
  ({
    thread: detail(threadId, items.length),
    recentRuns: [],
    items,
    nextPosition: null,
    hasMore: false,
  }) as unknown as OrchestratorMcpThreadReadResult;

const waitResult = (
  threadId: string,
  status: OrchestratorMcpThreadWaitResult["status"],
  timedOut: boolean,
  machine?: typeof M1,
): OrchestratorMcpThreadWaitResult => ({
  threadId: ThreadId.make(threadId),
  runId: RunId.make(`${threadId}-run`),
  status,
  timedOut,
  ...(machine === undefined ? {} : { machine }),
});

/**
 * Fake threads: each finishes `finishAfterMs` after the call starts, a wait
 * of `timeoutMs` sleeping (on the test clock) until then or its timeout.
 */
const fakeOps = (threads: Record<string, { finishAfterMs?: number; fail?: boolean }>) => {
  const waits: Array<{ ref: string; timeoutMs: number }> = [];
  let startedAt: number | undefined;
  const ops: ThreadsWaitOps<never> = {
    wait: (ref, timeoutMs) =>
      Effect.gen(function* () {
        waits.push({ ref, timeoutMs });
        const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
        startedAt ??= now;
        const spec = threads[ref]!;
        const machine = ref.startsWith("studio://thread/env-m1/") ? M1 : undefined;
        if (spec.fail)
          return yield* new OrchestratorMcpFailure({
            code: "machine_unreachable",
            message: "M1 is not answering.",
          });
        const finishAt =
          spec.finishAfterMs === undefined ? Infinity : startedAt + spec.finishAfterMs;
        if (finishAt <= now) return waitResult(ref, "completed", false, machine);
        if (finishAt - now <= timeoutMs) {
          yield* Effect.sleep(finishAt - now);
          return waitResult(ref, "completed", false, machine);
        }
        yield* Effect.sleep(timeoutMs);
        return waitResult(ref, "running", true, machine);
      }),
    read: (ref) =>
      Effect.succeed(
        readResult(ref, [
          item(0, "user_message", "go"),
          item(1, "assistant_message", `${ref} said hello`),
          item(2, "assistant_message", `${ref} is done`),
        ]),
      ),
  };
  return { ops, waits };
};

it.effect("waits for every thread in all mode and reports each one's last reply", () =>
  Effect.gen(function* () {
    const { ops, waits } = fakeOps({
      a: { finishAfterMs: 10_000 },
      "studio://thread/env-m1/b": { finishAfterMs: 120_000 },
    });
    const fiber = yield* Effect.forkChild(
      waitThreads({ threads: ["a", "studio://thread/env-m1/b"], timeoutMs: 600_000 }, ops),
    );
    yield* TestClock.adjust(130_000);
    const result = yield* Fiber.join(fiber);
    expect(result.mode).toBe("all");
    expect(result.timedOut).toBe(false);
    expect(result.threads).toMatchObject([
      { ref: "a", machine: "local", status: "completed", done: true, lastReply: "a is done" },
      {
        ref: "studio://thread/env-m1/b",
        machine: "M1",
        threadId: "studio://thread/env-m1/b",
        status: "completed",
        done: true,
        lastReply: "studio://thread/env-m1/b is done",
        lastReplyTruncated: false,
      },
    ]);
    // The remote wait is asked for in chunks no longer than 50s.
    const remote = waits.filter((wait) => wait.ref.startsWith("studio://"));
    expect(remote.length).toBe(3);
    expect(remote.every((wait) => wait.timeoutMs <= WAIT_CHUNK_MS)).toBe(true);
  }),
);

it.effect("returns as soon as one thread is done in any mode", () =>
  Effect.gen(function* () {
    const { ops } = fakeOps({ a: { finishAfterMs: 5_000 }, b: {} });
    const fiber = yield* Effect.forkChild(
      waitThreads({ threads: ["a", "b"], mode: "any", timeoutMs: 600_000 }, ops),
    );
    yield* TestClock.adjust(6_000);
    const result = yield* Fiber.join(fiber);
    expect(result.timedOut).toBe(false);
    expect(result.threads.map((entry) => [entry.ref, entry.status, entry.done])).toEqual([
      ["a", "completed", true],
      ["b", "running", false],
    ]);
  }),
);

it.effect("times out without failing and reports where each thread stands", () =>
  Effect.gen(function* () {
    const { ops, waits } = fakeOps({ a: { finishAfterMs: 1_000 }, b: {} });
    const fiber = yield* Effect.forkChild(
      waitThreads({ threads: ["a", "b"], timeoutMs: 70_000 }, ops),
    );
    yield* TestClock.adjust(80_000);
    const result = yield* Fiber.join(fiber);
    expect(result.timedOut).toBe(true);
    expect(result.threads.map((entry) => entry.done)).toEqual([true, false]);
    // Never past the budget: 50s, then the 20s left.
    expect(waits.filter((wait) => wait.ref === "b").map((wait) => wait.timeoutMs)).toEqual([
      50_000, 20_000, 1,
    ]);
  }),
);

it.effect("reports an unreachable machine in its row, not as a failed call", () =>
  Effect.gen(function* () {
    const { ops } = fakeOps({
      a: { finishAfterMs: 0 },
      "studio://thread/env-m1/b": { fail: true },
    });
    const result = yield* waitThreads({ threads: ["a", "studio://thread/env-m1/b"] }, ops);
    expect(result.timedOut).toBe(false);
    expect(result.threads[1]).toMatchObject({
      done: false,
      status: null,
      error: { code: "machine_unreachable", message: "M1 is not answering." },
    });
  }),
);

it.effect("caps the excerpt of a long last reply", () =>
  Effect.gen(function* () {
    const long = "x".repeat(LAST_REPLY_EXCERPT_CHARS + 50);
    const ops: ThreadsWaitOps<never> = {
      wait: (ref) => Effect.succeed(waitResult(ref, "completed", false)),
      read: (ref) => Effect.succeed(readResult(ref, [item(0, "assistant_message", long)])),
    };
    const result = yield* waitThreads({ threads: ["a"] }, ops);
    expect(result.threads[0]?.lastReply?.length).toBe(LAST_REPLY_EXCERPT_CHARS + 1);
    expect(result.threads[0]?.lastReplyTruncated).toBe(true);
  }),
);

it("accepts at most 20 threads and needs at least one", () => {
  const decode = Schema.decodeUnknownExit(ThreadsWaitInput);
  expect(decode({ threads: [] })._tag).toBe("Failure");
  expect(decode({ threads: Array.from({ length: 21 }, (_, i) => `t${i}`) })._tag).toBe("Failure");
  expect(decode({ threads: ["a"], mode: "any" })._tag).toBe("Success");
});

/** The tool itself, for a Studio thread or an outside MCP client, over the real handlers. */
const toolSetup = (
  outside: boolean,
  options: {
    /** The client is another machine's credential whose grant lists no project here. */
    readonly machineCredential?: boolean;
    /** The client's session is watched; it ends when this is completed. */
    readonly sessionEnd?: Deferred.Deferred<void>;
    /** Local threads keep running, so each wait chunk times out. */
    readonly running?: boolean;
    /** Undefined means a current peer; false/missing/malformed advertise no support. */
    readonly peerReadSupport?: "current" | "legacy" | "false" | "malformed";
  } = {},
) => {
  const callerId = ThreadId.make("coordinator");
  const providerInstanceId = ProviderInstanceId.make("codex");
  const caller = {
    id: callerId,
    projectId: ProjectId.make("project"),
    providerInstanceId,
    runtimeMode: "full-access",
    interactionMode: "default",
    activeRunId: "active-run",
    archivedAt: null,
    deletedAt: null,
  } as unknown as OrchestrationV2ThreadShell;
  const proxied: Array<{ tool: string; arguments: Record<string, unknown> }> = [];
  const localReads: Array<{ readonly acknowledgeResult?: boolean | undefined }> = [];
  const remote: RemoteWorkers.RemoteWorkersShape = {
    ...RemoteWorkers.RemoteWorkers.defaultValue(),
    enabled: true,
    resolveThread: ({ threadId }) =>
      Effect.succeed(
        threadId.startsWith("studio://thread/env-m1/")
          ? {
              target: { kind: "remote", machine: M1 },
              threadId: ThreadId.make(threadId.replace("studio://thread/env-m1/", "")),
            }
          : { target: { kind: "local" }, threadId: ThreadId.make(threadId) },
      ),
    proxy: (input) =>
      Effect.sync(() => {
        proxied.push({ tool: input.tool, arguments: input.arguments });
        if (input.tool === "orchestrator_capabilities")
          return options.peerReadSupport === "legacy"
            ? { features: {} }
            : {
                features: {
                  readThreadWithoutAcknowledgement:
                    options.peerReadSupport === "false"
                      ? false
                      : options.peerReadSupport === "malformed"
                        ? "true"
                        : true,
                },
              };
        const answer =
          input.tool === "studio_thread_wait"
            ? waitResult("b-thread", "completed", false)
            : readResult("b-thread", [item(0, "assistant_message", "remote result")]);
        return { ...answer, machine: input.machine } as unknown as Record<string, unknown>;
      }),
  };
  const layerDependencies = Layer.mergeAll(
    Layer.succeed(RemoteWorkers.RemoteWorkers, remote),
    Layer.succeed(WorkGrants.WorkGrants, {
      ...(WorkGrants.WorkGrants.defaultValue() as WorkGrants.WorkGrantsShape),
      enabled: options.machineCredential === true,
      forClient: () =>
        Effect.succeed(
          options.machineCredential === true
            ? {
                ...unscopedGrant(EnvironmentId.make("env-a")),
                projects: { kind: "listed" as const, projectIds: [] },
              }
            : undefined,
        ),
    }),
    ...(options.sessionEnd === undefined
      ? []
      : [
          Layer.mock(EnvironmentAuth.EnvironmentAuth)({
            watchSessionEnd: () => Effect.succeed(Deferred.await(options.sessionEnd!)),
          }),
        ]),
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("env-m4"),
      requestNamespace: "session",
      thread: outside
        ? undefined
        : { threadId: callerId, providerSessionId: "session", providerInstanceId },
      client: outside
        ? {
            sessionId: "s",
            label: "Outside agent",
            access: "read-only",
            ...(options.machineCredential === true
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
            : id === "local-thread"
              ? ({ ...caller, id } as OrchestrationV2ThreadShell)
              : null,
        ),
    }),
    Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({
      waitForThread: (_scope, input) =>
        options.running === true
          ? Effect.sleep(input.timeoutMs ?? 1).pipe(
              Effect.as(waitResult(input.threadId, "running", true)),
            )
          : Effect.succeed(waitResult(input.threadId, "completed", false)),
      readThread: (_scope, input) =>
        Effect.sync(() => {
          localReads.push(input);
          return readResult(input.threadId, [item(0, "assistant_message", "local result")]);
        }),
    }),
    Layer.mock(ThreadMetadataMcpService.ThreadMetadataMcpService)({}),
    Layer.mock(ProjectService.ProjectService)({
      getById: (id) => Effect.succeed(Option.some({ id, title: "App" } as never)),
    }),
  );
  const call = (params: Record<string, unknown>, tool = "studio_threads_wait") =>
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
  return { call, proxied, localReads };
};

for (const outside of [false, true])
  it.effect(
    `waits on a local and a remote thread for ${outside ? "an outside MCP client" : "a Studio thread"}`,
    () => {
      const { call, proxied, localReads } = toolSetup(outside);
      return Effect.gen(function* () {
        const result = yield* call({
          threads: ["local-thread", "studio://thread/env-m1/b-thread"],
        });
        expect(result).toMatchObject({
          mode: "all",
          timedOut: false,
          threads: [
            { ref: "local-thread", machine: "local", done: true, lastReply: "local result" },
            {
              ref: "studio://thread/env-m1/b-thread",
              machine: "M1",
              threadId: "b-thread",
              done: true,
              lastReply: "remote result",
            },
          ],
        });
        expect(localReads.length).toBeGreaterThan(0);
        expect(localReads.every((read) => read.acknowledgeResult === false)).toBe(true);
        const reads = proxied.filter((entry) => entry.tool === "studio_thread_read");
        expect(reads.length).toBeGreaterThan(0);
        expect(reads.every((read) => read.arguments.acknowledgeResult === false)).toBe(true);
        expect(
          proxied.findIndex((entry) => entry.tool === "orchestrator_capabilities"),
        ).toBeLessThan(proxied.findIndex((entry) => entry.tool === "studio_thread_read"));
        const wait = proxied.find((entry) => entry.tool === "studio_thread_wait");
        expect(wait?.arguments).toMatchObject({ threadId: "b-thread" });
        expect(wait?.arguments.timeoutMs as number).toBeLessThanOrEqual(WAIT_CHUNK_MS);
      });
    },
  );

it.effect("reports a thread another machine's credential may not reach in its row", () => {
  const { call, proxied } = toolSetup(true, { machineCredential: true });
  return Effect.gen(function* () {
    const result = yield* call({ threads: ["local-thread", "studio://thread/env-m1/b-thread"] });
    expect(result).toMatchObject({
      timedOut: false,
      threads: [
        { ref: "local-thread", done: false, error: { code: "outside_grant_scope" } },
        {
          ref: "studio://thread/env-m1/b-thread",
          done: false,
          error: { code: "capability_denied" },
        },
      ],
    });
    // Neither the other machine nor the thread here was waited on.
    expect(proxied).toEqual([]);
  });
});

it.effect("ends a client's wait when its sign-in is revoked meanwhile", () =>
  Effect.gen(function* () {
    for (const [tool, params] of [
      ["studio_threads_wait", { threads: ["local-thread"], timeoutMs: 3_600_000 }],
      ["studio_thread_wait", { threadId: "local-thread", timeoutMs: 3_600_000 }],
    ] as const) {
      const sessionEnd = yield* Deferred.make<void>();
      const { call } = toolSetup(true, { sessionEnd, running: true });
      const fiber = yield* Effect.forkChild(call(params, tool));
      yield* TestClock.adjust(WAIT_CHUNK_MS * 2);
      yield* Deferred.succeed(sessionEnd, undefined);
      yield* TestClock.adjust(1);
      const result = yield* Fiber.join(fiber);
      expect(result, tool).toMatchObject({
        code: "capability_denied",
        message: expect.stringContaining("revoked"),
      });
    }
  }),
);

for (const peerReadSupport of ["legacy", "false", "malformed"] as const)
  it.effect(
    `returns status only for a ${peerReadSupport} peer without an acknowledging read`,
    () => {
      const { call, proxied } = toolSetup(false, { peerReadSupport });
      return Effect.gen(function* () {
        const result = yield* call({ threads: ["studio://thread/env-m1/b-thread"] });
        expect(result).toMatchObject({
          timedOut: false,
          threads: [{ done: true, lastReply: null }],
        });
        expect(proxied.some((entry) => entry.tool === "orchestrator_capabilities")).toBe(true);
        expect(proxied.filter((entry) => entry.tool === "studio_thread_read")).toEqual([]);
      });
    },
  );
