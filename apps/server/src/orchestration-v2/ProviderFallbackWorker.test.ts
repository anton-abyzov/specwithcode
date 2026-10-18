import {
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  ProjectId,
  type OrchestrationV2ServerCommand,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { it as itEffect } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "vite-plus/test";

import * as Instances from "../provider/ProviderInstanceRegistry.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import { fallbackPolicyTestLayer } from "./providerFallbackPolicyTestHelpers.ts";
import * as Projects from "../project/ProjectService.ts";
import { provider } from "../studio/fixtures.ts";
import {
  API_CREDIT_IDLE_RETURN_MS,
  apiCreditOrigin,
  apiCreditReturnCommand,
  limitFallbackReturnCommand,
  LIMIT_FALLBACK_MESSAGE_PREFIX,
  limitResetAt,
  limitStopIsCurrent,
  makeSweep,
  ProviderFallbackEnv,
  providerFallbackCommand,
  providerLimitStep,
  reachedLimitWindow,
  unreportedLimitStops,
} from "./ProviderFallbackWorker.ts";
import { resolveUsageLimitsAfterProbe } from "../provider/providerUsageLimits.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const now = Date.parse("2026-10-09T12:00:00.000Z");
const resetsAt = "2026-10-09T14:00:00.000Z";
const claudeId = ProviderInstanceId.make("claudeAgent");
const codexId = ProviderInstanceId.make("codex");
const apiId = ProviderInstanceId.make("claudeApi");
const legacyProject = {
  id: ProjectId.make("legacy"),
  title: "Legacy project",
  workspaceRoot: "/project",
  defaultModelSelection: null,
  workspaceSettings: DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  scripts: [],
  createdAt: "2026-10-09T00:00:00Z",
  updatedAt: "2026-10-09T00:00:00Z",
  deletedAt: null,
};

function withUsage(base: ServerProvider, usedPercent: number): ServerProvider {
  return {
    ...base,
    models: [
      {
        slug: base.instanceId === codexId ? "gpt-6" : "default-model",
        name: "Default",
        isCustom: false,
        isDefault: true,
        capabilities: null,
      },
    ],
    usageLimits: {
      ...base.usageLimits!,
      windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent, resetsAt }],
    },
  };
}

const idle = {
  id: ThreadId.make("t1"),
  providerInstanceId: claudeId,
  modelSelection: { instanceId: claudeId, model: "opus" },
  status: "completed" as const,
  lastErrorClass: null,
  latestRunId: RunId.make("r1"),
  activeRunId: null,
  pendingRuntimeRequest: null,
  settledOverride: null,
};
const rule = {
  providerLimitAction: "switch" as const,
  providerLimitFallbackModelSelection: { instanceId: codexId, model: "gpt-6" },
  providerLimitSwitchAtPercent: 90,
  defaultModelSelection: { instanceId: claudeId, model: "opus" },
};

describe("providerFallbackCommand", () => {
  const claudeFull = withUsage(provider(claudeId, "claudeAgent", now), 92);
  const codexFree = withUsage(provider(codexId, "codex", now), 30);

  it("moves an idle thread to the fallback once its provider reaches the threshold", () => {
    const command = providerFallbackCommand(idle, [claudeFull, codexFree], rule, now);
    expect(command).toMatchObject({
      type: "thread.model-selection.set",
      threadId: idle.id,
      modelSelection: { instanceId: codexId, model: "gpt-6" },
      commandId: `limit-preswitch:t1:claudeAgent:${resetsAt}`,
    });
  });

  it("waits under the threshold, during a turn, and for other rules", () => {
    const claudeOk = withUsage(provider(claudeId, "claudeAgent", now), 80);
    expect(providerFallbackCommand(idle, [claudeOk, codexFree], rule, now)).toBeNull();
    expect(
      providerFallbackCommand(
        { ...idle, activeRunId: RunId.make("r2") },
        [claudeFull, codexFree],
        rule,
        now,
      ),
    ).toBeNull();
    expect(
      providerFallbackCommand(
        idle,
        [claudeFull, codexFree],
        { ...rule, providerLimitAction: "ask" },
        now,
      ),
    ).toBeNull();
    expect(
      providerFallbackCommand(
        idle,
        [claudeFull, codexFree],
        { ...rule, providerLimitSwitchAtPercent: null },
        now,
      ),
    ).toBeNull();
  });

  it("does not switch early when the full window resets within the wait", () => {
    const soon = {
      ...claudeFull,
      usageLimits: {
        ...claudeFull.usageLimits!,
        windows: [
          {
            id: "five_hour",
            kind: "session" as const,
            label: "Session",
            usedPercent: 96,
            resetsAt: DateTime.formatIso(DateTime.makeUnsafe(now + 20 * 60_000)),
          },
        ],
      },
    };
    const waiting = { ...rule, providerLimitWaitUnderMinutes: 30 };
    expect(providerFallbackCommand(idle, [soon, codexFree], waiting, now)).toBeNull();
    expect(
      providerFallbackCommand(
        idle,
        [soon, codexFree],
        { ...waiting, providerLimitWaitUnderMinutes: 0 },
        now,
      ),
    ).toMatchObject({
      type: "thread.model-selection.set",
    });
  });

  it("does not move a thread onto a provider that is full too", () => {
    const codexFull = withUsage(provider(codexId, "codex", now), 95);
    expect(providerFallbackCommand(idle, [claudeFull, codexFull], rule, now)).toBeNull();
  });

  it("continues a stopped turn even with no early threshold", () => {
    const limited = { ...idle, status: "failed" as const, lastErrorClass: "usage_limit" as const };
    expect(
      providerFallbackCommand(
        limited,
        [claudeFull, codexFree],
        { ...rule, providerLimitSwitchAtPercent: null },
        now,
      ),
    ).toMatchObject({
      type: "message.dispatch",
      manualContinuationOfRunId: "r1",
      modelSelection: { instanceId: codexId },
    });
  });
});

describe("unreportedLimitStops", () => {
  const copilotId = ProviderInstanceId.make("copilot");
  const copilot: ServerProvider = {
    ...provider(copilotId, "acp", now),
    models: [{ slug: "opus", name: "Opus", isCustom: false, capabilities: null }],
    usageLimits: undefined,
  };
  const claudeFull = withUsage(provider(claudeId, "claudeAgent", now), 95);
  const stopped = {
    ...idle,
    id: ThreadId.make("t2"),
    providerInstanceId: copilotId,
    modelSelection: { instanceId: copilotId, model: "opus" },
    status: "failed" as const,
    lastErrorClass: "usage_limit" as const,
    usageLimitResetAt: "2026-10-09T13:00:00.000Z",
  };

  it("holds a provider that reports no usage until its stop resets", () => {
    const held = unreportedLimitStops(new Map(), [stopped], [copilot], now);
    expect([...held]).toEqual([[copilotId, Date.parse("2026-10-09T13:00:00.000Z")]]);
    // The stopped thread has gone back to Claude; the hold outlives it.
    expect(unreportedLimitStops(held, [], [copilot], now + 30 * 60_000).has(copilotId)).toBe(true);
    expect(unreportedLimitStops(held, [], [copilot], now + 61 * 60_000).size).toBe(0);
  });

  it("ignores providers that report usage and stops that are no longer current", () => {
    const onClaude = { ...stopped, providerInstanceId: claudeId };
    expect(unreportedLimitStops(new Map(), [onClaude], [claudeFull], now).size).toBe(0);
    const old = { ...stopped, usageLimitResetAt: "2026-10-09T11:00:00.000Z" };
    expect(unreportedLimitStops(new Map(), [old], [copilot], now).size).toBe(0);
  });

  it("keeps a thread off a held provider that reports no usage", () => {
    const onClaude = {
      ...stopped,
      providerInstanceId: claudeId,
      modelSelection: idle.modelSelection,
    };
    const copilotRule = { ...rule, providerLimitFallbackModelSelection: null };
    expect(
      providerFallbackCommand(onClaude, [claudeFull, copilot], copilotRule, now),
    ).toMatchObject({ modelSelection: { instanceId: copilotId } });
    expect(
      providerFallbackCommand(
        onClaude,
        [claudeFull, copilot],
        copilotRule,
        now,
        null,
        new Set([copilotId]),
      ),
    ).toBeNull();
  });
});

