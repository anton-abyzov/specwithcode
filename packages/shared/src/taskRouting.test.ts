import * as DateTime from "effect/DateTime";
import {
  DEFAULT_TASK_ROUTING_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
  type TaskRoutingSettings,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  billingOf,
  classTier,
  classifyTask,
  contextWindowTokens,
  modelTier,
  planTranscriptChunks,
  resolveTaskRouting,
  routingPromptNote,
  taskRoutingConflicts,
} from "./taskRouting.ts";

const now = Date.parse("2026-10-20T20:00:00.000Z");

const contextWindow = {
  id: "contextWindow",
  label: "Context",
  type: "select" as const,
  options: [
    { id: "200k", label: "200k", isDefault: true },
    { id: "1m", label: "1M" },
  ],
};

function model(
  slug: string,
  name: string,
  over: Partial<ServerProviderModel> = {},
): ServerProviderModel {
  return {
    slug,
    name,
    isCustom: false,
    capabilities: { optionDescriptors: [contextWindow] },
    ...over,
  };
}

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
    auth: { status: "authenticated" },
    checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
    version: null,
    models: [...models],
    slashCommands: [],
    skills: [],
    ...(used === null
      ? {}
      : {
          usageLimits: {
            checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
            windows: [
              {
                id: "five_hour",
                kind: "session" as const,
                label: "Session",
                usedPercent: used,
                resetsAt: "2026-10-20T23:00:00.000Z",
              },
            ],
          },
        }),
    ...over,
  };
}

/** The live M4 catalog of October 20, 2026, trimmed to what routing reads. */
const claude = provider("claudeAgent", "claudeAgent", [
  model("claude-opus-5-5", "Claude Opus 5.5"),
  model("claude-fable-5-1", "Claude Fable 5.1"),
  model("claude-sonnet-5-5", "Claude Sonnet 5.5"),
  model("claude-haiku-5-5", "Claude Haiku 5.5", { capabilities: null }),
  model("claude-sonnet-5", "Claude Sonnet 5"),
  model("claude-haiku-4-5", "Claude Haiku 4.5", { isLegacy: true }),
]);
const copilotMine = provider(
  "copilot-0889",
  "acpRegistry",
  [
    model("auto", "Auto", { capabilities: null }),
    model("claude-sonnet-5.5", "Claude Sonnet 5.5", { capabilities: null }),
    model("claude-opus-5.5", "Claude Opus 5.5", { capabilities: null }),
    model("claude-haiku-5.5", "Claude Haiku 5.5", { capabilities: null }),
    model("gpt-6.1-sol", "GPT-6.1-Sol", { capabilities: null }),
  ],
  { displayName: "GitHub Copilot (your install)" },
  null,
);
const copilotManaged = provider(
  "acpRegistry_copilot",
  "acpRegistry",
  copilotMine.models,
  { displayName: "GitHub Copilot (SpecWithCode-managed)" },
  null,
);
const codex = provider("codex", "codex", [
  model("gpt-6.1-sol", "GPT-6.1-Sol", { capabilities: null }),
  model("gpt-6-luna", "GPT-6-Luna", { capabilities: null }),
]);
const providers = [claude, codex, copilotMine, copilotManaged];

const opus = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" };
const auto: TaskRoutingSettings = { ...DEFAULT_TASK_ROUTING_SETTINGS, mode: "auto" };

function route(
  text: string,
  over: Partial<Parameters<typeof resolveTaskRouting>[0]> = {},
  extra: Partial<Parameters<typeof classifyTask>[0]> = {},
) {
  return resolveTaskRouting({
    policy: auto,
    classification: classifyTask({ text, ...extra }),
    baseline: opus,
    providers,
    nowMs: now,
    switchAtPercent: 95,
    ...over,
  });
}

describe("modelTier", () => {
  it("places the live Claude and Copilot spellings and leaves unknown families out", () => {
    expect(modelTier({ slug: "claude-sonnet-5-5" })).toBe("standard");
    expect(modelTier({ slug: "claude-sonnet-5.5" })).toBe("standard");
    expect(modelTier({ slug: "claude-haiku-5-5" })).toBe("economy");
    expect(modelTier({ slug: "claude-opus-5-5" })).toBe("frontier");
    expect(modelTier({ slug: "claude-fable-5-1" })).toBe("frontier");
    expect(modelTier({ slug: "gpt-5.4-mini" })).toBe("economy");
    expect(modelTier({ slug: "gemini-3.5-flash-lite" })).toBe("economy");
    expect(modelTier({ slug: "gemini-3.8-flash" })).toBe("standard");
    expect(modelTier({ slug: "gemini-3.1-pro-preview" })).toBe("frontier");
    expect(modelTier({ slug: "gpt-6.1-sol" })).toBeNull();
    expect(modelTier({ slug: "auto" })).toBeNull();
    expect(modelTier({ slug: "grok-4.7" })).toBeNull();
  });
});

