import { fixtureProjectDatabase } from "../project/ProjectWorkspace.testkit.ts";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MCP_ELICITATION_URL_DONE_ANSWER,
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
import * as SqlClient from "effect/sql/SqlClient";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import {
  beginClosingClaudeForm,
  claudeFormCommitOutcome,
  FORM_AGENT_REFUSAL,
  FORM_ALREADY_ANSWERED,
  FORM_CLOSED,
  FORM_NEEDS_CARD,
  FORM_OPENING,
  forgetUncommittedFormAnswer,
  handOffClaudeFormAnswers,
  isClaudeFormAnswered,
  LINK_AGENT_REFUSAL,
  LINK_ALREADY_ANSWERED,
  LINK_CLOSED,
  LINK_NEEDS_CARD,
  settleFormAnswerDispatch,
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
const card = (
  name: string,
  elicitation: OrchestrationV2McpElicitation | undefined,
  options: { readonly withItem?: boolean } = {},
) =>
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
        // The ref the Claude adapter gives a form's request.
        nativeRequestRef:
          elicitation === undefined
            ? null
            : {
                driver: ProviderDriverKind.make("claudeAgent"),
                nativeId: `mcp-elicitation:github:${name}`,
                strength: "strong",
              },
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
    if (options.withItem !== false)
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
            ...(elicitation === undefined
              ? [{ decision: "accept" as const, label: "Approve" }]
              : []),
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
    // The adapter can tell the answer is recorded, not still committing (1493).
    assert.equal(claudeFormCommitOutcome(requestId), "committed");
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

const signInLink: OrchestrationV2McpElicitation = {
  serverName: "github",
  mode: "url",
  message: "Sign in to GitHub to continue.",
  url: "https://github.com/login/device?code=ABCD",
};

it.effect("takes only the person's I'm done on a link card (1498)", () =>
  Effect.gen(function* () {
    const { respond, status } = yield* card("link-refusals", signInLink);
    assert.include(
      yield* refusal(
        respond("agent", {
          decision: "accept",
          answers: { ...MCP_ELICITATION_URL_DONE_ANSWER },
          answeredByThreadId: ThreadId.make("thread:some-agent"),
        }),
      ),
      LINK_AGENT_REFUSAL,
    );
    assert.include(
      yield* refusal(
        respond("agent-decline", {
          decision: "decline",
          answeredByThreadId: ThreadId.make("thread:some-agent"),
        }),
      ),
      LINK_AGENT_REFUSAL,
    );
    // What Full access and any automatic responder send.
    assert.include(yield* refusal(respond("auto", { decision: "accept" })), LINK_NEEDS_CARD);
    assert.include(
      yield* refusal(
        respond("extra", {
          decision: "accept",
          answers: { ...MCP_ELICITATION_URL_DONE_ANSWER, url: "https://evil.example" },
        }),
      ),
      LINK_NEEDS_CARD,
    );
    assert.include(
      yield* refusal(respond("wrong", { decision: "accept", answers: { linkDone: "yes" } })),
      LINK_NEEDS_CARD,
    );
    // Only a plain accept: "always" means nothing for a link, and no decision
    // would record an answer while the server got a cancel (1498 review).
    for (const [tag, decision] of [
      ["always", "acceptAlways"],
      ["session", "acceptForSession"],
      ["none", undefined],
    ] as const)
      assert.include(
        yield* refusal(
          respond(tag, {
            ...(decision === undefined ? {} : { decision }),
            answers: { ...MCP_ELICITATION_URL_DONE_ANSWER },
          }),
        ),
        LINK_NEEDS_CARD,
      );
    assert.equal((yield* status)?.status, "pending");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("records a link card's I'm done with no answers and refuses a second press", () =>
  Effect.gen(function* () {
    const { respond, status, requestId } = yield* card("link-done", signInLink);
    yield* respond("person", {
      decision: "accept",
      answers: { ...MCP_ELICITATION_URL_DONE_ANSWER },
    });
    const resolved = yield* status;
    assert.equal(resolved?.status, "resolved");
    assert.equal(resolved?.decision, "accept");
    assert.isUndefined(resolved?.answers);
    // Nothing is handed on: the server gets a bare accept.
    assert.isUndefined(takeClaudeFormAnswers(requestId));
    assert.equal(claudeFormCommitOutcome(requestId), "committed");
    assert.include(
      yield* refusal(respond("again", { decision: "decline" })),
      LINK_ALREADY_ANSWERED,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("lets the person decline or cancel a link card, and refuses one closing", () =>
  Effect.gen(function* () {
    const declined = yield* card("link-decline", signInLink);
    yield* declined.respond("person", { decision: "decline" });
    assert.equal((yield* declined.status)?.status, "resolved");
    const cancelled = yield* card("link-cancel", signInLink);
    yield* cancelled.respond("person", { decision: "cancel" });
    assert.equal((yield* cancelled.status)?.status, "resolved");
    // Stop or the SDK's abort is closing the card: a late press is refused.
    const closing = yield* card("link-closing", signInLink);
    assert.isTrue(beginClosingClaudeForm(closing.requestId));
    assert.include(
      yield* refusal(
        closing.respond("late", {
          decision: "accept",
          answers: { ...MCP_ELICITATION_URL_DONE_ANSWER },
        }),
      ),
      LINK_CLOSED,
    );
    assert.equal((yield* closing.status)?.status, "pending");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("leaves a Codex elicitation without a form as it was", () =>
  Effect.gen(function* () {
    const { respond, status } = yield* card("codex", undefined);
    yield* respond("full-access", { decision: "accept" });
    assert.equal((yield* status)?.status, "resolved");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("treats a Claude form's request as a form before its card lands", () =>
  Effect.gen(function* () {
    const { respond, status } = yield* card("before-item", confirmForm, { withItem: false });
    // The adapter records the request a moment before the card's item.
    assert.include(
      yield* refusal(
        respond("early-accept", { decision: "accept", answers: { confirm: "octo/repo" } }),
      ),
      FORM_OPENING,
    );
    assert.include(
      yield* refusal(
        respond("early-agent", {
          decision: "accept",
          answers: { confirm: "octo/repo" },
          answeredByThreadId: ThreadId.make("thread:some-agent"),
        }),
      ),
      FORM_OPENING,
    );
    assert.equal((yield* status)?.status, "pending");
    // Decline still closes it, and nothing the person typed is kept.
    yield* respond("early-decline", { decision: "decline", answers: { confirm: "secret" } });
    const closed = yield* status;
    assert.equal(closed?.status, "resolved");
    assert.isUndefined(closed?.answers);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("queues the answer's delivery with only the redacted summary (1493)", () =>
  Effect.gen(function* () {
    const { respond } = yield* card("effect-redacted", confirmForm);
    yield* respond("person", { decision: "accept", answers: { confirm: "octo/repo" } });
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly payload_json: string }>`
      SELECT payload_json FROM orchestration_v2_effect_outbox
      WHERE command_id = 'respond:effect-redacted:person'`;
    assert.equal(rows.length, 1);
    const payload = JSON.parse(rows[0]!.payload_json) as {
      readonly answers?: unknown;
      readonly request?: { readonly answers?: unknown };
    };
    assert.deepEqual(payload.request?.answers ?? payload.answers, {
      confirm: REDACTED_FORM_ANSWER,
    });
    assert.notInclude(rows[0]!.payload_json, "octo/repo");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("refuses an answer once the adapter began closing the card (1493)", () =>
  Effect.gen(function* () {
    const { respond, status, requestId } = yield* card("closing", confirmForm);
    // Stop or the timer fired; the cancelled card has not landed yet.
    assert.isTrue(beginClosingClaudeForm(requestId));
    assert.include(
      yield* refusal(respond("late", { decision: "accept", answers: { confirm: "octo/repo" } })),
      FORM_CLOSED,
    );
    assert.equal((yield* status)?.status, "pending");
    assert.isFalse(isClaudeFormAnswered(requestId));
    assert.isUndefined(takeClaudeFormAnswers(requestId));
  }).pipe(Effect.provide(layerTest)),
);

it("lets exactly one of the hand-off and the close win (1493)", () => {
  const first = RuntimeRequestId.make("request:race-answer-first");
  assert.isTrue(handOffClaudeFormAnswers(first, { handOff: { confirm: "x" } }));
  assert.isFalse(beginClosingClaudeForm(first));
  const second = RuntimeRequestId.make("request:race-close-first");
  assert.isTrue(beginClosingClaudeForm(second));
  assert.isFalse(handOffClaudeFormAnswers(second, { handOff: { confirm: "x" } }));
  assert.isFalse(isClaudeFormAnswered(second));
  assert.isUndefined(takeClaudeFormAnswers(second));
});

it.effect("settles a hand-off however its dispatch ends (1493)", () =>
  Effect.gen(function* () {
    const respond = (requestId: RuntimeRequestId, commandId: string) => ({
      type: "runtime-request.respond",
      commandId,
      requestId,
    });
    const failed = RuntimeRequestId.make("request:dispatch-failed");
    handOffClaudeFormAnswers(failed, { handOff: { confirm: "x" } }, "command:a");
    assert.equal(claudeFormCommitOutcome(failed), "pending");
    // Another dispatch's exit never touches this hand-off.
    yield* settleFormAnswerDispatch(respond(failed, "command:other"), false);
    assert.equal(claudeFormCommitOutcome(failed), "pending");
    // Its own unsuccessful exit does, planning and interruption included.
    yield* settleFormAnswerDispatch(respond(failed, "command:a"), false);
    assert.equal(claudeFormCommitOutcome(failed), "failed");
    assert.isUndefined(takeClaudeFormAnswers(failed));
    const succeeded = RuntimeRequestId.make("request:dispatch-succeeded");
    handOffClaudeFormAnswers(succeeded, { handOff: { confirm: "x" } }, "command:b");
    yield* settleFormAnswerDispatch(respond(succeeded, "command:b"), true);
    assert.equal(claudeFormCommitOutcome(succeeded), "committed");
  }),
);

it.effect("keeps the first answer's hand-off when a later answer is refused (1493)", () =>
  Effect.gen(function* () {
    const { respond, status, requestId } = yield* card("second-refused", confirmForm);
    // The effect worker is off, so the first answer is still on its way.
    yield* respond("person", { decision: "accept", answers: { confirm: "octo/repo" } });
    assert.include(
      yield* refusal(respond("again", { decision: "accept", answers: { confirm: "other" } })),
      FORM_ALREADY_ANSWERED,
    );
    assert.include(
      yield* refusal(respond("decline", { decision: "decline" })),
      FORM_ALREADY_ANSWERED,
    );
    assert.equal((yield* status)?.status, "resolved");
    assert.equal(claudeFormCommitOutcome(requestId), "committed");
    assert.isFalse(beginClosingClaudeForm(requestId));
    assert.deepEqual(takeClaudeFormAnswers(requestId), { confirm: "octo/repo" });
  }).pipe(Effect.provide(layerTest)),
);

it("forgets an answer whose commit failed, so the card can close (1493)", () => {
  const requestId = RuntimeRequestId.make("request:commit-failed");
  handOffClaudeFormAnswers(requestId, { handOff: { confirm: "x" } });
  // Only a respond command's own request is touched.
  forgetUncommittedFormAnswer({ type: "thread.stop" });
  assert.isTrue(isClaudeFormAnswered(requestId));
  forgetUncommittedFormAnswer({ type: "runtime-request.respond", requestId });
  assert.isFalse(isClaudeFormAnswered(requestId));
  assert.isUndefined(takeClaudeFormAnswers(requestId));
  assert.isTrue(beginClosingClaudeForm(requestId));
});
