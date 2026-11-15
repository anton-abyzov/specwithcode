import { describe, expect, it } from "vite-plus/test";

import {
  type QuotaAlertAccount,
  coversQuotaAlertPeriod,
  describeQuotaAlert,
  quotaAlertId,
  quotaAlerts,
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
    { id: "secondary", title: "Weekly", leftPercent: 62, resetsAt: now + 9 * HOUR, expiring: true },
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

  it("stays quiet for a window that is not expiring, an offline machine and an unnamed account", () => {
    const calm = account({
      windows: [
        { id: "secondary", title: "Weekly", leftPercent: 62, resetsAt: now + 3 * DAY, expiring: false },
      ],
    });
    expect(quotaAlerts([calm], [], now)).toEqual([]);
    expect(quotaAlerts([account({ offline: true })], [], now)).toEqual([]);
    expect(quotaAlerts([account({ accountKey: null })], [], now)).toEqual([]);
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
    const monthly = (leftPercent: number, expiring = false) => [
      { id: "monthly", title: "Monthly", leftPercent, resetsAt: now + 20 * HOUR, expiring },
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
    // The window alert already says it.
    const both = quotaAlerts(
      [account({ windows: monthly(55, true), renewal: { at: now + 20 * HOUR } })],
      [],
      now,
    );
    expect(both.map((entry) => entry.kind)).toEqual(["window"]);
    // One line per subscription, even when the expiring window is a shorter one.
    const short = quotaAlerts(
      [
        account({
          windows: [
            { id: "primary", title: "5-hour", leftPercent: 70, resetsAt: now + HOUR, expiring: true },
            ...monthly(55),
          ],
          renewal: { at: now + 20 * HOUR },
        }),
      ],
      [],
      now,
    );
    expect(short.map((entry) => entry.kind)).toEqual(["window"]);
  });

  it("names the window the renewal ends, and stays quiet when none resets with it", () => {
    const windows = [
      { id: "monthly", title: "Monthly", leftPercent: 90, resetsAt: now + 29 * DAY, expiring: false },
      { id: "weekly", title: "Weekly", leftPercent: 50, resetsAt: now + 18 * HOUR, expiring: false },
    ];
    const [alert] = quotaAlerts([account({ windows, renewal: { at: now + 20 * HOUR } })], [], now);
    expect(alert).toMatchObject({ kind: "renewal", windowTitle: "Weekly", leftPercent: 50 });
    // The monthly window keeps its quota through this renewal.
    expect(
      quotaAlerts([account({ windows: windows.slice(0, 1), renewal: { at: now + 20 * HOUR } })], [], now),
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
            { id: "secondary", title: "Weekly", leftPercent: 62, resetsAt: now + 9 * HOUR + 3000, expiring: true },
          ],
        }),
      ],
      [],
      now,
    );
    expect(visibleQuotaAlerts(drifted, dismissed)).toEqual([]);
    expect(coversQuotaAlertPeriod(dismissed[key], now + 9 * HOUR + 5 * HOUR)).toBe(false);
    expect(coversQuotaAlertPeriod(undefined, now)).toBe(false);
  });
});