describe("classifyTask", () => {
  it("labels routine work from its words without a model call", () => {
    expect(classifyTask({ text: "Translate the onboarding emails into Spanish" })).toMatchObject({
      taskClass: "translation",
      confidence: "high",
    });
    expect(classifyTask({ text: "Summarize yesterday's meeting notes" }).taskClass).toBe("summary");
    expect(
      classifyTask({ text: "Research which charting libraries support SVG export" }).taskClass,
    ).toBe("research");
  });

  it("tells a first animation draft from a final render", () => {
    expect(classifyTask({ text: "Make a first draft of the promo animation" })).toMatchObject({
      taskClass: "animation-draft",
      confidence: "high",
    });
    expect(classifyTask({ text: "Render the final animation for publishing" })).toMatchObject({
      taskClass: "animation-final",
    });
    expect(classifyTask({ text: "Animate the logo" }).taskClass).toBe("animation-final");
  });

  it("marks mixed or high-risk signals uncertain", () => {
    expect(classifyTask({ text: "Translate the legal contract for the client" }).confidence).toBe(
      "uncertain",
    );
    expect(
      classifyTask({ text: "Translate the strings and refactor the i18n loader" }).confidence,
    ).toBe("uncertain");
    expect(classifyTask({ text: "Do the thing" })).toMatchObject({
      taskClass: "general",
      confidence: "uncertain",
    });
  });

  it("keeps release notes routine", () => {
    expect(classifyTask({ text: "Summarize the release notes" }).confidence).toBe("high");
  });

  it("lets a caller's hint win", () => {
    expect(classifyTask({ text: "Do the thing", hint: "translation" })).toMatchObject({
      taskClass: "translation",
      confidence: "hint",
    });
  });

  it("knows long audio needs speech-to-text before any text model", () => {
    const fromWords = classifyTask({ text: "Process an hour of speech from the keynote" });
    expect(fromWords).toMatchObject({
      taskClass: "transcript",
      needsTranscription: true,
      audioMinutes: 60,
    });
    const fromFile = classifyTask({
      text: "Pull the action items out of this",
      attachments: [{ name: "standup.m4a", mimeType: "audio/mp4" }],
    });
    expect(fromFile).toMatchObject({ taskClass: "transcript", needsTranscription: true });
    expect(classifyTask({ text: "Summarize the 90 minute interview transcript" })).toMatchObject({
      taskClass: "transcript",
      needsTranscription: false,
      audioMinutes: 90,
    });
  });
});

describe("classTier", () => {
  it("follows quality and overrides but never drops final or high-risk work below standard", () => {
    expect(classTier("translation", auto)).toBe("standard");
    expect(classTier("translation", { ...auto, quality: "economy" })).toBe("economy");
    expect(classTier("animation-draft", { ...auto, quality: "economy" })).toBe("standard");
    expect(classTier("translation", { ...auto, quality: "best" })).toBe("frontier");
    expect(classTier("code", { ...auto, classTiers: { code: "economy" } })).toBe("standard");
    expect(classTier("general", { ...auto, classTiers: { general: "economy" } })).toBe("frontier");
    expect(classTier("summary", { ...auto, classTiers: { summary: "economy" } })).toBe("economy");
  });
});

