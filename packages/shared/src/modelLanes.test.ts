import * as DateTime from "effect/DateTime";
import {
  type LearnedModelPreference,
  type ModelLanes,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
  type TaskRoutingDecision,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  classifyLane,
  classifyLaneByRules,
  describePreference,
  learnedPreferenceBillingBlock,
  preferenceMatch,
  resolveLaneRouting,
  suggestPreferenceKeywords,
  withLearnedPreference,
} from "./modelLanes.ts";
import { classifyTask } from "./taskRouting.ts";

const now = Date.parse("2026-10-22T22:00:00.000Z");
const at = DateTime.formatIso(DateTime.makeUnsafe(now));

const model = (slug: string, name: string): ServerProviderModel => ({
  slug,
  name,
  isCustom: false,
  capabilities: null,
});

function provider(
  id: string,
  driver: string,
  models: ReadonlyArray<ServerProviderModel>,
  over: Partial<ServerProvider> = {},
  used: number | null = 10,
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated", type: "subscription" },
    checkedAt: at,
    version: null,
    models: [...models],
    slashCommands: [],
    skills: [],
    ...(used === null
      ? {}
      : {
          usageLimits: {
            checkedAt: at,
            windows: [
              {
                id: "five_hour",
                kind: "session" as const,
                label: "Session",
                usedPercent: used,
                resetsAt: "2026-10-23T02:00:00.000Z",
              },
            ],
          },
        }),
    ...over,
  };
}

const claude = provider("claudeAgent", "claudeAgent", [
  model("claude-opus-5-5", "Claude Opus 5.5"),
  model("claude-fable-5-1", "Claude Fable 5.1"),
  model("claude-sonnet-5-5", "Claude Sonnet 5.5"),
]);
const codex = provider("codex", "codex", [
  model("gpt-6.1-sol", "GPT-6.1 Sol"),
  model("gpt-6-astra", "GPT-6 Astra"),
]);
const copilot = provider(
  "acpRegistry_copilot",
  "acpRegistry",
  [model("claude-opus-5.5", "Claude Opus 5.5"), model("gpt-6.1-sol", "GPT-6.1 Sol")],
  { displayName: "Copilot managed", auth: { status: "authenticated" } },
  null,
);
const gemini = provider(
  "geminiCli",
  "acpRegistry",
  [model("gemini-3-pro", "Gemini 3 Pro")],
  { displayName: "Gemini CLI (Vertex)", auth: { status: "authenticated", type: "vertex-ai" } },
  null,
);
const providers = [claude, codex, copilot, gemini];

const sel = (instanceId: string, slug: string) => ({
  instanceId: ProviderInstanceId.make(instanceId),
  model: slug,
});
const sol = sel("codex", "gpt-6.1-sol");
const fable = sel("claudeAgent", "claude-fable-5-1");
const opus = sel("claudeAgent", "claude-opus-5-5");
const copilotOpus = sel("acpRegistry_copilot", "claude-opus-5.5");
const sonnet = sel("claudeAgent", "claude-sonnet-5-5");
const astra = sel("codex", "gpt-6-astra");

const lanes: ModelLanes = { complex: [sol, fable], routine: [copilotOpus, opus, astra] };
const policy = { excludedProviders: [], escalate: true, minimumTier: null };

function route(
  text: string,
  over: Partial<Parameters<typeof resolveLaneRouting>[0]> = {},
): TaskRoutingDecision | null {
  return (
    resolveLaneRouting({
      lanes,
      preferences: [],
      task: { text },
      classification: classifyTask({ text }),
      baseline: astra,
      providers,
      nowMs: now,
      policy,
      switchAtPercent: 95,
      ...over,
    })?.decision ?? null
  );
}

const preference = (over: Partial<LearnedModelPreference>): LearnedModelPreference => ({
  id: "p1",
  keywords: [],
  action: { kind: "prefer", model: sonnet },
  createdAt: at,
  ...over,
});

