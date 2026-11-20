import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ClaudeSettings,
  CodexSettings,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  ProjectId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as CodexClient from "@specweave-studio/effect-codex-app-server/client";
import * as CodexReplay from "@specweave-studio/effect-codex-app-server/replay";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import {
  ProviderAdapterOpenSessionError,
  ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2TurnInput,
} from "../orchestration-v2/ProviderAdapter.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as CodexAdapterV2 from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ClaudeAdapterV2 from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { makeReplayServerConfig } from "../orchestration-v2/Adapters/CodexAdapterV2.testkit.ts";
import packageJson from "../../package.json" with { type: "json" };

// Native protocol fixtures use the existing adapter replay contract; no live provider process.
const DEFAULT_CLAUDE_SETTINGS = Schema.decodeSync(ClaudeSettings)({});
const DEFAULT_CODEX_SETTINGS = Schema.decodeSync(CodexSettings)({});
const CODEX_TEST_MODEL_SELECTION = {
  instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
  model: "gpt-5.4",
} satisfies ModelSelection;
const CODEX_TEST_RUNTIME_POLICY = ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/workspace",
});

function makeCodexTestAppThread(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
}): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: input.threadId,
    projectId: ProjectId.make(`project-${input.threadId}`),
    title: "Codex continuation test",
    providerInstanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
    modelSelection: CODEX_TEST_MODEL_SELECTION,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: input.providerThread.id,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: input.threadId,
    },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

function makeCodexTestTurnInput(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
  readonly attemptId: RunAttemptId;
  readonly text: string;
}): ProviderAdapterV2TurnInput {
  return {
    appThread: makeCodexTestAppThread(input),
    threadId: input.threadId,
    runId: RunId.make(`run-${input.attemptId}`),
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId: input.attemptId,
    rootNodeId: NodeId.make(`node-${input.attemptId}`),
    providerThread: input.providerThread,
    message: {
      createdBy: "user",
      creationSource: "web",
      messageId: MessageId.make(`message-${input.attemptId}`),
      text: input.text,
      attachments: [],
    },
    modelSelection: CODEX_TEST_MODEL_SELECTION,
    runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
  };
}

function makeCodexReplayTurn(input: {
  readonly id: string;
  readonly status: "inProgress" | "completed" | "interrupted" | "failed";
}): Record<string, unknown> {
  const terminal =
    input.status === "completed" || input.status === "interrupted" || input.status === "failed";
  return {
    id: input.id,
    items: [],
    itemsView: "notLoaded",
    status: input.status,
    error: null,
    startedAt: 1782622440,
    completedAt: terminal ? 1782622450 : null,
    durationMs: null,
  };
}

function codexReplayPreamble(input: {
  readonly nativeThreadId: string;
  readonly nativeTurnId: string;
  readonly prompt: string;
  /** Text the adapter should send, when it differs from what the user typed. */
  readonly sentPrompt?: string;
}): Array<CodexReplay.CodexAppServerReplayEntry> {
  return [
    {
      type: "expect_outbound",
      label: "initialize",
      frame: {
        id: 1,
        method: "initialize",
        params: {
          clientInfo: {
            name: "SpecWeave Studio",
            title: "SpecWeave Studio",
            version: packageJson.version,
          },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: ["turn/diff/updated"],
          },
        },
      },
    },
    {
      type: "emit_inbound",
      label: "initialize",
      frame: {
        id: 1,
        result: {
          userAgent: "SpecWeave Studio/0.156.1",
          codexHome: "/tmp/codex-home",
          platformFamily: "unix",
          platformOs: "macos",
        },
      },
    },
    { type: "expect_outbound", label: "initialized", frame: { method: "initialized" } },
    {
      type: "expect_outbound",
      label: "thread/start",
      frame: {
        id: 2,
        method: "thread/start",
        params: { config: CodexAdapterV2.CODEX_THREAD_CONFIG },
      },
    },
    {
      type: "emit_inbound",
      label: "thread/start",
      frame: {
        id: 2,
        result: {
          thread: {
            id: input.nativeThreadId,
            sessionId: input.nativeThreadId,
            forkedFromId: null,
            preview: "",
            ephemeral: false,
            modelProvider: "openai",
            createdAt: 1782622440,
            updatedAt: 1782622440,
            status: { type: "idle" },
            path: `/tmp/${input.nativeThreadId}.jsonl`,
            cwd: "/workspace",
            cliVersion: "0.144.0",
            source: "vscode",
            threadSource: null,
            agentNickname: null,
            agentRole: null,
            gitInfo: null,
            name: null,
            turns: [],
          },
          model: "gpt-5.4",
          modelProvider: "openai",
          serviceTier: null,
          cwd: "/workspace",
          instructionSources: [],
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
          reasoningEffort: "medium",
        },
      },
    },
    {
      type: "expect_outbound",
      label: "turn/start",
      frame: {
        id: 3,
        method: "turn/start",
        params: {
          threadId: input.nativeThreadId,
          input: [{ type: "text", text: input.sentPrompt ?? input.prompt }],
          cwd: "/workspace",
          model: "gpt-5.4",
          approvalPolicy: "never",
          approvalsReviewer: "user",
          sandboxPolicy: { type: "dangerFullAccess" },
          summary: "detailed",
        },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/start",
      frame: {
        id: 3,
        result: { turn: makeCodexReplayTurn({ id: input.nativeTurnId, status: "inProgress" }) },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/started",
      frame: {
        method: "turn/started",
        params: {
          threadId: input.nativeThreadId,
          turn: makeCodexReplayTurn({ id: input.nativeTurnId, status: "inProgress" }),
        },
      },
    },
  ];
}

function makeCodexReplayTranscript(input: {
  readonly scenario: string;
  readonly entries: ReadonlyArray<CodexReplay.CodexAppServerReplayEntry>;
}): CodexReplay.CodexAppServerReplayTranscript {
  return {
    provider: "codex",
    protocol: "codex.app-server",
    version: "0.144.0",
    scenario: input.scenario,
    entries: input.entries,
  };
}

const testLayer = Layer.merge(IdAllocator.layer, NodeServices.layer);
const openCodex = (
  transcript: CodexReplay.CodexAppServerReplayTranscript,
  onRequest: (method: string, params: unknown) => void = () => {},
  observe: {
    // Runs once the app-server answered the request.
    readonly answered?: (method: string) => Effect.Effect<void>;
    // Runs once the adapter's handler for the notification returned.
    readonly handled?: (method: string) => Effect.Effect<void>;
  } = {},
) =>
  Effect.gen(function* () {
    const adapter = CodexAdapterV2.makeCodexAdapterV2({
      instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
      settings: DEFAULT_CODEX_SETTINGS,
      environment: {},
      crypto: yield* Crypto.Crypto,
      fileSystem: yield* FileSystem.FileSystem,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      serverConfig: yield* makeReplayServerConfig(transcript.scenario).pipe(Effect.orDie),
      clientFactory: {
        open: (input) =>
          Layer.build(CodexReplay.layerReplay(transcript)).pipe(
            Effect.flatMap((context) =>
              Effect.service(CodexClient.CodexAppServerClient).pipe(Effect.provide(context)),
            ),
            Effect.map(
              (client) =>
                ({
                  ...client,
                  request: (method, params) =>
                    Effect.sync(() => onRequest(method, params)).pipe(
                      Effect.andThen(client.request(method, params)),
                      Effect.tap(() => observe.answered?.(method) ?? Effect.void),
                    ),
                  handleServerNotification: (method, handler) =>
                    client.handleServerNotification(method, (payload) =>
                      handler(payload).pipe(
                        Effect.andThen(observe.handled?.(method) ?? Effect.void),
                      ),
                    ),
                }) satisfies CodexClient.CodexAppServerClient["Service"],
            ),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterOpenSessionError({
                  driver: CodexAdapterV2.CODEX_DRIVER_KIND,
                  providerSessionId: input.providerSessionId,
                  cause,
                }),
            ),
          ),
      },
    });
    const threadId = ThreadId.make(`thread-${transcript.scenario}`);
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make("context-session"),
      modelSelection: CODEX_TEST_MODEL_SELECTION,
      runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
    });
    const providerThread = yield* runtime.ensureThread({
      threadId,
      modelSelection: CODEX_TEST_MODEL_SELECTION,
      runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
    });
    return { runtime, providerThread, threadId };
  });

