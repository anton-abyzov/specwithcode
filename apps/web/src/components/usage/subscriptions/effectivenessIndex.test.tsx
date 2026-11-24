// @vitest-environment jsdom
import { ProviderDriverKind, type UsageResetPeriod } from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../chat/ProviderInstanceIcon", () => ({
  ProviderInstanceIcon: ({ driverKind }: { driverKind: string }) => (
    <img data-logo={driverKind} alt="" />
  ),
}));
vi.mock("../../settings/providerDriverMeta", () => ({
  getDriverOption: (id: string) => ({
    label: id === "codex" ? "Codex" : id === "grok" ? "Grok" : "Claude",
  }),
}));

import { EffectivenessSummaryView, resetWhen, subline } from "./EffectivenessSummary";
import { effectivenessIndex } from "./effectivenessIndex";
import type { SubscriptionRow } from "./subscriptionRows";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Tuesday November 17, 2026, 10 AM local.
const now = new Date(2026, 10, 17, 10, 0).getTime();
const iso = (at: number) => new Date(at).toISOString();
const claude = ProviderDriverKind.make("claudeAgent");
const codex = ProviderDriverKind.make("codex");
const grok = ProviderDriverKind.make("grok");

const period = (
  accountKey: string,
  driver: ProviderDriverKind,
  endedAt: number,
  used: number,
  extra: Partial<UsageResetPeriod> = {},
): UsageResetPeriod =>
  ({
    accountKey,
    driver,
    windowId: "seven_day",
    windowKind: "weekly",
    endedAt: iso(endedAt),
    lastReadAt: iso(endedAt - HOUR),
    usedPercentAtReset: used,
    lostPercent: 100 - used,
    cause: "scheduled",
    ...extra,
  }) as UsageResetPeriod;

const row = (
  driver: ProviderDriverKind,
  leftPercent: number,
  resetsAt: number | null,
  extra: Partial<SubscriptionRow> = {},
): SubscriptionRow => ({
  key: `${driver}-${leftPercent}`,
  accountKey: `${driver}:a@example.com`,
  renewalKey: `${driver}:a@example.com`,
  driver,
  displayName: null,
  iconUrl: null,
  plan: null,
  email: null,
  machines: [],
  offline: false,
  checkedAt: now,
  windows: [
    {
      id: "five_hour",
      title: "5h",
      leftPercent: 100,
      resetsAt: now + HOUR,
      expiring: false,
      long: false,
      scoped: false,
      durationMs: 5 * HOUR,
      kind: "session",
      accountWide: true,
      spent: false,
      amounts: null,
    },
    {
      id: "weekly",
      title: "Weekly",
      leftPercent,
      resetsAt,
      expiring: false,
      long: true,
      scoped: false,
      durationMs: 7 * DAY,
      kind: "weekly",
      accountWide: true,
      spent: leftPercent === 0,
      amounts: null,
    },
  ],
  renewal: null,
  credits: null,
  lastLoss: null,
  atLimit: false,
  note: null,
  ...extra,
});

// Real shape from November 2026: Claude resets the last two weeks, Codex one, Grok none yet.
const periods = [
  period("claude:a@example.com", claude, new Date(2026, 10, 6, 12).getTime(), 100),
  period("claude:a@example.com", claude, new Date(2026, 10, 13, 12).getTime(), 69),
  period("claude:b@example.com", claude, new Date(2026, 10, 11, 12).getTime(), 99),
  period("claude:a@example.com", claude, new Date(2026, 10, 13, 12).getTime(), 40, {
    windowId: "seven_day_opus",
    modelScope: "Opus",
  }),
  period("codex:a@example.com", codex, new Date(2026, 10, 4, 12).getTime(), 98, {
    windowId: "primary",
  }),
  period("codex:a@example.com", codex, new Date(2026, 9, 1, 12).getTime(), 10, {
    windowId: "primary",
  }),
];

