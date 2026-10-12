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
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
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
      let restored = 0;
      let injected = 0;
      let memory = "old";
      const harness = yield* openCodex(
        makeCodexReplayTranscript({
          scenario: "project-compaction",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "work" }),
            compacted,
            compacted,
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
            compacted,
            {
              type: "emit_inbound",
              label: "done",
              frame: {
                method: "turn/completed",
                params: {
                  threadId: nativeThreadId,
                  turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
                },
              },
            },
          ],
        }),
        (method) => {
          if (method === "turn/start") memory = "fresh project memory";
          if (method === "thread/inject_items") injected++;
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
      assert.equal(injected, 1);
      assert.equal(restored, 1);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);
