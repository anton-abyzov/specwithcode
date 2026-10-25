import {
  MessageId,
  ProjectId,
  RunId,
  ScheduledTaskId,
  ThreadId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
} from "@specweave-studio/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import * as ServiceUpdateHold from "../serviceUpdate/ServiceUpdateHold.ts";
import { awaitGateOpen, makeGatedHold } from "../serviceUpdate/UpdateInstallGate.testkit.ts";
import * as TelegramBotApi from "./TelegramBotApi.ts";
import * as TelegramChannel from "./TelegramChannel.ts";

const TOKEN = "123456789:AAEhBP0av28mEaIzFhOxPj8lVk9ExampleTok";
const PROJECT_ID = ProjectId.make("project-personal");
const COORDINATOR = ThreadId.make("thread-coordinator");

interface Sent {
  readonly chatId: number;
  readonly text: string;
}

const run = (
  input: Partial<OrchestrationV2Run> & Pick<OrchestrationV2Run, "id" | "userMessageId">,
) =>
  ({
    threadId: COORDINATOR,
    status: "completed",
    ...input,
  }) as OrchestrationV2Run;

const conversationMessage = (input: Partial<OrchestrationV2ConversationMessage>) =>
  input as OrchestrationV2ConversationMessage;

/** Fakes for Telegram, the secret store, the project row and the coordinator thread. */
const makeHarness = Effect.gen(function* () {
  const updates = yield* Queue.unbounded<ReadonlyArray<TelegramBotApi.TelegramUpdate>>();
  const sent = yield* Queue.unbounded<Sent>();
  const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
  const dispatched: Array<{
    readonly text: string;
    readonly mode: string;
    readonly commandId: string;
  }> = [];
  const secrets = new Map<string, Uint8Array>();
  const messages: Array<OrchestrationV2ConversationMessage> = [];
  const polls = { count: 0 };

  const layer = TelegramChannel.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(TelegramBotApi.TelegramBotApi)(
          TelegramBotApi.TelegramBotApi.of({
            getMe: () =>
              Effect.succeed({ id: 99, username: "studio_test_bot", first_name: "Studio" }),
            getUpdates: () =>
              Effect.sync(() => void (polls.count += 1)).pipe(Effect.andThen(Queue.take(updates))),
            sendMessage: ({ chatId, text }) =>
              Queue.offer(sent, { chatId, text }).pipe(Effect.asVoid),
            sendTyping: () => Effect.void,
          }),
        ),
        Layer.succeed(ServerSecretStore.ServerSecretStore)(
          ServerSecretStore.ServerSecretStore.of({
            get: (name) => Effect.succeed(Option.fromNullishOr(secrets.get(name))),
            set: (name, value) => Effect.sync(() => void secrets.set(name, value)),
            create: (name, value) => Effect.sync(() => void secrets.set(name, value)),
            getOrCreateRandom: () => Effect.die("unused"),
            remove: (name) => Effect.sync(() => void secrets.delete(name)),
          }),
        ),
        Layer.succeed(ProjectStore.ProjectStoreV2)({
          get: (projectId: ProjectId) =>
            Effect.succeed(
              projectId === PROJECT_ID
                ? Option.some({
                    projectId: PROJECT_ID,
                    title: "Errands",
                    deletedAt: null,
                    workspaceSettings: { coordinatorThreadId: COORDINATOR, paused: false },
                  })
                : Option.none(),
            ),
        } as unknown as ProjectStore.ProjectStoreV2["Service"]),
        Layer.succeed(ThreadManagementService)({
          sendToThread: (input: { text: string; mode: string; commandId: string }) =>
            Effect.sync(() => {
              dispatched.push({ text: input.text, mode: input.mode, commandId: input.commandId });
              return { delivery: "started" };
            }),
          getProjectThreadRecords: (
            _key: unknown,
            _fields: unknown,
            filter: { messageIds?: ReadonlyArray<string>; messageRunIds?: ReadonlyArray<string> },
          ) =>
            Effect.succeed({
              messages: messages.filter(
                (message) =>
                  (filter.messageIds === undefined || filter.messageIds.includes(message.id)) &&
                  (filter.messageRunIds === undefined ||
                    (message.runId !== null && filter.messageRunIds.includes(message.runId))),
              ),
            }),
          getThreadShell: (threadId: ThreadId) =>
            Effect.succeed({ id: threadId, projectId: PROJECT_ID, title: "Book flights" }),
          streamDomainEvents: Stream.fromQueue(events),
        } as unknown as ThreadManagementService["Service"]),
        Layer.succeed(Crypto.Crypto)({
          randomBytes: (size: number) => Effect.succeed(new Uint8Array(size).fill(3)),
        } as never),
      ),
    ),
  );
  return { layer, updates, sent, events, dispatched, secrets, messages, polls };
});