it.effect.each([true, false])("Codex acknowledges only after turn/start succeeds (%s)", (success) =>
  Effect.gen(function* () {
    const entries = codexReplayPreamble({
      nativeThreadId: "context-native",
      nativeTurnId: "context-turn",
      prompt: "request",
    }).slice(0, 7);
    if (!success)
      entries[6] = {
        type: "emit_inbound",
        label: "rejected",
        frame: { id: 3, error: { code: -32600, message: "request rejected" } },
      };
    let accepted = 0;
    const harness = yield* openCodex(
      makeCodexReplayTranscript({ scenario: `context-${success}`, entries }),
      (method) => {
        if (method === "turn/start") assert.equal(accepted, 0);
      },
    );
    const input = makeCodexTestTurnInput({
      ...harness,
      now: yield* DateTime.now,
      attemptId: RunAttemptId.make("context"),
      text: "request",
    });
    const result = yield* harness.runtime
      .startTurn({
        ...input,
        projectContext: {
          restore: Effect.succeed("fresh"),
          accepted: Effect.sync(() => {
            accepted++;
          }),
        },
      })
      .pipe(Effect.result);
    assert.equal(result._tag, success ? "Success" : "Failure");
    assert.equal(accepted, success ? 1 : 0);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("Codex first native goal carries project context and keeps the objective unchanged", () =>
  Effect.gen(function* () {
    const nativeThreadId = "goal-context-native";
    const objective = "Ship the feature";
    const goal = (status: string) => ({
      threadId: nativeThreadId,
      objective,
      status,
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1782622440,
      updatedAt: 1782622450,
    });
    const request = (
      id: number,
      method: string,
      params: unknown,
      result: unknown,
    ): CodexReplay.CodexAppServerReplayEntry[] => [
      { type: "expect_outbound", label: method, frame: { id, method, params } },
      { type: "emit_inbound", label: method, frame: { id, result } },
    ];
    const preamble = codexReplayPreamble({
      nativeThreadId,
      nativeTurnId: "goal-turn",
      prompt: objective,
    });
    const goalStart = preamble.slice(5, 7).map((entry) => {
      const frame = "frame" in entry ? (entry.frame as Record<string, unknown>) : {};
      return {
        ...entry,
        frame: {
          ...frame,
          id: 5,
          ...(frame.method === "turn/start"
            ? {
                params: {
                  ...(frame.params as object),
                  additionalContext: {
                    studio_project_context: { kind: "untrusted", value: "PROJECT MEMORY" },
                  },
                },
              }
            : {}),
        },
      };
    }) as CodexReplay.CodexAppServerReplayEntry[];
    const harness = yield* openCodex(
      makeCodexReplayTranscript({
        scenario: "first-goal-context",
        entries: [
          ...preamble.slice(0, 5),
          ...request(3, "thread/goal/get", { threadId: nativeThreadId }, { goal: null }),
          ...request(
            4,
            "thread/goal/set",
            { threadId: nativeThreadId, objective, status: "paused" },
            { goal: goal("paused") },
          ),
          ...goalStart,
          ...request(
            6,
            "thread/goal/set",
            { threadId: nativeThreadId, status: "active" },
            { goal: goal("active") },
          ),
        ],
      }),
    );
    let accepted = 0;
    yield* harness.runtime.startTurn({
      ...makeCodexTestTurnInput({
        ...harness,
        now: yield* DateTime.now,
        attemptId: RunAttemptId.make("goal-context"),
        text: `/goal ${objective}`,
      }),
      projectContext: {
        nativeCommandText: "PROJECT MEMORY",
        restore: Effect.succeed("fresh"),
        accepted: Effect.sync(() => {
          accepted++;
        }),
      },
    });
    assert.equal(accepted, 1);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

// Live clock: the second turn is given real time to reach turn/start if it would.
it.live(
  "Codex starts the next turn only after a compaction's project context restore is injected",
  () =>
    Effect.gen(function* () {
      const nativeThreadId = "restore-order-native";
      const firstTurn = makeCodexReplayTurn({ id: "first-turn", status: "completed" });
      const preamble = codexReplayPreamble({
        nativeThreadId,
        nativeTurnId: "first-turn",
        prompt: "work",
      });
      const second = codexReplayPreamble({
        nativeThreadId,
        nativeTurnId: "second-turn",
        prompt: "next",
      })
        .slice(5)
        .map((entry) => {
          const frame = "frame" in entry ? (entry.frame as Record<string, unknown>) : {};
          return { ...entry, frame: "id" in frame ? { ...frame, id: 5 } : frame };
        }) as CodexReplay.CodexAppServerReplayEntry[];
      const methods: Array<string> = [];
      const harness = yield* openCodex(
        makeCodexReplayTranscript({
          scenario: "project-restore-order",
          entries: [
            ...preamble,
            {
              type: "emit_inbound",
              label: "compacted",
              frame: {
                method: "item/completed",
                params: {
                  threadId: nativeThreadId,
                  turnId: "first-turn",
                  item: { type: "contextCompaction", id: "compaction-1" },
                },
              },
            },
            {
              type: "emit_inbound",
              label: "first done",
              frame: {
                method: "turn/completed",
                params: { threadId: nativeThreadId, turn: firstTurn },
              },
            },
            // Strict order: the restore's injection must come before the next turn/start.
            {
              type: "expect_outbound",
              label: "restore",
              frame: {
                id: 4,
                method: "thread/inject_items",
                params: {
                  threadId: nativeThreadId,
                  items: [
                    {
                      type: "message",
                      role: "user",
                      content: [{ type: "input_text", text: "restored memory" }],
                    },
                  ],
                },
              },
            },
            { type: "emit_inbound", label: "restored", frame: { id: 4, result: {} } },
            ...second,
          ],
        }),
        (method) => {
          methods.push(method);
        },
      );
      const terminals = yield* Queue.unbounded<void>();
      yield* harness.runtime.events.pipe(
        Stream.runForEach((event) =>
          event.type === "turn.terminal" ? Queue.offer(terminals, undefined) : Effect.void,
        ),
        Effect.forkScoped,
      );
      const restoreCalled = yield* Deferred.make<void>();
      const releaseRestore = yield* Deferred.make<void>();
      const turn = (attempt: string, text: string) => ({
        ...makeCodexTestTurnInput({
          ...harness,
          now: DateTime.nowUnsafe(),
          attemptId: RunAttemptId.make(attempt),
          text,
        }),
        projectContext: {
          accepted: Effect.void,
          restore: Deferred.succeed(restoreCalled, undefined).pipe(
            Effect.andThen(Deferred.await(releaseRestore)),
            Effect.as("restored memory"),
          ),
        },
      });
      yield* harness.runtime.startTurn(turn("restore-order-1", "work"));
      yield* Deferred.await(restoreCalled);
      yield* Queue.take(terminals);
      // The next prompt arrives while the restore is still on its way.
      const next = yield* harness.runtime
        .startTurn(turn("restore-order-2", "next"))
        .pipe(Effect.forkScoped);
      yield* Effect.sleep("50 millis");
      assert.equal(methods.filter((method) => method === "turn/start").length, 1);
      yield* Deferred.succeed(releaseRestore, undefined);
      yield* Fiber.join(next);
      assert.deepEqual(methods.slice(-2), ["thread/inject_items", "turn/start"]);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect(
  "Codex acknowledges no prompt after a restore whose injection failed, until one succeeds",
  () =>
    Effect.gen(function* () {
      const nativeThreadId = "restore-unsettled-native";
      const firstTurn = makeCodexReplayTurn({ id: "first-turn", status: "completed" });
      const preamble = codexReplayPreamble({
        nativeThreadId,
        nativeTurnId: "first-turn",
        prompt: "work",
      });
      const nextTurn = (prompt: string, nativeTurnId: string, id: number) =>
        codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt })
          .slice(5)
          .map((entry) => {
            const frame = "frame" in entry ? (entry.frame as Record<string, unknown>) : {};
            return { ...entry, frame: "id" in frame ? { ...frame, id } : frame };
          }) as CodexReplay.CodexAppServerReplayEntry[];
      const compacted = (id: string, turnId: string): CodexReplay.CodexAppServerReplayEntry => ({
        type: "emit_inbound",
        label: `compacted ${id}`,
        frame: {
          method: "item/completed",
          params: {
            threadId: nativeThreadId,
            turnId,
            item: { type: "contextCompaction", id },
          },
        },
      });
      const inject = (id: number): CodexReplay.CodexAppServerReplayEntry => ({
        type: "expect_outbound",
        label: `restore ${id}`,
        frame: {
          id,
          method: "thread/inject_items",
          params: {
            threadId: nativeThreadId,
            items: [
              {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: "restored memory" }],
              },
            ],
          },
        },
      });
      const harness = yield* openCodex(
        makeCodexReplayTranscript({
          scenario: "project-restore-unsettled",
          entries: [
            ...preamble,
            compacted("compaction-1", "first-turn"),
            {
              type: "emit_inbound",
              label: "first done",
              frame: {
                method: "turn/completed",
                params: { threadId: nativeThreadId, turn: firstTurn },
              },
            },
            // The restore waits for turn/completed: items injected mid-turn make it sample again.
            inject(4),
            // The injection's outcome is unknown, as after a timeout.
            {
              type: "emit_inbound",
              label: "restore failed",
              frame: { id: 4, error: { code: -32000, message: "request timed out" } },
            },
            ...nextTurn("second", "second-turn", 5),
            compacted("compaction-2", "second-turn"),
            {
              type: "emit_inbound",
              label: "second done",
              frame: {
                method: "turn/completed",
                params: {
                  threadId: nativeThreadId,
                  turn: makeCodexReplayTurn({ id: "second-turn", status: "completed" }),
                },
              },
            },
            inject(6),
            { type: "emit_inbound", label: "restored", frame: { id: 6, result: {} } },
            ...nextTurn("third", "third-turn", 7),
          ],
        }),
      );
      const terminals = yield* Queue.unbounded<void>();
      yield* harness.runtime.events.pipe(
        Stream.runForEach((event) =>
          event.type === "turn.terminal" ? Queue.offer(terminals, undefined) : Effect.void,
        ),
        Effect.forkScoped,
      );
      const restoreCalls = yield* Queue.unbounded<void>();
      const accepted: Array<string> = [];
      const turn = (attempt: string, text: string) => ({
        ...makeCodexTestTurnInput({
          ...harness,
          now: DateTime.nowUnsafe(),
          attemptId: RunAttemptId.make(attempt),
          text,
        }),
        projectContext: {
          accepted: Effect.sync(() => {
            accepted.push(text);
          }),
          restore: Queue.offer(restoreCalls, undefined).pipe(Effect.as("restored memory")),
        },
      });
      // Each next turn waits for the restore in flight (awaitRestores), so the
      // injection's outcome is known when it starts.
      yield* harness.runtime.startTurn(turn("unsettled-1", "work"));
      yield* Queue.take(restoreCalls);
      yield* Queue.take(terminals);
      yield* harness.runtime.startTurn(turn("unsettled-2", "second"));
      // The failed injection may still land, so the second prompt is not acknowledged.
      assert.deepEqual(accepted, ["work"]);
      yield* Queue.take(restoreCalls);
      yield* Queue.take(terminals);
      yield* harness.runtime.startTurn(turn("unsettled-3", "third"));
      assert.deepEqual(accepted, ["work", "third"]);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect(
  "Claude running/offer and foreign UUIDs do not acknowledge context; a matching native echo does",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const messages = yield* Queue.unbounded<SDKMessage>();
      const processed = yield* Queue.unbounded<void>();
      const offered: SDKUserMessage[] = [];
      let openedOptions: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions | undefined;
      let currentMemory = "old memory";
      const adapter = ClaudeAdapterV2.makeClaudeAdapterV2({
        instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
        settings: DEFAULT_CLAUDE_SETTINGS,
        environment: {},
        attachmentsDir: yield* fs.makeTempDirectoryScoped({ prefix: "context-claude-" }),
        fileSystem: fs,
        path: yield* Path.Path,
        crypto: yield* Crypto.Crypto,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        queryRunner: {
          allocateSessionId: Effect.succeed("native-context-claude"),
          open: (input) =>
            Effect.sync(() => {
              openedOptions = input.options;
              return {
                messages: Stream.fromQueue(messages).pipe(
                  Stream.flatMap((message) =>
                    Stream.make(message).pipe(
                      Stream.concat(
                        Stream.fromEffect(Queue.offer(processed, undefined)).pipe(Stream.drain),
                      ),
                    ),
                  ),
                ),
                offer: (message) =>
                  Effect.sync(() => {
                    offered.push(message);
                  }),
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
      const modelSelection = {
        instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
        model: "claude-sonnet-4-6",
      };
      const threadId = ThreadId.make("claude-context-thread");
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("claude-context-session"),
        modelSelection,
        runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
      });
      let accepted = 0;
      const confirmed = yield* Deferred.make<void>();
      yield* runtime.startTurn({
        ...makeCodexTestTurnInput({
          threadId,
          providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("claude-context"),
          text: "project snapshot and user request",
        }),
        modelSelection,
        projectContext: {
          restore: Effect.sync(() => currentMemory),
          accepted: Effect.sync(() => {
            accepted++;
          }).pipe(Effect.andThen(Deferred.succeed(confirmed, undefined)), Effect.asVoid),
        },
      });
      assert.equal(offered.length, 1);
      assert.equal(accepted, 0);
      const frame = (uuid: string) =>
        ({
          type: "system",
          subtype: "init",
          uuid: "00000000-0000-4000-8000-000000000001",
          session_id: "native-context-claude",
          user_message_uuid: uuid,
        }) as unknown as SDKMessage;
      yield* Queue.offer(messages, frame("unrelated-prompt"));
      yield* Queue.take(processed);
      assert.equal(accepted, 0);
      yield* Queue.offer(messages, frame(offered[0]!.uuid!));
      yield* Deferred.await(confirmed);
      assert.equal(accepted, 1);
      currentMemory = "new memory after the prompt";
      const restored = yield* Effect.promise(() =>
        openedOptions!.hooks!.SessionStart!.at(-1)!.hooks[0]!(
          {
            hook_event_name: "SessionStart",
            source: "compact",
            session_id: "native-context-claude",
            transcript_path: "/tmp/fake",
            cwd: "/workspace",
          },
          undefined,
          { signal: new AbortController().signal },
        ),
      );
      assert.deepEqual(restored, {
        hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: currentMemory },
      });
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect(
  "Codex native compaction restores fresh project memory once for duplicate notifications",
  () =>
    Effect.gen(function* () {
      const nativeThreadId = "compact-native";
      const nativeTurnId = "compact-turn";
      const completed = yield* Deferred.make<void>();
      const restoreAnswered = yield* Deferred.make<void>();
      const lateDuplicateHandled = yield* Deferred.make<void>();
      const compacted: CodexReplay.CodexAppServerReplayEntry = {
        type: "emit_inbound",
        label: "compacted",
        frame: {
          method: "item/completed",
          params: {
            threadId: nativeThreadId,
            turnId: nativeTurnId,
            item: { type: "contextCompaction", id: "same-compaction" },
          },
        },
      };
      // The restore waits for turn/completed, so each one below is a chance to restore.
      const turnCompleted: CodexReplay.CodexAppServerReplayEntry = {
        type: "emit_inbound",
        label: "done",
        frame: {
          method: "turn/completed",
          params: {
            threadId: nativeThreadId,
            turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
          },
        },
      };
      let restored = 0;
      let injected = 0;
      let turnsCompleted = 0;
      let memory = "old";
      const harness = yield* openCodex(
        makeCodexReplayTranscript({
          scenario: "project-compaction",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "work" }),
            compacted,
            compacted,
            turnCompleted,
            {
              type: "expect_outbound",
              label: "restore",
              frame: {
                id: 4,
                method: "thread/inject_items",
                params: {
                  threadId: nativeThreadId,
                  items: [
                    {
                      type: "message",
                      role: "user",
                      content: [{ type: "input_text", text: "fresh project memory" }],
                    },
                  ],
                },
              },
            },
            { type: "emit_inbound", label: "restored", frame: { id: 4, result: {} } },
            // The same compaction reported again after its restore was answered.
            compacted,
            turnCompleted,
          ],
        }),
        (method) => {
          if (method === "turn/start") memory = "fresh project memory";
          if (method === "thread/inject_items") injected++;
        },
        {
          answered: (method) =>
            method === "thread/inject_items"
              ? Deferred.succeed(restoreAnswered, undefined).pipe(Effect.asVoid)
              : Effect.void,
          handled: (method) =>
            method === "turn/completed" && ++turnsCompleted === 2
              ? Deferred.succeed(lateDuplicateHandled, undefined).pipe(Effect.asVoid)
              : Effect.void,
        },
      );
      yield* harness.runtime.events.pipe(
        Stream.runForEach((event) =>
          event.type === "turn.terminal" ? Deferred.succeed(completed, undefined) : Effect.void,
        ),
        Effect.forkScoped,
      );
      yield* harness.runtime.startTurn({
        ...makeCodexTestTurnInput({
          ...harness,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("compact-project"),
          text: "work",
        }),
        projectContext: {
          accepted: Effect.void,
          restore: Effect.sync(() => {
            restored++;
            return memory;
          }),
        },
      });
      yield* Deferred.await(completed);
      yield* Deferred.await(restoreAnswered);
      yield* Deferred.await(lateDuplicateHandled);
      assert.equal(injected, 1);
      assert.equal(restored, 1);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

const restoreFixture = (nativeThreadId: string) => {
  const compacted = (turnId: string): CodexReplay.CodexAppServerReplayEntry => ({
    type: "emit_inbound",
    label: `compacted in ${turnId}`,
    frame: {
      method: "item/completed",
      params: {
        threadId: nativeThreadId,
        turnId,
        item: { type: "contextCompaction", id: `compaction-${turnId}` },
      },
    },
  });
  const completed = (turnId: string): CodexReplay.CodexAppServerReplayEntry => ({
    type: "emit_inbound",
    label: `${turnId} done`,
    frame: {
      method: "turn/completed",
      params: {
        threadId: nativeThreadId,
        turn: makeCodexReplayTurn({ id: turnId, status: "completed" }),
      },
    },
  });
  const inject = (id: number): CodexReplay.CodexAppServerReplayEntry[] => [
    {
      type: "expect_outbound",
      label: `restore ${id}`,
      frame: {
        id,
        method: "thread/inject_items",
        params: {
          threadId: nativeThreadId,
          items: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "restored memory" }],
            },
          ],
        },
      },
    },
    { type: "emit_inbound", label: `restored ${id}`, frame: { id, result: {} } },
  ];
  const nextTurn = (prompt: string, nativeTurnId: string, id: number) =>
    codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt })
      .slice(5)
      .map((entry) => {
        const frame = "frame" in entry ? (entry.frame as Record<string, unknown>) : {};
        return { ...entry, frame: "id" in frame ? { ...frame, id } : frame };
      }) as CodexReplay.CodexAppServerReplayEntry[];
  return { compacted, completed, inject, nextTurn };
};

it.effect("Codex reads an active goal's project context when compaction ends, not its turn", () =>
  Effect.gen(function* () {
    const nativeThreadId = "goal-restore-native";
    const { compacted, completed, inject } = restoreFixture(nativeThreadId);
    const restoreAnswered = yield* Deferred.make<void>();
    let restored = 0;
    const restoredWhenCompactionHandled: Array<number> = [];
    const harness = yield* openCodex(
      makeCodexReplayTranscript({
        scenario: "goal-restore-prefetch",
        entries: [
          ...codexReplayPreamble({ nativeThreadId, nativeTurnId: "first-turn", prompt: "work" }),
          {
            type: "emit_inbound",
            label: "goal active",
            frame: {
              method: "thread/goal/updated",
              params: {
                threadId: nativeThreadId,
                goal: {
                  threadId: nativeThreadId,
                  objective: "Ship the feature",
                  status: "active",
                  tokenBudget: null,
                  tokensUsed: 0,
                  timeUsedSeconds: 0,
                  createdAt: 1782622440,
                  updatedAt: 1782622450,
                },
              },
            },
          },
          compacted("first-turn"),
          completed("first-turn"),
          ...inject(4),
        ],
      }),
      undefined,
      {
        answered: (method) =>
          method === "thread/inject_items"
            ? Deferred.succeed(restoreAnswered, undefined).pipe(Effect.asVoid)
            : Effect.void,
        handled: (method) =>
          Effect.sync(() => {
            if (method === "item/completed") restoredWhenCompactionHandled.push(restored);
          }),
      },
    );
    yield* harness.runtime.startTurn({
      ...makeCodexTestTurnInput({
        ...harness,
        now: yield* DateTime.now,
        attemptId: RunAttemptId.make("goal-restore"),
        text: "work",
      }),
      projectContext: {
        accepted: Effect.void,
        restore: Effect.sync(() => {
          restored++;
          return "restored memory";
        }),
      },
    });
    yield* Deferred.await(restoreAnswered);
    // Codex continues the goal right after turn/completed; only the injection is left then.
    assert.deepEqual(restoredWhenCompactionHandled, [1]);
    assert.equal(restored, 1);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

// Live clock: the compaction is given real time to reach thread/compact/start if it would.
it.live("Codex starts a compaction only after the previous compaction's restore is injected", () =>
  Effect.gen(function* () {
    const nativeThreadId = "compact-after-restore-native";
    const { compacted, completed, inject } = restoreFixture(nativeThreadId);
    const methods: Array<string> = [];
    const harness = yield* openCodex(
      makeCodexReplayTranscript({
        scenario: "compact-after-restore",
        entries: [
          ...codexReplayPreamble({ nativeThreadId, nativeTurnId: "first-turn", prompt: "work" }),
          compacted("first-turn"),
          completed("first-turn"),
          ...inject(4),
          {
            type: "expect_outbound",
            label: "compact",
            frame: { id: 5, method: "thread/compact/start", params: { threadId: nativeThreadId } },
          },
          { type: "emit_inbound", label: "compact", frame: { id: 5, result: {} } },
        ],
      }),
      (method) => {
        methods.push(method);
      },
    );
    const terminals = yield* Queue.unbounded<void>();
    yield* harness.runtime.events.pipe(
      Stream.runForEach((event) =>
        event.type === "turn.terminal" ? Queue.offer(terminals, undefined) : Effect.void,
      ),
      Effect.forkScoped,
    );
    const restoreCalled = yield* Deferred.make<void>();
    const releaseRestore = yield* Deferred.make<void>();
    const turn = (attempt: string, text: string) => ({
      ...makeCodexTestTurnInput({
        ...harness,
        now: DateTime.nowUnsafe(),
        attemptId: RunAttemptId.make(attempt),
        text,
      }),
      projectContext: {
        accepted: Effect.void,
        restore: Deferred.succeed(restoreCalled, undefined).pipe(
          Effect.andThen(Deferred.await(releaseRestore)),
          Effect.as("restored memory"),
        ),
      },
    });
    yield* harness.runtime.startTurn(turn("compact-after-restore-1", "work"));
    yield* Deferred.await(restoreCalled);
    yield* Queue.take(terminals);
    // A second /compact arrives while the first restore is still reading its snapshot.
    const compact = yield* harness.runtime.compactThread!(
      turn("compact-after-restore-2", "/compact"),
    ).pipe(Effect.forkScoped);
    yield* Effect.sleep("50 millis");
    assert.notInclude(methods, "thread/compact/start");
    yield* Deferred.succeed(releaseRestore, undefined);
    yield* Fiber.join(compact);
    assert.deepEqual(methods.slice(-2), ["thread/inject_items", "thread/compact/start"]);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect(
  "Codex restores a compaction before the next prompt when Stop settled its turn unconfirmed",
  () =>
    Effect.gen(function* () {
      const nativeThreadId = "stop-restore-native";
      const { compacted, inject, nextTurn } = restoreFixture(nativeThreadId);
      const methods: Array<string> = [];
      const compactionHandled = yield* Deferred.make<void>();
      const releaseRestore = yield* Deferred.make<void>();
      const harness = yield* openCodex(
        makeCodexReplayTranscript({
          scenario: "stop-restore",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId: "first-turn", prompt: "work" }),
            compacted("first-turn"),
            {
              type: "expect_outbound",
              label: "interrupt",
              frame: {
                id: 4,
                method: "turn/interrupt",
                params: { threadId: nativeThreadId, turnId: "first-turn" },
              },
            },
            // Codex accepts the interrupt but never reports turn/completed.
            { type: "emit_inbound", label: "interrupt", frame: { id: 4, result: {} } },
            ...inject(5),
            ...nextTurn("next", "next-turn", 6),
          ],
        }),
        (method) => {
          methods.push(method);
        },
        {
          handled: (method) =>
            method === "item/completed"
              ? Deferred.succeed(compactionHandled, undefined).pipe(Effect.asVoid)
              : Effect.void,
        },
      );
      const turn = (attempt: string, text: string) => ({
        ...makeCodexTestTurnInput({
          ...harness,
          now: DateTime.nowUnsafe(),
          attemptId: RunAttemptId.make(attempt),
          text,
        }),
        projectContext: {
          accepted: Effect.void,
          restore: Deferred.await(releaseRestore).pipe(Effect.as("restored memory")),
        },
      });
      yield* harness.runtime.startTurn(turn("stop-restore-1", "work"));
      yield* Deferred.await(compactionHandled);
      const providerTurnId = (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
        driver: CodexAdapterV2.CODEX_DRIVER_KIND,
        nativeTurnId: "first-turn",
      });
      const stop = yield* harness.runtime
        .interruptTurn({ providerThread: harness.providerThread, providerTurnId })
        .pipe(Effect.exit, Effect.forkScoped);
      yield* TestClock.adjust("10 seconds");
      yield* Fiber.join(stop);
      // The restore is still reading its snapshot when the next prompt arrives.
      const next = yield* harness.runtime
        .startTurn(turn("stop-restore-2", "next"))
        .pipe(Effect.forkScoped);
      yield* TestClock.adjust("1 second");
      assert.equal(methods.filter((method) => method === "turn/start").length, 1);
      yield* Deferred.succeed(releaseRestore, undefined);
      yield* Fiber.join(next);
      assert.deepEqual(methods.slice(-2), ["thread/inject_items", "turn/start"]);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

// Live clock: the compaction is cancelled while it waits for the restore.
it.live("Codex leaves no compaction run for a late native turn after Stop cancels its wait", () =>
  Effect.gen(function* () {
    const nativeThreadId = "compact-cancel-native";
    const { compacted, completed, inject } = restoreFixture(nativeThreadId);
    const releaseRestore = yield* Deferred.make<void>();
    const lateTurnHandled = yield* Deferred.make<void>();
    let turnsStarted = 0;
    const harness = yield* openCodex(
      makeCodexReplayTranscript({
        scenario: "compact-cancel",
        entries: [
          ...codexReplayPreamble({ nativeThreadId, nativeTurnId: "first-turn", prompt: "work" }),
          compacted("first-turn"),
          completed("first-turn"),
          ...inject(4),
          {
            type: "emit_inbound",
            label: "late turn",
            frame: {
              method: "turn/started",
              params: {
                threadId: nativeThreadId,
                turn: makeCodexReplayTurn({ id: "late-turn", status: "inProgress" }),
              },
            },
          },
        ],
      }),
      undefined,
      {
        handled: (method) =>
          method === "turn/started" && ++turnsStarted === 2
            ? Deferred.succeed(lateTurnHandled, undefined).pipe(Effect.asVoid)
            : Effect.void,
      },
    );
    const events: Array<unknown> = [];
    const terminals = yield* Queue.unbounded<void>();
    yield* harness.runtime.events.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => events.push(event)).pipe(
          Effect.andThen(
            event.type === "turn.terminal" ? Queue.offer(terminals, undefined) : Effect.void,
          ),
        ),
      ),
      Effect.forkScoped,
    );
    const turn = (attempt: string, text: string) => ({
      ...makeCodexTestTurnInput({
        ...harness,
        now: DateTime.nowUnsafe(),
        attemptId: RunAttemptId.make(attempt),
        text,
      }),
      projectContext: {
        accepted: Effect.void,
        restore: Deferred.await(releaseRestore).pipe(Effect.as("restored memory")),
      },
    });
    yield* harness.runtime.startTurn(turn("compact-cancel-1", "work"));
    yield* Queue.take(terminals);
    const compact = yield* harness.runtime.compactThread!(
      turn("compact-cancel-2", "/compact"),
    ).pipe(Effect.forkScoped);
    yield* Effect.sleep("50 millis");
    // Stop cancels the compaction while it waits for the restore.
    yield* Fiber.interrupt(compact);
    yield* Deferred.succeed(releaseRestore, undefined);
    yield* Deferred.await(lateTurnHandled);
    // Let the event reader catch up with what the late turn emitted.
    yield* Effect.sleep("50 millis");
    // A late turn adopted by the cancelled compaction would carry its attempt id.
    assert.notInclude(JSON.stringify(events), "compact-cancel-2");
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

// Live clock: the prompt waits for the restore while a late turn/started arrives.
it.live("Codex starts a prompt waiting for a restore once, on its own native turn, not a late one", () =>
  Effect.gen(function* () {
    const nativeThreadId = "prompt-wait-native";
    const { compacted, completed, inject, nextTurn } = restoreFixture(nativeThreadId);
    const releaseRestore = yield* Deferred.make<void>();
    const lateTurnHandled = yield* Deferred.make<void>();
    let turnsStarted = 0;
    let turnStarts = 0;
    const harness = yield* openCodex(
      makeCodexReplayTranscript({
        scenario: "prompt-wait",
        entries: [
          ...codexReplayPreamble({ nativeThreadId, nativeTurnId: "first-turn", prompt: "work" }),
          compacted("first-turn"),
          completed("first-turn"),
          // The late turn arrives while the restore waits for its injection's answer.
          inject(4)[0]!,
          {
            type: "emit_inbound",
            label: "late turn",
            frame: {
              method: "turn/started",
              params: {
                threadId: nativeThreadId,
                turn: makeCodexReplayTurn({ id: "late-turn", status: "inProgress" }),
              },
            },
          },
          inject(4)[1]!,
          ...nextTurn("next", "second-turn", 5),
        ],
      }),
      (method) => {
        if (method === "turn/start") turnStarts++;
      },
      {
        handled: (method) =>
          method === "turn/started" && ++turnsStarted === 2
            ? Deferred.succeed(lateTurnHandled, undefined).pipe(Effect.asVoid)
            : Effect.void,
      },
    );
    const events: Array<unknown> = [];
    const terminals = yield* Queue.unbounded<void>();
    yield* harness.runtime.events.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => events.push(event)).pipe(
          Effect.andThen(
            event.type === "turn.terminal" ? Queue.offer(terminals, undefined) : Effect.void,
          ),
        ),
      ),
      Effect.forkScoped,
    );
    const turn = (attempt: string, text: string) => ({
      ...makeCodexTestTurnInput({
        ...harness,
        now: DateTime.nowUnsafe(),
        attemptId: RunAttemptId.make(attempt),
        text,
      }),
      projectContext: {
        accepted: Effect.void,
        restore: Deferred.await(releaseRestore).pipe(Effect.as("restored memory")),
      },
    });
    yield* harness.runtime.startTurn(turn("prompt-wait-1", "work"));
    yield* Queue.take(terminals);
    // The restore still reads its snapshot, so the prompt waits before turn/start.
    const next = yield* harness.runtime
      .startTurn(turn("prompt-wait-2", "next"))
      .pipe(Effect.forkScoped);
    yield* Effect.sleep("50 millis");
    yield* Deferred.succeed(releaseRestore, undefined);
    yield* Deferred.await(lateTurnHandled);
    yield* Fiber.join(next);
    // Let the event reader catch up with what the turns emitted.
    yield* Effect.sleep("50 millis");
    assert.equal(turnStarts, 2);
    // A late turn adopted by the waiting prompt would carry its attempt id.
    const promptTurns = events.flatMap((event) => {
      const value = event as {
        type: string;
        providerTurn?: { runAttemptId: string; nativeTurnRef?: { nativeId: string } };
      };
      return value.type === "provider_turn.updated" &&
        value.providerTurn?.runAttemptId === "prompt-wait-2"
        ? [value.providerTurn.nativeTurnRef?.nativeId]
        : [];
    });
    assert.isAbove(promptTurns.length, 0);
    assert.deepEqual([...new Set(promptTurns)], ["second-turn"]);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

const goalActive = (nativeThreadId: string): CodexReplay.CodexAppServerReplayEntry => ({
  type: "emit_inbound",
  label: "goal active",
  frame: {
    method: "thread/goal/updated",
    params: {
      threadId: nativeThreadId,
      goal: {
        threadId: nativeThreadId,
        objective: "Ship the feature",
        status: "active",
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 1782622440,
        updatedAt: 1782622450,
      },
    },
  },
});

it.effect("Codex stops a stalled goal snapshot read when its restore times out", () =>
  Effect.gen(function* () {
    const nativeThreadId = "goal-stall-native";
    const { compacted, completed } = restoreFixture(nativeThreadId);
    const turnCompleted = yield* Deferred.make<void>();
    const readStopped = yield* Deferred.make<void>();
    const harness = yield* openCodex(
      makeCodexReplayTranscript({
        scenario: "goal-stall",
        entries: [
          ...codexReplayPreamble({ nativeThreadId, nativeTurnId: "first-turn", prompt: "work" }),
          goalActive(nativeThreadId),
          compacted("first-turn"),
          completed("first-turn"),
        ],
      }),
      undefined,
      {
        handled: (method) =>
          method === "turn/completed"
            ? Deferred.succeed(turnCompleted, undefined).pipe(Effect.asVoid)
            : Effect.void,
      },
    );
    yield* harness.runtime.startTurn({
      ...makeCodexTestTurnInput({
        ...harness,
        now: yield* DateTime.now,
        attemptId: RunAttemptId.make("goal-stall"),
        text: "work",
      }),
      projectContext: {
        accepted: Effect.void,
        restore: Effect.never.pipe(
          Effect.onInterrupt(() => Deferred.succeed(readStopped, undefined)),
        ),
      },
    });
    yield* Deferred.await(turnCompleted);
    yield* TestClock.adjust("10 seconds");
    yield* Deferred.await(readStopped);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("Codex stops a goal snapshot read when its thread is unloaded", () =>
  Effect.gen(function* () {
    const nativeThreadId = "goal-unload-native";
    const { compacted } = restoreFixture(nativeThreadId);
    const compactionHandled = yield* Deferred.make<void>();
    const readStopped = yield* Deferred.make<void>();
    const harness = yield* openCodex(
      makeCodexReplayTranscript({
        scenario: "goal-unload",
        entries: [
          ...codexReplayPreamble({ nativeThreadId, nativeTurnId: "first-turn", prompt: "work" }),
          goalActive(nativeThreadId),
          compacted("first-turn"),
          {
            type: "expect_outbound",
            label: "thread/unsubscribe",
            frame: { id: 4, method: "thread/unsubscribe", params: { threadId: nativeThreadId } },
          },
          {
            type: "emit_inbound",
            label: "thread/unsubscribe",
            frame: { id: 4, result: { status: "unsubscribed" } },
          },
        ],
      }),
      undefined,
      {
        handled: (method) =>
          method === "item/completed"
            ? Deferred.succeed(compactionHandled, undefined).pipe(Effect.asVoid)
            : Effect.void,
      },
    );
    yield* harness.runtime.startTurn({
      ...makeCodexTestTurnInput({
        ...harness,
        now: yield* DateTime.now,
        attemptId: RunAttemptId.make("goal-unload"),
        text: "work",
      }),
      projectContext: {
        accepted: Effect.void,
        restore: Effect.never.pipe(
          Effect.onInterrupt(() => Deferred.succeed(readStopped, undefined)),
        ),
      },
    });
    yield* Deferred.await(compactionHandled);
    yield* harness.runtime.unloadThread!({ providerThread: harness.providerThread });
    yield* Deferred.await(readStopped);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

// Live clock: the injection is given real time to go out if it would.
it.live("Codex stops a restore in flight when its thread is unloaded", () =>
  Effect.gen(function* () {
    const nativeThreadId = "restore-unload-native";
    const { compacted, completed } = restoreFixture(nativeThreadId);
    const turnCompleted = yield* Deferred.make<void>();
    const readStopped = yield* Deferred.make<void>();
    const releaseRead = yield* Deferred.make<void>();
    const methods: Array<string> = [];
    const harness = yield* openCodex(
      makeCodexReplayTranscript({
        scenario: "restore-unload",
        entries: [
          ...codexReplayPreamble({ nativeThreadId, nativeTurnId: "first-turn", prompt: "work" }),
          goalActive(nativeThreadId),
          compacted("first-turn"),
          completed("first-turn"),
          {
            type: "expect_outbound",
            label: "thread/unsubscribe",
            frame: { id: 4, method: "thread/unsubscribe", params: { threadId: nativeThreadId } },
          },
          {
            type: "emit_inbound",
            label: "thread/unsubscribe",
            frame: { id: 4, result: { status: "unsubscribed" } },
          },
        ],
      }),
      (method) => {
        methods.push(method);
      },
      {
        handled: (method) =>
          method === "turn/completed"
            ? Deferred.succeed(turnCompleted, undefined).pipe(Effect.asVoid)
            : Effect.void,
      },
    );
    yield* harness.runtime.startTurn({
      ...makeCodexTestTurnInput({
        ...harness,
        now: DateTime.nowUnsafe(),
        attemptId: RunAttemptId.make("restore-unload"),
        text: "work",
      }),
      projectContext: {
        accepted: Effect.void,
        restore: Deferred.await(releaseRead).pipe(
          Effect.as("restored memory"),
          Effect.onInterrupt(() => Deferred.succeed(readStopped, undefined)),
        ),
      },
    });
    // The restore now waits for the goal's advance read.
    yield* Deferred.await(turnCompleted);
    yield* harness.runtime.unloadThread!({ providerThread: harness.providerThread });
    yield* Deferred.await(readStopped).pipe(Effect.timeout("2 seconds"));
    yield* Deferred.succeed(releaseRead, undefined);
    yield* Effect.sleep("50 millis");
    assert.notInclude(methods, "thread/inject_items");
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("Codex keeps a pending restore when an already restored compaction repeats", () =>
  Effect.gen(function* () {
    const nativeThreadId = "repeat-native";
    const { compacted, completed, inject, nextTurn } = restoreFixture(nativeThreadId);
    const restoresAnswered = yield* Queue.unbounded<void>();
    const terminals = yield* Queue.unbounded<void>();
    const harness = yield* openCodex(
      makeCodexReplayTranscript({
        scenario: "repeat",
        entries: [
          ...codexReplayPreamble({ nativeThreadId, nativeTurnId: "first-turn", prompt: "work" }),
          compacted("first-turn"),
          completed("first-turn"),
          ...inject(4),
          ...nextTurn("next", "second-turn", 5),
          compacted("second-turn"),
          // The first compaction, already restored, reported again.
          compacted("first-turn"),
          completed("second-turn"),
          ...inject(6),
        ],
      }),
      undefined,
      {
        answered: (method) =>
          method === "thread/inject_items"
            ? Queue.offer(restoresAnswered, undefined).pipe(Effect.asVoid)
            : Effect.void,
      },
    );
    yield* harness.runtime.events.pipe(
      Stream.runForEach((event) =>
        event.type === "turn.terminal" ? Queue.offer(terminals, undefined) : Effect.void,
      ),
      Effect.forkScoped,
    );
    const turn = (attempt: string, text: string) => ({
      ...makeCodexTestTurnInput({
        ...harness,
        now: DateTime.nowUnsafe(),
        attemptId: RunAttemptId.make(attempt),
        text,
      }),
      projectContext: { accepted: Effect.void, restore: Effect.succeed("restored memory") },
    });
    yield* harness.runtime.startTurn(turn("repeat-1", "work"));
    yield* Queue.take(terminals);
    yield* Queue.take(restoresAnswered);
    yield* harness.runtime.startTurn(turn("repeat-2", "next"));
    // The second compaction's restore still goes out.
    yield* Queue.take(restoresAnswered);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);
