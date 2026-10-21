import { fixtureProjectDatabase } from "../project/ProjectWorkspace.testkit.ts";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type UserInputAttachments,
  type UserInputQuestion,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const projectId = ProjectId.make("project:question-answers");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for question answers"),
} as ProviderAdapterV2Shape;
const layerDatabase = fixtureProjectDatabase([projectId]);
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "question-answers" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const screenshot: UserInputAttachments[string][number] = {
  type: "image",
  id: "thread-1-00000000-0000-4000-8000-0000000000aa",
  name: "screenshot.png",
  mimeType: "image/png",
  sizeBytes: 70,
};
// What ThreadMessageIntake appends for provider answer protocols.
const pathLine = `Attached image "screenshot.png": "/attachments/${screenshot.id}.png"`;

/** An ask_user card: a pending message-mode request with its question item. */
const askUser = (name: string, questions: ReadonlyArray<UserInputQuestion>) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make(`thread:${name}`);
    const requestId = RuntimeRequestId.make(`ask-user:${name}`);
    const nodeId = NodeId.make(`node:${name}`);
    const now = yield* DateTime.now;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${name}`),
      threadId,
      projectId,
      title: name,
      modelSelection: { instanceId, model: "gpt-5.1-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* projections.apply({
      id: EventId.make(`request:${name}`),
      type: "runtime-request.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: requestId,
        nodeId,
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input",
        status: "pending",
        responseCapability: { type: "message" },
        createdAt: now,
        resolvedAt: null,
      },
    });
    yield* projections.apply({
      id: EventId.make(`node:${name}`),
      type: "node.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: nodeId,
        threadId,
        runId: null,
        parentNodeId: null,
        rootNodeId: nodeId,
        kind: "user_input_request",
        status: "waiting",
        countsForRun: false,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: requestId,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: null,
      },
    });
    yield* projections.apply({
      id: EventId.make(`item:${name}`),
      type: "turn-item.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: TurnItemId.make(`item:${name}`),
        threadId,
        runId: null,
        nodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "waiting",
        title: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "user_input_request",
        requestId,
        responseMode: "message",
        questions,
      },
    });
    return { orchestrator, projections, threadId, requestId };
  });

const layoutQuestion: UserInputQuestion = {
  id: "q1",
  header: "Layout",
  question: "Which header layout?",
  options: [
    { label: "Compact", description: "One row" },
    { label: "Tall", description: "Two rows" },
  ],
  allowCustomAnswer: true,
};

it.effect("a reply in chat reaches the agent with its images and stays a plain message", () =>
  Effect.gen(function* () {
    const { orchestrator, projections, threadId, requestId } = yield* askUser("chat-reply", [
      layoutQuestion,
    ]);
    yield* orchestrator.dispatch({
      type: "runtime-request.respond",
      commandId: CommandId.make("respond:chat-reply"),
      threadId,
      requestId,
      answers: { q1: `Use this layout\n\n${pathLine}` },
      attachmentsByQuestionId: { q1: [screenshot] },
      answeredInChat: true,
    });
    const projection = yield* projections.getThreadProjection(threadId);
    const reply = projection.messages.find(
      (message) => message.id === MessageId.make(`async-answer:${requestId}`),
    );
    assert.ok(reply);
    assert.equal(reply.text, "Use this layout");
    assert.deepEqual(
      reply.attachments?.map((attachment) => attachment.id),
      [screenshot.id],
    );
    const card = projection.turnItems.find(
      (item) => item.type === "user_input_request" && item.requestId === requestId,
    );
    assert.ok(card?.type === "user_input_request");
    assert.equal(card.questionAnswer?.answeredInChat, true);
    // The card lists the file; its server path stays out of the shown answer.
    assert.deepEqual(card.questionAnswer?.answers, { q1: "Use this layout" });
    assert.equal((yield* projections.getRuntimeRequest(threadId, requestId))?.status, "resolved");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("an image-only reply and a picked option keep each question's context", () =>
  Effect.gen(function* () {
    const { orchestrator, projections, threadId, requestId } = yield* askUser("two-questions", [
      layoutQuestion,
      {
        id: "q2",
        header: "Pages",
        question: "Which pages change?",
        options: [
          { label: "Settings", description: "Settings" },
          { label: "Profile", description: "Profile" },
        ],
        multiSelect: true,
      },
    ]);
    yield* orchestrator.dispatch({
      type: "runtime-request.respond",
      commandId: CommandId.make("respond:two-questions"),
      threadId,
      requestId,
      answers: { q1: pathLine, q2: ["Settings", "Profile"] },
      attachmentsByQuestionId: { q1: [screenshot] },
    });
    const reply = (yield* projections.getThreadProjection(threadId)).messages.find(
      (message) => message.id === MessageId.make(`async-answer:${requestId}`),
    );
    assert.ok(reply);
    assert.equal(reply.text, "Which header layout?\n\nWhich pages change?\nSettings, Profile");
    assert.deepEqual(
      reply.attachments?.map((attachment) => attachment.id),
      [screenshot.id],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a resent answer is delivered once", () =>
  Effect.gen(function* () {
    const { orchestrator, projections, threadId, requestId } = yield* askUser("resend", [
      layoutQuestion,
    ]);
    const respond = {
      type: "runtime-request.respond" as const,
      commandId: CommandId.make("respond:resend"),
      threadId,
      requestId,
      answers: { q1: `Use this layout\n\n${pathLine}` },
      attachmentsByQuestionId: { q1: [screenshot] },
      answeredInChat: true,
    };
    yield* orchestrator.dispatch(respond);
    // A reload or restart replays the same command; the receipt answers it.
    yield* orchestrator.dispatch(respond);
    // A second send for an answered card must not post another reply.
    yield* orchestrator
      .dispatch({ ...respond, commandId: CommandId.make("respond:resend-again") })
      .pipe(Effect.ignore);
    const replies = (yield* projections.getThreadProjection(threadId)).messages.filter(
      (message) => message.id === MessageId.make(`async-answer:${requestId}`),
    );
    assert.equal(replies.length, 1);
    assert.equal(replies[0]?.text, "Use this layout");
  }).pipe(Effect.provide(layerTest)),
);
