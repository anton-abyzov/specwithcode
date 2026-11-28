import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ClaudeSettings,
  MessageId,
  type ModelSelection,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@specweave-studio/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as IdAllocator from "../IdAllocator.ts";
import { type ProviderAdapterV2Event, ProviderAdapterV2RuntimePolicy } from "../ProviderAdapter.ts";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";

const SETTINGS = Schema.decodeSync(ClaudeSettings)({});
const MODEL = {
  instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
  model: "claude-sonnet-4-6",
} satisfies ModelSelection;

/** Opens a Claude session on a fake query and starts one turn of a person's thread. */
const openElicitationTurn = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "studio-claude-elicitation-",
  });
  let openedOptions: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions | undefined;
  const adapter = ClaudeAdapterV2.makeClaudeAdapterV2({
    instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
    settings: SETTINGS,
    environment: {},
    attachmentsDir,
    fileSystem,
    path: yield* Path.Path,
    crypto: yield* Crypto.Crypto,
    idAllocator,
    queryRunner: {
      allocateSessionId: Effect.succeed("native-thread-claude-elicitation"),
      open: (input) =>
        Effect.sync(() => {
          openedOptions = input.options;
          return {
            messages: Stream.never,
            offer: () => Effect.void,
            setModel: () => Effect.void,
            setPermissionMode: () => Effect.void,
            interrupt: Effect.void,
            close: Effect.void,
          };
        }),
      forkSession: () => Effect.die("unused"),
      subagentLaunchToolUseId: () => Effect.succeed(null),
      assertComplete: Effect.void,
    },
  });
  // Full access: the form still waits for the person.
  const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: "full-access",
    interactionMode: "default",
    cwd: "/workspace",
  });
  const threadId = ThreadId.make("thread-claude-elicitation");
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("provider-session-claude-elicitation"),
    modelSelection: MODEL,
    runtimePolicy,
  });
  const providerThread = yield* runtime.ensureThread({
    threadId,
    modelSelection: MODEL,
    runtimePolicy,
  });
  const now = yield* DateTime.now;
  const attemptId = RunAttemptId.make("attempt-claude-elicitation");
  yield* runtime.startTurn({
    appThread: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make("project-claude-elicitation"),
      title: "Claude elicitation test",
      providerInstanceId: MODEL.instanceId,
      modelSelection: MODEL,
      runtimeMode: "full-access",
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
    runId: RunId.make(`run-${attemptId}`),
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId,
    rootNodeId: NodeId.make(`node-${attemptId}`),
    providerThread,
    message: {
      createdBy: "user",
      creationSource: "web",
      messageId: MessageId.make(`message-${attemptId}`),
      text: "Delete the test repository.",
      attachments: [],
    },
    modelSelection: MODEL,
    runtimePolicy,
  });
  return {
    runtime,
    providerThread,
    openedOptions: openedOptions as ClaudeAdapterV2.ClaudeAgentSdkQueryOptions | undefined,
  };
});

const LAYER = Layer.merge(IdAllocator.layer, NodeServices.layer);

const requestedSchema = {
  type: "object",
  properties: { confirm: { type: "string", title: "Type octo/repo to confirm" } },
  required: ["confirm"],
};

/** Waits a few event-loop turns for a condition the adapter's fibers reach. */
const until = (check: () => boolean) =>
  Effect.promise(async () => {
    for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setImmediate(resolve));
    return check();
  });

