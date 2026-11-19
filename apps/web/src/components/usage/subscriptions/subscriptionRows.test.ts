import {
  EnvironmentId,
  ProviderDriverKind,
  type ServerProviderUsageWindow,
  type UsageResetPeriod,
} from "@specweave-studio/contracts";
import type { LimitAccount } from "@specweave-studio/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import { nextRenewalOn, subscriptionRows } from "./subscriptionRows";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = new Date(2026, 10, 14, 20, 0).getTime();
const iso = (at: number) => new Date(at).toISOString();
const codex = ProviderDriverKind.make("codex");
const claude = ProviderDriverKind.make("claudeAgent");

const weekly = (usedPercent: number, resetsIn: number): ServerProviderUsageWindow => ({
  id: "secondary",
  kind: "weekly",
  label: "Weekly",
  windowDurationMins: 10_080,
  usedPercent,
  resetsAt: iso(now + resetsIn),
});

const account = (
  key: string,
  driver: LimitAccount["driver"],
  email: string | undefined,
  machine: string,
  limits: Partial<LimitAccount["limits"]> & Pick<LimitAccount["limits"], "windows">,
  extra: Partial<LimitAccount> = {},
): LimitAccount => ({
  key,
  driver,
  displayName: null,
  email,
  plan: "Pro",
  accentColor: undefined,
  environments: [{ environmentId: EnvironmentId.make(`env-${machine}`), label: machine }],
  sourceLabel: null,
  offline: false,
  redeem: null,
  limits: { checkedAt: iso(now - 5 * 60_000), ...limits },
  ...extra,
});

const period = (accountKey: string, endedAt: number, lostPercent: number): UsageResetPeriod => ({
  accountKey,
  driver: codex,
  windowId: "secondary",
  windowKind: "weekly",
  endedAt: iso(endedAt),
  lastReadAt: iso(endedAt - HOUR),
  usedPercentAtReset: 100 - lostPercent,
  lostPercent,
  cause: "scheduled",
});