describe("effectivenessIndex", () => {
  it("averages used before reset over four weeks, skipping model slices and older resets", () => {
    const index = effectivenessIndex([], periods, now);
    expect(index.resets).toBe(4);
    expect(index.usedPercent).toBeCloseTo((100 + 69 + 99 + 98) / 4);
    const claudeRow = index.providers.find((provider) => provider.driver === claude)!;
    expect(claudeRow.resets).toBe(3);
    // Week of November 2 holds the November 6 reset; week of November 9 the 11th and 13th.
    expect(claudeRow.pastWeeks.map((week) => week.usedPercent)).toEqual([100, 84]);
    const codexRow = index.providers.find((provider) => provider.driver === codex)!;
    expect(codexRow.pastWeeks.map((week) => week.usedPercent)).toEqual([98, null]);
  });

  it("projects this week from the live weekly window and names the soonest reset", () => {
    // Grok: 72% left with a day of seven to go, so the pace leaves about 67%. One reset
    // recorded long ago gives it a history, so the pace is projected.
    const index = effectivenessIndex(
      [row(grok, 72, now + DAY)],
      [period("grok:a@example.com", grok, now - 40 * DAY, 50)],
      now,
    );
    expect(index.usedPercent).toBeNull();
    const grokRow = index.providers[0]!;
    expect(grokRow).toMatchObject({ driver: grok, usedPercent: null, resets: 0 });
    expect(grokRow.nextReset?.at).toBe(now + DAY);
    expect(grokRow.nextReset?.projectedLeftPercent).toBeCloseTo(72 - (28 / 6) * 1);
    expect(grokRow.projectedUsedPercent).toBeCloseTo(
      100 - (grokRow.nextReset?.projectedLeftPercent ?? 0),
    );
  });

  it("projects nothing without a reset time, or before the week has run a day", () => {
    const noTime = effectivenessIndex([row(grok, 30, null)], [], now);
    expect(noTime.providers).toEqual([]);
    // An hour into the week with 5% spent: the reset is named, the pace is not guessed.
    const early = effectivenessIndex(
      [row(grok, 95, now + 7 * DAY - HOUR)],
      [period("grok:a@example.com", grok, now - 40 * DAY, 50)],
      now,
    );
    expect(early.providers[0]).toMatchObject({
      projectedUsedPercent: null,
      nextReset: { at: now + 7 * DAY - HOUR, projectedLeftPercent: null },
    });
  });

  it("leaves out an offline account's projection and a provider with neither", () => {
    const index = effectivenessIndex([row(grok, 50, now + DAY, { offline: true })], [], now);
    expect(index.providers).toEqual([]);
  });
});

