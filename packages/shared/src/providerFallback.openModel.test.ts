/**
 * 1513 D-08: an open-model route (a Claude Code instance made from a preset,
 * marked by `SPECWITHCODE_OPEN_MODEL_PRESET`) is never picked automatically,
 * whatever it bills. It runs only on a track or thread the person put it on.
 * A local model on Pi, OpenCode or a hand-built base-URL instance, which
 * carries no marker, keeps today's behaviour (D-05).
 */
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_TASK_ROUTING_SETTINGS,
  type ModelBilling,
  type ModelLanes,
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type TaskRoutingSettings,
} from "@specweave-studio/contracts";
import { reviewerChain } from "./adversarialReview.ts";
import {
  defaultCoordinatorModelSelection,
  defaultWorkerModelSelection,
} from "./coordinatorDefault.ts";
import { learnedPreferenceBillingBlock, resolveLaneRouting } from "./modelLanes.ts";
import { tierFallbackOrder } from "./modelTiers.ts";
import { isHeldSource, launchTrackLanes } from "./modelTracks.ts";
import {
  type ProviderFallbackRule,
  resolveCoordinatorTurnSelection,
  resolveProviderFallback,
  resolveSameModelElsewhere,
  resolveWorkerLaunchSelection,
} from "./providerFallback.ts";
import { classifyTask, resolveTaskRouting } from "./taskRouting.ts";

const now = Date.parse("2026-11-28T12:00:00Z");
const fresh = DateTime.formatIso(DateTime.makeUnsafe(now));
const OPUS = "claude-opus-5-5";
const SOL = "gpt-6.2-sol";
const FLASH = "deepseek-flash";

const full = (used: number) => ({
  checkedAt: fresh,
  windows: [
    {
      id: "five_hour",
      kind: "session" as const,
      label: "Session",
      usedPercent: used,
      resetsAt: DateTime.formatIso(DateTime.makeUnsafe(now + 3 * 60 * 60_000)),
    },
  ],
});

function source(input: {
  readonly id: string;
  readonly driver: string;
  readonly models: ReadonlyArray<string>;
  readonly billing?: ModelBilling;
  readonly preset?: string;
  readonly used?: number;
  readonly auth?: ServerProvider["auth"];
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.id),
    driver: ProviderDriverKind.make(input.driver),
    enabled: true,
    installed: true,
    status: "ready",
    auth: input.auth ?? { status: "authenticated" },
    checkedAt: fresh,
    version: null,
    models: input.models.map((slug, index) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: null,
      ...(index === 0 ? { isDefault: true } : {}),
      ...(input.billing === undefined ? {} : { billing: input.billing }),
    })),
    slashCommands: [],
    skills: [],
    ...(input.preset === undefined ? {} : { openModelPreset: input.preset }),
    ...(input.used === undefined ? {} : { usageLimits: full(input.used) }),
  };
}

/** The Claude subscription that ran out, and a Codex plan that ran out too. */
const claude = source({ id: "claudeAgent", driver: "claudeAgent", models: [OPUS], used: 100 });
const codex = source({ id: "codex", driver: "codex", models: [SOL], used: 100 });
const opus: ModelSelection = { instanceId: claude.instanceId, model: OPUS };
const sol: ModelSelection = { instanceId: codex.instanceId, model: SOL };

/** Ollama through Claude Code on this machine, and DeepSeek on the person's key. */
const ollama = (models: ReadonlyArray<string> = [FLASH]) =>
  source({
    id: "claude_ollama",
    driver: "claudeAgent",
    models,
    billing: "local",
    preset: "ollama",
    auth: { status: "authenticated", label: "Local" },
  });
const deepseek = (models: ReadonlyArray<string> = [FLASH]) =>
  source({
    id: "claude_deepseek",
    driver: "claudeAgent",
    models,
    billing: "api",
    preset: "deepseek",
    auth: { status: "authenticated", label: "Your key" },
  });
/** The same local model with no marker: Pi on Ollama, or a base URL set by hand. */
const unmarked = (models: ReadonlyArray<string> = [FLASH]) => [
  source({
    id: "pi",
    driver: "pi",
    models,
    billing: "local",
    auth: { status: "authenticated", type: "pi" },
  }),
  source({ id: "claude_byhand", driver: "claudeAgent", models, billing: "local" }),
];

const on = (provider: ServerProvider, model = provider.models[0]!.slug): ModelSelection => ({
  instanceId: provider.instanceId,
  model,
});
const switchRule: ProviderFallbackRule = {
  providerLimitAction: "switch",
  providerLimitFallbackModelSelection: null,
  providerLimitSwitchAtPercent: null,
  defaultModelSelection: null,
};
const complexOnly: ModelLanes = { complex: [opus], routine: [] };