describe("subscriptionRows", () => {
  it("gives each window its length, shortest first, and marks one that caps a single model", () => {
    const { windowDurationMins: _reported, ...unsized } = weekly(10, 2 * DAY);
    const [row] = subscriptionRows(
      [
        account("a", claude, "a@x.dev", "m4", {
          windows: [
            unsized,
            { ...unsized, id: "monthly", kind: "monthly", label: "Monthly" },
            { ...weekly(10, 2 * DAY), id: "seven_day_fable", label: "Weekly", modelScope: "Fable" },
            { ...unsized, id: "primary", kind: "session", label: "5-hour" },
          ],
        }),
      ],
      [],
      {},
      now,
    );
    expect(row?.windows.map((window) => [window.id, window.durationMs, window.scoped])).toEqual([
      ["primary", null, false],
      ["secondary", 7 * DAY, false],
      ["seven_day_fable", 10_080 * 60_000, true],
      ["monthly", 30 * DAY, false],
    ]);
  });

  it("puts the account about to lose quota first and marks its window", () => {
    const rows = subscriptionRows(
      [
        account("a", claude, "a@x.dev", "m4", { windows: [weekly(82, 2 * DAY)] }),
        account("b", codex, "b@x.dev", "m1", { windows: [weekly(38, 9 * HOUR)] }),
      ],
      [],
      {},
      now,
    );
    expect(rows.map((row) => row.key)).toEqual(["b", "a"]);
    expect(rows[0]?.windows).toEqual([
      expect.objectContaining({
        id: "secondary",
        title: "Weekly",
        leftPercent: 62,
        resetsAt: now + 9 * HOUR,
        expiring: true,
        long: true,
      }),
    ]);
    expect(rows[0]?.windows[0]).toMatchObject({ durationMs: 10_080 * 60_000, scoped: false });
    expect(rows[1]?.windows[0]?.expiring).toBe(false);
    expect(rows[0]?.machines).toEqual(["m1"]);
  });

  it("does not mark a window with little left, or one that resets days away", () => {
    const rows = subscriptionRows(
      [
        account("a", codex, "a@x.dev", "m4", { windows: [weekly(90, 3 * HOUR)] }),
        account("b", codex, "b@x.dev", "m4", { windows: [weekly(10, 3 * DAY)] }),
      ],
      [],
      {},
      now,
    );
    expect(rows.flatMap((row) => row.windows.map((window) => window.expiring))).toEqual([
      false,
      false,
    ]);
  });

  it("takes the renewal from the provider, else from the day the person set, else none", () => {
    const rows = subscriptionRows(
      [
        account("a", codex, "a@x.dev", "m4", {
          windows: [weekly(10, 3 * DAY)],
          renewsAt: iso(now + 18 * DAY),
          planLabel: "Business",
        }),
        account("b", codex, "b@x.dev", "m4", { windows: [weekly(10, 4 * DAY)] }),
        account("c", codex, "c@x.dev", "m4", { windows: [weekly(10, 5 * DAY)] }),
      ],
      [],
      { "codex:b@x.dev": 17 },
      now,
    );
    expect(rows[0]?.renewal).toEqual({ at: now + 18 * DAY, source: "provider", vendor: "OpenAI" });
    expect(rows[0]?.plan).toBe("Business");
    expect(rows[1]?.renewal).toEqual({ at: new Date(2026, 10, 17).getTime(), source: "set", day: 17 });
    expect(rows[2]?.renewal).toBeNull();
  });

  it("shows banked resets with their next expiry, and none when the bank is empty", () => {
    const rows = subscriptionRows(
      [
        account("a", codex, "a@x.dev", "m4", {
          windows: [weekly(10, 3 * DAY)],
          resetCredits: { availableCount: 2, nextExpiresAt: iso(now + 7 * DAY) },
        }),
        account("b", codex, "b@x.dev", "m4", {
          windows: [weekly(10, 4 * DAY)],
          resetCredits: { availableCount: 0 },
        }),
      ],
      [],
      {},
      now,
    );
    expect(rows[0]?.credits).toEqual({ count: 2, nextExpiresAt: now + 7 * DAY });
    expect(rows[1]?.credits).toBeNull();
  });

  it("names the last reset's loss for the account, and nothing for an account with no ledger", () => {
    const rows = subscriptionRows(
      [
        account("a", codex, "A@x.dev", "m4", { windows: [weekly(10, 3 * DAY)] }),
        account("b", codex, undefined, "m4", { windows: [weekly(10, 4 * DAY)] }),
      ],
      [
        period("codex:a@x.dev", now - 11 * DAY, 12),
        period("codex:a@x.dev", now - 4 * DAY, 41),
        period("codex:other@x.dev", now - DAY, 90),
      ],
      {},
      now,
    );
    expect(rows[0]?.lastLoss).toEqual({
      windowTitle: "Weekly",
      lostPercent: 41,
      endedAt: now - 4 * DAY,
      upperBound: false,
      cause: "scheduled",
    });
    expect(rows[1]?.accountKey).toBeNull();
    expect(rows[1]?.lastLoss).toBeNull();
  });

  it("keeps an offline account's last reading and leaves out windows whose reset passed", () => {
    const rows = subscriptionRows(
      [
        account(
          "a",
          codex,
          "a@x.dev",
          "ministorm",
          { windows: [weekly(60, -HOUR), { ...weekly(40, 2 * DAY), id: "monthly" }] },
          { offline: true },
        ),
      ],
      [],
      {},
      now,
    );
    expect(rows[0]?.offline).toBe(true);
    expect(rows[0]?.checkedAt).toBe(now - 5 * 60_000);
    expect(rows[0]?.windows.map((window) => window.id)).toEqual(["monthly"]);
  });
});

