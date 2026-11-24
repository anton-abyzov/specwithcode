import { DateTime } from "effect";
import {
  RunId,
  TurnItemId,
  ThreadId,
  MessageId,
  ProviderTurnId,
} from "@specweave-studio/contracts";
import type { UsageRecoveryRun, UsageRecoveryItem } from "./usageWarningResolution";
import { expect, it } from "vite-plus/test";
import { usageWarningResolved } from "./usageWarningResolution";
const old: UsageRecoveryRun = {
  id: RunId.make("old"),
  ordinal: 1,
  status: "failed",
  startedAt: DateTime.makeUnsafe("2026-10-14T10:00:00Z"),
};
const next: UsageRecoveryRun = {
  id: RunId.make("next"),
  ordinal: 2,
  status: "completed",
  startedAt: DateTime.makeUnsafe("2026-10-14T10:01:00Z"),
};
const answer: UsageRecoveryItem = {
  id: TurnItemId.make("answer"),
  threadId: ThreadId.make("thread"),
  runId: next.id,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: ProviderTurnId.make("native-turn"),
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed",
  title: null,
  startedAt: next.startedAt,
  completedAt: next.startedAt,
  updatedAt: next.startedAt!,
  type: "assistant_message",
  messageId: MessageId.make("answer-message"),
  text: "Working on it",
  streaming: false,
};
it("resolves old failures after same-provider or fallback execution", () => {
  expect(usageWarningResolved("old", [old, next])).toBe(true);
  expect(usageWarningResolved("old", [old, { ...next, status: "running" }])).toBe(false);
  expect(
    usageWarningResolved("old", [old, next, { ...old, id: RunId.make("new-failure"), ordinal: 3 }]),
  ).toBe(true);
  expect(
    usageWarningResolved("new-failure", [
      old,
      next,
      { ...old, id: RunId.make("new-failure"), ordinal: 3 },
    ]),
  ).toBe(false);
});
it("does not mistake pending, refused or earlier work for recovery", () => {
  for (const status of ["queued", "starting", "failed", "interrupted"] as const)
    expect(usageWarningResolved("old", [old, { ...next, status }])).toBe(false);
  expect(usageWarningResolved(null, [old, next])).toBe(false);
  expect(usageWarningResolved("missing", [next])).toBe(false);
  expect(usageWarningResolved("old", [old, { ...next, startedAt: null }])).toBe(false);
  expect(usageWarningResolved("old", [old, { ...next, ordinal: 0 }])).toBe(false);
});

it("keeps recovery resolved after later interruption or failure once the provider answered", () => {
  for (const status of ["running", "waiting", "failed", "interrupted"] as const)
    expect(usageWarningResolved("old", [old, { ...next, status }], [answer])).toBe(true);
});

it("does not count workspace setup commands as provider recovery", () => {
  const setup: UsageRecoveryItem = {
    ...answer,
    type: "command_execution",
    input: "npm install",
    providerTurnId: null,
  };
  const runs: UsageRecoveryRun[] = [old, { ...next, status: "failed" }];
  expect(usageWarningResolved("old", runs, [setup])).toBe(false);
  expect(
    usageWarningResolved("old", runs, [
      { ...setup, providerTurnId: ProviderTurnId.make("provider-turn") },
    ]),
  ).toBe(true);
});

it("does not count a later run that only wrote its own limit refusal (1460)", () => {
  const refused = { ...next, status: "failed" as const };
  const refusal: UsageRecoveryItem = {
    ...answer,
    text: "Error: You have exceeded your monthly quota",
  };
  const limit: UsageRecoveryItem = {
    ...answer,
    id: TurnItemId.make("limit"),
    type: "error",
    failure: {
      class: "usage_limit",
      message: "Monthly quota used up on this provider.",
      code: null,
      retryable: null,
    },
  } as UsageRecoveryItem;
  expect(usageWarningResolved("old", [old, refused], [refusal, limit])).toBe(false);
  // The same text on a run that failed for another reason still counts.
  expect(usageWarningResolved("old", [old, refused], [refusal])).toBe(true);
});

it("counts a real answer from a run that later stopped on its own limit (1460)", () => {
  const refused = { ...next, status: "failed" as const };
  const limit = {
    ...answer,
    id: TurnItemId.make("limit-2"),
    type: "error",
    failure: { class: "usage_limit", message: "Usage limit", code: null, retryable: null },
  } as UsageRecoveryItem;
  const real: UsageRecoveryItem = { ...answer, text: "I fixed the parser and the tests pass now." };
  expect(usageWarningResolved("old", [old, refused], [real, limit])).toBe(true);
});
