import {
  ProviderInstanceId,
  RunId,
  type ServerProvider,
  ThreadId,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { provider } from "../studio/fixtures.ts";
import { providerFallbackCommand } from "./ProviderFallbackWorker.ts";

// 1339: a limit stop never moves regular work onto the Review track; a review thread may.
const now = Date.parse("2026-11-17T12:00:00.000Z");
const resetsAt = "2026-11-17T14:00:00.000Z";
const claudeId = ProviderInstanceId.make("claudeAgent");
const museId = ProviderInstanceId.make("muse");
const usage = (base: ServerProvider, slug: string, usedPercent: number): ServerProvider => ({
  ...base,
  models: [{ slug, name: slug, isCustom: false, isDefault: true, capabilities: null }],
  usageLimits: {
    ...base.usageLimits!,
    windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent, resetsAt }],
  },
});
const stopped = {
  id: ThreadId.make("t1"),
  providerInstanceId: claudeId,
  modelSelection: { instanceId: claudeId, model: "opus" },
  status: "failed" as const,
  lastErrorClass: "usage_limit" as const,
  usageLimitResetAt: resetsAt,
  latestRunId: RunId.make("r1"),
  activeRunId: null,
  pendingRuntimeRequest: null,
  settledOverride: null,
};
const rule = {
  providerLimitAction: "switch" as const,
  providerLimitFallbackModelSelection: null,
  providerLimitSwitchAtPercent: 90,
  defaultModelSelection: { instanceId: claudeId, model: "opus" },
};
const providers = [
  usage(provider(claudeId, "claudeAgent", now), "opus", 100),
  usage(provider(museId, "muse", now), "muse-wonder-1.0", 14),
];

describe("providerFallbackCommand on the Review track", () => {
  it("leaves regular work waiting rather than on Muse, and lets a review continue there", () => {
    expect(providerFallbackCommand(stopped, providers, rule, now)).toBeNull();
    const review = { ...stopped, routing: { taskClass: "review" } } as unknown as typeof stopped;
    expect(providerFallbackCommand(review, providers, rule, now)).toMatchObject({
      modelSelection: { instanceId: museId, model: "muse-wonder-1.0" },
    });
  });
});
