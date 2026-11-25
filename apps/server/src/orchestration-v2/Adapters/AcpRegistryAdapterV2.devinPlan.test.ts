import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProjectId,
  type ProviderApprovalDecision,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  type RuntimeMode,
  ThreadId,
} from "@specweave-studio/contracts";
import { resolveSelfInvocation } from "@specweave-studio/shared/nodeRuntime";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../../config.ts";
import * as AcpSessionRuntime from "../../provider/acp/AcpSessionRuntime.ts";
import * as IdAllocator from "../IdAllocator.ts";
import { ProviderAdapterV2RuntimePolicy } from "../ProviderAdapter.ts";
import { AcpRegistryAdapterV2Driver, makeAcpRegistryAdapterV2 } from "./AcpRegistryAdapterV2.ts";

type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
type PermissionHandler = Parameters<RuntimeService["handleRequestPermission"]>[0];
type PermissionRequest = Parameters<PermissionHandler>[0];
type PermissionOption = PermissionRequest["options"][number];

const decodeSettings = Schema.decodeUnknownEffect(AcpRegistryAdapterV2Driver.configSchema);

const layerTest = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "studio-acp-devin-plan-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);

const SESSION_ID = "mock-session-1";

// Devin's plan exit lists its approvals as allow_once options in no fixed order.
const planExitOptions: ReadonlyArray<PermissionOption> = [
  { optionId: "plan_bypass", name: "Implement and bypass permissions", kind: "allow_once" },
  { optionId: "plan_approve", name: "Implement the plan", kind: "allow_once" },
  { optionId: "plan_reject", name: "Keep planning", kind: "reject_once" },
];

/**
 * Opens a registry session for `agentId`, raises one plan-exit permission
 * request in a running turn, answers it with `decision` when the mode asks,
 * and returns the option ID sent to the agent.
 */
const answerPlanExit = (
  agent: string | { readonly source: "local"; readonly commandPath: string },
  runtimeMode: RuntimeMode,
  decision: ProviderApprovalDecision,
  offered: ReadonlyArray<PermissionOption> = planExitOptions,
) =>
  Effect.gen(function* () {
    const agentId = typeof agent === "string" ? agent : "local";
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const path = yield* Path.Path;
    const mockAgentPath = yield* path.fromFileUrl(
      new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
    );
    const permissionHandler = yield* Deferred.make<PermissionHandler>();
    const instanceId = ProviderInstanceId.make(`acp-devin-plan-${agentId}-${runtimeMode}`);
    const threadId = ThreadId.make(`thread-acp-devin-plan-${agentId}-${runtimeMode}`);
    const adapter = makeAcpRegistryAdapterV2({
      crypto: yield* Crypto.Crypto,
      selfInvocation: yield* resolveSelfInvocation(),
      instanceId,
      settings: yield* decodeSettings(
        typeof agent === "string" ? { agentId: agent, authMethodId: "test" } : agent,
      ),
      environment: {},
      childProcessSpawner,
      fileSystem: yield* FileSystem.FileSystem,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      resolver: { resolve: () => Effect.die("the runtime is injected") },
      serverConfig: yield* ServerConfig.ServerConfig,
      makeRuntime: (input) =>
        Effect.gen(function* () {
          const { processEnvironment: _processEnvironment, ...runtimeInput } = input;
          const context = yield* Layer.build(
            AcpSessionRuntime.layer({
              ...runtimeInput,
              spawn: {
                command: process.execPath,
                args: [mockAgentPath],
                cwd: input.cwd,
                env: { STUDIO_ACP_SESSION_LIFECYCLE: "1", STUDIO_ACP_HANG_PROMPT_FOREVER: "1" },
              },
              authMethodId: "test",
            }).pipe(
              Layer.provide(
                Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
              ),
            ),
          );
          const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
            Effect.provide(context),
          );
          return {
            ...runtime,
            handleRequestPermission: (handler) =>
              Deferred.succeed(permissionHandler, handler).pipe(
                Effect.andThen(runtime.handleRequestPermission(handler)),
              ),
          } satisfies RuntimeService;
        }),
    });
    const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
      runtimeMode,
      interactionMode: "default",
      cwd: process.cwd(),
    });
    const modelSelection = { instanceId, model: "default" } as const;
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make(`provider-session-devin-plan-${runtimeMode}`),
      modelSelection,
      runtimePolicy,
    });
    const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
    const now = yield* DateTime.now;
    const suffix = `${threadId}:1`;
    yield* runtime
      .startTurn({
        appThread: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make(`project:${threadId}`),
          title: "Devin plan exit",
          providerInstanceId: instanceId,
          modelSelection,
          runtimeMode,
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: providerThread.id,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
        threadId,
        runId: RunId.make(`run:${suffix}`),
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make(`attempt:${suffix}`),
        rootNodeId: NodeId.make(`node:${suffix}`),
        providerThread,
        message: {
          createdBy: "user",
          creationSource: "web",
          messageId: MessageId.make(`message:${suffix}`),
          text: "Plan the change, then build it.",
          attachments: [],
        },
        modelSelection,
        runtimePolicy,
      })
      .pipe(Effect.forkScoped);
    const handler = yield* Deferred.await(permissionHandler).pipe(
      Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.die("no handler") }),
    );
    const answer = yield* handler(
      {
        sessionId: SESSION_ID,
        toolCall: { toolCallId: "exit-plan", title: "Exit plan mode", kind: "switch_mode" },
        options: [...offered],
      },
      { requestId: "devin-plan-exit", method: "session/request_permission" },
    ).pipe(Effect.forkScoped);
    if (runtimeMode !== "full-access") {
      const pending = Option.getOrThrow(
        yield* runtime.events.pipe(
          Stream.filter(
            (event) =>
              event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
          ),
          Stream.runHead,
          Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.die("no pending") }),
        ),
      );
      if (pending.type !== "runtime_request.updated") {
        return yield* Effect.die("Expected a pending plan-exit request");
      }
      yield* runtime
        .respondToRuntimeRequest({ requestId: pending.runtimeRequest.id, decision })
        .pipe(Effect.forkScoped);
    }
    const sent = yield* Fiber.join(answer).pipe(
      Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.die("no answer") }),
    );
    return sent.outcome.outcome === "selected" ? sent.outcome.optionId : null;
  });

