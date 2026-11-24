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
import { isProviderRefusalText, usageWarningResolved } from "./usageWarningResolution";
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
  const real: UsageRecoveryItem = {
    ...answer,
    text: `I fixed the parser. ${"The tests cover each case and pass now. ".repeat(12)}`,
  };
  expect(usageWarningResolved("old", [old, refused], [real, limit])).toBe(true);
  // So does tool work, whatever the text.
  const edit = {
    ...answer,
    id: TurnItemId.make("edit"),
    type: "file_change",
  } as unknown as UsageRecoveryItem;
  expect(usageWarningResolved("old", [old, refused], [edit, limit])).toBe(true);
});

it("never reads a short note from a run that stopped on its limit as recovery (1460)", () => {
  const refused = { ...next, status: "failed" as const };
  const limit = {
    ...answer,
    id: TurnItemId.make("limit-3"),
    type: "error",
    failure: { class: "usage_limit", message: "Usage limit", code: null, retryable: null },
  } as UsageRecoveryItem;
  // A refusal the classifier does not know, in the length of any notice.
  const note: UsageRecoveryItem = { ...answer, text: "Please try again after 3 PM." };
  expect(usageWarningResolved("old", [old, refused], [note, limit])).toBe(false);
});

it("names a refusal by the server's own rule, never by a word in an answer (1460)", () => {
  expect(
    isProviderRefusalText("Error: You have exceeded your monthly quota (Request ID: ab:12)"),
  ).toBe(true);
  expect(isProviderRefusalText("You have exceeded your monthly quota.")).toBe(true);
  expect(isProviderRefusalText("")).toBe(true);
  expect(
    isProviderRefusalText("The bucket quota is 5 GB; the upload exceeded it, so I split the file."),
  ).toBe(false);
  expect(isProviderRefusalText("Please try again after 3 PM.")).toBe(false);
  // Cursor's refusal arrives as the run's error; its text repeats that failure.
  const cursor = "Gemini 4 Neon is not included in your weekly usage.";
  expect(isProviderRefusalText(cursor)).toBe(false);
  expect(isProviderRefusalText(cursor, [cursor])).toBe(true);
  expect(isProviderRefusalText("I split the file and the upload worked.", [cursor])).toBe(false);
  expect(isProviderRefusalText(`Error: ${cursor} (Request ID: ab-12)`, [cursor])).toBe(true);
  // Part of the failure, or the failure inside an answer, is an answer.
  expect(isProviderRefusalText("Continue.", [cursor])).toBe(false);
  expect(isProviderRefusalText(`The build is done. Cursor then said: ${cursor}`, [cursor])).toBe(
    false,
  );
});
