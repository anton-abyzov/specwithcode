import type { ProviderInstanceId, ServerProvider } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type QuotaAlertAccount,
  coversQuotaAlertPeriod,
  driftedQuotaAlertPeriods,
  describeQuotaAlert,
  projectedUnusedPercent,
  quotaAlertId,
  quotaAlerts,
  quotaGoingUnused,
  trackAccountPriorities,
  visibleQuotaAlerts,
} from "./quotaAlerts.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = Date.parse("2026-11-14T20:00:00.000Z");

const account = (extra: Partial<QuotaAlertAccount> = {}): QuotaAlertAccount => ({
  accountKey: "codex:pro@example.com",
  driver: "codex",
  machines: ["m4"],
  offline: false,
  windows: [
    { id: "secondary", title: "Weekly", leftPercent: 62, resetsAt: now + 9 * HOUR, long: true },
  ],
  renewal: null,
  credits: null,
  ...extra,
});

describe("quotaAlerts", () => {
  it("raises one alert for a window that resets soon with much unused", () => {
    const [alert, ...rest] = quotaAlerts([account()], [], now);
    expect(rest).toEqual([]);
    expect(alert).toMatchObject({
      key: "codex:pro@example.com|window:secondary",
      kind: "window",
      periodEnd: now + 9 * HOUR,
      leftPercent: 62,
    });
    expect(describeQuotaAlert(alert!, "Codex Pro", now)).toBe(
      "Codex Pro on m4: 62% of its weekly quota resets in 9 h",
    );
  });

  it("stays quiet three days out, for an offline machine and for an unnamed account", () => {
    const calm = account({
      windows: [
        { id: "secondary", title: "Weekly", leftPercent: 62, resetsAt: now + 3 * DAY, long: true },
      ],
    });
    expect(quotaAlerts([calm], [], now)).toEqual([]);
    expect(quotaAlerts([account({ offline: true })], [], now)).toEqual([]);
    expect(quotaAlerts([account({ accountKey: null })], [], now)).toEqual([]);
  });

  it("never warns about a 5-hour window, or with under an hour left to act", () => {
    const session = account({
      windows: [
        {
          id: "primary",
          title: "5-hour",
          leftPercent: 62,
          resetsAt: now + 4 * 60_000,
          long: false,
        },
      ],
    });
    expect(quotaAlerts([session], [], now)).toEqual([]);
    const late = account({
      windows: [
        {
          id: "secondary",
          title: "Weekly",
          leftPercent: 62,
          resetsAt: now + 40 * 60_000,
          long: true,
        },
      ],
    });
    expect(quotaAlerts([late], [], now)).toEqual([]);
  });

  it("warns two days out only when the pace so far will leave much unused", () => {
    const weekly = (leftPercent: number) =>
      account({
        windows: [
          {
            id: "secondary",
            title: "Weekly",
            leftPercent,
            resetsAt: now + 2 * DAY - HOUR,
            long: true,
            durationMs: 7 * DAY,
          },
        ],
      });
    // Nothing used in five days: all of it goes.
    expect(quotaAlerts([weekly(100)], [], now).map((entry) => entry.kind)).toEqual(["window"]);
    // 55% left, but 9% a day so far uses another 17%: 38% is projected unused, under the bar.
    expect(projectedUnusedPercent(weekly(55).windows[0]!, now)).toBeCloseTo(37.4, 0);
    expect(quotaAlerts([weekly(55)], [], now)).toEqual([]);
    // The same 55% with nine hours to go is a loss the pace cannot close.
    const soon = account({
      windows: [
        {
          id: "secondary",
          title: "Weekly",
          leftPercent: 55,
          resetsAt: now + 9 * HOUR,
          long: true,
          durationMs: 7 * DAY,
        },
      ],
    });
    expect(quotaAlerts([soon], [], now)).toHaveLength(1);
  });

  it("warns of a banked reset in its last day, not before", () => {
    const quiet = { windows: [] };
    const soon = account({ ...quiet, credits: { count: 2, nextExpiresAt: now + 5 * HOUR } });
    const [alert] = quotaAlerts([soon], [], now);
    expect(alert).toMatchObject({ kind: "bankedReset", count: 2, periodEnd: now + 5 * HOUR });
    expect(describeQuotaAlert(alert!, "Codex Pro", now)).toBe(
      "Codex Pro on m4: 2 banked resets, the next expires in 5 h",
    );
    const later = account({ ...quiet, credits: { count: 2, nextExpiresAt: now + 3 * DAY } });
    expect(quotaAlerts([later], [], now)).toEqual([]);
    const unknown = account({ ...quiet, credits: { count: 2, nextExpiresAt: null } });
    expect(quotaAlerts([unknown], [], now)).toEqual([]);
  });

  it("warns of a renewal within a day with quota unused, once, not on top of the window", () => {
    const monthly = (leftPercent: number) => [
      { id: "monthly", title: "Monthly", leftPercent, resetsAt: now + 20 * HOUR, long: true },
    ];
    const renewing = account({ windows: monthly(55), renewal: { at: now + 20 * HOUR } });
    const [alert, ...rest] = quotaAlerts([renewing], [], now);
    expect(rest).toEqual([]);
    expect(alert).toMatchObject({ kind: "renewal", leftPercent: 55 });
    expect(describeQuotaAlert(alert!, "Claude Max", now)).toBe(
      "Claude Max on m4: renews in 20 h with 55% of its monthly quota unused",
    );
    // Nearly spent: nothing to lose.
    expect(
      quotaAlerts([account({ windows: monthly(10), renewal: { at: now + 20 * HOUR } })], [], now),
    ).toEqual([]);
    // One line per subscription: a 5-hour window never adds one.
    const short = quotaAlerts(
      [
        account({
          windows: [
            { id: "primary", title: "5-hour", leftPercent: 70, resetsAt: now + HOUR, long: false },
            ...monthly(55),
          ],
          renewal: { at: now + 20 * HOUR },
        }),
      ],
      [],
      now,
    );
    expect(short.map((entry) => entry.kind)).toEqual(["renewal"]);
  });

  it("carries the window's own reset, which a renewal's time may sit hours from", () => {
    const weekly = [
      { id: "weekly", title: "Weekly", leftPercent: 55, resetsAt: now + 26 * HOUR, long: true },
    ];
    const [alert] = quotaAlerts(
      [account({ windows: weekly, renewal: { at: now + 20 * HOUR } })],
      [],
      now,
    );
    expect(alert).toMatchObject({
      kind: "renewal",
      key: "codex:pro@example.com|window:weekly",
      periodEnd: now + 26 * HOUR,
      renewsAt: now + 20 * HOUR,
      windowId: "weekly",
      windowResetsAt: now + 26 * HOUR,
    });
  });

  it("keeps one identity for a window whether or not its line names the renewal", () => {
    const weekly = [
      {
        id: "weekly",
        title: "Weekly",
        leftPercent: 90,
        resetsAt: now + 30 * HOUR,
        long: true,
        durationMs: 7 * DAY,
      },
    ];
    const subscription = account({ windows: weekly, renewal: { at: now + 28 * HOUR } });
    const [first] = quotaAlerts([subscription], [], now);
    expect(first?.kind).toBe("window");
    // Eight hours on the renewal is within a day and the line changes; the dismissal holds.
    const later = quotaAlerts([subscription], [], now + 8 * HOUR);
    expect(later.map((entry) => entry.kind)).toEqual(["renewal"]);
    expect(visibleQuotaAlerts(later, { [first!.key]: first!.periodEnd })).toEqual([]);
  });

  it("lets the window that resets first speak, renewal or not", () => {
    const windows = [
      {
        id: "weekly",
        title: "Weekly",
        leftPercent: 90,
        resetsAt: now + 10 * HOUR,
        long: true,
        durationMs: 7 * DAY,
      },
      {
        id: "monthly",
        title: "Monthly",
        leftPercent: 50,
        resetsAt: now + 20 * HOUR,
        long: true,
        durationMs: 30 * DAY,
      },
    ];
    const [alert, ...rest] = quotaAlerts(
      [account({ windows, renewal: { at: now + 20 * HOUR } })],
      [],
      now,
    );
    expect(rest).toEqual([]);
    expect(alert).toMatchObject({ kind: "window", windowId: "weekly" });
  });

  it("ignores a window that caps one model only", () => {
    const windows = [
      { id: "secondary", title: "Weekly", leftPercent: 5, resetsAt: now + 24 * HOUR, long: true },
      {
        id: "seven_day_fable",
        title: "Fable weekly",
        leftPercent: 90,
        resetsAt: now + 24 * HOUR,
        long: true,
        scoped: true,
      },
    ];
    expect(quotaAlerts([account({ windows })], [], now)).toEqual([]);
  });

  it("names the window the renewal ends, and stays quiet when none resets with it", () => {
    const windows = [
      { id: "monthly", title: "Monthly", leftPercent: 90, resetsAt: now + 29 * DAY, long: true },
      { id: "weekly", title: "Weekly", leftPercent: 50, resetsAt: now + 18 * HOUR, long: true },
    ];
    const [alert] = quotaAlerts([account({ windows, renewal: { at: now + 20 * HOUR } })], [], now);
    expect(alert).toMatchObject({ kind: "renewal", windowTitle: "Weekly", leftPercent: 50 });
    // A 5-hour window refills long before the renewal, however near its next reset is.
    const session = [
      { id: "primary", title: "5-hour", leftPercent: 70, resetsAt: now + 18 * HOUR, long: false },
    ];
    expect(
      quotaAlerts([account({ windows: session, renewal: { at: now + 20 * HOUR } })], [], now),
    ).toEqual([]);
    // A weekly window that resets well before the renewal is not what the renewal ends.
    const earlier = [{ ...windows[1]!, resetsAt: now + 3 * HOUR }];
    // The window still says so itself.
    expect(
      quotaAlerts([account({ windows: earlier, renewal: { at: now + 23 * HOUR } })], [], now).map(
        (entry) => entry.kind,
      ),
    ).toEqual(["window"]);
    // The monthly window keeps its quota through this renewal.
    expect(
      quotaAlerts(
        [account({ windows: windows.slice(0, 1), renewal: { at: now + 20 * HOUR } })],
        [],
        now,
      ),
    ).toEqual([]);
  });

  it("warns that a promised reset will replace what is left, and says expected", () => {
    const weekly = (extra: object = {}) => [
      {
        id: "secondary",
        title: "Weekly",
        leftPercent: 62,
        resetsAt: now + 4 * DAY,
        long: true,
        durationMs: 7 * DAY,
        ...extra,
      },
    ];
    const promise = {
      id: "p1",
      driver: "codex",
      publishedAt: now - 2 * HOUR,
      sourceUrl: "https://x.com/example/status/9",
    };
    const [alert, ...rest] = quotaAlerts([account({ windows: weekly() })], [], now, [promise]);
    expect(rest).toEqual([]);
    expect(alert).toMatchObject({
      key: "codex:pro@example.com|expected",
      kind: "expectedReset",
      periodEnd: now + 4 * DAY,
      expectedUntil: now + 22 * HOUR,
      windowId: "secondary",
      windowResetsAt: now + 4 * DAY,
      sourceUrl: "https://x.com/example/status/9",
    });
    expect(describeQuotaAlert(alert!, "Codex Pro", now)).toBe(
      "Codex Pro reset expected today: 62% left on m4 will be replaced",
    );
    // A second post about the same reset is the same warning: the dismissal holds.
    const reposted = quotaAlerts([account({ windows: weekly() })], [], now, [
      promise,
      { ...promise, id: "p2", publishedAt: now - HOUR },
    ]);
    expect(reposted).toHaveLength(1);
    expect(visibleQuotaAlerts(reposted, { [alert!.key]: alert!.periodEnd })).toEqual([]);
    // It leads a window that resets sooner than this window does but later than the promise.
    const other = account({
      accountKey: "codex:team@example.com",
      windows: [
        {
          id: "secondary",
          title: "Weekly",
          leftPercent: 90,
          resetsAt: now + 30 * HOUR,
          long: true,
          durationMs: 7 * DAY,
        },
      ],
    });
    const mine = account({ driver: "claudeAgent", windows: weekly() });
    expect(
      quotaAlerts([other, mine], [], now, [{ ...promise, driver: "claudeAgent" }]).map(
        (entry) => entry.kind,
      ),
    ).toEqual(["expectedReset", "window"]);
    // Another provider's promise, an old one, and little left: nothing.
    expect(
      quotaAlerts([account({ windows: weekly() })], [], now, [
        { ...promise, driver: "claudeAgent" },
      ]),
    ).toEqual([]);
    expect(
      quotaAlerts([account({ windows: weekly() })], [], now, [
        { ...promise, publishedAt: now - 25 * HOUR },
      ]),
    ).toEqual([]);
    expect(
      quotaAlerts([account({ windows: weekly({ leftPercent: 12 }) })], [], now, [promise]),
    ).toEqual([]);
    // The window began after the post: the reset has arrived.
    expect(
      quotaAlerts([account({ windows: weekly({ resetsAt: now + 7 * DAY - HOUR }) })], [], now, [
        promise,
      ]),
    ).toEqual([]);
  });

  it("reports an early reset for six hours, after what is about to be lost", () => {
    const early = {
      accountKey: "codex:pro@example.com",
      driver: "codex",
      windowId: "secondary",
      windowTitle: "Weekly",
      endedAt: now - 2 * HOUR,
    };
    const alerts = quotaAlerts([account()], [early], now);
    expect(alerts.map((entry) => entry.kind)).toEqual(["window", "earlyReset"]);
    expect(describeQuotaAlert(alerts[1]!, "Codex Pro", now)).toBe(
      "Codex Pro on m4 reset early: weekly back to 100%",
    );
    expect(quotaAlerts([account()], [{ ...early, endedAt: now - 7 * HOUR }], now)).toHaveLength(1);
    // Signed out since, or only on an offline machine: not this person's news any more.
    expect(quotaAlerts([], [early], now)).toEqual([]);
    expect(quotaAlerts([account({ offline: true })], [early], now)).toEqual([]);
  });
});

