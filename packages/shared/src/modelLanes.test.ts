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
const policy = { excludedProviders: [], escalate: true };

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
    expect(classifyLaneByRules({ text: "Brainstorm creative names for the launch campaign" }).lane).toBe(
      "complex",
    );
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
    expect(
      preferenceMatch(rule, { text: "x" }, { taskClass: "translation" }, "routine"),
    ).toBe(1);
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
        { ...codex, usageLimits: { ...codex.usageLimits!, windows: [{ ...codex.usageLimits!.windows[0]!, usedPercent: 97 }] } },
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
    expect(
      route("Fix the typo", { runnableInstanceIds: new Set(["codex"]) })?.selection,
    ).toEqual(astra);
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
    const apiClaude = { ...claude, auth: { status: "authenticated" as const, apiKeyBilling: true } };
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
    const second = preference({ id: "b", keywords: ["Video"], action: { kind: "prefer", model: sol } });
    expect(withLearnedPreference([first], second, 40).map((rule) => rule.id)).toEqual(["b"]);
    const many = Array.from({ length: 3 }, (_, index) =>
      preference({ id: `r${index}`, keywords: [`k${index}`] }),
    );
    expect(withLearnedPreference(many, first, 3).map((rule) => rule.id)).toEqual([
      "r1",
      "r2",
      "a",
    ]);
  });

  it("describes a rule in words", () => {
    expect(describePreference(preference({ keywords: ["translate"] }), providers)).toBe(
      '"translate": use claudeAgent · Claude Sonnet 5.5',
    );
  });
});

