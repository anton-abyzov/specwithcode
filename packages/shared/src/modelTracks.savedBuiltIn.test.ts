/**
 * 1339 (PR 532 B2): an effort change on a built-in track saves the list. The
 * saved list must read and run like the built-in one it came from: every
 * entry kept, each still on the newest release of its family, only the
 * changed row's level different.
 */
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { describeTrack, savedBuiltInTrack, type TrackRow } from "./modelTrackRules.ts";
import {
  followsBuiltInFamily,
  launchTrackLanes,
  projectDraftModelSelection,
} from "./modelTracks.ts";
import { reviewerChain } from "./adversarialReview.ts";
import { reviewOnlyModel } from "./regularTrack.ts";

const nowMs = Date.parse("2026-11-19T09:00:00.000Z");
const levels = (optionId: string) => ({
  optionDescriptors: [
    {
      id: optionId,
      label: "Reasoning effort",
      type: "select" as const,
      options: ["low", "medium", "high", "xhigh"].map((id) => ({ id, label: id })),
    },
  ],
});

function provider(
  instanceId: string,
  driver: string,
  models: ReadonlyArray<{ slug: string; name: string }>,
  optionId: string,
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    displayName: instanceId,
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-19T09:00:00.000Z",
    version: null,
    models: models.map((model) => ({ ...model, isCustom: false, capabilities: levels(optionId) })),
    slashCommands: [],
    skills: [],
  } as unknown as ServerProvider;
}

const claude = provider(
  "claudeAgent",
  "claudeAgent",
  [{ slug: "claude-opus-5-5", name: "Claude Opus 5.5" }],
  "effort",
);
// Codex lists only the older Sol release here.
const codex = provider(
  "codex",
  "codex",
  [{ slug: "gpt-6.1-sol", name: "GPT-6.1-Sol" }],
  "reasoningEffort",
);
const codex62 = provider(
  "codex",
  "codex",
  [
    { slug: "gpt-6.1-sol", name: "GPT-6.1-Sol" },
    { slug: "gpt-6.2-sol", name: "GPT-6.2-Sol" },
  ],
  "reasoningEffort",
);
const muse = provider(
  "muse",
  "muse",
  [
    { slug: "muse-wonder-full-1.0", name: "muse-wonder-full-1.0" },
    { slug: "muse-wonder-1.0", name: "muse-wonder-1.0" },
  ],
  "reasoningEffort",
);
const copilot = {
  ...provider(
    "acpRegistry_copilot",
    "acpRegistry",
    [{ slug: "gemini-4-neon", name: "Gemini 4 Neon" }],
    "reasoningEffort",
  ),
  iconUrl: "https://cdn.agentclientprotocol.com/registry/v1/latest/github-copilot-cli.svg",
};

const view = (rows: ReadonlyArray<TrackRow>) =>
  rows.map((row) => ({
    name: row.name,
    sources: row.sources.map((source) => `${source.provider.instanceId}/${source.slug}`),
    follows: row.follows,
  }));
const slugs = (entries: ReadonlyArray<ModelSelection>) =>
  entries.map((entry) => `${entry.instanceId}/${entry.model}`);

/** The built-in rows, and the list an effort change on `name`'s row saves. */
function saveEffort(
  track: "daily" | "review",
  providers: ReadonlyArray<ServerProvider>,
  name: string,
  value: string,
) {
  const rows = describeTrack({ track, saved: [], providers, nowMs });
  const at = rows.findIndex((row) => row.name === name);
  const row = rows[at]!;
  const optionId = row.selection!.options![0]!.id;
  const saved = savedBuiltInTrack({
    rows,
    at,
    selection: { ...row.selection!, options: [{ id: optionId, value }] },
  });
  return { rows, saved };
}