describe("providerLimitStep", () => {
  const claudeFull = withUsage(provider(claudeId, "claudeAgent", now), 100);
  const codexFree = withUsage(provider(codexId, "codex", now), 30);
  const limited = { ...idle, status: "failed" as const, lastErrorClass: "usage_limit" as const };
  const banked = {
    ...claudeFull,
    usageLimits: {
      ...claudeFull.usageLimits!,
      resetCredits: { availableCount: 2, nextCreditId: "grant_a" },
    },
  };
  const codexLimited = {
    ...limited,
    providerInstanceId: codexId,
    modelSelection: { instanceId: codexId, model: "gpt-6" },
  };
  const codexWithCredits = {
    ...withUsage(provider(codexId, "codex", now), 100),
    usageLimits: {
      ...withUsage(provider(codexId, "codex", now), 100).usageLimits!,
      ordinaryUsageAllowed: false,
      spendControlReached: false,
      rateLimitReachedType: "rate_limit_reached",
      credits: { hasCredits: true, unlimited: false, balance: "56687.25" },
    },
  };

  it("redeems a banked reset before anything else, once per stopped run", () => {
    const rule2 = { ...rule, providerLimitRedeemResets: true };
    const step = providerLimitStep(limited, [banked, codexFree], rule2, now, {
      resetAttempted: false,
    });
    expect(step).toMatchObject({
      type: "redeem-reset",
      instanceId: claudeId,
      continuation: {
        type: "message.dispatch",
        commandId: "limit-reset:t1:r1",
        manualContinuationOfRunId: "r1",
        modelSelection: { instanceId: claudeId },
      },
    });
    expect(
      providerLimitStep(limited, [banked, codexFree], rule2, now, { resetAttempted: true }),
    ).toMatchObject({ type: "switch" });
    expect(
      providerLimitStep(limited, [claudeFull, codexFree], rule2, now, { resetAttempted: false }),
    ).toMatchObject({ type: "switch" });
    expect(
      providerLimitStep(
        limited,
        [banked, codexFree],
        { ...rule2, providerLimitAction: "wait" },
        now,
        { resetAttempted: false },
      ),
    ).toBeNull();
    expect(
      providerLimitStep(idle, [banked, codexFree], rule2, now, { resetAttempted: false }),
    ).toBeNull();
  });

  it("continues a limited Codex turn on paid credits only when the project allows it", () => {
    const spend = { ...rule, providerLimitAction: "ask" as const, providerLimitSpendCredits: true };
    const step = providerLimitStep(codexLimited, [codexWithCredits], spend, now, {
      resetAttempted: false,
    });
    expect(step).toMatchObject({
      type: "spend-credits",
      command: {
        commandId: "limit-credits:t1:r1",
        manualContinuationOfRunId: "r1",
        modelSelection: { instanceId: codexId, model: "gpt-6" },
        manualCodexCreditIntent: {
          type: "project-rule-existing-credits",
          instanceId: codexId,
          model: "gpt-6",
          expectedQuotaPoolId: codexWithCredits.usageLimits!.quotaPoolId,
          observedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
        },
      },
    });
    expect(
      providerLimitStep(
        codexLimited,
        [codexWithCredits],
        { ...spend, providerLimitSpendCredits: false },
        now,
        { resetAttempted: false },
      ),
    ).toBeNull();
    const empty = {
      ...codexWithCredits,
      usageLimits: {
        ...codexWithCredits.usageLimits,
        credits: { hasCredits: true, unlimited: false, balance: "0" },
      },
    };
    expect(
      providerLimitStep(codexLimited, [empty], spend, now, { resetAttempted: false }),
    ).toBeNull();
    const capped = {
      ...codexWithCredits,
      usageLimits: { ...codexWithCredits.usageLimits, spendControlReached: true },
    };
    expect(
      providerLimitStep(codexLimited, [capped], spend, now, { resetAttempted: false }),
    ).toBeNull();
    expect(
      providerLimitStep(codexLimited, [codexWithCredits], spend, now, {
        resetAttempted: false,
        simulated: true,
      }),
    ).toBeNull();
  });

  it("waits for a reset within the project's wait instead of redeeming, spending or switching", () => {
    const at = (minutes: number) => DateTime.formatIso(DateTime.makeUnsafe(now + minutes * 60_000));
    const waiting = {
      ...rule,
      providerLimitWaitUnderMinutes: 30,
      providerLimitRedeemResets: true,
      providerLimitSpendCredits: true,
    };
    const soon = { ...limited, usageLimitResetAt: at(20) };
    expect(
      providerLimitStep(soon, [banked, codexFree], waiting, now, { resetAttempted: false }),
    ).toBeNull();
    expect(providerFallbackCommand(soon, [claudeFull, codexFree], waiting, now)).toBeNull();
    expect(
      providerLimitStep(
        { ...codexLimited, usageLimitResetAt: at(20) },
        [codexWithCredits],
        waiting,
        now,
        { resetAttempted: false },
      ),
    ).toBeNull();
    // Too far to wait for, or the resume at the reset did not happen: the rule acts.
    expect(
      providerLimitStep(
        { ...limited, usageLimitResetAt: at(45) },
        [banked, codexFree],
        waiting,
        now,
        { resetAttempted: false },
      ),
    ).toMatchObject({ type: "redeem-reset" });
    expect(
      providerLimitStep(
        { ...limited, usageLimitResetAt: at(-11) },
        [claudeFull, codexFree],
        waiting,
        now,
        { resetAttempted: false },
      ),
    ).toMatchObject({ type: "switch" });
    expect(
      providerLimitStep(
        soon,
        [claudeFull, codexFree],
        { ...waiting, providerLimitWaitUnderMinutes: 0 },
        now,
        { resetAttempted: false },
      ),
    ).toMatchObject({ type: "switch" });
  });
});