describe("renewal", () => {
  const acp = ProviderDriverKind.make("acpRegistry");
  const copilotKey = `copilot:sha256:${"b".repeat(64)}`;
  const copilot = (checkedAt: number, usedPercent: number) =>
    account(
      "env-m4:copilot",
      acp,
      undefined,
      "m4",
      {
        checkedAt: iso(checkedAt),
        subscriptionKey: copilotKey,
        windows: [{ ...weekly(usedPercent, 9 * DAY), id: "premium_interactions", kind: "monthly" }],
      },
      { displayName: "Copilot" },
    );

  it("lets the day the person set win over a reported date, and ignores a reported date that has passed", () => {
    const rows = subscriptionRows(
      [
        account("a", codex, "a@x.dev", "m4", { windows: [weekly(10, DAY)], renewsAt: iso(now + 18 * DAY) }),
        account("b", codex, "b@x.dev", "m4", { windows: [weekly(10, 2 * DAY)], renewsAt: iso(now - DAY) }),
      ],
      [],
      { "codex:a@x.dev": 3 },
      now,
    );
    expect(rows[0]?.renewal).toEqual({ at: new Date(2026, 11, 3).getTime(), source: "set", day: 3 });
    expect(rows[1]?.renewal).toBeNull();
  });

  it("keys Copilot's day by its subscription and finds it after a sign-out, a sign-in and a new reading", () => {
    const [first] = subscriptionRows([copilot(now - DAY, 10)], [], {}, now);
    expect(first?.accountKey).toBeNull();
    expect(first?.renewalKey).toBe(`acpRegistry:subscription:${copilotKey}`);
    const saved = { [first!.renewalKey!]: 9 };
    // Signed out: no reading, so no row; the saved day stays in settings.
    expect(subscriptionRows([], [], saved, now)).toEqual([]);
    // Signed in again as the same login and plan, read anew.
    const [again] = subscriptionRows([copilot(now, 55)], [], saved, now);
    expect(again?.renewalKey).toBe(first?.renewalKey);
    expect(again?.renewal).toEqual({ at: new Date(2026, 11, 9).getTime(), source: "set", day: 9 });
  });

  it("has no renewal key for a reading with neither an account key nor a subscription", () => {
    const [row] = subscriptionRows(
      [account("z", acp, undefined, "m4", { windows: [weekly(10, DAY)] })],
      [],
      {},
      now,
    );
    expect(row?.renewalKey).toBeNull();
  });
});

describe("nextRenewalOn", () => {
  it("is today when the day is today, and next month once it has passed", () => {
    expect(nextRenewalOn(14, now)).toBe(new Date(2026, 10, 14).getTime());
    expect(nextRenewalOn(2, now)).toBe(new Date(2026, 11, 2).getTime());
  });

  it("uses the last day of a month too short for the day", () => {
    const february = new Date(2027, 1, 10).getTime();
    expect(nextRenewalOn(31, february)).toBe(new Date(2027, 1, 28).getTime());
  });
});

describe("subscriptionsSummary", () => {
  const session = (usedPercent: number, resetsIn: number): ServerProviderUsageWindow => ({
    id: "primary",
    kind: "session",
    label: "5-hour",
    windowDurationMins: 300,
    usedPercent,
    resetsAt: iso(now + resetsIn),
  });
  const rows = (accounts: LimitAccount[]) => subscriptionRows(accounts, [], {}, now);

  it("counts a spent account window as a limit, and names when the spent window frees it", () => {
    const list = rows([
      account("a", codex, "a@x.dev", "m4", { windows: [session(100, 2 * HOUR), weekly(40, 3 * DAY)] }),
      account("b", claude, "b@x.dev", "m4", { windows: [session(10, HOUR)] }),
    ]);
    expect(list.map((row) => [row.key, row.atLimit])).toEqual([
      ["b", false],
      ["a", true],
    ]);
    expect(subscriptionsSummary(list, 2, now)).toEqual({
      subscriptions: 2,
      atLimit: 1,
      nextResetAt: now + 2 * HOUR,
      withoutReading: 2,
    });
    expect(subscriptionsSummaryText(subscriptionsSummary(list, 2, now), now)).toBe(
      "2 subscriptions · 1 at a limit · next reset in 2h 0m · 2 without a reading",
    );
  });

  it("does not count Copilot at a limit when spent premium requests still run", () => {
    const monthly = { ...weekly(100, 9 * DAY), id: "premium_interactions", kind: "monthly" as const };
    const [row] = rows([
      account("c", ProviderDriverKind.make("acpRegistry"), undefined, "m4", {
        windows: [monthly],
        ordinaryUsageAllowed: true,
      }),
    ]);
    expect(row?.atLimit).toBe(false);
  });

  it("counts a stop or a spend control as a limit even with room left, and falls back to its soonest reset", () => {
    const list = rows([
      account("d", codex, "d@x.dev", "m4", {
        windows: [weekly(20, 4 * DAY)],
        ordinaryUsageAllowed: false,
      }),
      account("e", codex, "e@x.dev", "m4", { windows: [weekly(5, DAY)], spendControlReached: true }),
      account("f", codex, "f@x.dev", "m4", { windows: [weekly(5, HOUR)] }),
    ]);
    expect(subscriptionsSummary(list, 0, now)).toMatchObject({ atLimit: 2, nextResetAt: now + DAY });
  });

  it("ignores scoped windows and Cursor's Overall, and leaves the reset out when none is known", () => {
    const list = rows([
      account("g", claude, "g@x.dev", "m4", {
        windows: [{ ...weekly(100, HOUR), id: "seven_day_fable", label: "Weekly · Fable", modelScope: "Fable" }],
      }),
      account("h", ProviderDriverKind.make("cursor"), "h@x.dev", "m4", {
        windows: [{ ...weekly(100, HOUR), id: "totalPercentUsed", kind: "monthly", label: "Overall" }],
      }),
    ]);
    const summary = subscriptionsSummary(list, 0, now);
    expect(summary).toEqual({ subscriptions: 2, atLimit: 0, nextResetAt: null, withoutReading: 0 });
    expect(subscriptionsSummaryText(summary, now)).toBe("2 subscriptions · 0 at a limit");
  });
});

