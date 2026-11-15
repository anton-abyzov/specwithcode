import * as DateTime from "effect/DateTime";
import {
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
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
      ["claude-opus-5-5", ["claudeAgent", "copilot"]],
      ["gpt-6.1-sol", ["codex", "copilot"]],
      ["muse-wonder-1.0", ["muse"]],
      ["gpt-6-luna", ["codex", "copilot"]],
    ]);
    expect(rows.every((row) => row.builtIn)).toBe(true);
    expect(rows.at(-1)?.free).toBe(true);
    expect(rows[1]?.sources[0]?.status.state).toBe("limited");
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