describe("Claude API credits", () => {
  const claudeFull = withUsage(provider(claudeId, "claudeAgent", now), 100);
  const codexFree = withUsage(provider(codexId, "codex", now), 30);
  const api: ServerProvider = {
    ...withUsage(provider(apiId, "claudeAgent", now), 0),
    models: [{ slug: "opus", name: "Opus", isCustom: false, isDefault: true, capabilities: null }],
    auth: { status: "authenticated", type: "apiKey", apiKeyBilling: true },
    usageLimits: undefined,
  };
  const limited = {
    ...idle,
    status: "failed" as const,
    lastErrorClass: "usage_limit" as const,
    usageLimitResetAt: resetsAt,
  };
  const allow = { ...rule, providerLimitUseApiCredits: true };

  it("continues a limited subscription turn on the API-key instance before the fallback", () => {
    const step = providerLimitStep(limited, [claudeFull, codexFree, api], allow, now, {
      resetAttempted: false,
    });
    expect(step).toMatchObject({
      type: "api-credits",
      instanceId: claudeId,
      command: {
        type: "message.dispatch",
        commandId: "limit-api:t1:r1",
        messageId: "limit-api:t1:r1",
        manualContinuationOfRunId: "r1",
        modelSelection: { instanceId: apiId, model: "opus" },
      },
    });
  });

  it("only takes an instance with its own Anthropic key that lists the thread's model", () => {
    const step = (candidate: ServerProvider) =>
      providerLimitStep(
        limited,
        [claudeFull, candidate],
        { ...allow, providerLimitAction: "ask" },
        now,
        { resetAttempted: false },
      );
    expect(step(api)).toMatchObject({ type: "api-credits" });
    // A router or proxy token is billed somewhere else.
    expect(step({ ...api, auth: { status: "authenticated", type: "apiKey" } })).toBeNull();
    // Never a dearer or cheaper model than the thread was on.
    expect(
      step({
        ...api,
        models: [
          { slug: "haiku", name: "Haiku", isCustom: false, isDefault: true, capabilities: null },
        ],
      }),
    ).toBeNull();
    expect(step({ ...api, enabled: false })).toBeNull();
  });

  it("spends nothing on a stop that is old, snoozed or simulated", () => {
    const providers = [claudeFull, api];
    const ask = { ...allow, providerLimitAction: "ask" as const };
    const step = (thread: Parameters<typeof providerLimitStep>[0]) =>
      providerLimitStep(thread, providers, ask, now, { resetAttempted: false });
    expect(step(limited)).toMatchObject({ type: "api-credits" });
    expect(step({ ...limited, usageLimitResetAt: "2026-10-09T11:59:59.000Z" })).toBeNull();
    const at = (ms: number) => DateTime.makeUnsafe(ms);
    const unnamed = { ...limited, usageLimitResetAt: null };
    expect(step(unnamed)).toBeNull();
    expect(step({ ...unnamed, latestRunCompletedAt: at(now - 60_000) })).toMatchObject({
      type: "api-credits",
    });
    expect(step({ ...unnamed, latestRunCompletedAt: at(now - 6 * 60 * 60_000) })).toBeNull();
    expect(limitStopIsCurrent({ ...unnamed, latestRunCompletedAt: at(now - 60_000) }, now)).toBe(
      true,
    );
    expect(step({ ...limited, snoozedUntil: at(now + 60_000) })).toBeNull();
    expect(step({ ...limited, snoozedUntil: at(now - 60_000) })).toMatchObject({
      type: "api-credits",
    });
    // "Snooze limited threads" snoozes every stop until its reset; that is not a person's choice.
    const policy = { runId: RunId.make("r1"), resetAt: resetsAt, autoResume: false, snooze: true };
    const untilReset = {
      ...limited,
      snoozedUntil: at(Date.parse(resetsAt)),
      limitRecovery: policy as never,
    };
    const withPolicy = (thread: Parameters<typeof providerLimitStep>[0]) =>
      providerLimitStep(thread, providers, { ...ask, snoozeLimitedThreads: true }, now, {
        resetAttempted: false,
      });
    expect(withPolicy(untilReset)).toMatchObject({ type: "api-credits" });
    expect(withPolicy({ ...untilReset, snoozedUntil: at(Date.parse(resetsAt) + 1) })).toBeNull();
    // Without that setting the same snooze is a person's "Snooze until reset".
    expect(step(untilReset)).toBeNull();
    expect(
      step({ ...limited, lastError: "Simulated usage limit (STUDIO_SIMULATE_USAGE_LIMIT)." }),
    ).toBeNull();
  });

  it("never redeems or spends credits on a simulated stop after the variable is unset", () => {
    const simulatedStop = {
      ...limited,
      lastError: "Simulated usage limit (STUDIO_SIMULATE_USAGE_LIMIT).",
    };
    const banked = {
      ...claudeFull,
      usageLimits: { ...claudeFull.usageLimits!, resetCredits: { availableCount: 2 } },
    };
    const redeem = {
      ...rule,
      providerLimitAction: "ask" as const,
      providerLimitRedeemResets: true,
    };
    expect(
      providerLimitStep(limited, [banked], redeem, now, { resetAttempted: false }),
    ).toMatchObject({ type: "redeem-reset" });
    expect(
      providerLimitStep(simulatedStop, [banked], redeem, now, { resetAttempted: false }),
    ).toBeNull();
  });

  it("stays off without the rule, without an API-key instance, once tried, and while simulated", () => {
    const providers = [claudeFull, codexFree, api];
    expect(
      providerLimitStep(limited, providers, rule, now, { resetAttempted: false }),
    ).toMatchObject({ type: "switch" });
    expect(
      providerLimitStep(limited, [claudeFull, codexFree], allow, now, { resetAttempted: false }),
    ).toMatchObject({ type: "switch" });
    expect(
      providerLimitStep(limited, providers, allow, now, {
        resetAttempted: false,
        apiCreditsAttempted: true,
      }),
    ).toMatchObject({ type: "switch" });
    expect(
      providerLimitStep(limited, providers, allow, now, { resetAttempted: false, simulated: true }),
    ).toMatchObject({ type: "switch" });
    expect(
      providerLimitStep(limited, providers, { ...allow, providerLimitAction: "wait" }, now, {
        resetAttempted: false,
      }),
    ).toBeNull();
  });

  it("never falls back to an instance billed per token as any ready provider", () => {
    const open = {
      ...rule,
      providerLimitFallbackModelSelection: null,
      defaultModelSelection: null,
    };
    expect(
      providerLimitStep(limited, [claudeFull, api], open, now, { resetAttempted: false }),
    ).toBeNull();
    const bedrock = { ...api, auth: { status: "authenticated" as const, type: "bedrock" } };
    expect(
      providerLimitStep(limited, [claudeFull, bedrock], open, now, { resetAttempted: false }),
    ).toBeNull();
    // Nor is a Bedrock thread a subscription thread to move onto the key.
    const onBedrock = {
      ...limited,
      providerInstanceId: apiId,
      modelSelection: { instanceId: apiId, model: "opus" },
    };
    const key = { ...api, instanceId: ProviderInstanceId.make("claudeKey") };
    expect(
      providerLimitStep(onBedrock, [bedrock, key], { ...allow, providerLimitAction: "ask" }, now, {
        resetAttempted: false,
      }),
    ).toBeNull();
  });

  const onApi = {
    ...idle,
    providerInstanceId: apiId,
    modelSelection: { instanceId: apiId, model: "opus" },
    latestRunId: RunId.make("r3"),
  };
  const run = (
    id: string,
    ordinal: number,
    instanceId: ProviderInstanceId,
    userMessageId: string,
  ) => ({
    id: RunId.make(id),
    ordinal,
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "opus" },
    userMessageId: userMessageId as never,
  });
  const moved = [
    run("r1", 1, claudeId, "m1"),
    run("r2", 2, apiId, "limit-api:t1:r1"),
    run("r3", 3, apiId, "m3"),
  ];

  it("finds the subscription run the rule continued, and nothing for a thread a person moved", () => {
    expect(apiCreditOrigin(onApi, moved)).toEqual({
      stoppedRunId: "r1",
      continuedByRunId: "r2",
      modelSelection: { instanceId: claudeId, model: "opus" },
      resetAt: null,
    });
    expect(
      apiCreditOrigin(onApi, [run("r1", 1, claudeId, "m1"), run("r2", 2, apiId, "m2")]),
    ).toBeNull();
    // A continuation that stopped and was continued again still leads to the subscription.
    const chained = [...moved.slice(0, 2), run("r3", 3, apiId, "limit-api:t1:r2")];
    expect(apiCreditOrigin(onApi, chained)).toMatchObject({
      stoppedRunId: "r1",
      continuedByRunId: "r3",
    });
    // A run elsewhere since the move means a person chose where the thread runs.
    expect(
      apiCreditOrigin(onApi, [
        ...moved.slice(0, 2),
        run("r3", 3, codexId, "m3"),
        run("r4", 4, apiId, "m4"),
      ]),
    ).toBeNull();
  });

  it("moves a thread whose API account ran out of credits on to the next account", () => {
    const second: ServerProvider = { ...api, instanceId: ProviderInstanceId.make("claudeApi2") };
    const outOfCredits = {
      ...limited,
      providerInstanceId: apiId,
      modelSelection: { instanceId: apiId, model: "opus" },
      usageLimitResetAt: null,
      latestRunCompletedAt: DateTime.makeUnsafe(now - 60_000),
      lastError: "Credit balance too low · Add funds: https://platform.claude.com/settings/billing",
    };
    const ask = { ...allow, providerLimitAction: "ask" as const };
    expect(
      providerLimitStep(outOfCredits, [claudeFull, api, second], ask, now, {
        resetAttempted: false,
      }),
    ).toMatchObject({
      type: "api-credits",
      instanceId: apiId,
      rotate: true,
      command: {
        commandId: "limit-api:t1:r1",
        modelSelection: { instanceId: second.instanceId, model: "opus" },
      },
    });
    // No other account, the rule off, or another kind of stop on the key: nothing moves.
    expect(
      providerLimitStep(outOfCredits, [claudeFull, api], ask, now, { resetAttempted: false }),
    ).toBeNull();
    expect(
      providerLimitStep(
        outOfCredits,
        [claudeFull, api, second],
        { ...rule, providerLimitAction: "ask" },
        now,
        { resetAttempted: false },
      ),
    ).toBeNull();
    expect(
      providerLimitStep(
        { ...outOfCredits, lastError: "Claude API rate limit reached. Try again later." },
        [claudeFull, api, second],
        ask,
        now,
        { resetAttempted: false },
      ),
    ).toBeNull();
    expect(
      providerLimitStep(outOfCredits, [claudeFull, api, second], ask, now, {
        resetAttempted: false,
        simulated: true,
      }),
    ).toBeNull();
  });

  it("leads the way back through every API account to the subscription", () => {
    const secondId = ProviderInstanceId.make("claudeApi2");
    const rotated = [
      run("r1", 1, claudeId, "m1"),
      run("r2", 2, apiId, "limit-api:t1:r1"),
      run("r3", 3, apiId, "m3"),
      run("r4", 4, secondId, "limit-api:t1:r3"),
    ];
    expect(apiCreditOrigin({ id: onApi.id, providerInstanceId: secondId }, rotated)).toEqual({
      stoppedRunId: "r1",
      continuedByRunId: "r4",
      modelSelection: { instanceId: claudeId, model: "opus" },
      resetAt: null,
    });
    // An account a person put the thread on is where the way back ends.
    expect(
      apiCreditOrigin({ id: onApi.id, providerInstanceId: secondId }, [
        run("r1", 1, apiId, "m1"),
        run("r2", 2, secondId, "limit-api:t1:r1"),
      ]),
    ).toMatchObject({ stoppedRunId: "r1", modelSelection: { instanceId: apiId } });
  });

  const claudeOpen = withUsage(provider(claudeId, "claudeAgent", now), 4);
  const back = {
    type: "thread.model-selection.set",
    commandId: "limit-api-return:t1:r2",
    threadId: "t1",
    modelSelection: { instanceId: claudeId, model: "opus" },
  };

  it("goes back once the subscription's usage read shows no limit", () => {
    const origin = apiCreditOrigin(onApi, moved)!;
    expect(apiCreditReturnCommand(onApi, origin, [claudeOpen, api], now)).toEqual(back);
    expect(apiCreditReturnCommand(onApi, origin, [claudeFull, api], now)).toBeNull();
    // The window reset since the last read.
    expect(
      apiCreditReturnCommand(onApi, origin, [claudeFull, api], Date.parse(resetsAt) + 1),
    ).not.toBeNull();
    const unread = { ...claudeOpen, usageLimits: undefined };
    expect(apiCreditReturnCommand(onApi, origin, [unread, api], now)).toBeNull();
    expect(
      apiCreditReturnCommand(
        { ...onApi, providerInstanceId: claudeId },
        origin,
        [claudeOpen, api],
        now,
      ),
    ).toBeNull();
  });

  it("goes back when the stopped run's limit has reset, whatever the cached read says", () => {
    const origin = { ...apiCreditOrigin(onApi, moved)!, resetAt: resetsAt };
    const denied = {
      ...claudeFull,
      usageLimits: { ...claudeFull.usageLimits!, windows: [], ordinaryUsageAllowed: false },
    };
    expect(apiCreditReturnCommand(onApi, origin, [denied, api], now)).toBeNull();
    expect(apiCreditReturnCommand(onApi, origin, [denied, api], Date.parse(resetsAt))).toEqual(
      back,
    );
    // A known reset time is waited for, however long the thread sits idle.
    const idleLong = {
      ...onApi,
      latestRunCompletedAt: DateTime.makeUnsafe(now - 2 * API_CREDIT_IDLE_RETURN_MS),
    };
    expect(apiCreditReturnCommand(idleLong, origin, [denied, api], now)).toBeNull();
  });

  it("goes back after an idle spell when the stop named no reset time", () => {
    const origin = apiCreditOrigin(onApi, moved)!;
    const unread = { ...claudeFull, usageLimits: undefined };
    const at = (ms: number) => ({ ...onApi, latestRunCompletedAt: DateTime.makeUnsafe(ms) });
    expect(
      apiCreditReturnCommand(at(now - API_CREDIT_IDLE_RETURN_MS + 1), origin, [unread, api], now),
    ).toBeNull();
    expect(
      apiCreditReturnCommand(at(now - API_CREDIT_IDLE_RETURN_MS), origin, [unread, api], now),
    ).toEqual(back);
  });

  it("goes back at once when the rule is off, and numbers a retried command", () => {
    const origin = apiCreditOrigin(onApi, moved)!;
    expect(
      apiCreditReturnCommand(onApi, origin, [claudeFull, api], now, { ruleOn: false }),
    ).toEqual(back);
    expect(
      apiCreditReturnCommand(onApi, origin, [claudeFull, api], now, { ruleOn: false, attempt: 2 }),
    ).toMatchObject({
      commandId: "limit-api-return:t1:r2:2",
    });
  });

  it("stays while the thread works, hosts background work, or has no subscription to return to", () => {
    const origin = apiCreditOrigin(onApi, moved)!;
    const off = { ruleOn: false };
    const stays = (
      thread: Parameters<typeof apiCreditReturnCommand>[0],
      providers: ReadonlyArray<ServerProvider> = [claudeOpen, api],
    ) => expect(apiCreditReturnCommand(thread, origin, providers, now, off)).toBeNull();
    stays({ ...onApi, activeRunId: RunId.make("r4") });
    stays({ ...onApi, activityRunStatus: "waiting" });
    stays({ ...onApi, pendingBackgroundTasks: [{ taskId: "bash-1", kind: "command" }] as never });
    stays({ ...onApi, settledOverride: "settled" });
    stays(onApi, [api]);
    stays(onApi, [{ ...claudeOpen, enabled: false }, api]);
    stays(onApi, [{ ...claudeOpen, auth: { status: "unauthenticated" } }, api]);
    // Studio's own pull request watch does not live in the provider session.
    expect(
      apiCreditReturnCommand(
        {
          ...onApi,
          pendingBackgroundTasks: [
            { taskId: "pull-request-watch:o/r#1", kind: "monitor" },
          ] as never,
        },
        origin,
        [claudeOpen, api],
        now,
        off,
      ),
    ).toEqual(back);
  });

  it("reads the reset time from the stopped run's usage-limit failure", () => {
    const error = (runId: string, cls: string, resetAt?: string) =>
      ({
        type: "error",
        runId,
        failure: { class: cls, message: "x", code: null, retryable: false, resetAt },
      }) as never;
    expect(
      limitResetAt(RunId.make("r1"), [
        error("r1", "usage_limit", resetsAt),
        error("r0", "usage_limit", "2027-01-01T00:00:00.000Z"),
      ]),
    ).toBe(resetsAt);
    expect(
      limitResetAt(RunId.make("r1"), [
        error("r1", "overloaded", resetsAt),
        error("r1", "usage_limit"),
      ]),
    ).toBeNull();
  });
});