describe("visibleQuotaAlerts", () => {
  it("holds a dismissal for its period and shows the next one", () => {
    const alerts = quotaAlerts([account()], [], now);
    const key = alerts[0]!.key;
    expect(visibleQuotaAlerts(alerts, {})).toHaveLength(1);
    expect(visibleQuotaAlerts(alerts, { [key]: now + 9 * HOUR })).toEqual([]);
    // Last week's dismissal does not hide this week's alert.
    expect(visibleQuotaAlerts(alerts, { [key]: now + 9 * HOUR - 7 * DAY })).toHaveLength(1);
    expect(quotaAlertId(alerts[0]!)).toBe(`${key}@${now + 9 * HOUR}`);
  });

  it("keeps a dismissal when a re-read moves the same reset a few seconds", () => {
    const alerts = quotaAlerts([account()], [], now);
    const key = alerts[0]!.key;
    const dismissed = { [key]: alerts[0]!.periodEnd };
    const drifted = quotaAlerts(
      [
        account({
          windows: [
            {
              id: "secondary",
              title: "Weekly",
              leftPercent: 62,
              resetsAt: now + 9 * HOUR + 3000,
              long: true,
            },
          ],
        }),
      ],
      [],
      now,
    );
    expect(visibleQuotaAlerts(drifted, dismissed)).toEqual([]);
    expect(coversQuotaAlertPeriod(dismissed[key], now + 9 * HOUR + 5 * HOUR)).toBe(false);
    expect(coversQuotaAlertPeriod(undefined, now)).toBe(false);
    // The record follows the re-read, so a second small drift is still the same period.
    expect(driftedQuotaAlertPeriods(drifted, dismissed)).toEqual({ [key]: now + 9 * HOUR + 3000 });
    expect(driftedQuotaAlertPeriods(alerts, dismissed)).toEqual({});
  });
});

