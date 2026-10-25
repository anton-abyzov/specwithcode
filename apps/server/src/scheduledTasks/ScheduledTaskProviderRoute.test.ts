import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { provider } from "../studio/fixtures.ts";
import {
  deferUntil,
  fallbackOrigin,
  routineRoute,
  type RouteRun,
} from "./ScheduledTaskProviderRoute.ts";

const NOW = Date.parse("2026-10-21T11:03:00.000Z");
const MINUTE = 60_000;

describe("deferUntil", () => {
  it("waits 15 minutes without a known reset", () => {
    expect(deferUntil(NOW, [null])).toBe(NOW + 15 * MINUTE);
  });
  it("aims at a reset sooner than 15 minutes, but never under 5", () => {
    expect(deferUntil(NOW, [NOW + 9 * MINUTE])).toBe(NOW + 9 * MINUTE);
    expect(deferUntil(NOW, [NOW + 1 * MINUTE])).toBe(NOW + 5 * MINUTE);
  });
  it("ignores resets already past and never waits past 15 minutes for a later one", () => {
    expect(deferUntil(NOW, [NOW - MINUTE, NOW + 4 * 60 * MINUTE])).toBe(NOW + 15 * MINUTE);
  });
});

const run = (over: Partial<RouteRun> & Pick<RouteRun, "runId" | "instanceId">): RouteRun => ({
  model: "claude-opus-5.5",
  status: "failed",
  completedAtMs: NOW - 60 * MINUTE,
  userMessageId: "user-message",
  openFailureCode: null,
  openFailureMessage: null,
  limitStop: false,
  limitResetAtMs: null,
  ...over,
});

describe("fallbackOrigin", () => {
  const stopped = run({
    runId: "run:29",
    instanceId: "claudeAgent",
    model: "claude-opus-5-5",
    limitStop: true,
    limitResetAtMs: NOW - 5 * MINUTE,
  });

  it("finds the limit stop behind a later hop, past runs on the fallback since", () => {
    const origin = fallbackOrigin("thread-1", "acpRegistry_copilot", [
      run({ runId: "run:31", instanceId: "acpRegistry_copilot", userMessageId: "scheduled" }),
      run({
        runId: "run:30",
        instanceId: "acpRegistry_copilot",
        userMessageId: "limit-fallback:thread-1:hop-1:run:29",
      }),
      stopped,
    ]);
    expect(origin).toEqual({
      selection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
      stoppedAtMs: stopped.completedAtMs,
      resetAtMs: stopped.limitResetAtMs,
    });
  });

  it("is null for a thread the provider fallback moved off a provider that could not open", () => {
    const failed = run({
      runId: "run:29",
      instanceId: "acpRegistry_copilot",
      openFailureCode: "provider_unavailable",
    });
    expect(
      fallbackOrigin("thread-1", "codex", [
        run({
          runId: "run:30",
          instanceId: "codex",
          userMessageId: "provider-fallback:thread-1:run:29",
        }),
        failed,
      ]),
    ).toBeNull();
  });

  it("is null for a thread a person moved, or one that ran elsewhere since", () => {
    expect(
      fallbackOrigin("thread-1", "acpRegistry_copilot", [
        run({ runId: "run:30", instanceId: "acpRegistry_copilot" }),
        stopped,
      ]),
    ).toBeNull();
    expect(
      fallbackOrigin("thread-1", "acpRegistry_copilot", [
        run({ runId: "run:32", instanceId: "codex" }),
        run({
          runId: "run:30",
          instanceId: "acpRegistry_copilot",
          userMessageId: "limit-fallback:thread-1:run:29",
        }),
        stopped,
      ]),
    ).toBeNull();
  });
});

describe("routineRoute on a same-driver switch", () => {
  const opus = "claude-opus-5-5";
  const used = (id: string, usedPercent: number): ServerProvider => {
    const base = provider(id, "claudeAgent", NOW);
    return {
      ...base,
      models: [{ slug: opus, name: opus, isCustom: false, isDefault: true, capabilities: null }],
      usageLimits: {
        ...base.usageLimits!,
        windows: [
          {
            id: "five_hour",
            kind: "session",
            label: "Session",
            usedPercent,
            resetsAt: "2026-10-21T15:00:00.000Z",
          },
        ],
      },
    };
  };
  it("fires on the second account with the routine's effort", () => {
    const high = [{ id: "effort", value: "high" }];
    const providers = [used("claudeAgent", 100), used("claudeAgent-2", 10)];
    const route = routineRoute({
      providers,
      candidates: providers,
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: opus,
        options: high,
      },
      thread: null,
      threadId: null,
      runs: [],
      openFailures: new Map(),
      rule: {
        ...DEFAULT_SERVER_SETTINGS,
        providerLimitAction: "switch",
        providerLimitSwitchAtPercent: 90,
      },
      nowMs: NOW,
    });
    expect(route.type === "fire" ? route.modelSelection : route).toEqual({
      instanceId: "claudeAgent-2",
      model: opus,
      options: high,
    });
  });
});