describe("reachedLimitWindow", () => {
  const claude = provider(claudeId, "claudeAgent", now);
  it("keys a full window by its reset time and ignores windows that have reset", () => {
    expect(reachedLimitWindow(withUsage(claude, 100), now)).toBe(resetsAt);
    expect(reachedLimitWindow(withUsage(claude, 98), now)).toBeNull();
    expect(reachedLimitWindow(withUsage(claude, 100), Date.parse(resetsAt) + 1)).toBeNull();
    expect(reachedLimitWindow(undefined, now)).toBeNull();
    expect(reachedLimitWindow({ ...claude, usageLimits: undefined }, now)).toBeNull();
  });
  it("trusts an explicit denial of ordinary usage, not a stopped run", () => {
    const denied = {
      ...withUsage(claude, 60),
      usageLimits: { ...withUsage(claude, 60).usageLimits!, ordinaryUsageAllowed: false },
    };
    expect(reachedLimitWindow(denied, now)).toBe(resetsAt);
    const failedProbe = {
      ...withUsage(claude, 100),
      usageLimits: {
        ...withUsage(claude, 100).usageLimits!,
        unavailable: { reason: "probeFailed" as const },
      },
    };
    expect(reachedLimitWindow(failedProbe, now)).toBeNull();
  });
});