describe("ClaudeAdapterV2 MCP elicitation", () => {
  it.effect("passes onElicitation and answers a form with the person's content", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { runtime, openedOptions } = yield* openElicitationTurn;
        const onElicitation = openedOptions?.onElicitation;
        assert.isFunction(onElicitation);
        // The SDK runs Elicitation hooks before onElicitation; the app installs none.
        const hookEvents = Object.keys(openedOptions?.hooks ?? {});
        assert.notInclude(hookEvents, "Elicitation");
        assert.notInclude(hookEvents, "ElicitationResult");

        const requestEvents = yield* runtime.events.pipe(
          Stream.takeUntil(
            (event) =>
              event.type === "turn_item.updated" && event.turnItem.type === "approval_request",
          ),
          Stream.runCollect,
          Effect.forkScoped,
        );
        const result = yield* Effect.promise(() =>
          onElicitation!(
            {
              serverName: "github",
              message: "Delete octo/repo? This cannot be undone.",
              mode: "form",
              requestedSchema,
            },
            { signal: new AbortController().signal, requestId: "sdk-elicitation-1" },
          ),
        ).pipe(Effect.forkScoped);
        const events = yield* Fiber.join(requestEvents);
        const request = events.find((event) => event.type === "runtime_request.updated");
        assert.equal(
          request?.type === "runtime_request.updated" ? request.runtimeRequest.kind : undefined,
          "mcp-elicitation",
        );
        assert.equal(
          request?.type === "runtime_request.updated" ? request.runtimeRequest.status : undefined,
          "pending",
        );
        const item = events.findLast((event) => event.type === "turn_item.updated");
        const approval =
          item?.type === "turn_item.updated" && item.turnItem.type === "approval_request"
            ? item.turnItem
            : undefined;
        assert.deepStrictEqual(approval?.elicitation, {
          serverName: "github",
          mode: "form",
          message: "Delete octo/repo? This cannot be undone.",
          requestedSchema,
        });
        assert.equal(approval?.appName, "github");
        assert.isFalse((approval?.options ?? []).some((option) => option.decision === "accept"));

        yield* runtime.respondToRuntimeRequest({
          requestId:
            request?.type === "runtime_request.updated"
              ? request.runtimeRequest.id
              : (undefined as never),
          decision: "accept",
          answers: { confirm: "octo/repo" },
        });
        assert.deepStrictEqual(yield* Fiber.join(result), {
          action: "accept",
          content: { confirm: "octo/repo" },
        });
      }).pipe(Effect.provide(LAYER)),
    ),
  );

  it.effect(
    "says the server stopped waiting when the SDK aborts, and not after the person's Stop (1495)",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { runtime, providerThread, openedOptions } = yield* openElicitationTurn;
          const onElicitation = openedOptions?.onElicitation;
          assert.isFunction(onElicitation);
          const events: Array<ProviderAdapterV2Event> = [];
          yield* runtime.events.pipe(
            Stream.runForEach((event) => Effect.sync(() => void events.push(event))),
            Effect.forkScoped,
          );
          const cards = () =>
            events.flatMap((event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "approval_request" &&
              event.turnItem.status !== "cancelled"
                ? [event.turnItem]
                : [],
            );
          const notices = () =>
            events.flatMap((event) =>
              event.type === "turn_item.updated" && event.turnItem.type === "system_notice"
                ? [event.turnItem.message]
                : [],
            );
          const ask = (signal: AbortSignal, requestId: string) =>
            Effect.promise(() =>
              onElicitation!(
                {
                  serverName: "github",
                  message: "Delete octo/repo?",
                  mode: "form",
                  requestedSchema,
                },
                { signal, requestId },
              ),
            ).pipe(Effect.forkScoped);

          // The server cancels its request (the probe's 60 s SDK timeout): the SDK aborts.
          const serverGaveUp = new AbortController();
          const first = yield* ask(serverGaveUp.signal, "sdk-elicitation-1");
          assert.isTrue(yield* until(() => cards().length === 1));
          serverGaveUp.abort();
          assert.deepStrictEqual(yield* Fiber.join(first), { action: "cancel" });
          assert.isTrue(yield* until(() => notices().length === 1));
          assert.deepStrictEqual(notices(), ["github stopped waiting for an answer."]);

          // The person's Stop marks the turn before the CLI aborts the request.
          const stopped = new AbortController();
          const second = yield* ask(stopped.signal, "sdk-elicitation-2");
          assert.isTrue(yield* until(() => cards().length === 2));
          const providerTurnId = cards()[1]!.providerTurnId;
          assert.isDefined(providerTurnId);
          yield* runtime
            .interruptTurn({ providerThread, providerTurnId: providerTurnId! })
            .pipe(Effect.ignore, Effect.forkScoped);
          yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
          stopped.abort();
          assert.deepStrictEqual(yield* Fiber.join(second), { action: "cancel" });
          yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
          assert.deepStrictEqual(notices(), ["github stopped waiting for an answer."]);
        }).pipe(Effect.provide(LAYER)),
      ),
  );
});