/** Every automatic path a Complex or Review thread or worker takes off a spent Opus. */
function automaticPicks(route: ServerProvider, providers = [claude, codex, route]) {
  const withOpus = { ...route, models: [...route.models, { ...route.models[0]!, slug: OPUS }] };
  const withSol = { ...route, models: [...route.models, { ...route.models[0]!, slug: SOL }] };
  const fallback = (
    over: Partial<Parameters<typeof resolveProviderFallback>[0]> = {},
  ): ModelSelection | null =>
    resolveProviderFallback({
      providers,
      currentInstanceId: claude.instanceId,
      currentModel: OPUS,
      rule: { ...switchRule, threadModelMode: "model", modelLanes: complexOnly },
      lane: "complex",
      nowMs: now,
      anyReady: true,
      ...over,
    });
  return {
    anyReady: fallback(),
    tracks: fallback({
      rule: { ...switchRule, threadModelMode: "tracks", modelLanes: complexOnly },
    }),
    // The person put the route on Daily: a Complex chain never continues onto it.
    complexIntoDaily: fallback({
      rule: {
        ...switchRule,
        threadModelMode: "model",
        modelLanes: { complex: [opus], routine: [on(route)] },
      },
      anyReady: false,
    }),
    sameModel: resolveSameModelElsewhere({
      providers: [claude, withOpus],
      current: opus,
      // Ranking it in the Sources order is not putting it on a track.
      order: [route.instanceId],
      nowMs: now,
    }),
    sameModelFallback: fallback({ providers: [claude, codex, withOpus] }),
    proven: resolveProviderFallback({
      providers,
      currentInstanceId: claude.instanceId,
      currentModel: OPUS,
      rule: { ...switchRule, threadModelMode: "model" },
      nowMs: now,
      proven: on(route),
    }),
    worker: resolveWorkerLaunchSelection({
      preferred: opus,
      coordinator: null,
      providers,
      rule: { ...switchRule, threadModelMode: "model", modelLanes: complexOnly },
      nowMs: now,
    }),
    workerOnTracks: resolveWorkerLaunchSelection({
      preferred: opus,
      coordinator: null,
      providers,
      rule: { ...switchRule, threadModelMode: "tracks", modelLanes: complexOnly },
      nowMs: now,
    }),
    workerBesideCoordinator: resolveWorkerLaunchSelection({
      preferred: opus,
      coordinator: on(route),
      providers,
      rule: switchRule,
      nowMs: now,
    }),
    coordinator: resolveCoordinatorTurnSelection({
      saved: opus,
      thread: null,
      providers,
      rule: switchRule,
      nowMs: now,
    }),
    coordinatorStays: resolveCoordinatorTurnSelection({
      saved: opus,
      thread: on(route),
      providers,
      rule: switchRule,
      nowMs: now,
    }),
    // A reviewer's same-model alternate: Sol is spent on Codex, the route lists Sol.
    review: resolveProviderFallback({
      providers: [claude, codex, withSol],
      currentInstanceId: claude.instanceId,
      currentModel: OPUS,
      rule: {
        ...switchRule,
        threadModelMode: "tracks",
        adversarialReview: { reviewers: [sol] } as never,
      },
      nowMs: now,
      review: true,
    }),
    complexChain: tierFallbackOrder(
      { threadModelMode: "model", modelLanes: { complex: [sol], routine: [] } },
      SOL,
      [claude, codex, withSol],
      { lane: "complex" },
    ),
  };
}

const lands = (selection: ModelSelection | null | undefined, route: ServerProvider) =>
  selection?.instanceId === route.instanceId;