describe("sweep redeem path", () => {
  const limited = {
    ...idle,
    status: "failed" as const,
    lastErrorClass: "usage_limit" as const,
    projectId: null,
  };
  const settings = {
    ...DEFAULT_SERVER_SETTINGS,
    providerLimitRedeemResets: true,
    providerLimitAction: "ask" as const,
  };
  const banked = (usedPercent: number): ServerProvider => {
    const base = withUsage(provider(claudeId, "claudeAgent", now), usedPercent);
    return { ...base, usageLimits: { ...base.usageLimits!, resetCredits: { availableCount: 2 } } };
  };

  /** One worker over a stopped thread; `fresh` is what a live refresh of the account reports. */
  function harness(input: {
    cached: ServerProvider;
    fresh: ServerProvider;
    env?: Record<string, string>;
    /** What changed on the thread between the sweep's snapshot and the claim. */
    now?: Record<string, unknown>;
  }) {
    const state = {
      run: 0,
      consumed: 0,
      refreshed: 0,
      fresh: input.fresh,
      dispatched: [] as OrchestrationV2ServerCommand[],
    };
    const deps = Layer.mergeAll(
      Layer.mock(Projects.ProjectService)({
        getById: () => Effect.succeed(Option.some(legacyProject)),
      }),
      fallbackPolicyTestLayer(settings),
      Layer.mock(Providers.ProviderRegistry)({
        getProviders: Effect.succeed([input.cached]),
        refreshInstance: () => Effect.sync(() => ((state.refreshed += 1), [state.fresh])),
      }),
      Layer.mock(Instances.ProviderInstanceRegistry)({
        getInstance: () =>
          Effect.succeed({
            enabled: true,
            consumeResetCredit: () => Effect.sync(() => ((state.consumed += 1), "reset" as const)),
          } as never),
      }),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getShellSnapshot: () =>
          Effect.succeed({
            threads: [{ ...limited, latestRunId: RunId.make(`r${state.run}`) }],
          } as never),
        getThreadShell: () =>
          Effect.succeed({
            ...limited,
            latestRunId: RunId.make(`r${state.run}`),
            ...input.now,
          } as never),
        getThreadRecords: (threadId) =>
          Effect.fail(new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId })),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        dispatch: (command) =>
          Effect.sync(() => (state.dispatched.push(command), { sequence: 1, storedEvents: [] })),
      }),
    );
    const sweeps = Effect.gen(function* () {
      const sweep = yield* makeSweep;
      return { state, sweep };
    }).pipe(Effect.provide(deps), Effect.provideService(ProviderFallbackEnv, input.env ?? {}));
    return sweeps;
  }

  itEffect.effect("redeems once per real limit window, against a fresh read", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust("1 minute");
      const { state, sweep } = yield* harness({ cached: banked(100), fresh: banked(100) });
      yield* sweep();
      expect(state.refreshed).toBe(1);
      expect(state.consumed).toBe(1);
      expect(state.dispatched.map((c) => c.commandId)).toEqual(["limit-reset:t1:r0"]);
      // The continuation stopped on the same window again: no second reset.
      state.run = 1;
      yield* TestClock.adjust("31 seconds");
      yield* sweep();
      expect(state.refreshed).toBe(2);
      expect(state.consumed).toBe(1);
      expect(state.dispatched).toHaveLength(1);
    }),
  );

  itEffect.effect("never redeems while usage limits are simulated", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust("1 minute");
      const { state, sweep } = yield* harness({
        cached: banked(100),
        fresh: banked(100),
        env: { STUDIO_SIMULATE_USAGE_LIMIT: "claudeAgent" },
      });
      yield* sweep();
      expect(state.refreshed).toBe(0);
      expect(state.consumed).toBe(0);
      expect(state.dispatched).toEqual([]);
    }),
  );

  itEffect.effect("never redeems on a usage read that failed and kept the limits it had", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust("1 minute");
      // A new snapshot time, the old usage read: what a timed-out usage call publishes.
      const kept = {
        ...banked(100),
        usageLimits: { ...banked(100).usageLimits!, checkedAt: "1970-01-01T00:00:10.000Z" },
      };
      const { state, sweep } = yield* harness({ cached: banked(100), fresh: kept });
      for (let i = 0; i < 5; i++) {
        yield* sweep();
        yield* TestClock.adjust("31 seconds");
      }
      // Tried on three sweeps, then the stop is left alone.
      expect(state.refreshed).toBe(3);
      expect(state.consumed).toBe(0);
      expect(state.dispatched).toEqual([]);
    }),
  );

  itEffect.effect("keeps the reset step open when the read came back without the reset count", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust("1 minute");
      // The usage read worked, the banked-reset lookup did not.
      const { state, sweep } = yield* harness({
        cached: banked(100),
        fresh: withUsage(provider(claudeId, "claudeAgent", now), 100),
      });
      yield* sweep();
      expect(state.consumed).toBe(0);
      state.fresh = banked(100);
      yield* TestClock.adjust("31 seconds");
      yield* sweep();
      expect(state.consumed).toBe(1);
      expect(state.dispatched.map((c) => c.commandId)).toEqual(["limit-reset:t1:r0"]);
    }),
  );

  itEffect.effect("never redeems for a thread settled since the sweep's snapshot", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust("1 minute");
      const { state, sweep } = yield* harness({
        cached: banked(100),
        fresh: banked(100),
        now: { settledOverride: "settled" },
      });
      yield* sweep();
      expect(state.consumed).toBe(0);
      expect(state.dispatched).toEqual([]);
    }),
  );

  itEffect.effect("never redeems when the account's fresh read shows no limit", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust("1 minute");
      const { state, sweep } = yield* harness({ cached: banked(100), fresh: banked(2) });
      yield* sweep();
      expect(state.refreshed).toBe(1);
      expect(state.consumed).toBe(0);
      expect(state.dispatched).toEqual([]);
    }),
  );
});

