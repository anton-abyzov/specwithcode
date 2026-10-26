import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  UsageLimitSourceId,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  FLAT_SAMPLE_INTERVAL_MS,
  HISTORY_RETENTION_MS,
  MAX_SAMPLES_PER_SERIES,
  type HistoryState,
  decodeHistoryFile,
  encodeHistoryFile,
  pruneHistory,
  readHistory,
  readingsFromProviders,
  readingsFromSources,
  recordReading,
} from "./usageLimitHistoryStore.ts";

const MINUTE = 60_000;
const t0 = Date.parse("2026-10-26T10:00:00.000Z");
const claude = ProviderDriverKind.make("claudeAgent");
const weekly = {
  id: "seven_day",
  kind: "weekly",
  label: "Weekly",
  windowDurationMins: 10_080,
  resetsAt: "2026-10-28T10:00:00.000Z",
} as const;

const reading = (at: number, usedPercent: number, resetsAt: string = weekly.resetsAt) => ({
  accountKey: "claudeAgent:main@example.com",
  driver: claude,
  checkedAt: at,
  windows: [{ ...weekly, usedPercent, resetsAt }],
});

function provider(overrides: Partial<ServerProvider>): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    driver: claude,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated", email: "Main@Example.com" },
    checkedAt: "2026-10-26T10:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

describe("recordReading", () => {
  it("stores a sample per changed read and skips repeats and older reads", () => {
    const state: HistoryState = new Map();
    expect(recordReading(state, reading(t0, 10))).toBe(true);
    // A cached snapshot replayed with the same or an older time adds nothing.
    expect(recordReading(state, reading(t0, 10))).toBe(false);
    expect(recordReading(state, reading(t0 - MINUTE, 5))).toBe(false);
    // Unchanged and recent: no point yet.
    expect(recordReading(state, reading(t0 + 5 * MINUTE, 10))).toBe(false);
    expect(recordReading(state, reading(t0 + 10 * MINUTE, 12))).toBe(true);
    // Flat for half an hour still gets a point, so the chart stays level.
    expect(recordReading(state, reading(t0 + 10 * MINUTE + FLAT_SAMPLE_INTERVAL_MS, 12))).toBe(
      true,
    );
    const [series] = state.values();
    expect(series?.samples.map((sample) => sample.usedPercent)).toEqual([10, 12, 12]);
  });

  it("treats a moved reset as a change even when the percentage matches", () => {
    const state: HistoryState = new Map();
    recordReading(state, reading(t0, 0));
    expect(recordReading(state, reading(t0 + MINUTE, 0, "2026-11-04T10:00:00.000Z"))).toBe(true);
    // A few minutes of rounding is the same reset.
    expect(recordReading(state, reading(t0 + 2 * MINUTE, 0, "2026-11-04T10:02:00.000Z"))).toBe(
      false,
    );
  });

  it("keeps at most the newest samples of a series", () => {
    const state: HistoryState = new Map();
    for (let index = 0; index < MAX_SAMPLES_PER_SERIES + 5; index += 1) {
      recordReading(state, reading(t0 + index * MINUTE, index % 2 === 0 ? 10 : 11));
    }
    const [series] = state.values();
    expect(series?.samples).toHaveLength(MAX_SAMPLES_PER_SERIES);
    expect(series?.samples[0]?.at).toBe(t0 + 5 * MINUTE);
  });
});

describe("pruneHistory and readHistory", () => {
  it("drops samples past retention and returns the last one before the range", () => {
    const state: HistoryState = new Map();
    recordReading(state, reading(t0, 10));
    recordReading(state, reading(t0 + 60 * MINUTE, 20));
    recordReading(state, reading(t0 + 120 * MINUTE, 30));
    const [series] = readHistory(state, t0 + 90 * MINUTE);
    expect(series?.samples.map((sample) => sample.usedPercent)).toEqual([20, 30]);
    expect(series?.samples[0]).toEqual({
      at: "2026-10-26T11:00:00.000Z",
      usedPercent: 20,
      resetsAt: weekly.resetsAt,
    });
    expect(pruneHistory(state, t0 + 90 * MINUTE + HISTORY_RETENTION_MS)).toBe(true);
    expect([...state.values()][0]?.samples.map((sample) => sample.usedPercent)).toEqual([30]);
    expect(pruneHistory(state, t0 + 200 * MINUTE + HISTORY_RETENTION_MS)).toBe(true);
    expect(state.size).toBe(0);
  });
});

describe("history file", () => {
  it("round-trips and ignores malformed entries", () => {
    const state: HistoryState = new Map();
    recordReading(state, reading(t0, 10));
    recordReading(state, reading(t0 + 10 * MINUTE, 15));
    const decoded = decodeHistoryFile(encodeHistoryFile(state));
    expect(readHistory(decoded, 0)).toEqual(readHistory(state, 0));

    const raw = JSON.parse(encodeHistoryFile(state));
    raw.series.push({ accountKey: "", driver: "codex", windowId: "x", windowKind: "session" });
    raw.series[0].samples.push(["late", 3, null], [t0 - MINUTE, 3, null]);
    expect(readHistory(decodeHistoryFile(JSON.stringify(raw)), 0)).toEqual(readHistory(state, 0));
    expect(decodeHistoryFile("not json").size).toBe(0);
    expect(decodeHistoryFile(JSON.stringify({ version: 99, series: [] })).size).toBe(0);
  });
});

describe("readings", () => {
  it("keys native instances like the pooled views and skips unusable reads", () => {
    const limits = {
      checkedAt: "2026-10-26T10:00:00.000Z",
      windows: [{ ...weekly, usedPercent: 40 }],
    };
    const readings = readingsFromProviders([
      provider({ usageLimits: limits }),
      provider({ instanceId: ProviderInstanceId.make("claude_work"), usageLimits: undefined }),
      provider({
        instanceId: ProviderInstanceId.make("claude_api"),
        usageLimits: { ...limits, unavailable: { reason: "unsupported" } },
      }),
      provider({ auth: { status: "authenticated" }, usageLimits: limits }),
    ]);
    expect(readings).toEqual([
      {
        accountKey: "claudeAgent:main@example.com",
        driver: claude,
        checkedAt: t0,
        windows: limits.windows,
      },
    ]);
  });

  it("reads hub accounts", () => {
    const readings = readingsFromSources([
      {
        id: UsageLimitSourceId.make("hub"),
        kind: "cliproxy",
        label: "Hub",
        checkedAt: "2026-10-26T10:00:00.000Z",
        accounts: [
          {
            id: "codex-1.json",
            driver: ProviderDriverKind.make("codex"),
            email: "pro@example.com",
            usageLimits: {
              checkedAt: "2026-10-26T10:00:00.000Z",
              windows: [{ ...weekly, id: "secondary", usedPercent: 70 }],
            },
          },
        ],
      },
    ]);
    expect(readings.map((entry) => entry.accountKey)).toEqual(["codex:pro@example.com"]);
  });
});
