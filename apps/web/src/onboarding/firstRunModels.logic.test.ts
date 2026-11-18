import {
  MODEL_TRACKS,
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { describeTrack } from "@specweave-studio/shared/modelTrackRules";
import { describe, expect, it } from "vite-plus/test";

import {
  firstRunModels,
  type ModelLine,
  modelBrand,
  modelTrackLists,
  type ModelTrackSettings,
  readyAgents,
  savedModelTracks,
} from "./firstRunModels.logic";

const now = Date.parse("2026-11-18T18:00:00.000Z");
const checkedAt = "2026-11-18T17:59:00.000Z";

function agent(
  id: string,
  driver: string,
  models: ReadonlyArray<readonly [slug: string, name: string]>,
  over: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    version: null,
    models: models.map(([slug, name]) => ({ slug, name, isCustom: false, capabilities: null })),
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt,
      windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 20 }],
    },
    ...over,
  };
}

const claude = agent("claudeAgent", "claudeAgent", [
  ["claude-opus-5-5", "Claude Opus 5.5"],
  ["claude-sonnet-5-5", "Claude Sonnet 5.5"],
  ["claude-fable-5-2", "Claude Fable 5.2"],
]);
const codex = agent("codex", "codex", [
  ["gpt-6.1-sol", "GPT-6.1 Sol"],
  ["gpt-6-astra", "GPT-6 Astra"],
  ["gpt-6-luna", "GPT-6 Luna"],
]);
const muse = agent("muse", "muse", [["muse-wonder-1.0", "Muse Wonder 1.0"]]);
const gemini = agent("gemini", "acpRegistry", [["gemini-4-carbon", "Gemini 4 Carbon"]]);
const copilot = agent(
  "copilot",
  "acpRegistry",
  [
    ["claude-opus-5.5", "Claude Opus 5.5"],
    ["gpt-6.1-sol", "GPT-6.1 Sol"],
    ["gpt-6-luna", "GPT-6 Luna"],
  ],
  { iconUrl: "https://cdn.agentclientprotocol.com/registry/v1/latest/github-copilot-cli.svg" },
);
const FIVE = [claude, codex, muse, gemini, copilot] as const;

const signedOut = (provider: ServerProvider): ServerProvider => ({
  ...provider,
  status: "error",
  auth: { status: "unauthenticated" },
});

const builtIn: ModelTrackSettings = { adversarialReview: { reviewers: [] } };
const sel = (instanceId: string, model: string): ModelSelection => ({
  instanceId: ProviderInstanceId.make(instanceId),
  model,
});

function subsets<T>(items: ReadonlyArray<T>): ReadonlyArray<ReadonlyArray<T>> {
  return Array.from({ length: 2 ** items.length }, (_, mask) =>
    items.filter((_, index) => (mask & (1 << index)) !== 0),
  );
}

/** What Settings > Models draws for a track: its rows that name a model a source runs. */
function editorList(
  settings: ModelTrackSettings,
  providers: ReadonlyArray<ServerProvider>,
): Record<string, ReadonlyArray<ModelSelection>> {
  const saved = savedModelTracks(settings);
  return Object.fromEntries(
    MODEL_TRACKS.map((track) => [
      track,
      describeTrack({
        track,
        saved: saved[track],
        providers,
        sourceOrder: settings.defaultModelProviders ?? [],
        nowMs: now,
      }).flatMap((row) => (row.selection === null ? [] : [row.selection])),
    ]),
  );
}

const names = (line: ModelLine | undefined) =>
  line?.kind === "models" ? line.shown.map((entry) => entry.name) : line?.kind;
const lineOf = (result: ReturnType<typeof firstRunModels>, track: string) =>
  result.kind === "lines" ? result.lines.find((line) => line.track === track) : undefined;

describe("modelTrackLists", () => {
  const variants: ReadonlyArray<readonly [string, ModelTrackSettings]> = [
    ["built-in tracks", builtIn],
    [
      "saved lanes and reviewers",
      {
        modelLanes: {
          routine: [sel("codex", "gpt-6.1-sol"), sel("claudeAgent", "claude-sonnet-5-5")],
          complex: [sel("claudeAgent", "claude-fable-5-2")],
        },
        adversarialReview: { reviewers: [sel("muse", "muse-wonder-1.0")] },
      },
    ],
    [
      "a saved Sources order",
      {
        adversarialReview: { reviewers: [] },
        defaultModelProviders: [ProviderInstanceId.make("copilot")],
      },
    ],
  ];

  for (const [label, settings] of variants) {
    it(`gives the lists Settings > Models shows, for every set of ready agents (${label})`, () => {
      for (const ready of subsets(FIVE)) {
        expect(modelTrackLists(settings, ready), ready.map((p) => p.instanceId).join("+")).toEqual(
          editorList(settings, ready),
        );
      }
    });
  }
});

