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
const museWonderFull = { instanceId: id("muse"), model: "muse-wonder-full-1.0" };
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
    // A saved Review order still reserves Muse for review unless Regular work names it.
    const own = reviewOnlyModel({
      ...rule,
      adversarialReview: { reviewers: [{ instanceId: id("codex"), model: "gpt-6-astra" }] },
    });
    expect(own({ model: "muse-wonder-1.0" })).toBe(true);
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
      resolveProviderFallback({
        providers: onlyMuse,
        currentInstanceId: claude.instanceId,
        currentModel: FABLE,
        rule,
        nowMs: now,
        anyReady: true,
        limitedInstanceIds: limited,
        review: true,
      }),
    ).toEqual(museWonder);
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

describe("a Review-track model saved on Daily is the last resort", () => {
  // Owner decision, November 18, 2026: Muse Wonder Full stays on the saved
  // Daily list and runs regular work only once no other Daily entry has room.
  const onDaily = (routine: ReadonlyArray<{ instanceId: ProviderInstanceId; model: string }>) => ({
    ...rule,
    providerLimitFallbackModels: [],
    modelLanes: { routine: [...routine], complex: [] },
  });
  const stop = (stopRule: ProviderFallbackRule, available: ReadonlyArray<ServerProvider>) =>
    resolveProviderFallback({
      providers: available,
      currentInstanceId: claude.instanceId,
      currentModel: OPUS,
      rule: stopRule,
      nowMs: now,
      anyReady: true,
      limitedInstanceIds: new Set([claude.instanceId]),
    });

  it("runs every other Daily entry first, wherever Wonder Full sits on the list", () => {
    // Wonder Full is saved second and Muse shows verified room; Opus on
    // Copilot Enterprise reports no usage and still goes first.
    expect(
      stop(onDaily([opus, museWonderFull, opusOnEnterprise]), [
        claudeSpent,
        codex,
        copilotEnterprise,
        muse,
      ]),
    ).toEqual(opusOnEnterprise);
  });

  it("falls back to Wonder Full once no other Daily entry has room", () => {
    expect(
      stop(onDaily([opus, opusOnEnterprise, museWonderFull]), [claudeSpent, codex, copilot, muse]),
    ).toEqual(museWonderFull);
  });

  it("still never guesses a Review-track model that is not on the saved Daily list", () => {
    // Muse has room, but neither Wonder model is on Daily: the thread waits.
    expect(stop(onDaily([opus, opusOnEnterprise]), [claudeSpent, codex, copilot, muse])).toBeNull();
    // Wonder Full on Daily does not let its sibling Wonder 1.0 in as a guess.
    expect(reviewOnlyModel(onDaily([opus, museWonderFull]))(museWonder)).toBe(true);
  });
});

describe("a real post-stop snapshot", () => {
  // At the stop the account read also says ordinary usage is denied and when.
  const deniedClaude: ServerProvider = {
    ...claude,
    usageLimits: {
      ...claude.usageLimits!,
      ordinaryUsageAllowed: false,
      rateLimitReachedType: "seven_day_fable",
      nativeDenialObservedAt: iso(now),
      nativeAllowanceObservedAt: iso(now),
    },
  };

  it("still continues on Opus on the same Claude account", () => {
    expect(
      resolveProviderFallback({
        providers: [deniedClaude, codex, copilot, copilotEnterprise, muse],
        currentInstanceId: claude.instanceId,
        currentModel: FABLE,
        rule,
        nowMs: now,
        belowPercent: 100,
        anyReady: true,
      }),
    ).toEqual(opus);
  });

  it("waits when Complex is out, even if a retained fallback list names a ready Daily model", () => {
    expect(
      resolveProviderFallback({
        providers: [deniedClaude, codex, muse],
        currentInstanceId: claude.instanceId,
        currentModel: FABLE,
        lane: "complex",
        rule: {
          ...rule,
          threadModelMode: "tracks",
          defaultModelSelection: opus,
          providerLimitFallbackModels: [opus],
          providerLimitFallbackModelSelection: null,
          modelLanes: { complex: [fable], routine: [opus] },
        },
        nowMs: now,
        anyReady: true,
      }),
    ).toBeNull();
  });

  it("fits a saved Neon entry to a listed newer release and retains Review effort", () => {
    const neon = {
      ...copilotEnterprise,
      models: [{
        ...copilotEnterprise.models[0]!,
        slug: "gemini-4.5-neon",
        name: "Gemini 4.5 Neon",
        capabilities: {
          optionDescriptors: [{
            id: "reasoningEffort",
            label: "Reasoning effort",
            type: "select" as const,
            options: [{ id: "medium", label: "Medium" }, { id: "high", label: "High" }],
          }],
        },
      }],
    };
    expect(resolveProviderFallback({
      providers: [neon],
      currentInstanceId: id("codex"),
      currentModel: "gpt-6.2-sol",
      review: true,
      rule: {
        ...rule,
        threadModelMode: "tracks",
        adversarialReview: {
          reviewers: [{ instanceId: id("antigravity"), model: "gemini-4-neon" }],
        },
      },
      nowMs: now,
    })).toEqual({
      instanceId: neon.instanceId,
      model: "gemini-4.5-neon",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
  });

  it("keeps a newer release of a built-in Daily model on the Regular side", () => {
    expect(reviewOnlyModel(rule)({ model: "gpt-6.2-sol" })).toBe(false);
  });

  it("keeps Review models reserved despite a saved single-model default in Tracks mode", () => {
    expect(reviewOnlyModel({
      ...rule,
      threadModelMode: "tracks",
      defaultModelSelection: museWonderFull,
      adversarialReview: { reviewers: [museWonderFull] },
    })(museWonderFull)).toBe(true);
  });

  it("keeps an unread reviewer ahead of a later reviewer with known room", () => {
    const unreadMuse: ServerProvider = {
      ...muse,
      usageLimits: {
        checkedAt: iso(now),
        windows: [],
        unavailable: { reason: "probeFailed", message: "Usage could not be read." },
      },
    };
    expect(resolveProviderFallback({
      providers: [unreadMuse, claude],
      currentInstanceId: id("codex"),
      currentModel: "gpt-6.2-sol",
      review: true,
      rule: {
        ...rule,
        threadModelMode: "tracks",
        adversarialReview: { reviewers: [museWonderFull, opus] },
      },
      nowMs: now,
    })).toMatchObject(museWonderFull);
  });
});