describe("resolveTaskRouting", () => {
  it("moves a translation from Opus 5.5 to Sonnet 5.5 on the same subscription", () => {
    const decision = route("Translate the onboarding emails into Spanish");
    expect(decision).toMatchObject({
      taskClass: "translation",
      moved: true,
      tier: "standard",
      selection: { instanceId: "claudeAgent", model: "claude-sonnet-5-5" },
      baseline: opus,
      escalation: opus,
      billing: "subscription",
    });
    expect(decision.reason).toContain("Claude Sonnet 5.5 instead of Claude Opus 5.5");
  });

  it("keeps final and high-risk work on the baseline", () => {
    expect(route("Implement the billing endpoint").moved).toBe(false);
    expect(route("Review PR 501 before merge").moved).toBe(false);
    expect(route("Design the settings page layout").moved).toBe(false);
    expect(route("Render the final animation for publishing").moved).toBe(false);
    expect(route("Translate the legal contract").moved).toBe(false);
  });

  it("lets a first animation draft run on Sonnet", () => {
    expect(route("First draft of the explainer animation storyboard")).toMatchObject({
      taskClass: "animation-draft",
      moved: true,
      selection: { model: "claude-sonnet-5-5" },
    });
  });

  it("never moves above the baseline", () => {
    const sonnet = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-sonnet-5-5",
    };
    expect(route("Implement the endpoint", { baseline: sonnet })).toMatchObject({
      moved: false,
      selection: sonnet,
    });
  });

  it("holds the minimum tier floor", () => {
    const decision = route("Translate the emails", {
      policy: { ...auto, minimumTier: "frontier" },
    });
    expect(decision.moved).toBe(false);
    expect(decision.reason).toContain("Minimum tier Frontier");
    expect(
      route("Translate the emails", {
        policy: { ...auto, quality: "economy", minimumTier: "standard" },
      }).selection.model,
    ).toBe("claude-sonnet-5-5");
  });

  it("uses economy only when the policy allows it, skipping legacy models", () => {
    expect(
      route("Translate the emails", { policy: { ...auto, classTiers: { translation: "economy" } } })
        .selection,
    ).toEqual({ instanceId: "claudeAgent", model: "claude-haiku-5-5" });
  });

  it("skips excluded and unavailable providers and keeps the two Copilot instances apart", () => {
    const excluded = route("Translate the emails", {
      policy: { ...auto, excludedProviders: [ProviderInstanceId.make("claudeAgent")] },
    });
    expect(excluded.selection).toEqual({ instanceId: "copilot-0889", model: "claude-sonnet-5.5" });
    const bothOut = route("Translate the emails", {
      policy: {
        ...auto,
        excludedProviders: [
          ProviderInstanceId.make("claudeAgent"),
          ProviderInstanceId.make("copilot-0889"),
        ],
      },
    });
    expect(bothOut.selection).toEqual({
      instanceId: "acpRegistry_copilot",
      model: "claude-sonnet-5.5",
    });
    const unavailable = route("Translate the emails", {
      providers: [{ ...claude, status: "error" }, codex],
    });
    expect(unavailable.moved).toBe(false);
    expect(unavailable.reason).toContain("No Standard model is eligible");
  });

  it("treats a subscription past the switch threshold as no room", () => {
    const full = provider("claudeAgent", "claudeAgent", claude.models, {}, 97);
    const decision = route("Translate the emails", {
      providers: [full, codex, copilotMine, copilotManaged],
      baseline: { instanceId: ProviderInstanceId.make("copilot-0889"), model: "claude-opus-5.5" },
    });
    expect(decision.selection).toEqual({ instanceId: "copilot-0889", model: "claude-sonnet-5.5" });
  });

  it("keeps the baseline when no model is eligible and says why", () => {
    const decision = route("Translate the emails", {
      providers: [claude],
      limitedInstanceIds: new Set(["claudeAgent"]),
    });
    expect(decision).toMatchObject({ moved: false, selection: opus, escalation: null });
    expect(decision.reason).toContain("at its usage limit");
  });

  it("never picks a per-token provider unless the paid-API cap allows that tier", () => {
    const console = provider("claude-console", "claudeAgent", claude.models, {
      auth: { status: "authenticated", apiKeyBilling: true },
    });
    const only = [{ ...claude, status: "error" as const }, console];
    expect(route("Translate the emails", { providers: only }).moved).toBe(false);
    expect(
      route("Translate the emails", { providers: only, policy: { ...auto, paidApi: "economy" } })
        .moved,
    ).toBe(false);
    const paid = route("Translate the emails", {
      providers: only,
      policy: { ...auto, paidApi: "standard" },
    });
    expect(paid).toMatchObject({
      moved: true,
      billing: "api",
      selection: { instanceId: "claude-console" },
    });
  });

  it("treats API-key sign-ins under any driver name, and unknown sign-ins, as paid", () => {
    const flash = [model("gemini-3.8-flash-high", "Gemini 3.8 Flash High", { capabilities: null })];
    const gemini = provider("antigravity", "antigravity", flash, {
      auth: { status: "authenticated", type: "gemini-api-key" },
    });
    const cursor = provider("cursor", "cursor", flash, {
      auth: { status: "authenticated", type: "api-key" },
    });
    const mystery = provider("mystery", "acpRegistry", flash, {
      auth: { status: "authenticated", type: "workspace-token" },
    });
    expect(billingOf(gemini)).toBe("api");
    expect(billingOf(cursor)).toBe("api");
    expect(billingOf(mystery)).toBe("unknown");
    // OpenCode reports no sign-in type and may run on any API key.
    expect(billingOf(provider("opencode", "opencode", flash))).toBe("unknown");
    expect(billingOf(copilotMine)).toBe("subscription");
    expect(billingOf(claude)).toBe("subscription");
    expect(
      billingOf({ ...claude, auth: { status: "authenticated", type: "max", label: "Claude Max" } }),
    ).toBe("subscription");
    expect(
      billingOf(
        provider("codex", "codex", [], { auth: { status: "authenticated", type: "chatgpt" } }),
      ),
    ).toBe("subscription");
    // Claude's Sonnet is excluded, so only the paid or unknown Flash models could take the work.
    const policy = {
      ...auto,
      excludedProviders: ["claudeAgent", "copilot-0889", "acpRegistry_copilot"].map((id) =>
        ProviderInstanceId.make(id),
      ),
    };
    const opencode = provider("opencode", "opencode", flash);
    for (const only of [gemini, cursor, mystery, opencode]) {
      const decision = route("Translate the emails", { providers: [claude, only], policy });
      expect(decision).toMatchObject({ moved: false, selection: opus });
    }
    expect(
      route("Translate the emails", {
        providers: [claude, gemini],
        policy: { ...policy, paidApi: "standard" },
      }),
    ).toMatchObject({ moved: true, billing: "api", selection: { instanceId: "antigravity" } });
  });

  it("keeps a baseline whose tier is unknown", () => {
    const sol = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" };
    expect(route("Translate the emails", { baseline: sol })).toMatchObject({
      moved: false,
      selection: sol,
    });
  });

  it("records no escalation when the policy turns it off", () => {
    expect(
      route("Translate the emails", { policy: { ...auto, escalate: false } }).escalation,
    ).toBeNull();
  });

  it("plans long audio as ASR, then chunks sized to the routed model, then processing", () => {
    const decision = route("Process an hour of speech from the keynote into chapter notes");
    expect(decision).toMatchObject({
      taskClass: "transcript",
      moved: true,
      selection: { model: "claude-sonnet-5-5" },
      chunking: { estimatedTokens: 12_000, maxTokensPerChunk: 100_000, chunks: 1 },
    });
    expect(decision.pipeline?.[0]).toMatch(/speech-to-text \(ASR\).*never reads audio/);
    expect(routingPromptNote(decision)).toContain("stop and report that as a blocker");
    const long = route("Process the 20 hour conference recording");
    expect(long.chunking?.chunks).toBe(3);
  });
});