describe("classifyLaneByRules", () => {
  it("puts hard, open-ended and creative work in the complex lane", () => {
    expect(
      classifyLaneByRules({ text: "Redesign the sync architecture to remove the race condition" })
        .lane,
    ).toBe("complex");
    expect(
      classifyLaneByRules({ text: "Brainstorm creative names for the launch campaign" }).lane,
    ).toBe("complex");
    expect(
      classifyLaneByRules({
        text: "Think on how to organize it best, implement, deploy, and test.",
      }).lane,
    ).toBe("complex");
  });

  it("keeps well-specified work routine", () => {
    expect(classifyLaneByRules({ text: "Fix the typo in the README" }).lane).toBe("routine");
    expect(classifyLaneByRules({ text: "Run the release via the documented process" }).lane).toBe(
      "routine",
    );
    expect(classifyLaneByRules({ text: "Add a loading spinner to the save button" }).lane).toBe(
      "routine",
    );
  });

  it("treats a long requirement list as complex", () => {
    const text = Array.from({ length: 9 }, (_, index) => `- requirement ${index + 1}`).join("\n");
    const result = classifyLaneByRules({ text });
    expect(result.lane).toBe("complex");
    expect(result.signals).toContain("9 requirements");
  });

  it("lets a routine class outweigh a single complex word", () => {
    const text = "Translate the creative brief into Spanish";
    expect(classifyLaneByRules({ text }, classifyTask({ text })).lane).toBe("routine");
  });
});

describe("classifyLane", () => {
  it("takes the caller's hint over everything", () => {
    expect(classifyLane({ task: { text: "Fix the typo" }, hint: "complex" })).toMatchObject({
      lane: "complex",
      source: "hint",
    });
  });

  it("uses a learned lane rule before the rules", () => {
    const learned = preference({
      id: "lane-video",
      keywords: ["promo video"],
      action: { kind: "lane", lane: "complex" },
    });
    expect(
      classifyLane({ task: { text: "Cut a promo video from the demo" }, preferences: [learned] }),
    ).toMatchObject({ lane: "complex", source: "learned", preferenceId: "lane-video" });
  });
});

describe("preferenceMatch", () => {
  it("matches keywords on word boundaries, case-insensitively", () => {
    const rule = preference({ keywords: ["Release"] });
    expect(preferenceMatch(rule, { text: "cut the release" }, undefined, "routine")).toBe(2);
    expect(preferenceMatch(rule, { text: "unreleased work" }, undefined, "routine")).toBeNull();
  });

  it("needs the class and the lane when the rule names them", () => {
    const rule = preference({ taskClass: "translation", lane: "routine" });
    expect(preferenceMatch(rule, { text: "x" }, { taskClass: "translation" }, "routine")).toBe(1);
    expect(preferenceMatch(rule, { text: "x" }, { taskClass: "code" }, "routine")).toBeNull();
    expect(
      preferenceMatch(rule, { text: "x" }, { taskClass: "translation" }, "complex"),
    ).toBeNull();
  });

  it("never matches an unscoped lane rule", () => {
    expect(
      preferenceMatch(
        preference({ action: { kind: "lane", lane: "complex" } }),
        { text: "anything" },
        undefined,
        undefined,
      ),
    ).toBeNull();
  });
});

