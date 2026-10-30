import { ProviderInstanceId } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildModelPickerSearchText,
  countModelSearchMatches,
  scoreModelPickerSearch,
} from "./modelPickerSearch";

describe("buildModelPickerSearchText", () => {
  it("builds provider-agnostic search text from generic fields", () => {
    expect(
      buildModelPickerSearchText({
        driverKind: "opencode",
        providerDisplayName: "opencode",
        name: "Claude Opus 4.7",
        subProvider: "GitHub Copilot",
      }),
    ).toBe("claude opus 4.7 github copilot opencode opencode");
  });
});

describe("scoreModelPickerSearch", () => {
  it("matches typo-tolerant multi-token queries", () => {
    expect(
      scoreModelPickerSearch(
        {
          driverKind: "opencode",
          providerDisplayName: "opencode",
          name: "Claude Opus 4.7",
          subProvider: "GitHub Copilot",
        },
        "coplt op",
      ),
    ).not.toBeNull();
  });

  it("rejects results when any query token does not match", () => {
    expect(
      scoreModelPickerSearch(
        {
          driverKind: "codex",
          providerDisplayName: "codex",
          name: "GPT-5 Codex",
        },
        "coplt op",
      ),
    ).toBeNull();
  });

  it("ranks exact token matches ahead of fuzzier matches", () => {
    const exactScore = scoreModelPickerSearch(
      {
        driverKind: "opencode",
        providerDisplayName: "opencode",
        name: "Claude Opus 4.7",
        subProvider: "GitHub Copilot",
      },
      "copilot opus",
    );
    const fuzzyScore = scoreModelPickerSearch(
      {
        driverKind: "opencode",
        providerDisplayName: "opencode",
        name: "Claude Opus 4.7",
        subProvider: "GitHub Copilot",
      },
      "coplt op",
    );

    expect(exactScore).not.toBeNull();
    expect(fuzzyScore).not.toBeNull();
    expect(exactScore!).toBeLessThan(fuzzyScore!);
  });

  it("gives favorite models a strong enough ranking boost for partial queries", () => {
    const favoriteScore = scoreModelPickerSearch(
      {
        driverKind: "claudeAgent",
        providerDisplayName: "Claude",
        name: "Claude Opus 4.7",
        isFavorite: true,
      },
      "opu",
    );
    const nonFavoriteScore = scoreModelPickerSearch(
      {
        driverKind: "cursor",
        providerDisplayName: "Cursor",
        name: "Opus 4.5",
      },
      "opu",
    );

    expect(favoriteScore).not.toBeNull();
    expect(nonFavoriteScore).not.toBeNull();
    expect(favoriteScore!).toBeLessThan(nonFavoriteScore!);
  });

  it("does not let the favorite boost outrank clearly better textual matches", () => {
    const favoriteScore = scoreModelPickerSearch(
      {
        driverKind: "claudeAgent",
        providerDisplayName: "Claude",
        name: "Claude Opus 4.7",
        isFavorite: true,
      },
      "opus 4.7",
    );
    const nonFavoriteExactScore = scoreModelPickerSearch(
      {
        driverKind: "cursor",
        providerDisplayName: "Cursor",
        name: "Opus 4.7",
      },
      "opus 4.7",
    );

    expect(favoriteScore).not.toBeNull();
    expect(nonFavoriteExactScore).not.toBeNull();
    expect(nonFavoriteExactScore!).toBeLessThan(favoriteScore!);
  });

  it("matches a custom instance's display name against its models", () => {
    expect(
      scoreModelPickerSearch(
        {
          driverKind: "codex",
          providerDisplayName: "Codex Personal",
          name: "GPT-5 Codex",
        },
        "personal",
      ),
    ).not.toBeNull();
  });

  it("finds every model of a provider by its display name alone", () => {
    const base = { driverKind: "claudeAgent", providerDisplayName: "Claude Code" };
    expect(scoreModelPickerSearch({ ...base, name: "Opus 5.5" }, "claude")).not.toBeNull();
    expect(scoreModelPickerSearch({ ...base, name: "Sonnet 5" }, "claude code")).not.toBeNull();
    expect(scoreModelPickerSearch({ ...base, name: "Sonnet 5" }, "codex")).toBeNull();
  });
});

describe("countModelSearchMatches", () => {
  it("counts matches per provider, for All and for Favorites", () => {
    const claude = ProviderInstanceId.make("claudeAgent");
    const copilot = ProviderInstanceId.make("copilot_work");
    const counts = countModelSearchMatches(
      [
        { instanceId: claude, slug: "claude-opus-5-5" },
        { instanceId: copilot, slug: "claude-opus-5-5" },
        { instanceId: copilot, slug: "claude-opus-5" },
      ],
      new Set(["copilot_work:claude-opus-5"]),
    );
    expect(Object.fromEntries(counts)).toEqual({
      all: 3,
      favorites: 1,
      claudeAgent: 1,
      copilot_work: 2,
    });
  });
});