describe("planTranscriptChunks", () => {
  it("sizes chunks from the context window and the input", () => {
    expect(contextWindowTokens(claude.models[2])).toBe(200_000);
    expect(contextWindowTokens(claude.models[3])).toBeNull();
    expect(planTranscriptChunks({ chars: 2_000_000 }, 200_000)).toEqual({
      estimatedTokens: 500_000,
      maxTokensPerChunk: 100_000,
      chunks: 5,
    });
    expect(planTranscriptChunks({ minutes: 60 }, null)).toEqual({
      estimatedTokens: 12_000,
      maxTokensPerChunk: 50_000,
      chunks: 1,
    });
    expect(planTranscriptChunks({}, 200_000)).toBeNull();
  });
});

describe("taskRoutingConflicts", () => {
  it("names a floor that overrides classes and a project worker model Auto may leave", () => {
    const notes = taskRoutingConflicts({
      policy: { ...auto, minimumTier: "frontier" },
      providers,
      projectWorkerModel: opus,
    });
    expect(notes[0]).toContain("Minimum tier Frontier overrides Translation");
    expect(notes[1]).toContain("start on Claude Opus 5.5");
    expect(taskRoutingConflicts({ policy: DEFAULT_TASK_ROUTING_SETTINGS, providers })).toEqual([]);
  });

  it("warns when every provider of a tier in use is excluded", () => {
    const notes = taskRoutingConflicts({
      policy: {
        ...auto,
        excludedProviders: ["claudeAgent", "copilot-0889", "acpRegistry_copilot"].map((id) =>
          ProviderInstanceId.make(id),
        ),
      },
      providers,
    });
    expect(notes.some((note) => note.includes("Standard model"))).toBe(true);
  });
});

describe("taskRouting persistence", () => {
  it("replaces the whole policy on patch, so a cleared class tier and exclusion stay cleared", async () => {
    const { DEFAULT_SERVER_SETTINGS } = await import("@specweave-studio/contracts");
    const { applyServerSettingsPatch } = await import("./serverSettings.ts");
    const before = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      taskRouting: {
        ...auto,
        classTiers: { translation: "economy" },
        excludedProviders: [ProviderInstanceId.make("copilot-0889")],
      },
    });
    expect(before.taskRouting.classTiers).toEqual({ translation: "economy" });
    const after = applyServerSettingsPatch(before, { taskRouting: auto });
    expect(after.taskRouting).toEqual(auto);
  });
});
