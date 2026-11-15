import * as DateTime from "effect/DateTime";
import {
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { effectiveFallbackOrder } from "./modelTiers.ts";
import { defaultTrackSelections } from "./modelTracks.ts";
import {
  addTrackEntry,
  moveTrackEntry,
  describeSources,
  describeTrack,
  moveSource,
  singleReviewFamily,
  sourceStatus,
  trackEntryRefusal,
} from "./modelTrackRules.ts";

const now = Date.parse("2026-11-14T18:00:00.000Z");
const fresh = DateTime.formatIso(DateTime.makeUnsafe(now));
const reset = "2026-11-14T20:55:00.000Z";

function provider(
  id: string,
  driver: string,
  slugs: ReadonlyArray<string>,
  used: number | null,
  over: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: fresh,
    version: null,
    models: slugs.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
    slashCommands: [],
    skills: [],
    ...(used === null
      ? {}
      : {
          usageLimits: {
            checkedAt: fresh,
            windows: [
              { id: "weekly", kind: "weekly", label: "Weekly", usedPercent: used, resetsAt: reset },
            ],
          },
        }),
    ...over,
  };
}

const sel = (instanceId: string, model: string): ModelSelection => ({
  instanceId: ProviderInstanceId.make(instanceId),
  model,
});
const ids = (rows: ReadonlyArray<{ provider: ServerProvider }>) =>
  rows.map((row) => row.provider.instanceId as string);