describe("EffectivenessSummaryView", () => {
  it("shows the index and a row per provider with its logo on the left", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    const index = effectivenessIndex([row(grok, 72, now + 7 * HOUR)], periods, now);
    await act(async () => root.render(<EffectivenessSummaryView index={index} now={now} />));
    expect(container.querySelector("svg[role=img]")?.getAttribute("aria-label")).toBe(
      "92% used before reset",
    );
    expect(container.textContent).toContain("8% left on the table per reset");
    const rows = [...container.querySelectorAll("[data-effectiveness-provider]")];
    expect(rows.map((element) => element.getAttribute("data-effectiveness-provider"))).toEqual([
      "claudeAgent",
      "codex",
      "grok",
    ]);
    for (const element of rows) {
      expect(element.firstElementChild?.getAttribute("data-logo")).toBe(
        element.getAttribute("data-effectiveness-provider"),
      );
    }
    expect(rows[2]?.textContent).toContain("new");
    // No reset recorded for Grok yet: its reading, never a pace.
    expect(rows[2]?.textContent).toContain("28% used · resets today");
    expect(rows[2]?.textContent).not.toContain("on pace");
    expect(rows[2]?.querySelector(".sr-only")?.textContent).toBe(
      "Last two weeks no reset, then no reset.",
    );
    await act(async () => root.unmount());
    container.remove();
  });

  it("names each registry agent with its own mark and says a spent limit plainly", async () => {
    const acp = ProviderDriverKind.make("acpRegistry");
    const copilotIcon =
      "https://cdn.agentclientprotocol.com/registry/v1/latest/github-copilot-cli.svg";
    const rows = [
      // Two Copilot accounts, one named by the registry icon and one only by its name.
      row(acp, 0, now + 6 * DAY, {
        key: "c1",
        accountKey: "acpRegistry:one@example.com",
        displayName: "Work Copilot",
        iconUrl: copilotIcon,
        atLimit: true,
      }),
      row(acp, 0, now + 7 * DAY, {
        key: "c2",
        accountKey: "acpRegistry:two@example.com",
        displayName: "GitHub Copilot Enterprise",
        atLimit: true,
      }),
      row(acp, 60, now + 3 * DAY, {
        key: "g1",
        accountKey: "acpRegistry:three@example.com",
        displayName: "Gemini CLI",
      }),
    ];
    const index = effectivenessIndex(rows, [], now);
    expect(index.providers.map((provider) => provider.group.label).toSorted()).toEqual([
      "Gemini CLI",
      "GitHub Copilot",
    ]);
    const copilot = index.providers.find(
      (provider) => provider.group.key === "acpRegistry:copilot",
    )!;
    expect(copilot.atLimitUntil).toBe(now + 6 * DAY);
    expect(copilot.projectedUsedPercent).toBeNull();

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    await act(async () => root.render(<EffectivenessSummaryView index={index} now={now} />));
    const text = container.textContent ?? "";
    expect(text).not.toContain("ACP Registry");
    expect(text).not.toContain("on pace");
    const copilotRow = container.querySelector(
      '[data-effectiveness-provider="acpRegistry:copilot"]',
    );
    expect(copilotRow?.textContent).toContain("at its limit until");
    const geminiRow = container.querySelector('[data-effectiveness-provider="acpRegistry:gemini"]');
    expect(geminiRow?.textContent).toContain("40% used · resets");
    await act(async () => root.unmount());
    container.remove();
  });

  it("calls a limit spent only from the window itself, never from a rounded reading", () => {
    const acp = ProviderDriverKind.make("acpRegistry");
    const copilotIcon =
      "https://cdn.agentclientprotocol.com/registry/v1/latest/github-copilot-cli.svg";
    const spentWindow = (target: SubscriptionRow, spent: boolean, resetsAt: number | null) => ({
      ...target,
      atLimit: spent,
      windows: target.windows.map((window) =>
        window.id === "weekly" ? { ...window, leftPercent: 0, spent, resetsAt } : window,
      ),
    });
    // Reads 0% left (rounded) but the window is not spent: no "at its limit".
    const rounded = spentWindow(
      row(acp, 0, now + 6 * DAY, {
        key: "r",
        accountKey: "acpRegistry:r@example.com",
        iconUrl: copilotIcon,
      }),
      false,
      now + 6 * DAY,
    );
    expect(effectivenessIndex([rounded], [], now).providers[0]?.atLimit).toBe(false);
    // Spent on both accounts, one without a reset time: at its limit, until the known reset.
    const known = spentWindow(
      row(acp, 0, now + 6 * DAY, {
        key: "k",
        accountKey: "acpRegistry:k@example.com",
        iconUrl: copilotIcon,
      }),
      true,
      now + 6 * DAY,
    );
    const unknown = spentWindow(
      row(acp, 0, null, {
        key: "u",
        accountKey: "acpRegistry:u@example.com",
        iconUrl: copilotIcon,
      }),
      true,
      null,
    );
    const provider = effectivenessIndex([known, unknown], [], now).providers[0]!;
    expect(provider.atLimit).toBe(true);
    expect(provider.atLimitUntil).toBe(now + 6 * DAY);
    expect(subline(provider, now)).toContain("at its limit until");
    // Premium pool spent but the provider says ordinary use still runs (the row is not at
    // its limit): no "at its limit" for the provider either.
    const stillRuns = { ...known, atLimit: false };
    expect(effectivenessIndex([stillRuns], [], now).providers[0]?.atLimit ?? false).toBe(false);
    // Blocked by a spend control with nothing spent: at its limit, no date.
    const capped = { ...rounded, atLimit: true };
    const cappedProvider = effectivenessIndex([capped], [], now).providers[0]!;
    expect(cappedProvider.atLimit).toBe(true);
    expect(cappedProvider.atLimitUntil).toBeNull();
    // No account has a reset time: still at its limit, without a date.
    const alone = effectivenessIndex([unknown], [], now).providers[0]!;
    expect(alone.atLimit).toBe(true);
    expect(alone.atLimitUntil).toBeNull();
    expect(subline(alone, now)).toBe("at its limit");
  });

  it("says when a reset is", () => {
    expect(resetWhen(now + 2 * HOUR, now)).toMatch(/^today /);
    expect(resetWhen(now + DAY, now)).toMatch(/^tomorrow /);
    expect(resetWhen(now + 5 * DAY, now)).not.toMatch(/today|tomorrow/);
  });
});