describe("firstRunModels", () => {
  it("shows the three lists with Claude Code and Codex ready", () => {
    const result = firstRunModels({ settings: builtIn, providers: [claude, codex] });
    expect(names(lineOf(result, "daily"))).toEqual([
      "Claude Opus 5.5",
      "GPT-6.1 Sol",
      "GPT-6 Luna",
    ]);
    expect(names(lineOf(result, "complex"))).toEqual(["Claude Fable 5.2", "GPT-6 Astra"]);
    expect(names(lineOf(result, "review"))).toEqual(["GPT-6.1 Sol"]);
  });

  it("names three models, then counts the rest", () => {
    const result = firstRunModels({ settings: builtIn, providers: [claude, codex, muse] });
    const daily = lineOf(result, "daily");
    expect(names(daily)).toEqual(["Claude Opus 5.5", "GPT-6.1 Sol", "Muse Wonder 1.0"]);
    expect(daily?.kind === "models" && daily.more).toBe(1);
  });

  it("reads one line when no agent is ready", () => {
    expect(firstRunModels({ settings: builtIn, providers: [] })).toEqual({ kind: "none-ready" });
    expect(firstRunModels({ settings: builtIn, providers: null })).toEqual({ kind: "none-ready" });
    expect(
      firstRunModels({ settings: builtIn, providers: [signedOut(claude), signedOut(codex)] }),
    ).toEqual({ kind: "none-ready" });
  });

  it("fits only ready agents: a signed-out Codex adds no GPT model and no reviewer", () => {
    const result = firstRunModels({ settings: builtIn, providers: [claude, signedOut(codex)] });
    expect(names(lineOf(result, "daily"))).toEqual(["Claude Opus 5.5"]);
    expect(names(lineOf(result, "complex"))).toEqual(["Claude Fable 5.2"]);
    expect(lineOf(result, "review")).toEqual({
      track: "review",
      kind: "no-reviewer",
      examples: [
        { name: "Codex", brand: "openai" },
        { name: "Muse Code", brand: "meta" },
      ],
    });
  });

  it("never offers a reviewer of the family already doing the everyday work", () => {
    const onlyCodex = firstRunModels({ settings: builtIn, providers: [codex] });
    expect(names(lineOf(onlyCodex, "daily"))).toEqual(["GPT-6.1 Sol", "GPT-6 Luna"]);
    const review = lineOf(onlyCodex, "review");
    expect(review?.kind).toBe("no-reviewer");
    expect(review?.kind === "no-reviewer" && review.examples.map((e) => e.name)).toEqual([
      "Muse Code",
      "Claude Code",
    ]);
    const onlyMuse = lineOf(firstRunModels({ settings: builtIn, providers: [muse] }), "review");
    expect(onlyMuse?.kind === "no-reviewer" && onlyMuse.examples.map((e) => e.name)).toEqual([
      "Codex",
      "Claude Code",
    ]);
  });

  it("marks a list none of the ready agents runs", () => {
    const result = firstRunModels({ settings: builtIn, providers: [muse] });
    expect(names(lineOf(result, "daily"))).toEqual(["Muse Wonder 1.0"]);
    expect(lineOf(result, "complex")).toEqual({ track: "complex", kind: "empty" });
  });

  it("never names a model of the everyday family on the Review line, for any ready set", () => {
    for (const ready of subsets(FIVE)) {
      const result = firstRunModels({ settings: builtIn, providers: ready });
      if (result.kind !== "lines") continue;
      const daily = lineOf(result, "daily");
      const review = lineOf(result, "review");
      if (daily?.kind !== "models" || review?.kind !== "no-reviewer") continue;
      const family = daily.shown[0]!.brand;
      expect(review.examples.map((example) => example.brand)).not.toContain(family);
    }
  });

  it("leaves out a saved entry that nothing ready runs, and names it by its listing", () => {
    const saved: ModelTrackSettings = {
      modelLanes: {
        routine: [sel("codex", "gpt-6.1-sol"), sel("claudeAgent", "claude-opus-5-5")],
        complex: [],
      },
      adversarialReview: { reviewers: [sel("codex", "gpt-6.1-sol")] },
    };
    const result = firstRunModels({ settings: saved, providers: [claude, signedOut(codex)] });
    expect(names(lineOf(result, "daily"))).toEqual(["Claude Opus 5.5"]);
    expect(lineOf(result, "review")?.kind).toBe("no-reviewer");
    // Copilot is ready and runs the same model, so the saved Codex entry stays, by its name.
    const viaCopilot = firstRunModels({
      settings: saved,
      providers: [claude, signedOut(codex), copilot],
    });
    expect(names(lineOf(viaCopilot, "daily"))).toEqual(["GPT-6.1 Sol", "Claude Opus 5.5"]);
    expect(names(lineOf(viaCopilot, "review"))).toEqual(["GPT-6.1 Sol"]);
  });

  it("names a saved entry whose agent is gone by the ready agent that runs it", () => {
    const saved: ModelTrackSettings = {
      modelLanes: { routine: [sel("codex", "gpt-6.1-sol")], complex: [] },
      adversarialReview: { reviewers: [sel("codex", "gpt-6.1-sol")] },
    };
    const result = firstRunModels({ settings: saved, providers: [claude, copilot] });
    expect(names(lineOf(result, "daily"))).toEqual(["GPT-6.1 Sol"]);
    expect(names(lineOf(result, "review"))).toEqual(["GPT-6.1 Sol"]);
  });

  it("shows saved one-family lists as lists while a second family is ready", () => {
    const claudeOnly: ModelTrackSettings = {
      modelLanes: {
        routine: [sel("claudeAgent", "claude-opus-5-5")],
        complex: [sel("claudeAgent", "claude-fable-5-2")],
      },
      adversarialReview: { reviewers: [sel("claudeAgent", "claude-fable-5-2")] },
    };
    const withCodex = firstRunModels({ settings: claudeOnly, providers: [claude, codex] });
    expect(names(lineOf(withCodex, "review"))).toEqual(["Claude Fable 5.2"]);
    const alone = firstRunModels({ settings: claudeOnly, providers: [claude] });
    expect(lineOf(alone, "review")?.kind).toBe("no-reviewer");
  });

  it("treats models of no known family as the runtime does: each only matches itself", () => {
    const qwen = agent("qwen", "acpRegistry", [["qwen-4-coder", "Qwen 4 Coder"]]);
    const deepseek = agent("deepseek", "acpRegistry", [["deepseek-v5", "DeepSeek V5"]]);
    const saved: ModelTrackSettings = {
      modelLanes: { routine: [sel("qwen", "qwen-4-coder")], complex: [] },
      adversarialReview: { reviewers: [sel("deepseek", "deepseek-v5")] },
    };
    const both = firstRunModels({ settings: saved, providers: [qwen, deepseek] });
    expect(names(lineOf(both, "review"))).toEqual(["DeepSeek V5"]);
    const ownReviewer = firstRunModels({
      settings: { ...saved, adversarialReview: { reviewers: [sel("qwen", "qwen-4-coder")] } },
      providers: [qwen],
    });
    expect(lineOf(ownReviewer, "review")?.kind).toBe("no-reviewer");
  });

  it("shows a saved same-family reviewer while a second family is ready", () => {
    const result = firstRunModels({
      settings: { adversarialReview: { reviewers: [sel("claudeAgent", "claude-fable-5-2")] } },
      providers: [claude, codex],
    });
    expect(names(lineOf(result, "review"))).toEqual(["Claude Fable 5.2"]);
  });

  it("gives every model a provider mark: Claude, OpenAI for GPT, Meta for Muse", () => {
    for (const ready of subsets(FIVE)) {
      const result = firstRunModels({ settings: builtIn, providers: ready });
      if (result.kind !== "lines") continue;
      for (const line of result.lines) {
        const entries =
          line.kind === "models" ? line.shown : line.kind === "no-reviewer" ? line.examples : [];
        for (const entry of entries) expect(entry.brand, entry.name).not.toBeNull();
      }
    }
    expect(modelBrand({ slug: "claude-opus-5-5" })).toBe("claude");
    expect(modelBrand({ slug: "gpt-6.1-sol" })).toBe("openai");
    expect(modelBrand({ slug: "muse-wonder-1.0" })).toBe("meta");
    expect(modelBrand({ slug: "gemini-4-carbon" })).toBe("gemini");
    expect(modelBrand({ slug: "some-local-model" })).toBeNull();
  });

  it("counts an agent as ready only when it is installed, on and signed in", () => {
    expect(
      readyAgents([
        claude,
        signedOut(codex),
        { ...muse, enabled: false },
        { ...gemini, installed: false },
      ]).map((provider) => provider.instanceId),
    ).toEqual(["claudeAgent"]);
  });
});
