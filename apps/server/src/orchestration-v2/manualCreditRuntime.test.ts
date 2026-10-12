import { describe, it, expect } from "vite-plus/test";
import { ProviderInstanceId, type ManualCodexCreditIntent } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { creditAdmissionOptions, manualCreditRunAllowed } from "./manualCreditRuntime.ts";

const now = Date.parse("2026-10-09T07:00:00Z");
const selection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" };
const intent: ManualCodexCreditIntent = {
  type: "human-submit-existing-credits",
  ...selection,
  expectedQuotaPoolId: `codex:sha256:${"a".repeat(64)}`,
  observedAt: new Date(now).toISOString(),
};
function state() {
  return {
    now,
    phase: "open",
    run: {
      id: "run",
      threadId: "chat",
      userMessageId: "message",
      providerInstanceId: "codex",
      providerThreadId: "thread",
      activeAttemptId: "attempt",
      modelSelection: selection,
      manualCodexCreditIntent: intent,
      status: "starting",
      startedAt: null,
    },
    attempt: {
      id: "attempt",
      runId: "run",
      providerInstanceId: "codex",
      providerThreadId: "thread",
      reason: "initial",
      attemptOrdinal: 1,
      providerTurnId: null,
      status: "pending",
      startedAt: null,
    },
    message: {
      id: "message",
      threadId: "chat",
      role: "user",
      text: "Explain this code",
      createdBy: "user",
      creationSource: "web",
    },
    providerThread: {
      id: "thread",
      driver: "codex",
      providerInstanceId: "codex",
      ownerNodeId: null,
    },
  } as unknown as Parameters<typeof manualCreditRunAllowed>[0];
}

describe("one-request credit provenance", () => {
  it("admits only the current first human request at open and actual turn", () => {
    const input = state();
    expect(manualCreditRunAllowed(input)).toBe(true);
    expect(
      manualCreditRunAllowed({
        ...input,
        phase: "turn",
        run: { ...input.run, status: "running" },
        attempt: { ...input.attempt, status: "running" },
      }),
    ).toBe(true);
  });
  it.each([
    ["retry", { attempt: { reason: "retry" } }],
    ["recovery", { attempt: { reason: "provider_recovery" } }],
    ["steer", { attempt: { reason: "steering_restart" } }],
    ["second attempt", { attempt: { attemptOrdinal: 2 } }],
    ["accepted", { attempt: { providerTurnId: "accepted" } }],
    ["queue", { run: { queuePosition: 1 } }],
    ["held queue", { run: { queueHeld: true } }],
    ["restart", { run: { restartContinuationOfRunId: "prior" } }],
    ["wake", { run: { workStartedAt: {} } }],
    ["plan", { run: { sourcePlanRef: {} } }],
    ["delegation", { run: { delegatedCompletion: {} } }],
    ["schedule", { message: { scheduledTaskId: "task" } }],
    ["agent message", { message: { senderThreadId: "agent" } }],
    ["notification", { message: { notification: {} } }],
    ["message delegation", { message: { delegatedCompletion: {} } }],
    ["assistant role", { message: { role: "assistant" } }],
    ["mcp", { message: { creationSource: "mcp" } }],
    ["system", { message: { createdBy: "system" } }],
    ["goal command", { message: { text: " /goal work forever" } }],
    ["compaction", { message: { text: "/compact" } }],
    ["active goal", { providerThread: { goal: { status: "active" } } }],
    ["changed instance", { providerThread: { providerInstanceId: "other" } }],
    ["child thread", { providerThread: { ownerNodeId: "owner" } }],
  ])("refuses %s", (_name, patch) => {
    const input = state();
    const merged = Object.fromEntries(
      Object.entries(input).map(([key, value]) => [
        key,
        typeof value === "object" ? { ...value, ...(patch as Record<string, object>)[key] } : value,
      ]),
    );
    expect(manualCreditRunAllowed(merged as unknown as typeof input)).toBe(false);
  });
  it("keeps ordinary admission unprivileged and refuses changed/stale credit binding", async () => {
    expect(
      await Effect.runPromise(creditAdmissionOptions(undefined, selection, "codex", now)),
    ).toBeUndefined();
    expect(
      await Effect.runPromise(creditAdmissionOptions(intent, selection, "codex", now)),
    ).toEqual({ allowCredits: true, expectedQuotaPoolId: intent.expectedQuotaPoolId });
    for (const [model, driver, time] of [
      ["other", "codex", now],
      [selection.model, "claudeAgent", now],
      [selection.model, "codex", now + 60_001],
      [selection.model, "codex", now - 1],
    ] as const) {
      expect(
        Exit.isFailure(
          await Effect.runPromiseExit(
            creditAdmissionOptions(intent, { ...selection, model }, driver, time),
          ),
        ),
      ).toBe(true);
    }
  });
});