describe("resolveLaneRouting", () => {
  it("starts complex work on the first complex entry, routine on the first routine entry", () => {
    const complex = route("Design a new architecture for offline sync from scratch");
    expect(complex).toMatchObject({ lane: "complex", moved: true, selection: sol });
    expect(complex?.escalation).toEqual(fable);
    const routine = route("Update the changelog for 1.0.73");
    expect(routine).toMatchObject({ lane: "routine", moved: true, selection: copilotOpus });
  });

  it("enforces the tier floor for lane entries and learned preferences", () => {
    const decision = route("Update the changelog", {
      lanes: { complex: [], routine: [sonnet, opus] },
      preferences: [preference({ action: { kind: "prefer", model: sonnet } })],
      policy: { ...policy, minimumTier: "frontier" },
    });
    expect(decision?.selection).toEqual(opus);
    expect(decision?.skipped?.[0]).toContain("below minimum tier Frontier");
  });

  it("rejects an unknown model tier when a floor is set", () => {
    const custom = sel("claudeAgent", "custom-model");
    const decision = route("Update the changelog", {
      lanes: { complex: [], routine: [custom, opus] },
      providers: [{ ...claude, models: [...claude.models, model("custom-model", "Custom model")] }],
      policy: { ...policy, minimumTier: "standard" },
    });
    expect(decision?.selection).toEqual(opus);
    expect(decision?.skipped?.[0]).toContain("below minimum tier");
  });

  it("marks an avoided baseline as prohibited when the lane is exhausted", () => {
    const result = resolveLaneRouting({
      lanes: { complex: [], routine: [opus] },
      preferences: [
        preference({ keywords: ["changelog"], action: { kind: "avoid", model: opus } }),
      ],
      task: { text: "Update the changelog" },
      classification: classifyTask({ text: "Update the changelog" }),
      baseline: opus,
      providers,
      nowMs: now,
      policy,
    });
    expect(result?.found).toBe(false);
    expect(result?.baselineUnavailable).toBe("avoided for tasks like this");
  });

  it("skips an exhausted provider and records why", () => {
    const decision = route("Update the changelog", {
      limitedInstanceIds: new Set(["acpRegistry_copilot"]),
    });
    expect(decision?.selection).toEqual(opus);
    expect(decision?.skipped).toEqual(["Copilot managed · Claude Opus 5.5: at its usage limit"]);
    expect(decision?.reason).toContain("after skipping 1");
  });

  it("skips a provider over the switch threshold and one that is signed out", () => {
    const decision = route("Design a new architecture from scratch", {
      providers: [
        {
          ...codex,
          usageLimits: {
            ...codex.usageLimits!,
            windows: [{ ...codex.usageLimits!.windows[0]!, usedPercent: 97 }],
          },
        },
        { ...claude, auth: { status: "unauthenticated" } },
        copilot,
      ],
    });
    expect(decision?.moved).toBe(false);
    expect(decision?.skipped).toEqual([
      "codex · GPT-6.1 Sol: at 97% usage",
      "claudeAgent · Claude Fable 5.1: signed out",
    ]);
    expect(decision?.reason).toMatch(/^No Complex and creative model can run now/);
  });

  it("never picks Gemini or Vertex spend, even from a lane", () => {
    const decision = route("Fix the typo", {
      lanes: { complex: [], routine: [sel("geminiCli", "gemini-3-pro"), astra] },
    });
    expect(decision?.skipped?.[0]).toContain("never picked automatically");
    expect(decision).toMatchObject({ moved: false, selection: astra });
  });

  it("honours exclusions and runnable instances", () => {
    expect(
      route("Fix the typo", { policy: { excludedProviders: [copilot.instanceId], escalate: true } })
        ?.selection,
    ).toEqual(opus);
    expect(route("Fix the typo", { runnableInstanceIds: new Set(["codex"]) })?.selection).toEqual(
      astra,
    );
  });

  it("returns null when the lane is empty and nothing is learned", () => {
    expect(route("Fix the typo", { lanes: { complex: [sol], routine: [] } })).toBeNull();
  });

  it("tries a matching prefer rule first and records it", () => {
    const decision = route("Translate the onboarding copy to German", {
      preferences: [preference({ id: "tr", keywords: ["translate"] })],
    });
    expect(decision).toMatchObject({ selection: sonnet, preferenceId: "tr" });
    expect(decision?.reason).toContain("learned preference");
  });

  it("skips a model an avoid rule names", () => {
    const decision = route("Update the changelog", {
      preferences: [
        preference({
          id: "no-copilot",
          keywords: ["changelog"],
          action: { kind: "avoid", model: copilotOpus },
        }),
      ],
    });
    expect(decision?.selection).toEqual(opus);
    expect(decision?.skipped?.[0]).toContain("avoided for tasks like this");
  });

  it("keeps the baseline unmoved when the lane's first entry is the baseline", () => {
    const decision = route("Fix the typo", { baseline: copilotOpus });
    expect(decision).toMatchObject({ moved: false, selection: copilotOpus, escalation: null });
  });

  it("uses the caller's lane hint", () => {
    expect(route("Fix the typo", { laneHint: "complex" })).toMatchObject({
      lane: "complex",
      confidence: "hint",
      selection: sol,
    });
  });

  it("allows a per-token entry the user listed and labels its billing", () => {
    const apiClaude = {
      ...claude,
      auth: { status: "authenticated" as const, apiKeyBilling: true },
    };
    const decision = route("Update the changelog", {
      providers: [apiClaude, codex],
      lanes: { complex: [], routine: [opus] },
    });
    expect(decision).toMatchObject({ selection: opus, billing: "api" });
  });
});