describe("sweep API credit path", () => {
  const limited = {
    ...idle,
    status: "failed" as const,
    lastErrorClass: "usage_limit" as const,
    usageLimitResetAt: resetsAt,
    projectId: null,
  };
  const ruleOn = {
    ...DEFAULT_SERVER_SETTINGS,
    providerLimitUseApiCredits: true,
    providerLimitAction: "ask" as const,
  };
  const claude = (usedPercent: number) =>
    withUsage(provider(claudeId, "claudeAgent", now), usedPercent);
  const api: ServerProvider = {
    ...withUsage(provider(apiId, "claudeAgent", now), 0),
    models: [{ slug: "opus", name: "Opus", isCustom: false, isDefault: true, capabilities: null }],
    auth: { status: "authenticated", type: "apiKey", apiKeyBilling: true },
    usageLimits: undefined,
  };
  const onApi = {
    ...idle,
    projectId: null,
    providerInstanceId: apiId,
    modelSelection: { instanceId: apiId, model: "opus" },
    latestRunId: RunId.make("r2"),
  };
  const stopped = {
    id: "r1",
    ordinal: 1,
    providerInstanceId: claudeId,
    modelSelection: { instanceId: claudeId, model: "opus" },
    userMessageId: "m1",
  };
  const moved = [
    stopped,
    {
      id: "r2",
      ordinal: 2,
      providerInstanceId: apiId,
      modelSelection: { instanceId: apiId, model: "opus" },
      userMessageId: "limit-api:t1:r1",
    },
  ];
  const returned = {
    type: "thread.model-selection.set",
    commandId: "limit-api-return:t1:r2",
    threadId: "t1",
    modelSelection: { instanceId: claudeId, model: "opus" },
  };

  function harness(input: {
    cached: ServerProvider;
    fresh: ServerProvider;
    settings?: typeof ruleOn;
    thread?: Record<string, unknown>;
    /** Every unsettled thread, when the sweep should see more than one. */
    threads?: ReadonlyArray<Record<string, unknown>>;
    /** What changed on the thread between the sweep's snapshot and the dispatch. */
    now?: Record<string, unknown>;
    runs?: ReadonlyArray<unknown>;
    turnItems?: ReadonlyArray<unknown>;
    env?: Record<string, string>;
  }) {
    const all = input.threads ?? [input.thread ?? limited];
    const state = {
      refreshed: 0,
      recordsRead: 0,
      failDispatch: false,
      failWith: undefined as unknown,
      /** What a usage read taken now reports; undefined for a read that failed. */
      fresh: input.fresh as ServerProvider | undefined,
      attempted: [] as string[],
      dispatched: [] as OrchestrationV2ServerCommand[],
    };
    const deps = Layer.mergeAll(
      Layer.mock(Projects.ProjectService)({
        getById: () => Effect.succeed(Option.some(legacyProject)),
      }),
      fallbackPolicyTestLayer(input.settings ?? ruleOn),
      Layer.mock(Providers.ProviderRegistry)({
        getProviders: Effect.succeed([input.cached, api]),
      }),
      Layer.mock(Instances.ProviderInstanceRegistry)({
        getInstance: () =>
          Effect.succeed({
            enabled: true,
            readUsageLimitsNow: Effect.sync(
              () => ((state.refreshed += 1), state.fresh?.usageLimits),
            ),
          } as never),
      }),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getShellSnapshot: () => Effect.succeed({ threads: all } as never),
        getThreadShell: (id) =>
          Effect.succeed({ ...all.find((thread) => thread.id === id), ...input.now } as never),
        getThreadRecords: () =>
          Effect.sync(() => {
            state.recordsRead += 1;
            return {
              runs: input.runs ?? [stopped],
              providerThreads: [{ appThreadId: "t1", nativeThreadRef: "native" }],
              turnItems: input.turnItems ?? [],
            };
          }) as never,
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        dispatch: (command) =>
          Effect.suspend(() => {
            state.attempted.push(command.commandId);
            if (state.failWith !== undefined) return Effect.fail(state.failWith as never);
            if (state.failDispatch) return Effect.die(new Error("rejected"));
            state.dispatched.push(command);
            return Effect.succeed({ sequence: 1, storedEvents: [] });
          }),
      }),
    );
    return Effect.gen(function* () {
      const sweep = yield* makeSweep;
      return { state, sweep };
    }).pipe(Effect.provide(deps), Effect.provideService(ProviderFallbackEnv, input.env ?? {}));
  }

  itEffect.effect("continues on the API-key instance once, against a usage read at the limit", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust("1 minute");
      const { state, sweep } = yield* harness({ cached: claude(100), fresh: claude(100) });
      yield* sweep();
      expect(state.refreshed).toBe(1);
      expect(state.dispatched).toMatchObject([
        {
          commandId: "limit-api:t1:r1",
          manualContinuationOfRunId: "r1",
          modelSelection: { instanceId: apiId, model: "opus" },
        },
      ]);
      yield* TestClock.adjust("31 seconds");
      yield* sweep();
      expect(state.refreshed).toBe(1);
      expect(state.dispatched).toHaveLength(1);
    }),
  );

  itEffect.effect("moves an out-of-credit API thread to the next key without a usage read", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust("1 minute");
      const second = { ...api, instanceId: ProviderInstanceId.make("claudeApi2") };
      const outOfCredits = {
        ...onApi,
        status: "failed" as const,
        lastErrorClass: "usage_limit" as const,
        latestRunId: RunId.make("r1"),
        usageLimitResetAt: null,
        latestRunCompletedAt: DateTime.makeUnsafe(0),
        lastError:
          "Credit balance too low · Add funds: https://platform.claude.com/settings/billing",
      };
      const { state, sweep } = yield* harness({
        cached: second,
        fresh: second,
        thread: outOfCredits,
        runs: [{ ...stopped, providerInstanceId: apiId }],
      });
      yield* sweep();
      expect(state.refreshed).toBe(0);
      expect(state.dispatched).toMatchObject([
        {
          commandId: "limit-api:t1:r1",
          manualContinuationOfRunId: "r1",
          modelSelection: { instanceId: second.instanceId, model: "opus" },
        },
      ]);
    }),
  );

  itEffect.effect("spends nothing when the fresh read shows no limit", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust("1 minute");
      const { state, sweep } = yield* harness({ cached: claude(100), fresh: claude(3) });
      yield* sweep();
      expect(state.refreshed).toBe(1);
      expect(state.dispatched).toEqual([]);
    }),
  );

  // What the stop itself publishes: a denial with no windows, under the time of the stop.
  const denial: ServerProvider = {
    ...claude(100),
    usageLimits: {
      checkedAt: "1970-01-01T00:00:10.000Z",
      windows: [],
      ordinaryUsageAllowed: false,
      nativeDenialRequiresFullRead: true,
      nativeDenialObservedAt: "1970-01-01T00:00:10.000Z",
    },
  };

  itEffect.effect(
    "fires on a real stop, where the published limits keep the denial under its old time",
    () =>
      Effect.gen(function* () {
        yield* TestClock.adjust("1 minute");
        const read = { ...claude(100).usageLimits!, checkedAt: "1970-01-01T00:01:00.000Z" };
        // The premise: a successful read that still shows the limit leaves the denial published as it was.
        expect(
          resolveUsageLimitsAfterProbe({
            driver: claude(100).driver,
            published: denial.usageLimits,
            probed: read,
          }),
        ).toBe(denial.usageLimits);
        const { state, sweep } = yield* harness({
          cached: denial,
          fresh: { ...claude(100), usageLimits: read },
        });
        yield* sweep();
        expect(state.dispatched).toMatchObject([
          { commandId: "limit-api:t1:r1", modelSelection: { instanceId: apiId } },
        ]);
      }),
  );

  itEffect.effect(
    "spends nothing when the read shows room although a denial is still published",
    () =>
      Effect.gen(function* () {
        yield* TestClock.adjust("1 minute");
        const { state, sweep } = yield* harness({ cached: denial, fresh: claude(40) });
        yield* sweep();
        expect(state.refreshed).toBe(1);
        expect(state.dispatched).toEqual([]);
      }),
  );

  itEffect.effect(
    "spends nothing on a usage read that failed, and tries the read again a few times",
    () =>
      Effect.gen(function* () {
        yield* TestClock.adjust("1 minute");
        // The read fails; the registry goes on publishing the limit it had.
        const { state, sweep } = yield* harness({ cached: claude(100), fresh: claude(100) });
        state.fresh = undefined;
        for (let i = 0; i < 5; i++) {
          yield* sweep();
          yield* TestClock.adjust("31 seconds");
        }
        expect(state.refreshed).toBe(3);
        expect(state.dispatched).toEqual([]);
        const failed = yield* harness({
          cached: claude(100),
          fresh: {
            ...claude(100),
            usageLimits: { ...claude(100).usageLimits!, unavailable: { reason: "probeFailed" } },
          },
        });
        yield* failed.sweep();
        expect(failed.state.dispatched).toEqual([]);
        // The read comes back on the next sweep: the stop is still served.
        failed.state.fresh = claude(100);
        yield* TestClock.adjust("31 seconds");
        yield* failed.sweep();
        expect(failed.state.dispatched).toMatchObject([{ commandId: "limit-api:t1:r1" }]);
      }),
  );

  itEffect.effect("reads the account once per sweep for all its stopped threads", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust("1 minute");
      const second = { ...limited, id: ThreadId.make("t2") };
      const { state, sweep } = yield* harness({
        cached: claude(100),
        fresh: claude(100),
        threads: [limited, second],
      });
      yield* sweep();
      expect(state.refreshed).toBe(1);
      expect(state.dispatched.map((command) => command.commandId)).toEqual([
        "limit-api:t1:r1",
        "limit-api:t2:r1",
      ]);
    }),
  );

  itEffect.effect(
    "spends nothing for a thread snoozed, settled or moved since the sweep's snapshot",
    () =>
      Effect.gen(function* () {
        yield* TestClock.adjust("1 minute");
        for (const now of [
          { snoozedUntil: DateTime.makeUnsafe("2026-10-09T13:00:00.000Z") },
          { settledOverride: "settled" },
          { modelSelection: { instanceId: claudeId, model: "haiku" } },
          { status: "running", activeRunId: "r9" },
        ]) {
          const { state, sweep } = yield* harness({ cached: claude(100), fresh: claude(100), now });
          yield* sweep();
          expect(state.refreshed).toBe(1);
          expect(state.dispatched).toEqual([]);
        }
      }),
  );

  itEffect.effect("spends nothing for a stop that happened on another instance", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust("1 minute");
      // The key instance's own run failed with a rate limit, then the thread was moved to the subscription.
      const runs = [
        ...moved.slice(0, 1),
        { ...moved[1]!, id: "r1x" },
        { ...moved[1]!, id: "r1", ordinal: 3 },
      ];
      const { state, sweep } = yield* harness({
        cached: claude(100),
        fresh: claude(100),
        runs: runs.slice(2),
      });
      yield* sweep();
      expect(state.refreshed).toBe(0);
      expect(state.dispatched).toEqual([]);
    }),
  );

  itEffect.effect("spends nothing while usage limits are simulated", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust("1 minute");
      const { state, sweep } = yield* harness({
        cached: claude(100),
        fresh: claude(100),
        env: { STUDIO_SIMULATE_USAGE_LIMIT: "claudeAgent" },
      });
      yield* sweep();
      expect(state.refreshed).toBe(0);
      expect(state.dispatched).toEqual([]);
    }),
  );

  itEffect.effect("moves the thread back once the subscription has usage again", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust("1 minute");
      const { state, sweep } = yield* harness({
        cached: claude(5),
        fresh: claude(5),
        thread: onApi,
        runs: moved,
      });
      yield* sweep();
      yield* TestClock.adjust("31 seconds");
      yield* sweep();
      // Runs once, the stopped run's items once, the queue once; then the move is the person's to undo.
      expect(state.recordsRead).toBe(3);
      expect(state.dispatched).toEqual([returned]);
    }),
  );

  itEffect.effect("keeps a limited subscription's thread on API credits while the rule is on", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust("1 minute");
      const turnItems = [
        {
          type: "error",
          runId: "r1",
          failure: {
            class: "usage_limit",
            message: "x",
            code: null,
            retryable: false,
            resetAt: resetsAt,
          },
        },
      ];
      const { state, sweep } = yield* harness({
        cached: claude(100),
        fresh: claude(100),
        thread: onApi,
        runs: moved,
        turnItems,
      });
      yield* sweep();
      expect(state.dispatched).toEqual([]);
    }),
  );

  itEffect.effect("moves the thread back when the rule is turned off, with no rule left on", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust("1 minute");
      const { state, sweep } = yield* harness({
        cached: claude(100),
        fresh: claude(100),
        settings: { ...ruleOn, providerLimitUseApiCredits: false },
        thread: onApi,
        runs: moved,
      });
      yield* sweep();
      expect(state.dispatched).toEqual([returned]);
    }),
  );

  itEffect.effect(
    "retries a rejected way back under a new command id, a bounded number of times",
    () =>
      Effect.gen(function* () {
        yield* TestClock.adjust("1 minute");
        const { state, sweep } = yield* harness({
          cached: claude(5),
          fresh: claude(5),
          thread: onApi,
          runs: moved,
        });
        state.failDispatch = true;
        yield* sweep();
        yield* TestClock.adjust("31 seconds");
        yield* sweep();
        expect(state.attempted).toEqual(["limit-api-return:t1:r2", "limit-api-return:t1:r2:1"]);
        state.failDispatch = false;
        yield* TestClock.adjust("31 seconds");
        yield* sweep();
        expect(state.dispatched).toMatchObject([{ commandId: "limit-api-return:t1:r2:2" }]);
        yield* TestClock.adjust("31 seconds");
        yield* sweep();
        expect(state.attempted).toHaveLength(3);
        // An id the orchestrator rejected before a restart is skipped without using up a try.
        const replayed = yield* harness({
          cached: claude(5),
          fresh: claude(5),
          thread: onApi,
          runs: moved,
        });
        replayed.state.failWith = { _tag: "OrchestratorCommandPreviouslyRejectedError" };
        for (let i = 0; i < 7; i++) {
          yield* TestClock.adjust("31 seconds");
          yield* replayed.sweep();
        }
        replayed.state.failWith = undefined;
        yield* TestClock.adjust("31 seconds");
        yield* replayed.sweep();
        expect(replayed.state.dispatched).toMatchObject([
          { commandId: "limit-api-return:t1:r2:7" },
        ]);
        // A way back that keeps failing rests after five tries, then tries again.
        const failing = yield* harness({
          cached: claude(5),
          fresh: claude(5),
          thread: onApi,
          runs: moved,
        });
        failing.state.failDispatch = true;
        for (let i = 0; i < 7; i++) {
          yield* TestClock.adjust("31 seconds");
          yield* failing.sweep();
        }
        expect(failing.state.attempted).toHaveLength(5);
        yield* TestClock.adjust("31 minutes");
        yield* failing.sweep();
        expect(failing.state.attempted).toHaveLength(6);
      }),
  );

  itEffect.effect("leaves a thread on the key instance while a message is queued for it", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust("1 minute");
      const queued = { ...moved[1]!, id: "q3", ordinal: 3, userMessageId: "m3", status: "queued" };
      const { state, sweep } = yield* harness({
        cached: claude(5),
        fresh: claude(5),
        thread: onApi,
        runs: [...moved, queued],
      });
      yield* sweep();
      expect(state.attempted).toEqual([]);
    }),
  );

  itEffect.effect(
    "leaves a thread on the key instance when a turn started since the snapshot",
    () =>
      Effect.gen(function* () {
        yield* TestClock.adjust("1 minute");
        const { state, sweep } = yield* harness({
          cached: claude(5),
          fresh: claude(5),
          thread: onApi,
          runs: moved,
          now: { activeRunId: "r3", latestRunId: "r3" },
        });
        yield* sweep();
        expect(state.attempted).toEqual([]);
      }),
  );
});

