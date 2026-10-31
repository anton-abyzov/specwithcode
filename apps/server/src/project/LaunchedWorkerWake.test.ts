import { assert, it } from "@effect/vitest";
import {
  MessageId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadShell,
  ProjectId,
  RunId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as LaunchedWorkerWake from "./LaunchedWorkerWake.ts";
import * as ProjectService from "./ProjectService.ts";

const projectId = ProjectId.make("project-greet");
const coordinatorId = ThreadId.make("thread-coordinator");
const workerId = ThreadId.make("thread-french");
const at = (iso: string) => DateTime.makeUnsafe(iso);

const shell = (
  id: ThreadId,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell =>
  ({
    id,
    projectId,
    title: id === workerId ? "Demo: French" : "Coordinator",
    createdBy: "agent",
    creationSource: "mcp",
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    deletedAt: null,
    archivedAt: null,
    latestRunId: RunId.make("run-1"),
    ...overrides,
  }) as OrchestrationV2ThreadShell;

const message = (
  id: string,
  createdAt: string,
  overrides: Partial<OrchestrationV2ConversationMessage> = {},
): OrchestrationV2ConversationMessage =>
  ({
    id: MessageId.make(id),
    threadId: workerId,
    role: "user",
    createdBy: "agent",
    creationSource: "mcp",
    senderThreadId: coordinatorId,
    createdAt: at(createdAt),
    ...overrides,
  }) as OrchestrationV2ConversationMessage;

const run = (status: OrchestrationV2Run["status"], id = "run-1"): OrchestrationV2Run =>
  ({ id: RunId.make(id), threadId: workerId, status }) as OrchestrationV2Run;

interface Setup {
  readonly worker?: OrchestrationV2ThreadShell;
  readonly coordinator?: OrchestrationV2ThreadShell;
  readonly messages?: ReadonlyArray<OrchestrationV2ConversationMessage>;
  readonly paused?: boolean;
}

const harness = (setup: Setup = {}) => {
  const sent: Array<ThreadManagement.ThreadManagementSendInput> = [];
  let worker = setup.worker ?? shell(workerId);
  const shells = () =>
    new Map<string, OrchestrationV2ThreadShell>([
      [workerId, worker],
      [
        coordinatorId,
        setup.coordinator ?? shell(coordinatorId, { createdBy: "user", creationSource: "web" }),
      ],
    ]);
  const layer = Layer.mergeAll(
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (id) => Effect.succeed(shells().get(id) ?? null),
      getThreadRecords: ((_id: ThreadId) =>
        Effect.succeed({
          thread: undefined,
          messages: setup.messages ?? [
            message("follow-up", "2026-10-31T07:40:00.000Z", { createdBy: "user" }),
            message("launch", "2026-10-31T07:33:00.000Z"),
          ],
        })) as never,
      sendToThread: (input) =>
        Effect.sync(() => {
          sent.push(input);
          return {} as ThreadManagement.ThreadManagementSendResult;
        }),
    }),
    Layer.mock(ProjectService.ProjectService)({
      getById: () =>
        Effect.succeed(
          Option.some({
            id: projectId,
            workspaceSettings: { paused: setup.paused === true },
          } as never),
        ),
    }),
  );
  return {
    sent,
    setWorker: (next: OrchestrationV2ThreadShell) => {
      worker = next;
    },
    observe: (value: OrchestrationV2Run) =>
      LaunchedWorkerWake.make.pipe(
        Effect.flatMap((reactor) => reactor.observeRun(value)),
        Effect.provide(layer),
      ),
  };
};

it.effect("wakes the coordinator that launched a local worker when its run completes", () =>
  Effect.gen(function* () {
    const test = harness();
    yield* test.observe(run("completed"));
    assert.equal(test.sent.length, 1);
    const [wake] = test.sent;
    assert.equal(wake?.threadId, coordinatorId);
    assert.equal(wake?.mode, "queue");
    assert.equal(wake?.creationSource, "server");
    assert.equal(String(wake?.commandId), "launched-worker-wake:run-1");
    assert.include(wake?.text ?? "", "Demo: French");
    assert.include(wake?.text ?? "", "finished: completed");
    assert.equal(wake?.notification?.outcome, "completed");
  }),
);

it.effect("leaves threads it did not launch alone", () =>
  Effect.gen(function* () {
    // A delegated child reports through its own task wake.
    const child = harness({
      worker: shell(workerId, {
        lineage: {
          parentThreadId: coordinatorId,
          relationshipToParent: "subagent",
          rootThreadId: coordinatorId,
        },
      }),
    });
    yield* child.observe(run("completed"));
    assert.equal(child.sent.length, 0);

    // A thread the person started, even if another thread later wrote to it.
    const personal = harness({
      worker: shell(workerId, { createdBy: "user", creationSource: "web" }),
    });
    yield* personal.observe(run("completed"));
    assert.equal(personal.sent.length, 0);

    // A launch whose first message no thread sent (an outside MCP client).
    const outside = harness({
      messages: [message("launch", "2026-10-31T07:33:00.000Z", { senderThreadId: undefined })],
    });
    yield* outside.observe(run("completed"));
    assert.equal(outside.sent.length, 0);

    // A stop or a restart is not the end of the work.
    const stopped = harness();
    yield* stopped.observe(run("interrupted"));
    yield* stopped.observe(run("cancelled"));
    assert.equal(stopped.sent.length, 0);

    // A delegated child that launched the worker is not woken.
    const nested = harness({
      coordinator: shell(coordinatorId, {
        lineage: {
          parentThreadId: workerId,
          relationshipToParent: "subagent",
          rootThreadId: workerId,
        },
      }),
    });
    yield* nested.observe(run("completed"));
    assert.equal(nested.sent.length, 0);

    // A paused project gets no new turn.
    const paused = harness({ paused: true });
    yield* paused.observe(run("completed"));
    assert.equal(paused.sent.length, 0);
  }),
);

it.effect("wakes a forked thread that launched the worker", () =>
  Effect.gen(function* () {
    const test = harness({
      coordinator: shell(coordinatorId, {
        createdBy: "user",
        creationSource: "web",
        lineage: { parentThreadId: workerId, relationshipToParent: "fork", rootThreadId: workerId },
      }),
    });
    yield* test.observe(run("completed"));
    assert.equal(test.sent.length, 1);
    assert.equal(test.sent[0]?.threadId, coordinatorId);
  }),
);

it.effect("reports a failed run only when no fallback run followed it", () =>
  Effect.gen(function* () {
    const settled = harness();
    const fiber = yield* settled.observe(run("failed")).pipe(Effect.forkChild);
    yield* TestClock.adjust(LaunchedWorkerWake.FAILED_RUN_GRACE);
    yield* Fiber.join(fiber);
    assert.equal(settled.sent.length, 1);
    assert.equal(settled.sent[0]?.notification?.outcome, "failed");

    const fellBack = harness();
    const pending = yield* fellBack.observe(run("failed")).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    fellBack.setWorker(shell(workerId, { latestRunId: RunId.make("run-2") }));
    yield* TestClock.adjust(LaunchedWorkerWake.FAILED_RUN_GRACE);
    yield* Fiber.join(pending);
    assert.equal(fellBack.sent.length, 0);
  }),
);
