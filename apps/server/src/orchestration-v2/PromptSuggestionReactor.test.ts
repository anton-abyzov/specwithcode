import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import type {
  OrchestrationV2AppThread,
  OrchestrationV2ConversationMessage,
  OrchestrationV2DomainEvent,
  OrchestrationV2Run,
} from "@specweave-studio/contracts";
import { MessageId, RunId, ThreadId } from "@specweave-studio/contracts";

import {
  completedRunCandidate,
  promptSuggestionTranscript,
  runNeedsGeneratedSuggestion,
  runStartedByPerson,
  threadTakesPromptSuggestions,
} from "./PromptSuggestionReactor.ts";

const threadId = ThreadId.make("thread:suggest");
const runId = RunId.make("run:suggest");
const userMessageId = MessageId.make("message:user");
const run = (overrides: Partial<OrchestrationV2Run> = {}) =>
  ({
    id: runId,
    threadId,
    ordinal: 1,
    status: "completed",
    userMessageId,
    ...overrides,
  }) as unknown as OrchestrationV2Run;
const updated = (payload: OrchestrationV2Run) =>
  ({ type: "run.updated", threadId, payload }) as unknown as OrchestrationV2DomainEvent;
const message = (overrides: Partial<OrchestrationV2ConversationMessage>) =>
  ({
    id: MessageId.make("message:reply"),
    runId,
    role: "assistant",
    text: "",
    streaming: false,
    ...overrides,
  }) as unknown as OrchestrationV2ConversationMessage;

describe("suggested prompt reactor", () => {
  it("takes completed runs the person started", () => {
    expect(completedRunCandidate(updated(run()))?.run.id).toBe(runId);
    expect(completedRunCandidate(updated(run({ status: "running" })))).toBeNull();
    expect(completedRunCandidate(updated(run({ status: "failed" })))).toBeNull();
  });
  it("skips wakes, restart continuations, delegated results and runs that have one", () => {
    const now = DateTime.makeUnsafe(0) as never;
    for (const overrides of [
      { workStartedAt: now },
      { restartContinuationOfRunId: RunId.make("run:before") },
      { delegatedCompletion: {} as never },
      { promptSuggestion: { text: "go on", source: "provider" as const } },
    ])
      expect(completedRunCandidate(updated(run(overrides)))).toBeNull();
    expect(
      completedRunCandidate({ type: "run.created", threadId, payload: run() } as never),
    ).toBeNull();
  });
  it("leaves subagent, archived and deleted threads alone", () => {
    const thread = (overrides: object) =>
      ({
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        archivedAt: null,
        deletedAt: null,
        ...overrides,
      }) as unknown as OrchestrationV2AppThread;
    expect(threadTakesPromptSuggestions(thread({}))).toBe(true);
    expect(
      threadTakesPromptSuggestions(
        thread({
          lineage: {
            parentThreadId: threadId,
            relationshipToParent: "fork",
            rootThreadId: threadId,
          },
        }),
      ),
    ).toBe(true);
    expect(
      threadTakesPromptSuggestions(
        thread({
          lineage: {
            parentThreadId: threadId,
            relationshipToParent: "subagent",
            rootThreadId: threadId,
          },
        }),
      ),
    ).toBe(false);
    expect(threadTakesPromptSuggestions(thread({ archivedAt: DateTime.makeUnsafe(0) }))).toBe(
      false,
    );
    expect(threadTakesPromptSuggestions(thread({ deletedAt: DateTime.makeUnsafe(0) }))).toBe(false);
    expect(
      threadTakesPromptSuggestions(thread({ origin: { kind: "mcp_client", label: "Cursor" } })),
    ).toBe(false);
  });
  it("skips runs a routine or another agent started", () => {
    expect(runStartedByPerson(message({ role: "user" }))).toBe(true);
    expect(runStartedByPerson(message({ scheduledTaskId: "task:daily" as never }))).toBe(false);
    expect(runStartedByPerson(message({ senderThreadId: ThreadId.make("thread:other") }))).toBe(
      false,
    );
  });
  it("generates only for the latest completed run without a suggestion", () => {
    expect(runNeedsGeneratedSuggestion([run()], runId)).toBe(true);
    expect(
      runNeedsGeneratedSuggestion(
        [run(), run({ id: RunId.make("run:next"), ordinal: 2, status: "running" })],
        runId,
      ),
    ).toBe(false);
    expect(
      runNeedsGeneratedSuggestion(
        [run({ promptSuggestion: { text: "go on", source: "provider" } })],
        runId,
      ),
    ).toBe(false);
  });
  it("builds the transcript from the person's message and this run's reply", () => {
    const transcript = promptSuggestionTranscript(run(), [
      message({ id: userMessageId, role: "user", text: "Fix the login bug" }),
      message({ text: "Fixed it in auth.ts." }),
      message({ id: MessageId.make("message:other"), runId: RunId.make("run:old"), text: "Old" }),
      message({ id: MessageId.make("message:live"), text: "Still typing", streaming: true }),
    ]);
    expect(transcript).toBe("Person:\nFix the login bug\n\nAgent:\nFixed it in auth.ts.");
    expect(
      promptSuggestionTranscript(run(), [message({ id: userMessageId, role: "user", text: "Hi" })]),
    ).toBeNull();
    const long = promptSuggestionTranscript(run(), [message({ text: "x".repeat(10_000) })])!;
    expect(long.startsWith("Agent:\n[Earlier text truncated]")).toBe(true);
  });
});