describe("limitFallbackReturnCommand", () => {
  const onCodex = {
    ...idle,
    providerInstanceId: codexId,
    modelSelection: { instanceId: codexId, model: "gpt-6" },
    latestRunId: RunId.make("r3"),
  };
  const run = (id: string, ordinal: number, instanceId: ProviderInstanceId, message: string) => ({
    id: RunId.make(id),
    ordinal,
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: instanceId === claudeId ? "opus" : "gpt-6" },
    userMessageId: message as never,
  });
  const moved = [
    run("r1", 1, claudeId, "m1"),
    run("r2", 2, codexId, `${LIMIT_FALLBACK_MESSAGE_PREFIX}t1:r1`),
    run("r3", 3, codexId, "m3"),
  ];
  const codex = withUsage(provider(codexId, "codex", now), 30);

  it("returns a thread the switch rule moved once its provider has room", () => {
    const origin = apiCreditOrigin(onCodex, moved, LIMIT_FALLBACK_MESSAGE_PREFIX)!;
    expect(origin).toMatchObject({ stoppedRunId: "r1", continuedByRunId: "r2" });
    const open = withUsage(provider(claudeId, "claudeAgent", now), 20);
    const spent = withUsage(provider(claudeId, "claudeAgent", now), 100);
    expect(limitFallbackReturnCommand(onCodex, origin, [open, codex], now)).toEqual({
      type: "thread.model-selection.set",
      commandId: "limit-return:t1:r2",
      threadId: "t1",
      modelSelection: { instanceId: claudeId, model: "opus" },
    });
    // Still spent: it stays on the fallback until the read shows room or the reset passes.
    expect(limitFallbackReturnCommand(onCodex, origin, [spent, codex], now)).toBeNull();
    expect(
      limitFallbackReturnCommand(
        onCodex,
        { ...origin, resetAt: resetsAt },
        [spent, codex],
        Date.parse(resetsAt),
      ),
    ).not.toBeNull();
    // Never mid-turn.
    expect(
      limitFallbackReturnCommand(
        { ...onCodex, activeRunId: RunId.make("r4") },
        origin,
        [open, codex],
        now,
      ),
    ).toBeNull();
  });

  it("leaves a thread a person moved where they put it", () => {
    expect(
      apiCreditOrigin(
        onCodex,
        [run("r1", 1, claudeId, "m1"), run("r2", 2, codexId, "m2")],
        LIMIT_FALLBACK_MESSAGE_PREFIX,
      ),
    ).toBeNull();
  });
});