describe("ACP registry permission answers", () => {
  it.live("a person's approval of Devin's plan never selects the bypass option", () =>
    answerPlanExit("devin", "approval-required", "accept").pipe(
      Effect.map((sent) => assert.equal(sent, "plan_approve")),
      Effect.provide(layerTest),
      Effect.scoped,
    ),
  );

  it.live("Full access never auto-approves Devin's plan with the bypass option", () =>
    answerPlanExit("devin", "full-access", "accept").pipe(
      Effect.map((sent) => assert.equal(sent, "plan_approve")),
      Effect.provide(layerTest),
      Effect.scoped,
    ),
  );

  it.live.each(["/usr/local/bin/devin", "C:\\tools\\devin.exe"])(
    "a locally installed Devin (%s) never answers with the bypass option",
    (commandPath) =>
      Effect.gen(function* () {
        assert.equal(
          yield* answerPlanExit({ source: "local", commandPath }, "approval-required", "accept"),
          "plan_approve",
        );
        assert.equal(
          yield* answerPlanExit({ source: "local", commandPath }, "full-access", "accept"),
          "plan_approve",
        );
      }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live("Devin's reject still answers with its reject option", () =>
    answerPlanExit("devin", "approval-required", "decline").pipe(
      Effect.map((sent) => assert.equal(sent, "plan_reject")),
      Effect.provide(layerTest),
      Effect.scoped,
    ),
  );

  // Any agent, not only one recognised as Devin (a wrapper script, another
  // registry agent), may list the bypass option first.
  it.live.each([
    { label: "another registry agent", agent: "gemini" },
    {
      label: "Devin behind a wrapper",
      agent: { source: "local", commandPath: "/opt/bin/agent-run" },
    },
  ] as const)("$label never answers with the bypass option", ({ agent }) =>
    Effect.gen(function* () {
      assert.equal(yield* answerPlanExit(agent, "approval-required", "accept"), "plan_approve");
      assert.equal(yield* answerPlanExit(agent, "full-access", "accept"), "plan_approve");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live("an approval sends the agent's option ID exactly as offered", () =>
    answerPlanExit("gemini", "approval-required", "accept", [
      { optionId: " opaque-choice ", name: "Allow once", kind: "allow_once" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ]).pipe(
      Effect.map((sent) => assert.equal(sent, " opaque-choice ")),
      Effect.provide(layerTest),
      Effect.scoped,
    ),
  );

  // An agent that trims IDs would read "same" as either answer.
  it.live("an ID that both an allow and a reject option use is never sent", () =>
    Effect.gen(function* () {
      const offered: ReadonlyArray<PermissionOption> = [
        { optionId: " same ", name: "Allow once", kind: "allow_once" },
        { optionId: "same", name: "Reject", kind: "reject_once" },
      ];
      assert.isNull(yield* answerPlanExit("gemini", "approval-required", "decline", offered));
      assert.isNull(yield* answerPlanExit("gemini", "approval-required", "accept", offered));
      assert.isNull(yield* answerPlanExit("gemini", "full-access", "accept", offered));
      // Full access approves once or not at all, never for good instead.
      assert.isNull(
        yield* answerPlanExit("gemini", "full-access", "accept", [
          ...offered,
          { optionId: "always", name: "Always allow", kind: "allow_always" },
        ]),
      );
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
