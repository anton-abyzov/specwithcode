import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
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
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../../config.ts";
import * as AcpSessionRuntime from "../../provider/acp/AcpSessionRuntime.ts";
import * as IdAllocator from "../IdAllocator.ts";
import { ProviderAdapterV2RuntimePolicy } from "../ProviderAdapter.ts";
import { AcpProviderCapabilitiesV2, makeAcpAdapterV2 } from "./AcpAdapterV2.ts";
import { makeAntigravityAcpAdapterFlavor } from "./AntigravityAdapterV2.ts";

type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
type PermissionHandler = Parameters<RuntimeService["handleRequestPermission"]>[0];
type PermissionRequest = Parameters<PermissionHandler>[0];
type PermissionOption = PermissionRequest["options"][number];

const layerTest = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "studio-acp-question-bypass-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);

const SESSION_ID = "mock-session-1";

// A flavor that shows some permission requests as a question (Antigravity's
// interaction_* requests) offers each option ID as an answer.
const questionFlavor = makeAntigravityAcpAdapterFlavor({
  instanceId: ProviderInstanceId.make("acp-question-bypass-flavor"),
  crypto: undefined as never,
  fileSystem: undefined as never,
  path: undefined as never,
  idAllocator: undefined as never,
  serverConfig: undefined as never,
  selfInvocation: undefined as never,
  makeRuntime: () => Effect.die("not used"),
  withProcess: (_stop, task) => task,
  defaultModel: Effect.succeed(undefined),
});

const offered: ReadonlyArray<PermissionOption> = [
  { optionId: "plan_bypass", name: "Implement and bypass permissions", kind: "allow_once" },
  { optionId: "plan_approve", name: "Implement the plan", kind: "allow_once" },
];

/**
 * Raises one question-shaped permission request in a running turn, answers it
 * with `answer`, and returns the option labels shown plus the option ID sent.
 */
const answerQuestion = (answer: string) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const path = yield* Path.Path;
    const mockAgentPath = yield* path.fromFileUrl(
      new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
    );
    const permissionHandler = yield* Deferred.make<PermissionHandler>();
    const instanceId = ProviderInstanceId.make("acp-question-bypass");
    const threadId = ThreadId.make(`thread-acp-question-bypass-${answer}`);
    const adapter = makeAcpAdapterV2({
      crypto: yield* Crypto.Crypto,
      instanceId,
      flavor: {
        driver: ProviderDriverKind.make("acp-test"),
        capabilities: AcpProviderCapabilitiesV2,
        ...(questionFlavor.extractPermissionQuestion === undefined
          ? {}
          : { extractPermissionQuestion: questionFlavor.extractPermissionQuestion }),
        makeRuntime: (input) =>
          Effect.gen(function* () {
            const context = yield* Layer.build(
              AcpSessionRuntime.layer({
                ...input,
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
      },
      fileSystem: yield* FileSystem.FileSystem,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      serverConfig: yield* ServerConfig.ServerConfig,
      selfInvocation: yield* resolveSelfInvocation(),
    });
    const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
      runtimeMode: "approval-required",
      interactionMode: "default",
      cwd: process.cwd(),
    });
    const modelSelection = { instanceId, model: "default" } as const;
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make(`provider-session-question-bypass-${answer}`),
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
          title: "Question bypass",
          providerInstanceId: instanceId,
          modelSelection,
          runtimeMode: "approval-required",
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
    const sent = yield* handler(
      {
        sessionId: SESSION_ID,
        toolCall: { toolCallId: "interaction_1", title: "How should I continue?" },
        options: [...offered],
      },
      { requestId: "question-bypass", method: "session/request_permission" },
    ).pipe(Effect.forkScoped);
    const shown = Option.getOrThrow(
      yield* runtime.events.pipe(
        Stream.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "user_input_request"
            ? Stream.make(event.turnItem)
            : Stream.empty,
        ),
        Stream.runHead,
        Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.die("no question") }),
      ),
    );
    yield* runtime
      .respondToRuntimeRequest({ requestId: shown.requestId, answers: { interaction_1: answer } })
      .pipe(Effect.forkScoped);
    const response = yield* Fiber.join(sent).pipe(
      Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.die("no answer") }),
    );
    return {
      shown: shown.questions.flatMap((question) => question.options.map((option) => option.label)),
      sent: response.outcome.outcome === "selected" ? response.outcome.optionId : null,
    };
  });

describe("ACP permission questions", () => {
  it.live("a question never offers or sends the agent's bypass option", () =>
    Effect.gen(function* () {
      const bypass = yield* answerQuestion("plan_bypass");
      assert.deepEqual(bypass.shown, ["Implement the plan"]);
      assert.isNull(bypass.sent);
      const approve = yield* answerQuestion("plan_approve");
      assert.equal(approve.sent, "plan_approve");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