describe("preference helpers", () => {
  it("suggests topic words from a title", () => {
    expect(suggestPreferenceKeywords("Translate the onboarding copy into German")).toEqual([
      "translate",
      "onboarding",
      "copy",
    ]);
  });

  it("replaces a rule with the same match and keeps the newest within the limit", () => {
    const first = preference({ id: "a", keywords: ["video"] });
    const second = preference({
      id: "b",
      keywords: ["Video"],
      action: { kind: "prefer", model: sol },
    });
    expect(withLearnedPreference([first], second, 40).map((rule) => rule.id)).toEqual(["b"]);
    const many = Array.from({ length: 3 }, (_, index) =>
      preference({ id: `r${index}`, keywords: [`k${index}`] }),
    );
    expect(withLearnedPreference(many, first, 3).map((rule) => rule.id)).toEqual(["r1", "r2", "a"]);
  });

  it("describes a rule in words", () => {
    expect(describePreference(preference({ keywords: ["translate"] }), providers)).toBe(
      '"translate": use claudeAgent · Claude Sonnet 5.5',
    );
  });
});

describe("a learned preference for a paid model", () => {
  // A Claude CLI on Anthropic API credits: every turn bills the key.
  const claudeApi = provider(
    "claude-api",
    "claudeAgent",
    [model("claude-opus-5-5", "Claude Opus 5.5"), model("claude-sonnet-5-5", "Claude Sonnet 5.5")],
    { auth: { status: "authenticated", type: "apiKey", apiKeyBilling: true } },
    null,
  );
  const apiOpus = sel("claude-api", "claude-opus-5-5");
  const prefer = preference({ lane: "routine", action: { kind: "prefer", model: apiOpus } });
  const routeRoutine = (over: Partial<Parameters<typeof resolveLaneRouting>[0]> = {}) =>
    resolveLaneRouting({
      lanes: { complex: [], routine: [] },
      preferences: [prefer],
      task: { text: "Fix the typo in README" },
      classification: classifyTask({ text: "Fix the typo in README" }),
      laneHint: "routine",
      baseline: opus,
      providers: [claude, claudeApi],
      nowMs: now,
      policy: { ...policy, paidApi: "never" },
      ...over,
    });

  it("never moves a worker onto API credits by itself", () => {
    // Refused for billing, the rule counts as absent: with empty lanes the
    // lanes have nothing to say, so Auto (or the baseline) decides.
    expect(routeRoutine()).toBeNull();
    // With a lane list, the list decides and the decision says why.
    const result = routeRoutine({ lanes: { complex: [], routine: [sonnet] } });
    expect(result?.found).toBe(true);
    expect(result?.decision).toMatchObject({ moved: true, selection: sonnet });
    expect(result?.decision.skipped?.[0]).toContain("billed per token");
    // Nor a model whose billing its provider cannot establish (Pi on `anthropic`).
    const pi = provider(
      "pi",
      "pi",
      [{ ...model("anthropic/claude-opus-5-5", "Claude Opus 5.5"), billing: "unknown" }],
      { auth: { status: "authenticated", type: "pi" } },
      null,
    );
    const piPrefer = preference({
      lane: "routine",
      action: { kind: "prefer", model: sel("pi", "anthropic/claude-opus-5-5") },
    });
    expect(routeRoutine({ providers: [claude, pi], preferences: [piPrefer] })).toBeNull();
    const unknown = routeRoutine({
      providers: [claude, pi],
      preferences: [piPrefer],
      lanes: { complex: [], routine: [sonnet] },
    });
    expect(unknown?.decision.selection).toEqual(sonnet);
    expect(unknown?.decision.skipped?.[0]).toContain("billing unknown");
  });

  it("falls through instead of refusing when only a refused rule set the lanes", () => {
    // The baseline is at its switch threshold; a refused rule must not turn
    // that into "no permitted model", which would fail the launch.
    const busyClaude = provider(
      "claudeAgent",
      "claudeAgent",
      [model("claude-opus-5-5", "Claude Opus 5.5")],
      {},
      96,
    );
    expect(routeRoutine({ providers: [busyClaude, claudeApi], switchAtPercent: 95 })).toBeNull();
  });

  it("honours a rule the person made from the routing chip, whatever the billing", () => {
    const own = preference({
      lane: "routine",
      action: { kind: "prefer", model: apiOpus },
      recordedBy: "person",
    });
    expect(routeRoutine({ preferences: [own] })?.decision).toMatchObject({
      moved: true,
      selection: apiOpus,
      billing: "api",
    });
    // A coordinator-stamped rule is still checked.
    expect(
      routeRoutine({ preferences: [{ ...own, recordedBy: "coordinator" as const }] }),
    ).toBeNull();
  });

  it("moves it when the user put the model in a lane or Auto's paid-API setting allows it", () => {
    expect(routeRoutine({ lanes: { complex: [], routine: [apiOpus] } })?.decision).toMatchObject({
      moved: true,
      selection: apiOpus,
      billing: "api",
    });
    // Auto's cap applies by tier: Standard allows Sonnet on the key, not Opus.
    const apiSonnet = sel("claude-api", "claude-sonnet-5-5");
    const paidStandard = { ...policy, mode: "auto" as const, paidApi: "standard" as const };
    expect(routeRoutine({ policy: paidStandard })).toBeNull();
    expect(
      routeRoutine({
        policy: paidStandard,
        preferences: [
          preference({ lane: "routine", action: { kind: "prefer", model: apiSonnet } }),
        ],
      })?.decision.selection,
    ).toEqual(apiSonnet);
  });

  it("ignores a paid-API setting left over after Auto was turned off", () => {
    // Turning Auto off keeps `paidApi` but hides it; it must grant nothing.
    const apiSonnet = sel("claude-api", "claude-sonnet-5-5");
    const sonnetRule = preference({
      lane: "routine",
      action: { kind: "prefer", model: apiSonnet },
    });
    const leftover = { ...policy, mode: "off" as const, paidApi: "standard" as const };
    expect(routeRoutine({ policy: leftover, preferences: [sonnetRule] })).toBeNull();
    expect(
      learnedPreferenceBillingBlock(apiSonnet, {
        providers: [claude, claudeApi],
        lanes: { complex: [], routine: [] },
        policy: leftover,
      }),
    ).toContain("billed per token");
    // Absent mode reads as off too.
    expect(
      routeRoutine({ policy: { ...policy, paidApi: "standard" }, preferences: [sonnetRule] }),
    ).toBeNull();
  });

  it("does not let a refused coordinator rule shadow the person's own rule", () => {
    const { taskClass } = classifyTask({ text: "Fix the typo in README" });
    const own = preference({
      id: "own",
      keywords: ["typo"],
      taskClass,
      action: { kind: "prefer", model: sonnet },
      recordedBy: "person",
      createdAt: "2026-10-20T00:00:00.000Z",
    });
    // Same score (keywords + task class), newer, refused for billing.
    const coordinator = preference({
      id: "coordinator",
      keywords: ["readme"],
      taskClass,
      action: { kind: "prefer", model: apiOpus },
      recordedBy: "coordinator",
      createdAt: "2026-10-21T00:00:00.000Z",
    });
    expect(routeRoutine({ preferences: [own] })?.decision.selection).toEqual(sonnet);
    const result = routeRoutine({ preferences: [own, coordinator] });
    expect(result?.decision).toMatchObject({ moved: true, selection: sonnet });
    expect(result?.decision.skipped?.[0]).toContain("billed per token");
    // A refused unattributed (legacy) rule falls through the same way.
    const { recordedBy: _author, ...legacy } = coordinator;
    expect(routeRoutine({ preferences: [own, legacy] })?.decision.selection).toEqual(sonnet);
  });

  it("honours a model its provider reports as subscription-billed (OpenCode Go on Pi)", () => {
    // Pi signs in as `pi`, which names no plan; the model's own billing does.
    const goModel = "opencode-go/kimi-k3";
    const pi = provider(
      "pi",
      "pi",
      [{ ...model(goModel, "Kimi K3"), billing: "subscription" }],
      { auth: { status: "authenticated", type: "pi" } },
      null,
    );
    const go = sel("pi", goModel);
    const input = { providers: [claude, pi], lanes: { complex: [], routine: [] }, policy };
    expect(learnedPreferenceBillingBlock(go, input)).toBeNull();
    expect(
      routeRoutine({
        providers: [claude, pi],
        preferences: [preference({ lane: "routine", action: { kind: "prefer", model: go } })],
      })?.decision,
    ).toMatchObject({ moved: true, selection: go, billing: "subscription" });
    // A per-token sign-in still bills every model, whatever the model reports.
    const keyed = { ...pi, auth: { status: "authenticated" as const, type: "apiKey" } };
    expect(learnedPreferenceBillingBlock(go, { ...input, providers: [claude, keyed] })).toContain(
      "billed per token",
    );
  });

  it("keeps a subscription preference working", () => {
    const sub = preference({ lane: "routine", action: { kind: "prefer", model: sonnet } });
    expect(routeRoutine({ preferences: [sub] })?.decision).toMatchObject({
      moved: true,
      selection: sonnet,
    });
  });
});
