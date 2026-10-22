import { ProviderInstanceId, RunId, RuntimeRequestId, ThreadId } from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { limitHandoffTrigger } from "./MachineLimitHandoff.ts";

const stoppedAt = Date.parse("2026-10-21T10:00:00.000Z");
const limited = {
  id: ThreadId.make("t1"),
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  status: "failed" as const,
  latestRunId: RunId.make("r2"),
  activeRunId: null,
  pendingRuntimeRequest: null,
  settledOverride: null,
  latestRunCompletedAt: DateTime.makeUnsafe(stoppedAt),
};
const base = {
  thread: limited,
  rule: {
    providerLimitAction: "switch" as const,
    providerLimitMachineTargets: [
      {
        environmentId: "minis",
        machineLabel: "Minis",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      },
    ],
    providerLimitTargetOrder: "other-machine-first" as const,
  },
  nowMs: stoppedAt + 60_000,
  stopped: true,
  atThreshold: false,
  localStep: null,
  windowKey: "five_hour",
} as unknown as Parameters<typeof limitHandoffTrigger>[0];
const pending = (detail: object): Parameters<typeof limitHandoffTrigger>[0] => ({
  ...base,
  thread: {
    ...limited,
    pendingRuntimeRequest: {
      id: RuntimeRequestId.make("q1"),
      createdAt: DateTime.makeUnsafe(stoppedAt),
      ...detail,
    },
  } as unknown as Parameters<typeof limitHandoffTrigger>[0]["thread"],
});

describe("limitHandoffTrigger with a pending request", () => {
  it("hands off past a question the next message answers", () => {
    expect(
      limitHandoffTrigger(
        pending({ kind: "user_input", responseCapability: { type: "message" }, runId: "r2" }),
      )?.key,
    ).toBe("limit-handoff:t1:r2");
  });

  it("hands off past a request an earlier run left", () => {
    expect(
      limitHandoffTrigger(
        pending({
          kind: "command",
          responseCapability: { type: "not_resumable", reason: "ended" },
          runId: "r1",
        }),
      ),
    ).not.toBeNull();
  });

  it("waits on an approval of the stopped run, or a request it cannot read", () => {
    expect(
      limitHandoffTrigger(
        pending({
          kind: "command",
          responseCapability: { type: "not_resumable", reason: "ended" },
          runId: "r2",
        }),
      ),
    ).toBeNull();
    expect(limitHandoffTrigger(pending({ kind: "user_input" }))).toBeNull();
  });
});
