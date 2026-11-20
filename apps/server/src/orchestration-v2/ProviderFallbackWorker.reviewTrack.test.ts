import {
  ProviderInstanceId,
  RunId,
  type ServerProvider,
  ThreadId,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { provider } from "../studio/fixtures.ts";
import { providerFallbackCommand, providerLimitStep } from "./ProviderFallbackWorker.ts";

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
  it("skips the author's family after a reviewer hits its limit", () => {
    const copilotId = ProviderInstanceId.make("copilot");
    const codexId = ProviderInstanceId.make("codex");
    const reviewer = { instanceId: copilotId, model: "gemini-4-neon" };
    const author = { instanceId: codexId, model: "gpt-6.2-sol" };
    const alternate = { instanceId: museId, model: "muse-wonder-1.0" };
    const review = {
      ...stopped,
      providerInstanceId: copilotId,
      modelSelection: reviewer,
      routing: {
        taskClass: "review" as const,
        confidence: "high" as const,
        moved: false,
        tier: null,
        baseline: author,
        reviewAuthorFamily: "openai" as const,
        selection: reviewer,
        escalation: null,
        billing: "unknown" as const,
        reason: "Adversarial review of finished work.",
        signals: [],
        decidedAt: resetsAt,
      },
    };
    const available = [
      usage(provider(copilotId, "acpRegistry", now), reviewer.model, 100),
      usage(provider(codexId, "codex", now), author.model, 14),
      providers[1]!,
    ];
    const trackRule = {
      ...rule,
      threadModelMode: "tracks" as const,
      adversarialReview: { reviewers: [reviewer, author, alternate] },
    };
    const options = { resetAttempted: false, proven: author };
    expect(providerLimitStep(review, available, trackRule, now, options)).toMatchObject({
      type: "switch",
      command: { modelSelection: alternate },
    });
    expect(providerLimitStep(review, available.slice(0, 2), trackRule, now, options)).toBeNull();
  });

  it("leaves regular work waiting rather than on Muse, and lets a review continue there", () => {
    expect(providerFallbackCommand(stopped, providers, rule, now)).toBeNull();
    const review = { ...stopped, routing: { taskClass: "review" } } as unknown as typeof stopped;
    expect(providerFallbackCommand(review, providers, rule, now)).toMatchObject({
      modelSelection: { instanceId: museId, model: "muse-wonder-1.0" },
    });
  });

  it("recognises a review thread started before the routing marker by its title", () => {
    const legacy = { ...stopped, title: "Adversarial review: Model tracks" };
    expect(providerFallbackCommand(legacy, providers, rule, now)).toMatchObject({
      modelSelection: { instanceId: museId, model: "muse-wonder-1.0" },
    });
    // Regular work that only mentions a review in its title stays regular.
    const regular = { ...stopped, title: "Fix the adversarial review card" };
    expect(providerFallbackCommand(regular, providers, rule, now)).toBeNull();
    // A routed regular thread is never read as review work by its title.
    const routed = {
      ...stopped,
      title: "Adversarial review: renamed",
      routing: { taskClass: "routine" },
    } as unknown as typeof stopped;
    expect(providerFallbackCommand(routed, providers, rule, now)).toBeNull();
  });
});
