import { describe, expect, it } from "vite-plus/test";

import {
  formatProviderSubagentShortStatus,
  providerSubagentStatusTone,
} from "./providerSubagentStatusDisplay";

const START = "2026-10-11T16:00:00.000Z";
const NOW = Date.parse("2026-10-11T16:00:12.000Z");

describe("formatProviderSubagentShortStatus", () => {
  it("shortens a completed run to Done and its duration", () => {
    expect(
      formatProviderSubagentShortStatus(
        { status: "completed", startedAt: START, completedAt: "2026-10-11T16:00:34.000Z" },
        NOW,
      ),
    ).toBe("Done 34s");
    expect(
      formatProviderSubagentShortStatus(
        { status: "completed", startedAt: null, completedAt: null },
        NOW,
      ),
    ).toBe("Done");
  });

  it("keeps already short wording", () => {
    expect(
      formatProviderSubagentShortStatus(
        { status: "running", startedAt: START, completedAt: null },
        NOW,
      ),
    ).toBe("Working 12s");
    expect(formatProviderSubagentShortStatus(null, NOW)).toBe("Starting");
    expect(
      formatProviderSubagentShortStatus(
        { status: "failed", startedAt: START, completedAt: null },
        NOW,
      ),
    ).toBe("Failed");
  });
});

describe("providerSubagentStatusTone", () => {
  it("shows an unreachable child as Unknown, never a ticking Working", () => {
    const unknown = { status: "unknown", startedAt: START, completedAt: null } as const;
    expect(providerSubagentStatusTone(unknown)).toBe("unknown");
    expect(formatProviderSubagentShortStatus(unknown, NOW)).toBe("Unknown (machine unreachable)");
  });

  it("maps each status to a glyph", () => {
    const tone = (status: Parameters<typeof providerSubagentStatusTone>[0]) =>
      providerSubagentStatusTone(status);
    const at = { startedAt: START, completedAt: null };
    expect(tone(null)).toBe("starting");
    expect(tone({ status: "idle", ...at })).toBe("idle");
    expect(tone({ status: "running", ...at })).toBe("live");
    expect(tone({ status: "waiting", ...at })).toBe("live");
    expect(tone({ status: "completed", ...at })).toBe("done");
    expect(tone({ status: "failed", ...at })).toBe("failed");
    expect(tone({ status: "cancelled", ...at })).toBe("stopped");
    expect(tone({ status: "interrupted", ...at })).toBe("stopped");
  });
});
