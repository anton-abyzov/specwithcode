/**
 * The November 17, 2026 incident: the project default was Claude Fable 5.2,
 * the fallback list [Claude Opus 5.5 on Claude, GPT-6.1 Sol on Codex]. Fable's
 * own weekly window was spent while the Claude account still had room for
 * Opus; Codex was full and does not list Sol; Copilot was full; Copilot
 * Enterprise lists Opus and reports no usage; Muse was at 14%. Every path
 * landed on Muse Wonder, a Review-track model.
 */
import * as DateTime from "effect/DateTime";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type ProviderFallbackRule,
  resolveCoordinatorTurnSelection,
  resolveProviderFallback,
  resolveWorkerLaunchSelection,
} from "./providerFallback.ts";
import { limitStopIsAccountWide, modelLine, reviewOnlyModel } from "./regularTrack.ts";

const now = Date.parse("2026-11-17T04:58:00.000Z");
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const later = iso(now + 3 * 60 * 60_000);
const nextWeek = iso(now + 5 * 24 * 60 * 60_000);
const id = ProviderInstanceId.make;
const COPILOT_ICON =
  "https://cdn.agentclientprotocol.com/registry/v1/latest/github-copilot-cli.svg";

function provider(input: {
  readonly id: string;
  readonly driver: string;
  readonly models: ReadonlyArray<string>;
  readonly windows?: ReadonlyArray<ServerProviderUsageWindow>;
  readonly iconUrl?: string;
}): ServerProvider {
  return {
    instanceId: id(input.id),
    driver: ProviderDriverKind.make(input.driver),
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: iso(now),
    ...(input.iconUrl === undefined ? {} : { iconUrl: input.iconUrl }),
    version: null,
    models: input.models.map((slug, index) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: null,
      ...(index === 0 ? { isDefault: true } : {}),
    })),
    slashCommands: [],
    skills: [],
    ...(input.windows === undefined
      ? {}
      : { usageLimits: { checkedAt: iso(now), windows: [...input.windows] } }),
  };
}

const session = (used: number): ServerProviderUsageWindow => ({
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent: used,
  resetsAt: later,
});
const fableWeekly: ServerProviderUsageWindow = {
  id: "seven_day_fable",
  kind: "weekly",
  label: "Weekly · Fable",
  usedPercent: 100,
  resetsAt: nextWeek,
  modelScope: "fable",
};

const FABLE = "claude-fable-5-2";
const OPUS = "claude-opus-5-5";
// Claude: Fable's own weekly is spent, the account still has room for Opus.
const claude = provider({
  id: "claudeAgent",
  driver: "claudeAgent",
  models: [FABLE, OPUS, "claude-sonnet-5-5"],
  windows: [session(40), fableWeekly],
});
// The same account after an account-wide stop: its session is spent too.
const claudeSpent = { ...claude, usageLimits: { ...claude.usageLimits!, windows: [session(100)] } };
const codex = provider({
  id: "codex",
  driver: "codex",
  models: ["gpt-6-astra"],
  windows: [session(100)],
});
const copilot = provider({
  id: "copilot",
  driver: "acpRegistry",
  models: ["claude-opus-5.5"],
  windows: [session(100)],
  iconUrl: COPILOT_ICON,
});
const copilotEnterprise = provider({
  id: "acpRegistry_copilot",
  driver: "acpRegistry",
  models: ["claude-opus-5.5"],
  iconUrl: COPILOT_ICON,
});
const muse = provider({
  id: "muse",
  driver: "muse",
  models: ["muse-wonder-1.0", "muse-wonder-full-1.0"],
  windows: [session(14)],
});
const providers = [claude, codex, copilot, copilotEnterprise, muse];