describe.each([
  ["local", ollama],
  ["api", deepseek],
] as const)("an open-model route billed %s", (_billing, make) => {
  const route = make();

  it("is held from every automatic pick for Complex and Review work", () => {
    expect(isHeldSource(route, FLASH)).toBe(true);
    const picks = automaticPicks(route);
    expect(picks.anyReady).toBeNull();
    expect(picks.tracks).toBeNull();
    expect(picks.complexIntoDaily).toBeNull();
    expect(picks.sameModel).toBeNull();
    expect(lands(picks.sameModelFallback, route)).toBe(false);
    expect(lands(picks.proven, route)).toBe(false);
    expect(picks.worker).toEqual({ selection: opus, reason: "no-room" });
    expect(picks.workerOnTracks).toEqual({ selection: opus, reason: "no-room" });
    expect(picks.workerBesideCoordinator).toEqual({ selection: opus, reason: "no-room" });
    expect(lands(picks.coordinator.selection, route)).toBe(false);
    expect(picks.coordinatorStays.reason).not.toBe("staying-on-fallback");
    expect(lands(picks.review, route)).toBe(false);
    expect(picks.complexChain.some((entry) => lands(entry, route))).toBe(false);
  });

  it("starts a Daily launch when the person put it on the Daily track", () => {
    const providers = [claude, codex, route];
    const lanes = launchTrackLanes({ complex: [opus], routine: [on(route)] }, providers, null, now);
    const launch = (laneHint: "routine" | "complex") =>
      resolveLaneRouting({
        lanes,
        preferences: [],
        task: { text: "Rename the button label" },
        classification: classifyTask({ text: "Rename the button label" }),
        laneHint,
        baseline: opus,
        providers,
        nowMs: now,
        policy: { excludedProviders: [], escalate: false, minimumTier: null },
        switchAtPercent: 95,
      });
    expect(launch("routine")?.decision.selection).toEqual(on(route));
    expect(launch("routine")?.found).toBe(true);
    // Complex work stays off it: only Opus is on Complex, and it is spent.
    expect(lands(launch("complex")?.decision.selection, route)).toBe(false);
    // A worker whose Daily entry is the route starts there.
    expect(
      resolveWorkerLaunchSelection({
        preferred: on(route),
        coordinator: null,
        providers,
        rule: { ...switchRule, threadModelMode: "tracks", modelLanes: lanes },
        nowMs: now,
      }),
    ).toEqual({ selection: on(route), reason: "preferred" });
  });

  it("is never a coordinator's learned preference unless it is on a track", () => {
    const policy = { excludedProviders: [], escalate: false, minimumTier: null };
    const providers = [claude, route];
    expect(
      learnedPreferenceBillingBlock(on(route), {
        providers,
        lanes: { complex: [], routine: [] },
        policy,
      }),
    ).toContain("runs only on a track you put it on");
    expect(
      learnedPreferenceBillingBlock(on(route), {
        providers,
        lanes: { complex: [], routine: [on(route)] },
        policy,
      }),
    ).toBeNull();
  });

  it("is never an Auto pick off another model", () => {
    const auto: TaskRoutingSettings = {
      ...DEFAULT_TASK_ROUTING_SETTINGS,
      mode: "auto",
      paidApi: "standard",
    };
    const roomy = { ...claude, usageLimits: full(10) };
    const decision = resolveTaskRouting({
      policy: auto,
      classification: classifyTask({ text: "Summarize this article about tides" }),
      baseline: opus,
      providers: [roomy, route],
      nowMs: now,
      switchAtPercent: 95,
    });
    expect(lands(decision.selection, route)).toBe(false);
    expect(decision.skipped ?? [decision.reason]).toEqual(
      expect.arrayContaining([expect.stringContaining("runs only where you put it")]),
    );
  });
});

describe("the coordinator and worker defaults", () => {
  it("never fall to an open-model route by themselves", () => {
    for (const route of [ollama(), deepseek()]) {
      expect(defaultCoordinatorModelSelection([route])).toBeNull();
      expect(defaultWorkerModelSelection([route])).toBeNull();
    }
  });
});

describe("a delegated review's reviewer order", () => {
  it("never adds an open-model route as an unnamed same-model alternate", () => {
    const chain = reviewerChain({
      providers: [codex, ollama([SOL]), deepseek([SOL])],
      reviewers: [sol],
      tier: "regular",
    });
    expect(chain).toEqual([sol]);
  });

  it("keeps a source with no preset marker as an alternate, as today", () => {
    const pi = unmarked([SOL])[0]!;
    const chain = reviewerChain({ providers: [codex, pi], reviewers: [sol], tier: "regular" });
    expect(chain.map((step) => step.instanceId)).toEqual([codex.instanceId, pi.instanceId]);
  });
});

describe("a Review track entry the person named", () => {
  it("may review on a local route they put there", () => {
    const route = ollama([SOL]);
    const picked = resolveProviderFallback({
      providers: [claude, codex, route],
      currentInstanceId: claude.instanceId,
      currentModel: OPUS,
      rule: {
        ...switchRule,
        threadModelMode: "tracks",
        adversarialReview: { reviewers: [on(route)] } as never,
      },
      nowMs: now,
      review: true,
    });
    expect(picked).toEqual(on(route));
  });
});

describe.each([
  ["Pi on a local runtime", 0],
  ["a Claude instance with a base URL set by hand", 1],
] as const)("%s, with no preset marker", (_label, index) => {
  const route = unmarked()[index]!;

  it("keeps today's behaviour: a local model may still be picked automatically", () => {
    expect(isHeldSource(route, FLASH)).toBe(false);
    const picks = automaticPicks(route);
    expect(picks.anyReady).toEqual(on(route));
    expect(picks.complexIntoDaily).toEqual(on(route));
    expect(picks.sameModel).toEqual(on(route, OPUS));
    expect(picks.worker.selection).toEqual(on(route));
    expect(picks.workerBesideCoordinator).toEqual({ selection: on(route), reason: "coordinator" });
    expect(picks.coordinatorStays.reason).toBe("staying-on-fallback");
    expect(picks.review).toEqual(on(route, SOL));
    expect(picks.complexChain.some((entry) => lands(entry, route))).toBe(true);
    expect(
      learnedPreferenceBillingBlock(on(route), {
        providers: [claude, route],
        lanes: { complex: [], routine: [] },
        policy: { excludedProviders: [], escalate: false, minimumTier: null },
      }),
    ).toBeNull();
  });
});
