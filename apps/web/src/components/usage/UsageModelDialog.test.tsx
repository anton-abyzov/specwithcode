import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { USAGE_CONTRACT_VERSION, type UsageBucket } from "@specweave-studio/contracts";
import { mergeUsage, type ModelTotals } from "@specweave-studio/shared/usageMerge";
const state = vi.hoisted(() => ({ merge: vi.fn(), chart: vi.fn(), share: vi.fn() }));
vi.mock("../../state/usage", () => ({ mergeAnsweredUsage: state.merge }));
vi.mock("../chat/ProviderInstanceIcon", () => ({ ProviderInstanceIcon: () => null }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/dialog", () => ({
  Dialog: "div",
  DialogDescription: "p",
  DialogFooter: "footer",
  DialogHeader: "header",
  DialogPanel: "main",
  DialogPopup: "section",
  DialogTitle: "h2",
}));
vi.mock("./UsageProviderChart", () => ({ UsageProviderChart: state.chart }));
vi.mock("./UsageShareBar", () => ({ UsageShareBar: state.share }));
import { UsageModelDialog } from "./UsageModelDialog";
const model: ModelTotals = {
  model: "claude-test",
  provider: "claude",
  costUsd: 4,
  totalTokens: 100,
  records: 2,
  unpricedRecords: 1,
  unpricedTokens: 50,
  costShare: 0.5,
  tokenShare: 0.5,
  tokens: {
    uncachedInputTokens: 50,
    cachedInputTokens: 20,
    cacheCreationTokens: 0,
    outputTokens: 30,
    reasoningTokens: 0,
  },
};
const props = {
  model,
  environments: [],
  metric: "cost" as const,
  chartWindow: {
    days: ["2026-10-21", "2026-10-22"],
    hours: ["2026-10-22T10:00:00Z", "2026-10-22T11:00:00Z"],
    resolution: "day" as const,
    timeZone: "UTC",
    referenceTime: undefined,
  },
  onSetPrice: () => {},
  onClose: () => {},
};
beforeEach(() => {
  vi.clearAllMocks();
  state.merge.mockReturnValue(mergeUsage([], USAGE_CONTRACT_VERSION));
  state.chart.mockReturnValue(null);
  state.share.mockReturnValue(null);
});
const bucket = (overrides: Partial<UsageBucket> = {}) =>
  ({
    provider: "claude",
    model: "claude-test",
    day: "2026-10-22",
    hourStart: "2026-10-22T10:00:00Z",
    ...overrides,
  }) as UsageBucket;
describe("model details follow dashboard scope", () => {
  it("keeps model and provider selection plus the pinned date", () => {
    renderToStaticMarkup(
      <UsageModelDialog {...props} pinnedPeriod={{ kind: "day", day: "2026-10-22" }} />,
    );
    const keep = state.merge.mock.calls[0]![1] as (value: UsageBucket) => boolean;
    expect(keep(bucket())).toBe(true);
    expect(keep(bucket({ day: "2026-10-21" } as Partial<UsageBucket>))).toBe(false);
    expect(keep(bucket({ provider: "codex" }))).toBe(false);
    expect(keep(bucket({ model: "another" }))).toBe(false);
    expect(state.chart.mock.calls[0]![0].days).toEqual(["2026-10-22"]);
  });
  it("keeps an hourly drill-down within the pinned hour", () => {
    renderToStaticMarkup(
      <UsageModelDialog
        {...props}
        pinnedPeriod={{ kind: "hour", hourStart: "2026-10-22T10:00:00Z" }}
      />,
    );
    const keep = state.merge.mock.calls[0]![1] as (value: UsageBucket) => boolean;
    expect(keep(bucket())).toBe(true);
    expect(keep(bucket({ hourStart: "2026-10-22T11:00:00Z" }))).toBe(false);
    expect(state.chart.mock.calls[0]![0].hours).toEqual(["2026-10-22T10:00:00Z"]);
  });
  it("marks partial money as a lower bound throughout details", () => {
    const markup = renderToStaticMarkup(<UsageModelDialog {...props} />);
    expect(markup).toContain("≥ $4.00");
    expect(markup).toContain("not billed spend");
    const format = state.share.mock.calls.find(
      ([value]) => value.label === "API-equivalent cost by type",
    )![0].format;
    expect(format(2)).toBe("≥ $2.00");
  });
});
