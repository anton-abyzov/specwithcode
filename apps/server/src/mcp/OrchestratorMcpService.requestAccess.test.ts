import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  type AccessRequestSubject,
  EnvironmentId,
  type OrchestrationV2ServerCommand,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { projectFixture } from "../project/ProjectWorkspace.testkit.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const threadId = ThreadId.make("thread:mcp-access");
const projectId = ProjectId.make("project:mcp-access");
const notes: AccessRequestSubject = {
  kind: "app",
  key: "app:notes",
  label: "Notes",
  detail: "See and control its windows",
};

const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:mcp-access"),
  requestNamespace: "provider-session:mcp-access",
  thread: {
    threadId,
    providerSessionId: "provider-session:mcp-access",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

/**
 * A thread in a live run whose access request cards are recorded like the
 * orchestrator does: answered once, a pending retry leaves the card as it is.
 */
const harness = (options: { readonly runStatus?: string; readonly hasRun?: boolean } = {}) => {
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  const cards = new Map<string, Record<string, unknown>>();
  let runStatus = options.runStatus ?? "running";
  const records = () =>
    ({
      thread: { id: threadId, projectId, title: "Access" },
      runs:
        options.hasRun === false
          ? []
          : [
              {
                id: "run-1",
                ordinal: 1,
                status: runStatus,
                rootNodeId: "node-root",
                providerInstanceId: "codex",
              },
            ],
      turnItems: Array.from(cards.values()),
      messages: [],
      subagents: [],
      providerThreads: [],
      providerTurns: [],
      runtimeRequests: [],
      contextTransfers: [],
    }) as never;
  const layer = OrchestratorMcpService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () => Effect.sync(records),
          getThreadShell: () => Effect.succeed(null),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command);
              if (command.type !== "access_request.record") return {} as never;
              const existing = cards.get(command.turnItemId);
              if (
                existing !== undefined &&
                (existing.accessStatus !== "pending" || command.accessStatus === "pending")
              ) {
                return {} as never;
              }
              cards.set(command.turnItemId, {
                id: command.turnItemId,
                type: "access_request",
                runId: command.runId,
                nodeId: command.nodeId,
                accessTitle: command.accessTitle,
                reason: command.reason,
                subjects: command.subjects,
                accessStatus: command.accessStatus,
                ...(command.accessScope === undefined ? {} : { accessScope: command.accessScope }),
              });
              return {} as never;
            }),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: (id) => Effect.succeed(Option.some(projectFixture(id))),
        }),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      ),
    ),
  );
  /** What the card's Allow or Deny does once AccessRequests wrote the grants. */
  const answer = (accessStatus: "allowed" | "denied", accessScope?: "thread" | "machine") => {
    for (const [id, card] of cards) {
      cards.set(id, {
        ...card,
        accessStatus,
        ...(accessScope === undefined ? {} : { accessScope }),
      });
    }
  };
  const endRun = () => {
    runStatus = "completed";
  };
  const statuses = () =>
    dispatched.flatMap((command) =>
      command.type === "access_request.record" ? [command.accessStatus] : [],
    );
  return { layer, dispatched, cards, answer, endRun, statuses };
};

const card = (clientRequestId: string, timeoutMs?: number) => ({
  accessTitle: "Use Notes",
  reason: "To read the shopping list.",
  subjects: [notes],
  clientRequestId,
  ...(timeoutMs === undefined ? {} : { timeoutMs }),
});

/** Lets the forked call record its card and reach its first sleep. */
const settle = Effect.gen(function* () {
  for (let index = 0; index < 20; index++) yield* Effect.yieldNow;
});

