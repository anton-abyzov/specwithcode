/** Real OpenCode 1.x adapter contract with a local deterministic model, no account or spend.
 * Launched by scripts/harness-support/opencode-runtime.py with an explicit isolated server.
 */
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { describe } from "vite-plus/test";
import {
  MessageId,
  NodeId,
  OpenCodeSettings,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ProviderThread,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as ServerConfig from "../../config.ts";
import type { OpenCodeRuntimeShape } from "../../provider/opencodeRuntime.ts";
import * as IdAllocator from "../IdAllocator.ts";
import { ProviderAdapterV2RuntimePolicy } from "../ProviderAdapter.ts";
import { makeOpenCodeAdapterV2 } from "./OpenCodeAdapterV2.ts";

const OPEN_CODE_TEST_SETTINGS = Schema.decodeSync(OpenCodeSettings)({
  serverUrl: process.env.OPENCODE_FIXTURE_URL ?? "http://test.invalid",
});
function runtimePolicy(
  runtimeMode: ProviderAdapterV2RuntimePolicy["runtimeMode"],
  override: Partial<ProviderAdapterV2RuntimePolicy> = {},
) {
  return ProviderAdapterV2RuntimePolicy.make({
    runtimeMode,
    interactionMode: "default",
    cwd: null,
    ...override,
  });
}
const makeOpenCodeRuntimeHarness = Effect.fn("makeOpenCodeRuntimeHarness")(function* (
  suffix: string,
  url: string,
  directory: string,
  existingProviderThread?: OrchestrationV2ProviderThread,
  policyOverride: Partial<ProviderAdapterV2RuntimePolicy> = {},
) {
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const instanceId = ProviderInstanceId.make("opencode-native-contract");
  const threadId = ThreadId.make("thread-opencode-native-contract");
  const modelSelection = {
    instanceId,
    model: "fixture/test",
    options: [],
  };
  const policy = runtimePolicy("full-access", { cwd: directory, ...policyOverride });
  const adapter = makeOpenCodeAdapterV2({
    instanceId,
    settings: OPEN_CODE_TEST_SETTINGS,
    environment: {},
    runtime: {
      connectToOpenCodeServer: () => Effect.succeed({ url, external: true }),
      createOpenCodeSdkClient: () =>
        createOpencodeClient({ baseUrl: url, directory, throwOnError: true }),
    } as unknown as OpenCodeRuntimeShape,
    idAllocator,
    serverConfig: {
      cwd: directory,
      attachmentsDir: "/tmp/attachments",
    } as ServerConfig.ServerConfig["Service"],
  });
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make(`session-opencode-${suffix}`),
    modelSelection,
    runtimePolicy: policy,
  });
  const providerThread = yield* runtime.ensureThread({
    ...(existingProviderThread === undefined ? {} : { existingProviderThread }),
    threadId,
    modelSelection,
    runtimePolicy: policy,
  });
  const now = yield* DateTime.now;
  const startTurn = (
    text = "hello",
    startProviderThread: OrchestrationV2ProviderThread = providerThread,
  ) =>
    runtime.startTurn({
      appThread: {
        id: threadId,
        projectId: ProjectId.make(`project-opencode-${suffix}`),
        title: suffix,
        providerInstanceId: modelSelection.instanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: providerThread.id,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdBy: "user",
        creationSource: "web",
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
      threadId,
      runId: RunId.make(`run-opencode-${suffix}`),
      runOrdinal: 1,
      providerTurnOrdinal: 1,
      attemptId: RunAttemptId.make(`attempt-opencode-${suffix}`),
      rootNodeId: NodeId.make(`node-opencode-${suffix}`),
      providerThread: startProviderThread,
      message: {
        createdBy: "user",
        creationSource: "web",
        messageId: MessageId.make(`message-opencode-${suffix}`),
        text,
        attachments: [],
      },
      modelSelection,
      runtimePolicy: policy,
    });
  return {
    now,
    policy,
    providerThread,
    runId: RunId.make(`run-opencode-${suffix}`),
    runtime,
    startTurn,
    threadId,
  };
});

const url = process.env.OPENCODE_FIXTURE_URL;
const directory = process.env.OPENCODE_FIXTURE_DIRECTORY;
describe.runIf(Boolean(url && directory))("OpenCode real runtime through app adapter", () => {
  it.live(
    "projects tools and streaming, then resumes the native session in a new adapter session",
    () =>
      Effect.gen(function* () {
        const first = yield* makeOpenCodeRuntimeHarness("native-first", url!, directory!);
        const observed = yield* first.runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* first.startTurn("Run the fixture command and return HARNESS_RUNTIME_OK");
        const events = yield* Fiber.join(observed).pipe(Effect.timeout("45 seconds"));
        assert.deepInclude(events.at(-1), { type: "turn.terminal", status: "completed" });
        assert.isTrue(
          events.some(
            (event) =>
              event.type === "message.updated" &&
              event.message.role === "assistant" &&
              event.message.text.includes("HARNESS_RUNTIME_OK"),
          ),
        );
        assert.include(JSON.stringify(events), "HARNESS_TOOL_OK");
        assert.isTrue(
          events.some(
            (event) =>
              event.type === "turn_item.updated" && event.turnItem.type === "command_execution",
          ),
        );
        const updated = events.filter((event) => event.type === "provider_thread.updated").at(-1);
        const native =
          updated?.type === "provider_thread.updated"
            ? updated.providerThread
            : first.providerThread;
        const second = yield* makeOpenCodeRuntimeHarness("native-second", url!, directory!, native);
        assert.deepEqual(
          second.providerThread.nativeThreadRef,
          first.providerThread.nativeThreadRef,
        );
        const resumed = yield* second.runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* second.startTurn("RESUME_CHECK");
        const continued = yield* Fiber.join(resumed).pipe(Effect.timeout("45 seconds"));
        assert.deepInclude(continued.at(-1), { type: "turn.terminal", status: "completed" });
        assert.isTrue(
          continued.some(
            (event) =>
              event.type === "message.updated" &&
              event.message.role === "assistant" &&
              event.message.text.includes("RESUME_OK"),
          ),
        );
      }).pipe(Effect.provide([IdAllocator.layer, NodeServices.layer]), Effect.scoped),
  );
});