describe("window notes", () => {
  const acp = ProviderDriverKind.make("acpRegistry");
  const cursor = ProviderDriverKind.make("cursor");
  const noteOf = (accounts: LimitAccount[]) => subscriptionRows(accounts, [], {}, now)[0]?.note?.note ?? null;

  it("notes Copilot from its reading, with the vendor page and the day it was read", () => {
    const [row] = subscriptionRows(
      [
        account("c", acp, undefined, "m4", {
          subscriptionKey: `copilot:sha256:${"a".repeat(64)}`,
          windows: [{ ...weekly(10, 9 * DAY), id: "premium_interactions", kind: "monthly" }],
        }),
      ],
      [],
      {},
      now,
    );
    expect(row?.note).toEqual({
      id: "copilot-monthly",
      note: "Monthly allowance. Resets on the first of the month at 00:00 UTC, whatever your billing day.",
      source: "https://docs.github.com/en/copilot/concepts/billing/billing-for-individuals",
      readOn: "2026-11-18",
    });
  });

  it("notes Cursor's weekly pool, a Codex Pro plan with no 5-hour window, and nothing for Claude", () => {
    expect(noteOf([account("u", cursor, "u@x.dev", "m4", { windows: [weekly(10, DAY)] })])).toBe(
      "One weekly pool. No hourly limit.",
    );
    expect(
      noteOf([
        account("p", codex, "p@x.dev", "m4", { windows: [weekly(10, DAY)] }, { plan: "ChatGPT Pro 20x Subscription" }),
      ]),
    ).toBe("No 5-hour window reported for this plan.");
    expect(noteOf([account("q", claude, "q@x.dev", "m4", { windows: [weekly(10, DAY)] })])).toBeNull();
  });

  it("never lets a model-scoped window or Cursor's Overall earn a note", () => {
    expect(
      noteOf([
        account("u", cursor, "u@x.dev", "m4", {
          windows: [{ ...weekly(10, DAY), id: "totalPercentUsed", label: "Overall" }],
        }),
      ]),
    ).toBeNull();
  });
});

describe("window amounts", () => {
  it("keeps sound amounts and shows anything else as none", async () => {
    const { windowAmounts } = await import("./subscriptionRows");
    expect(windowAmounts({ used: 885, limit: 1500, unit: " premium requests " })).toEqual({
      used: 885,
      limit: 1500,
      unit: "premium requests",
    });
    expect(windowAmounts({})).toBeNull();
    expect(windowAmounts({ used: 1, limit: 2 })).toBeNull();
    expect(windowAmounts({ used: -1, limit: 2, unit: "x" })).toBeNull();
    expect(windowAmounts({ used: Number.POSITIVE_INFINITY, limit: 2, unit: "x" })).toBeNull();
    expect(windowAmounts({ used: 1, limit: Number.NaN, unit: "x" })).toBeNull();
    expect(windowAmounts({ used: 1, limit: 2, unit: "   " })).toBeNull();
    expect(windowAmounts({ used: 1, limit: 2, unit: "x".repeat(25) })).toBeNull();
    expect(windowAmounts({ used: 0, limit: 0, unit: "x".repeat(24) })).not.toBeNull();
  });

  it("carries a Copilot reading's amounts onto its row", () => {
    const [row] = subscriptionRows(
      [
        account("c", ProviderDriverKind.make("acpRegistry"), undefined, "m4", {
          windows: [
            {
              ...weekly(59, 9 * DAY),
              id: "premium_interactions",
              kind: "monthly",
              used: 885,
              limit: 1500,
              unit: "premium requests",
            },
          ],
        }),
      ],
      [],
      {},
      now,
    );
    expect(row?.windows[0]?.amounts).toEqual({ used: 885, limit: 1500, unit: "premium requests" });
  });
});
