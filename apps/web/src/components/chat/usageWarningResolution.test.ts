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