describe("sweep switch path with a stale fallback read", () => {
  // The coordinator stopped on a weekly limit four days from its reset. Codex
  // is signed in with room, but this idle host last read it 20 minutes ago.
  const stoppedAt = Date.parse("2026-10-17T04:42:26.000Z");
  const limited = {
    ...idle,
    status: "failed" as const,
    lastErrorClass: "usage_limit" as const,
    projectId: null,
    usageLimitResetAt: "2026-10-21T02:00:00.000Z",
    latestRunCompletedAt: DateTime.makeUnsafe(stoppedAt),
  };
  const settings = {
    ...DEFAULT_SERVER_SETTINGS,
    providerLimitAction: "switch" as const,
    providerLimitFallbackModelSelection: null,
  };
  const codexAt = (at: number) => {
    const codex = withUsage(provider(codexId, "codex", at), 45);
    const windows = codex.usageLimits!.windows.map((window) => ({
      ...window,
      resetsAt: "2026-10-22T06:15:00.000Z",
    }));
    return { ...codex, usageLimits: { ...codex.usageLimits!, windows } };
  };

  function harness(fresh: (at: number) => ServerProvider) {
    const state = {
      providers: [
        withUsage(provider(claudeId, "claudeAgent", stoppedAt), 100),
        codexAt(stoppedAt - 20 * 60_000),
      ],
      refreshed: [] as string[],
      dispatched: [] as OrchestrationV2ServerCommand[],
    };
    const deps = Layer.mergeAll(
      Layer.mock(Projects.ProjectService)({
        getById: () => Effect.succeed(Option.some(legacyProject)),
      }),
      fallbackPolicyTestLayer(settings),
      Layer.mock(Providers.ProviderRegistry)({
        getProviders: Effect.sync(() => state.providers),
        refreshInstance: (id) =>
          Effect.gen(function* () {
            state.refreshed.push(id);
            const at = DateTime.toEpochMillis(yield* DateTime.now);
            state.providers = state.providers.map((entry) =>
              entry.instanceId === id ? fresh(at) : entry,
            );
            return state.providers;
          }),
      }),
      Layer.mock(Instances.ProviderInstanceRegistry)({
        getInstance: () => Effect.succeed(undefined),
      }),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getShellSnapshot: () => Effect.succeed({ threads: [limited] } as never),
        getThreadShell: () => Effect.succeed(limited as never),
        getThreadRecords: (threadId) =>
          Effect.fail(new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId })),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        dispatch: (command) =>
          Effect.sync(() => (state.dispatched.push(command), { sequence: 1, storedEvents: [] })),
      }),
    );
    return Effect.gen(function* () {
      yield* TestClock.setTime(stoppedAt + 30_000);
      const sweep = yield* makeSweep;
      return { state, sweep };
    }).pipe(Effect.provide(deps), Effect.provideService(ProviderFallbackEnv, {}));
  }

  itEffect.effect("reads the signed-in fallback and moves the stopped thread to it", () =>
    Effect.gen(function* () {
      const { state, sweep } = yield* harness(codexAt);
      yield* sweep();
      expect(state.refreshed).toEqual([codexId]);
      expect(state.dispatched).toHaveLength(1);
      expect(state.dispatched[0]).toMatchObject({
        type: "message.dispatch",
        manualContinuationOfRunId: limited.latestRunId,
        modelSelection: { instanceId: codexId, model: "gpt-6" },
      });
    }),
  );

  itEffect.effect("reads a fallback that stays unusable once per read lifetime", () =>
    Effect.gen(function* () {
      const { state, sweep } = yield* harness((at) => codexAt(at - 20 * 60_000));
      yield* sweep();
      yield* TestClock.adjust("31 seconds");
      yield* sweep();
      expect(state.refreshed).toEqual([codexId]);
      expect(state.dispatched).toEqual([]);
      yield* TestClock.adjust("5 minutes");
      yield* sweep();
      expect(state.refreshed).toEqual([codexId, codexId]);
    }),
  );
});

describe("a stopped worker and its coordinator", () => {
  const copilotId = ProviderInstanceId.make("copilot");
  // Copilot and the other agents behind an ACP bridge report no usage at all.
  const { usageLimits: _none, ...copilotBase } = provider(copilotId, "acpRegistry", now);
  const copilot: ServerProvider = {
    ...copilotBase,
    models: [
      { slug: "claude-opus-5.5", name: "Claude Opus 5.5", isCustom: true, capabilities: null },
    ],
  };
  const claudeSpent = withUsage(provider(claudeId, "claudeAgent", now), 100);
  const coordinatorId = ThreadId.make("coordinator");
  const worker = {
    ...idle,
    status: "failed" as const,
    lastErrorClass: "usage_limit" as const,
    projectId: legacyProject.id,
  };
  const coordinator = {
    ...idle,
    id: coordinatorId,
    providerInstanceId: copilotId,
    modelSelection: { instanceId: copilotId, model: "claude-opus-5.5" },
    projectId: legacyProject.id,
  };
  const switchRule = { ...rule, providerLimitFallbackModelSelection: null };

  it("continues on the coordinator's model, which needs no usage read", () => {
    expect(
      providerLimitStep(worker, [claudeSpent, copilot], switchRule, now, { resetAttempted: false }),
    ).toBeNull();
    expect(
      providerLimitStep(worker, [claudeSpent, copilot], switchRule, now, {
        resetAttempted: false,
        proven: coordinator.modelSelection,
      }),
    ).toMatchObject({
      type: "switch",
      command: {
        type: "message.dispatch",
        manualContinuationOfRunId: "r1",
        modelSelection: { instanceId: copilotId, model: "claude-opus-5.5" },
      },
    });
  });

  function harness(coordinatorShell: Record<string, unknown> | null) {
    const dispatched: OrchestrationV2ServerCommand[] = [];
    const project = {
      ...legacyProject,
      workspaceSettings: {
        ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
        coordinatorThreadId: coordinatorId,
      },
    };
    const deps = Layer.mergeAll(
      Layer.mock(Projects.ProjectService)({ getById: () => Effect.succeed(Option.some(project)) }),
      fallbackPolicyTestLayer({ ...DEFAULT_SERVER_SETTINGS, providerLimitAction: "switch" }),
      Layer.mock(Providers.ProviderRegistry)({
        getProviders: Effect.succeed([claudeSpent, copilot]),
      }),
      Layer.mock(Instances.ProviderInstanceRegistry)({
        getInstance: () => Effect.succeed(undefined),
      }),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getShellSnapshot: () => Effect.succeed({ threads: [worker] } as never),
        getThreadShell: (threadId) =>
          Effect.succeed((threadId === coordinatorId ? coordinatorShell : worker) as never),
        getThreadRecords: (threadId) =>
          Effect.fail(new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId })),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        dispatch: (command) =>
          Effect.sync(() => (dispatched.push(command), { sequence: 1, storedEvents: [] })),
      }),
    );
    return Effect.gen(function* () {
      const sweep = yield* makeSweep;
      return { dispatched, sweep };
    }).pipe(Effect.provide(deps), Effect.provideService(ProviderFallbackEnv, {}));
  }

  itEffect.effect("moves a worker stopped on the limit to where its coordinator runs", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust("1 minute");
      const { dispatched, sweep } = yield* harness(coordinator);
      yield* sweep();
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]).toMatchObject({
        type: "message.dispatch",
        threadId: worker.id,
        manualContinuationOfRunId: "r1",
        modelSelection: { instanceId: copilotId, model: "claude-opus-5.5" },
      });
    }),
  );

  itEffect.effect("leaves the worker stopped when the coordinator stopped on the limit too", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust("1 minute");
      const { dispatched, sweep } = yield* harness({
        ...coordinator,
        status: "failed",
        lastErrorClass: "usage_limit",
      });
      yield* sweep();
      expect(dispatched).toEqual([]);
    }),
  );
});