const fable = { instanceId: id("claudeAgent"), model: FABLE };
const opus = { instanceId: id("claudeAgent"), model: OPUS };
const opusOnEnterprise = { instanceId: id("acpRegistry_copilot"), model: "claude-opus-5.5" };
const museWonder = { instanceId: id("muse"), model: "muse-wonder-1.0" };
const rule: ProviderFallbackRule = {
  providerLimitAction: "switch",
  providerLimitFallbackModelSelection: null,
  providerLimitFallbackModels: [opus, { instanceId: id("codex"), model: "gpt-6.1-sol" }],
  providerLimitSwitchAtPercent: null,
  defaultModelSelection: fable,
  modelLanes: null,
};

describe("a Fable-only limit stop", () => {
  it("does not mark the whole Claude account limited", () => {
    expect(limitStopIsAccountWide(claude, FABLE, now)).toBe(false);
    // Opus on the same account was never out of room.
    expect(limitStopIsAccountWide(claude, OPUS, now)).toBe(true);
  });

  it("is account-wide when a spent window covers every model, or nothing scopes it", () => {
    expect(limitStopIsAccountWide(claudeSpent, FABLE, now)).toBe(true);
    expect(limitStopIsAccountWide(muse, "muse-wonder-1.0", now)).toBe(true);
    expect(limitStopIsAccountWide(copilotEnterprise, "claude-opus-5.5", now)).toBe(true);
    const spendControl = {
      ...claude,
      usageLimits: { ...claude.usageLimits!, spendControlReached: true },
    };
    expect(limitStopIsAccountWide(spendControl, FABLE, now)).toBe(true);
  });
});

describe("the coordinator turn after a Fable-only stop", () => {
  const turn = (limited: ReadonlySet<string>) =>
    resolveCoordinatorTurnSelection({
      saved: fable,
      thread: fable,
      providers,
      rule,
      nowMs: now,
      limitedInstanceIds: limited,
    });

  it("takes Opus elsewhere, not Muse, even with the whole Claude instance marked limited", () => {
    // Before the fix this landed on Muse Wonder through the headroom guess.
    expect(turn(new Set([claude.instanceId])).selection).toEqual(opusOnEnterprise);
  });

  it("continues on Opus on the same Claude account", () => {
    // The set the coordinator service builds for this stop (ProjectCoordinatorService).
    const limited = new Set<string>();
    if (limitStopIsAccountWide(claude, FABLE, now)) limited.add(claude.instanceId);
    expect(turn(limited)).toEqual({ selection: opus, reason: "fallback" });
  });

  it("after an account-wide stop takes Opus on Copilot Enterprise, never Muse", () => {
    const result = resolveCoordinatorTurnSelection({
      saved: fable,
      thread: fable,
      providers: [claudeSpent, codex, copilot, copilotEnterprise, muse],
      rule,
      nowMs: now,
      limitedInstanceIds: new Set([claude.instanceId]),
    });
    expect(result).toEqual({ selection: opusOnEnterprise, reason: "fallback" });
  });
});

describe("a worker launch while Fable is out of room", () => {
  it("takes Opus on the Claude account, not the coordinator's Muse", () => {
    expect(
      resolveWorkerLaunchSelection({
        preferred: fable,
        coordinator: museWonder,
        providers,
        rule,
        nowMs: now,
      }),
    ).toEqual({ selection: opus, reason: "fallback" });
  });

  it("takes Opus on Copilot Enterprise when the Claude account is spent", () => {
    expect(
      resolveWorkerLaunchSelection({
        preferred: fable,
        coordinator: museWonder,
        providers: [claudeSpent, codex, copilot, copilotEnterprise, muse],
        rule,
        nowMs: now,
      }).selection,
    ).toEqual(opusOnEnterprise);
  });
});

describe("the limit-stop fallback of a Fable thread", () => {
  const stop = {
    currentInstanceId: claude.instanceId,
    currentModel: FABLE,
    rule,
    nowMs: now,
    belowPercent: 100,
    anyReady: true,
  } as const;

  it("continues on Opus on the same Claude account", () => {
    expect(resolveProviderFallback({ ...stop, providers })).toEqual(opus);
  });

  it("continues on Opus on Copilot Enterprise when the Claude account is spent", () => {
    expect(
      resolveProviderFallback({
        ...stop,
        providers: [claudeSpent, codex, copilot, copilotEnterprise, muse],
      }),
    ).toEqual(opusOnEnterprise);
  });
});