const update = (updateId: number, text: string, chatId = 42) => ({
  update_id: updateId,
  message: {
    message_id: updateId,
    chat: { id: chatId, type: "private", first_name: "Anton" },
    text,
  },
});

it.effect("pairs the chat that sends the code, then forwards and answers", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Effect.gen(function* () {
      const channel = yield* TelegramChannel.TelegramChannel;
      const configured = yield* channel.configure({
        botToken: TOKEN,
        projectId: PROJECT_ID,
        enabled: true,
      });
      assert.strictEqual(configured.configured, true);
      assert.strictEqual(configured.botUsername, "studio_test_bot");
      assert.strictEqual(configured.paired, false);
      const code = configured.pairingCode;
      assert.isNotNull(code);
      assert.isFalse(
        new TextDecoder().decode(harness.secrets.get("telegram-channel-state")).includes(TOKEN),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* channel.start();

          // A stranger before pairing only gets the hint.
          yield* Queue.offer(harness.updates, [update(1, "hello", 7)]);
          assert.include((yield* Queue.take(harness.sent)).text, "not paired");

          yield* Queue.offer(harness.updates, [update(2, `/start ${code}`)]);
          const pairedReply = yield* Queue.take(harness.sent);
          assert.strictEqual(pairedReply.chatId, 42);
          assert.include(pairedReply.text, "Errands");
          const status = yield* channel.status;
          assert.strictEqual(status.paired, true);
          assert.isNull(status.pairingCode);

          // After pairing a stranger is ignored and the owner's text reaches the coordinator.
          yield* Queue.offer(harness.updates, [update(3, "hi", 7), update(4, "plan my week")]);
          yield* Queue.offer(harness.updates, [update(5, "/help")]);
          assert.include((yield* Queue.take(harness.sent)).text, "/status");
          assert.deepStrictEqual(harness.dispatched, [
            { text: "plan my week", mode: "queue", commandId: "telegram:99:4" },
          ]);

          // The coordinator's answer to that message goes back; a desk-started run does not.
          harness.messages.push(
            conversationMessage({
              id: MessageId.make("telegram-message:99:4"),
              runId: RunId.make("run-phone"),
              role: "user",
              createdBy: "user",
              creationSource: "server",
            }),
            conversationMessage({
              id: MessageId.make("answer-phone"),
              runId: RunId.make("run-phone"),
              role: "assistant",
              text: "Here is your week.",
            }),
            conversationMessage({
              id: MessageId.make("desk"),
              runId: RunId.make("run-desk"),
              role: "user",
              createdBy: "user",
              creationSource: "web",
            }),
            conversationMessage({
              id: MessageId.make("answer-desk"),
              runId: RunId.make("run-desk"),
              role: "assistant",
              text: "Desk answer",
            }),
          );
          const runEvent = (payload: OrchestrationV2Run) =>
            ({ type: "run.updated", threadId: COORDINATOR, payload }) as OrchestrationV2DomainEvent;
          yield* Queue.offer(
            harness.events,
            runEvent(run({ id: RunId.make("run-desk"), userMessageId: MessageId.make("desk") })),
          );
          yield* Queue.offer(
            harness.events,
            runEvent(
              run({
                id: RunId.make("run-phone"),
                userMessageId: MessageId.make("telegram-message:99:4"),
              }),
            ),
          );
          // The same run finishing twice is announced once.
          yield* Queue.offer(
            harness.events,
            runEvent(
              run({
                id: RunId.make("run-phone"),
                userMessageId: MessageId.make("telegram-message:99:4"),
              }),
            ),
          );
          yield* Queue.offer(harness.events, {
            type: "runtime-request.updated",
            threadId: ThreadId.make("thread-worker"),
            payload: { id: "request-1", status: "pending" },
          } as unknown as OrchestrationV2DomainEvent);
          assert.strictEqual((yield* Queue.take(harness.sent)).text, "Here is your week.");
          assert.include((yield* Queue.take(harness.sent)).text, "“Book flights” in Errands");
          assert.strictEqual(yield* Queue.size(harness.sent), 0);

          // A routine's run in its own thread goes back, headed by the thread's
          // title, even when the routine was made at a desk; a worker's run does not.
          const ROUTINE_THREAD = ThreadId.make("thread-routine");
          harness.messages.push(
            conversationMessage({
              id: MessageId.make("routine-fire"),
              runId: RunId.make("run-routine"),
              role: "user",
              createdBy: "user",
              creationSource: "web",
              scheduledTaskId: ScheduledTaskId.make("task-seo"),
            }),
            conversationMessage({
              id: MessageId.make("answer-routine"),
              runId: RunId.make("run-routine"),
              role: "assistant",
              text: "Search traffic is steady.",
            }),
            conversationMessage({
              id: MessageId.make("worker-ask"),
              runId: RunId.make("run-worker"),
              role: "user",
              createdBy: "agent",
              creationSource: "mcp",
            }),
            conversationMessage({
              id: MessageId.make("answer-worker"),
              runId: RunId.make("run-worker"),
              role: "assistant",
              text: "Worker detail",
            }),
          );
          const threadRunEvent = (payload: OrchestrationV2Run) =>
            ({
              type: "run.updated",
              threadId: payload.threadId,
              payload,
            }) as OrchestrationV2DomainEvent;
          yield* Queue.offer(
            harness.events,
            threadRunEvent(
              run({
                id: RunId.make("run-worker"),
                threadId: ROUTINE_THREAD,
                userMessageId: MessageId.make("worker-ask"),
              }),
            ),
          );
          yield* Queue.offer(
            harness.events,
            threadRunEvent(
              run({
                id: RunId.make("run-routine"),
                threadId: ROUTINE_THREAD,
                userMessageId: MessageId.make("routine-fire"),
              }),
            ),
          );
          assert.strictEqual(
            (yield* Queue.take(harness.sent)).text,
            "“Book flights”\n\nSearch traffic is steady.",
          );
          assert.strictEqual(yield* Queue.size(harness.sent), 0);

          const unpaired = yield* channel.unpair;
          assert.strictEqual(unpaired.paired, false);
          assert.isNotNull(unpaired.pairingCode);
        }),
      );

      const removed = yield* channel.remove;
      assert.strictEqual(removed.configured, false);
      assert.strictEqual(harness.secrets.size, 0);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("does not ask Telegram for messages until an update install's gate is cleared", () =>
  Effect.gen(function* () {
    const gated = yield* makeGatedHold();
    const harness = yield* makeHarness;
    yield* Effect.gen(function* () {
      const channel = yield* TelegramChannel.TelegramChannel;
      yield* channel.configure({ botToken: TOKEN, projectId: PROJECT_ID, enabled: true });
      yield* channel.start();
      const settle = TestClock.withLive(Effect.sleep(Duration.millis(20)));
      yield* settle;
      yield* TestClock.adjust("20 seconds");
      yield* settle;
      assert.strictEqual(harness.polls.count, 0);

      yield* gated.clear;
      assert.isTrue(yield* awaitGateOpen(gated.hold));
      yield* TestClock.adjust("5 seconds");
      yield* settle;
      assert.isAtLeast(harness.polls.count, 1);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        harness.layer.pipe(
          Layer.provide(Layer.succeed(ServiceUpdateHold.ServiceUpdateHold, gated.hold)),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
