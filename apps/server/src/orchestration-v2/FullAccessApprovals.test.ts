import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ServerCommand,
  type RuntimeMode,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as FullAccessApprovals from "./FullAccessApprovals.ts";
import { OrchestratorDispatchError } from "./Orchestrator.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const coordinatorId = ThreadId.make("project-coordinator:full-access");
const workerId = ThreadId.make("thread:delegated-task:worker");
const nativeChildId = ThreadId.make("thread:provider-subagent:child");

const thread = (
  runtimeMode: RuntimeMode,
  lineage: { parentThreadId: ThreadId | null; relationshipToParent: "subagent" | null } = {
    parentThreadId: null,
    relationshipToParent: null,
  },
  creationSource: "provider" | "mcp" = "mcp",
) => ({ runtimeMode, lineage, creationSource }) as unknown as OrchestrationV2AppThread;

const request = (
  id: string,
  kind: OrchestrationV2RuntimeRequest["kind"] = "command",
  status: OrchestrationV2RuntimeRequest["status"] = "pending",
) =>
  ({
    id,
    kind,
    status,
    responseCapability: { type: "live", providerSessionId: "provider-session:codex:shared" },
  }) as unknown as OrchestrationV2RuntimeRequest;

interface FakeThread {
  thread: OrchestrationV2AppThread;
  runtimeRequests: ReadonlyArray<OrchestrationV2RuntimeRequest>;
  subagents?: ReadonlyArray<{ childThreadId: ThreadId | null }>;
}

function harness(threads: Record<string, FakeThread>, options: { failDispatch?: boolean } = {}) {
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  const service = {
    getThreadRecords: (threadId: ThreadId) =>
      Effect.succeed({
        runtimeRequests: [],
        subagents: [],
        ...threads[threadId],
      }),
    dispatch: (command: OrchestrationV2ServerCommand) =>
      Effect.suspend(() => {
        dispatched.push(command);
        return options.failDispatch
          ? Effect.fail(
              new OrchestratorDispatchError({
                commandId: CommandId.make("server:full-access-accept:answered"),
                commandType: "runtime-request.respond",
                cause: "Runtime request is resolved.",
              }),
            )
          : Effect.succeed({});
      }),
    streamDomainEvents: Stream.empty,
  } as unknown as ThreadManagementService.ThreadManagementServiceShape;
  const layer = FullAccessApprovals.layer.pipe(
    Layer.provide(Layer.succeed(ThreadManagementService.ThreadManagementService, service)),
  );
  const process = (event: Partial<OrchestrationV2DomainEvent>) =>
    Effect.gen(function* () {
      const reactor = yield* FullAccessApprovals.FullAccessApprovals;
      yield* reactor.process(event as OrchestrationV2DomainEvent);
    }).pipe(Effect.provide(layer));
  return { dispatched, process };
}

const pendingEvent = (threadId: ThreadId, payload: OrchestrationV2RuntimeRequest) =>
  ({ type: "runtime-request.updated", threadId, payload }) as Partial<OrchestrationV2DomainEvent>;

describe("FullAccessApprovals", () => {
  it("answers command, file and permission prompts only", () => {
    for (const kind of ["command", "file-read", "file-change", "permission"] as const)
      assert.isTrue(FullAccessApprovals.isFullAccessPrompt(request("r", kind)));
    for (const kind of ["user_input", "mcp-elicitation", "auth_refresh"] as const)
      assert.isFalse(FullAccessApprovals.isFullAccessPrompt(request("r", kind)));
    assert.isFalse(FullAccessApprovals.isFullAccessPrompt(request("r", "command", "resolved")));
  });

  it.effect("accepts a prompt that reaches a Full access thread from an older turn", () =>
    Effect.gen(function* () {
      const prompt = request("runtime-request:exec-1");
      const { dispatched, process } = harness({
        [workerId]: { thread: thread("full-access"), runtimeRequests: [prompt] },
      });
      yield* process(pendingEvent(workerId, prompt));
      assert.deepEqual(dispatched, [
        {
          type: "runtime-request.respond",
          commandId: "server:full-access-accept:runtime-request:exec-1",
          threadId: workerId,
          requestId: "runtime-request:exec-1",
          decision: "accept",
        } as unknown as OrchestrationV2ServerCommand,
      ]);
    }),
  );

  it.effect("leaves prompts of a Supervised thread and questions to the person", () =>
    Effect.gen(function* () {
      const prompt = request("runtime-request:exec-2");
      const question = request("runtime-request:question", "user_input");
      const supervised = harness({
        [workerId]: { thread: thread("approval-required"), runtimeRequests: [prompt] },
      });
      yield* supervised.process(pendingEvent(workerId, prompt));
      assert.deepEqual(supervised.dispatched, []);
      const fullAccess = harness({
        [workerId]: { thread: thread("full-access"), runtimeRequests: [question] },
      });
      yield* fullAccess.process(pendingEvent(workerId, question));
      assert.deepEqual(fullAccess.dispatched, []);
    }),
  );

  it.effect("accepts pending prompts when a thread is raised to Full access", () =>
    Effect.gen(function* () {
      const { dispatched, process } = harness({
        [coordinatorId]: {
          thread: thread("full-access"),
          runtimeRequests: [
            request("runtime-request:exec-3"),
            request("runtime-request:mcp", "mcp-elicitation"),
          ],
          subagents: [{ childThreadId: nativeChildId }, { childThreadId: workerId }],
        },
        [nativeChildId]: {
          thread: thread(
            "approval-required",
            { parentThreadId: coordinatorId, relationshipToParent: "subagent" },
            "provider",
          ),
          runtimeRequests: [request("runtime-request:child-exec")],
        },
        // An app-owned worker follows its own mode and its own mode event.
        [workerId]: {
          thread: thread("approval-required", {
            parentThreadId: coordinatorId,
            relationshipToParent: "subagent",
          }),
          runtimeRequests: [request("runtime-request:worker-exec")],
        },
      });
      yield* process({
        type: "thread.runtime-mode-updated",
        threadId: coordinatorId,
        payload: thread("full-access"),
      } as Partial<OrchestrationV2DomainEvent>);
      assert.deepEqual(
        dispatched.map((command) => {
          const respond = command as { threadId: ThreadId; requestId: string };
          return [respond.threadId, respond.requestId];
        }),
        [
          [coordinatorId, "runtime-request:exec-3"],
          [nativeChildId, "runtime-request:child-exec"],
        ],
      );
    }),
  );

  it.effect("answers a provider subagent's prompt by its parent's mode", () =>
    Effect.gen(function* () {
      const prompt = request("runtime-request:child-exec");
      const { dispatched, process } = harness({
        [coordinatorId]: { thread: thread("full-access"), runtimeRequests: [] },
        [nativeChildId]: {
          thread: thread(
            "approval-required",
            { parentThreadId: coordinatorId, relationshipToParent: "subagent" },
            "provider",
          ),
          runtimeRequests: [prompt],
        },
      });
      yield* process(pendingEvent(nativeChildId, prompt));
      assert.lengthOf(dispatched, 1);
    }),
  );

  it.effect("ignores a prompt the person already answered", () =>
    Effect.gen(function* () {
      const prompt = request("runtime-request:exec-4");
      const { dispatched, process } = harness(
        { [workerId]: { thread: thread("full-access"), runtimeRequests: [prompt] } },
        { failDispatch: true },
      );
      yield* process(pendingEvent(workerId, prompt));
      assert.lengthOf(dispatched, 1);
    }),
  );
});