const provider = (
  instanceId: string,
  driver: string,
  email: string,
  models: readonly string[],
  extra: Partial<ServerProvider> = {},
): ServerProvider =>
  ({
    instanceId: instanceId as ProviderInstanceId,
    driver: driver as ServerProvider["driver"],
    provider: driver,
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated", email },
    models: models.map((slug) => ({ slug, name: slug, isCustom: false })),
    ...extra,
  }) as unknown as ServerProvider;

describe("trackAccountPriorities and track-scoped quotaAlerts", () => {
  const claude = provider("claudeAgent", "claudeAgent", "me@example.com", [
    "claude-opus-5-5",
    "claude-sonnet-5-5",
    "claude-fable-5-2",
  ]);
  const codex = provider("codex", "codex", "me@example.com", [
    "gpt-6.2-sol",
    "gpt-6.2-astra",
    "gpt-6-luna",
  ]);
  const copilot = provider("acpRegistry_copilot", "acp", "me@example.com", [
    "gemini-4-neon",
    "gpt-6.2-sol",
  ]);
  const grok = provider("grok", "grok", "me@example.com", ["grok-4.7", "grok-4.6"]);

  it("includes only accounts serving active tracks and orders Daily > Complex > Review", () => {
    const priorities = trackAccountPriorities({
      providerLists: [[claude, codex, copilot, grok]],
      now,
    });
    expect(priorities.has("claudeAgent:me@example.com")).toBe(true);
    expect(priorities.has("codex:me@example.com")).toBe(true);
    expect(priorities.has("acp:me@example.com")).toBe(true);
    // Grok is not on Daily, Complex or Review by default.
    expect(priorities.has("grok:me@example.com")).toBe(false);
    // Claude is first on Daily, ahead of Codex.
    expect(priorities.get("claudeAgent:me@example.com")!).toBeLessThan(
      priorities.get("codex:me@example.com")!,
    );
  });

  it("includes an account once added to a custom track or pinned as defaultModelSelection", () => {
    const custom = trackAccountPriorities({
      providerLists: [[claude, grok]],
      modelLanes: {
        routine: [{ instanceId: "grok" as ProviderInstanceId, model: "grok-4.7" }],
        complex: [],
      },
      now,
    });
    expect(custom.has("grok:me@example.com")).toBe(true);
    expect(custom.get("grok:me@example.com")!).toBeLessThan(
      custom.get("claudeAgent:me@example.com")!,
    );

    const pinned = trackAccountPriorities({
      providerLists: [[claude, grok]],
      threadModelMode: "model",
      defaultModelSelection: { instanceId: "grok" as ProviderInstanceId, model: "grok-4.7" },
      now,
    });
    expect(pinned.get("grok:me@example.com")).toBe(0);
  });

  it("filters off-track accounts and ranks track priority ahead of sooner resets", () => {
    const priorities = trackAccountPriorities({
      providerLists: [[claude, codex, grok]],
      now,
    });
    const grokAccount = account({
      accountKey: "grok:me@example.com",
      driver: "grok",
      windows: [
        { id: "weekly", title: "Weekly", leftPercent: 85, resetsAt: now + 5 * HOUR, long: true },
      ],
    });
    const codexAccount = account({
      accountKey: "codex:me@example.com",
      driver: "codex",
      windows: [
        { id: "secondary", title: "Weekly", leftPercent: 70, resetsAt: now + 8 * HOUR, long: true },
      ],
    });
    const claudeAccount = account({
      accountKey: "claudeAgent:me@example.com",
      driver: "claudeAgent",
      windows: [
        { id: "weekly", title: "Weekly", leftPercent: 60, resetsAt: now + 30 * HOUR, long: true },
      ],
    });
    const grokEarly = {
      accountKey: "grok:me@example.com",
      driver: "grok",
      windowId: "weekly",
      windowTitle: "Weekly",
      endedAt: now - HOUR,
    };
    const claudeEarly = {
      accountKey: "claudeAgent:me@example.com",
      driver: "claudeAgent",
      windowId: "weekly",
      windowTitle: "Weekly",
      endedAt: now - HOUR,
    };

    const alerts = quotaAlerts(
      [grokAccount, codexAccount, claudeAccount],
      [grokEarly, claudeEarly],
      now,
      [],
      {
        trackPriorities: priorities,
      },
    );
    // Grok is completely absent (neither window nor early reset).
    expect(alerts.some((entry) => entry.accountKey === "grok:me@example.com")).toBe(false);
    // Claude (Daily #0) leads Codex even though Codex resets sooner; earlyReset news stays last.
    expect(alerts.map((entry) => `${entry.accountKey}:${entry.kind}`)).toEqual([
      "claudeAgent:me@example.com:window",
      "codex:me@example.com:window",
      "claudeAgent:me@example.com:earlyReset",
    ]);
  });

  it("respects subscriptionTargets planned share so spare subscriptions stay quiet", () => {
    const spareWindow = {
      id: "secondary",
      title: "Weekly",
      leftPercent: 85,
      resetsAt: now + 10 * HOUR,
      long: true,
    };
    // With default 100% target, 85% left warns.
    expect(quotaGoingUnused(spareWindow, now)).toBe(true);
    // With a 30% spare target, 15% used is only 15 points under target (< 40).
    expect(quotaGoingUnused(spareWindow, now, 30)).toBe(false);
    // With a 70% target and 90% left (10% used), 60 points under target (>= 40) still warns.
    expect(quotaGoingUnused({ ...spareWindow, leftPercent: 90 }, now, 70)).toBe(true);

    const spare = account({
      accountKey: "codex:me@example.com",
      windows: [spareWindow],
    });
    expect(quotaAlerts([spare], [], now, [], { targets: { "codex:me@example.com": 30 } })).toEqual(
      [],
    );
  });
});
