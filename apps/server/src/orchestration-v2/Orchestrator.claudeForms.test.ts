import { fixtureProjectDatabase } from "../project/ProjectWorkspace.testkit.ts";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Command,
  type OrchestrationV2McpElicitation,
} from "@specweave-studio/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import {
  FORM_AGENT_REFUSAL,
  FORM_ALREADY_ANSWERED,
  FORM_NEEDS_CARD,
  REDACTED_FORM_ANSWER,
  takeClaudeFormAnswers,
} from "./ClaudeFormResponses.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

// The rules for answering an MCP server's form in a Claude thread (1481), at
// the one place every answer passes: runtime-request.respond.
const instanceId = ProviderInstanceId.make("codex");
const projectId = ProjectId.make("project:claude-forms");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for form answers"),
} as ProviderAdapterV2Shape;
const layerDatabase = fixtureProjectDatabase([projectId]);
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "claude-forms" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const confirmForm: OrchestrationV2McpElicitation = {
  serverName: "github",
  mode: "form",
  message: "Delete octo/repo? This cannot be undone.",
  requestedSchema: {
    type: "object",
    properties: { confirm: { type: "string", title: "Type octo/repo to confirm" } },
    required: ["confirm"],
  },
};

/** A pending mcp-elicitation card on a live session, with or without a Claude form. */
const card = (name: string, elicitation: OrchestrationV2McpElicitation | undefined) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make(`thread:${name}`);
    const requestId = RuntimeRequestId.make(`request:${name}`);
    const nodeId = NodeId.make(`node:${name}`);
    const sessionId = ProviderSessionId.make(`session:${name}`);
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
      id: EventId.make(`attach:${name}`),
      type: "provider-session.attached",
      threadId,
      occurredAt: now,
      payload: {
        id: sessionId,
        driver: adapter.driver,
        providerInstanceId: instanceId,
        status: "ready",
        cwd: "/repo",
        model: "gpt-5.1-codex",
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      },
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
        kind: "mcp-elicitation",
        status: "pending",
        responseCapability: { type: "live", providerSessionId: sessionId },
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
        kind: "approval_request",
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
        type: "approval_request",
        requestId,
        requestKind: "mcp-elicitation",
        appName: "github",
        options: [
          { decision: "decline", label: "Decline" },
          { decision: "cancel", label: "Cancel" },
          ...(elicitation === undefined ? [{ decision: "accept" as const, label: "Approve" }] : []),
        ],
        ...(elicitation === undefined ? {} : { elicitation }),
      },
    });
    const respond = (
      tag: string,
      fields: Omit<
        Extract<OrchestrationV2Command, { type: "runtime-request.respond" }>,
        "type" | "commandId" | "threadId" | "requestId"
      >,
    ) =>
      orchestrator.dispatch({
        type: "runtime-request.respond",
        commandId: CommandId.make(`respond:${name}:${tag}`),
        threadId,
        requestId,
        ...fields,
      });
    const status = projections.getRuntimeRequest(threadId, requestId);
    return { respond, status, requestId };
  });

/** "succeeded", or the reason the dispatch was refused. */
const refusal = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.exit(effect).pipe(
    Effect.map((exit) => {
      if (Exit.isSuccess(exit)) return "succeeded";
      const error = Cause.squash(exit.cause) as { readonly cause?: unknown };
      return typeof error?.cause === "string" ? error.cause : String(error);
    }),
  );

it.effect("refuses an agent's answer and an accept without the card's answers", () =>
  Effect.gen(function* () {
    const { respond, status } = yield* card("refusals", confirmForm);
    assert.include(
      yield* refusal(
        respond("agent", {
          decision: "accept",
          answers: { confirm: "octo/repo" },
          answeredByThreadId: ThreadId.make("thread:some-agent"),
        }),
      ),
      FORM_AGENT_REFUSAL,
    );
    // What Full access and any automatic responder send.
    assert.include(yield* refusal(respond("auto", { decision: "accept" })), FORM_NEEDS_CARD);
    assert.equal((yield* status)?.status, "pending");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("checks the answers against the form and keeps the card open when they don't fit", () =>
  Effect.gen(function* () {
    const { respond, status } = yield* card("invalid", confirmForm);
    assert.include(
      yield* refusal(respond("empty", { decision: "accept", answers: {} })),
      "Type octo/repo to confirm: Required.",
    );
    assert.equal((yield* status)?.status, "pending");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("records only which fields were answered and hands the answers to the adapter", () =>
  Effect.gen(function* () {
    const { respond, status, requestId } = yield* card("accepted", confirmForm);
    yield* respond("person", {
      decision: "accept",
      answers: { confirm: "octo/repo", stray: "dropped" },
    });
    const resolved = yield* status;
    assert.equal(resolved?.status, "resolved");
    assert.deepEqual(resolved?.answers, { confirm: REDACTED_FORM_ANSWER });
    assert.deepEqual(takeClaudeFormAnswers(requestId), { confirm: "octo/repo" });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("takes one answer when two machines answer the same card at once", () =>
  Effect.gen(function* () {
    const { respond, status } = yield* card("twice", confirmForm);
    const outcomes = yield* Effect.all(
      [
        refusal(respond("machine-a", { decision: "accept", answers: { confirm: "octo/repo" } })),
        refusal(respond("machine-b", { decision: "decline" })),
      ],
      { concurrency: "unbounded" },
    );
    assert.equal(outcomes.filter((outcome) => outcome === "succeeded").length, 1);
    assert.include(
      outcomes.find((outcome) => outcome !== "succeeded"),
      FORM_ALREADY_ANSWERED,
    );
    assert.equal((yield* status)?.status, "resolved");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("leaves a Codex elicitation without a form as it was", () =>
  Effect.gen(function* () {
    const { respond, status } = yield* card("codex", undefined);
    yield* respond("full-access", { decision: "accept" });
    assert.equal((yield* status)?.status, "resolved");
  }).pipe(Effect.provide(layerTest)),
);