const copilotIcon = {
  iconUrl: "https://cdn.agentclientprotocol.com/registry/v1/latest/github-copilot-cli.svg",
};
const copilot = provider(
  "copilot",
  "acpRegistry",
  ["claude-opus-5.5", "gpt-6.1-sol", "gpt-6-luna"],
  null,
  copilotIcon,
);
const claude = provider("claudeAgent", "claudeAgent", ["claude-opus-5-5", "claude-fable-5-2"], 13);
const codex = provider("codex", "codex", ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"], 100);
const muse = provider("muse", "muse", ["muse-wonder-1.0"], 5);
const apiKey = provider("claude-api", "claudeAgent", ["claude-opus-5-5"], null, {
  auth: { status: "authenticated", type: "apiKey" },
});
const all = [copilot, apiKey, claude, codex, muse];

describe("sources", () => {
  it("lists harnesses first, then other subscriptions, then sources never picked on their own", () => {
    const rows = describeSources({ providers: all, nowMs: now });
    expect(ids(rows)).toEqual(["claudeAgent", "codex", "muse", "copilot", "claude-api"]);
    expect(rows.at(-1)?.hold).toBe("per-token");
    expect(rows.find((row) => row.provider.instanceId === "codex")?.status).toEqual({
      state: "limited",
      until: Date.parse(reset),
    });
  });

  it("keeps a saved order ahead of the default and a per-token source last", () => {
    const order = [copilot.instanceId, apiKey.instanceId];
    expect(ids(describeSources({ providers: all, order, nowMs: now }))).toEqual([
      "copilot",
      "claudeAgent",
      "codex",
      "muse",
      "claude-api",
    ]);
  });

  it("moves a source and refuses a move across the automatic boundary", () => {
    const rows = describeSources({ providers: all, nowMs: now });
    expect(moveSource(rows, 3, 0)).toEqual({
      order: ["copilot", "claudeAgent", "codex", "muse"],
    });
    // A held source the person named and a source that is switched off keep their places.
    const saved = [ProviderInstanceId.make("cursor-off"), apiKey.instanceId, copilot.instanceId];
    expect(
      moveSource(describeSources({ providers: all, order: saved, nowMs: now }), 1, 0, saved),
    ).toEqual({ order: ["claudeAgent", "copilot", "codex", "muse", "claude-api", "cursor-off"] });
    expect(moveSource(rows, 4, 0)).toEqual({ refused: "held-source" });
    expect(moveSource(rows, 0, 4)).toEqual({ refused: "into-held" });
  });

  it("reports sign in and not installed", () => {
    expect(sourceStatus({ ...muse, auth: { status: "unauthenticated" } }, now).state).toBe(
      "sign-in",
    );
    expect(sourceStatus({ ...muse, installed: false }, now).state).toBe("not-installed");
  });
});

describe("track rows", () => {
  it("shows the built-in order with each model's sources, harness first", () => {
    const rows = describeTrack({ track: "daily", saved: [], providers: all, nowMs: now });
    expect(rows.map((row) => [row.model, ids(row.sources)])).toEqual([
      ["claude-opus-5-5", ["claudeAgent", "copilot", "claude-api"]],
      ["gpt-6.1-sol", ["codex", "copilot"]],
      ["muse-wonder-1.0", ["muse"]],
      ["gpt-6-luna", ["codex", "copilot"]],
    ]);
    expect(rows.every((row) => row.builtIn)).toBe(true);
    expect(rows.at(-1)?.free).toBe(true);
    expect(rows[1]?.sources[0]?.status.state).toBe("limited");
    // The per-token source is listed with its billing, and never started on.
    expect(rows[0]?.sources.at(-1)).toMatchObject({ hold: "per-token", used: false });
  });

  it("starts a built-in row where the resolver does: the saved Sources order first", () => {
    const sourceOrder = [copilot.instanceId, claude.instanceId];
    const rows = describeTrack({
      track: "daily",
      saved: [],
      providers: all,
      sourceOrder,
      nowMs: now,
    });
    expect(ids(rows[0]!.sources).slice(0, 2)).toEqual(["copilot", "claudeAgent"]);
    expect(rows[0]?.selection).toEqual(defaultTrackSelections("daily", all, sourceOrder)[0]);
    expect(
      effectiveFallbackOrder(
        {
          providerLimitFallbackModelSelection: null,
          modelLanes: { complex: [], routine: [] },
          defaultModelProviders: sourceOrder,
        },
        undefined,
        all,
      )
        .order.slice(0, 2)
        .map((entry) => entry.instanceId as string),
    ).toEqual(["copilot", "claudeAgent"]);
  });

  it("orders the other sources of a saved entry by room, as the limit walk does", () => {
    const cursor = provider("cursor", "acpRegistry", ["claude-opus-5-5"], 90);
    const devin = provider("devin", "acpRegistry", ["claude-opus-5-5"], 5);
    const rows = describeTrack({
      track: "daily",
      saved: [sel("claudeAgent", "claude-opus-5-5")],
      providers: [claude, cursor, devin],
      nowMs: now,
    });
    expect(ids(rows[0]!.sources)).toEqual(["claudeAgent", "devin", "cursor"]);
  });

  it("shows a model only a per-token source lists as held, not as missing", () => {
    const gemini = provider("gemini", "acpRegistry", ["gemini-4-carbon"], null);
    const review = describeTrack({
      track: "review",
      saved: [],
      providers: [...all, gemini],
      nowMs: now,
    });
    const carbon = review.at(-1)!;
    expect(carbon.selection).toBeNull();
    expect(carbon.sources).toMatchObject([{ hold: "per-token", used: false }]);
  });

  it("marks a saved per-token entry: it spends on Daily and never reviews", () => {
    const saved = [sel("claude-api", "claude-opus-5-5")];
    const first = (track: "daily" | "review") =>
      describeTrack({ track, saved, providers: all, nowMs: now })[0]!.sources[0];
    expect(first("daily")).toMatchObject({ hold: "per-token", used: true });
    expect(first("review")).toMatchObject({ hold: "per-token", used: false });
  });

  it("flags a free model stored in Complex", () => {
    const rows = describeTrack({
      track: "complex",
      saved: [sel("codex", "gpt-6-luna")],
      providers: all,
      nowMs: now,
    });
    expect(rows[0]).toMatchObject({ free: false, misplaced: true });
  });

  it("keeps a built-in model nothing lists, with no sources", () => {
    const review = describeTrack({ track: "review", saved: [], providers: all, nowMs: now });
    expect(review.at(-1)).toMatchObject({ model: "gemini-4-carbon", selection: null, sources: [] });
  });

  it("follows the saved Sources order and keeps a named source first", () => {
    const rows = describeTrack({
      track: "daily",
      saved: [sel("claude-api", "claude-opus-5-5")],
      providers: all,
      sourceOrder: [copilot.instanceId],
      nowMs: now,
    });
    expect(ids(rows[0]!.sources)).toEqual(["claude-api", "copilot", "claudeAgent"]);
    expect(rows[0]?.builtIn).toBe(false);
  });
});

describe("moves that cannot work", () => {
  it("refuses a duplicate, a free model in Complex or Review, and a full track", () => {
    const base = { providers: all, existing: [sel("copilot", "claude-opus-5.5")] };
    expect(trackEntryRefusal({ ...base, track: "daily", model: { slug: "claude-opus-5-5" } })).toBe(
      "duplicate",
    );
    expect(trackEntryRefusal({ ...base, track: "complex", model: { slug: "gpt-6-luna" } })).toBe(
      "free-in-hard-track",
    );
    expect(
      trackEntryRefusal({ ...base, track: "daily", model: { slug: "gpt-6-luna" } }),
    ).toBeNull();
    expect(
      trackEntryRefusal({
        track: "daily",
        model: { slug: "gpt-6-astra" },
        providers: all,
        existing: Array.from({ length: 8 }, (_, index) => sel("codex", `m-${index}`)),
      }),
    ).toBe("full");
  });

  it("refuses a source billed per token and keeps a free entry last on Daily", () => {
    expect(
      trackEntryRefusal({
        track: "daily",
        model: { slug: "claude-opus-5-5" },
        providers: all,
        existing: [],
        instanceId: apiKey.instanceId,
      }),
    ).toBe("per-token");
    const entries = [sel("claudeAgent", "claude-opus-5-5"), sel("codex", "gpt-6-luna")];
    expect(moveTrackEntry({ track: "daily", entries, providers: all, from: 1, to: 0 })).toEqual({
      refused: "free-not-last",
    });
    expect(
      addTrackEntry({
        track: "daily",
        entries,
        providers: all,
        entry: sel("muse", "muse-wonder-1.0"),
      }),
    ).toEqual([entries[0], sel("muse", "muse-wonder-1.0"), entries[1]]);
    const hard = [sel("claudeAgent", "claude-fable-5-2"), sel("codex", "gpt-6-astra")];
    expect(
      moveTrackEntry({ track: "complex", entries: hard, providers: all, from: 1, to: 0 }),
    ).toEqual({ entries: [hard[1], hard[0]] });
  });

  it("names the family when every reviewer is in one", () => {
    const one = describeTrack({
      track: "review",
      saved: [sel("codex", "gpt-6.1-sol"), sel("codex", "gpt-6-astra")],
      providers: all,
      nowMs: now,
    });
    expect(singleReviewFamily(one)).toBe("openai");
    const mixed = describeTrack({ track: "review", saved: [], providers: all, nowMs: now });
    expect(singleReviewFamily(mixed)).toBeNull();
  });
});