describe("regular work never falls back to a Review-track model", () => {
  // Nothing on the person's list or the Daily track has room; only Muse does.
  const onlyMuse = [claudeSpent, codex, copilot, muse];
  const limited = new Set([claude.instanceId]);

  it("reads Muse Wonder and Muse Wonder Full as one line, Opus and Sonnet as two", () => {
    expect(modelLine("muse-wonder-1.0")).toBe(modelLine("muse-wonder-full-1.0"));
    expect(modelLine("claude-opus-5-5")).toBe(modelLine("claude-opus-5.5"));
    expect(modelLine("claude-opus-5-5")).not.toBe(modelLine("claude-sonnet-5-5"));
    expect(modelLine("gpt-6.1-sol")).toBe("gpt-sol");
  });

  it("holds back the Muse Wonder line, never a model on the Regular side", () => {
    const reviewOnly = reviewOnlyModel(rule);
    expect(reviewOnly({ model: "muse-wonder-1.0" })).toBe(true);
    expect(reviewOnly({ model: "muse-wonder-full-1.0" })).toBe(true);
    // Sol is on both built-in tracks: Daily keeps it on the Regular side.
    expect(reviewOnly({ model: "gpt-6.1-sol" })).toBe(false);
    expect(reviewOnly({ model: OPUS })).toBe(false);
    // The person's own Review track decides which line is held back.
    const own = reviewOnlyModel({
      ...rule,
      adversarialReview: { reviewers: [{ instanceId: id("codex"), model: "gpt-6-astra" }] },
    });
    expect(own({ model: "muse-wonder-1.0" })).toBe(false);
    // Complex names Astra: it stays on the Regular side.
    expect(own({ model: "gpt-6-astra" })).toBe(false);
  });

  it("waits on the saved model instead of guessing Muse for the coordinator", () => {
    expect(
      resolveCoordinatorTurnSelection({
        saved: fable,
        thread: fable,
        providers: onlyMuse,
        rule,
        nowMs: now,
        limitedInstanceIds: limited,
      }),
    ).toEqual({ selection: fable, reason: "no-fallback" });
  });

  it("does not keep a coordinator on Muse that a move put there", () => {
    const result = resolveCoordinatorTurnSelection({
      saved: fable,
      thread: museWonder,
      providers,
      rule,
      nowMs: now,
    });
    expect(result).toEqual({ selection: opus, reason: "fallback" });
  });

  it("starts a worker on its pick with no room rather than on Muse", () => {
    expect(
      resolveWorkerLaunchSelection({
        preferred: fable,
        coordinator: museWonder,
        providers: onlyMuse,
        rule,
        nowMs: now,
        limitedInstanceIds: limited,
      }),
    ).toEqual({ selection: fable, reason: "no-room" });
  });

  it("leaves a limit-stopped thread waiting rather than on Muse", () => {
    expect(
      resolveProviderFallback({
        providers: onlyMuse,
        currentInstanceId: claude.instanceId,
        currentModel: FABLE,
        rule,
        nowMs: now,
        anyReady: true,
        limitedInstanceIds: limited,
      }),
    ).toBeNull();
  });

  it("still lets review work and a Muse model the person listed reach Muse", () => {
    expect(
      resolveWorkerLaunchSelection({
        preferred: fable,
        coordinator: museWonder,
        providers: onlyMuse,
        rule,
        nowMs: now,
        limitedInstanceIds: limited,
        review: true,
      }),
    ).toEqual({ selection: museWonder, reason: "coordinator" });
    expect(
      resolveProviderFallback({
        providers: onlyMuse,
        currentInstanceId: claude.instanceId,
        currentModel: FABLE,
        rule: { ...rule, providerLimitFallbackModels: [opus, museWonder] },
        nowMs: now,
        anyReady: true,
        limitedInstanceIds: limited,
      }),
    ).toEqual(museWonder);
  });
});
