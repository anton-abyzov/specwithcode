import { describe, expect, it } from "vite-plus/test";
import {
  costText,
  matchesModelQuery,
  toggleUsageProvider,
  usageBucketFilter,
  NO_USAGE_FILTERS,
} from "./usageFilters";
import type { UsageBucket } from "@specweave-studio/contracts";

describe("usage dashboard filters", () => {
  it("isolates and combines providers, returning to all when all selected", () => {
    const selected = toggleUsageProvider(new Set(), "claude", ["claude", "codex"]);
    expect([...selected]).toEqual(["claude"]);
    expect(toggleUsageProvider(selected, "codex", ["claude", "codex"]).size).toBe(0);
    expect(toggleUsageProvider(selected, "claude", ["claude", "codex"]).size).toBe(0);
  });
  it("keeps the full chart but narrows summary to the pinned period", () => {
    const filters = {
      ...NO_USAGE_FILTERS,
      providers: new Set(["claude"] as const),
      period: { kind: "day" as const, day: "2026-10-22" },
    };
    const bucket = { provider: "claude", day: "2026-10-21" } as UsageBucket;
    expect(usageBucketFilter(filters, false)!(bucket)).toBe(true);
    expect(usageBucketFilter(filters, true)!(bucket)).toBe(false);
    expect(usageBucketFilter(filters, true)!({ ...bucket, day: "2026-10-22" } as UsageBucket)).toBe(
      true,
    );
    expect(usageBucketFilter(filters, false)!({ ...bucket, provider: "codex" })).toBe(false);
    expect(usageBucketFilter(NO_USAGE_FILTERS, true)).toBeUndefined();
  });
  it("pins an exact hour, without changing the other hours in the chart", () => {
    const filters = {
      ...NO_USAGE_FILTERS,
      period: { kind: "hour" as const, hourStart: "2026-10-22T10:00:00Z" },
    };
    const bucket = { provider: "claude", hourStart: "2026-10-22T11:00:00Z" } as UsageBucket;
    expect(usageBucketFilter(filters, true)!(bucket)).toBe(false);
    expect(usageBucketFilter(filters, false)).toBeUndefined();
  });
  it("searches words independently of case", () => {
    expect(matchesModelQuery("Claude Opus 5.5", "OPUS claude")).toBe(true);
    expect(matchesModelQuery("Claude Sonnet", "Opus")).toBe(false);
  });
  it("never turns missing rates into zero money", () => {
    expect(costText({ costUsd: 0, records: 2, unpricedRecords: 2 }).text).toBe("Unpriced");
    expect(costText({ costUsd: 3, records: 2, unpricedRecords: 1 }).text).toContain("≥");
    expect(costText({ costUsd: 0, records: 2, unpricedRecords: 0 }).text).toBe("$0.00");
    expect(costText(undefined).text).toBe("—");
  });
});