describe("a built-in track saved by an effort change", () => {
  it("keeps every built-in entry by its maker's name, unlisted ones on the maker's harness", () => {
    const { saved } = saveEffort("daily", [claude, codex], "GPT-6.1-Sol", "high");
    expect(saved).toEqual([
      {
        instanceId: "claudeAgent",
        model: "claude-opus-5-5",
        options: [{ id: "effort", value: "medium" }],
      },
      { instanceId: "claudeAgent", model: "claude-sonnet-5-5" },
      {
        instanceId: "codex",
        model: "gpt-6.2-sol",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
      { instanceId: "codex", model: "gpt-6-luna" },
    ]);
  });

  it("reads like the built-in rows it came from", () => {
    const providers = [claude, codex];
    const { rows, saved } = saveEffort("daily", providers, "GPT-6.1-Sol", "high");
    const after = describeTrack({ track: "daily", saved, providers, nowMs });
    expect(view(after)).toEqual(view(rows));
    expect(after.map((row) => row.effort)).toEqual(["medium", "medium", "high", "medium"]);
  });

  it("launches on the same models, and follows a newer release once a source lists it", () => {
    const providers = [claude, codex];
    const { saved } = saveEffort("daily", providers, "GPT-6.1-Sol", "high");
    const routine = launchTrackLanes({ routine: [...saved], complex: [] }, providers).routine;
    // The listed rows run where the built-in ones do; Sonnet and Luna, which
    // nothing here lists, stay in their places as saved.
    expect(slugs(launchTrackLanes(null, providers).routine)).toEqual([
      "claudeAgent/claude-opus-5-5",
      "codex/gpt-6.1-sol",
    ]);
    expect(slugs(routine)).toEqual([
      "claudeAgent/claude-opus-5-5",
      "claudeAgent/claude-sonnet-5-5",
      "codex/gpt-6.1-sol",
      "codex/gpt-6-luna",
    ]);
    expect(routine.find((entry) => entry.model === "gpt-6.1-sol")?.options).toEqual([
      { id: "reasoningEffort", value: "high" },
    ]);
    const newer = launchTrackLanes({ routine: [...saved], complex: [] }, [claude, codex62]).routine;
    expect(slugs(newer)).toContain("codex/gpt-6.2-sol");
    expect(slugs(newer)).not.toContain("codex/gpt-6.1-sol");
  });

  it("keeps Sol a regular model and Muse Wonder Full on Daily a model of its own", () => {
    const { saved } = saveEffort("daily", [claude, codex], "GPT-6.1-Sol", "high");
    const rule = { modelLanes: { routine: [...saved], complex: [] } };
    expect(reviewOnlyModel(rule)({ model: "gpt-6.1-sol" })).toBe(false);
    // B1: Wonder Full saved on Daily runs as itself, never as its whole line.
    expect(followsBuiltInFamily("daily", "muse-wonder-full-1.0")).toBe(false);
    const withMuse = {
      modelLanes: {
        routine: [...saved, { instanceId: muse.instanceId, model: "muse-wonder-full-1.0" }],
        complex: [],
      },
    };
    expect(reviewOnlyModel(withMuse)({ model: "muse-wonder-1.0" })).toBe(true);
  });

  it("reviews in the built-in order with only the changed reviewer's level different", () => {
    const providers = [claude, codex, copilot, muse];
    const { saved } = saveEffort("review", providers, "Gemini 4 Neon", "xhigh");
    expect(saved.map((entry) => entry.model)).toEqual([
      "gemini-4-neon",
      "gpt-6.2-sol",
    ]);
    const chain = (reviewers: ReadonlyArray<ModelSelection>) =>
      reviewerChain({ providers, reviewers, tier: "regular", trackOnly: true });
    const builtIn = chain([]);
    const after = chain(saved);
    expect(slugs(after)).toEqual(slugs(builtIn));
    expect(builtIn[0]?.options).toEqual([{ id: "reasoningEffort", value: "high" }]);
    expect(after[0]?.options).toEqual([{ id: "reasoningEffort", value: "xhigh" }]);
    expect(after[1]?.options).toEqual(builtIn[1]?.options);
  });

  it("starts new threads on a listed entry where the maker's harness is missing", () => {
    // Codex only: Opus and Sonnet are kept under Claude Code, which is not here.
    const providers = [codex];
    const { saved } = saveEffort("daily", providers, "GPT-6.1-Sol", "high");
    expect(saved.slice(0, 2).map((entry) => entry.instanceId)).toEqual([
      "claudeAgent",
      "claudeAgent",
    ]);
    const settings = {
      threadModelMode: "tracks" as const,
      defaultModelSelection: null,
      modelLanes: { routine: [...saved], complex: [] },
    };
    expect(projectDraftModelSelection(settings, providers)).toEqual({
      instanceId: "codex",
      model: "gpt-6.1-sol",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
  });

  it("makes a hand-saved entry spelled like a built-in one follow its family", () => {
    // A behaviour change for existing lists: `gpt-6.2-sol` saved by hand on Codex,
    // which lists only GPT-6.1 Sol, now runs there instead of being skipped.
    const routine = launchTrackLanes(
      { routine: [{ instanceId: codex.instanceId, model: "gpt-6.2-sol" }], complex: [] },
      [codex],
    ).routine;
    expect(slugs(routine)).toEqual(["codex/gpt-6.1-sol"]);
  });
});
