import {
  ProviderInstanceId,
  RunId,
  type ServerProvider,
  ThreadId,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { provider } from "../studio/fixtures.ts";
import { providerLimitStep } from "./ProviderFallbackWorker.ts";

// 1506: a thread moved to the same model on another account takes its track row's
// Ultracode, idle or stopped on a limit; a routine's own thread never does.
const now = Date.parse("2026-11-27T12:00:00.000Z");
const resetsAt = "2026-11-27T14:00:00.000Z";
const OPUS = "claude-opus-5-5";
const home = ProviderInstanceId.make("claudeAgent");
const work = ProviderInstanceId.make("claudeAgent_work");
const medium = { id: "effort", value: "medium" };
const on = { id: "ultracode", value: true };
const claude = (instanceId: ProviderInstanceId, usedPercent: number): ServerProvider => ({
  ...provider(instanceId, "claudeAgent", now),
  models: [
    {
      slug: OPUS,
      name: "Claude Opus 5.5",
      isCustom: false,
      isDefault: true,
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Effort",
            type: "select",
            options: [{ id: "medium", label: "Medium", isDefault: true }],
          },
          { id: "ultracode", label: "Ultracode", type: "boolean" },
        ],
      },
    },
  ],
  usageLimits: {
    checkedAt: new Date(now).toISOString(),
    windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent, resetsAt }],
  },
});
const providers = [claude(home, 95), claude(work, 10)];
const rule = {
  threadModelMode: "tracks" as const,
  providerLimitAction: "switch" as const,
  providerLimitFallbackModelSelection: null,
  providerLimitSwitchAtPercent: 90,
  defaultModelSelection: null,
  modelLanes: { routine: [{ instanceId: home, model: OPUS, options: [medium, on] }], complex: [] },
};
const idle = {
  id: ThreadId.make("t1"),
  providerInstanceId: home,
  modelSelection: { instanceId: home, model: OPUS, options: [medium] },
  status: "completed" as const,
  lastErrorClass: null,
  latestRunId: RunId.make("r1"),
  activeRunId: null,
  pendingRuntimeRequest: null,
  settledOverride: null,
};
const stopped = {
  ...idle,
  status: "failed" as const,
  lastErrorClass: "usage_limit" as const,
  usageLimitResetAt: resetsAt,
};
const moved = (thread: typeof idle | typeof stopped, noRowUltracode: boolean) => {
  const step = providerLimitStep(thread, providers, rule, now, {
    resetAttempted: true,
    apiCreditsAttempted: true,
    noRowUltracode,
  });
  if (step?.type !== "switch") throw new Error(`expected a switch, got ${step?.type}`);
  // An idle move sets the model; a stopped thread's continuation carries it.
  const command = step.command;
  const selection = "modelSelection" in command ? command.modelSelection : undefined;
  if (!selection) throw new Error(`expected a model, got ${command.type}`);
  expect(selection.instanceId).toBe(work);
  return selection.options ?? [];
};

describe("a move onto the same model on another account (1506)", () => {
  it("gives an idle thread the row's Ultracode, never a routine's or the coordinator's", () => {
    expect(moved(idle, false)).toContainEqual(on);
    expect(moved(idle, true)).not.toContainEqual(on);
  });

  it("gives a thread stopped on a limit the row's Ultracode, never a routine's or the coordinator's", () => {
    expect(moved(stopped, false)).toContainEqual(on);
    expect(moved(stopped, true)).not.toContainEqual(on);
  });
});