describe("OrchestratorMcpService.requestAccess", () => {
  it.effect("shows a pending card and returns the user's Allow with its scope", () => {
    const { layer, answer, cards, statuses, dispatched } = harness();
    return Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const fiber = yield* service.requestAccess(scope, card("notes")).pipe(Effect.forkChild);
      yield* settle;
      assert.deepEqual(statuses(), ["pending"]);
      const pending = Array.from(cards.values())[0]!;
      assert.include(pending, {
        type: "access_request",
        runId: "run-1",
        nodeId: "node-root",
        accessTitle: "Use Notes",
        accessStatus: "pending",
      });
      assert.deepEqual(pending.subjects, [notes]);
      assert.include(String(pending.id), "turn-item:access-request:");
      const first = dispatched[0];
      assert.equal(first?.type === "access_request.record" ? first.threadId : null, threadId);

      answer("allowed", "machine");
      yield* TestClock.adjust("1 second");
      const result = yield* Fiber.join(fiber);
      assert.deepEqual(result, { status: "allowed", scope: "machine" });
      // The answered card is not closed afterwards.
      assert.deepEqual(statuses(), ["pending"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("returns denied without a scope", () => {
    const { layer, answer } = harness();
    return Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const fiber = yield* service.requestAccess(scope, card("notes")).pipe(Effect.forkChild);
      yield* settle;
      answer("denied");
      yield* TestClock.adjust("1 second");
      assert.deepEqual(yield* Fiber.join(fiber), { status: "denied" });
    }).pipe(Effect.provide(layer));
  });

  it.effect("times out and closes the card so a late Allow grants nothing", () => {
    const { layer, cards, statuses } = harness();
    return Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const fiber = yield* service
        .requestAccess(scope, card("notes", 2_000))
        .pipe(Effect.forkChild);
      yield* settle;
      yield* TestClock.adjust("3 seconds");
      assert.deepEqual(yield* Fiber.join(fiber), { status: "timed_out" });
      assert.deepEqual(statuses(), ["pending", "cancelled"]);
      assert.equal(Array.from(cards.values())[0]?.accessStatus, "cancelled");
    }).pipe(Effect.provide(layer));
  });

  it.effect("cancels the card when the run that asked ends", () => {
    const { layer, endRun, statuses } = harness();
    return Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const fiber = yield* service.requestAccess(scope, card("notes")).pipe(Effect.forkChild);
      yield* settle;
      endRun();
      yield* TestClock.adjust("1 second");
      assert.deepEqual(yield* Fiber.join(fiber), { status: "cancelled" });
      assert.deepEqual(statuses(), ["pending", "cancelled"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("a retry with the same clientRequestId gets the answer without a second card", () => {
    const { layer, answer, cards } = harness();
    return Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const fiber = yield* service.requestAccess(scope, card("notes")).pipe(Effect.forkChild);
      yield* settle;
      answer("allowed", "thread");
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(fiber);
      const retried = yield* service.requestAccess(scope, card("notes"));
      assert.deepEqual(retried, { status: "allowed", scope: "thread" });
      assert.equal(cards.size, 1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("the same clientRequestId with other subjects shows a new card", () => {
    const { layer, answer, cards } = harness();
    const finder: AccessRequestSubject = { ...notes, key: "app:finder", label: "Finder" };
    return Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const first = yield* service
        .requestAccess(scope, { ...card("ask"), subjects: [notes, finder] })
        .pipe(Effect.forkChild);
      yield* settle;
      answer("allowed", "thread");
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(first);
      // Same subjects in another order: the answered card, no second one.
      const again = yield* service.requestAccess(scope, {
        ...card("ask"),
        subjects: [finder, notes, finder],
      });
      assert.deepEqual(again, { status: "allowed", scope: "thread" });
      assert.equal(cards.size, 1);

      const other = yield* service
        .requestAccess(scope, { ...card("ask"), subjects: [finder] })
        .pipe(Effect.forkChild);
      yield* settle;
      assert.equal(cards.size, 2);
      const fresh = Array.from(cards.values()).find((item) => item.accessStatus === "pending");
      assert.deepEqual(fresh?.subjects, [finder]);
      answer("denied");
      yield* TestClock.adjust("1 second");
      assert.deepEqual(yield* Fiber.join(other), { status: "denied" });
    }).pipe(Effect.provide(layer));
  });

  it.effect("needs a live turn and at least one subject", () => {
    const between = harness({ hasRun: false });
    const live = harness();
    return Effect.gen(function* () {
      const betweenTurns = yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        return yield* service.requestAccess(scope, card("notes")).pipe(Effect.flip);
      }).pipe(Effect.provide(between.layer));
      assert.equal(betweenTurns.code, "parent_not_active");
      assert.equal(between.dispatched.length, 0);

      const empty = yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        return yield* service
          .requestAccess(scope, { ...card("notes"), subjects: [] })
          .pipe(Effect.flip);
      }).pipe(Effect.provide(live.layer));
      assert.equal(empty.code, "invalid_request");
      assert.equal(live.dispatched.length, 0);
    });
  });
});
